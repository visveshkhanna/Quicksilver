// The three palettes: switch database (Mod+K), go to object (Mod+P) and the
// command palette (Mod+Shift+P).

import { useMemo } from 'react'
import { COMMANDS } from '../../app/commands'
import { KeyCaps } from '../../app/Kbd'
import { ColorDot } from '../../app/ui'
import { hasBinding, keysFor } from '../../keymap/keymap'
import { selectFrom, type Target, targetKey } from '../../lib/target'
import {
  activeTab,
  closeDialog,
  newTab,
  nodeKey,
  profileById,
  retarget,
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

export function GoToObject() {
  const state = useApp()
  const front = activeTab(state)
  const profile = profileById(front?.profileId ?? null)
  const objects = useMemo(() => {
    if (!profile) return []
    const seen = new Map<string, { database: string; schema: string; name: string; kind: string }>()
    for (const e of state.catalog) {
      if (e.profileId === profile.id && e.schema && e.name) {
        seen.set(`${e.database}.${e.schema}.${e.name}`, {
          database: e.database,
          schema: e.schema,
          name: e.name,
          kind: e.kind,
        })
      }
    }
    // Objects loaded in the navigator since the cache was written.
    for (const [key, loaded] of Object.entries(state.tree)) {
      const m = /^c:([^/]+)\/d:([^/]+)\/s:([^/]+)$/.exec(key)
      if (!m || m[1] !== profile.id || loaded.status !== 'ready') continue
      for (const o of loaded.objects ?? []) {
        seen.set(`${m[2]}.${m[3]}.${o.name}`, {
          database: m[2] ?? '',
          schema: m[3] ?? '',
          name: o.name,
          kind: o.kind,
        })
      }
    }
    // The tab's own database first.
    return [...seen.values()].sort(
      (a, b) =>
        Number(b.database === front?.database) - Number(a.database === front?.database) ||
        a.schema.localeCompare(b.schema) ||
        a.name.localeCompare(b.name),
    )
  }, [state.catalog, state.tree, profile, front?.database])

  const items: PickItem[] = objects.map((o) => ({
    id: `${o.database}\u0000${o.schema}\u0000${o.name}`,
    label: `${o.schema}.${o.name}`,
    detail: `${o.database} · ${o.kind}`,
  }))

  return (
    <QuickPick
      title="Go to object"
      placeholder={profile ? `Table, view or function in ${profile.name}…` : 'Pick a database first'}
      items={items}
      empty={
        profile
          ? 'Nothing matches. Objects appear here after the connection has been opened once.'
          : 'No connection.'
      }
      onClose={closeDialog}
      onPick={(item) => {
        closeDialog()
        const o = objects.find((x) => `${x.database}\u0000${x.schema}\u0000${x.name}` === item.id)
        if (!o || !profile) return
        if (OPENABLE.has(o.kind)) {
          newTab(
            { profileId: profile.id, database: o.database },
            selectFrom(profile.engine, o.schema, o.name),
            { schema: o.schema, name: o.name },
          )
        } else {
          select({
            kind: 'node',
            node: {
              kind: 'object',
              profileId: profile.id,
              database: o.database,
              schema: o.schema,
              object: { name: o.name, kind: o.kind as never },
            },
          })
        }
      }}
      footer={
        <>
          <KeyCaps keys="Enter" /> open a query on it in a new tab
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
