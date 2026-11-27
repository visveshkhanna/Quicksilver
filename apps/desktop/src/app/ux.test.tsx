// @vitest-environment jsdom
//
// Everyday rough edges: connections that drop or will not open, passwords
// the server refuses, throwing away row changes, naming tabs, the empty
// workspace, a new connection, and an empty result.

import { clearMocks } from '@tauri-apps/api/mocks'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatMs } from '../lib/target'
import { boot, resetApp, setTabText, toggleDeleteRows, useApp } from '../state/app'
import { databaseEntry, fakeBackend, profile } from '../test/backend'
import { App } from './App'

const pg = profile('pg', 'prod-pg')
const catalog = [databaseEntry('pg', 'quicksilver_dev')]

async function start(options: Parameters<typeof fakeBackend>[0] = { profiles: [pg], catalog }) {
  const backend = fakeBackend(options)
  await boot()
  const user = userEvent.setup()
  render(<App />)
  return { backend, user }
}

const front = () => {
  const s = useApp.getState()
  const tab = s.tabs.find((t) => t.id === s.activeTabId)
  if (!tab) throw new Error('no front tab')
  return tab
}

/** A tab on prod-pg with `sql` in it, run once. */
async function ran(user: ReturnType<typeof userEvent.setup>, sql = 'select 1') {
  await user.keyboard('{Control>}k{/Control}')
  await user.type(await screen.findByRole('combobox'), 'quicksilver')
  await user.keyboard('{Enter}')
  act(() => setTabText(front().id, sql, sql.length))
  await user.keyboard('{Control>}{Enter}{/Control}')
  await waitFor(() => expect(front().run?.status).toBe('done'))
}

beforeEach(() => resetApp())
afterEach(() => {
  cleanup()
  clearMocks()
})

describe('connections', () => {
  it('reconnects after the server closed the session', async () => {
    const { user, backend } = await start()
    await ran(user)
    backend.dropSessions()
    await user.keyboard('{Control>}{Enter}{/Control}')
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The connection was closed')
    // The dead session is forgotten, so running again opens a new one.
    expect(Object.keys(useApp.getState().sessions)).toHaveLength(0)
    await user.click(within(alert).getByRole('button', { name: 'Reconnect and run' }))
    await waitFor(() => expect(front().run?.status).toBe('done'))
    expect(backend.called('connect_profile')).toHaveLength(2)
  })

  it('shows a failure to connect in the results, with Try again', async () => {
    await start({ profiles: [profile('bad', 'broken', { host: 'unreachable.example' })], catalog: [] })
    const user = userEvent.setup()
    await user.keyboard('{Control>}k{/Control}')
    await user.type(await screen.findByRole('combobox'), 'broken')
    await user.keyboard('{Enter}')
    act(() => setTabText(front().id, 'select 1', 8))
    await user.keyboard('{Control>}{Enter}{/Control}')
    const text = await screen.findByText(/Could not connect to broken: could not connect to server/)
    const alert = text.closest('[role="alert"]') as HTMLElement
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(within(alert).getByRole('button', { name: 'Copy' })).toBeTruthy()
  })

  it('asks again, saying why, when the password is refused', async () => {
    const { user } = await start({ profiles: [pg], catalog, needsPassword: new Set(['pg']) })
    await user.keyboard('{Control>}k{/Control}')
    await user.type(await screen.findByRole('combobox'), 'quicksilver')
    await user.keyboard('{Enter}')
    let ask = await screen.findByRole('dialog', { name: 'Password for prod-pg' })
    await user.type(within(ask).getByLabelText('Password'), 'wrong{Enter}')
    ask = await screen.findByRole('dialog', { name: 'Password for prod-pg' })
    expect(within(ask).getByRole('alert').textContent).toContain('password authentication failed')
    await user.type(within(ask).getByLabelText('Password'), 'right{Enter}')
    await waitFor(() => expect(Object.keys(useApp.getState().sessions).length).toBeGreaterThan(0))
  })

  it('opens a tab on a connection once it is created', async () => {
    const { user } = await start({ profiles: [], catalog: [] })
    await user.keyboard('{Control>}{Shift>}n{/Shift}{/Control}')
    const form = await screen.findByRole('dialog', { name: 'New connection' })
    await user.type(within(form).getByLabelText('Name'), 'fresh')
    await user.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(useApp.getState().tabs).toHaveLength(1))
    const id = useApp.getState().profiles[0]?.id
    expect(front().profileId).toBe(id)
    expect(useApp.getState().current).toBe(`c:${id}`)
  })
})

describe('tabs and results', () => {
  it('asks before Discard throws row changes away', async () => {
    const { user } = await start()
    await ran(user)
    const result = front().run?.results[0]
    if (!result) throw new Error('no result')
    act(() => toggleDeleteRows(front().id, result.resultId, [0]))
    await user.click(await screen.findByRole('button', { name: 'Discard' }))
    const ask = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }))
    expect(front().draft).not.toBeNull()
    expect(screen.getByText('unsaved changes', { exact: false })).toBeTruthy()
  })

  it('renames a tab with a double-click', async () => {
    const { user } = await start()
    await ran(user)
    const strip = screen.getByRole('tablist', { name: 'Query tabs' })
    await user.dblClick(within(strip).getByRole('tab', { selected: true }))
    // The name is selected, so typing replaces it.
    expect(document.activeElement).toBe(screen.getByLabelText('Tab name'))
    await user.keyboard('Monthly report{Enter}')
    expect(front().title).toBe('Monthly report')
  })

  it('offers commands from the empty workspace', async () => {
    const { user } = await start()
    await user.click(screen.getByRole('button', { name: /New query tab.*Ctrl/ }))
    expect(useApp.getState().tabs).toHaveLength(1)
  })

  it('formats durations for people', () => {
    expect(formatMs(0.4321)).toBe('0.4 ms')
    expect(formatMs(12.346)).toBe('12 ms')
    expect(formatMs(1250)).toBe('1.25 s')
    expect(formatMs(125_000)).toBe('2 min 5 s')
  })
})
