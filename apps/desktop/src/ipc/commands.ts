import { Channel, invoke, isTauri } from '@tauri-apps/api/core'
import { decodePage, type Page } from './page'
import type { ColumnInfo, DbObject, ResultInfo, RunEvent, SessionInfo } from './types'

/** One engine, as `qs-service` describes it. */
export type EngineInfo = {
  id: string
  name: string
  defaultPort: number | null
}

/** What the app reports about itself (`qs_service::AppInfo`). */
export type AppInfo = {
  name: string
  version: string
  engines: EngineInfo[]
}

/**
 * The app's name, version and known engines.
 *
 * Outside the Tauri shell (the UI opened in a plain browser with `pnpm
 * dev:web`) there is no backend, so this resolves to `null` and the UI shows
 * that it is running without one.
 */
export async function appInfo(): Promise<AppInfo | null> {
  if (!isTauri()) return null
  return invoke<AppInfo>('app_info')
}

/** Opens a session from a connection URL. Rejects with a `QsError`. */
export function connect(url: string, password?: string): Promise<SessionInfo> {
  return invoke('connect', { url, password: password ?? null })
}

export function disconnect(session: number): Promise<void> {
  return invoke('disconnect', { session })
}

/** Where a run came from, for its history entry. */
export type RunContext = { profileId: string | null; database: string | null }

/**
 * Starts a script; `onEvent` receives every `RunEvent`. Resolves to the run
 * id. The run is added to history under `context`.
 */
export function run(
  session: number,
  script: string,
  rowCap: number | null,
  onEvent: (event: RunEvent) => void,
  context: RunContext = { profileId: null, database: null },
): Promise<number> {
  const channel = new Channel<RunEvent>()
  channel.onmessage = onEvent
  return invoke('run', { session, script, rowCap, ...context, onEvent: channel })
}

export function cancelRun(run: number): Promise<void> {
  return invoke('cancel_run', { run })
}

/** A page of rows, fetched as raw bytes and decoded here. */
export async function fetchPage(result: number, offset: number, count: number): Promise<Page> {
  const bytes = await invoke<ArrayBuffer>('fetch_page', { result, offset, count })
  return decodePage(bytes)
}

export function resultInfo(result: number): Promise<ResultInfo> {
  return invoke('result_info', { result })
}

export function closeResult(result: number): Promise<void> {
  return invoke('close_result', { result })
}

export function listDatabases(session: number): Promise<string[]> {
  return invoke('list_databases', { session })
}

export function listSchemas(session: number): Promise<string[]> {
  return invoke('list_schemas', { session })
}

export function listObjects(session: number, schema: string): Promise<DbObject[]> {
  return invoke('list_objects', { session, schema })
}

export function listColumns(session: number, schema: string, table: string): Promise<ColumnInfo[]> {
  return invoke('list_columns', { session, schema, table })
}
