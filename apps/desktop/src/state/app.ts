// The UI's state and the actions that change it. Components read with
// `useApp(selector)` and call the exported functions; nothing else writes.

import { create } from 'zustand'
import * as ipc from '../ipc/commands'
import type { CatalogEntry, Notice, Profile, ProfileFields } from '../ipc/store'
import * as saved from '../ipc/store'
import type { Column, ColumnInfo, DbObject, QsError, SessionInfo, StatementOutcome } from '../ipc/types'
import type { Overrides } from '../keymap/keymap'
import { type Target, targetKey } from '../lib/target'

/** How many rows a run keeps per statement; the UI says when it stopped there. */
export const ROW_CAP = 1000
/** How many rows the results pane shows. */
export const PREVIEW_ROWS = 200

export type RunState = {
  status: 'running' | 'done' | 'failed'
  runId: number | null
  /** Where the script that ran starts in the editor, for error positions. */
  offset: number
  statements: { index: number; resultId: number | null; outcome: StatementOutcome | null }[]
  resultId: number | null
  columns: Column[]
  rows: (string | null)[][]
  elapsedMs: number | null
  error: QsError | null
  errorIndex: number | null
}

export type Tab = {
  id: string
  title: string
  profileId: string | null
  database: string | null
  sql: string
  cursor: number
  run: RunState | null
}

export type Dialog =
  | null
  | { kind: 'switcher' }
  | { kind: 'goto' }
  | { kind: 'palette' }
  | { kind: 'shortcuts' }
  | { kind: 'connection'; profileId: string | null; pasteUrl?: boolean }

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
  | { kind: 'row'; columns: Column[]; row: (string | null)[] }
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
    id: b.id,
    title: b.title,
    profileId: profiles.some((p) => p.id === b.profileId) ? b.profileId : null,
    database: b.database,
    sql: b.sql,
    cursor: b.cursor,
    run: null,
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

/** Opens a tab on `target` (or the front tab's target) and makes it active. */
export function newTab(target?: Target | null, sql = ''): Tab {
  const front = activeTab()
  const where =
    target === undefined ? (front ? { profileId: front.profileId, database: front.database } : null) : target
  const tab: Tab = {
    id: crypto.randomUUID(),
    title: nextTitle(),
    profileId: where?.profileId ?? null,
    database: where?.database ?? null,
    sql,
    cursor: sql.length,
    run: null,
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
  clearTimeout(saveTimers.get(tab.id))
  const rest = tabs.filter((t) => t.id !== id)
  const next = rest[Math.min(index, rest.length - 1)]
  set((s) => ({
    tabs: rest,
    activeTabId: s.activeTabId === id ? (next?.id ?? null) : s.activeTabId,
    closedTabs: [{ ...tab, run: null }, ...s.closedTabs].slice(0, 20),
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
  for (const s of tab.run?.statements ?? []) {
    if (s.resultId !== null) void ipc.closeResult(s.resultId).catch(() => {})
  }
}

function updateRun(tabId: string, change: (run: RunState) => Partial<RunState>) {
  updateTab(tabId, (t) => (t.run ? { run: { ...t.run, ...change(t.run) } } : {}))
}

/** Runs the statement under the cursor, or the whole editor, in the front tab. */
export async function runActive(mode: 'statement' | 'all') {
  const tab = activeTab()
  if (!tab) return
  if (tab.run?.status === 'running') return
  const profile = profileById(tab.profileId)
  if (!profile) {
    say('Pick a database for this tab first.')
    openDialog({ kind: 'switcher' })
    return
  }
  let script = tab.sql
  let offset = 0
  if (mode === 'statement') {
    const range = await ipc.statementAt(tab.sql, profile.engine, tab.cursor)
    if (!range) return
    script = tab.sql.slice(range.start, range.end)
    offset = range.start
  }
  if (script.trim() === '') return

  let session: SessionInfo
  try {
    session = await ensureSession(profile.id, tab.database)
  } catch (err) {
    if (!(isQsError(err) && err.kind === 'cancelled')) say(errorText(err), true)
    return
  }
  freeResults(tab)
  updateTab(tab.id, {
    run: {
      status: 'running',
      runId: null,
      offset,
      statements: [],
      resultId: null,
      columns: [],
      rows: [],
      elapsedMs: null,
      error: null,
      errorIndex: null,
    },
  })
  set({ selection: null, message: null })

  const finish = async (resultId: number | null) => {
    if (resultId === null) return
    try {
      const page = await ipc.fetchPage(resultId, 0, PREVIEW_ROWS)
      updateRun(tab.id, () => ({ rows: page.rows }))
    } catch (err) {
      say(`Could not read the result: ${errorText(err)}`, true)
    }
  }

  try {
    const runId = await ipc.run(
      session.id,
      script,
      ROW_CAP,
      (event) => {
        switch (event.event) {
          case 'resultStarted':
            updateRun(tab.id, (r) => ({
              resultId: event.resultId,
              columns: event.columns,
              rows: [],
              statements: [...r.statements, { index: event.index, resultId: event.resultId, outcome: null }],
            }))
            break
          case 'statementFinished':
            updateRun(tab.id, (r) => {
              const known = r.statements.some((s) => s.index === event.index)
              const statements = known
                ? r.statements.map((s) => (s.index === event.index ? { ...s, outcome: event.outcome } : s))
                : [...r.statements, { index: event.index, resultId: event.resultId, outcome: event.outcome }]
              return { statements }
            })
            break
          case 'finished':
            updateRun(tab.id, () => ({ status: 'done', elapsedMs: event.elapsedMs }))
            void finish(currentRun(tab.id)?.resultId ?? null)
            break
          case 'failed':
            updateRun(tab.id, () => ({ status: 'failed', error: event.error, errorIndex: event.index }))
            void finish(currentRun(tab.id)?.resultId ?? null)
            break
        }
      },
      { profileId: profile.id, database: tab.database ?? session.database },
    )
    updateRun(tab.id, () => ({ runId }))
  } catch (err) {
    updateRun(tab.id, () => ({ status: 'failed', error: isQsError(err) ? err : null }))
    if (!isQsError(err)) say(errorText(err), true)
  }
}

function currentRun(tabId: string): RunState | null {
  return get().tabs.find((t) => t.id === tabId)?.run ?? null
}

export function cancelActive() {
  const run = activeTab()?.run
  if (run?.status === 'running' && run.runId !== null) void ipc.cancelRun(run.runId)
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
