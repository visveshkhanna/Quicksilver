// The UI's state and the actions that change it. Components read with
// `useApp(selector)` and call the exported functions; nothing else writes.

import { create } from 'zustand'
import { forgetEditor, selectionIn } from '../features/editor/registry'
import * as ipc from '../ipc/commands'
import type { CatalogEntry, Notice, Profile, ProfileFields } from '../ipc/store'
import * as saved from '../ipc/store'
import type {
  Column,
  ColumnInfo,
  DbObject,
  EditTarget,
  Plan,
  QsError,
  RowEdit,
  SessionInfo,
  SortDirection,
  StatementOutcome,
} from '../ipc/types'
import type { Overrides } from '../keymap/keymap'
import { type Target, targetKey } from '../lib/target'

/**
 * How many rows a run keeps per statement. Rows past it are not read; the
 * results say so and offer to run again without the limit.
 */
export const ROW_CAP = 100_000

/** One statement's rows, as the grid pages through them. */
export type ResultView = {
  /** The statement's position in the script. */
  index: number
  resultId: number
  columns: Column[]
  /** Rows stored so far. */
  rows: number
  /** Whether the statement finished, so the rows can be sorted. */
  done: boolean
  sort: { column: number; direction: SortDirection } | null
  /** Bumped whenever the rows' order changes, so the grid refetches. */
  version: number
  /** Whether the rows can be edited, once known. */
  edit: EditTarget | null
}

/**
 * Changes not yet saved, for one result. Rows are named by source row (their
 * place in arrival order), so sorting never moves an edit to another row.
 */
export type Draft = {
  resultId: number
  /** Source row → result column → new value (`null` is NULL). */
  updates: Record<number, Record<number, string | null>>
  /** Source rows to delete. */
  deletes: number[]
  /** New rows: result column → value; columns left out take their defaults. */
  inserts: Record<number, string | null>[]
}

export type RunState = {
  status: 'running' | 'done' | 'failed'
  runId: number | null
  /** The text that ran, and where it starts in the editor. */
  script: string
  offset: number
  /** The row cap it ran with; `null` for none. */
  rowCap: number | null
  /** Each statement's start in the editor (UTF-16), by index. */
  starts: number[]
  statements: { index: number; resultId: number | null; outcome: StatementOutcome | null }[]
  results: ResultView[]
  /** Which result is shown. */
  shown: number
  elapsedMs: number | null
  error: QsError | null
  errorIndex: number | null
  /** Where in the editor the error points, when the server said. */
  errorAt: number | null
}

export type PlanState =
  | { status: 'loading'; sql: string }
  | { status: 'ready'; sql: string; plan: Plan }
  | { status: 'failed'; sql: string; error: string }

/** A table a tab was opened on, for the filter bar. */
export type TableSource = { schema: string | null; name: string }

export type Tab = {
  id: string
  title: string
  profileId: string | null
  database: string | null
  sql: string
  cursor: number
  run: RunState | null
  plan: PlanState | null
  /** What the results area shows. */
  view: 'results' | 'plan'
  /** Set when the tab was opened on a table; enables the filter bar. */
  table: TableSource | null
  filter: string
  draft: Draft | null
}

export type Dialog =
  | null
  | { kind: 'switcher' }
  | { kind: 'goto' }
  | { kind: 'palette' }
  | { kind: 'shortcuts' }
  | { kind: 'connection'; profileId: string | null; pasteUrl?: boolean }
  | { kind: 'confirmRun'; message: string; statements: string[]; run: () => void }
  | { kind: 'review'; tabId: string; statements: string[]; error: string | null; applying: boolean }
  | { kind: 'insertRow'; tabId: string }

export type PasswordRequest = {
  profile: Profile
  resolve: (answer: { password: string; remember: boolean } | null) => void
}

/** What a navigator node is. Keys come from `nodeKey`. */
export type NodeRef =
  | { kind: 'connection'; profileId: string }
  | { kind: 'database'; profileId: string; database: string }
  | { kind: 'schema'; profileId: string; database: string; schema: string }
  | { kind: 'group'; profileId: string; database: string; schema: string; group: ObjectGroup }
  | { kind: 'object'; profileId: string; database: string; schema: string; object: DbObject }

export type ObjectGroup = 'tables' | 'views' | 'functions' | 'sequences'

