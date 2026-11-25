/**
 * The shapes `qs-service` sends, mirrored by hand from the Rust types. When a
 * Rust type changes, change it here too; phase 4 replaces these with
 * bindings generated from Rust.
 */

export type Engine =
  | 'postgres'
  | 'mysql'
  | 'mariadb'
  | 'sqlite'
  | 'duckdb'
  | 'mssql'
  | 'clickhouse'
  | 'mongodb'
  | 'redis'
  | 'snowflake'
  | 'turso'

/** `qs_core::TypeTag`. */
export type TypeTag =
  | 'bool'
  | 'integer'
  | 'float'
  | 'decimal'
  | 'text'
  | 'bytes'
  | 'date'
  | 'time'
  | 'timestamp'
  | 'timestampTz'
  | 'interval'
  | 'uuid'
  | 'json'
  | 'array'
  | 'network'
  | 'other'

/** `qs_core::ColumnSource`. */
export type ColumnSource =
  | { postgresAttribute: { tableOid: number; columnId: number } }
  | { named: { schema: string | null; table: string; column: string } }

/** `qs_core::Column`. */
export type Column = {
  name: string
  typeTag: TypeTag
  dbType: string
  source: ColumnSource | null
}

/** `qs_core::Error`. */
export type QsError =
  | {
      kind: 'config' | 'connect' | 'passwordNeeded' | 'tls' | 'unsupported' | 'storage' | 'internal'
      message: string
    }
  | { kind: 'query'; message: string; code: string | null; position: number | null; detail: string | null }
  | { kind: 'cancelled' }
  | { kind: 'closed' }

/** `qs_drivers::Span`: byte offsets into the script. */
export type Span = { start: number; end: number }

/** `qs_drivers::StatementOutcome`. */
export type StatementOutcome = {
  rowsReturned: number
  rowsAffected: number | null
  capped: boolean
  elapsedMs: number
}

/** `qs_service::RunEvent`. */
export type RunEvent =
  | { event: 'statementStarted'; index: number; span: Span }
  | { event: 'resultStarted'; index: number; resultId: number; columns: Column[] }
  | { event: 'progress'; resultId: number; rows: number }
  | { event: 'statementFinished'; index: number; resultId: number | null; outcome: StatementOutcome }
  | { event: 'finished'; elapsedMs: number }
  | { event: 'failed'; index: number | null; error: QsError }

/** `qs_service::SessionInfo`. */
export type SessionInfo = {
  id: number
  engine: Engine
  /** The database it landed in, when known. */
  database: string | null
  readOnly: boolean
}

/** `qs_service::ResultInfo`. */
export type ResultInfo = { columns: Column[]; rows: number; bytes: number }

/** `qs_drivers::DbObject`. */
export type DbObject = {
  name: string
  kind: 'table' | 'view' | 'materializedView' | 'foreignTable' | 'sequence' | 'function' | 'procedure'
}

/** `qs_drivers::ColumnInfo`. */
export type ColumnInfo = {
  name: string
  dbType: string
  nullable: boolean
  default: string | null
  primaryKeyPosition: number | null
}
