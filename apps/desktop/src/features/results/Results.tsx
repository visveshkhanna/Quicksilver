import { Kbd } from '../../app/Kbd'
import type { Engine } from '../../ipc/types'
import { quoteIdent } from '../../lib/target'
import { type RunState, runAgainUncapped, setView, showResult, type Tab } from '../../state/app'
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
        <span className="flex items-center gap-2">
          Run a statement with <Kbd id="run-statement" />, everything with <Kbd id="run-all" />, or explain
          one with <Kbd id="explain-statement" />
        </span>
      </div>
    )
  }
  const result = run.results[run.shown]
  const last = run.statements[run.statements.length - 1]
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {run.error && <ErrorBox run={run} />}
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
  const message = 'message' in error ? error.message : error.kind
  return (
    <div role="alert" className="m-2 shrink-0 rounded border border-[#e5484d]/40 bg-[#e5484d]/8 px-3 py-2">
      <p className="font-semibold text-[#e5484d]">
        {run.errorIndex !== null && run.statements.length > 0 ? `Statement ${run.errorIndex + 1}: ` : ''}
        {message}
      </p>
      {error.kind === 'query' && (
        <p className="mt-1 text-[12px] text-muted">
          {[
            error.code && `code ${error.code}`,
            error.position !== null && `at character ${error.position}`,
            error.detail,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
    </div>
  )
}
