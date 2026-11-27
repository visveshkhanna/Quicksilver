import * as Menu from '@radix-ui/react-context-menu'
import { type DragEvent, type HTMLAttributes, type ReactNode, useEffect, useState } from 'react'
import { Icon, type IconName } from '../../app/icons'
import { shortcutLabel } from '../../app/Kbd'
import { DropItem, DropMenu, MenuItem as Item, MenuContent, MenuSeparator as Separator } from '../../app/menu'
import { Button, ColorDot } from '../../app/ui'
import * as ipc from '../../ipc/commands'
import { dbeaverScan, type Profile } from '../../ipc/store'
import type { ColumnInfo, DbObject } from '../../ipc/types'
import { keysFor } from '../../keymap/keymap'
import { copyText } from '../../lib/clipboard'
import {
  askDisconnect,
  createFolder,
  deleteFolder,
  deleteProfile,
  ensureSession,
  errorText,
  indexProfile,
  isConnected,
  type Loaded,
  moveFolder,
  moveProfile,
  type NodeRef,
  newTab,
  nodeKey,
  type ObjectGroup,
  openDialog,
  openTable,
  refreshNode,
  retarget,
  type State,
  say,
  select,
  setFilter,
  setFolderOpen,
  toggleNode,
  useApp,
} from '../../state/app'
import {
  allPaths,
  badFolderName,
  buildTree,
  countIn,
  type Folder,
  MAX_DEPTH,
  nameOf,
  normalPath,
  parentOf,
  splitPath,
} from './projects'

const GROUPS: { group: ObjectGroup; title: string; kinds: DbObject['kind'][] }[] = [
  { group: 'tables', title: 'Tables', kinds: ['table', 'foreignTable'] },
  { group: 'views', title: 'Views', kinds: ['view', 'materializedView'] },
  { group: 'functions', title: 'Functions', kinds: ['function', 'procedure'] },
  { group: 'sequences', title: 'Sequences', kinds: ['sequence'] },
]

const ICONS: Record<DbObject['kind'], IconName> = {
  table: 'table',
  foreignTable: 'table',
  view: 'view',
  materializedView: 'view',
  function: 'function',
  procedure: 'function',
  sequence: 'sequence',
}

const OPENABLE = new Set<DbObject['kind']>(['table', 'view', 'materializedView', 'foreignTable'])

function copy(text: string) {
  copyText(text).then(
    () => say(`Copied ${text}`),
    (err) => say(`Could not copy: ${errorText(err)}`, true),
  )
}

/** Copies the SQL that creates an object, as the server describes it. */
async function copyDdl(profileId: string, database: string, schema: string, object: DbObject) {
  const ddl = ensureSession(profileId, database).then((session) =>
    ipc.objectDdl(session.id, schema, object.name, object.kind),
  )
  try {
    await copyText(ddl)
    say(`Copied the DDL for ${object.name}`)
  } catch (err) {
    say(`Could not copy the DDL: ${errorText(err)}`, true)
  }
}

// --- What the tree shows -------------------------------------------------------

type View = {
  /** What each node holds: loaded in this run, or else read from the catalog cache. */
  tree: Record<string, Loaded>
  /** With a filter: every node that holds, at any depth, a name that passes it. */
  matches: Set<string>
}

let memo: { tree: State['tree']; catalog: State['catalog']; filter: string; view: View } | null = null

/**
 * The tree as the navigator draws it. Databases and schemas never opened in
 * this run are filled from the catalog cache, which `indexProfile` keeps, so
 * the filter finds tables in any database without opening each one.
 */
