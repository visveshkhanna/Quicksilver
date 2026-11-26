// The connection form's URL, written from its fields. Reading a URL back
// into fields is Rust's job (`parse_url`); this only writes one for display,
// so the URL field always says what the other fields say. It never holds a
// password.

import type { ProfileFields } from '../../ipc/store'
import type { Engine } from '../../ipc/types'

const SCHEMES: Partial<Record<Engine, string>> = {
  postgres: 'postgres',
  mysql: 'mysql',
  mariadb: 'mariadb',
  sqlite: 'sqlite',
  duckdb: 'duckdb',
  mssql: 'sqlserver',
  clickhouse: 'clickhouse',
  mongodb: 'mongodb',
  redis: 'redis',
  snowflake: 'snowflake',
}

const FILE_ENGINES = new Set<Engine>(['sqlite', 'duckdb'])

/** Percent-encodes what would end a URL part early, leaving `@` readable where it is safe. */
function part(text: string): string {
  return encodeURIComponent(text)
}

/** The URL for `fields`, or `''` when there is nothing to say yet. */
export function formatUrl(fields: ProfileFields): string {
  const scheme = SCHEMES[fields.engine] ?? fields.engine
  if (FILE_ENGINES.has(fields.engine)) {
    if (!fields.path) return ''
    const path = fields.path.startsWith('/') ? fields.path : `/${fields.path}`
    return `${scheme}://${encodeURI(path)}`
  }
  if (!fields.host && !fields.user && !fields.database) return ''
  const user = fields.user ? `${part(fields.user)}@` : ''
  const host = fields.host?.includes(':') ? `[${fields.host}]` : (fields.host ?? '')
  const port = fields.port ? `:${fields.port}` : ''
  const database = fields.database ? `/${part(fields.database)}` : ''
  const query = new URLSearchParams()
  if (fields.sslMode !== 'prefer') query.set('sslmode', fields.sslMode)
  if (fields.sslRootCert) query.set('sslrootcert', fields.sslRootCert)
  for (const [key, value] of Object.entries(fields.options)) query.set(key, value)
  const search = query.size > 0 ? `?${query.toString()}` : ''
  return `${scheme}://${user}${host}${port}${database}${search}`
}
