// The results grid. Cells are painted on a canvas, so a million rows cost
// what the screen shows and no more: native scrollbars move over a spacer
// the size of the whole result, and each frame draws the visible window
// from pages fetched from Rust.

import * as Menu from '@radix-ui/react-context-menu'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MenuContent, MenuItem, MenuSeparator } from '../../app/menu'
import * as ipc from '../../ipc/commands'
import type { Column, CopyFormat } from '../../ipc/types'
import { bindingFor, currentPlatform, keysFor } from '../../keymap/keymap'
import { copyText } from '../../lib/clipboard'
import {
  type Draft,
  errorText,
  openDialog,
  type ResultView,
  refocusGrid,
  say,
  select,
  setCell,
  sortResult,
  toggleDeleteRows,
  togglePanel,
  useApp,
} from '../../state/app'
import { remember, remembered } from './memory'
import {
  borderAt,
  type Cell,
  type ColumnState,
  columnAt,
  columnX,
  contains,
  display,
  HEADER_HEIGHT,
  initialWidth,
  layout,
  MAX_AUTO_WIDTH,
  MIN_WIDTH,
  move,
  ROW_HEIGHT,
  rect,
  rowAt,
  type Selection,
  scrollToColumn,
  scrollToRow,
  selectAll,
  visibleRows,
} from './model'
import { PAGE_ROWS, PageCache } from './pages'

const platform = currentPlatform()
const FONT = '12px ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace'
const HEADER_FONT = '600 12px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
/** Browsers cap element height; past it the spacer is scaled. */
const MAX_SCROLL_HEIGHT = 15_000_000

const NUMERIC = new Set(['integer', 'float', 'decimal'])

type Colors = Record<'bg' | 'panel' | 'raised' | 'border' | 'fg' | 'muted' | 'accent', string>

function readColors(): Colors {
  const style = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => style.getPropertyValue(`--color-${name}`).trim() || fallback
  return {
    bg: v('bg', '#fff'),
    panel: v('panel', '#f6f7f9'),
    raised: v('raised', '#eceef2'),
    border: v('border', '#d9dce3'),
    fg: v('fg', '#1b1f27'),
    muted: v('muted', '#646b7a'),
    accent: v('accent', '#3b6cf6'),
  }
}

let measureContext: CanvasRenderingContext2D | null | undefined
function measure(text: string, font = FONT): number {
  if (measureContext === undefined) measureContext = document.createElement('canvas').getContext('2d')
  if (!measureContext) return text.length * 7.2
  measureContext.font = font
  return measureContext.measureText(text).width
}

/**
 * The width a header needs: padding, the name, a gap, the type, and room for
 * the sort arrow.
 */
function headerWidth(column: Column | undefined): number {
  if (!column) return MIN_WIDTH
  return 8 + measure(column.name, HEADER_FONT) + 6 + measure(column.dbType) + 8 + 14
}

/**
 * A cell being edited. What it names (source row, result column, the value
 * it had) is taken when editing starts, so keeping it still works after its
 * page has scrolled out of the cache.
 */
type Editing = {
  row: number
  col: number
  source: number
  column: number
  original: string | null
  value: string
}

type Props = {
  tabId: string
  result: ResultView
  /** How the table is written in an INSERT, when the result is one table's rows. */
  insertTable: string
}

type MenuTarget = { kind: 'cells' } | { kind: 'header'; col: number } | null

/** The value a cell shows: the draft's when it has one. */
function shown(draft: Draft | null, source: number | undefined, column: number, stored: string | null) {
  if (draft === null || source === undefined) return { value: stored, edited: false }
  const cells = draft.updates[source]
  if (cells && column in cells) return { value: cells[column] ?? null, edited: true }
  return { value: stored, edited: false }
}