function navView(s: State): View {
  if (memo && memo.tree === s.tree && memo.catalog === s.catalog && memo.filter === s.filter) return memo.view
  const tree: Record<string, Loaded> = {}
  const ready = (key: string) => {
    let node = tree[key]
    if (node?.status !== 'ready') {
      node = { status: 'ready' }
      tree[key] = node
    }
    return node
  }
  const add = (list: string[] | undefined, name: string) =>
    list?.includes(name) ? list : [...(list ?? []), name]
  for (const e of s.catalog) {
    const conn = `c:${e.profileId}`
    const db = `${conn}/d:${e.database}`
    const c = ready(conn)
    c.databases = add(c.databases, e.database)
    if (!e.schema) continue
    const d = ready(db)
    d.schemas = add(d.schemas, e.schema)
    if (!e.name) continue
    const sc = ready(`${db}/s:${e.schema}`)
    sc.objects = [...(sc.objects ?? []), { name: e.name, kind: e.kind as DbObject['kind'] }]
  }
  for (const [key, loaded] of Object.entries(s.tree)) {
    // While a node reloads, the cached names stay on show.
    if (loaded.status !== 'loading' || !tree[key]) tree[key] = loaded
  }
  const matches = new Set<string>()
  if (s.filter !== '') {
    for (const [key, loaded] of Object.entries(tree)) {
      if (loaded.status !== 'ready') continue
      const names = [
        ...(loaded.databases ?? []),
        ...(loaded.schemas ?? []),
        ...(loaded.objects ?? []).map((o) => o.name),
        ...(loaded.columns ?? []).map((c) => c.name),
      ]
      if (!names.some((n) => passes(n, s.filter))) continue
      const parts = key.split('/')
      for (let i = 1; i <= parts.length; i++) matches.add(parts.slice(0, i).join('/'))
    }
  }
  const view = { tree, matches }
  memo = { tree: s.tree, catalog: s.catalog, filter: s.filter, view }
  return view
}

const useView = () => useApp(navView)

/** Whether `name` passes the filter. */
function passes(name: string, filter: string): boolean {
  return filter === '' || name.toLowerCase().includes(filter.toLowerCase())
}

function profileVisible(profile: Profile, filter: string, matches: Set<string>): boolean {
  return passes(profile.name, filter) || matches.has(`c:${profile.id}`)
}

function folderVisible(folder: Folder, filter: string, matches: Set<string>): boolean {
  return (
    filter === '' ||
    passes(folder.name, filter) ||
    folder.profiles.some((p) => profileVisible(p, filter, matches)) ||
    folder.folders.some((f) => folderVisible(f, filter, matches))
  )
}

// --- Folders and moving --------------------------------------------------------

const PROFILE_TYPE = 'application/x-quicksilver-connection'
const FOLDER_TYPE = 'application/x-quicksilver-folder'

function dragged(e: DragEvent): { profile?: string; folder?: string } | null {
  const types = e.dataTransfer.types
  if (types.includes(PROFILE_TYPE)) return { profile: e.dataTransfer.getData(PROFILE_TYPE) }
  if (types.includes(FOLDER_TYPE)) return { folder: e.dataTransfer.getData(FOLDER_TYPE) }
  return null
}

/** Drops a dragged connection or folder into `target` (`null`: the top level). */
function dropInto(e: DragEvent, target: string | null) {
  const what = dragged(e)
  if (!what) return
  e.preventDefault()
  e.stopPropagation()
  if (what.profile) void moveProfile(what.profile, target)
  else if (what.folder) {
    const to = normalPath(`${target ?? ''}/${nameOf(what.folder)}`)
    if (to !== what.folder && parentOf(what.folder) !== target)
      void moveFolder(what.folder, target === null ? nameOf(what.folder) : to)
  }
}