export type Loaded =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | {
      status: 'ready'
      databases?: string[]
      schemas?: string[]
      objects?: DbObject[]
      columns?: ColumnInfo[]
    }

export type Selection =
  | { kind: 'row'; columns: Column[]; row: (string | null)[]; position?: number }
  | { kind: 'node'; node: NodeRef }

export type State = {
  ready: boolean
  profiles: Profile[]
  catalog: CatalogEntry[]
  /** Open sessions by `targetKey`. */
  sessions: Record<string, SessionInfo>
  tabs: Tab[]
  activeTabId: string | null
  closedTabs: Tab[]
  /** Target keys, most recent first. */
  recent: string[]
  overrides: Overrides
  dialog: Dialog
  passwordRequest: PasswordRequest | null
  notices: Notice[]
  /** A short message for the status bar. */
  message: { text: string; error: boolean } | null
  selection: Selection | null
  panels: { navigator: boolean; inspector: boolean }
  tree: Record<string, Loaded>
  expanded: Record<string, boolean>
  filter: string
}

const initial: State = {
  ready: false,
  profiles: [],
  catalog: [],
  sessions: {},
  tabs: [],
  activeTabId: null,
  closedTabs: [],
  recent: [],
  overrides: {},
  dialog: null,
  passwordRequest: null,
  notices: [],
  message: null,
  selection: null,
  panels: { navigator: true, inspector: true },
  tree: {},
  expanded: {},
  filter: '',
}

export const useApp = create<State>(() => initial)

const get = useApp.getState
const set = useApp.setState

/** Back to the empty state (tests). */
export function resetApp() {
  set(initial, true)
  pending.clear()
}

// --- Boot -------------------------------------------------------------------

/** Loads everything saved, then marks the app ready. */
export async function boot() {
  const [profiles, catalog, buffers, recent, overrides, panels, notices] = await Promise.all([
    saved.listProfiles(),
    saved.catalog(),
    saved.buffers(),
    saved.getLayout<string[]>('recentTargets'),
    saved.getLayout<Overrides>('keymap'),
    saved.getLayout<State['panels']>('panelVisibility'),
    saved.storeNotices(),
  ])
  const tabs: Tab[] = buffers.map((b) => ({
    ...blankTab,
    id: b.id,
    title: b.title,
    profileId: profiles.some((p) => p.id === b.profileId) ? b.profileId : null,
    database: b.database,
    sql: b.sql,
    cursor: b.cursor,
  }))
  set({
    ready: true,
    profiles,
    catalog,
    tabs,
    activeTabId: tabs[0]?.id ?? null,
    recent: recent ?? [],
    overrides: overrides ?? {},
    panels: panels ?? initial.panels,
    notices,
  })
}

export function profileById(id: string | null): Profile | undefined {
  return id ? get().profiles.find((p) => p.id === id) : undefined
}

export function isQsError(err: unknown): err is QsError {
  return typeof err === 'object' && err !== null && 'kind' in err
}

export function errorText(err: unknown): string {
  if (isQsError(err)) return 'message' in err ? err.message : err.kind
  return err instanceof Error ? err.message : String(err)
}

export function say(text: string, error = false) {
  set({ message: { text, error } })
}

// --- Dialogs ------------------------------------------------------------------

export function openDialog(dialog: Dialog) {
  set({ dialog })
}

export function closeDialog() {
  set({ dialog: null })
}

function askPassword(profile: Profile): Promise<{ password: string; remember: boolean } | null> {
  return new Promise((resolve) => {
    set({
      passwordRequest: {
        profile,
        resolve: (answer) => {
          set({ passwordRequest: null })
          resolve(answer)
        },
      },
    })
  })
}

// --- Profiles -----------------------------------------------------------------

export async function saveProfile(
  id: string | null,
  fields: ProfileFields,
  password: saved.PasswordChange,
): Promise<Profile> {
  const profile = id
    ? await saved.updateProfile(id, fields, password)
    : await saved.createProfile(fields, password)
  set((s) => ({
    profiles: id ? s.profiles.map((p) => (p.id === id ? profile : p)) : [...s.profiles, profile],
  }))
  if (id) await disconnectProfile(id)
  return profile
}

