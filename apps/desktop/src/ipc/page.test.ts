import { describe, expect, it } from 'vitest'
import { decodePage } from './page'

/** Builds a page byte by byte, following the documented layout. */
function page(offset: number, columns: number, rows: (string | null)[][]): ArrayBuffer {
  const encoder = new TextEncoder()
  const parts: number[] = [0x51, 0x53, 0x50, 0x31]
  const u32 = (n: number) => {
    const b = new ArrayBuffer(4)
    new DataView(b).setUint32(0, n, true)
    parts.push(...new Uint8Array(b))
  }
  u32(rows.length)
  u32(columns)
  const first = new ArrayBuffer(8)
  new DataView(first).setBigUint64(0, BigInt(offset), true)
  parts.push(...new Uint8Array(first))
  for (const row of rows) {
    for (const cell of row) {
      if (cell === null) {
        u32(0xffffffff)
      } else {
        const bytes = encoder.encode(cell)
        u32(bytes.length)
        parts.push(...bytes)
      }
    }
  }
  return new Uint8Array(parts).buffer
}

describe('decodePage', () => {
  it('decodes the bytes the Rust store test pins down', () => {
    // The same page as `a_page_has_the_documented_layout` in store.rs.
    const bytes = new Uint8Array([
      0x51, 0x53, 0x50, 0x31, 1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0x61, 0x62, 0xff,
      0xff, 0xff, 0xff,
    ])
    expect(decodePage(bytes.buffer)).toEqual({ offset: 0, columnCount: 2, rows: [['ab', null]] })
  })

  it('round-trips nulls, empty strings and unicode', () => {
    const rows = [
      ['', null, '🚀 é'],
      [null, 'x', null],
    ]
    expect(decodePage(page(1_000_000, 3, rows))).toEqual({ offset: 1_000_000, columnCount: 3, rows })
  })

  it('decodes an empty page', () => {
    expect(decodePage(page(5, 4, []))).toEqual({ offset: 5, columnCount: 4, rows: [] })
  })

  it('rejects truncated or foreign data', () => {
    const good = new Uint8Array(page(0, 1, [['hello']]))
    expect(() => decodePage(good.slice(0, good.length - 1).buffer)).toThrow('ends inside a cell')
    expect(() => decodePage(new Uint8Array(30).buffer)).toThrow('not a Quicksilver page')
    expect(() => decodePage(new Uint8Array(3).buffer)).toThrow('shorter than its header')
  })
})
