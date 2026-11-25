import { useMemo, useState } from 'react'
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { Kbd } from '../../app/Kbd'
import { Button, ColorDot } from '../../app/ui'
import { binding } from '../../keymap/keymap'
import { COLORS } from '../../lib/target'
import {
  activateTab,
  applyFilter,
  cancelActive,
  closeTab,
  explainActive,
  newTab,
  openDialog,
  runActive,
  setTabCursor,
  setTabText,
  type Tab,
  useApp,
} from '../../state/app'
import { panelStorage } from '../../state/layoutStorage'
import { SqlEditor } from '../editor/SqlEditor'
import { schemaSourceFor } from '../editor/schemaSource'
import { Results } from '../results/Results'

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
  const running = tab.run?.status === 'running'
  const layout = useDefaultLayout({ id: 'editor-results', storage: panelStorage })
  const engine = profile?.engine ?? null
  const target = useMemo(
    () => ({ profileId: tab.profileId, database: tab.database }),
    [tab.profileId, tab.database],
  )

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
              <Button
                onClick={() => void explainActive()}
                disabled={!profile}
                title="Explain without running"
              >
                Explain
              </Button>
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
      {tab.table && profile && <FilterBar tab={tab} />}
      <Group
        orientation="vertical"
        className="min-h-0 flex-1"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
      >
        <Panel id="editor" defaultSize="40%" minSize="80px">
          <SqlEditor
            tabId={tab.id}
            doc={tab.sql}
            cursor={tab.cursor}
            engine={engine}
            errorAt={tab.run?.errorAt ?? null}
            placeholderText={
              profile ? 'SELECT …' : 'Choose a database with the switcher, then type SQL here.'
            }
            schema={() => schemaSourceFor(target)}
            onChange={(sql, cursor) => setTabText(tab.id, sql, cursor)}
            onCursor={(cursor) => setTabCursor(tab.id, cursor)}
          />
        </Panel>
        <Separator className="h-px bg-border transition-colors hover:bg-accent data-[separator=active]:bg-accent" />
        <Panel id="results" minSize="80px">
          <Results tab={tab} engine={engine} />
        </Panel>
      </Group>
    </div>
  )
}

/** On a table's tab: a WHERE clause (or ORDER BY …) that rewrites the query and runs it. */
function FilterBar({ tab }: { tab: Tab }) {
  const [text, setText] = useState(tab.filter)
  return (
    <form
      className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2"
      onSubmit={(e) => {
        e.preventDefault()
        void applyFilter(text)
      }}
    >
      <label htmlFor={`filter-${tab.id}`} className="shrink-0 font-mono text-[12px] font-semibold text-muted">
        WHERE
      </label>
      <input
        id={`filter-${tab.id}`}
        aria-label="Filter rows"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && text !== '') {
            e.preventDefault()
            setText('')
            void applyFilter('')
          }
        }}
        placeholder="a condition, or ORDER BY …; Enter runs it"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none"
      />
    </form>
  )
}
