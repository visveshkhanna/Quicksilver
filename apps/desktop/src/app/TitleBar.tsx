import { keysFor } from '../keymap/keymap'
import { COLORS } from '../lib/target'
import { activeTab, openDialog, togglePanel, useApp } from '../state/app'
import { Icon } from './icons'
import { Kbd, shortcutLabel } from './Kbd'
import { ColorDot } from './ui'

/** A title bar button that shows or hides a side panel. */
function PanelToggle({ panel, side }: { panel: 'navigator' | 'inspector'; side: 'Left' | 'Right' }) {
  const shown = useApp((s) => s.panels[panel])
  const overrides = useApp((s) => s.overrides)
  const keys = shortcutLabel(keysFor(`toggle-${panel}`, overrides))
  const label = `${shown ? 'Hide' : 'Show'} the ${panel}`
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={shown}
      title={keys ? `${label} (${keys})` : label}
      onClick={() => togglePanel(panel)}
      className={`rounded p-1 hover:bg-raised ${shown ? 'text-fg' : 'text-muted'}`}
    >
      <Icon name={side === 'Left' ? 'sidebarLeft' : 'sidebarRight'} className="size-4" />
    </button>
  )
}

/** The front tab's target (connection ▸ database), its mode, and the switcher. */
export function TitleBar() {
  const tab = useApp((s) => activeTab(s))
  const profile = useApp((s) => s.profiles.find((p) => p.id === tab?.profileId))
  return (
    <header
      className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-panel px-3"
      style={profile?.color ? { boxShadow: `inset 3px 0 0 ${COLORS[profile.color]}` } : undefined}
    >
      <PanelToggle panel="navigator" side="Left" />
      <span className="font-semibold">Quicksilver</span>
      <nav aria-label="Current target" className="flex min-w-0 items-center gap-1.5 text-muted">
        {profile ? (
          <>
            {profile.color && <ColorDot color={profile.color} />}
            <span className="truncate text-fg">{profile.name}</span>
            <span aria-hidden>▸</span>
            <span className="truncate">{tab?.database ?? 'default database'}</span>
            {profile.mode === 'readOnly' && (
              <span className="ml-1 rounded bg-raised px-1.5 py-0.5 text-[10px] font-semibold">
                READ-ONLY
              </span>
            )}
          </>
        ) : (
          <span>No database selected</span>
        )}
      </nav>
      <button
        type="button"
        onClick={() => openDialog({ kind: 'switcher' })}
        className="ml-auto flex items-center gap-2 rounded px-1.5 py-0.5 text-muted hover:bg-raised"
      >
        Switch database <Kbd id="switch-database" />
      </button>
      <PanelToggle panel="inspector" side="Right" />
    </header>
  )
}
