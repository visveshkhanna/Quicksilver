import { describe, expect, it, vi } from 'vitest'
import {
  borderAt,
  columnAt,
  contains,
  display,
  HEADER_HEIGHT,
  layout,
  move,
  ROW_HEIGHT,
  rowAt,
  scrollToRow,
  visibleRows,
} from './model'
import { PAGE_ROWS, PageCache } from './pages'

const states = [
  { width: 100, hidden: false, pinned: false },
  { width: 50, hidden: true, pinned: false },
  { width: 80, hidden: false, pinned: true },
  { width: 120, hidden: false, pinned: false },
]

describe('layout', () => {
  it('puts pinned columns first and leaves hidden ones out', () => {
    const l = layout(states, 1000)
    expect(l.order).toEqual([2, 0, 3])
    expect(l.left).toEqual([0, 80, 180])
    expect(l.pinnedWidth).toBe(80)
    expect(l.totalWidth).toBe(300)
    expect(l.gutter).toBe(48)
  })

  it('hit-tests pinned columns in place and the rest through the scroll', () => {
    const l = layout(states, 10)
    const g = l.gutter
    expect(columnAt(l, g - 1, 0)).toBeNull()
    expect(columnAt(l, g + 10, 500)).toBe(0) // pinned ignores scroll
    expect(columnAt(l, g + 85, 0)).toBe(1)
    expect(columnAt(l, g + 85, 100)).toBe(2) // column 1 scrolled under
    expect(columnAt(l, g + 1000, 0)).toBeNull()
    expect(borderAt(l, g + 80, 0)).toBe(0)
    expect(borderAt(l, g + 181, 0)).toBe(1)
    expect(borderAt(l, g + 120, 0)).toBeNull()
  })
})

describe('rows', () => {
  it('maps y to rows below the header and lists what is visible', () => {
    expect(rowAt(HEADER_HEIGHT - 1, 0, 100)).toBeNull()
    expect(rowAt(HEADER_HEIGHT + ROW_HEIGHT * 2 + 1, 0, 100)).toBe(2)
    expect(rowAt(HEADER_HEIGHT, ROW_HEIGHT * 10, 100)).toBe(10)
    expect(rowAt(HEADER_HEIGHT + 5, ROW_HEIGHT * 200, 100)).toBeNull()
    expect(visibleRows(ROW_HEIGHT * 5, HEADER_HEIGHT + ROW_HEIGHT * 3, 1_000_000)).toEqual([5, 9])
    expect(visibleRows(0, 1000, 3)).toEqual([0, 3])
  })

  it('scrolls just enough to show a row', () => {
    const height = HEADER_HEIGHT + ROW_HEIGHT * 10
    expect(scrollToRow(3, 0, height)).toBe(0)
    expect(scrollToRow(12, 0, height)).toBe(ROW_HEIGHT * 3)
    expect(scrollToRow(1, ROW_HEIGHT * 5, height)).toBe(ROW_HEIGHT)
  })
})

describe('selection', () => {
  it('moves, extends and clamps', () => {
    let sel = move(null, 0, 0, false, 10, 3)
    expect(sel).toEqual({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } })
    sel = move(sel, 2, 5, true, 10, 3)
    expect(sel).toEqual({ anchor: { row: 0, col: 0 }, focus: { row: 2, col: 2 } })
    expect(contains(sel, 1, 1)).toBe(true)
    expect(contains(sel, 3, 1)).toBe(false)
    sel = move(sel, 100, 0, false, 10, 3)
    expect(sel).toEqual({ anchor: { row: 9, col: 2 }, focus: { row: 9, col: 2 } })
    expect(move(sel, 1, 1, false, 0, 3)).toBeNull()
  })

  it('shows cells on one line', () => {
    expect(display('a\nb\r\nc\td')).toBe('a↵b↵c d')
    expect(display('x'.repeat(500)).length).toBe(401)
  })
})

describe('PageCache', () => {
  const page = (offset: number, count: number) => ({
    offset,
    columnCount: 1,
    rows: Array.from({ length: count }, (_, i) => [String(offset + i)]),
  })

  it('fetches each missing page once and serves rows from it', async () => {
    const fetch = vi.fn(async (offset: number, count: number) => page(offset, Math.min(count, 600 - offset)))
    const onLoad = vi.fn()
    const cache = new PageCache(fetch, onLoad)
    await Promise.all([cache.ensure(0, 300, 600), cache.ensure(10, 20, 600)])
    expect(fetch.mock.calls).toEqual([
      [0, PAGE_ROWS],
      [PAGE_ROWS, PAGE_ROWS],
    ])
    expect(cache.row(299)).toEqual(['299'])
    expect(cache.row(600)).toBeUndefined()
    expect(onLoad).toHaveBeenCalledTimes(2)
  })

  it('refetches a short page once the result has grown', async () => {
    let available = 100
    const fetch = vi.fn(async (offset: number) =>
      page(offset, Math.max(0, Math.min(PAGE_ROWS, available - offset))),
    )
    const cache = new PageCache(fetch, () => {})
    await cache.ensure(0, 50, available)
    expect(cache.row(150)).toBeUndefined()
    available = 200
    await cache.ensure(0, 200, available)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(cache.row(150)).toEqual(['150'])
  })

  it('keeps only recent pages, and drops a fetch made before a clear', async () => {
    let release: () => void = () => {}
    const slow = new Promise<void>((r) => {
      release = r
    })
    const fetch = vi.fn(async (offset: number, count: number) => {
      if (offset === 0 && fetch.mock.calls.length === 1) await slow
      return page(offset, count)
    })
    const cache = new PageCache(fetch, () => {})
    const first = cache.ensure(0, 1, 1_000_000)
    cache.clear()
    release()
    await first
    expect(cache.row(0)).toBeUndefined()

    for (let n = 0; n < 60; n++) await cache.ensure(n * PAGE_ROWS, n * PAGE_ROWS + 1, 1_000_000)
    expect(cache.size).toBe(48)
    expect(cache.row(59 * PAGE_ROWS)).toBeDefined()
    expect(cache.row(0)).toBeUndefined()
  })
})