/** Handlers that make an element a drop target, lit while something is over it. */
function useDropTarget(target: string | null) {
  const [over, setOver] = useState(false)
  const handlers: HTMLAttributes<HTMLElement> = {
    onDragOver: (e) => {
      const types = e.dataTransfer.types
      if (!types.includes(PROFILE_TYPE) && !types.includes(FOLDER_TYPE)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      setOver(true)
    },
    onDragLeave: () => setOver(false),
    onDrop: (e) => {
      setOver(false)
      dropInto(e, target)
    },
  }
  return { over, handlers }
}

/** Why `path` cannot be used for a new or renamed folder: one is there already. */
function taken(path: string | null): string | null {
  const { profiles, folders } = useApp.getState()
  const paths = allPaths(buildTree(profiles, folders))
  return path && paths.some((p) => p.toLowerCase() === path.toLowerCase())
    ? `There is already a folder named ${nameOf(path)} there.`
    : null
}

function askFolderName(parent: string | null) {
  openDialog({
    kind: 'prompt',
    title: parent ? `New folder in ${nameOf(parent)}` : 'New folder',
    label: 'Name',
    initial: '',
    confirmLabel: 'Create',
    check: (name) => {
      if (splitPath(parent).length >= MAX_DEPTH) return `Folders nest at most ${MAX_DEPTH} deep.`
      return badFolderName(name) ?? taken(normalPath(`${parent ?? ''}/${name}`))
    },
    run: (name) => createFolder(parent, name),
  })
}

function askRename(path: string) {
  openDialog({
    kind: 'prompt',
    title: `Rename ${nameOf(path)}`,
    label: 'Name',
    initial: nameOf(path),
    confirmLabel: 'Rename',
    check: (name) => {
      const to = normalPath(`${parentOf(path) ?? ''}/${name}`)
      return badFolderName(name) ?? (to === path ? null : taken(to))
    },
    run: (name) => void moveFolder(path, normalPath(`${parentOf(path) ?? ''}/${name}`)),
  })
}

function askMove(profile: Profile) {
  const { profiles, folders: saved } = useApp.getState()
  openDialog({
    kind: 'prompt',
    title: `Move ${profile.name}`,
    label: 'Folder (nest with "/"; leave empty for the top level)',
    initial: profile.project ?? '',
    confirmLabel: 'Move',
    suggestions: allPaths(buildTree(profiles, saved)),
    check: (path) => (splitPath(path).length > MAX_DEPTH ? `Folders nest at most ${MAX_DEPTH} deep.` : null),
    run: (path) => void moveProfile(profile.id, normalPath(path)),
  })
}

// --- The panel -------------------------------------------------------------------

/**
 * The left navigator: every saved connection, in nested project folders,
 * expanding lazily to databases, schemas, objects and columns.
 */
export function Navigator() {
  const profiles = useApp((s) => s.profiles)
  const folders = useApp((s) => s.folders)
  const filter = useApp((s) => s.filter)
  const root = buildTree(profiles, folders)
  const { over, handlers } = useDropTarget(null)
  const filterKeys = useApp((s) => shortcutLabel(keysFor('focus-navigator', s.overrides)))
  const { matches } = useView()
  const nothing =
    filter !== '' &&
    !root.profiles.some((p) => profileVisible(p, filter, matches)) &&
    !root.folders.some((f) => folderVisible(f, filter, matches))

  // A search reads the tables of every database on connected connections.
  useEffect(() => {
    if (filter === '') return
    const timer = setTimeout(() => {
      for (const p of useApp.getState().profiles) if (isConnected(p.id)) void indexProfile(p.id)
    }, 300)
    return () => clearTimeout(timer)
  }, [filter])
  const reading = useApp((s) => Object.keys(s.indexing).length > 0)

  return (
    <nav className="flex h-full flex-col bg-panel" aria-label="Connections">
      <div className="flex items-center gap-2 border-b border-border p-2">
        <input
          id="navigator-filter"
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setFilter('')
              e.currentTarget.blur()
            }
          }}
          placeholder={`Filter…${filterKeys ? `  ${filterKeys}` : ''}`}
          aria-label="Filter connections"
          className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 outline-none focus:border-accent"
        />
        <DropMenu
          trigger={
            <button
              type="button"
              title="Add a connection or folder"
              aria-label="Add"
              className="rounded px-1.5 text-[16px] leading-none text-muted hover:bg-raised hover:text-fg"
            >
              +
            </button>
          }
        >
          <DropItem onSelect={() => openDialog({ kind: 'connection', profileId: null })}>
            New connection…
          </DropItem>
          <DropItem onSelect={() => openDialog({ kind: 'connection', profileId: null, pasteUrl: true })}>
            New connection from a URL…
          </DropItem>
          <DropItem onSelect={() => askFolderName(null)}>New folder…</DropItem>
          <DropItem onSelect={() => openDialog({ kind: 'importDbeaver' })}>Import from DBeaver…</DropItem>
        </DropMenu>
      </div>
      {filter !== '' && reading && (
        <p role="status" className="m-0 border-b border-border px-3 py-1 text-[11px] text-muted">
          Reading tables from every database…
        </p>
      )}
      {profiles.length === 0 && folders.length === 0 ? (
        <FirstRun />
      ) : (
        <div
          role="tree"
          aria-label="Connections"
          className={`min-h-0 flex-1 overflow-auto py-1 ${over ? 'bg-accent/5' : ''}`}
          {...handlers}
        >
          <FolderContents folder={root} depth={0} />
          {nothing && (
            <div className="flex flex-col items-center gap-2 p-4 text-center text-muted">
              <p className="m-0">Nothing matches “{filter}”.</p>
              <button type="button" className="text-accent hover:underline" onClick={() => setFilter('')}>
                Clear the filter
              </button>
            </div>
          )}
        </div>
      )}
    </nav>
  )
}

