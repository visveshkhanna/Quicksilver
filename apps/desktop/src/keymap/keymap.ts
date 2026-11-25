/**
 * Every keyboard shortcut, in one place.
 *
 * `Mod` is Cmd on macOS and Ctrl elsewhere. The docs site's shortcut page is
 * generated from this list, so it is the only place a binding is written.
 */
export type Binding = {
  id: string
  keys: string
  title: string
}

export const BINDINGS: readonly Binding[] = [
  { id: 'switch-database', keys: 'Mod+K', title: 'Switch database' },
  { id: 'go-to-object', keys: 'Mod+P', title: 'Go to table, view or function' },
  { id: 'command-palette', keys: 'Mod+Shift+P', title: 'Command palette' },
  { id: 'new-tab', keys: 'Mod+T', title: 'New query tab' },
  { id: 'close-tab', keys: 'Mod+W', title: 'Close tab' },
  { id: 'reopen-tab', keys: 'Mod+Shift+T', title: 'Reopen closed tab' },
  { id: 'run-statement', keys: 'Mod+Enter', title: 'Run statement under cursor' },
  { id: 'run-all', keys: 'Mod+Shift+Enter', title: 'Run everything' },
  { id: 'cancel-query', keys: 'Mod+.', title: 'Cancel running query' },
  { id: 'focus-navigator', keys: 'Mod+Shift+E', title: 'Focus navigator filter' },
]

export type Platform = 'mac' | 'other'

/** Detects the platform from the webview's user agent. */
export function currentPlatform(userAgent = globalThis.navigator?.userAgent ?? ''): Platform {
  return /Mac|iPhone|iPad/.test(userAgent) ? 'mac' : 'other'
}

const MAC_SYMBOLS: Record<string, string> = {
  Mod: '⌘',
  Shift: '⇧',
  Alt: '⌥',
  Ctrl: '⌃',
  Enter: '↩',
}

/** Formats a binding the way the platform writes shortcuts: `⌘⇧P` or `Ctrl+Shift+P`. */
export function formatKeys(keys: string, platform: Platform): string {
  const parts = keys.split('+')
  if (platform === 'mac') return parts.map((part) => MAC_SYMBOLS[part] ?? part).join('')
  return parts.map((part) => (part === 'Mod' ? 'Ctrl' : part)).join('+')
}

/** The binding with this id. Throws on an unknown id, which is a typo in the caller. */
export function binding(id: string): Binding {
  const found = BINDINGS.find((b) => b.id === id)
  if (!found) throw new Error(`no binding with id ${id}`)
  return found
}
