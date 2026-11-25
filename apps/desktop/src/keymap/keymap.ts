/**
 * Every keyboard shortcut, in one place.
 *
 * `Mod` is Cmd on macOS and Ctrl elsewhere. The docs site's shortcut page is
 * generated from this list, so it is the only place a default binding is
 * written. People can rebind any of them; their changes are kept in the
 * state database as overrides on top of these defaults.
 */
export type Binding = {
  id: string
  /** The default keys, such as `Mod+Shift+P`. */
  keys: string
  title: string
  /**
   * Where it applies: everywhere (the default), or only while the results
   * grid has focus.
   */
  scope?: 'grid'
}

export const BINDINGS: readonly Binding[] = [
  { id: 'switch-database', keys: 'Mod+K', title: 'Switch database' },
  { id: 'go-to-object', keys: 'Mod+P', title: 'Go to table, view or function' },
  { id: 'command-palette', keys: 'Mod+Shift+P', title: 'Command palette' },
  { id: 'new-tab', keys: 'Mod+T', title: 'New query tab' },
  { id: 'close-tab', keys: 'Mod+W', title: 'Close tab' },
  { id: 'reopen-tab', keys: 'Mod+Shift+T', title: 'Reopen closed tab' },
  { id: 'run-statement', keys: 'Mod+Enter', title: 'Run the selection, or the statement under the cursor' },
  { id: 'run-all', keys: 'Mod+Shift+Enter', title: 'Run everything' },
  { id: 'cancel-query', keys: 'Mod+.', title: 'Cancel running query' },
  { id: 'focus-navigator', keys: 'Mod+Shift+E', title: 'Focus navigator filter' },
  { id: 'new-connection', keys: 'Mod+Shift+N', title: 'New connection' },
  { id: 'toggle-navigator', keys: 'Mod+B', title: 'Show or hide the navigator' },
  { id: 'toggle-inspector', keys: 'Mod+Shift+I', title: 'Show or hide the inspector' },
  { id: 'keyboard-shortcuts', keys: 'Mod+,', title: 'Keyboard shortcuts' },
  { id: 'explain-statement', keys: 'Mod+E', title: 'Explain the statement under the cursor' },
  { id: 'format-sql', keys: 'Mod+Shift+F', title: 'Format the selection, or everything' },
  { id: 'toggle-focus', keys: 'Mod+J', title: 'Switch focus between the editor and the results' },
  { id: 'copy-cells', keys: 'Mod+C', title: 'Copy the selected cells', scope: 'grid' },
  {
    id: 'copy-cells-with-header',
    keys: 'Mod+Shift+C',
    title: 'Copy the selected cells with column names',
    scope: 'grid',
  },
  { id: 'select-all-cells', keys: 'Mod+A', title: 'Select every cell', scope: 'grid' },
  { id: 'inspect-row', keys: 'Space', title: 'Show the row in the inspector', scope: 'grid' },
]

/** Keys the grid handles that cannot be rebound. */
export const GRID_FIXED_KEYS = [
  ['Arrows', 'Move the cell cursor; with Shift, extend the selection'],
  ['PageUp PageDown', 'Move a screen at a time'],
  ['Mod+Up Mod+Down', 'First or last row'],
  ['Home End', 'First or last column'],
] as const

/** `Mod+1` … `Mod+9` jump to tab N. Fixed, so not in `BINDINGS`. */
export const TAB_JUMP_KEYS = 'Mod+1…9'

/** The user's changes: binding id to keys (`''` unbinds). */
export type Overrides = Record<string, string>

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
  if (keys === '') return ''
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

/** Whether `id` is a binding (some commands are only in the palette). */
export function hasBinding(id: string): boolean {
  return BINDINGS.some((b) => b.id === id)
}

/** The keys bound to `id` once the user's overrides apply. */
export function keysFor(id: string, overrides: Overrides): string {
  return overrides[id] ?? binding(id).keys
}

/** The other binding already using `keys`, if any. */
export function conflictFor(id: string, keys: string, overrides: Overrides): Binding | undefined {
  if (keys === '') return undefined
  return BINDINGS.find((b) => b.id !== id && keysFor(b.id, overrides) === keys)
}

type KeyEventLike = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

const CODE_KEYS: Record<string, string> = {
  Period: '.',
  Comma: ',',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Space: 'Space',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'Backspace',
}

/**
 * The key an event names, independent of Shift and keyboard layout quirks:
 * `K`, `1`, `.`, `Enter`. Uses the physical key code where it identifies
 * the key, because Shift turns `.` into `>` in `event.key`.
 */
export function keyName(event: Pick<KeyboardEvent, 'key' | 'code'>): string | null {
  const code = event.code ?? ''
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6)
  if (CODE_KEYS[code]) return CODE_KEYS[code]
  if (/^F[0-9]{1,2}$/.test(code)) return code
  const key = event.key ?? ''
  if (['Shift', 'Control', 'Alt', 'Meta', 'OS', 'Dead', 'Unidentified', ''].includes(key)) return null
  return key.length === 1 ? key.toUpperCase() : key
}

/** The keys an event spells, as a binding string, or `null` for a bare modifier. */
export function eventToKeys(event: KeyEventLike, platform: Platform): string | null {
  const key = keyName(event)
  if (!key) return null
  const parts: string[] = []
  const mod = platform === 'mac' ? event.metaKey : event.ctrlKey
  if (mod) parts.push('Mod')
  if (platform === 'mac' && event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

/** Canonical order, so `Shift+Mod+K` and `Mod+Shift+K` compare equal. */
function canonical(keys: string): string {
  const parts = keys.split('+')
  const key = parts.pop() ?? ''
  const order = ['Mod', 'Ctrl', 'Alt', 'Shift']
  return [...order.filter((m) => parts.includes(m)), key.length === 1 ? key.toUpperCase() : key].join('+')
}

/** Whether `event` is exactly `keys` (no extra modifiers). */
export function matches(keys: string, event: KeyEventLike, platform: Platform): boolean {
  if (keys === '') return false
  const spelled = eventToKeys(event, platform)
  return spelled !== null && canonical(spelled) === canonical(keys)
}

/** The binding `event` triggers in `scope` (the whole app by default), if any. */
export function bindingFor(
  event: KeyEventLike,
  overrides: Overrides,
  platform: Platform,
  scope: 'app' | 'grid' = 'app',
): Binding | undefined {
  return BINDINGS.find(
    (b) => (b.scope ?? 'app') === scope && matches(keysFor(b.id, overrides), event, platform),
  )
}

/** For `Mod+1` … `Mod+9`, the tab index (0-based); otherwise `null`. */
export function tabJump(event: KeyEventLike, platform: Platform): number | null {
  const key = keyName(event)
  const mod = platform === 'mac' ? event.metaKey : event.ctrlKey
  if (!mod || event.shiftKey || event.altKey || !key || !/^[1-9]$/.test(key)) return null
  return Number(key) - 1
}
