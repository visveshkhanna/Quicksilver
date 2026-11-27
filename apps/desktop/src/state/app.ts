// The UI's state and the actions that change it. Components read with
// `useApp(selector)` and call the exported functions; nothing else writes.

import { create } from 'zustand'
import { editorHooks, forgetEditor, selectionIn } from '../features/editor/registry'
import { forgetGrids } from '../features/grid/memory'
import { moved, normalPath, parentOf, within } from '../features/navigator/projects'
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
  | { kind: 'connection'; profileId: string | null; pasteUrl?: boolean; project?: string | null }
  | { kind: 'confirmRun'; message: string; statements: string[]; run: () => void }
  | {
      kind: 'review'
      tabId: string
      /** What will be saved: exactly the edits these statements were generated from. */
      edits: RowEdit[]
      statements: string[]
      error: string | null
      applying: boolean
    }
  | {
      kind: 'confirm'
      title: string
      message: string
      confirmLabel: string
      run: () => void
    }
  | { kind: 'insertRow'; tabId: string }
  | {
      kind: 'prompt'
      title: string
      label: string
      initial: string
      confirmLabel: string
      /** Why `value` will not do, or `null` to accept it. */
      check: (value: string) => string | null
      run: (value: string) => void
    }
  | { kind: 'importDbeaver' }

export type PasswordRequest = {
  profile: Profile
  /** Why it is asked again: the last password was refused. */
  error: string | null
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
  /** Project folders kept even while empty, as `/`-joined paths. */
  folders: string[]
  /** Project folders the user closed. */
  collapsedFolders: string[]
  /** The navigator row last picked or revealed, by `nodeKey`. */
  current: string | null
  filter: string
  /** Databases read into the catalog so far, per connection being indexed. */
  indexing: Record<string, { done: number; total: number }>
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
  folders: [],
  collapsedFolders: [],
  current: null,
  filter: '',
  indexing: {},
}

export const useApp = create<State>(() => initial)

const get = useApp.getState
const set = useApp.setState

/** Back to the empty state (tests). */
export function resetApp() {
  set(initial, true)
  pending.clear()
  starting.clear()
  runTokens.clear()
  refocusGrid.clear()
  indexed.clear()
  reindex.clear()
  forgetGrids()
}

// --- Boot -------------------------------------------------------------------

/** Loads everything saved, then marks the app ready. */
export async function boot() {
  const [profiles, catalog, buffers, recent, overrides, panels, notices, folders, collapsedFolders] =
    await Promise.all([
      saved.listProfiles(),
      saved.catalog(),
      saved.buffers(),
      saved.getLayout<string[]>('recentTargets'),
      saved.getLayout<Overrides>('keymap'),
      saved.getLayout<State['panels']>('panelVisibility'),
      saved.storeNotices(),
      saved.getLayout<string[]>('projectFolders'),
      saved.getLayout<string[]>('collapsedFolders'),
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
    folders: folders ?? [],
    collapsedFolders: collapsedFolders ?? [],
  })
}

export function profileById(id: string | null): Profile | undefined {
  return id ? get().profiles.find((p) => p.id === id) : undefined
}

export function isQsError(err: unknown): err is QsError {
  return typeof err === 'object' && err !== null && 'kind' in err
}

/** What an error without a message of its own means, in words. */
const BARE: Record<string, string> = {
  closed: 'The connection was closed, by the server or a network timeout. Run again to reconnect.',
  cancelled: 'Cancelled.',
}

