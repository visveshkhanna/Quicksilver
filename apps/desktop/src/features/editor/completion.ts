// Schema-aware completion for the SQL editor: tables from the catalog cache,
// columns of the tables a statement reads (through their aliases), and whole
// `JOIN … ON` conditions from foreign keys.

import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { ColumnInfo, ForeignKey } from '../../ipc/types'
import { ident, refName, type TableRef, wantAt } from './sqlContext'

export type SchemaTable = { schema: string; name: string; kind: string }

/** What completion knows about the tab's database. */
export type SchemaSource = {
  /** The schema unqualified names resolve to (`public`, `main`). */
  defaultSchema: string
  /** Tables, views and the like, known without asking the server. */
  tables(): SchemaTable[]
  /** The columns of a table; may ask the server. */
  columns(schema: string, table: string): Promise<ColumnInfo[]>
  /** The foreign keys starting or ending in a schema; may ask the server. */
  foreignKeys(schema: string): Promise<ForeignKey[]>
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The catalog table a reference names, preferring the default schema. */
function resolve(source: SchemaSource, ref: TableRef): SchemaTable | null {
  const tables = source.tables()
  const named = tables.filter(
    (t) => same(t.name, ref.name) && (ref.schema === null || same(t.schema, ref.schema)),
  )
  return named.find((t) => t.schema === source.defaultSchema) ?? named[0] ?? null
}

function columnOption(column: ColumnInfo, detail: string, boost = 0): Completion {
  return {
    label: column.name,
    apply: ident(column.name),
    type: column.primaryKeyPosition !== null ? 'constant' : 'property',
    detail: `${column.dbType}${detail ? ` · ${detail}` : ''}`,
    boost,
  }
}

function tableLabel(source: SchemaSource, table: SchemaTable): string {
  return table.schema === source.defaultSchema
    ? ident(table.name)
    : `${ident(table.schema)}.${ident(table.name)}`
}

function tableOptions(source: SchemaSource): Completion[] {
  return source.tables().map((t) => ({
    label: tableLabel(source, t),
    type: t.kind === 'view' || t.kind === 'materializedView' ? 'interface' : 'class',
    detail: t.kind === 'table' ? undefined : t.kind,
  }))
}

/** `JOIN … ON` conditions linking `joined` to the other tables in scope. */
async function joinConditions(
  source: SchemaSource,
  joined: TableRef,
  scope: TableRef[],
): Promise<Completion[]> {
  const table = resolve(source, joined)
  if (!table) return []
  const keys = await source.foreignKeys(table.schema)
  const options: Completion[] = []
  for (const other of scope) {
    if (other.start === joined.start) continue
    const target = resolve(source, other)
    if (!target) continue
    for (const key of keys) {
      const forward =
        same(key.table, table.name) && same(key.schema, table.schema) && same(key.refTable, target.name)
      const backward =
        same(key.refTable, table.name) && same(key.refSchema, table.schema) && same(key.table, target.name)
      if (!forward && !backward) continue
      const [from, to] = forward ? [joined, other] : [other, joined]
      const [fromColumns, toColumns] = [key.columns, key.refColumns]
      const label = fromColumns
        .map(
          (c, i) => `${ident(refName(from))}.${ident(c)} = ${ident(refName(to))}.${ident(toColumns[i] ?? c)}`,
        )
        .join(' AND ')
      options.push({ label, type: 'keyword', detail: key.name ?? 'foreign key', boost: 10 })
    }
  }
  return options
}

/** A CodeMirror completion source over `source()`; `null` while the tab has no database. */
export function schemaCompletion(source: () => SchemaSource | null) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const schema = source()
    if (!schema) return null
    const sql = context.state.doc.toString()
    const { want, scope } = wantAt(sql, context.pos)
    const typed = context.pos > want.from
    // Only offer names unprompted once something is typed, or after a `.`.
    if (!context.explicit && !typed && want.kind !== 'member' && want.kind !== 'joinCondition') return null

    let options: Completion[] = []
    switch (want.kind) {
      case 'member': {
        const ref = scope.find(
          (r) => (r.alias && same(r.alias, want.qualifier)) || same(r.name, want.qualifier),
        )
        const table = ref ? resolve(schema, ref) : null
        if (table) {
          const columns = await schema.columns(table.schema, table.name)
          options = columns.map((c) => columnOption(c, ''))
        } else {
          // `schema.` lists that schema's tables.
          options = schema
            .tables()
            .filter((t) => same(t.schema, want.qualifier))
            .map((t) => ({ label: ident(t.name), type: 'class', detail: t.kind }))
        }
        break
      }
      case 'table':
        options = tableOptions(schema)
        break
      case 'joinCondition':
        options = await joinConditions(schema, want.table, scope)
        break
      case 'any': {
        const lists = await Promise.all(
          scope.map(async (ref) => {
            const table = resolve(schema, ref)
            if (!table) return []
            const columns = await schema.columns(table.schema, table.name)
            return columns.map((c) => columnOption(c, scope.length > 1 ? refName(ref) : '', 2))
          }),
        )
        options = [...lists.flat(), ...tableOptions(schema).map((o) => ({ ...o, boost: -1 }))]
        break
      }
    }
    if (options.length === 0) return null
    return { from: want.from, options, validFor: /^[\w$"]*$/ }
  }
}
