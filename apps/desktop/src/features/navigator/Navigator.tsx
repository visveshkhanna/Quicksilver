import * as Menu from '@radix-ui/react-context-menu'
import type { ReactNode } from 'react'
import { Icon, type IconName } from '../../app/icons'
import { Kbd } from '../../app/Kbd'
import { MenuItem as Item, MenuContent, MenuSeparator as Separator } from '../../app/menu'
import { Button, ColorDot } from '../../app/ui'
import * as ipc from '../../ipc/commands'
import type { Profile } from '../../ipc/store'
import type { ColumnInfo, DbObject } from '../../ipc/types'
import { copyText } from '../../lib/clipboard'
import {
  deleteProfile,
  disconnectProfile,
  ensureSession,
  errorText,
  type Loaded,
  type NodeRef,
  newTab,
  nodeKey,
  type ObjectGroup,
  openDialog,
  openTable,
  refreshNode,
  retarget,
  say,
  select,
  setFilter,
  toggleNode,
  useApp,
} from '../../state/app'

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
  copyText(text).catch((err) => say(`Could not copy: ${errorText(err)}`, true))
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

/**
 * The left navigator: every saved connection, grouped by project, expanding
 * lazily to databases, schemas, objects and columns.
 */
export function Navigator() {
  const profiles = useApp((s) => s.profiles)
  const filter = useApp((s) => s.filter)

  const projects = new Map<string, Profile[]>()
  for (const p of profiles) {
    const key = p.project ?? ''
    projects.set(key, [...(projects.get(key) ?? []), p])
  }
  const ordered = [...projects.entries()].sort(([a], [b]) =>
    a === '' ? -1 : b === '' ? 1 : a.localeCompare(b),
  )

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
          placeholder="Filter…"
          aria-label="Filter connections"
          className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 outline-none focus:border-accent"
        />
        <Kbd id="focus-navigator" />
        <button
          type="button"
          title="New connection"
          aria-label="New connection"
          onClick={() => openDialog({ kind: 'connection', profileId: null })}
          className="rounded px-1.5 text-[16px] leading-none text-muted hover:bg-raised hover:text-fg"
        >
          +
        </button>
      </div>
      {profiles.length === 0 ? (
        <FirstRun />
      ) : (
        <div role="tree" aria-label="Connections" className="min-h-0 flex-1 overflow-auto py-1">
          {ordered.map(([project, list]) => (
            <div key={project || '-'}>
              {project && (
                <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
                  {project}
                </div>
              )}
              {list.map((p) => (
                <ConnectionNode key={p.id} profile={p} />
              ))}
            </div>
          ))}
        </div>
      )}
    </nav>
  )
}

function FirstRun() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center text-muted">
      <p>No connections yet.</p>
      <Button kind="primary" onClick={() => openDialog({ kind: 'connection', profileId: null })}>
        New connection
      </Button>
      <Button onClick={() => openDialog({ kind: 'connection', profileId: null, pasteUrl: true })}>
        Paste a URL
      </Button>
    </div>
  )
}

/** Whether `name` passes the filter. */
function passes(name: string, filter: string): boolean {
  return filter === '' || name.toLowerCase().includes(filter.toLowerCase())
}

