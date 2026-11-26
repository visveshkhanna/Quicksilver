// A stand-in for the Rust side, behind Tauri's IPC mock, so UI flows can be
// tested end to end in jsdom. It keeps just enough state to answer the
// commands the flows use, and records every call.

import { mockIPC } from '@tauri-apps/api/mocks'
import type { CatalogEntry, Profile, ProfileFields } from '../ipc/store'
import type { Column, RunEvent } from '../ipc/types'

/** Encodes rows as the Rust side's binary page (see `src/ipc/page.ts`). */
export function encodePage(
  offset: number,
  rows: (string | null)[][],
  width: number,
  sources: number[] = rows.map((_, i) => offset + i),
): ArrayBuffer {
  const encoder = new TextEncoder()
  const encoded = rows.map((row) => row.map((c) => (c === null ? null : encoder.encode(c))))
  const size = 20 + encoded.reduce((n, row) => n + 8 + row.reduce((m, c) => m + 4 + (c?.length ?? 0), 0), 0)
  const buffer = new ArrayBuffer(size)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  bytes.set([0x51, 0x53, 0x50, 0x32])
  view.setUint32(4, rows.length, true)
  view.setUint32(8, width, true)
  view.setBigUint64(12, BigInt(offset), true)
  let at = 20
  encoded.forEach((row, r) => {
    view.setBigUint64(at, BigInt(sources[r] ?? offset + r), true)
    at += 8
    for (const c of row) {
      view.setUint32(at, c === null ? 0xffffffff : c.length, true)
      at += 4
      if (c) {
        bytes.set(c, at)
        at += c.length
      }
    }
  })
  return buffer
}

/** What a fake run returns: these columns and rows for any statement, unless it says `error`. */
export const PEOPLE: { columns: Column[]; rows: (string | null)[][] } = {
  columns: [
    { name: 'id', typeTag: 'integer', dbType: 'int4', source: null },
    { name: 'name', typeTag: 'text', dbType: 'text', source: null },
  ],
  rows: [
    ['2', 'b'],
    ['10', 'c'],
    ['1', null],
  ],
}

type Result = { columns: Column[]; rows: (string | null)[][]; order: number[]; script: string }

export type Call = { cmd: string; args: Record<string, unknown> }

export function profile(id: string, name: string, over: Partial<ProfileFields> = {}): Profile {
  return {
    id,
    name,
    project: null,
    color: null,
    engine: 'postgres',
    host: '127.0.0.1',
    port: 15432,
    user: 'quicksilver',
    database: 'quicksilver_dev',
    path: null,
    sslMode: 'disable',
    sslRootCert: null,
    options: {},
    auth: { kind: 'keychain' },
    mode: 'readWrite',
    createdMs: 1,
    updatedMs: 1,
    ...over,
  }
}

export function databaseEntry(profileId: string, database: string): CatalogEntry {
  return { profileId, database, schema: null, name: null, kind: 'database', refreshedMs: 1 }
}

export function objectEntry(
  profileId: string,
  database: string,
  schema: string,
  name: string,
  kind = 'table',
) {
  return { profileId, database, schema, name, kind, refreshedMs: 1 } satisfies CatalogEntry
}

