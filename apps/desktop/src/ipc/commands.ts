import { Channel, invoke, isTauri } from '@tauri-apps/api/core'
import { decodePage, type Page } from './page'
import type {
  AppInfo,
  ColumnInfo,
  CopyFormat,
  DbObject,
  Engine,
  ForeignKey,
  ObjectKind,
  Plan,
  ResultInfo,
  RunEvent,
  SessionInfo,
  SortDirection,
  StatementRange,
} from './types'

export type { AppInfo } from './types'

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

/** The statement under the cursor, as UTF-16 offsets into `script`. */
export function statementAt(script: string, engine: Engine, cursor: number): Promise<StatementRange | null> {
  return invoke('statement_at', { script, engine, cursor })
}

/** Sorts a finished result by `column`, or restores arrival order with `null`. */
export function sortResult(result: number, column: number | null, direction: SortDirection = 'ascending') {
  return invoke<void>('sort_result', { result, column, direction })
}

/** Rows `offset .. offset + count` of a result, as shown, in `format`. */
export function copyRows(
  result: number,
  offset: number,
  count: number,
  columns: number[],
  format: CopyFormat,
): Promise<string> {
  return invoke('copy_rows', { result, offset, count, columns, format })
}

export function listForeignKeys(session: number, schema: string): Promise<ForeignKey[]> {
  return invoke('list_foreign_keys', { session, schema })
}

/** How the server would run one statement, without running it. */
export function explain(session: number, statement: string): Promise<Plan> {
  return invoke('explain', { session, statement })
}

/** The SQL that creates an object. */
export function objectDdl(session: number, schema: string, name: string, kind: ObjectKind): Promise<string> {
  return invoke('object_ddl', { session, schema, name, kind })
}