export function Grid({ tabId, result, insertTable }: Props) {
  const draft = useApp((s) => {
    const d = s.tabs.find((t) => t.id === tabId)?.draft ?? null
    return d?.resultId === result.resultId ? d : null
  })
  const deleted = useMemo(() => new Set(draft?.deletes ?? []), [draft])
  const [editing, setEditingState] = useState<Editing | null>(null)
  // Finishing an edit moves focus, which blurs the input; a blur after the
  // edit was kept or cancelled must not keep it again.
  const editOpen = useRef(false)
  const setEditing = (next: Editing | null) => {
    editOpen.current = next !== null
    setEditingState(next)
  }
  const scroller = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [scroll, setScroll] = useState({ top: 0, left: 0 })
  const [states, setStates] = useState<ColumnState[]>(
    () =>
      remembered.get(result.resultId)?.states ??
      result.columns.map((c) => ({
        width: Math.max(MIN_WIDTH, Math.min(MAX_AUTO_WIDTH, headerWidth(c))),
        hidden: false,
        pinned: false,
      })),
  )
  const sized = useRef(remembered.has(result.resultId))
  const [selection, setSelection] = useState<Selection | null>(
    () => remembered.get(result.resultId)?.selection ?? null,
  )
  const [menu, setMenu] = useState<MenuTarget>(null)
  const [, redraw] = useState(0)
  const overrides = useApp((s) => s.overrides)

  const cache = useMemo(
    () =>
      new PageCache(
        (offset, count) => ipc.fetchPage(result.resultId, offset, count),
        () => redraw((n) => n + 1),
        (err) => say(`Could not read rows: ${errorText(err)}`, true),
      ),
    [result.resultId],
  )
  // A sort reorders the rows: drop what was fetched.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the trigger
  useEffect(() => {
    cache.clear()
    redraw((n) => n + 1)
  }, [cache, result.version])

  const rowCount = result.rows
  const l = useMemo(() => layout(states, rowCount), [states, rowCount])
  const colCount = l.order.length
  // The spacer's height, scaled down past what browsers allow.
  const fullHeight = HEADER_HEIGHT + rowCount * ROW_HEIGHT
  const scale = fullHeight > MAX_SCROLL_HEIGHT ? fullHeight / MAX_SCROLL_HEIGHT : 1
  const scrollTop = scroll.top * scale

  // Size the canvas to the scroller's visible area.
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const update = () => setSize({ width: element.clientWidth, height: element.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const [first, end] = visibleRows(scrollTop, size.height, rowCount)
  useEffect(() => {
    void cache.ensure(Math.max(0, first - PAGE_ROWS / 2), end + PAGE_ROWS / 2, rowCount)
  }, [cache, first, end, rowCount])

  // Once rows arrive, fit each column to its name and first rows.
  // Runs after every render until it has sized once.
  useEffect(() => {
    if (sized.current || rowCount === 0) return
    const sample: (string | null)[][] = []
    for (let r = 0; r < Math.min(rowCount, 64); r++) {
      const row = cache.row(r)
      if (!row) return
      sample.push(row)
    }
    sized.current = true
    setStates((prev) =>
      prev.map((s, i) => ({
        ...s,
        width: initialWidth(
          headerWidth(result.columns[i]),
          sample.map((row) => row[i] ?? null),
          (t) => measure(t),
        ),
      })),
    )
  })

  // --- Drawing ---------------------------------------------------------------

  // The colours come from the theme, so repaint when the OS switches it.
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!query) return
    const repaint = () => redraw((n) => n + 1)
    query.addEventListener('change', repaint)
    return () => query.removeEventListener('change', repaint)
  }, [])

  useEffect(() => {
    const element = canvas.current
    const ctx = element?.getContext('2d')
    if (!element || !ctx || size.width === 0 || size.height === 0) return
    const dpr = window.devicePixelRatio || 1
    if (element.width !== Math.round(size.width * dpr)) element.width = Math.round(size.width * dpr)
    if (element.height !== Math.round(size.height * dpr)) element.height = Math.round(size.height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const colors = readColors()
    const { width, height } = size
    ctx.fillStyle = colors.bg
    ctx.fillRect(0, 0, width, height)
    ctx.textBaseline = 'middle'

    const sel = selection ? rect(selection) : null
    const y0 = HEADER_HEIGHT - (scrollTop % ROW_HEIGHT)
    const firstRow = Math.floor(scrollTop / ROW_HEIGHT)
    const rowsShown = Math.ceil((height - HEADER_HEIGHT) / ROW_HEIGHT) + 1
    // Where the last row ends, so lines stop there rather than run on below.
    const rowsBottom = Math.min(height, HEADER_HEIGHT + rowCount * ROW_HEIGHT - scrollTop)

    const drawColumn = (c: number) => {
      const x = columnX(l, c, scroll.left)
      const w = l.width[c] as number
      const source = l.order[c] as number
      const column = result.columns[source] as Column
      const numeric = NUMERIC.has(column.typeTag)
      ctx.save()
      ctx.beginPath()
      ctx.rect(x, HEADER_HEIGHT, w, height - HEADER_HEIGHT)
      ctx.clip()
      for (let k = 0; k < rowsShown; k++) {
        const r = firstRow + k
        if (r >= rowCount) break
        const y = y0 + k * ROW_HEIGHT
        if (contains(selection, r, c)) {
          ctx.globalAlpha = 0.16
          ctx.fillStyle = colors.accent
          ctx.fillRect(x, y, w, ROW_HEIGHT)
          ctx.globalAlpha = 1
        }
        const row = cache.row(r)
        if (!row) continue
        const { value: cell, edited } = shown(draft, cache.source(r), source, row[source] ?? null)
        if (edited) {
          ctx.globalAlpha = 0.28
          ctx.fillStyle = '#e2a336'
          ctx.fillRect(x, y, w, ROW_HEIGHT)
          ctx.globalAlpha = 1
        }
        if (cell === null) {
          ctx.font = `italic ${FONT}`
          ctx.fillStyle = colors.muted
          ctx.textAlign = 'left'
          ctx.fillText('NULL', x + 8, y + ROW_HEIGHT / 2)
        } else {
          ctx.font = FONT
          ctx.fillStyle = colors.fg
          const text = display(cell)
          if (numeric) {
            ctx.textAlign = 'right'
            ctx.fillText(text, x + w - 8, y + ROW_HEIGHT / 2)
          } else {
            ctx.textAlign = 'left'
            ctx.fillText(text, x + 8, y + ROW_HEIGHT / 2)
          }
        }
      }
      // Grid lines.
      ctx.fillStyle = colors.border
      ctx.fillRect(x + w - 1, HEADER_HEIGHT, 1, Math.max(0, rowsBottom - HEADER_HEIGHT))
      ctx.restore()
    }

    // Scrolled columns first, clipped to the right of the pinned ones.
    ctx.save()
    ctx.beginPath()
    ctx.rect(l.gutter + l.pinnedWidth, 0, width, height)
    ctx.clip()
    for (let c = l.pinnedCount; c < colCount; c++) {
      const x = columnX(l, c, scroll.left)
      if (x > width || x + (l.width[c] as number) < l.gutter + l.pinnedWidth) continue
      drawColumn(c)
    }
    ctx.restore()
    for (let c = 0; c < l.pinnedCount; c++) drawColumn(c)
    if (l.pinnedCount > 0) {
      ctx.fillStyle = colors.muted
      ctx.fillRect(l.gutter + l.pinnedWidth - 1, 0, 1, height)
    }

    // Rows marked for deletion: tinted and struck through.
    for (let k = 0; k < rowsShown; k++) {
      const r = firstRow + k
      if (r >= rowCount) break
      const source = cache.source(r)
      if (source === undefined || !deleted.has(source)) continue
      const y = y0 + k * ROW_HEIGHT
      ctx.globalAlpha = 0.14
      ctx.fillStyle = '#e5484d'
      ctx.fillRect(l.gutter, y, width, ROW_HEIGHT)
      ctx.globalAlpha = 0.8
      ctx.fillRect(
        l.gutter,
        y + ROW_HEIGHT / 2,
        Math.min(width, l.gutter + l.totalWidth - scroll.left) - l.gutter,
        1,
      )
      ctx.globalAlpha = 1
    }

    // Row lines across the data.
    ctx.fillStyle = colors.border
    for (let k = 0; k < rowsShown; k++) {
      const y = y0 + (k + 1) * ROW_HEIGHT - 1
      if (firstRow + k >= rowCount) break
      ctx.globalAlpha = 0.5
      ctx.fillRect(l.gutter, y, width, 1)
      ctx.globalAlpha = 1
    }

    // The gutter: row numbers.
    ctx.fillStyle = colors.panel
    ctx.fillRect(0, HEADER_HEIGHT, l.gutter, height - HEADER_HEIGHT)
    ctx.font = FONT
    ctx.textAlign = 'right'
    for (let k = 0; k < rowsShown; k++) {
      const r = firstRow + k
      if (r >= rowCount) break
      const inRows = sel && r >= sel.top && r <= sel.bottom
      ctx.fillStyle = inRows ? colors.fg : colors.muted
      ctx.fillText(String(r + 1), l.gutter - 8, y0 + k * ROW_HEIGHT + ROW_HEIGHT / 2)
    }
    ctx.fillStyle = colors.border
    ctx.fillRect(l.gutter - 1, 0, 1, height)

    // The header.
    ctx.fillStyle = colors.panel
    ctx.fillRect(0, 0, width, HEADER_HEIGHT)
    const drawHeader = (c: number) => {
      const x = columnX(l, c, scroll.left)
      const w = l.width[c] as number
      const source = l.order[c] as number
      const column = result.columns[source] as Column
      ctx.save()
      ctx.beginPath()
      ctx.rect(x, 0, w - 1, HEADER_HEIGHT)
      ctx.clip()
      const sorted =
        result.sort?.column === source ? (result.sort.direction === 'ascending' ? ' ▲' : ' ▼') : ''
      ctx.font = HEADER_FONT
      ctx.fillStyle = colors.fg
      ctx.textAlign = 'left'
      ctx.fillText(column.name + sorted, x + 8, HEADER_HEIGHT / 2)
      const nameWidth = measure(column.name + sorted, HEADER_FONT)
      ctx.font = FONT
      ctx.fillStyle = colors.muted
      ctx.fillText(column.dbType, x + 14 + nameWidth, HEADER_HEIGHT / 2)
      ctx.restore()
      ctx.fillStyle = colors.border
      ctx.fillRect(x + w - 1, 0, 1, HEADER_HEIGHT)
    }
    ctx.save()
    ctx.beginPath()
    ctx.rect(l.gutter + l.pinnedWidth, 0, width, HEADER_HEIGHT)
    ctx.clip()
    for (let c = l.pinnedCount; c < colCount; c++) drawHeader(c)
    ctx.restore()
    for (let c = 0; c < l.pinnedCount; c++) drawHeader(c)
    ctx.fillStyle = colors.border
    ctx.fillRect(0, HEADER_HEIGHT - 1, width, 1)

    // The cursor cell.
    if (selection) {
      const { row, col } = selection.focus
      const x = columnX(l, col, scroll.left)
      const y = HEADER_HEIGHT + row * ROW_HEIGHT - scrollTop
      if (y + ROW_HEIGHT > HEADER_HEIGHT && y < height) {
        ctx.strokeStyle = colors.accent
        ctx.lineWidth = 2
        ctx.strokeRect(x + 1, y + 1, (l.width[col] as number) - 2, ROW_HEIGHT - 2)
      }
    }
  })

  // --- Selection and keyboard -------------------------------------------------

  const focusCell = useCallback(
    (next: Selection | null) => {
      setSelection(next)
      const element = scroller.current
      if (!next || !element) return
      const top = scrollToRow(next.focus.row, scrollTop, element.clientHeight)
      const left = scrollToColumn(l, next.focus.col, element.scrollLeft, element.clientWidth)
      if (top !== scrollTop) element.scrollTop = top / scale
      if (left !== element.scrollLeft) element.scrollLeft = left
      void cache.ensure(next.focus.row, next.focus.row + 1, rowCount)
    },
    [cache, l, rowCount, scale, scrollTop],
  )

  // The grid is keyed by result, so a new result starts fresh; coming back
  // to one restores where it was left, and a re-run started from the grid
  // hands focus to the new one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on mount
  useEffect(() => {
    const element = scroller.current
    const was = remembered.get(result.resultId)
    if (element && was) {
      element.scrollTop = was.scroll.top
      element.scrollLeft = was.scroll.left
    }
    if (element && refocusGrid.delete(tabId)) element.focus()
  }, [])
  useEffect(() => {
    remember(result.resultId, { states, scroll, selection })
  }, [result.resultId, states, scroll, selection])

  const sourceColumns = (sel: Selection | null): number[] => {
    if (!sel) return []
    const r = rect(sel)
    return l.order.slice(r.left, r.right + 1)
  }

  const copy = (format: CopyFormat, sel = selection) => {
    if (!sel) return
    const r = rect(sel)
    const text = ipc.copyRows(result.resultId, r.top, r.bottom - r.top + 1, sourceColumns(sel), format)
    copyText(text)
      .then(() => {
        const rows = r.bottom - r.top + 1
        say(`Copied ${rows.toLocaleString()} row${rows === 1 ? '' : 's'}`)
      })
      .catch((err) => say(`Could not copy: ${errorText(err)}`, true))
  }

  /** Shows the cursor's row, opening the inspector if it is hidden. */
  const showInInspector = () => {
    if (!useApp.getState().panels.inspector) togglePanel('inspector')
    inspect()
  }
  const inspect = (sel = selection) => {
    if (!sel) return
    const stored = cache.row(sel.focus.row)
    if (!stored) return
    // Pending edits show as they will be saved.
    const source = cache.source(sel.focus.row)
    const row = stored.map((value, column) => shown(draft, source, column, value).value)
    select({ kind: 'row', columns: result.columns, row, position: sel.focus.row })
  }

  const pageRows = Math.max(1, Math.floor((size.height - HEADER_HEIGHT) / ROW_HEIGHT) - 1)

  // --- Editing -------------------------------------------------------------------

  /** Says why the rows cannot be edited, if they cannot. */
  const editable = (): boolean => {
    if (!result.edit) {
      say(
        result.done
          ? 'Checking whether these rows can be edited…'
          : 'Rows can be edited once the statement has finished.',
      )
      return false
    }
    if (result.edit.reason) {
      say(`These rows cannot be edited: ${result.edit.reason}.`, true)
      return false
    }
    return true
  }

  /** Opens the cell editor on `cell`, holding its value, or `typed` in place of it. */
  const startEditing = (cell = selection?.focus, typed?: string) => {
    if (!cell || !editable()) return
    const source = cache.source(cell.row)
    const row = cache.row(cell.row)
    if (source === undefined || !row) return
    if (deleted.has(source)) {
      say('That row is marked for deletion.')
      return
    }
    const column = l.order[cell.col]
    if (column === undefined) return
    const original = row[column] ?? null
    const { value } = shown(draft, source, column, original)
    setSelection({ anchor: cell, focus: cell })
    setEditing({ row: cell.row, col: cell.col, source, column, original, value: typed ?? value ?? '' })
  }

  const commitEdit = (value: string | null, then?: { rows: number; cols: number }) => {
    const current = editing
    if (!editOpen.current) return
    setEditing(null)
    scroller.current?.focus()
    if (!current) return
    setCell(tabId, result.resultId, current.source, current.column, value, current.original)
    if (then) {
      focusCell(move({ anchor: current, focus: current }, then.rows, then.cols, false, rowCount, colCount))
    }
  }

  /** Every selected cell's (source row, column), loaded or not. */
  const selectedCells = (): { source: number; column: number; original: string | null }[] => {
    if (!selection) return []
    const r = rect(selection)
    const out = []
    for (let row = r.top; row <= r.bottom; row++) {
      const source = cache.source(row)
      const values = cache.row(row)
      if (source === undefined || !values) continue
      for (let col = r.left; col <= r.right; col++) {
        const column = l.order[col]
        if (column === undefined) continue
        out.push({ source, column, original: values[column] ?? null })
      }
    }
    return out
  }

  const setNull = () => {
    if (!editable()) return
    for (const c of selectedCells()) setCell(tabId, result.resultId, c.source, c.column, null, c.original)
  }

  const deleteRows = () => {
    if (!editable() || !selection) return
    const r = rect(selection)
    const rows: number[] = []
    for (let row = r.top; row <= r.bottom; row++) {
      const source = cache.source(row)
      if (source !== undefined) rows.push(source)
    }
    if (rows.length > 0) toggleDeleteRows(tabId, result.resultId, rows)
  }

  const addRow = () => {
    if (editable()) openDialog({ kind: 'insertRow', tabId })
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (editing) return
    const found = bindingFor(event.nativeEvent, overrides, platform, 'grid')
    if (found) {
      event.preventDefault()
      if (found.id === 'copy-cells') copy({ kind: 'tsv', header: false })
      if (found.id === 'copy-cells-with-header') copy({ kind: 'tsv', header: true })
      if (found.id === 'select-all-cells') setSelection(selectAll(rowCount, colCount))
      if (found.id === 'inspect-row') showInInspector()
      if (found.id === 'edit-cell') startEditing()
      if (found.id === 'set-null') setNull()
      if (found.id === 'delete-rows') deleteRows()
      return
    }
    if (event.key === 'F2') {
      event.preventDefault()
      startEditing()
      return
    }
    // Typing on a cell replaces its value, as in a spreadsheet.
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && selection) {
      event.preventDefault()
      startEditing(undefined, event.key)
      return
    }
    const mod = platform === 'mac' ? event.metaKey : event.ctrlKey
    const extend = event.shiftKey
    const go = (rows: number, cols: number) => {
      event.preventDefault()
      focusCell(move(selection, rows, cols, extend, rowCount, colCount))
    }
    switch (event.key) {
      case 'ArrowDown':
        return go(mod ? rowCount : 1, 0)
      case 'ArrowUp':
        return go(mod ? -rowCount : -1, 0)
      case 'ArrowRight':
        return go(0, mod ? colCount : 1)
      case 'ArrowLeft':
        return go(0, mod ? -colCount : -1)
      case 'PageDown':
        return go(pageRows, 0)
      case 'PageUp':
        return go(-pageRows, 0)
      case 'Home':
        return go(mod ? -rowCount : 0, -colCount)
      case 'End':
        return go(mod ? rowCount : 0, colCount)
    }
  }

  // The inspector follows the cursor row, so moving through rows shows each in full.
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the cursor row
  useEffect(() => {
    if (selection) inspect()
  }, [selection?.focus.row, cache.row(selection?.focus.row ?? -1), draft])

  // --- Mouse -------------------------------------------------------------------

  const resizing = useRef<{ col: number; startX: number; startWidth: number } | null>(null)
  const dragging = useRef(false)

  const point = (event: React.MouseEvent | MouseEvent) => {
    const box = scroller.current?.getBoundingClientRect()
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) }
  }

  const cellAt = (x: number, y: number): Cell | null => {
    const row = rowAt(y, scrollTop, rowCount)
    const col = columnAt(l, x, scroll.left)
    return row === null || col === null ? null : { row, col }
  }

  const setWidth = (col: number, width: number) => {
    const source = l.order[col] as number
    setStates((prev) => prev.map((s, i) => (i === source ? { ...s, width: Math.max(MIN_WIDTH, width) } : s)))
  }

  const fitColumn = (col: number) => {
    const source = l.order[col] as number
    const samples: (string | null)[] = []
    for (let r = first; r < end; r++) samples.push(cache.row(r)?.[source] ?? null)
    setWidth(
      col,
      initialWidth(headerWidth(result.columns[source]), samples, (t) => measure(t)),
    )
  }

  const onMouseDown = (event: React.MouseEvent) => {
    if (event.button !== 0) return
    const { x, y } = point(event)
    // Clicks on the scrollbars are not on the grid.
    if (x >= size.width || y >= size.height) return
    scroller.current?.focus()
    if (y < HEADER_HEIGHT) {
      const border = borderAt(l, x, scroll.left)
      if (border !== null) {
        if (event.detail === 2) fitColumn(border)
        else resizing.current = { col: border, startX: event.clientX, startWidth: l.width[border] as number }
        event.preventDefault()
        return
      }
      const col = columnAt(l, x, scroll.left)
      if (col === null) return
      const source = l.order[col] as number
      if (!result.done) {
        say('Rows can be sorted once the statement has finished.')
        return
      }
      // Click cycles: up, down, as the rows arrived.
      const current = result.sort?.column === source ? result.sort.direction : null
      const next = current === null ? 'ascending' : current === 'ascending' ? 'descending' : null
      void sortResult(tabId, result.resultId, next ? { column: source, direction: next } : null)
      return
    }
    if (x < l.gutter) {
      // The gutter selects whole rows.
      const row = rowAt(y, scrollTop, rowCount)
      if (row === null || colCount === 0) return
      const anchor = event.shiftKey && selection ? selection.anchor : { row, col: 0 }
      setSelection({ anchor: { row: anchor.row, col: 0 }, focus: { row, col: colCount - 1 } })
      return
    }
    const cell = cellAt(x, y)
    if (!cell) return
    if (event.detail === 2) {
      event.preventDefault()
      startEditing(cell)
      return
    }
    setSelection(
      event.shiftKey && selection ? { anchor: selection.anchor, focus: cell } : { anchor: cell, focus: cell },
    )
    dragging.current = true
  }

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const resize = resizing.current
      if (resize) {
        setWidth(resize.col, resize.startWidth + event.clientX - resize.startX)
        return
      }
      if (!dragging.current) return
      const { x, y } = point(event)
      const cell = cellAt(x, y)
      if (cell) setSelection((sel) => (sel ? { anchor: sel.anchor, focus: cell } : sel))
    }
    const onUp = () => {
      resizing.current = null
      dragging.current = false
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  })

  const [cursor, setCursor] = useState('default')
  const onHover = (event: React.MouseEvent) => {
    const { x, y } = point(event)
    const next = y < HEADER_HEIGHT && borderAt(l, x, scroll.left) !== null ? 'col-resize' : 'default'
    if (next !== cursor) setCursor(next)
  }

  const onContextMenu = (event: React.MouseEvent) => {
    const { x, y } = point(event)
    if (y < HEADER_HEIGHT) {
      const col = columnAt(l, x, scroll.left)
      setMenu(col === null ? null : { kind: 'header', col })
      return
    }
    const cell = cellAt(x, y)
    if (cell && !contains(selection, cell.row, cell.col)) setSelection({ anchor: cell, focus: cell })
    setMenu(cell ? { kind: 'cells' } : null)
  }

  /** Pins, unpins, hides or shows columns; display positions move, so the selection goes. */
  const reshape = (change: (prev: ColumnState[]) => ColumnState[]) => {
    setSelection(null)
    setEditing(null)
    setStates(change)
  }
  const setColumn = (col: number, change: Partial<ColumnState>) => {
    const source = l.order[col] as number
    reshape((prev) => prev.map((s, i) => (i === source ? { ...s, ...change } : s)))
  }

  // --- What a screen reader hears -------------------------------------------------

  let description = `${rowCount.toLocaleString()} rows, ${colCount} columns`
  if (selection) {
    const { row, col } = selection.focus
    const column = l.order[col] as number
    const stored = cache.row(row)?.[column]
    const sourceRow = cache.source(row)
    const { value, edited } =
      stored === undefined ? { value: undefined, edited: false } : shown(draft, sourceRow, column, stored)
    const name = result.columns[column]?.name ?? ''
    const marks = [
      edited && 'edited',
      sourceRow !== undefined && deleted.has(sourceRow) && 'row marked for deletion',
    ].filter(Boolean)
    description = `Row ${row + 1} of ${rowCount.toLocaleString()}, ${name}: ${
      value === undefined ? 'loading' : value === null ? 'NULL' : value
    }${marks.length > 0 ? ` (${marks.join(', ')})` : ''}`
  }

  const canEdit = Boolean(result.edit && !result.edit.reason)
  const selectedRows = selection ? rect(selection) : null
  const selectedRowCount = selectedRows ? selectedRows.bottom - selectedRows.top + 1 : 0
  // The menu offers to keep the rows when every selected row is marked for deletion.
  let selectionDeleted = selectedRows !== null && menu?.kind === 'cells'
  for (let r = selectedRows?.top ?? 0; selectionDeleted && selectedRows && r <= selectedRows.bottom; r++) {
    const source = cache.source(r)
    if (source === undefined || !deleted.has(source)) selectionDeleted = false
  }

  const hiddenCount = states.filter((s) => s.hidden).length
  const menuCol = menu?.kind === 'header' ? menu.col : null
  const menuSource = menuCol === null ? null : (l.order[menuCol] as number)
  const keys = (id: string) => keysFor(id, overrides)

  return (
    <div className="relative min-h-0 flex-1">
      <Menu.Root onOpenChange={(open) => !open && setMenu(null)}>
        <Menu.Trigger asChild>
          {/* biome-ignore lint/a11y/useSemanticElements: a canvas grid has no table to use */}
          <div
            ref={scroller}
            role="grid"
            tabIndex={0}
            aria-label="Result rows"
            aria-rowcount={rowCount}
            aria-colcount={colCount}
            onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, left: e.currentTarget.scrollLeft })}
            onMouseDown={onMouseDown}
            onMouseMove={onHover}
            onKeyDown={onKeyDown}
            onContextMenu={onContextMenu}
            className="absolute inset-0 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
            style={{ cursor }}
          >
            <div
              style={{
                width: l.gutter + l.totalWidth,
                height: fullHeight / scale,
              }}
            />
          </div>
        </Menu.Trigger>
        {menu?.kind === 'cells' && (
          <MenuContent>
            <MenuItem onSelect={() => copy({ kind: 'tsv', header: false })} keys={keys('copy-cells')}>
              Copy
            </MenuItem>
            <MenuItem
              onSelect={() => copy({ kind: 'tsv', header: true })}
              keys={keys('copy-cells-with-header')}
            >
              Copy with column names
            </MenuItem>
            <MenuItem onSelect={() => copy({ kind: 'csv', header: true })}>Copy as CSV</MenuItem>
            <MenuItem onSelect={() => copy({ kind: 'json' })}>Copy as JSON</MenuItem>
            <MenuItem onSelect={() => copy({ kind: 'insert', table: insertTable })}>
              Copy as INSERT statements
            </MenuItem>
            <MenuSeparator />
            <MenuItem disabled={!canEdit} onSelect={() => startEditing()} keys={keys('edit-cell')}>
              Edit cell
            </MenuItem>
            <MenuItem disabled={!canEdit} onSelect={setNull} keys={keys('set-null')}>
              Set to NULL
            </MenuItem>
            <MenuItem disabled={!canEdit} onSelect={deleteRows} keys={keys('delete-rows')}>
              {selectionDeleted ? 'Keep' : 'Delete'}{' '}
              {selectedRowCount === 1 ? 'row' : `${selectedRowCount} rows`}
            </MenuItem>
            <MenuItem disabled={!canEdit} onSelect={addRow}>
              Add a row…
            </MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={showInInspector} keys={keys('inspect-row')}>
              Show row in the inspector
            </MenuItem>
            <MenuItem
              onSelect={() => setSelection(selectAll(rowCount, colCount))}
              keys={keys('select-all-cells')}
            >
              Select all
            </MenuItem>
          </MenuContent>
        )}
        {menuCol !== null && menuSource !== null && (
          <MenuContent>
            <MenuItem
              disabled={!result.done}
              onSelect={() =>
                void sortResult(tabId, result.resultId, { column: menuSource, direction: 'ascending' })
              }
            >
              Sort ascending
            </MenuItem>
            <MenuItem
              disabled={!result.done}
              onSelect={() =>
                void sortResult(tabId, result.resultId, { column: menuSource, direction: 'descending' })
              }
            >
              Sort descending
            </MenuItem>
            {result.sort && (
              <MenuItem onSelect={() => void sortResult(tabId, result.resultId, null)}>
                Back to the order rows arrived in
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem onSelect={() => setColumn(menuCol, { pinned: !states[menuSource]?.pinned })}>
              {states[menuSource]?.pinned ? 'Unpin column' : 'Pin column to the left'}
            </MenuItem>
            <MenuItem onSelect={() => fitColumn(menuCol)}>Fit width to contents</MenuItem>
            <MenuItem disabled={colCount <= 1} onSelect={() => setColumn(menuCol, { hidden: true })}>
              Hide column
            </MenuItem>
            {hiddenCount > 0 && (
              <MenuItem onSelect={() => reshape((prev) => prev.map((s) => ({ ...s, hidden: false })))}>
                Show {hiddenCount} hidden column{hiddenCount === 1 ? '' : 's'}
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem
              onSelect={() =>
                copy(
                  { kind: 'tsv', header: false },
                  {
                    anchor: { row: 0, col: menuCol },
                    focus: { row: Math.max(0, rowCount - 1), col: menuCol },
                  },
                )
              }
            >
              Copy column values
            </MenuItem>
            <MenuItem onSelect={() => void copyText(result.columns[menuSource]?.name ?? '')}>
              Copy column name
            </MenuItem>
          </MenuContent>
        )}
      </Menu.Root>
      <canvas
        ref={canvas}
        aria-hidden
        className="pointer-events-none absolute top-0 left-0"
        style={{ width: size.width, height: size.height }}
      />
      {editing && (
        // A textarea, not an input: an input drops line breaks, which would
        // silently change a multi-line value. Enter saves; Shift+Enter or
        // Alt+Enter adds a line.
        <textarea
          // biome-ignore lint/a11y/noAutofocus: editing starts on a key or double-click
          autoFocus
          data-cell-editor
          aria-label={`New value for ${result.columns[editing.column]?.name ?? 'the cell'}`}
          value={editing.value}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          rows={1}
          onFocus={(e) => {
            const end = e.currentTarget.value.length
            e.currentTarget.setSelectionRange(end, end)
          }}
          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
              e.preventDefault()
              commitEdit(editing.value, { rows: 1, cols: 0 })
            } else if (e.key === 'Tab') {
              e.preventDefault()
              commitEdit(editing.value, { rows: 0, cols: e.shiftKey ? -1 : 1 })
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setEditing(null)
              scroller.current?.focus()
            }
          }}
          onBlur={() => editing && commitEdit(editing.value)}
          className="absolute z-10 resize-none rounded-sm border-2 border-accent bg-bg px-1.5 font-mono text-[12px] leading-[18px] outline-none"
          style={{
            left: columnX(l, editing.col, scroll.left),
            top: HEADER_HEIGHT + editing.row * ROW_HEIGHT - scrollTop,
            width: Math.max(160, l.width[editing.col] as number),
            height: Math.max(ROW_HEIGHT, Math.min(8, editing.value.split('\n').length) * 18 + 6),
          }}
        />
      )}
      <div aria-live="polite" className="sr-only" data-testid="grid-cursor">
        {description}
      </div>
    </div>
  )
}