/** The empty navigator: ways to add the first connection, DBeaver's first when it has some. */
function FirstRun() {
  const [fromDbeaver, setFromDbeaver] = useState(0)
  useEffect(() => {
    dbeaverScan()
      .then((scan) =>
        setFromDbeaver(scan.candidates.filter((c) => c.skipped === null && !c.alreadyImported).length),
      )
      .catch(() => {})
  }, [])
  const importButton = (
    <Button
      kind={fromDbeaver > 0 ? 'primary' : 'plain'}
      onClick={() => openDialog({ kind: 'importDbeaver' })}
    >
      {fromDbeaver > 0
        ? `Import ${fromDbeaver} connection${fromDbeaver === 1 ? '' : 's'} from DBeaver`
        : 'Import from DBeaver'}
    </Button>
  )
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center text-muted [&_button]:w-full [&_button]:max-w-60">
      <p className="m-0">No connections yet.</p>
      {fromDbeaver > 0 && importButton}
      <Button
        kind={fromDbeaver > 0 ? 'plain' : 'primary'}
        onClick={() => openDialog({ kind: 'connection', profileId: null })}
      >
        New connection
      </Button>
      <Button onClick={() => openDialog({ kind: 'connection', profileId: null, pasteUrl: true })}>
        Paste a URL
      </Button>
      {fromDbeaver === 0 && importButton}
    </div>
  )
}

function FolderContents({ folder, depth }: { folder: Folder; depth: number }) {
  return (
    <>
      {folder.folders.map((f) => (
        <FolderNode key={f.path} folder={f} depth={depth} />
      ))}
      {folder.profiles.map((p) => (
        <ConnectionNode key={p.id} profile={p} depth={depth} />
      ))}
    </>
  )
}

function FolderNode({ folder, depth }: { folder: Folder; depth: number }) {
  const filter = useApp((s) => s.filter)
  const { matches } = useView()
  const collapsed = useApp((s) => s.collapsedFolders.includes(folder.path))
  const { over, handlers } = useDropTarget(folder.path)
  if (!folderVisible(folder, filter, matches)) return null
  const open = filter !== '' || !collapsed
  const toggle = () => setFolderOpen(folder.path, !open)
  return (
    <>
      <Menu.Root>
        <Menu.Trigger asChild>
          <div
            role="treeitem"
            aria-expanded={open}
            aria-selected={false}
            tabIndex={0}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(FOLDER_TYPE, folder.path)
              e.dataTransfer.effectAllowed = 'move'
            }}
            onClick={toggle}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || (e.key === 'ArrowRight' && !open) || (e.key === 'ArrowLeft' && open))
                toggle()
              else arrowFocus(e)
            }}
            {...handlers}
            className={`flex cursor-default items-center gap-1.5 py-[3px] pr-2 font-medium outline-none focus-visible:bg-accent/10 data-[state=open]:shadow-[inset_0_0_0_1px_var(--color-accent)] ${
              over ? 'bg-accent/20' : 'hover:bg-raised'
            }`}
            style={{ paddingLeft: 6 + depth * 14 }}
          >
            <span className="w-3 shrink-0 text-center text-[10px] text-muted">{open ? '▾' : '▸'}</span>
            <Icon name="folder" className="text-muted" />
            <span className="truncate">{folder.name}</span>
            <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted">{countIn(folder)}</span>
          </div>
        </Menu.Trigger>
        <MenuContent>
          <Item onSelect={() => openDialog({ kind: 'connection', profileId: null, project: folder.path })}>
            New connection here…
          </Item>
          <Item onSelect={() => askFolderName(folder.path)}>New folder inside…</Item>
          <Separator />
          <Item onSelect={() => askRename(folder.path)}>Rename…</Item>
          {parentOf(folder.path) !== null && (
            <Item onSelect={() => void moveFolder(folder.path, nameOf(folder.path))}>
              Move to the top level
            </Item>
          )}
          <Separator />
          <Item
            danger
            onSelect={() =>
              openDialog({
                kind: 'confirm',
                title: `Delete the folder ${folder.name}?`,
                message:
                  countIn(folder) === 0
                    ? 'It is empty.'
                    : `Its ${countIn(folder)} connection${countIn(folder) === 1 ? '' : 's'} move to ${parentOf(folder.path) ?? 'the top level'}; none is deleted.`,
                confirmLabel: 'Delete folder',
                run: () => void deleteFolder(folder.path),
              })
            }
          >
            Delete folder…
          </Item>
        </MenuContent>
      </Menu.Root>
      {open && (
        // biome-ignore lint/a11y/useSemanticElements: a tree's child list is a group, not a form fieldset
        <div role="group">
          <FolderContents folder={folder} depth={depth + 1} />
        </div>
      )}
    </>
  )
}

