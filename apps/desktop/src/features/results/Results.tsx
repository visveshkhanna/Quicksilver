import { Kbd } from '../../app/Kbd'
import { Button } from '../../app/ui'
import type { Engine } from '../../ipc/types'
import { copyText } from '../../lib/clipboard'
import { quoteIdent } from '../../lib/target'
import {
  askDiscardDraft,
  type Draft,
  draftSize,
  errorText,
  openDialog,
  type ResultView,
  type RunState,
  reviewDraft,
  runAgain,
  runAgainUncapped,
  say,
  setView,
  showResult,
  type Tab,
} from '../../state/app'
import { Grid } from '../grid/Grid'
import { PlanView } from './PlanView'

/** The bottom of a tab: a run's rows or messages, or a plan. */
export function Results({ tab, engine }: { tab: Tab; engine: Engine | null }) {
  const run = tab.run
  const showingPlan = tab.view === 'plan' && tab.plan !== null
  return (
    <section aria-label="Results" className="flex h-full min-h-0 flex-col border-t border-border">
      {(run || tab.plan) && (
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-panel px-1.5 text-[12px]">
          {run && (
            <ViewTab active={!showingPlan} onClick={() => setView('results')}>
              Results
            </ViewTab>
          )}
          {tab.plan && (
            <ViewTab active={showingPlan} onClick={() => setView('plan')}>
              Plan
            </ViewTab>
          )}
          {!showingPlan && run && run.results.length > 1 && (
            <span
              className="ml-2 flex items-center gap-1 border-l border-border pl-2"
              role="tablist"
              aria-label="Statement results"
            >
              {run.results.map((r, i) => (
                <ViewTab key={r.resultId} active={run.shown === i} onClick={() => showResult(i)}>
                  {`Statement ${r.index + 1}`}
                </ViewTab>
              ))}
            </span>
          )}
          {!showingPlan && run && <RunSummary run={run} />}
        </div>
      )}
      {showingPlan && tab.plan ? <PlanView plan={tab.plan} /> : <RunBody tab={tab} engine={engine} />}
    </section>
  )
}

function ViewTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded px-2 py-0.5 ${active ? 'bg-bg font-semibold shadow-sm' : 'text-muted hover:text-fg'}`}
    >
      {children}
    </button>
  )
}

function RunSummary({ run }: { run: RunState }) {
  const result = run.results[run.shown]
  const outcome = result ? run.statements.find((s) => s.resultId === result.resultId)?.outcome : null
  const parts: string[] = []
  if (result) parts.push(`${result.rows.toLocaleString()} row${result.rows === 1 ? '' : 's'}`)
  if (outcome) parts.push(`${outcome.elapsedMs.toLocaleString()} ms`)
  else if (run.elapsedMs !== null) parts.push(`${run.elapsedMs.toLocaleString()} ms`)
  return (
    <span role="status" className="ml-auto flex items-center gap-2 pr-1 text-muted">
      {run.status === 'running' && <span className="text-accent">Running…</span>}
      {parts.join(' · ')}
      {outcome?.capped && run.rowCap !== null && (
        <span className="flex items-center gap-1.5 rounded bg-[#e2a336]/15 px-1.5 text-fg">
          Stopped at {run.rowCap.toLocaleString()} rows
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() => void runAgainUncapped()}
          >
            Run again without the limit
          </button>
        </span>
      )}
    </span>
  )
}

function RunBody({ tab, engine }: { tab: Tab; engine: Engine | null }) {
  const run = tab.run
  if (!run) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted">
        <p className="m-0 px-4 text-center leading-7">
          Run a statement with <Kbd id="run-statement" />, everything with <Kbd id="run-all" />, or explain
          one with <Kbd id="explain-statement" />
        </p>
      </div>
    )
  }
  const result = run.results[run.shown]
  const last = run.statements[run.statements.length - 1]
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {run.error && <ErrorBox run={run} />}
      {result && <EditBar tab={tab} result={result} />}
      {result ? (
        <Grid key={result.resultId} tabId={tab.id} result={result} insertTable={insertTarget(tab, engine)} />
      ) : (
        run.status !== 'running' &&
        !run.error &&
        last?.outcome && (
          <p className="px-3 py-2 text-muted">
            {last.outcome.rowsAffected !== null
              ? `${last.outcome.rowsAffected.toLocaleString()} row${last.outcome.rowsAffected === 1 ? '' : 's'} affected`
              : 'Done'}{' '}
            · {run.statements.length} statement{run.statements.length === 1 ? '' : 's'}
            {run.elapsedMs !== null && ` · ${run.elapsedMs.toLocaleString()} ms`}
          </p>
        )
      )}
      {!result && run.status === 'running' && <p className="px-3 py-2 text-muted">Running…</p>}
    </div>
  )
}

/** Whether the rows can be edited, and the unsaved changes to them. */
function EditBar({ tab, result }: { tab: Tab; result: ResultView }) {
  const draft = tab.draft?.resultId === result.resultId ? tab.draft : null
  const changes = draftSize(draft)
  if (!result.edit) return null
  if (result.edit.reason) {
    return (
      <p
        className="m-0 shrink-0 truncate border-b border-border px-2 py-1 text-[11px] text-muted"
        title={result.edit.reason}
      >
        Read only: {result.edit.reason}.
      </p>
    )
  }
  return (
    <div className="@container flex h-8 shrink-0 items-center gap-2 border-b border-border px-2 text-[12px]">
      <span
        className="min-w-0 truncate text-muted @max-[520px]:hidden"
        title={`Rows are named by ${result.edit.byPrimaryKey ? 'their primary key' : 'every value, since the table has no primary key'}`}
      >
        Editable · rows named by {result.edit.byPrimaryKey ? 'primary key' : 'every value (no primary key)'}
      </span>
      <span className="ml-auto flex min-w-0 items-center gap-2">
        <Button small onClick={() => openDialog({ kind: 'insertRow', tabId: tab.id })}>
          Add row
        </Button>
        {changes > 0 && (
          <>
            <span role="status" className="shrink-0 font-semibold text-[#b4561a]" title={breakdown(draft)}>
              {changes} unsaved change{changes === 1 ? '' : 's'}
            </span>
            {/* New rows are not drawn in the grid, so say they are there. */}
            {draft && draft.inserts.length > 0 && (
              <span className="min-w-0 truncate text-muted @max-[640px]:hidden">({breakdown(draft)})</span>
            )}
            <Button small onClick={() => askDiscardDraft(tab.id)}>
              Discard
            </Button>
            <Button small kind="primary" onClick={() => void reviewDraft()}>
              Review and save{' '}
              <span className="@max-[560px]:hidden">
                <Kbd id="review-changes" />
              </span>
            </Button>
          </>
        )}
      </span>
    </div>
  )
}

/** What a draft holds, by kind: "2 edited rows, 1 new row". */
function breakdown(draft: Draft | null): string {
  if (!draft) return ''
  const deleted = new Set(draft.deletes)
  const edited = Object.keys(draft.updates).filter((r) => !deleted.has(Number(r))).length
  const parts: [number, string, string][] = [
    [edited, 'edited row', 'edited rows'],
    [draft.deletes.length, 'row to delete', 'rows to delete'],
    [draft.inserts.length, 'new row', 'new rows'],
  ]
  return parts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
    .join(', ')
}

/** The table name an INSERT copy uses: the tab's table, or a placeholder to replace. */
function insertTarget(tab: Tab, engine: Engine | null): string {
  if (!tab.table || !engine) return 'table_name'
  const { schema, name } = tab.table
  return schema && !(engine === 'sqlite' && schema === 'main')
    ? `${quoteIdent(schema, engine)}.${quoteIdent(name, engine)}`
    : quoteIdent(name, engine)
}

function ErrorBox({ run }: { run: RunState }) {
  const error = run.error
  if (!error) return null
  if (error.kind === 'cancelled') return <p className="px-3 py-2 text-muted">Cancelled.</p>
  const message = errorText(error)
  const details =
    error.kind === 'query'
      ? [
          error.code && `code ${error.code}`,
          error.position !== null && `at character ${error.position}`,
          error.detail,
        ]
          .filter(Boolean)
          .join(' · ')
      : ''
  const prefix =
    run.errorIndex !== null && run.statements.length > 0 ? `Statement ${run.errorIndex + 1}: ` : ''
  const retry = error.kind === 'closed' || error.kind === 'connect' || error.kind === 'tls'
  return (
    <div
      role="alert"
      className="m-2 flex shrink-0 items-start gap-3 rounded border border-[#e5484d]/40 bg-[#e5484d]/8 px-3 py-2"
    >
      <div className="min-w-0 flex-1 select-text">
        <p className="font-semibold break-words text-[#e5484d]">
          {prefix}
          {message}
        </p>
        {details && <p className="mt-1 text-[12px] text-muted">{details}</p>}
      </div>
      <div className="flex shrink-0 gap-1.5">
        {retry && (
          <Button small onClick={() => void runAgain()}>
            {error.kind === 'closed' ? 'Reconnect and run' : 'Try again'}
          </Button>
        )}
        <Button
          small
          onClick={() =>
            copyText([prefix + message, details].filter(Boolean).join('\n')).then(
              () => say('Copied the error'),
              (err) => say(`Could not copy: ${errorText(err)}`, true),
            )
          }
        >
          Copy
        </Button>
      </div>
    </div>
  )
}
