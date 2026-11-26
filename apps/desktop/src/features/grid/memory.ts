// How each result's grid was left (column sizes, scroll, cursor), so
// switching tabs or views and back finds it the same. Only the newest
// results are kept.

import type { ColumnState, Selection } from './model'

export type Remembered = {
  states: ColumnState[]
  scroll: { top: number; left: number }
  selection: Selection | null
}

export const remembered = new Map<number, Remembered>()
const KEEP = 64

export function remember(resultId: number, state: Remembered) {
  remembered.delete(resultId)
  remembered.set(resultId, state)
  if (remembered.size > KEEP) {
    const oldest = remembered.keys().next().value
    if (oldest !== undefined) remembered.delete(oldest)
  }
}

/** Forgets every grid (tests, and a reset). */
export function forgetGrids() {
  remembered.clear()
}