/** Moves focus to the next or previous row of the tree. */
function arrowFocus(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  e.preventDefault()
  const rows = [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')]
  const at = rows.indexOf(e.currentTarget)
  rows[at + (e.key === 'ArrowDown' ? 1 : -1)]?.focus()
}

function Row({
  node,
  depth,
  label,
  lead,
  aside,
  expandable,
  menu,
  onOpen,
  extra,
}: {
  node: NodeRef
  depth: number
  label: ReactNode
  lead?: ReactNode
  aside?: ReactNode
  expandable: boolean
  menu: ReactNode
  onOpen?: () => void
  /** More attributes for the row, such as drag handlers. */
  extra?: HTMLAttributes<HTMLDivElement>
}) {
  const key = nodeKey(node)
  const filter = useApp((s) => s.filter)
  const { matches } = useView()
  const open = useApp((s) => Boolean(s.expanded[key])) || (filter !== '' && matches.has(key))
  const selected = useApp((s) => s.current === key)
  const loading = useApp((s) => s.tree[key]?.status === 'loading')
  const row = (
    <div
      role="treeitem"
      aria-expanded={expandable ? open : undefined}
      aria-selected={selected}
      data-node-key={key}
      tabIndex={0}
      onClick={() => {
        select({ kind: 'node', node })
        if (expandable) toggleNode(node)
      }}
      onDoubleClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          // Enter opens a table or view (its columns are on the right arrow);
          // elsewhere it expands, and Mod+Enter opens a query on it.
          if (onOpen && (e.metaKey || e.ctrlKey || !expandable || node.kind === 'object')) onOpen()
          else if (expandable) toggleNode(node)
        } else if (e.key === 'ArrowRight' && expandable && !open) toggleNode(node)
        else if (e.key === 'ArrowLeft' && expandable && open) toggleNode(node)
        else arrowFocus(e)
      }}
      {...extra}
      className={`flex cursor-default items-center gap-1.5 py-[3px] pr-2 outline-none focus-visible:bg-accent/10 data-[state=open]:shadow-[inset_0_0_0_1px_var(--color-accent)] ${
        selected ? 'bg-accent/15' : 'hover:bg-raised'
      }`}
      style={{ paddingLeft: 6 + depth * 14 }}
    >
      <span className="w-3 shrink-0 text-center text-[10px] text-muted">
        {expandable ? (loading ? '…' : open ? '▾' : '▸') : ''}
      </span>
      {lead}
      <span className="truncate">{label}</span>
      {aside && <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted">{aside}</span>}
    </div>
  )
  if (!menu) return row
  return (
    <Menu.Root>
      <Menu.Trigger asChild>{row}</Menu.Trigger>
      <MenuContent>{menu}</MenuContent>
    </Menu.Root>
  )
}

function Children({
  node,
  children,
}: {
  node: NodeRef
  children: (loaded: Loaded & { status: 'ready' }) => ReactNode
}) {
  const key = nodeKey(node)
  const filter = useApp((s) => s.filter)
  const view = useView()
  const open = useApp((s) => Boolean(s.expanded[key])) || (filter !== '' && view.matches.has(key))
  const loaded = view.tree[key]
  if (!open || !loaded) return null
  if (loaded.status === 'error') {
    return (
      <div role="alert" className="px-6 py-1 text-[12px] text-danger">
        {loaded.error}
      </div>
    )
  }
  if (loaded.status === 'loading') return null
  // biome-ignore lint/a11y/useSemanticElements: a tree's child list is a group, not a form fieldset
  return <div role="group">{children(loaded)}</div>
}

