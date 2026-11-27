// The SQL editor: CodeMirror 6 with the engine's SQL dialect, schema-aware
// completion, and the app's shortcuts left to the app.
//
// One view is mounted for the front tab. Each tab's editor state (text,
// selection, undo history) is kept here when it goes to the back, so
// switching tabs never loses undo.

import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  closeCompletion,
  completionKeymap,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory } from '@codemirror/commands'
import { PostgreSQL, SQLite, StandardSQL, sql } from '@codemirror/lang-sql'
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { useEffect, useRef } from 'react'
import type { Engine } from '../../ipc/types'
import { type SchemaSource, schemaCompletion } from './completion'
import { editorHooks, parked, views, wiring } from './registry'

// --- Marks: the statement that just ran, and where an error is -------------------

const flashEffect = StateEffect.define<{ from: number; to: number } | null>()
const errorEffect = StateEffect.define<number | null>()

const flashMark = Decoration.mark({ class: 'cm-ran' })
const errorMark = Decoration.mark({ class: 'cm-error-at' })

const marks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    let next = set.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(flashEffect)) {
        next = next.update({ filter: (_f, _t, d) => d !== flashMark })
        const range = effect.value
        if (range && range.to > range.from && range.to <= tr.state.doc.length) {
          next = next.update({ add: [flashMark.range(range.from, range.to)] })
        }
      }
      if (effect.is(errorEffect)) {
        next = next.update({ filter: (_f, _t, d) => d !== errorMark })
        const at = effect.value
        if (at !== null && at < tr.state.doc.length) {
          // Mark the word the error points at.
          const line = tr.state.doc.lineAt(at)
          const rest = line.text.slice(at - line.from)
          const length = Math.max(1, /^[\w$."]+/.exec(rest)?.[0].length ?? 1)
          next = next.update({ add: [errorMark.range(at, Math.min(at + length, line.to || at + 1))] })
        }
      }
    }
    // Typing clears an error mark: it is about text that has changed.
    if (tr.docChanged) next = next.update({ filter: (_f, _t, d) => d !== errorMark })
    return next
  },
  provide: (f) => EditorView.decorations.from(f),
})

/** Briefly highlights `from .. to` in tab `id`'s editor. */
export function flashRange(id: string, from: number, to: number) {
  const view = views.get(id)
  if (!view) return
  view.dispatch({ effects: flashEffect.of({ from, to }) })
  setTimeout(() => {
    if (views.get(id) === view) view.dispatch({ effects: flashEffect.of(null) })
  }, 600)
}

editorHooks.flash = flashRange
editorHooks.closeCompletion = (id) => {
  const view = views.get(id)
  if (view) closeCompletion(view)
}

// --- Looks ---------------------------------------------------------------------

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--color-syntax-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--color-syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--color-syntax-number)' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: 'var(--color-muted)',
    fontStyle: 'italic',
  },
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--color-syntax-type)' },
  { tag: [tags.special(tags.name), tags.quote], color: 'var(--color-fg)' },
])

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--color-bg)', color: 'var(--color-fg)', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--color-fg)', padding: '8px 0' },
  '.cm-gutters': { backgroundColor: 'var(--color-bg)', color: 'var(--color-muted)', border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': {
    backgroundColor: 'color-mix(in srgb, var(--color-raised) 55%, transparent)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--color-accent) 28%, transparent) !important',
  },
  '.cm-cursor': { borderLeftColor: 'var(--color-fg)' },
  '.cm-ran': { backgroundColor: 'color-mix(in srgb, var(--color-accent) 18%, transparent)' },
  '.cm-error-at': { textDecoration: 'underline wavy var(--color-danger)', textUnderlineOffset: '3px' },
  '.cm-tooltip': {
    backgroundColor: 'var(--color-popover)',
    border: '1px solid var(--color-border)',
    borderRadius: '6px',
    overflow: 'hidden',
    boxShadow: '0 8px 24px rgb(0 0 0 / 0.18)',
  },
  '.cm-tooltip-autocomplete > ul': { padding: '3px', fontFamily: 'var(--font-mono)' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px !important', borderRadius: '4px' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '600', color: 'var(--color-accent)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'color-mix(in srgb, var(--color-accent) 22%, transparent)',
    color: 'var(--color-fg)',
  },
  '.cm-completionDetail': { color: 'var(--color-muted)', fontStyle: 'normal', marginLeft: '1em' },
  '.cm-panels': { backgroundColor: 'var(--color-panel)', color: 'var(--color-fg)' },
  '.cm-placeholder': { color: 'var(--color-muted)' },
})

function dialectFor(engine: Engine | null) {
  if (engine === 'postgres') return PostgreSQL
  if (engine === 'sqlite') return SQLite
  return StandardSQL
}

