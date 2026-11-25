// What Quicksilver keeps between runs, mirrored from `qs-store` and wrapped
// as calls to the commands in `src-tauri/src/saved.rs`.

import { invoke } from '@tauri-apps/api/core'
import type { Engine, SessionInfo } from './types'

/** `qs_core::SslMode`. */
export type SslMode = 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full'

/** `qs_store::Color`: a connection's marker colour. */
export type Color = 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'purple' | 'gray'

/** `qs_store::Auth`: where a connection's password comes from. */
export type Auth =
  | { kind: 'none' }
  | { kind: 'keychain' }
  | { kind: 'command'; program: string; args: string[] }

/** `qs_store::Mode`: what a connection may do. */
export type Mode = 'readOnly' | 'readWrite' | 'full'

/** `qs_store::ProfileFields`: what a person edits about a connection. */
export type ProfileFields = {
  name: string
  project: string | null
  color: Color | null
  engine: Engine
  host: string | null
  port: number | null
  user: string | null
  database: string | null
  path: string | null
  sslMode: SslMode
  sslRootCert: string | null
  options: Record<string, string>
  auth: Auth
  mode: Mode
}

/** `qs_store::Profile`: a saved connection. */
export type Profile = ProfileFields & { id: string; createdMs: number; updatedMs: number }

/** `qs_store::PasswordChange`. */
export type PasswordChange = { kind: 'keep' } | { kind: 'set'; password: string } | { kind: 'clear' }

/** `qs_store::Notice`: something to tell the user once, after start-up. */
export type Notice =
  | { kind: 'recovered'; file: string; keptAs: string; reason: string }
  | { kind: 'newerFormat'; file: string; version: number }

/** `qs_store::HistoryEntry`. */
export type HistoryEntry = {
  id: number
  profileId: string | null
  database: string | null
  sql: string
  startedMs: number
  elapsedMs: number | null
  rows: number | null
  error: string | null
}

/** `qs_store::HistoryQuery`. Every field is optional. */
export type HistoryQuery = {
  profileId?: string | null
  text?: string | null
  beforeId?: number | null
  limit?: number | null
}

/** `qs_store::SavedQuery`. */
export type SavedQuery = {
  id: string
  name: string
  profileId: string | null
  sql: string
  createdMs: number
  updatedMs: number
}

/** `qs_store::Buffer`: an editor tab's contents. */
export type Buffer = {
  id: string
  profileId: string | null
  database: string | null
  title: string
  sql: string
  cursor: number
  position: number
  updatedMs: number
}

/** `qs_store::CatalogEntry`: one name the `Mod+K` switcher can find. */
export type CatalogEntry = {
  profileId: string
  database: string
  schema: string | null
  name: string | null
  kind: string
  refreshedMs: number
}

export const storeNotices = (): Promise<Notice[]> => invoke('store_notices')

export const listProfiles = (): Promise<Profile[]> => invoke('list_profiles')

export const createProfile = (
  fields: ProfileFields,
  password: PasswordChange = { kind: 'keep' },
): Promise<Profile> => invoke('create_profile', { fields, password })

export const updateProfile = (
  id: string,
  fields: ProfileFields,
  password: PasswordChange = { kind: 'keep' },
): Promise<Profile> => invoke('update_profile', { id, fields, password })

export const deleteProfile = (id: string): Promise<void> => invoke('delete_profile', { id })

/**
 * Opens a session for a saved connection, in `database` or the profile's
 * own. Rejects with `{ kind: 'passwordNeeded' }` when it uses the keychain
 * and nothing is saved; call again with the password the user typed.
 */
export const connectProfile = (
  id: string,
  database: string | null = null,
  password: string | null = null,
): Promise<SessionInfo> => invoke('connect_profile', { id, database, password })

/** Connects with unsaved form fields and disconnects. */
export const testConnection = (
  fields: ProfileFields,
  id: string | null,
  password: string | null,
): Promise<void> => invoke('test_connection', { fields, id, password })

/** A pasted URL, read into form fields. */
export type ParsedUrl = { fields: ProfileFields; password: string | null }

export const parseUrl = (url: string): Promise<ParsedUrl> => invoke('parse_url', { url })

export const refreshCatalog = (session: number, profileId: string, database: string | null): Promise<void> =>
  invoke('refresh_catalog', { session, profileId, database })

export const catalog = (profileId: string | null = null): Promise<CatalogEntry[]> =>
  invoke('catalog', { profileId })

export const history = (query: HistoryQuery = {}): Promise<HistoryEntry[]> => invoke('history', { query })

export const clearHistory = (profileId: string | null = null): Promise<void> =>
  invoke('clear_history', { profileId })

export const savedQueries = (profileId: string | null = null): Promise<SavedQuery[]> =>
  invoke('saved_queries', { profileId })

export const saveQuery = (query: {
  id?: string | null
  name: string
  profileId: string | null
  sql: string
}): Promise<SavedQuery> =>
  invoke('save_query', {
    id: query.id ?? null,
    name: query.name,
    profileId: query.profileId,
    sql: query.sql,
  })

export const deleteQuery = (id: string): Promise<void> => invoke('delete_query', { id })

export const buffers = (): Promise<Buffer[]> => invoke('buffers')

export const saveBuffer = (buffer: Omit<Buffer, 'updatedMs'>): Promise<void> =>
  invoke('save_buffer', { buffer: { ...buffer, updatedMs: 0 } })

export const deleteBuffer = (id: string): Promise<void> => invoke('delete_buffer', { id })

export const getLayout = <T>(key: string): Promise<T | null> => invoke('get_layout', { key })

export const setLayout = (key: string, value: unknown): Promise<void> => invoke('set_layout', { key, value })