export async function deleteProfile(id: string) {
  await disconnectProfile(id)
  await saved.deleteProfile(id)
  set((s) => ({
    profiles: s.profiles.filter((p) => p.id !== id),
    catalog: s.catalog.filter((c) => c.profileId !== id),
    tabs: s.tabs.map((t) => (t.profileId === id ? { ...t, profileId: null, database: null } : t)),
    recent: s.recent.filter((k) => !k.startsWith(`${id}\u0000`)),
  }))
}

// --- Sessions -----------------------------------------------------------------

const pending = new Map<string, Promise<SessionInfo>>()

/**
 * A session for `profileId` in `database` (its own default when `null`),
 * connecting if there is none. Asks for a password when the keychain has
 * none saved.
 */
export function ensureSession(profileId: string, database: string | null): Promise<SessionInfo> {
  const key = targetKey(profileId, database)
  const open = get().sessions[key]
  if (open) return Promise.resolve(open)
  const waiting = pending.get(key)
  if (waiting) return waiting
  const connecting = connect(profileId, database).finally(() => pending.delete(key))
  pending.set(key, connecting)
  return connecting
}

async function connect(profileId: string, database: string | null): Promise<SessionInfo> {
  const profile = profileById(profileId)
  if (!profile) throw new Error('that connection no longer exists')
  let info: SessionInfo
  try {
    info = await saved.connectProfile(profileId, database)
  } catch (err) {
    if (!isQsError(err) || err.kind !== 'passwordNeeded') throw err
    const answer = await askPassword(profile)
    if (!answer) throw { kind: 'cancelled' } satisfies QsError
    info = await saved.connectProfile(profileId, database, answer.password)
    if (answer.remember) {
      const { id, createdMs, updatedMs, ...fields } = profile
      await saved.updateProfile(id, fields, { kind: 'set', password: answer.password })
    }
  }
  set((s) => ({
    sessions: {
      ...s.sessions,
      [targetKey(profileId, database)]: info,
      [targetKey(profileId, info.database)]: info,
    },
  }))
  // The catalog cache is refreshed in the background after connecting.
  setTimeout(() => void reloadCatalog(), 1500)
  return info
}

export async function disconnectProfile(profileId: string) {
  const prefix = `${profileId}\u0000`
  const sessions = get().sessions
  const ids = new Set(
    Object.entries(sessions)
      .filter(([k]) => k.startsWith(prefix))
      .map(([, s]) => s.id),
  )
  await Promise.all([...ids].map((id) => ipc.disconnect(id).catch(() => {})))
  set((s) => ({
    sessions: Object.fromEntries(Object.entries(s.sessions).filter(([k]) => !k.startsWith(prefix))),
    tree: Object.fromEntries(Object.entries(s.tree).filter(([k]) => !k.startsWith(`c:${profileId}`))),
    expanded: Object.fromEntries(Object.entries(s.expanded).filter(([k]) => !k.startsWith(`c:${profileId}`))),
  }))
}

export function isConnected(profileId: string): boolean {
  const prefix = `${profileId}\u0000`
  return Object.keys(get().sessions).some((k) => k.startsWith(prefix))
}

export async function reloadCatalog() {
  try {
    set({ catalog: await saved.catalog() })
  } catch {
    // The cache is a convenience; a failed read leaves the old one.
  }
}

// --- Tabs ---------------------------------------------------------------------

const blankTab: Omit<Tab, 'id' | 'title'> = {
  profileId: null,
  database: null,
  sql: '',
  cursor: 0,
  run: null,
  plan: null,
  view: 'results',
  table: null,
  filter: '',
  draft: null,
}