function ConnectionNode({ profile, depth }: { profile: Profile; depth: number }) {
  const node: NodeRef = { kind: 'connection', profileId: profile.id }
  const filter = useApp((s) => s.filter)
  const { matches } = useView()
  const connected = useApp((s) => Object.keys(s.sessions).some((k) => k.startsWith(`${profile.id}\u0000`)))
  if (!profileVisible(profile, filter, matches)) return null
  const target = { profileId: profile.id, database: profile.database }
  return (
    <>
      <Row
        node={node}
        depth={depth}
        expandable
        lead={<ColorDot color={profile.color} />}
        label={profile.name}
        extra={{
          draggable: true,
          onDragStart: (e) => {
            e.dataTransfer.setData(PROFILE_TYPE, profile.id)
            e.dataTransfer.effectAllowed = 'move'
          },
        }}
        aside={
          <>
            {profile.mode === 'readOnly' && 'read-only '}
            {connected && (
              <span title="Connected" className="text-success">
                ●<span className="sr-only"> connected</span>
              </span>
            )}
          </>
        }
        onOpen={() => newTab(target)}
        menu={
          <>
            <Item onSelect={() => newTab(target)}>New query here</Item>
            <Item onSelect={() => retarget(target)}>Use in this tab</Item>
            <Separator />
            <Item onSelect={() => openDialog({ kind: 'connection', profileId: profile.id })}>
              Edit connection…
            </Item>
            <Item onSelect={() => askMove(profile)}>Move to folder…</Item>
            <Item onSelect={() => copy(profile.name)}>Copy name</Item>
            <Item onSelect={() => refreshNode(node)}>Refresh</Item>
            {connected && <Item onSelect={() => askDisconnect(profile.id)}>Disconnect</Item>}
            <Separator />
            <Item
              danger
              onSelect={() =>
                openDialog({
                  kind: 'confirm',
                  title: `Delete ${profile.name}?`,
                  message:
                    'The connection and its saved password are deleted. Its tabs stay open, without a connection.',
                  confirmLabel: 'Delete connection',
                  run: () => void deleteProfile(profile.id),
                })
              }
            >
              Delete connection…
            </Item>
          </>
        }
      />
      <Children node={node}>
        {(loaded) =>
          (loaded.databases ?? [])
            .filter((d) => {
              const child: NodeRef = { kind: 'database', profileId: profile.id, database: d }
              return (
                filter === '' ||
                passes(profile.name, filter) ||
                passes(d, filter) ||
                matches.has(nodeKey(child))
              )
            })
            .map((d) => <DatabaseNode key={d} profile={profile} database={d} depth={depth + 1} />)
        }
      </Children>
    </>
  )
}

function DatabaseNode({ profile, database, depth }: { profile: Profile; database: string; depth: number }) {
  const node: NodeRef = { kind: 'database', profileId: profile.id, database }
  const target = { profileId: profile.id, database }
  const filter = useApp((s) => s.filter)
  const { matches } = useView()
  return (
    <>
      <Row
        node={node}
        depth={depth}
        expandable
        lead={<Icon name="database" className="text-muted" />}
        label={database}
        onOpen={() => newTab(target)}
        menu={
          <>
            <Item onSelect={() => newTab(target)}>New query here</Item>
            <Item onSelect={() => retarget(target)}>Use in this tab</Item>
            <Separator />
            <Item onSelect={() => copy(database)}>Copy name</Item>
            <Item onSelect={() => refreshNode(node)}>Refresh</Item>
          </>
        }
      />
      <Children node={node}>
        {(loaded) =>
          (loaded.schemas ?? [])
            .filter(
              (schema) =>
                filter === '' ||
                passes(database, filter) ||
                passes(schema, filter) ||
                matches.has(nodeKey({ kind: 'schema', profileId: profile.id, database, schema })),
            )
            .map((schema) => (
              <SchemaNode
                key={schema}
                profile={profile}
                database={database}
                schema={schema}
                depth={depth + 1}
              />
            ))
        }
      </Children>
    </>
  )
}

