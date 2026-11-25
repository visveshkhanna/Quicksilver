import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import type { ColumnInfo, ForeignKey } from '../../ipc/types'
import { type SchemaSource, schemaCompletion } from './completion'

const col = (name: string, pk: number | null = null): ColumnInfo => ({
  name,
  dbType: 'int4',
  nullable: pk === null,
  default: null,
  primaryKeyPosition: pk,
})

const source: SchemaSource = {
  defaultSchema: 'public',
  tables: () => [
    { schema: 'sales', name: 'orders', kind: 'table' },
    { schema: 'sales', name: 'accounts', kind: 'table' },
    { schema: 'public', name: 'notes', kind: 'view' },
    { schema: 'public', name: 'Order', kind: 'table' },
  ],
  columns: async (_schema, table) =>
    table === 'orders'
      ? [col('id', 1), col('account_id')]
      : table === 'accounts'
        ? [col('id', 1), col('name')]
        : [],
  foreignKeys: async (): Promise<ForeignKey[]> => [
    {
      name: 'orders_account_id_fkey',
      schema: 'sales',
      table: 'orders',
      columns: ['account_id'],
      refSchema: 'sales',
      refTable: 'accounts',
      refColumns: ['id'],
    },
  ],
}

async function complete(sql: string, explicit = false) {
  const pos = sql.indexOf('|')
  const state = EditorState.create({ doc: sql.replace('|', '') })
  const result = await schemaCompletion(() => source)(new CompletionContext(state, pos, explicit))
  return result ? { from: result.from, labels: result.options.map((o) => o.label) } : null
}

describe('schema completion', () => {
  it('lists columns after an alias', async () => {
    expect(await complete('select o.| from sales.orders o')).toEqual({
      from: 9,
      labels: ['id', 'account_id'],
    })
  })

  it('lists tables after FROM, qualified outside the default schema and quoted when needed', async () => {
    const result = await complete('select * from |', true)
    expect(result?.labels).toEqual(['sales.orders', 'sales.accounts', 'notes', '"Order"'])
  })

  it('lists a schema’s tables after its name', async () => {
    expect((await complete('select * from sales.|'))?.labels).toEqual(['orders', 'accounts'])
  })

  it('offers the whole JOIN condition from the foreign key, either way round', async () => {
    expect((await complete('select * from sales.orders o join sales.accounts a on |'))?.labels).toEqual([
      'o.account_id = a.id',
    ])
    expect((await complete('select * from sales.accounts a join sales.orders o on |'))?.labels).toEqual([
      'o.account_id = a.id',
    ])
  })

  it('offers columns in scope, then tables, once something is typed', async () => {
    expect(await complete('select | from sales.orders')).toBeNull()
    const result = await complete('select a| from sales.orders')
    expect(result?.labels.slice(0, 2)).toEqual(['id', 'account_id'])
    expect(result?.labels).toContain('sales.accounts')
  })
})