export function errorText(err: unknown): string {
  if (isQsError(err)) return 'message' in err ? err.message : (BARE[err.kind] ?? err.kind)
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

function askPassword(
  profile: Profile,
  error: string | null = null,
): Promise<{ password: string; remember: boolean } | null> {
  return new Promise((resolve) => {
    set({
      passwordRequest: {
        profile,
        error,
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
  const before = id ? profileById(id) : undefined
  set((s) => ({
    profiles: id ? s.profiles.map((p) => (p.id === id ? profile : p)) : [...s.profiles, profile],
  }))
  // Open sessions stay unless something they were opened with changed: a
  // new name, colour or project does not end anyone's query.
  if (before && (password.kind !== 'keep' || connectionChanged(before, profile)))
    await disconnectProfile(before.id)
  return profile
}

/**
 * Imports the chosen DBeaver connections (by candidate key), with their
 * saved passwords going straight to the keychain when `passwords`.
 */
export async function importDbeaver(keys: string[], passwords: boolean) {
  const result = await saved.dbeaverImport(keys, passwords)
  set((s) => ({ profiles: [...s.profiles, ...result.imported] }))
  const n = result.imported.length
  say(
    `Imported ${n} connection${n === 1 ? '' : 's'} from DBeaver` +
      (result.skipped.length > 0 ? `; ${result.skipped.length} could not be.` : '.'),
    result.skipped.length > 0 && n === 0,
  )
  return result
}

// --- Project folders ------------------------------------------------------------

function saveFolders(folders: string[]) {
  const unique = [...new Set(folders)].sort()
  set({ folders: unique })
  void saved.setLayout('projectFolders', unique).catch(() => {})
}

/** Moves a connection into the folder at `project` (`null` for the top level). */
export async function moveProfile(id: string, project: string | null) {
  const profile = profileById(id)
  const to = normalPath(project)
  if (!profile || (profile.project ?? null) === to) return
  const { id: _, createdMs, updatedMs, ...fields } = profile
  try {
    await saveProfile(id, { ...fields, project: to }, { kind: 'keep' })
  } catch (err) {
    say(`Could not move ${profile.name}: ${errorText(err)}`, true)
  }
}

/** Adds an empty folder named `name` inside `parent`. */
export function createFolder(parent: string | null, name: string) {
  const path = normalPath(`${parent ?? ''}/${name}`)
  if (!path) return
  saveFolders([...get().folders, path])
  setFolderOpen(path, true)
  if (parent) setFolderOpen(parent, true)
}

/**
 * Moves the folder at `from` (with everything in it) to `to`: a rename when
 * only the last name differs. Refuses to move a folder into itself.
 */
export async function moveFolder(from: string, to: string | null) {
  if (to !== null && within(to, from)) {
    say('A folder cannot be moved into itself.', true)
    return
  }
  const target = (path: string) => moved(path, from, to)
  saveFolders(
    get()
      .folders.flatMap((f) => (within(f, from) ? [target(f) ?? ''] : [f]))
      .filter(Boolean),
  )
  set((s) => ({
    collapsedFolders: s.collapsedFolders.flatMap((f) => (within(f, from) ? [] : [f])),
  }))
  for (const p of get().profiles) {
    if (within(p.project ?? null, from)) await moveProfile(p.id, target(p.project ?? ''))
  }
}

/** Removes a folder; what was in it moves up to its parent. */
export async function deleteFolder(path: string) {
  const parent = parentOf(path)
  saveFolders(
    get()
      .folders.flatMap((f) => (f === path ? [] : within(f, path) ? [moved(f, path, parent) ?? ''] : [f]))
      .filter(Boolean),
  )
  for (const p of get().profiles) {
    if (within(p.project ?? null, path)) await moveProfile(p.id, moved(p.project ?? '', path, parent))
  }
}

export function setFolderOpen(path: string, open: boolean) {
  const rest = get().collapsedFolders.filter((f) => f !== path)
  const collapsedFolders = open ? rest : [...rest, path]
  set({ collapsedFolders })
  void saved.setLayout('collapsedFolders', collapsedFolders).catch(() => {})
}

function connectionChanged(a: Profile, b: Profile): boolean {
  const strip = ({ name, color, project, createdMs, updatedMs, ...rest }: Profile) => rest
  return JSON.stringify(strip(a)) !== JSON.stringify(strip(b))
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

/** Whether a failed connect was the server refusing the password. */
function refusedPassword(err: unknown): boolean {
  return isQsError(err) && err.kind === 'connect' && /password|authentication failed/i.test(err.message)
}

async function connect(profileId: string, database: string | null): Promise<SessionInfo> {
  const profile = profileById(profileId)
  if (!profile) throw new Error('that connection no longer exists')
  let info: SessionInfo | null = null
  let refused: string | null = null
  try {
    info = await saved.connectProfile(profileId, database)
  } catch (err) {
    const keychain = profile.auth.kind === 'keychain'
    if (!isQsError(err) || !(err.kind === 'passwordNeeded' || (keychain && refusedPassword(err)))) throw err
    if (err.kind !== 'passwordNeeded') refused = `The saved password was refused: ${errorText(err)}`
  }
  // Asked for, and asked again while the server refuses what was typed.
  while (info === null) {
    const answer = await askPassword(profile, refused)
    if (!answer) throw { kind: 'cancelled' } satisfies QsError
    try {
      info = await saved.connectProfile(profileId, database, answer.password)
    } catch (err) {
      if (!refusedPassword(err)) throw err
      refused = errorText(err)
      continue
    }
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

/**
 * Forgets a session the server closed, so the next use connects afresh
 * instead of failing on the dead one again.
 */
export function forgetSession(sessionId: number) {
  void ipc.disconnect(sessionId).catch(() => {})
  set((s) => ({
    sessions: Object.fromEntries(Object.entries(s.sessions).filter(([, info]) => info.id !== sessionId)),
  }))
}

/**
 * Runs a catalog read on a session for `profileId` in `database`. When the
 * session turns out to be closed, it is forgotten and the read tried once
 * more on a new one: reads are safe to repeat.
 */
async function withSession<T>(
  profileId: string,
  database: string | null,
  read: (session: SessionInfo) => Promise<T>,
): Promise<T> {
  const session = await ensureSession(profileId, database)
  try {
    return await read(session)
  } catch (err) {
    if (!isQsError(err) || err.kind !== 'closed') throw err
    forgetSession(session.id)
    return read(await ensureSession(profileId, database))
  }
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

/** When each connection's databases were last read into the catalog, this run. */
const indexed = new Map<string, number>()
/** Connections refreshed by hand: their next search reads every database again. */
const reindex = new Set<string>()
/** How long a database's cached table list is trusted before a search reads it again. */
const INDEX_FRESH_MS = 60 * 60_000

/** When `database`'s tables were last read into the catalog cache, if ever. */
function indexedAt(profileId: string, database: string): number | null {
  let at: number | null = null
  for (const e of get().catalog) {
    if (e.profileId === profileId && e.database === database && e.schema !== null) {
      at = Math.max(at ?? 0, Number(e.refreshedMs))
    }
  }
  return at
}

/**
 * Reads the tables of every database on a connection into the catalog, so
 * `Mod+P` and the navigator filter find them without each database being
 * opened first. Runs in the background two databases at a time, each over a
 * connection that is closed once read; results show up as they arrive. A
 * database read in the last hour (in this run or an earlier one) is not read
 * again, unless `force`.
 */
export async function indexProfile(profileId: string, force = reindex.has(profileId)) {
  const last = indexed.get(profileId)
  if (get().indexing[profileId] || (!force && last !== undefined && Date.now() - last < INDEX_FRESH_MS))
    return
  indexed.set(profileId, Date.now())
  reindex.delete(profileId)
  const progress = (done: number, total: number) =>
    set((s) => ({ indexing: { ...s.indexing, [profileId]: { done, total } } }))
  try {
    const open = Object.entries(get().sessions).find(([k]) => k.startsWith(`${profileId}\u0000`))?.[1]
    const session = open ?? (await ensureSession(profileId, null))
    const listed = await ipc.listDatabases(session.id)
    const all = listed.length > 0 ? listed : session.database ? [session.database] : []
    const now = Date.now()
    const databases = all.filter((d) => {
      const at = indexedAt(profileId, d)
      return force || at === null || now - at > INDEX_FRESH_MS
    })
    if (databases.length === 0) return
    // The connected database first: its tables are the likeliest wanted.
    databases.sort((a, b) => Number(b === session.database) - Number(a === session.database))
    let done = 0
    progress(done, databases.length)
    const queue = [...databases]
    const worker = async () => {
      for (let database = queue.shift(); database !== undefined; database = queue.shift()) {
        // A database this user may not open is skipped; the rest still index.
        await saved.indexDatabase(session.id, profileId, database).catch(() => {})
        progress(++done, databases.length)
        await reloadCatalog()
      }
    }
    await Promise.all([worker(), worker()])
  } catch {
    // Not connected (or the password prompt was dismissed): try again next time.
    indexed.delete(profileId)
  } finally {
    set((s) => {
      const { [profileId]: _, ...rest } = s.indexing
      return { indexing: rest }
    })
  }
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

const saveTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; write: () => Promise<void> }>()

function persistTab(tab: Tab, now = false) {
  const write = () => {
    saveTimers.delete(tab.id)
    const current = get().tabs.find((t) => t.id === tab.id)
    if (!current) return Promise.resolve()
    const position = get().tabs.indexOf(current)
    return saved
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
  clearTimeout(saveTimers.get(tab.id)?.timer)
  if (now) void write()
  else saveTimers.set(tab.id, { timer: setTimeout(write, 400), write })
}

/** Saves every tab whose text is waiting to be saved, at once. */
export async function flushTabs() {
  const waiting = [...saveTimers.values()]
  for (const { timer } of waiting) clearTimeout(timer)
  await Promise.all(waiting.map(({ write }) => write()))
}

/** How many unsaved row changes all tabs hold together. */
export function unsavedChanges(): number {
  return get().tabs.reduce((n, t) => n + draftSize(t.draft), 0)
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
 * Runs `then` at once when tab `tabId` has no unsaved row changes; otherwise
 * asks first, since `then` (`what`, such as "run the query") throws them away.
 */
function unlessDraft(tabId: string, what: string, then: () => void) {
  const tab = get().tabs.find((t) => t.id === tabId)
  const n = draftSize(tab?.draft ?? null)
  if (n === 0) {
    then()
    return
  }
  openDialog({
    kind: 'confirm',
    title: 'Discard unsaved changes?',
    message: `This tab has ${n} unsaved change${n === 1 ? '' : 's'} to its rows. To ${what}, they are discarded.`,
    confirmLabel: 'Discard changes',
    run: () => {
      updateTab(tabId, { draft: null })
      then()
    },
  })
}

/** Whether the selection is a row from a result (rather than a navigator node). */
function forgetRowSelection() {
  if (get().selection?.kind === 'row') set({ selection: null })
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
  forgetRowSelection()
  set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }))
  persistTab(tab, true)
  if (where?.profileId) touchTarget({ profileId: where.profileId, database: where.database })
  return tab
}

/**
 * Shows a table's or view's rows: brings its tab forward if one is open,
 * otherwise opens a tab on it and runs it.
 */
export async function openTable(target: Target, schema: string | null, name: string) {
  const open = get().tabs.find(
    (t) =>
      t.profileId === target.profileId &&
      t.database === target.database &&
      t.table?.schema === schema &&
      t.table?.name === name,
  )
  if (open) {
    activateTab(open.id)
    return
  }
  const profile = profileById(target.profileId)
  if (!profile) return
  let sql: string
  try {
    sql = await ipc.filterQuery(profile.engine, schema, name, '')
  } catch (err) {
    say(errorText(err), true)
    return
  }
  const tab = newTab(target, sql, { schema, name })
  await runScript(tab.id, sql, 0, ROW_CAP)
}

export function activateTab(id: string) {
  if (id !== get().activeTabId) forgetRowSelection()
  set({ activeTabId: id })
}

export function jumpToTab(index: number) {
  const tab = get().tabs[index]
  if (tab) activateTab(tab.id)
}

/** Closes tab `id`, asking first when it has unsaved row changes. */
export function closeTab(id = get().activeTabId) {
  if (id) unlessDraft(id, 'close the tab', () => closeNow(id))
}

function closeNow(id: string) {
  const tabs = get().tabs
  const index = tabs.findIndex((t) => t.id === id)
  const tab = tabs[index]
  if (!tab) return
  // A run still starting has no id yet; dropping its token makes it stop itself.
  runTokens.delete(tab.id)
  if (tab.run?.status === 'running' && tab.run.runId !== null) void ipc.cancelRun(tab.run.runId)
  freeResults(tab)
  forgetRowSelection()
  forgetEditor(tab.id)
  clearTimeout(saveTimers.get(tab.id)?.timer)
  const rest = tabs.filter((t) => t.id !== id)
  const next = rest[Math.min(index, rest.length - 1)]
  set((s) => ({
    tabs: rest,
    activeTabId: s.activeTabId === id ? (next?.id ?? null) : s.activeTabId,
    closedTabs: [
      { ...tab, run: null, plan: null, draft: null, view: 'results' as const },
      ...s.closedTabs,
    ].slice(0, 20),
  }))
  void saved.deleteBuffer(tab.id).catch(() => {})
}

export function reopenTab() {
  const [tab, ...rest] = get().closedTabs
  if (!tab) return
  const restored = { ...tab, title: get().tabs.some((t) => t.title === tab.title) ? nextTitle() : tab.title }
  forgetRowSelection()
  set((s) => ({ tabs: [...s.tabs, restored], activeTabId: restored.id, closedTabs: rest }))
  persistTab(restored, true)
}

export function setTabText(id: string, sql: string, cursor: number) {
  updateTab(id, { sql, cursor })
  // The editor drops an error's underline once the text changes; forget it
  // too, or it would come back at the old place when the editor remounts.
  updateTab(id, (t) => (t.run?.errorAt != null ? { run: { ...t.run, errorAt: null } } : {}))
  const tab = get().tabs.find((t) => t.id === id)
  if (tab) persistTab(tab)
}

export function setTabCursor(id: string, cursor: number) {
  updateTab(id, { cursor })
}

/**
 * Points tab `id` (or a new tab when there is none) at `target`. Results
 * from the old target are put away, so nothing on screen (or saved from the
 * edit bar) belongs to a database the tab no longer points at.
 */
export function retarget(target: Target, id = get().activeTabId) {
  const tab = get().tabs.find((t) => t.id === id)
  if (!tab) {
    newTab(target)
    return
  }
  if (tab.profileId === target.profileId && tab.database === target.database) return
  if (tab.run?.status === 'running') {
    say('Cancel the running query before switching this tab to another database.')
    return
  }
  unlessDraft(tab.id, 'switch database', () => {
    const current = get().tabs.find((t) => t.id === tab.id)
    if (!current) return
    freeResults(current)
    updateTab(tab.id, { run: null, plan: null, draft: null })
    forgetRowSelection()
    updateTab(tab.id, { profileId: target.profileId, database: target.database })
    persistTab({ ...current, ...target }, true)
    touchTarget(target)
  })
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

/**
 * The tab's session, connecting if needed. A failure to connect is shown in
 * the tab's results, where the user is looking, not only in the status bar.
 */
async function sessionFor(tab: Tab): Promise<{ profile: Profile; session: SessionInfo } | null> {
  const profile = profileById(tab.profileId)
  if (!profile) {
    say('Pick a database for this tab first.')
    openDialog({ kind: 'switcher' })
    return null
  }
  try {
    if (!get().sessions[targetKey(profile.id, tab.database)]) say(`Connecting to ${profile.name}…`)
    const session = await ensureSession(profile.id, tab.database)
    if (get().message?.text.startsWith('Connecting to ')) set({ message: null })
    return { profile, session }
  } catch (err) {
    if (get().message?.text.startsWith('Connecting to ')) set({ message: null })
    if (isQsError(err) && err.kind === 'cancelled') return null
    const error: QsError = isQsError(err) ? err : { kind: 'internal', message: errorText(err) }
    if (tab.run) freeResults(tab)
    updateTab(tab.id, {
      view: 'results',
      run: {
        status: 'failed',
        runId: null,
        script: '',
        offset: 0,
        rowCap: null,
        starts: [],
        statements: [],
        results: [],
        shown: 0,
        elapsedMs: null,
        error: { kind: 'connect', message: `Could not connect to ${profile.name}: ${errorText(error)}` },
        errorIndex: null,
        errorAt: null,
      },
    })
    return null
  }
}

/** Runs the selection, the statement under the cursor, or everything, in the front tab. */
export async function runActive(mode: 'statement' | 'all') {
  const tab = activeTab()
  if (!tab || busy(tab)) return
  const profile = profileById(tab.profileId)
  if (!profile) {
    say('Pick a database for this tab first.')
    openDialog({ kind: 'switcher' })
    return
  }
  let text: { script: string; offset: number } | null
  try {
    text = await textToRun(tab, profile, mode)
  } catch (err) {
    say(errorText(err), true)
    return
  }
  if (!text || text.script.trim() === '') {
    say(mode === 'all' ? 'There is nothing to run.' : 'There is no statement at the cursor to run.')
    return
  }
  const { script, offset } = text
  // Show which statement runs: with the cursor between two, it may not be obvious.
  if (mode === 'statement' && !selectionIn(tab.id)) editorHooks.flash(tab.id, offset, offset + script.length)
  unlessDraft(tab.id, 'run the query', () => void runScript(tab.id, script, offset, ROW_CAP))
}

/** Runs the front tab's last script again with no row cap. */
export async function runAgainUncapped() {
  const tab = activeTab()
  const run = tab?.run
  if (!tab || !run || busy(tab)) return
  unlessDraft(tab.id, 'run the query again', () => void runScript(tab.id, run.script, run.offset, null))
}

/** Runs the front tab's last script again as it was (or, when it never started, the statement at the cursor). */
export async function runAgain() {
  const tab = activeTab()
  const run = tab?.run
  if (!tab || !run || busy(tab)) return
  if (run.script === '') {
    await runActive('statement')
    return
  }
  unlessDraft(tab.id, 'run the query again', () => void runScript(tab.id, run.script, run.offset, run.rowCap))
}

/**
 * Each tab's current run, by a token made when it starts. Events from a run
 * whose token is no longer the tab's (the tab closed, or ran again) are
 * dropped, and their results closed.
 */
const runTokens = new Map<string, symbol>()

/** Tabs whose run is connecting, before it shows as running. */
const starting = new Set<string>()

/** Whether a run in `tab` is starting (connecting) or going; says so if it is. */
function busy(tab: Tab): boolean {
  if (starting.has(tab.id) || tab.run?.status === 'running') {
    say('A query is already running in this tab.')
    return true
  }
  return false
}

/** Tabs whose grid had focus when a new run replaced it; the new grid takes focus. */
export const refocusGrid = new Set<string>()

async function runScript(
  tabId: string,
  script: string,
  offset: number,
  rowCap: number | null,
  confirmed = false,
) {
  const tab = get().tabs.find((t) => t.id === tabId)
  if (!tab || busy(tab)) return
  const token = Symbol(tabId)
  runTokens.set(tabId, token)
  const live = () => runTokens.get(tabId) === token
  starting.add(tabId)
  const target = await sessionFor(tab).finally(() => starting.delete(tabId))
  if (!target || !live()) return
  const { profile, session } = target
  // Kept until the server accepts the script: a schema change it asks about
  // leaves these results in place if the user declines.
  const previous = get().tabs.find((t) => t.id === tabId)?.run ?? null
  if (document.activeElement?.closest('[role="grid"]')) refocusGrid.add(tabId)
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
  forgetRowSelection()
  set({ message: null })

  try {
    const runId = await ipc.run(
      session.id,
      script,
      rowCap,
      (event) => {
        if (!live()) {
          if (event.event === 'resultStarted') void ipc.closeResult(event.resultId).catch(() => {})
          return
        }
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
            if (event.error.kind === 'closed') forgetSession(session.id)
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
    if (previous) freeResults({ ...tab, run: previous })
    if (!live()) {
      // The tab closed while the run was starting.
      void ipc.cancelRun(runId).catch(() => {})
      return
    }
    updateRun(tab.id, () => ({ runId }))
  } catch (err) {
    refocusGrid.delete(tabId)
    if (isQsError(err) && err.kind === 'confirmationNeeded') {
      updateTab(tab.id, { run: previous })
      openDialog({
        kind: 'confirmRun',
        message: err.message,
        statements: err.statements,
        run: () => void runScript(tabId, script, offset, rowCap, true),
      })
      return
    }
    if (isQsError(err) && err.kind === 'closed') forgetSession(session.id)
    if (previous) freeResults({ ...tab, run: previous })
    updateRun(tab.id, () => ({
      status: 'failed',
      error: isQsError(err) ? err : { kind: 'internal', message: errorText(err) },
    }))
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
  let text: { script: string; offset: number } | null
  try {
    text = await textToRun(tab, target.profile, 'statement')
  } catch (err) {
    say(errorText(err), true)
    return
  }
  if (!text || text.script.trim() === '') {
    say('There is no statement at the cursor to explain.')
    return
  }
  if (!selectionIn(tab.id)) editorHooks.flash(tab.id, text.offset, text.offset + text.script.length)
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
  if (!tab?.table || !profile || busy(tab)) return
  let sql: string
  try {
    sql = await ipc.filterQuery(profile.engine, tab.table.schema, tab.table.name, filter)
  } catch (err) {
    say(errorText(err), true)
    return
  }
  unlessDraft(tab.id, 'filter the rows', () => {
    updateTab(tab.id, { filter, sql, cursor: 0 })
    persistTab({ ...tab, sql }, true)
    void runScript(tab.id, sql, 0, ROW_CAP)
  })
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
  const held = get().tabs.find((t) => t.id === tabId)?.draft
  if (held && held.resultId !== resultId && draftSize(held) > 0) {
    // One draft per tab: another statement's changes are waiting.
    say('Save or discard the changes to the other result first.', true)
    return
  }
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

/** Discards a tab's unsaved row changes, once the user agrees. */
export function askDiscardDraft(tabId: string) {
  const n = draftSize(get().tabs.find((t) => t.id === tabId)?.draft ?? null)
  if (n === 0) return
  openDialog({
    kind: 'confirm',
    title: 'Discard unsaved changes?',
    message: `${n} change${n === 1 ? '' : 's'} to this result's rows will be lost. Nothing has been sent to the database.`,
    confirmLabel: 'Discard changes',
    run: () => discardDraft(tabId),
  })
}

/** Takes one reviewed change back out of the draft, and reviews what is left. */
export async function dropEdit(tabId: string, edit: RowEdit, index: number) {
  const draft = get().tabs.find((t) => t.id === tabId)?.draft
  if (!draft) return
  if (edit.kind === 'update') {
    changeDraft(tabId, draft.resultId, (d) => {
      const updates = { ...d.updates }
      delete updates[edit.row]
      return { ...d, updates }
    })
  } else if (edit.kind === 'delete') {
    toggleDeleteRows(tabId, draft.resultId, [edit.row])
  } else {
    // Inserts come last, in draft order.
    const first = draftEdits(draft).length - draft.inserts.length
    removeInsert(tabId, draft.resultId, index - first)
  }
  await reviewDraft()
}

/** Shows the statements the front tab's draft would run, for review. */
export async function reviewDraft() {
  // A cell still being edited is kept first, so the review shows it.
  document.querySelector<HTMLElement>('[data-cell-editor]')?.blur()
  const tab = activeTab()
  const draft = tab?.draft
  if (!tab || !draft) {
    if (get().dialog?.kind === 'review') closeDialog()
    return
  }
  try {
    const edits = draftEdits(draft)
    const statements = await ipc.previewEdits(draft.resultId, edits)
    openDialog({ kind: 'review', tabId: tab.id, edits, statements, error: null, applying: false })
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
    // Exactly what was reviewed, even if the draft changed behind the dialog.
    const ran = await ipc.applyEdits(draft.resultId, dialog.edits)
    updateTab(tab.id, { draft: null })
    closeDialog()
    const saved = `Saved ${ran.length} change${ran.length === 1 ? '' : 's'}.`
    const run = tab.run
    // Show the saved rows by running the query again, when it only reads.
    if (
      run &&
      /^\s*(select|table|values)\b/i.test(run.script) &&
      !run.script.trim().replace(/;\s*$/, '').includes(';')
    ) {
      await runScript(tab.id, run.script, run.offset, run.rowCap)
      say(saved)
    } else {
      say(`${saved} Run the query again to see them.`)
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
        // Any open session on the connection can list its databases.
        const open = Object.entries(get().sessions).find(([k]) =>
          k.startsWith(`${node.profileId}\u0000`),
        )?.[1]
        let session = open ?? (await ensureSession(node.profileId, null))
        let listed: string[]
        try {
          listed = await ipc.listDatabases(session.id)
        } catch (err) {
          if (!isQsError(err) || err.kind !== 'closed') throw err
          forgetSession(session.id)
          session = await ensureSession(node.profileId, null)
          listed = await ipc.listDatabases(session.id)
        }
        const databases = listed.length > 0 ? listed : session.database ? [session.database] : []
        setLoaded(key, { status: 'ready', databases })
        break
      }
      case 'database': {
        const schemas = await withSession(node.profileId, node.database, (session) =>
          ipc.listSchemas(session.id),
        )
        setLoaded(key, { status: 'ready', schemas })
        break
      }
      case 'schema': {
        const objects = await withSession(node.profileId, node.database, (session) =>
          ipc.listObjects(session.id, node.schema),
        )
        setLoaded(key, { status: 'ready', objects })
        break
      }
      case 'object': {
        const columns = await withSession(node.profileId, node.database, (session) =>
          ipc.listColumns(session.id, node.schema, node.object.name),
        )
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
  // The next search reads the connection's databases again.
  if (node.kind === 'connection') {
    indexed.delete(node.profileId)
    reindex.add(node.profileId)
  }
  set((s) => ({
    tree: Object.fromEntries(Object.entries(s.tree).filter(([k]) => !k.startsWith(`${key}/`))),
  }))
  void loadNode(node, true)
}

export function select(selection: Selection | null) {
  if (selection?.kind === 'node') set({ selection, current: nodeKey(selection.node) })
  else set({ selection })
}

const GROUP_OF: Record<DbObject['kind'], ObjectGroup> = {
  table: 'tables',
  foreignTable: 'tables',
  view: 'views',
  materializedView: 'views',
  function: 'functions',
  procedure: 'functions',
  sequence: 'sequences',
}

/**
 * Shows a connection, database, schema or object in the navigator: opens
 * the panel, expands (and loads) each level above it, highlights it and
 * scrolls it into view. Clears a filter that could hide it.
 */
export async function reveal(node: NodeRef) {
  if (!get().panels.navigator) togglePanel('navigator')
  if (get().filter !== '') setFilter('')
  const path: NodeRef[] = [{ kind: 'connection', profileId: node.profileId }]
  if (node.kind !== 'connection')
    path.push({ kind: 'database', profileId: node.profileId, database: node.database })
  if (node.kind === 'schema' || node.kind === 'group' || node.kind === 'object') {
    path.push({ kind: 'schema', profileId: node.profileId, database: node.database, schema: node.schema })
  }
  if (node.kind === 'object') {
    path.push({
      kind: 'group',
      profileId: node.profileId,
      database: node.database,
      schema: node.schema,
      group: GROUP_OF[node.object.kind] ?? 'tables',
    })
  }
  const key = nodeKey(node)
  set({ current: key })
  // One session in the node's own database lists everything above it too.
  if (node.kind !== 'connection') {
    try {
      await ensureSession(node.profileId, node.database)
    } catch {
      // Each level below reports its own error.
    }
  }
  for (const level of path) {
    set((s) => ({ expanded: { ...s.expanded, [nodeKey(level)]: true } }))
    await loadNode(level)
  }
  scrollToNode(key)
}

/** Scrolls the navigator row for `key` into view once it is drawn. */
function scrollToNode(key: string, tries = 10) {
  const row = document.querySelector<HTMLElement>(`[data-node-key="${CSS.escape(key)}"]`)
  if (row) {
    row.scrollIntoView?.({ block: 'nearest' })
    return
  }
  if (tries > 0) requestAnimationFrame(() => scrollToNode(key, tries - 1))
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
