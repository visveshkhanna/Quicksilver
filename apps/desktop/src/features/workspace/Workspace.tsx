import { useEffect, useRef } from 'react'
import { Kbd } from '../../app/Kbd'
import { Button, ColorDot } from '../../app/ui'
import { binding } from '../../keymap/keymap'
import { COLORS } from '../../lib/target'
import {
  activateTab,
  cancelActive,
  closeTab,
  newTab,
  openDialog,
  PREVIEW_ROWS,
  ROW_CAP,
  type RunState,
  runActive,
  select,
  setTabCursor,
  setTabText,
  type Tab,
  useApp,
} from '../../state/app'

const HINTS = ['switch-database', 'go-to-object', 'command-palette', 'new-tab', 'new-connection']

/** The tab strip, the editor and the results of the front tab. */
export function Workspace() {
  const tabs = useApp((s) => s.tabs)
  const activeId = useApp((s) => s.activeTabId)
  const active = tabs.find((t) => t.id === activeId)

  return (
    <main className="flex h-full min-w-0 flex-col bg-bg">
      <div
        className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-border bg-panel"
        role="tablist"
        aria-label="Query tabs"
      >
        {tabs.map((tab) => (
          <TabButton key={tab.id} tab={tab} active={tab.id === activeId} />
        ))}
        <button
          type="button"
          onClick={() => newTab()}
          aria-label="New query tab"
          title="New query tab"
          className="px-2.5 text-[15px] text-muted hover:text-fg"
        >
          +
        </button>
      </div>
      {active ? <TabBody key={active.id} tab={active} /> : <Welcome />}
    </main>
  )
}

function TabButton({ tab, active }: { tab: Tab; active: boolean }) {
  const profile = useApp((s) => s.profiles.find((p) => p.id === tab.profileId))
  const where = profile ? `${profile.name}${tab.database ? `/${tab.database}` : ''}` : 'no database'
  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={active}
      title={`${tab.title} · ${where}`}
      onClick={() => activateTab(tab.id)}
      onKeyDown={(e) => e.key === 'Enter' && activateTab(tab.id)}
      onAuxClick={(e) => e.button === 1 && closeTab(tab.id)}
      className={`group relative flex max-w-64 shrink-0 cursor-default items-center gap-1.5 border-r border-border px-3 ${
        active ? 'bg-bg' : 'text-muted hover:bg-raised'
      }`}
    >
      {profile?.color && (
        <span
          aria-hidden
          className="absolute inset-x-0 top-0 h-0.5"
          style={{ background: COLORS[profile.color] }}
        />
      )}
      <span className="truncate">{tab.title}</span>
      <span className="truncate text-[11px] text-muted">· {where}</span>
      {tab.run?.status === 'running' && <span className="text-[11px] text-accent">●</span>}
      <button
        type="button"
        aria-label={`Close ${tab.title}`}
        onClick={(e) => {
          e.stopPropagation()
          closeTab(tab.id)
        }}
        className="ml-1 rounded px-1 text-muted opacity-0 hover:bg-border group-hover:opacity-100 group-aria-selected:opacity-100"
      >
        ×
      </button>
    </div>
  )
}