export function activeTab(state: State = get()): Tab | undefined {
  return state.tabs.find((t) => t.id === state.activeTabId)
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()

function persistTab(tab: Tab, now = false) {
  const write = () => {
    saveTimers.delete(tab.id)
    const current = get().tabs.find((t) => t.id === tab.id)
    if (!current) return
    const position = get().tabs.indexOf(current)
    void saved
      .saveBuffer({
        id: current.id,
        profileId: current.profileId,
        database: current.database,
        title: current.title,
        sql: current.sql,
        cursor: current.cursor,
        position,
      })
      .catch((err) => say(`Could not save the tab: ${errorText(err)}`, true))
  }
  clearTimeout(saveTimers.get(tab.id))
  if (now) write()
  else saveTimers.set(tab.id, setTimeout(write, 400))
}

function updateTab(id: string, change: Partial<Tab> | ((tab: Tab) => Partial<Tab>)) {
  set((s) => ({
    tabs: s.tabs.map((t) =>
      t.id === id ? { ...t, ...(typeof change === 'function' ? change(t) : change) } : t,
    ),
  }))
}

function nextTitle(): string {
  const used = new Set(get().tabs.map((t) => t.title))
  let n = 1
  while (used.has(`Query ${n}`)) n++
  return `Query ${n}`
}

/**
 * Opens a tab on `target` (or the front tab's target) and makes it active.
 * A tab opened on `table` gets the filter bar.
 */
export function newTab(target?: Target | null, sql = '', table: TableSource | null = null): Tab {
  const front = activeTab()
  const where =
    target === undefined ? (front ? { profileId: front.profileId, database: front.database } : null) : target
  const tab: Tab = {
    ...blankTab,
    id: crypto.randomUUID(),
    title: table ? table.name : nextTitle(),
    profileId: where?.profileId ?? null,
    database: where?.database ?? null,
    sql,
    cursor: sql.length,
    table,
  }
  set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }))
  persistTab(tab, true)
  if (where?.profileId) touchTarget({ profileId: where.profileId, database: where.database })
  return tab
}

export function activateTab(id: string) {
  set({ activeTabId: id })
}

export function jumpToTab(index: number) {
  const tab = get().tabs[index]
  if (tab) set({ activeTabId: tab.id })
}

export function closeTab(id = get().activeTabId) {
  const tabs = get().tabs
  const index = tabs.findIndex((t) => t.id === id)
  const tab = tabs[index]
  if (!tab) return
  if (tab.run?.status === 'running' && tab.run.runId !== null) void ipc.cancelRun(tab.run.runId)
  freeResults(tab)
  forgetEditor(tab.id)
  clearTimeout(saveTimers.get(tab.id))
  const rest = tabs.filter((t) => t.id !== id)
  const next = rest[Math.min(index, rest.length - 1)]
  set((s) => ({
    tabs: rest,
    activeTabId: s.activeTabId === id ? (next?.id ?? null) : s.activeTabId,
    closedTabs: [{ ...tab, run: null, plan: null, view: 'results' as const }, ...s.closedTabs].slice(0, 20),
  }))
  void saved.deleteBuffer(tab.id).catch(() => {})
}

export function reopenTab() {
  const [tab, ...rest] = get().closedTabs
  if (!tab) return
  const restored = { ...tab, title: get().tabs.some((t) => t.title === tab.title) ? nextTitle() : tab.title }
  set((s) => ({ tabs: [...s.tabs, restored], activeTabId: restored.id, closedTabs: rest }))
  persistTab(restored, true)
}

export function setTabText(id: string, sql: string, cursor: number) {
  updateTab(id, { sql, cursor })
  const tab = get().tabs.find((t) => t.id === id)
  if (tab) persistTab(tab)
}

export function setTabCursor(id: string, cursor: number) {
  updateTab(id, { cursor })
}

/** Points tab `id` (or a new tab when there is none) at `target`. */
export function retarget(target: Target, id = get().activeTabId) {
  const tab = get().tabs.find((t) => t.id === id)
  if (!tab) {
    newTab(target)
    return
  }
  updateTab(tab.id, { profileId: target.profileId, database: target.database })
  persistTab({ ...tab, ...target }, true)
  touchTarget(target)
}

/** Records `target` as just used, and starts connecting so it is ready. */
function touchTarget(target: Target) {
  if (!target.profileId) return
  const key = targetKey(target.profileId, target.database)
  const recent = [key, ...get().recent.filter((k) => k !== key)].slice(0, 50)
  set({ recent })
  void saved.setLayout('recentTargets', recent).catch(() => {})
  ensureSession(target.profileId, target.database).catch((err) => {
    if (!(isQsError(err) && err.kind === 'cancelled')) say(errorText(err), true)
  })
}

// --- Runs ---------------------------------------------------------------------

function freeResults(tab: Tab) {
  for (const r of tab.run?.results ?? []) void ipc.closeResult(r.resultId).catch(() => {})
}

function updateRun(tabId: string, change: (run: RunState) => Partial<RunState>) {
  updateTab(tabId, (t) => (t.run ? { run: { ...t.run, ...change(t.run) } } : {}))
}

function updateResult(tabId: string, resultId: number, change: (r: ResultView) => Partial<ResultView>) {
  updateRun(tabId, (run) => ({
    results: run.results.map((r) => (r.resultId === resultId ? { ...r, ...change(r) } : r)),
  }))
}

