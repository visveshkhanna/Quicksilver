import { describe, expect, it } from 'vitest'
import { ident, statementTokens, tablesInScope, tokenize, wantAt } from './sqlContext'

/** `wantAt` with the cursor where `|` is. */
function at(sql: string) {
  const cursor = sql.indexOf('|')
  return wantAt(sql.replace('|', ''), cursor)
}

describe('tokenize', () => {
  it('skips comments and keeps strings and quoted names whole', () => {
    const tokens = tokenize(`select 'it''s from x', "My ""T"" " -- from y\n/* from z */ from $$ from w $$`)
    expect(tokens.map((t) => [t.kind, t.text])).toEqual([
      ['word', 'select'],
      ['string', "'it''s from x'"],
      ['punct', ','],
      ['quoted', 'My "T" '],
      ['word', 'from'],
      ['string', '$$ from w $$'],
    ])
  })
})

describe('tablesInScope', () => {
  const scope = (sql: string) =>
    tablesInScope(statementTokens(sql, 0)).map(({ schema, name, alias }) => [schema, name, alias])

  it('finds tables, schemas and aliases after FROM and JOIN', () => {
    expect(
      scope(
        'SELECT * FROM sales.orders o JOIN "Sales"."Line Items" AS li ON li.order_id = o.id LEFT JOIN accounts WHERE 1',
      ),
    ).toEqual([
      ['sales', 'orders', 'o'],
      ['Sales', 'Line Items', 'li'],
      [null, 'accounts', null],
    ])
  })

  it('reads comma lists, UPDATE and INSERT INTO', () => {
    expect(scope('select 1 from a x, b, c as z where 1')).toEqual([
      [null, 'a', 'x'],
      [null, 'b', null],
      [null, 'c', 'z'],
    ])
    expect(scope('update t set a = 1')).toEqual([[null, 't', null]])
    expect(scope('insert into s.t (a) values (1)')).toEqual([['s', 't', null]])
  })

  it('does not take a clause word for an alias', () => {
    expect(scope('select * from t order by 1')).toEqual([[null, 't', null]])
    expect(scope('select * from t join u using (id)')).toEqual([
      [null, 't', null],
      [null, 'u', null],
    ])
  })

  it('looks only at the statement around the cursor', () => {
    const sql = 'select * from a; select * from b'
    expect(tablesInScope(statementTokens(sql, sql.length)).map((t) => t.name)).toEqual(['b'])
    expect(tablesInScope(statementTokens(sql, 3)).map((t) => t.name)).toEqual(['a'])
  })
})

describe('wantAt', () => {
  it('completes a member after an alias, even half typed', () => {
    expect(at('select o.| from orders o').want).toEqual({ kind: 'member', qualifier: 'o', from: 9 })
    expect(at('select o.ac| from orders o').want).toEqual({ kind: 'member', qualifier: 'o', from: 9 })
    expect(at('select "My T".| from "My T"').want).toMatchObject({ kind: 'member', qualifier: 'My T' })
  })

  it('wants a table after FROM, JOIN and a comma in a FROM list', () => {
    expect(at('select * from |').want.kind).toBe('table')
    expect(at('select * from ord|').want).toEqual({ kind: 'table', from: 14 })
    expect(at('select * from a join |').want.kind).toBe('table')
    expect(at('select * from a, |').want.kind).toBe('table')
    expect(at('select a, | from t').want.kind).toBe('any')
  })

  it('wants a join condition right after ON', () => {
    const { want } = at('select * from orders o join accounts a on |')
    expect(want).toMatchObject({ kind: 'joinCondition', table: { name: 'accounts', alias: 'a' } })
  })

  it('wants anything elsewhere, and knows the scope', () => {
    const { want, scope } = at('select | from sales.orders o')
    expect(want.kind).toBe('any')
    expect(scope.map((t) => t.alias)).toEqual(['o'])
  })
})

describe('ident', () => {
  it('quotes only what needs it', () => {
    expect(ident('orders')).toBe('orders')
    expect(ident('Orders')).toBe('"Orders"')
    expect(ident('order')).toBe('"order"')
    expect(ident('a"b')).toBe('"a""b"')
  })
})