export function fakeBackend({
  profiles = [] as Profile[],
  catalog = [] as CatalogEntry[],
  needsPassword = new Set<string>(),
} = {}) {
  const calls: Call[] = []
  const buffers = new Map<string, unknown>()
  const layout = new Map<string, unknown>()
  const saved = new Map<string, string>()
  let nextSession = 1
  let nextId = 100
  const results = new Map<number, Result>()
  const sendTo = (channel: unknown) => {
    const id = (channel as { id: number }).id
    let index = 0
    return (message: RunEvent) =>
      (
        window as unknown as { __TAURI_INTERNALS__: { runCallback: (id: number, data: unknown) => void } }
      ).__TAURI_INTERNALS__.runCallback(id, { index: index++, message })
  }

  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>
    calls.push({ cmd, args })
    switch (cmd) {
      case 'app_info':
        return { name: 'Quicksilver', version: '0.0.0-test', engines: [] }
      case 'list_profiles':
        return profiles
      case 'catalog':
        return catalog
      case 'buffers':
        return [...buffers.values()]
      case 'store_notices':
        return []
      case 'get_layout':
        return layout.get(args.key as string) ?? null
      case 'set_layout':
        layout.set(args.key as string, args.value)
        return null
      case 'save_buffer': {
        const b = args.buffer as { id: string }
        buffers.set(b.id, b)
        return null
      }
      case 'delete_buffer':
        buffers.delete(args.id as string)
        return null
      case 'connect_profile': {
        const id = args.id as string
        if (needsPassword.has(id) && !saved.has(id) && args.password === null) {
          throw { kind: 'passwordNeeded', message: 'no password is saved' }
        }
        const p = profiles.find((x) => x.id === id)
        return {
          id: nextSession++,
          engine: p?.engine ?? 'postgres',
          database: (args.database as string | null) ?? p?.database ?? null,
          readOnly: p?.mode === 'readOnly',
        }
      }
      case 'update_profile': {
        const change = args.password as { kind: string; password?: string }
        if (change.kind === 'set') saved.set(args.id as string, change.password ?? '')
        const p = profiles.find((x) => x.id === args.id)
        return { ...p, ...(args.fields as object) }
      }
      case 'list_databases':
        return ['quicksilver_dev', 'analytics', 'staging']
      case 'list_schemas':
        return ['public', 'sales']
      case 'list_objects':
        return args.schema === 'sales'
          ? [
              { name: 'orders', kind: 'table' },
              { name: 'recent_orders', kind: 'view' },
            ]
          : []
      case 'list_columns':
        return []
      case 'statement_at': {
        // Statements end at `;`: the one the cursor is in, trimmed.
        const script = args.script as string
        const cursor = args.cursor as number
        let start = script.lastIndexOf(';', cursor - 1) + 1
        let end = script.indexOf(';', cursor)
        if (end < 0) end = script.length
        while (start < end && /\s/.test(script[start] as string)) start++
        while (end > start && /\s/.test(script[end - 1] as string)) end--
        return start === end ? null : { start, end }
      }
      case 'run': {
        const send = sendTo(args.onEvent)
        const script = args.script as string
        const cap = args.rowCap as number | null
        const runId = nextId++
        // A read-write connection asks before a schema change.
        if (/\b(create|drop|alter)\b/i.test(script) && !args.confirmed) {
          throw {
            kind: 'confirmationNeeded',
            message: '1 statement may change the schema; run it anyway?',
            statements: [script.trim()],
          }
        }
        setTimeout(() => {
          send({ event: 'statementStarted', index: 0, span: { start: 0, end: script.length } })
          if (/error/i.test(script)) {
            send({
              event: 'failed',
              index: 0,
              error: {
                kind: 'query',
                message: 'column "error" does not exist',
                code: '42703',
                position: script.toLowerCase().indexOf('error') + 1,
                detail: null,
              },
            })
            return
          }
          const resultId = nextId++
          const many = /many/i.test(script)
          const rows = many
            ? Array.from({ length: cap ?? 250_000 }, (_, i) => [String(i + 1), `row ${i + 1}`])
            : PEOPLE.rows
          results.set(resultId, { columns: PEOPLE.columns, rows, order: rows.map((_, i) => i), script })
          send({ event: 'resultStarted', index: 0, resultId, columns: PEOPLE.columns })
          send({
            event: 'statementFinished',
            index: 0,
            resultId,
            outcome: {
              rowsReturned: rows.length,
              rowsAffected: null,
              capped: many && cap !== null,
              elapsedMs: 3,
            },
          })
          send({ event: 'finished', elapsedMs: 4 })
        }, 0)
        return runId
      }
      case 'result_info': {
        const r = results.get(args.result as number)
        return { columns: r?.columns ?? [], rows: r?.rows.length ?? 0, bytes: 0, spilledBytes: 0 }
      }
      case 'fetch_page': {
        const r = results.get(args.result as number)
        if (!r) throw { kind: 'config', message: 'no result' }
        const offset = args.offset as number
        const order = r.order.slice(offset, offset + (args.count as number))
        const picked = order.map((i) => r.rows[i] as (string | null)[])
        return encodePage(offset, picked, r.columns.length, order)
      }
      case 'sort_result': {
        const r = results.get(args.result as number)
        if (!r) return null
        const column = args.column as number | null
        const sign = args.direction === 'descending' ? -1 : 1
        r.order = r.rows.map((_, i) => i)
        if (column !== null) {
          r.order.sort((a, b) => {
            const [x, y] = [r.rows[a]?.[column], r.rows[b]?.[column]]
            if (x == null) return 1
            if (y == null) return -1
            return sign * (Number(x) - Number(y) || x.localeCompare(y))
          })
        }
        return null
      }
      case 'copy_rows': {
        const r = results.get(args.result as number)
        const columns = args.columns as number[]
        const format = args.format as { kind: string; header?: boolean }
        const offset = args.offset as number
        const lines = (r?.order ?? [])
          .slice(offset, offset + (args.count as number))
          .map((i) => columns.map((c) => r?.rows[i]?.[c] ?? '').join('\t'))
        if (format.header) lines.unshift(columns.map((c) => r?.columns[c]?.name).join('\t'))
        return `${lines.join('\n')}\n`
      }
      case 'edit_target': {
        const r = results.get(args.result as number)
        return /computed/i.test(r?.script ?? '')
          ? {
              reason: 'a column is computed, not read from a table',
              schema: null,
              table: null,
              byPrimaryKey: false,
              key: [],
            }
          : { reason: null, schema: 'public', table: 'people', byPrimaryKey: true, key: [0] }
      }
      case 'preview_edits':
      case 'apply_edits':
        return (args.edits as { kind: string; row?: number }[]).map(
          (e) => `${e.kind.toUpperCase()} row ${e.row ?? 'new'}`,
        )
      case 'filter_query': {
        const filter = (args.filter as string).trim()
        if (filter.includes(';'))
          throw {
            kind: 'query',
            message: 'That filter cannot be used: exactly one statement is allowed',
            code: null,
            position: null,
            detail: null,
          }
        const name = `"${args.schema}"."${args.table}"`
        return filter === ''
          ? `SELECT * FROM ${name};\n`
          : /^order\s+by/i.test(filter)
            ? `SELECT * FROM ${name} ${filter};\n`
            : `SELECT * FROM ${name} WHERE ${filter};\n`
      }
      case 'explain':
        return {
          roots: [
            {
              label: 'Seq Scan on orders',
              cost: 35.5,
              rows: 1200,
              details: [{ name: 'Filter', value: '(id > 1)' }],
              children: [],
            },
          ],
          raw: '[{"Plan": {}}]',
        }
      case 'list_foreign_keys':
        return []
      case 'object_ddl':
        return `CREATE TABLE "${args.schema}"."${args.name}" (id int);\n`
      case 'disconnect':
      case 'close_result':
        return null
      default:
        throw new Error(`the fake backend has no ${cmd}`)
    }
  })

  return {
    calls,
    results,
    called: (cmd: string) => calls.filter((c) => c.cmd === cmd),
  }
}
