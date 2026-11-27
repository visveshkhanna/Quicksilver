// The three palettes: switch database (Mod+K), go to object (Mod+P) and the
// command palette (Mod+Shift+P).

import { useEffect, useMemo } from 'react'
import { COMMANDS } from '../../app/commands'
import { Icon, type IconName } from '../../app/icons'
import { KeyCaps } from '../../app/Kbd'
import { ColorDot } from '../../app/ui'
import { hasBinding, keysFor } from '../../keymap/keymap'
import { type Target, targetKey } from '../../lib/target'
import {
  activeTab,
  closeDialog,
  indexProfile,
  isConnected,
  newTab,
  nodeKey,
  openTable,
  profileById,
  retarget,
  reveal,
  type State,
  select,
  useApp,
} from '../../state/app'
import { type PickItem, QuickPick } from './QuickPick'

/** Every connection + database the app knows of, most recent first. */
export function knownTargets(state: State): (Target & { label: string })[] {
  const byKey = new Map<string, Target & { label: string }>()
  for (const profile of state.profiles) {
    const databases = new Set<string>()
    for (const entry of state.catalog) {
      if (entry.profileId === profile.id && entry.kind === 'database') databases.add(entry.database)
    }
    const loaded = state.tree[nodeKey({ kind: 'connection', profileId: profile.id })]
    if (loaded?.status === 'ready') for (const d of loaded.databases ?? []) databases.add(d)
    if (profile.database) databases.add(profile.database)
    if (databases.size === 0) {
      byKey.set(targetKey(profile.id, null), { profileId: profile.id, database: null, label: profile.name })
    }
    for (const database of [...databases].sort()) {
      byKey.set(targetKey(profile.id, database), {
        profileId: profile.id,
        database,
        label: `${profile.name} / ${database}`,
      })
    }
  }
  const recent = state.recent.filter((k) => byKey.has(k))
  const rest = [...byKey.keys()].filter((k) => !recent.includes(k))
  return [...recent, ...rest].flatMap((k) => {
    const t = byKey.get(k)
    return t ? [t] : []
  })
}

export function DatabaseSwitcher() {
  const state = useApp()
  const front = activeTab(state)
  const targets = useMemo(() => knownTargets(state), [state])
  const items: PickItem[] = targets.map((t) => {
    const profile = profileById(t.profileId)
    const current = front?.profileId === t.profileId && front.database === t.database
    return {
      id: targetKey(t.profileId, t.database),
      label: t.label,
      lead: <ColorDot color={profile?.color} />,
      aside: current ? <span className="text-[11px] text-muted">current</span> : undefined,
    }
  })
  return (
    <QuickPick
      title="Switch database"
      placeholder="Connection or database…"
      items={items}
      empty={
        state.profiles.length === 0 ? 'No connections yet. Add one with New connection.' : 'Nothing matches.'
      }
      onClose={closeDialog}
      onPick={(item, alternative) => {
        const target = targets.find((t) => targetKey(t.profileId, t.database) === item.id)
        closeDialog()
        if (!target) return
        if (alternative) newTab({ profileId: target.profileId, database: target.database })
        else retarget({ profileId: target.profileId, database: target.database })
        void reveal(
          target.database
            ? { kind: 'database', profileId: target.profileId, database: target.database }
            : { kind: 'connection', profileId: target.profileId },
        )
      }}
      footer={
        <>
          <KeyCaps keys="Enter" /> switch this tab · <KeyCaps keys="Mod+Enter" /> open in a new tab
        </>
      }
    />
  )
}

const OPENABLE = new Set(['table', 'view', 'materializedView', 'foreignTable'])

const KIND_ICONS: Record<string, IconName> = {
  table: 'table',
  foreignTable: 'table',
  view: 'view',
  materializedView: 'view',
  function: 'function',
  procedure: 'function',
  sequence: 'sequence',
}

type Found = { profileId: string; database: string; schema: string; name: string; kind: string }

