// The grid's geometry and selection, with no drawing in it, so it can be
// tested on its own. "Display" columns are the visible ones in the order
// shown: pinned first, then the rest; each maps back to a result column.

export const ROW_HEIGHT = 24
export const HEADER_HEIGHT = 28
export const MIN_WIDTH = 48
export const MAX_AUTO_WIDTH = 360

export type ColumnState = { width: number; hidden: boolean; pinned: boolean }

export type Layout = {
  /** Result column index for each display column. */
  order: number[]
  /** Left edge of each display column, from the left of the data area. */
  left: number[]
  width: number[]
  /** How many display columns are pinned (they come first). */
  pinnedCount: number
  pinnedWidth: number
  totalWidth: number
  /** Width of the row-number gutter. */
  gutter: number
}

/** The gutter fits the largest row number. */
export function gutterWidth(rowCount: number): number {
  return Math.max(36, String(Math.max(1, rowCount)).length * 8 + 16)
}

export function layout(states: ColumnState[], rowCount: number): Layout {
  const visible = states.map((s, i) => ({ ...s, i })).filter((s) => !s.hidden)
  const ordered = [...visible.filter((s) => s.pinned), ...visible.filter((s) => !s.pinned)]
  const left: number[] = []
  const width: number[] = []
  let x = 0
  for (const s of ordered) {
    left.push(x)
    width.push(s.width)
    x += s.width
  }
  const pinnedCount = ordered.filter((s) => s.pinned).length
  const pinnedWidth =
    pinnedCount > 0 ? (left[pinnedCount - 1] as number) + (width[pinnedCount - 1] as number) : 0
  return {
    order: ordered.map((s) => s.i),
    left,
    width,
    pinnedCount,
    pinnedWidth,
    totalWidth: x,
    gutter: gutterWidth(rowCount),
  }
}

/**
 * Where display column `col` is drawn, in viewport pixels: pinned columns
 * stay put, the others move with the horizontal scroll.
 */
export function columnX(l: Layout, col: number, scrollLeft: number): number {
  const left = l.left[col] ?? 0
  return col < l.pinnedCount ? l.gutter + left : l.gutter + left - scrollLeft
}

/** The display column at viewport x, if any. */
export function columnAt(l: Layout, x: number, scrollLeft: number): number | null {
  if (x < l.gutter) return null
  const local = x - l.gutter
  if (local < l.pinnedWidth) {
    for (let c = 0; c < l.pinnedCount; c++) {
      if (local < (l.left[c] as number) + (l.width[c] as number)) return c
    }
  }
  const data = local + scrollLeft
  for (let c = l.pinnedCount; c < l.order.length; c++) {
    const left = l.left[c] as number
    if (data >= left && data < left + (l.width[c] as number)) {
      // A scrolled column hidden under the pinned ones is not hit.
      return columnX(l, c, scrollLeft) + (l.width[c] as number) > l.gutter + l.pinnedWidth ? c : null
    }
  }
  return null
}

/** The display column whose right border is within a few pixels of x, for resizing. */
export function borderAt(l: Layout, x: number, scrollLeft: number): number | null {
  for (let c = 0; c < l.order.length; c++) {
    const right = columnX(l, c, scrollLeft) + (l.width[c] as number)
    if (Math.abs(x - right) <= 4 && (c < l.pinnedCount || right > l.gutter + l.pinnedWidth)) return c
  }
  return null
}

/** The row at viewport y (below the header), if any. */
export function rowAt(y: number, scrollTop: number, rowCount: number): number | null {
  if (y < HEADER_HEIGHT) return null
  const row = Math.floor((y - HEADER_HEIGHT + scrollTop) / ROW_HEIGHT)
  return row >= 0 && row < rowCount ? row : null
}

/** The rows a viewport of `height` shows at `scrollTop`, as `[first, end)`. */
export function visibleRows(scrollTop: number, height: number, rowCount: number): [number, number] {
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT))
  const end = Math.min(
    rowCount,
    Math.ceil((scrollTop + Math.max(0, height - HEADER_HEIGHT)) / ROW_HEIGHT) + 1,
  )
  return [first, Math.max(first, end)]
}

// --- Selection ----------------------------------------------------------------

export type Cell = { row: number; col: number }

/** A rectangle from where it started (`anchor`) to where the cursor is (`focus`). */
export type Selection = { anchor: Cell; focus: Cell }

export type Rect = { top: number; bottom: number; left: number; right: number }

export function rect(sel: Selection): Rect {
  return {
    top: Math.min(sel.anchor.row, sel.focus.row),
    bottom: Math.max(sel.anchor.row, sel.focus.row),
    left: Math.min(sel.anchor.col, sel.focus.col),
    right: Math.max(sel.anchor.col, sel.focus.col),
  }
}

export function contains(sel: Selection | null, row: number, col: number): boolean {
  if (!sel) return false
  const r = rect(sel)
  return row >= r.top && row <= r.bottom && col >= r.left && col <= r.right
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

/**
 * Moves the cursor by `rows` and `cols` (clamped to the grid); with
 * `extend`, the anchor stays and the selection grows.
 */
export function move(
  sel: Selection | null,
  rows: number,
  cols: number,
  extend: boolean,
  rowCount: number,
  colCount: number,
): Selection | null {
  if (rowCount === 0 || colCount === 0) return null
  const from = sel?.focus ?? { row: 0, col: 0 }
  const focus = {
    row: clamp(from.row + (sel ? rows : 0), 0, rowCount - 1),
    col: clamp(from.col + (sel ? cols : 0), 0, colCount - 1),
  }
  return { anchor: extend && sel ? sel.anchor : focus, focus }
}

export function selectAll(rowCount: number, colCount: number): Selection | null {
  if (rowCount === 0 || colCount === 0) return null
  return { anchor: { row: 0, col: 0 }, focus: { row: rowCount - 1, col: colCount - 1 } }
}

/** The vertical scroll that brings `row` into view, or the current one if it is already. */
export function scrollToRow(row: number, scrollTop: number, height: number): number {
  const top = row * ROW_HEIGHT
  const visible = height - HEADER_HEIGHT
  if (top < scrollTop) return top
  if (top + ROW_HEIGHT > scrollTop + visible) return top + ROW_HEIGHT - visible
  return scrollTop
}

/** The horizontal scroll that brings display column `col` into view. */
export function scrollToColumn(l: Layout, col: number, scrollLeft: number, width: number): number {
  if (col < l.pinnedCount) return scrollLeft
  const left = (l.left[col] as number) - l.pinnedWidth
  const right = (l.left[col] as number) + (l.width[col] as number)
  const visible = width - l.gutter
  if (left < scrollLeft) return Math.max(0, left)
  if (right > scrollLeft + visible) return right - visible
  return scrollLeft
}

/**
 * A starting width for a column: room for its header (`header`, the drawn
 * width of its name and type), or its widest sample.
 */
export function initialWidth(
  header: number,
  samples: (string | null)[],
  measure: (text: string) => number,
): number {
  let widest = header
  for (const s of samples) widest = Math.max(widest, measure(display(s ?? 'NULL')) + 16)
  return clamp(Math.ceil(widest), MIN_WIDTH, MAX_AUTO_WIDTH)
}

/** A cell as one line of text: line breaks shown as ↵ and long text cut. */
export function display(text: string): string {
  const cut = text.length > 400 ? `${text.slice(0, 400)}…` : text
  return cut.replace(/\r\n|\r|\n/g, '↵').replace(/\t/g, ' ')
}
