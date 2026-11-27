// The dialogs that stand between the user and anything that changes data:
// reviewing the statements an edit runs, confirming a script that changes
// the schema, and adding a row.

import { useState } from 'react'
import { Button, Modal } from '../../app/ui'
import { addInsert, applyDraft, closeDialog, dropEdit, useApp } from '../../state/app'

function StatementList({ statements, onDrop }: { statements: string[]; onDrop?: (index: number) => void }) {
  return (
    <ol className="m-0 max-h-[50vh] list-none overflow-auto p-0 font-mono text-[12px]">
      {statements.map((sql, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: statements are positional
        <li key={i} className="flex gap-2 border-b border-border/60 px-1 py-1.5 last:border-0">
          <span className="w-6 shrink-0 text-right text-muted">{i + 1}</span>
          <code className="min-w-0 flex-1 break-all whitespace-pre-wrap select-text">{sql};</code>
          {onDrop && (
            <button
              type="button"
              onClick={() => onDrop(i)}
              title="Take this change out; the rest stay"
              className="shrink-0 self-start rounded px-1.5 font-sans text-[11px] text-muted hover:bg-raised hover:text-fg"
            >
              Undo
            </button>
          )}
        </li>
      ))}
    </ol>
  )
}

/** Every statement an edit will run, read before anything runs. */
export function ReviewChanges() {
  const dialog = useApp((s) => (s.dialog?.kind === 'review' ? s.dialog : null))
  if (!dialog) return null
  const n = dialog.statements.length
  return (
    <Modal title="Review changes" onClose={closeDialog} width={720}>
      <div className="flex flex-col gap-3 p-4">
        <p className="m-0 text-muted">
          {n} statement{n === 1 ? '' : 's'} will run in one transaction. If any of them changes anything other
          than exactly one row, all of them are undone and nothing is saved.
        </p>
        <StatementList
          statements={dialog.statements}
          onDrop={
            dialog.applying
              ? undefined
              : (i) => {
                  const edit = dialog.edits[i]
                  if (edit) void dropEdit(dialog.tabId, edit, i)
                }
          }
        />
        {dialog.error && (
          <p
            role="alert"
            className="m-0 rounded border border-[#e5484d]/40 bg-[#e5484d]/8 px-3 py-2 text-[#e5484d]"
          >
            {dialog.error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={closeDialog} autoFocus>
            Back to editing
          </Button>
          <Button kind="primary" onClick={() => void applyDraft()} disabled={dialog.applying}>
            {dialog.applying ? 'Saving…' : 'Save in one transaction'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** A read-write connection asks before statements that change the schema. */
export function ConfirmRun() {
  const dialog = useApp((s) => (s.dialog?.kind === 'confirmRun' ? s.dialog : null))
  if (!dialog) return null
  return (
    <Modal title="Change the schema?" onClose={closeDialog} width={640}>
      <div className="flex flex-col gap-3 p-4">
        <p className="m-0">{dialog.message}</p>
        <p className="m-0 text-[12px] text-muted">
          This connection is read-write, so it asks first. A connection in full mode runs these without
          asking.
        </p>
        <StatementList statements={dialog.statements} />
        <div className="flex justify-end gap-2">
          <Button onClick={closeDialog}>Don’t run</Button>
          <Button
            kind="danger"
            onClick={() => {
              closeDialog()
              dialog.run()
            }}
          >
            Run the script
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** A new row, column by column; a column left as the default is not sent. */
export function InsertRow() {
  const dialog = useApp((s) => (s.dialog?.kind === 'insertRow' ? s.dialog : null))
  const tab = useApp((s) => s.tabs.find((t) => t.id === dialog?.tabId))
  const result = tab?.run?.results[tab.run.shown]
  const [values, setValues] = useState<Record<number, string | null>>({})
  if (!dialog || !tab || !result) return null
  const field = (i: number, value: string | null | undefined) =>
    setValues((v) => {
      const next = { ...v }
      if (value === undefined) delete next[i]
      else next[i] = value
      return next
    })
  return (
    <Modal title={`Add a row to ${result.edit?.table ?? 'the table'}`} onClose={closeDialog} width={560}>
      <form
        className="flex flex-col gap-3 p-4"
        onSubmit={(e) => {
          e.preventDefault()
          addInsert(tab.id, result.resultId, values)
          setValues({})
          closeDialog()
        }}
      >
        <div className="grid max-h-[55vh] grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1.5 overflow-auto">
          {result.columns.map((c, i) => {
            const value = values[i]
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
              <div key={i} className="contents">
                <label htmlFor={`insert-${i}`} className="text-right">
                  {c.name} <span className="text-[11px] text-muted">{c.dbType}</span>
                </label>
                <input
                  id={`insert-${i}`}
                  value={value ?? ''}
                  placeholder={value === null ? 'NULL' : 'default'}
                  disabled={value === null}
                  onChange={(e) => field(i, e.target.value === '' ? undefined : e.target.value)}
                  spellCheck={false}
                  className="rounded border border-border bg-bg px-2 py-1 font-mono text-[12px] outline-none focus:border-accent disabled:opacity-60"
                />
                <label className="flex items-center gap-1 text-[12px] text-muted">
                  <input
                    type="checkbox"
                    checked={value === null}
                    onChange={(e) => field(i, e.target.checked ? null : undefined)}
                  />
                  NULL
                </label>
              </div>
            )
          })}
        </div>
        <p className="m-0 text-[12px] text-muted">
          Empty fields are left out, so the table’s defaults apply. The row is added to the changes to review.
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={closeDialog}>Cancel</Button>
          <Button kind="primary" type="submit">
            Add to changes
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/** A yes-or-no question before something that cannot be taken back. */
export function Confirm() {
  const dialog = useApp((s) => (s.dialog?.kind === 'confirm' ? s.dialog : null))
  if (!dialog) return null
  return (
    <Modal title={dialog.title} onClose={closeDialog} width={480}>
      <div className="flex flex-col gap-3 p-4">
        <p className="m-0">{dialog.message}</p>
        <div className="flex justify-end gap-2">
          <Button onClick={closeDialog}>Cancel</Button>
          <Button
            kind="danger"
            onClick={() => {
              closeDialog()
              dialog.run()
            }}
          >
            {dialog.confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** Asks for one line of text, such as a folder's name. */
export function Prompt() {
  const dialog = useApp((s) => (s.dialog?.kind === 'prompt' ? s.dialog : null))
  const [value, setValue] = useState(dialog?.initial ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  if (!dialog) return null
  const submit = () => {
    const why = dialog.check(value)
    if (why !== null) {
      setProblem(why)
      return
    }
    closeDialog()
    dialog.run(value.trim())
  }
  return (
    <Modal title={dialog.title} onClose={closeDialog} width={420}>
      <form
        className="flex flex-col gap-3 p-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-muted">{dialog.label}</span>
          <input
            data-autofocus
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setProblem(null)
            }}
            onFocus={(e) => e.currentTarget.select()}
            list={dialog.suggestions ? 'prompt-suggestions' : undefined}
            aria-invalid={problem !== null}
            className="rounded border border-border bg-bg px-2 py-1 outline-none focus:border-accent aria-invalid:border-[#e5484d]"
          />
        </label>
        {dialog.suggestions && (
          <datalist id="prompt-suggestions">
            {dialog.suggestions.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        )}
        {problem && (
          <p role="alert" className="m-0 text-[12px] text-[#e5484d]">
            {problem}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={closeDialog}>Cancel</Button>
          <Button kind="primary" type="submit">
            {dialog.confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
