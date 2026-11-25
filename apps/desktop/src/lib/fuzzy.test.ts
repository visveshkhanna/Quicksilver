import { describe, expect, it } from 'vitest'
import { fuzzyFilter, fuzzyMatch } from './fuzzy'

describe('fuzzyMatch', () => {
  it('needs every character in order, ignoring case', () => {
    expect(fuzzyMatch('ANA', 'prod-pg / analytics')).not.toBeNull()
    expect(fuzzyMatch('xyz', 'prod-pg / analytics')).toBeNull()
    expect(fuzzyMatch('sp', 'ps')).toBeNull()
  })

  it('matches everything for an empty query', () => {
    expect(fuzzyMatch('  ', 'anything')).toEqual({ score: 0, positions: [] })
  })

  it('reports positions for highlighting', () => {
    expect(fuzzyMatch('pa', 'prod / analytics')?.positions).toEqual([0, 7])
  })

  it('never skips ahead past text the rest of the query needs', () => {
    expect(fuzzyMatch('prod quicksilver', 'prod-pg / quicksilver_dev')).not.toBeNull()
  })

  it('ignores spaces in the query', () => {
    expect(fuzzyMatch('pg ana', 'prod-pg / analytics')).not.toBeNull()
  })
})

describe('fuzzyFilter', () => {
  const names = ['fiscal_all', 'sales', 'staging / sales_archive', 'analytics']

  it('ranks word starts and runs above scattered matches', () => {
    const ranked = fuzzyFilter(names, 'sal', (n) => n).map((r) => r.item)
    expect(ranked[0]).toBe('sales')
    expect(ranked.indexOf('fiscal_all')).toBeGreaterThan(ranked.indexOf('sales'))
    expect(ranked).not.toContain('analytics')
  })

  it('keeps the input order when the query is empty', () => {
    expect(fuzzyFilter(names, '', (n) => n).map((r) => r.item)).toEqual(names)
  })
})