function Welcome() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6">
      <dl className="grid grid-cols-[auto_auto] items-center gap-x-6 gap-y-2 text-muted">
        {HINTS.map((id) => (
          <div key={id} className="contents">
            <dt className="text-right">{binding(id).title}</dt>
            <dd className="m-0">
              <Kbd id={id} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function TabBody({ tab }: { tab: Tab }) {
  const profile = useApp((s) => s.profiles.find((p) => p.id === tab.profileId))
  const editor = useRef<HTMLTextAreaElement>(null)
  const running = tab.run?.status === 'running'

  // Put the cursor back where it was when the tab comes to the front (the
  // body is keyed by tab, so this runs once per switch).
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on mount
  useEffect(() => {
    const area = editor.current
    if (!area) return
    area.focus()
    area.setSelectionRange(tab.cursor, tab.cursor)
  }, [])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <button
          type="button"
          onClick={() => openDialog({ kind: 'switcher' })}
          className="flex min-w-0 items-center gap-1.5 rounded border border-border px-2 py-0.5 hover:bg-raised"
          title="Switch database"
        >
          <ColorDot color={profile?.color} />
          <span className="truncate">
            {profile ? `${profile.name} / ${tab.database ?? 'default database'}` : 'Choose a database…'}
          </span>
          <Kbd id="switch-database" />
        </button>
        {profile?.mode === 'readOnly' && (
          <span className="rounded bg-raised px-1.5 py-0.5 text-[11px] font-semibold text-muted">
            READ-ONLY
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {running ? (
            <Button onClick={cancelActive}>Cancel</Button>
          ) : (
            <>
              <Button onClick={() => void runActive('all')} disabled={!profile} title="Run everything">
                Run all
              </Button>
              <Button kind="primary" onClick={() => void runActive('statement')} disabled={!profile}>
                Run <Kbd id="run-statement" />
              </Button>
            </>
          )}
        </span>
      </div>
      <textarea
        ref={editor}
        // The editor is a plain text area until phase 5 brings CodeMirror.
        aria-label="SQL editor"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        value={tab.sql}
        placeholder={profile ? 'SELECT …' : 'Choose a database with the switcher, then type SQL here.'}
        onChange={(e) => setTabText(tab.id, e.target.value, e.target.selectionStart)}
        onSelect={(e) => setTabCursor(tab.id, e.currentTarget.selectionStart)}
        onKeyDown={(e) => {
          if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault()
            const area = e.currentTarget
            const { selectionStart: start, selectionEnd: end, value } = area
            const next = `${value.slice(0, start)}  ${value.slice(end)}`
            setTabText(tab.id, next, start + 2)
            requestAnimationFrame(() => area.setSelectionRange(start + 2, start + 2))
          }
        }}
        className="min-h-24 flex-[2] resize-none bg-bg p-3 font-mono text-[13px] leading-relaxed outline-none"
      />
      <Results run={tab.run} />
    </div>
  )
}

function Results({ run }: { run: RunState | null }) {
  if (!run) {
    return (
      <section
        aria-label="Results"
        className="flex flex-1 items-center justify-center border-t border-border text-muted"
      >
        <span className="flex items-center gap-2">
          Run a statement with <Kbd id="run-statement" />, or everything with <Kbd id="run-all" />
        </span>
      </section>
    )
  }
  const last = run.statements[run.statements.length - 1]
  const capped = run.statements.some((s) => s.outcome?.capped)
  return (
    <section aria-label="Results" className="flex min-h-0 flex-[3] flex-col border-t border-border">
      {run.status === 'running' && <p className="px-3 py-2 text-muted">Running…</p>}
      {run.error && <ErrorBox run={run} />}
      {run.status !== 'running' && !run.error && run.resultId === null && last?.outcome && (
        <p className="px-3 py-2 text-muted">
          {last.outcome.rowsAffected !== null
            ? `${last.outcome.rowsAffected.toLocaleString()} row${last.outcome.rowsAffected === 1 ? '' : 's'} affected`
            : 'Done'}{' '}
          · {run.statements.length} statement{run.statements.length === 1 ? '' : 's'}
        </p>
      )}
      {run.resultId !== null && run.columns.length > 0 && (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="border-collapse font-mono text-[12px]">
            <thead className="sticky top-0 bg-panel">
              <tr>
                {run.columns.map((c, i) => (
                  <th
                    // biome-ignore lint/suspicious/noArrayIndexKey: columns can share names
                    key={i}
                    title={c.dbType}
                    className="border-r border-b border-border px-2 py-1 text-left font-semibold whitespace-nowrap"
                  >
                    {c.name}
                    <span className="ml-1 font-normal text-muted">{c.dbType}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {run.rows.map((row, r) => (
                <tr
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
                  key={r}
                  onClick={() => select({ kind: 'row', columns: run.columns, row })}
                  className="hover:bg-accent/10"
                >
                  {row.map((cell, i) => (
                    <td
                      // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                      key={i}
                      className={`max-w-80 truncate border-r border-b border-border/60 px-2 py-0.5 whitespace-nowrap ${
                        cell === null ? 'text-muted italic' : ''
                      }`}
                    >
                      {cell ?? 'NULL'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {last?.outcome && last.outcome.rowsReturned > run.rows.length && (
            <p className="px-3 py-2 text-[12px] text-muted">
              Showing the first {PREVIEW_ROWS} of {last.outcome.rowsReturned.toLocaleString()} rows
              {capped ? ` (the run stopped at ${ROW_CAP.toLocaleString()})` : ''}. The full grid arrives in
              the next release.
            </p>
          )}
        </div>
      )}
    </section>
  )
}

function ErrorBox({ run }: { run: RunState }) {
  const error = run.error
  if (!error) return null
  if (error.kind === 'cancelled') return <p className="px-3 py-2 text-muted">Cancelled.</p>
  const message = 'message' in error ? error.message : error.kind
  return (
    <div role="alert" className="m-2 rounded border border-[#e5484d]/40 bg-[#e5484d]/8 px-3 py-2">
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
