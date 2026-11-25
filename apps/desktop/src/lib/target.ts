// Where a tab points, and small helpers for naming things there.

import type { Engine } from '../ipc/types'

/** A connection and database a tab runs against. */
export type Target = { profileId: string; database: string | null }

/** A stable key for a connection + database, for maps and recents. */
export function targetKey(profileId: string, database: string | null): string {
  return `${profileId}\u0000${database ?? ''}`
}

export function parseTargetKey(key: string): Target {
  const [profileId = '', database = ''] = key.split('\u0000')
  return { profileId, database: database === '' ? null : database }
}

/** Quotes an identifier for `engine`'s SQL. */
export function quoteIdent(name: string, engine: Engine): string {
  if (engine === 'mysql' || engine === 'mariadb' || engine === 'clickhouse') {
    return `\`${name.replaceAll('`', '``')}\``
  }
  if (engine === 'mssql') return `[${name.replaceAll(']', ']]')}]`
  return `"${name.replaceAll('"', '""')}"`
}

/**
 * A starting query for an object, put in the editor for the user to read and
 * run. It is never run on its own.
 */
export function selectFrom(engine: Engine, schema: string | null, name: string): string {
  const qualified =
    schema && !(engine === 'sqlite' && schema === 'main')
      ? `${quoteIdent(schema, engine)}.${quoteIdent(name, engine)}`
      : quoteIdent(name, engine)
  return `SELECT * FROM ${qualified};\n`
}

/** The fixed connection colours, as CSS colours. */
export const COLORS = {
  red: '#e5484d',
  orange: '#f76b15',
  yellow: '#e2a336',
  green: '#30a46c',
  teal: '#12a594',
  blue: '#3e63dd',
  purple: '#8e4ec6',
  gray: '#8b8d98',
} as const
