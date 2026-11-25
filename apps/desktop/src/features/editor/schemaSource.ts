// What completion knows about a tab's database: tables from the catalog
// cache straight away, columns and foreign keys from the server on first
// use, remembered per session.

import * as ipc from '../../ipc/commands'
import type { ColumnInfo, ForeignKey } from '../../ipc/types'
import { ensureSession, profileById, type Tab, useApp } from '../../state/app'
import type { SchemaSource, SchemaTable } from './completion'

const TABLE_KINDS = new Set(['table', 'view', 'materializedView', 'foreignTable'])

const columnCache = new Map<string, Promise<ColumnInfo[]>>()
const keyCache = new Map<string, Promise<ForeignKey[]>>()

function cached<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
  empty: T,
): Promise<T> {
  let found = cache.get(key)
  if (!found) {
    found = load().catch(() => {
      // Forget a failure so the next keystroke tries again.
      cache.delete(key)
      return empty
    })
    cache.set(key, found)
  }
  return found
}

/** The schema source for `tab`'s target, or `null` when it has none. */
export function schemaSourceFor(tab: Pick<Tab, 'profileId' | 'database'>): SchemaSource | null {
  const profile = profileById(tab.profileId)
  if (!profile) return null
  const target = `${profile.id}\u0000${tab.database ?? profile.database ?? ''}`
  return {
    defaultSchema: profile.engine === 'sqlite' ? 'main' : 'public',
    tables(): SchemaTable[] {
      const database = tab.database ?? profile.database
      return useApp
        .getState()
        .catalog.filter(
          (e) =>
            e.profileId === profile.id &&
            (database === null || e.database === database) &&
            e.schema !== null &&
            e.name !== null &&
            TABLE_KINDS.has(e.kind),
        )
        .map((e) => ({ schema: e.schema as string, name: e.name as string, kind: e.kind }))
    },
    columns: (schema, table) =>
      cached(
        columnCache,
        `${target}\u0000${schema}\u0000${table}`,
        async () => ipc.listColumns((await ensureSession(profile.id, tab.database)).id, schema, table),
        [],
      ),
    foreignKeys: (schema) =>
      cached(
        keyCache,
        `${target}\u0000${schema}`,
        async () => ipc.listForeignKeys((await ensureSession(profile.id, tab.database)).id, schema),
        [],
      ),
  }
}

/** Forgets what was learned about a connection, as after a refresh. */
export function forgetSchema(profileId: string) {
  for (const cache of [columnCache, keyCache]) {
    for (const key of cache.keys()) if (key.startsWith(`${profileId}\u0000`)) cache.delete(key)
  }
}
