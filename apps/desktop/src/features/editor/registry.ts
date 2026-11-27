// Which editor belongs to which tab. Kept apart from the component so app
// state can ask for a tab's selection without importing React code.

import type { Compartment, EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { SchemaSource } from './completion'

/** The mounted view for the front tab, by tab id. */
export const views = new Map<string, EditorView>()
/** Each back tab's editor state (text, selection, undo), by tab id. */
export const parked = new Map<string, EditorState>()

export type Wiring = {
  language: Compartment
  hint: Compartment
  /** The mounted component's callbacks; a parked state's extensions read them here. */
  props: {
    onChange: (doc: string, cursor: number) => void
    onCursor: (cursor: number) => void
    schema: () => SchemaSource | null
  }
}
export const wiring = new Map<string, Wiring>()

/** The mounted editor for tab `id`, if it is the front tab. */
export function editorFor(id: string): EditorView | undefined {
  return views.get(id)
}

/** Forgets a closed tab's editor state. */
export function forgetEditor(id: string) {
  parked.delete(id)
  wiring.delete(id)
}

/** The selected range in tab `id`'s editor, or `null` when nothing is selected. */
export function selectionIn(id: string): { from: number; to: number } | null {
  const range = views.get(id)?.state.selection.main
  return range && !range.empty ? { from: range.from, to: range.to } : null
}

/** Editor effects app state can ask for; the editor module fills them in. */
export const editorHooks = {
  /** Briefly highlights a range in a tab's editor. */
  flash: (_id: string, _from: number, _to: number) => {},
}