const encoder = new TextEncoder()

/** The UTF-16 offset of byte offset `byte` in `text`. */
export function byteToUtf16(text: string, byte: number): number {
  let bytes = 0
  let i = 0
  while (i < text.length && bytes < byte) {
    const code = text.codePointAt(i) ?? 0
    bytes += encoder.encode(String.fromCodePoint(code)).length
    i += code > 0xffff ? 2 : 1
  }
  return i
}

/** The text the front tab would run, and where it starts: the selection, the statement under the cursor, or everything. */
async function textToRun(
  tab: Tab,
  profile: Profile,
  mode: 'statement' | 'all',
): Promise<{ script: string; offset: number } | null> {
  if (mode === 'all') return { script: tab.sql, offset: 0 }
  const selected = selectionIn(tab.id)
  if (selected) return { script: tab.sql.slice(selected.from, selected.to), offset: selected.from }
  const range = await ipc.statementAt(tab.sql, profile.engine, tab.cursor)
  if (!range) return null
  return { script: tab.sql.slice(range.start, range.end), offset: range.start }
}

async function sessionFor(tab: Tab): Promise<{ profile: Profile; session: SessionInfo } | null> {
  const profile = profileById(tab.profileId)
  if (!profile) {
    say('Pick a database for this tab first.')
    openDialog({ kind: 'switcher' })
    return null
  }
  try {
    return { profile, session: await ensureSession(profile.id, tab.database) }
  } catch (err) {
    if (!(isQsError(err) && err.kind === 'cancelled')) say(errorText(err), true)
    return null
  }
}

/** Runs the selection, the statement under the cursor, or everything, in the front tab. */
export async function runActive(mode: 'statement' | 'all') {
  const tab = activeTab()
  if (!tab || tab.run?.status === 'running') return
  const profile = profileById(tab.profileId)
  if (!profile) {
    say('Pick a database for this tab first.')
    openDialog({ kind: 'switcher' })
    return
  }
  const text = await textToRun(tab, profile, mode)
  if (!text || text.script.trim() === '') return
  await runScript(tab.id, text.script, text.offset, ROW_CAP)
}

/** Runs the front tab's last script again with no row cap. */
export async function runAgainUncapped() {
  const tab = activeTab()
  const run = tab?.run
  if (!tab || !run || run.status === 'running') return
  await runScript(tab.id, run.script, run.offset, null)
}

async function runScript(
  tabId: string,
  script: string,
  offset: number,
  rowCap: number | null,
  confirmed = false,
) {
  const tab = get().tabs.find((t) => t.id === tabId)
  if (!tab) return
  const target = await sessionFor(tab)
  if (!target) return
  const { profile, session } = target
  if (tab.draft && draftSize(tab.draft) > 0) say('The unsaved changes to the last result were discarded.')
  freeResults(tab)
  updateTab(tab.id, {
    view: 'results',
    draft: null,
    run: {
      status: 'running',
      runId: null,
      script,
      offset,
      rowCap,
      starts: [],
      statements: [],
      results: [],
      shown: 0,
      elapsedMs: null,
      error: null,
      errorIndex: null,
      errorAt: null,
    },
  })
  set({ selection: null, message: null })

  try {
    const runId = await ipc.run(
      session.id,
      script,
      rowCap,
      (event) => {
        switch (event.event) {
          case 'statementStarted':
            updateRun(tab.id, (r) => {
              const starts = [...r.starts]
              starts[event.index] = offset + byteToUtf16(script, event.span.start)
              return { starts }
            })
            break
          case 'resultStarted':
            updateRun(tab.id, (r) => ({
              results: [
                ...r.results,
                {
                  index: event.index,
                  resultId: event.resultId,
                  columns: event.columns,
                  rows: 0,
                  done: false,
                  sort: null,
                  version: 0,
                  edit: null,
                },
              ],
              // Follow the newest result while the run is going.
              shown: r.results.length,
              statements: [...r.statements, { index: event.index, resultId: event.resultId, outcome: null }],
            }))
            break
          case 'progress':
            updateResult(tab.id, event.resultId, () => ({ rows: event.rows }))
            break
          case 'statementFinished':
            updateRun(tab.id, (r) => {
              const known = r.statements.some((s) => s.index === event.index)
              const statements = known
                ? r.statements.map((s) => (s.index === event.index ? { ...s, outcome: event.outcome } : s))
                : [...r.statements, { index: event.index, resultId: event.resultId, outcome: event.outcome }]
              const results = r.results.map((res) =>
                res.resultId === event.resultId
                  ? { ...res, rows: event.outcome.rowsReturned, done: true }
                  : res,
              )
              return { statements, results }
            })
            break
          case 'finished':
            updateRun(tab.id, (r) => ({
              status: 'done',
              elapsedMs: event.elapsedMs,
              results: r.results.map((res) => ({ ...res, done: true })),
            }))
            void refreshCounts(tab.id)
            void loadEditTargets(tab.id)
            break
          case 'failed':
            updateRun(tab.id, (r) => {
              const error = event.error
              let errorAt: number | null = null
              if (error.kind === 'query' && error.position !== null && event.index !== null) {
                const start = r.starts[event.index]
                if (start !== undefined) errorAt = start + error.position - 1
              }
              return {
                status: 'failed',
                error,
                errorIndex: event.index,
                errorAt,
                results: r.results.map((res) => ({ ...res, done: true })),
              }
            })
            void refreshCounts(tab.id)
            void loadEditTargets(tab.id)
            break
        }
      },
      { profileId: profile.id, database: tab.database ?? session.database, confirmed },
    )
    updateRun(tab.id, () => ({ runId }))
  } catch (err) {
    if (isQsError(err) && err.kind === 'confirmationNeeded') {
      updateTab(tab.id, { run: null })
      openDialog({
        kind: 'confirmRun',
        message: err.message,
        statements: err.statements,
        run: () => void runScript(tabId, script, offset, rowCap, true),
      })
      return
    }
    updateRun(tab.id, () => ({ status: 'failed', error: isQsError(err) ? err : null }))
    if (!isQsError(err)) say(errorText(err), true)
  }
}

