// Closing the window or quitting: the Rust side asks here first. Tab text
// still waiting to be saved is saved, and unsaved row changes are not lost
// without asking.

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { flushTabs, openDialog, unsavedChanges, useApp } from '../state/app'

/** Quits once the user agrees; called when the window closes or the app quits. */
export async function confirmQuit() {
  await flushTabs()
  const n = unsavedChanges()
  if (n === 0) {
    await invoke('quit_app')
    return
  }
  if (useApp.getState().dialog?.kind === 'confirm') return
  openDialog({
    kind: 'confirm',
    title: 'Quit with unsaved changes?',
    message: `${n} change${n === 1 ? '' : 's'} to rows ${n === 1 ? 'has' : 'have'} not been saved to the database and will be lost.`,
    confirmLabel: 'Quit anyway',
    run: () => void invoke('quit_app'),
  })
}

/** Listens for the window closing or the app quitting. */
export function guardQuit(): Promise<() => void> {
  return listen('quit-requested', () => void confirmQuit())
}
