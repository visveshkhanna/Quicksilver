// Everything the app can do from the keyboard or the command palette. A
// shortcut and its palette entry are the same command, so they always agree.

import { useEffect } from 'react'
import { bindingFor, currentPlatform, tabJump } from '../keymap/keymap'
import {
  activeTab,
  cancelActive,
  closeTab,
  disconnectProfile,
  newTab,
  openDialog,
  reloadCatalog,
  reopenTab,
  runActive,
  type State,
  togglePanel,
  useApp,
} from '../state/app'

export type Command = {
  id: string
  title: string
  /** Whether it can run right now; the palette lists only those that can. */
  enabled: (state: State) => boolean
  run: () => void
}

const always = () => true
const hasTarget = (s: State) => Boolean(activeTab(s)?.profileId)
const isRunning = (s: State) => activeTab(s)?.run?.status === 'running'

/** Focuses the navigator filter (rendered by the navigator). */
export function focusNavigatorFilter() {
  const input = document.getElementById('navigator-filter')
  if (!input) {
    if (!useApp.getState().panels.navigator) togglePanel('navigator')
    setTimeout(() => document.getElementById('navigator-filter')?.focus(), 0)
    return
  }
  input.focus()
}

export const COMMANDS: readonly Command[] = [
  {
    id: 'switch-database',
    title: 'Switch database',
    enabled: always,
    run: () => openDialog({ kind: 'switcher' }),
  },
  {
    id: 'go-to-object',
    title: 'Go to table, view or function',
    enabled: hasTarget,
    run: () => openDialog({ kind: 'goto' }),
  },
  {
    id: 'command-palette',
    title: 'Command palette',
    enabled: always,
    run: () => openDialog({ kind: 'palette' }),
  },
  { id: 'new-tab', title: 'New query tab', enabled: always, run: () => void newTab() },
  { id: 'close-tab', title: 'Close tab', enabled: (s) => s.tabs.length > 0, run: () => closeTab() },
  { id: 'reopen-tab', title: 'Reopen closed tab', enabled: (s) => s.closedTabs.length > 0, run: reopenTab },
  {
    id: 'run-statement',
    title: 'Run statement under cursor',
    enabled: (s) => hasTarget(s) && !isRunning(s),
    run: () => void runActive('statement'),
  },
  {
    id: 'run-all',
    title: 'Run everything',
    enabled: (s) => hasTarget(s) && !isRunning(s),
    run: () => void runActive('all'),
  },
  { id: 'cancel-query', title: 'Cancel running query', enabled: isRunning, run: cancelActive },
  { id: 'focus-navigator', title: 'Focus navigator filter', enabled: always, run: focusNavigatorFilter },
  {
    id: 'new-connection',
    title: 'New connection',
    enabled: always,
    run: () => openDialog({ kind: 'connection', profileId: null }),
  },
  {
    id: 'toggle-navigator',
    title: 'Show or hide the navigator',
    enabled: always,
    run: () => togglePanel('navigator'),
  },
  {
    id: 'toggle-inspector',
    title: 'Show or hide the inspector',
    enabled: always,
    run: () => togglePanel('inspector'),
  },
  {
    id: 'keyboard-shortcuts',
    title: 'Keyboard shortcuts',
    enabled: always,
    run: () => openDialog({ kind: 'shortcuts' }),
  },
  // Palette only.
  {
    id: 'disconnect',
    title: 'Disconnect this tab’s connection',
    enabled: (s) => {
      const id = activeTab(s)?.profileId
      return Boolean(id && Object.keys(s.sessions).some((k) => k.startsWith(`${id}\u0000`)))
    },
    run: () => {
      const id = activeTab()?.profileId
      if (id) void disconnectProfile(id)
    },
  },
  {
    id: 'reload-catalog',
    title: 'Reload the database list for switching',
    enabled: always,
    run: () => void reloadCatalog(),
  },
]

export function command(id: string): Command | undefined {
  return COMMANDS.find((c) => c.id === id)
}

const platform = currentPlatform()

/**
 * Listens for shortcuts on the whole window. While a dialog is open, only
 * the dialog's own keys apply, except the switchers, which replace each
 * other.
 */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return
      const state = useApp.getState()
      if (state.passwordRequest) return
      const jump = tabJump(event, platform)
      if (jump !== null && !state.dialog) {
        event.preventDefault()
        const tab = state.tabs[jump]
        if (tab) useApp.setState({ activeTabId: tab.id })
        return
      }
      const found = bindingFor(event, state.overrides, platform)
      if (!found) return
      const switcher = ['switch-database', 'go-to-object', 'command-palette']
      if (
        state.dialog &&
        !(switcher.includes(found.id) && ['switcher', 'goto', 'palette'].includes(state.dialog.kind))
      ) {
        return
      }
      const cmd = command(found.id)
      if (!cmd) return
      event.preventDefault()
      if (cmd.enabled(state)) cmd.run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
