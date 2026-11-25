// A stand-in for the Rust side, behind Tauri's IPC mock, so UI flows can be
// tested end to end in jsdom. It keeps just enough state to answer the
// commands the flows use, and records every call.

import { mockIPC } from '@tauri-apps/api/mocks'
import type { CatalogEntry, Profile, ProfileFields } from '../ipc/store'

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
      case 'disconnect':
      case 'close_result':
        return null
      default:
        throw new Error(`the fake backend has no ${cmd}`)
    }
  })

  return {
    calls,
    called: (cmd: string) => calls.filter((c) => c.cmd === cmd),
  }
}