/** Every table, view and routine known for any connection: the front tab's connection and database first. */
function knownObjects(state: State, profileId: string | null, database: string | null): Found[] {
  const seen = new Map<string, Found>()
  const add = (o: Found) => seen.set(`${o.profileId}\u0000${o.database}\u0000${o.schema}\u0000${o.name}`, o)
  const names = new Set(state.profiles.map((p) => p.id))
  for (const e of state.catalog) {
    if (names.has(e.profileId) && e.schema && e.name) {
      add({ profileId: e.profileId, database: e.database, schema: e.schema, name: e.name, kind: e.kind })
    }
  }
  // Objects loaded in the navigator since the cache was written.
  for (const [key, loaded] of Object.entries(state.tree)) {
    const m = /^c:([^/]+)\/d:([^/]+)\/s:([^/]+)$/.exec(key)
    if (!m || loaded.status !== 'ready') continue
    for (const o of loaded.objects ?? []) {
      add({ profileId: m[1] ?? '', database: m[2] ?? '', schema: m[3] ?? '', name: o.name, kind: o.kind })
    }
  }
  const rank = (o: Found) => (o.profileId === profileId ? (o.database === database ? 0 : 1) : 2)
  return [...seen.values()].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.profileId.localeCompare(b.profileId) ||
      a.database.localeCompare(b.database) ||
      a.schema.localeCompare(b.schema) ||
      a.name.localeCompare(b.name),
  )
}

export function GoToObject() {
  const state = useApp()
  const front = activeTab(state)
  const profile = profileById(front?.profileId ?? null)
  const several = state.profiles.length > 1

  // Read every database's tables in the background: the front tab's
  // connection, and any other that is connected.
  useEffect(() => {
    const { profiles } = useApp.getState()
    for (const p of profiles) {
      if (p.id === profile?.id || isConnected(p.id)) void indexProfile(p.id)
    }
  }, [profile?.id])

  const objects = useMemo(
    () => knownObjects(state, profile?.id ?? null, front?.database ?? null),
    [state, profile?.id, front?.database],
  )
  const id = (o: Found) => `${o.profileId}\u0000${o.database}\u0000${o.schema}\u0000${o.name}`
  const items: PickItem[] = objects.map((o) => ({
    id: id(o),
    lead: <Icon name={KIND_ICONS[o.kind] ?? 'table'} className="text-muted" />,
    label: `${o.schema}.${o.name}`,
    detail: `${several ? `${profileById(o.profileId)?.name ?? ''} / ` : ''}${o.database} · ${o.kind}`,
  }))
  const reading = Object.values(state.indexing)
  const done = reading.reduce((n, r) => n + r.done, 0)
  const total = reading.reduce((n, r) => n + r.total, 0)

  return (
    <QuickPick
      title="Go to object"
      placeholder="Table, view or function in any database…"
      items={items}
      empty={
        reading.length > 0
          ? 'Reading the databases…'
          : profile || state.catalog.length > 0
            ? 'Nothing matches.'
            : 'Connect to a database first.'
      }
      onClose={closeDialog}
      onPick={(item) => {
        closeDialog()
        const o = objects.find((x) => id(x) === item.id)
        if (!o) return
        const node = {
          kind: 'object' as const,
          profileId: o.profileId,
          database: o.database,
          schema: o.schema,
          object: { name: o.name, kind: o.kind as never },
        }
        void reveal(node)
        if (OPENABLE.has(o.kind)) {
          void openTable({ profileId: o.profileId, database: o.database }, o.schema, o.name)
        } else {
          select({ kind: 'node', node })
        }
      }}
      footer={
        <>
          <KeyCaps keys="Enter" /> open it and show it in the navigator
          {reading.length > 0 && (
            <span className="ml-auto" role="status">
              Reading tables: {done} of {total} databases…
            </span>
          )}
        </>
      }
    />
  )
}

export function CommandPalette() {
  const state = useApp()
  const items: PickItem[] = COMMANDS.filter((c) => c.id !== 'command-palette' && c.enabled(state)).map(
    (c) => {
      const keys = hasBinding(c.id) ? keysFor(c.id, state.overrides) : ''
      return { id: c.id, label: c.title, aside: keys ? <KeyCaps keys={keys} /> : undefined }
    },
  )
  return (
    <QuickPick
      title="Command palette"
      placeholder="Run a command…"
      items={items}
      empty="No command matches."
      onClose={closeDialog}
      onPick={(item) => {
        closeDialog()
        COMMANDS.find((c) => c.id === item.id)?.run()
      }}
    />
  )
}