function SchemaNode({
  profile,
  database,
  schema,
  depth,
}: {
  profile: Profile
  database: string
  schema: string
  depth: number
}) {
  const node: NodeRef = { kind: 'schema', profileId: profile.id, database, schema }
  const filter = useApp((s) => s.filter)
  return (
    <>
      <Row
        node={node}
        depth={depth}
        expandable
        lead={<Icon name="schema" className="text-muted" />}
        label={schema}
        onOpen={() => newTab({ profileId: profile.id, database })}
        menu={
          <>
            <Item onSelect={() => newTab({ profileId: profile.id, database })}>New query here</Item>
            <Item onSelect={() => copy(schema)}>Copy name</Item>
            <Item onSelect={() => refreshNode(node)}>Refresh</Item>
          </>
        }
      />
      <Children node={node}>
        {(loaded) =>
          GROUPS.map(({ group, title, kinds }) => {
            const objects = (loaded.objects ?? []).filter(
              (o) => kinds.includes(o.kind) && passes(o.name, filter),
            )
            if (objects.length === 0) return null
            return (
              <GroupNode
                key={group}
                node={{ kind: 'group', profileId: profile.id, database, schema, group }}
                title={title}
                objects={objects}
                profile={profile}
                depth={depth + 1}
              />
            )
          })
        }
      </Children>
    </>
  )
}

function GroupNode({
  node,
  title,
  objects,
  profile,
  depth,
}: {
  node: NodeRef & { kind: 'group' }
  title: string
  objects: DbObject[]
  profile: Profile
  depth: number
}) {
  const key = nodeKey(node)
  const filter = useApp((s) => s.filter)
  const open = useApp((s) => Boolean(s.expanded[key])) || filter !== ''
  return (
    <>
      <Row
        node={node}
        depth={depth}
        expandable
        lead={<Icon name="group" className="text-muted/70" />}
        label={title}
        aside={objects.length}
        menu={null}
      />
      {open &&
        objects.map((object) => (
          <ObjectNode
            key={`${object.kind}:${object.name}`}
            profile={profile}
            database={node.database}
            schema={node.schema}
            object={object}
            depth={depth + 1}
          />
        ))}
    </>
  )
}

function ObjectNode({
  profile,
  database,
  schema,
  object,
  depth,
}: {
  profile: Profile
  database: string
  schema: string
  object: DbObject
  depth: number
}) {
  const node: NodeRef = { kind: 'object', profileId: profile.id, database, schema, object }
  const openable = OPENABLE.has(object.kind)
  const open = () => void openTable({ profileId: profile.id, database }, schema, object.name)
  return (
    <>
      <Row
        node={node}
        depth={depth}
        expandable={openable}
        lead={<Icon name={ICONS[object.kind]} className="text-muted" />}
        label={object.name}
        aside={object.kind === 'materializedView' ? 'mat.' : object.kind === 'procedure' ? 'proc' : undefined}
        onOpen={openable ? open : undefined}
        menu={
          <>
            {openable && <Item onSelect={open}>Open</Item>}
            <Item onSelect={() => newTab({ profileId: profile.id, database })}>New query here</Item>
            <Separator />
            <Item onSelect={() => copy(object.name)}>Copy name</Item>
            <Item onSelect={() => copy(`${schema}.${object.name}`)}>Copy qualified name</Item>
            <Item onSelect={() => void copyDdl(profile.id, database, schema, object)}>Copy DDL</Item>
            {openable && <Item onSelect={() => refreshNode(node)}>Refresh</Item>}
          </>
        }
      />
      {openable && (
        <Children node={node}>
          {(loaded) =>
            (loaded.columns ?? []).map((c) => <ColumnLeaf key={c.name} column={c} depth={depth + 1} />)
          }
        </Children>
      )}
    </>
  )
}

function ColumnLeaf({ column, depth }: { column: ColumnInfo; depth: number }) {
  return (
    <div
      className="flex items-center gap-1.5 py-[2px] pr-2 text-[12px]"
      style={{ paddingLeft: 6 + depth * 14 + 12 }}
    >
      <Icon name={column.primaryKeyPosition !== null ? 'key' : 'column'} className="text-muted/70" />
      <span className="max-w-[60%] shrink-0 truncate" title={column.name}>
        {column.name}
      </span>
      {column.primaryKeyPosition !== null && (
        <span title="Primary key" className="text-[10px] font-semibold text-accent">
          PK
        </span>
      )}
      <span
        className="ml-auto min-w-0 truncate pl-2 text-muted"
        title={`${column.dbType}${column.nullable ? '' : ' not null'}`}
      >
        {column.dbType}
        {column.nullable ? '' : ' not null'}
      </span>
    </div>
  )
}
