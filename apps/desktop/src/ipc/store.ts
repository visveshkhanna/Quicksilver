// What Quicksilver keeps between runs: the commands in
// `src-tauri/src/saved.rs`, with types generated from `qs-store`.

import { invoke } from '@tauri-apps/api/core'
import type { Buffer } from './generated/Buffer'
import type { CatalogEntry } from './generated/CatalogEntry'
import type { HistoryEntry } from './generated/HistoryEntry'
import type { HistoryQuery } from './generated/HistoryQuery'
import type { Notice } from './generated/Notice'
import type { ParsedUrl } from './generated/ParsedUrl'
import type { PasswordChange } from './generated/PasswordChange'
import type { Profile } from './generated/Profile'
import type { ProfileFields } from './generated/ProfileFields'
import type { SavedQuery } from './generated/SavedQuery'
import type { SessionInfo } from './types'

export type { Auth } from './generated/Auth'
export type { Buffer } from './generated/Buffer'
export type { CatalogEntry } from './generated/CatalogEntry'
export type { Color } from './generated/Color'
export type { HistoryEntry } from './generated/HistoryEntry'
export type { HistoryQuery } from './generated/HistoryQuery'
export type { Mode } from './generated/Mode'
export type { Notice } from './generated/Notice'
export type { ParsedUrl } from './generated/ParsedUrl'
export type { PasswordChange } from './generated/PasswordChange'
export type { Profile } from './generated/Profile'
export type { ProfileFields } from './generated/ProfileFields'
export type { SavedQuery } from './generated/SavedQuery'
export type { SslMode } from './generated/SslMode'

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