/** Reads every result's final row count, which the last progress event may not have had. */
async function refreshCounts(tabId: string) {
  const run = currentRun(tabId)
  for (const r of run?.results ?? []) {
    try {
      const info = await ipc.resultInfo(r.resultId)
      updateResult(tabId, r.resultId, () => ({ rows: info.rows }))
    } catch {
      // Closed meanwhile.
    }
  }
}

function currentRun(tabId: string): RunState | null {
  return get().tabs.find((t) => t.id === tabId)?.run ?? null
}

export function cancelActive() {
  const run = activeTab()?.run
  if (run?.status === 'running' && run.runId !== null) void ipc.cancelRun(run.runId)
}

/** Shows result `index` of the front tab's run. */
export function showResult(index: number) {
  const tab = activeTab()
  if (tab) updateRun(tab.id, () => ({ shown: index }))
}

/** Sorts a result by a column; `null` restores the order the rows arrived in. */
export async function sortResult(
  tabId: string,
  resultId: number,
  sort: { column: number; direction: SortDirection } | null,
) {
  try {
    await ipc.sortResult(resultId, sort?.column ?? null, sort?.direction)
    updateResult(tabId, resultId, (r) => ({ sort, version: r.version + 1 }))
  } catch (err) {
    say(`Could not sort: ${errorText(err)}`, true)
  }
}

export function setView(view: Tab['view']) {
  const tab = activeTab()
  if (tab) updateTab(tab.id, { view })
}

/** Explains the selection or the statement under the cursor, without running it. */
export async function explainActive() {
  const tab = activeTab()
  if (!tab) return
  const target = await sessionFor(tab)
  if (!target) return
  const text = await textToRun(tab, target.profile, 'statement')
  if (!text || text.script.trim() === '') return
  const sql = text.script
  updateTab(tab.id, { view: 'plan', plan: { status: 'loading', sql } })
  try {
    const plan = await ipc.explain(target.session.id, sql)
    updateTab(tab.id, { plan: { status: 'ready', sql, plan } })
  } catch (err) {
    updateTab(tab.id, { plan: { status: 'failed', sql, error: errorText(err) } })
  }
}

/**
 * Builds the filter bar's query in Rust, where the filter gate checks it,
 * puts it in the editor where it can be read, and runs it.
 */
