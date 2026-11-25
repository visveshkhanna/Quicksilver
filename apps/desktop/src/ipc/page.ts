/**
 * Decodes the binary pages `qs_service::store::ResultStore::page` writes:
 *
 *   "QSP2"                  4 bytes
 *   row count     u32 LE
 *   column count  u32 LE
 *   first row     u64 LE
 *   then, row by row:
 *     source row  u64 LE    the row's place in arrival order, whatever the sort
 *     cells: length u32 LE (0xFFFFFFFF for NULL), then UTF-8 bytes
 */

const MAGIC = [0x51, 0x53, 0x50, 0x32] // "QSP2"
const NULL_LENGTH = 0xffffffff
const HEADER_BYTES = 20

export type Page = {
  /** The row number of the first row in `rows`. */
  offset: number
  columnCount: number
  /** Row by row; `null` is SQL NULL. */
  rows: (string | null)[][]
  /** Each row's place in arrival order, which edits name it by. */
  sources: number[]
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
  const sources: number[] = new Array(rowCount)
  let at = HEADER_BYTES
  for (let r = 0; r < rowCount; r++) {
    if (at + 8 > buffer.byteLength) throw new Error('page ends inside a row number')
    sources[r] = Number(view.getBigUint64(at, true))
    at += 8
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
  return { offset, columnCount, rows, sources }
}
