// The rows the grid has fetched, a page at a time. Only pages near what is
// on screen are kept; the result itself stays in Rust.

import type { Page } from '../../ipc/page'

export const PAGE_ROWS = 256
const MAX_PAGES = 48

type Entry = { page: Page; used: number }

export class PageCache {
  private pages = new Map<number, Entry>()
  private loading = new Map<number, Promise<void>>()
  private clock = 0
  /** Bumped by `clear`, so a fetch started before it is thrown away. */
  private generation = 0

  constructor(
    private readonly fetch: (offset: number, count: number) => Promise<Page>,
    private readonly onLoad: () => void,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  /** The row, if its page is here. */
  row(index: number): (string | null)[] | undefined {
    const number = Math.floor(index / PAGE_ROWS)
    const entry = this.pages.get(number)
    if (!entry) return undefined
    entry.used = ++this.clock
    return entry.page.rows[index - entry.page.offset]
  }

  /** The row's place in arrival order (what edits name it by), if its page is here. */
  source(index: number): number | undefined {
    const entry = this.pages.get(Math.floor(index / PAGE_ROWS))
    return entry?.page.sources[index - entry.page.offset]
  }

  /**
   * Fetches the pages covering rows `[first, end)` that are missing, or
   * that were short because the result was still growing and now has more
   * than they hold. Resolves when they are in.
   */
  async ensure(first: number, end: number, rowCount: number): Promise<void> {
    const waits: Promise<void>[] = []
    for (let n = Math.floor(first / PAGE_ROWS); n * PAGE_ROWS < Math.min(end, rowCount); n++) {
      const entry = this.pages.get(n)
      const wanted = Math.min(PAGE_ROWS, rowCount - n * PAGE_ROWS)
      if (entry && entry.page.rows.length >= wanted) continue
      waits.push(this.load(n))
    }
    await Promise.all(waits)
  }

  private load(n: number): Promise<void> {
    const pending = this.loading.get(n)
    if (pending) return pending
    const generation = this.generation
    const done = this.fetch(n * PAGE_ROWS, PAGE_ROWS)
      .then((page) => {
        if (generation !== this.generation) return
        this.pages.set(n, { page, used: ++this.clock })
        this.evict()
        this.onLoad()
      })
      .catch((err) => {
        if (generation === this.generation) this.onError(err)
      })
      .finally(() => {
        if (this.loading.get(n) === done) this.loading.delete(n)
      })
    this.loading.set(n, done)
    return done
  }

  private evict() {
    if (this.pages.size <= MAX_PAGES) return
    const oldest = [...this.pages.entries()].sort((a, b) => a[1].used - b[1].used)
    for (const [n] of oldest.slice(0, this.pages.size - MAX_PAGES)) this.pages.delete(n)
  }

  /** Drops every page, as after a sort reorders the rows. */
  clear() {
    this.generation++
    this.pages.clear()
    this.loading.clear()
  }

  /** How many pages are held (tests). */
  get size(): number {
    return this.pages.size
  }
}