export async function applyFilter(filter: string) {
  const tab = activeTab()
  const profile = profileById(tab?.profileId ?? null)
  if (!tab?.table || !profile) return
  let sql: string
  try {
    sql = await ipc.filterQuery(profile.engine, tab.table.schema, tab.table.name, filter)
  } catch (err) {
    say(errorText(err), true)
    return
  }
  updateTab(tab.id, { filter, sql, cursor: 0 })
  persistTab({ ...tab, sql }, true)
  await runScript(tab.id, sql, 0, ROW_CAP)
}

// --- Editing ------------------------------------------------------------------

async function loadEditTargets(tabId: string) {
  for (const r of currentRun(tabId)?.results ?? []) {
    try {
      const edit = await ipc.editTarget(r.resultId)
      updateResult(tabId, r.resultId, () => ({ edit }))
    } catch (err) {
      updateResult(tabId, r.resultId, () => ({
        edit: { reason: errorText(err), schema: null, table: null, byPrimaryKey: false, key: [] },
      }))
    }
  }
}

export function draftSize(draft: Draft | null): number {
  if (!draft) return 0
  const deleted = new Set(draft.deletes)
  const updated = Object.keys(draft.updates).filter((row) => !deleted.has(Number(row))).length
  return updated + draft.deletes.length + draft.inserts.length
}

/** The draft as the edits the service takes: updates, then deletes, then inserts. */
export function draftEdits(draft: Draft): RowEdit[] {
  const deleted = new Set(draft.deletes)
  const toValues = (cells: Record<number, string | null>) =>
    Object.entries(cells).map(([column, value]) => ({ column: Number(column), value }))
  return [
    ...Object.entries(draft.updates)
      .filter(([row]) => !deleted.has(Number(row)))
      .map(([row, cells]): RowEdit => ({ kind: 'update', row: Number(row), set: toValues(cells) })),
    ...draft.deletes.map((row): RowEdit => ({ kind: 'delete', row })),
    ...draft.inserts.map((values): RowEdit => ({ kind: 'insert', values: toValues(values) })),
  ]
}

function changeDraft(tabId: string, resultId: number, change: (draft: Draft) => Draft) {
  updateTab(tabId, (t) => {
    const current =
      t.draft?.resultId === resultId ? t.draft : { resultId, updates: {}, deletes: [], inserts: [] }
    const next = change(current)
    return { draft: draftSize(next) === 0 ? null : next }
  })
}

/** Records a new value for a cell; setting it back to `original` forgets the edit. */
export function setCell(
  tabId: string,
  resultId: number,
  row: number,
  column: number,
  value: string | null,
  original: string | null,
) {
  changeDraft(tabId, resultId, (draft) => {
    const cells = { ...(draft.updates[row] ?? {}) }
    if (value === original) delete cells[column]
    else cells[column] = value
    const updates = { ...draft.updates }
    if (Object.keys(cells).length === 0) delete updates[row]
    else updates[row] = cells
    return { ...draft, updates }
  })
}

/** Marks rows for deletion, or unmarks them if they all are. */
export function toggleDeleteRows(tabId: string, resultId: number, rows: number[]) {
  changeDraft(tabId, resultId, (draft) => {
    const marked = new Set(draft.deletes)
    const all = rows.every((r) => marked.has(r))
    for (const r of rows) {
      if (all) marked.delete(r)
      else marked.add(r)
    }
    return { ...draft, deletes: [...marked].sort((a, b) => a - b) }
  })
}

export function addInsert(tabId: string, resultId: number, values: Record<number, string | null>) {
  changeDraft(tabId, resultId, (draft) => ({ ...draft, inserts: [...draft.inserts, values] }))
}

export function removeInsert(tabId: string, resultId: number, index: number) {
  changeDraft(tabId, resultId, (draft) => ({
    ...draft,
    inserts: draft.inserts.filter((_, i) => i !== index),
  }))
}

export function discardDraft(tabId: string) {
  updateTab(tabId, { draft: null })
}

/** Shows the statements the front tab's draft would run, for review. */
export async function reviewDraft() {
  const tab = activeTab()
  const draft = tab?.draft
  if (!tab || !draft) return
  try {
    const statements = await ipc.previewEdits(draft.resultId, draftEdits(draft))
    openDialog({ kind: 'review', tabId: tab.id, statements, error: null, applying: false })
  } catch (err) {
    say(`Those changes cannot be saved: ${errorText(err)}`, true)
  }
}