type Props = {
  tabId: string
  doc: string
  cursor: number
  engine: Engine | null
  placeholderText: string
  schema: () => SchemaSource | null
  /** Where the last run's error points, as an offset in the text. */
  errorAt: number | null
  onChange: (doc: string, cursor: number) => void
  onCursor: (cursor: number) => void
}

export function SqlEditor({
  tabId,
  doc,
  cursor,
  engine,
  placeholderText,
  schema,
  errorAt,
  onChange,
  onCursor,
}: Props) {
  const host = useRef<HTMLDivElement>(null)
  let wired = wiring.get(tabId)
  if (!wired) {
    wired = { language: new Compartment(), hint: new Compartment(), props: { onChange, onCursor, schema } }
    wiring.set(tabId, wired)
  }
  wired.props = { onChange, onCursor, schema }
  const { language, hint } = wired

  // biome-ignore lint/correctness/useExhaustiveDependencies: the view is made once per tab
  useEffect(() => {
    const element = host.current
    if (!element) return
    const props = () => wiring.get(tabId)?.props
    const kept = parked.get(tabId)
    const state =
      kept && kept.doc.toString() === doc
        ? kept
        : EditorState.create({
            doc,
            selection: { anchor: Math.min(cursor, doc.length) },
            extensions: [
              lineNumbers(),
              highlightActiveLineGutter(),
              highlightActiveLine(),
              history(),
              drawSelection(),
              indentOnInput(),
              bracketMatching(),
              closeBrackets(),
              highlightSelectionMatches(),
              language.of(sql({ dialect: dialectFor(engine), upperCaseKeywords: true })),
              hint.of(placeholder(placeholderText)),
              syntaxHighlighting(highlight),
              autocompletion({ override: [schemaCompletion(() => props()?.schema() ?? null)], icons: false }),
              keymap.of([
                ...closeBracketsKeymap,
                ...defaultKeymap,
                ...searchKeymap,
                ...historyKeymap,
                ...completionKeymap,
                indentWithTab,
              ]),
              marks,
              theme,
              EditorView.contentAttributes.of({
                'aria-label': 'SQL editor',
                spellcheck: 'false',
                autocorrect: 'off',
                autocapitalize: 'off',
              }),
              EditorView.updateListener.of((update) => {
                const head = update.state.selection.main.head
                if (update.docChanged) props()?.onChange(update.state.doc.toString(), head)
                else if (update.selectionSet) props()?.onCursor(head)
              }),
            ],
          })
    const view = new EditorView({ state, parent: element })
    views.set(tabId, view)
    view.focus()
    return () => {
      parked.set(tabId, view.state)
      views.delete(tabId)
      view.destroy()
    }
  }, [tabId])

  // The engine can change when the tab is pointed at another connection.
  useEffect(() => {
    views.get(tabId)?.dispatch({
      effects: language.reconfigure(sql({ dialect: dialectFor(engine), upperCaseKeywords: true })),
    })
  }, [engine, tabId, language])

  useEffect(() => {
    views.get(tabId)?.dispatch({ effects: hint.reconfigure(placeholder(placeholderText)) })
  }, [placeholderText, tabId, hint])

  // Text set from outside (the filter bar, Go to object) replaces the editor's.
  useEffect(() => {
    const view = views.get(tabId)
    if (view && view.state.doc.toString() !== doc) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc },
        selection: { anchor: Math.min(cursor, doc.length) },
      })
    }
  }, [doc, cursor, tabId])

  useEffect(() => {
    const view = views.get(tabId)
    if (!view) return
    const effects = [errorEffect.of(errorAt)]
    // Bring the mark into view in a long script.
    if (errorAt !== null && errorAt <= view.state.doc.length) {
      effects.push(EditorView.scrollIntoView(errorAt, { y: 'center' }) as never)
    }
    view.dispatch({ effects })
  }, [errorAt, tabId])

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />
}

/**
 * Formats the selection (or everything) in tab `id`'s editor as one undoable
 * change. Formatting only ever happens on this command.
 */
export async function formatIn(id: string, engine: Engine | null): Promise<void> {
  const view = views.get(id)
  if (!view) return
  const { format } = await import('sql-formatter')
  const range = view.state.selection.main
  const from = range.empty ? 0 : range.from
  const to = range.empty ? view.state.doc.length : range.to
  const text = view.state.sliceDoc(from, to)
  const formatted = format(text, {
    language: engine === 'sqlite' ? 'sqlite' : engine === 'postgres' ? 'postgresql' : 'sql',
    keywordCase: 'preserve',
    tabWidth: 2,
  })
  const insert = range.empty && text.endsWith('\n') ? `${formatted}\n` : formatted
  if (insert !== text) {
    view.dispatch({
      changes: { from, to, insert },
      scrollIntoView: true,
      annotations: isolateHistory.of('full'),
    })
  }
}