/** Whether anything loaded beneath `key` passes the filter. */
function descendantPasses(tree: Record<string, Loaded>, key: string, filter: string): boolean {
  if (filter === '') return false
  for (const [k, loaded] of Object.entries(tree)) {
    if ((k !== key && !k.startsWith(`${key}/`)) || loaded.status !== 'ready') continue
    const names = [
      ...(loaded.databases ?? []),
      ...(loaded.schemas ?? []),
      ...(loaded.objects ?? []).map((o) => o.name),
      ...(loaded.columns ?? []).map((c) => c.name),
    ]
    if (names.some((n) => passes(n, filter))) return true
  }
  return false
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
}: {
  node: NodeRef
  depth: number
  label: ReactNode
  lead?: ReactNode
  aside?: ReactNode
  expandable: boolean
  menu: ReactNode
  onOpen?: () => void
}) {
  const key = nodeKey(node)
  const filter = useApp((s) => s.filter)
  const open = useApp(
    (s) => Boolean(s.expanded[key]) || (filter !== '' && descendantPasses(s.tree, key, filter)),
  )
  const selected = useApp((s) => s.selection?.kind === 'node' && nodeKey(s.selection.node) === key)
  const loading = useApp((s) => s.tree[key]?.status === 'loading')
  const row = (
    <div
      role="treeitem"
      aria-expanded={expandable ? open : undefined}
      aria-selected={selected}
      tabIndex={0}
      onClick={() => {
        select({ kind: 'node', node })
        if (expandable) toggleNode(node)
      }}
      onDoubleClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          if (onOpen && (e.metaKey || e.ctrlKey || !expandable)) onOpen()
          else if (expandable) toggleNode(node)
        } else if (e.key === 'ArrowRight' && expandable && !open) toggleNode(node)
        else if (e.key === 'ArrowLeft' && expandable && open) toggleNode(node)
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const rows = [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')]
          const at = rows.indexOf(e.currentTarget)
          rows[at + (e.key === 'ArrowDown' ? 1 : -1)]?.focus()
        }
      }}
      className={`flex cursor-default items-center gap-1.5 py-[3px] pr-2 outline-none focus-visible:bg-accent/10 ${
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
  const open = useApp(
    (s) => Boolean(s.expanded[key]) || (filter !== '' && descendantPasses(s.tree, key, filter)),
  )
  const loaded = useApp((s) => s.tree[key])
  if (!open || !loaded) return null
  if (loaded.status === 'error') {
    return (
      <div role="alert" className="px-6 py-1 text-[12px] text-[#e5484d]">
        {loaded.error}
      </div>
    )
  }
  if (loaded.status === 'loading') return null
  // biome-ignore lint/a11y/useSemanticElements: a tree's child list is a group, not a form fieldset
  return <div role="group">{children(loaded)}</div>
}

function ConnectionNode({ profile }: { profile: Profile }) {
  const node: NodeRef = { kind: 'connection', profileId: profile.id }
  const filter = useApp((s) => s.filter)
  const visible = useApp(
    (s) => passes(profile.name, s.filter) || descendantPasses(s.tree, nodeKey(node), s.filter),
  )
  const connected = useApp((s) => Object.keys(s.sessions).some((k) => k.startsWith(`${profile.id}\u0000`)))
  if (!visible) return null
  const target = { profileId: profile.id, database: profile.database }
  return (
    <>
      <Row
        node={node}
        depth={0}
        expandable
        lead={<ColorDot color={profile.color} />}
        label={profile.name}
        aside={
          <>
            {profile.mode === 'readOnly' && 'read-only '}
            {connected && (
              <span title="Connected" className="text-[#30a46c]">
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
            <Item onSelect={() => copy(profile.name)}>Copy name</Item>
            <Item onSelect={() => refreshNode(node)}>Refresh</Item>
            {connected && <Item onSelect={() => void disconnectProfile(profile.id)}>Disconnect</Item>}
            <Separator />
            <Item
              danger
              onSelect={() => {
                if (
                  window.confirm(
                    `Delete the connection "${profile.name}"? Its saved password is deleted too.`,
                  )
                ) {
                  void deleteProfile(profile.id)
                }
              }}
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
                descendantPasses(useApp.getState().tree, nodeKey(child), filter)
              )
            })
            .map((d) => <DatabaseNode key={d} profile={profile} database={d} />)
        }
      </Children>
    </>
  )
}

function DatabaseNode({ profile, database }: { profile: Profile; database: string }) {
  const node: NodeRef = { kind: 'database', profileId: profile.id, database }
  const target = { profileId: profile.id, database }
  return (
    <>
      <Row
        node={node}
        depth={1}
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
          (loaded.schemas ?? []).map((schema) => (
            <SchemaNode key={schema} profile={profile} database={database} schema={schema} />
          ))
        }
      </Children>
    </>
  )
}

function SchemaNode({ profile, database, schema }: { profile: Profile; database: string; schema: string }) {
  const node: NodeRef = { kind: 'schema', profileId: profile.id, database, schema }
  const filter = useApp((s) => s.filter)
  return (
    <>
      <Row
        node={node}
        depth={2}
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
}: {
  node: NodeRef & { kind: 'group' }
  title: string
  objects: DbObject[]
  profile: Profile
}) {
  const key = nodeKey(node)
  const filter = useApp((s) => s.filter)
  const open = useApp((s) => Boolean(s.expanded[key])) || filter !== ''
  return (
    <>
      <Row node={node} depth={3} expandable label={title} aside={objects.length} menu={null} />
      {open &&
        objects.map((object) => (
          <ObjectNode
            key={`${object.kind}:${object.name}`}
            profile={profile}
            database={node.database}
            schema={node.schema}
            object={object}
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
}: {
  profile: Profile
  database: string
  schema: string
  object: DbObject
}) {
  const node: NodeRef = { kind: 'object', profileId: profile.id, database, schema, object }
  const openable = OPENABLE.has(object.kind)
  const open = () => void openTable({ profileId: profile.id, database }, schema, object.name)
  return (
    <>
      <Row
        node={node}
        depth={4}
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
          {(loaded) => (loaded.columns ?? []).map((c) => <ColumnLeaf key={c.name} column={c} />)}
        </Children>
      )}
    </>
  )
}

function ColumnLeaf({ column }: { column: ColumnInfo }) {
  return (
    <div
      className="flex items-center gap-1.5 py-[2px] pr-2 text-[12px]"
      style={{ paddingLeft: 6 + 5 * 14 + 18 }}
    >
      <span className="truncate">{column.name}</span>
      {column.primaryKeyPosition !== null && (
        <span title="Primary key" className="text-[10px] font-semibold text-accent">
          PK
        </span>
      )}
      <span className="ml-auto truncate pl-2 text-muted">
        {column.dbType}
        {column.nullable ? '' : ' not null'}
      </span>
    </div>
  )
}