/** Saves the reviewed draft in one transaction, then shows the rows again. */
export async function applyDraft() {
  const dialog = get().dialog
  if (dialog?.kind !== 'review') return
  const tab = get().tabs.find((t) => t.id === dialog.tabId)
  const draft = tab?.draft
  if (!tab || !draft) return
  set({ dialog: { ...dialog, applying: true, error: null } })
  try {
    const ran = await ipc.applyEdits(draft.resultId, draftEdits(draft))
    updateTab(tab.id, { draft: null })
    closeDialog()
    say(`Saved ${ran.length} change${ran.length === 1 ? '' : 's'}.`)
    const run = tab.run
    // Show the saved rows by running the query again, when it only reads.
    if (
      run &&
      /^\s*(select|table|values)\b/i.test(run.script) &&
      !run.script.trim().replace(/;\s*$/, '').includes(';')
    ) {
      await runScript(tab.id, run.script, run.offset, run.rowCap)
    }
  } catch (err) {
    set({ dialog: { ...dialog, applying: false, error: errorText(err) } })
  }
}

// --- Navigator ----------------------------------------------------------------

export function nodeKey(node: NodeRef): string {
  const base = `c:${node.profileId}`
  switch (node.kind) {
    case 'connection':
      return base
    case 'database':
      return `${base}/d:${node.database}`
    case 'schema':
      return `${base}/d:${node.database}/s:${node.schema}`
    case 'group':
      return `${base}/d:${node.database}/s:${node.schema}/g:${node.group}`
    case 'object':
      return `${base}/d:${node.database}/s:${node.schema}/o:${node.object.kind}:${node.object.name}`
  }
}

function setLoaded(key: string, loaded: Loaded) {
  set((s) => ({ tree: { ...s.tree, [key]: loaded } }))
}

/** Loads what `node` contains, unless it is already loaded (or `force`). */
export async function loadNode(node: NodeRef, force = false) {
  const key = nodeKey(node)
  const current = get().tree[key]
  if (!force && current && current.status !== 'error') return
  if (node.kind === 'group') return
  setLoaded(key, { status: 'loading' })
  try {
    switch (node.kind) {
      case 'connection': {
        const session = await ensureSession(node.profileId, null)
        const listed = await ipc.listDatabases(session.id)
        const databases = listed.length > 0 ? listed : session.database ? [session.database] : []
        setLoaded(key, { status: 'ready', databases })
        break
      }
      case 'database': {
        const session = await ensureSession(node.profileId, node.database)
        setLoaded(key, { status: 'ready', schemas: await ipc.listSchemas(session.id) })
        break
      }
      case 'schema': {
        const session = await ensureSession(node.profileId, node.database)
        setLoaded(key, { status: 'ready', objects: await ipc.listObjects(session.id, node.schema) })
        break
      }
      case 'object': {
        const session = await ensureSession(node.profileId, node.database)
        const columns = await ipc.listColumns(session.id, node.schema, node.object.name)
        setLoaded(key, { status: 'ready', columns })
        break
      }
    }
  } catch (err) {
    setLoaded(key, { status: 'error', error: errorText(err) })
  }
}

export function toggleNode(node: NodeRef) {
  const key = nodeKey(node)
  const open = !get().expanded[key]
  set((s) => ({ expanded: { ...s.expanded, [key]: open } }))
  if (open) void loadNode(node)
}

/** Reloads `node` and forgets what was loaded beneath it. */
export function refreshNode(node: NodeRef) {
  const key = nodeKey(node)
  set((s) => ({
    tree: Object.fromEntries(Object.entries(s.tree).filter(([k]) => !k.startsWith(`${key}/`))),
  }))
  void loadNode(node, true)
}

export function select(selection: Selection | null) {
  set({ selection })
}

export function setFilter(filter: string) {
  set({ filter })
}

// --- Layout and keymap --------------------------------------------------------

export function togglePanel(panel: keyof State['panels']) {
  const panels = { ...get().panels, [panel]: !get().panels[panel] }
  set({ panels })
  void saved.setLayout('panelVisibility', panels).catch(() => {})
}

export function setOverride(id: string, keys: string | null) {
  const overrides = { ...get().overrides }
  if (keys === null) delete overrides[id]
  else overrides[id] = keys
  set({ overrides })
  void saved.setLayout('keymap', overrides).catch(() => {})
}

export function dismissNotice(index: number) {
  set((s) => ({ notices: s.notices.filter((_, i) => i !== index) }))
}
