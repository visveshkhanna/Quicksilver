/**
 * Decodes the binary pages `qs_service::store::ResultStore::page` writes:
 *
 *   "QSP1"                  4 bytes
 *   row count     u32 LE
 *   column count  u32 LE
 *   first row     u64 LE
 *   cells, row by row: length u32 LE (0xFFFFFFFF for NULL), then UTF-8 bytes
 */

const MAGIC = [0x51, 0x53, 0x50, 0x31] // "QSP1"
const NULL_LENGTH = 0xffffffff
const HEADER_BYTES = 20

export type Page = {
  /** The row number of the first row in `rows`. */
  offset: number
  columnCount: number
  /** Row by row; `null` is SQL NULL. */
  rows: (string | null)[][]
}

const decoder = new TextDecoder('utf-8')

export function decodePage(buffer: ArrayBuffer): Page {
  if (buffer.byteLength < HEADER_BYTES) throw new Error('page is shorter than its header')
  const bytes = new Uint8Array(buffer)
  if (MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('not a Quicksilver page')

  const view = new DataView(buffer)
  const rowCount = view.getUint32(4, true)
  const columnCount = view.getUint32(8, true)
  const offset = Number(view.getBigUint64(12, true))

  const rows: (string | null)[][] = new Array(rowCount)
  let at = HEADER_BYTES
  for (let r = 0; r < rowCount; r++) {
    const row: (string | null)[] = new Array(columnCount)
    for (let c = 0; c < columnCount; c++) {
      if (at + 4 > buffer.byteLength) throw new Error('page ends inside a cell length')
      const length = view.getUint32(at, true)
      at += 4
      if (length === NULL_LENGTH) {
        row[c] = null
      } else {
        if (at + length > buffer.byteLength) throw new Error('page ends inside a cell')
        row[c] = decoder.decode(bytes.subarray(at, at + length))
        at += length
      }
    }
    rows[r] = row
  }
  if (at !== buffer.byteLength) throw new Error('page has trailing bytes')
  return { offset, columnCount, rows }
}
