// @vitest-environment jsdom
//
// Every keyboard flow, end to end: the real UI and state, with the Rust side
// replaced by a fake behind Tauri's IPC mock. jsdom is not a Mac, so `Mod`
// is Ctrl here.

import { clearMocks } from '@tauri-apps/api/mocks'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boot, resetApp, saveProfile, useApp } from '../state/app'
import { databaseEntry, fakeBackend, objectEntry, profile } from '../test/backend'
import { App } from './App'

const pg = profile('pg', 'prod-pg', { color: 'red' })
const lite = profile('lite', 'local', {
  engine: 'sqlite',
  host: null,
  user: null,
  database: null,
  path: '/tmp/a.db',
})
const catalog = [
  databaseEntry('pg', 'quicksilver_dev'),
  databaseEntry('pg', 'analytics'),
  databaseEntry('pg', 'staging'),
  databaseEntry('lite', 'main'),
  objectEntry('pg', 'quicksilver_dev', 'sales', 'orders'),
  objectEntry('pg', 'quicksilver_dev', 'sales', 'customers'),
  objectEntry('pg', 'quicksilver_dev', 'sales', 'order_total', 'function'),
]

async function start(options: Parameters<typeof fakeBackend>[0] = { profiles: [pg, lite], catalog }) {
  const backend = fakeBackend(options)
  await boot()
  const user = userEvent.setup()
  render(<App />)
  return { backend, user }
}

const tabs = () => within(screen.getByRole('tablist', { name: 'Query tabs' })).queryAllByRole('tab')
const activeTitle = () => useApp.getState().tabs.find((t) => t.id === useApp.getState().activeTabId)

beforeEach(() => resetApp())
afterEach(() => {
  cleanup()
  clearMocks()
})

describe('first run', () => {
  it('offers to create a connection', async () => {
    await start({ profiles: [], catalog: [] })
    expect(screen.getByText('No connections yet.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Paste a URL' })).toBeTruthy()
  })

  it('opens the connection form with Mod+Shift+N', async () => {
    const { user } = await start({ profiles: [], catalog: [] })
    await user.keyboard('{Control>}{Shift>}n{/Shift}{/Control}')
    expect(await screen.findByRole('dialog', { name: 'New connection' })).toBeTruthy()
  })
})

describe('Mod+K switches database', () => {
  it('finds a database by fuzzy search and points the tab at it', async () => {
    const { user, backend } = await start()
    await user.keyboard('{Control>}k{/Control}')
    const box = await screen.findByRole('combobox', { name: 'Switch database' })
    await user.type(box, 'pg ana')
    const options = screen.getAllByRole('option')
    expect(options[0]?.textContent).toContain('prod-pg / analytics')
    await user.keyboard('{Enter}')

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(tabs()).toHaveLength(1)
    expect(activeTitle()).toMatchObject({ profileId: 'pg', database: 'analytics' })
    expect(
      within(screen.getByRole('navigation', { name: 'Current target' })).getByText('analytics'),
    ).toBeTruthy()
    // It starts connecting at once, so the first run does not wait.
    await waitFor(() =>
      expect(backend.called('connect_profile').some((c) => c.args.database === 'analytics')).toBe(true),
    )
  })

  it('lists the most recent target first and opens a new tab with Mod+Enter', async () => {
    const { user } = await start()
    await user.keyboard('{Control>}k{/Control}')
    await user.type(await screen.findByRole('combobox'), 'staging')
    await user.keyboard('{Enter}')

    await user.keyboard('{Control>}k{/Control}')
    const first = (await screen.findAllByRole('option'))[0]
    expect(first?.textContent).toContain('prod-pg / staging')
    expect(first?.textContent).toContain('current')

    await user.type(screen.getByRole('combobox'), 'local')
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(tabs()).toHaveLength(2)
    expect(activeTitle()).toMatchObject({ profileId: 'lite', database: 'main' })
  })

  it('moves with the arrow keys and closes on Escape', async () => {
    const { user } = await start()
    await user.keyboard('{Control>}k{/Control}')
    await screen.findByRole('combobox')
    await user.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('option')[1]?.getAttribute('aria-selected')).toBe('true')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(tabs()).toHaveLength(0)
  })
})

describe('tabs', () => {
  it('opens, closes, reopens and jumps with the keyboard', async () => {
    const { user, backend } = await start()
    await user.keyboard('{Control>}t{/Control}')
    await user.keyboard('{Control>}t{/Control}')
    await user.keyboard('{Control>}t{/Control}')
    expect(tabs().map((t) => t.getAttribute('title')?.split(' · ')[0])).toEqual([
      'Query 1',
      'Query 2',
      'Query 3',
    ])
    expect(activeTitle()?.title).toBe('Query 3')

    await user.keyboard('{Control>}1{/Control}')
    expect(activeTitle()?.title).toBe('Query 1')

    await user.keyboard('{Control>}w{/Control}')
    expect(tabs()).toHaveLength(2)
    expect(backend.called('delete_buffer')).toHaveLength(1)

    await user.keyboard('{Control>}{Shift>}t{/Shift}{/Control}')
    expect(tabs()).toHaveLength(3)
    expect(activeTitle()?.title).toBe('Query 1')
  })

  it('a new tab inherits the front tab’s target', async () => {
    const { user } = await start()
    await user.keyboard('{Control>}k{/Control}')
    await user.type(await screen.findByRole('combobox'), 'analytics')
    await user.keyboard('{Enter}')
    await user.keyboard('{Control>}t{/Control}')
    expect(activeTitle()).toMatchObject({ title: 'Query 2', profileId: 'pg', database: 'analytics' })
  })

  it('restores tabs saved by the last session', async () => {
    const backend = fakeBackend({ profiles: [pg], catalog })
    await boot()
    render(<App />)
    const user = userEvent.setup()
    await user.keyboard('{Control>}t{/Control}')
    // A new tab focuses its editor. (No click: jsdom has no layout, so the
    // panel separator's hit test would take the click.)
    expect(document.activeElement?.getAttribute('aria-label')).toBe('SQL editor')
    await user.keyboard('select 42')
    await waitFor(() => expect(backend.called('save_buffer').length).toBeGreaterThan(1), { timeout: 2000 })
    cleanup()
    resetApp()
    await boot()
    render(<App />)
    expect(tabs()).toHaveLength(1)
    expect(screen.getByRole('textbox', { name: 'SQL editor' }).textContent).toBe('select 42')
  })
})

describe('Mod+P goes to an object', () => {
  it('lists the connection’s tables, opens one and shows its rows', async () => {
    const { user, backend } = await start()
    await user.keyboard('{Control>}k{/Control}')
    await user.type(await screen.findByRole('combobox'), 'prod quicksilver')
    await user.keyboard('{Enter}')

    await user.keyboard('{Control>}p{/Control}')
    await user.type(await screen.findByRole('combobox', { name: 'Go to object' }), 'ord')
    const labels = screen.getAllByRole('option').map((o) => o.textContent)
    expect(labels[0]).toContain('sales.orders')
    expect(labels.some((l) => l?.includes('order_total'))).toBe(true)
    await user.keyboard('{Enter}')

    expect(tabs()).toHaveLength(2)
    expect(activeTitle()).toMatchObject({
      title: 'orders',
      sql: 'SELECT * FROM "sales"."orders";\n',
      table: { schema: 'sales', name: 'orders' },
    })
    await waitFor(() => expect(backend.called('run')).toHaveLength(1))
    expect(backend.called('run')[0]?.args.script).toBe('SELECT * FROM "sales"."orders";\n')

    // Going to it again brings its tab forward instead of opening another.
    await user.keyboard('{Control>}t{/Control}')
    expect(tabs()).toHaveLength(3)
    await user.keyboard('{Control>}p{/Control}')
    await user.type(await screen.findByRole('combobox', { name: 'Go to object' }), 'sales.orders')
    await user.keyboard('{Enter}')
    expect(tabs()).toHaveLength(3)
    expect(activeTitle()?.title).toBe('orders')
    expect(backend.called('run')).toHaveLength(1)
  })

  it('is not offered before the tab has a database', async () => {
    const { user } = await start()
    await user.keyboard('{Control>}p{/Control}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('Mod+Shift+P command palette', () => {
  it('lists only commands that can run now, with their shortcuts', async () => {
    const { user } = await start()
    await user.keyboard('{Control>}{Shift>}p{/Shift}{/Control}')
    let options = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '')
    expect(options.some((o) => o.startsWith('New query tab') && o.includes('Ctrl+T'))).toBe(true)
    expect(options.some((o) => o.startsWith('Close tab'))).toBe(false)
    await user.keyboard('{Escape}')

    await user.keyboard('{Control>}t{/Control}')
    await user.keyboard('{Control>}{Shift>}p{/Shift}{/Control}')
    options = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '')
    expect(options.some((o) => o.startsWith('Close tab') && o.includes('Ctrl+W'))).toBe(true)

    await user.type(screen.getByRole('combobox'), 'close tab')
    await user.keyboard('{Enter}')
    expect(tabs()).toHaveLength(0)
  })
})

describe('rebinding', () => {
  it('records new keys, uses them at once and keeps them', async () => {
    const { user, backend } = await start()
    await user.keyboard('{Control>},{/Control}')
    await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    await user.click(screen.getByRole('button', { name: 'Change shortcut for New query tab' }))
    await user.keyboard('{Control>}y{/Control}')
    expect(screen.getByRole('button', { name: 'Change shortcut for New query tab' }).textContent).toBe(
      'Ctrl+Y',
    )

    // A clash is refused and explained.
    await user.click(screen.getByRole('button', { name: 'Change shortcut for Close tab' }))
    await user.keyboard('{Control>}k{/Control}')
    expect(screen.getByRole('status').textContent).toContain('Switch database')
    await user.keyboard('{Escape}')

    await user.click(screen.getByRole('button', { name: 'Done' }))
    await user.keyboard('{Control>}y{/Control}')
    expect(tabs()).toHaveLength(1)
    await user.keyboard('{Control>}t{/Control}')
    expect(tabs()).toHaveLength(1)
    await waitFor(() => expect(backend.called('set_layout').some((c) => c.args.key === 'keymap')).toBe(true))
  })
})

describe('passwords', () => {
  it('asks when none is saved and can save the one typed', async () => {
    const { user, backend } = await start({ profiles: [pg], catalog, needsPassword: new Set(['pg']) })
    await user.keyboard('{Control>}k{/Control}')
    await user.type(await screen.findByRole('combobox'), 'analytics')
    await user.keyboard('{Enter}')

    const prompt = await screen.findByRole('dialog', { name: 'Password for prod-pg' })
    await user.type(within(prompt).getByLabelText('Password'), 'p@ss')
    await user.click(within(prompt).getByRole('button', { name: 'Connect' }))

    await waitFor(() =>
      expect(backend.called('connect_profile').some((c) => c.args.password === 'p@ss')).toBe(true),
    )
    expect(backend.called('update_profile')[0]?.args.password).toEqual({ kind: 'set', password: 'p@ss' })
    await waitFor(() => expect(Object.keys(useApp.getState().sessions).length).toBeGreaterThan(0))
  })
})

describe('editing a connection', () => {
  it('keeps sessions open for a new colour, and reconnects for a new host', async () => {
    const { user, backend } = await start()
    await user.keyboard('{Control>}k{/Control}')
    await user.type(await screen.findByRole('combobox'), 'prod quicksilver')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(Object.keys(useApp.getState().sessions)).toHaveLength(1))
    const { id, createdMs, updatedMs, ...fields } = pg
    await act(() => saveProfile('pg', { ...fields, color: 'blue' }, { kind: 'keep' }))
    expect(backend.called('disconnect')).toHaveLength(0)
    await act(() => saveProfile('pg', { ...fields, host: 'db.internal' }, { kind: 'keep' }))
    expect(backend.called('disconnect')).toHaveLength(1)
  })

  it('says what is wrong instead of saving a bad port', async () => {
    const { user, backend } = await start()
    await user.keyboard('{Control>}{Shift>}n{/Shift}{/Control}')
    const form = await screen.findByRole('dialog', { name: 'New connection' })
    await user.type(within(form).getByLabelText('Name'), 'x')
    await user.type(within(form).getByLabelText('Port'), '99999')
    expect((within(form).getByLabelText('Port') as HTMLInputElement).value).toBe('99999')
    await user.click(within(form).getByRole('button', { name: 'Save' }))
    expect(within(form).getByRole('status').textContent).toBe('The port must be a number from 1 to 65535.')
    expect(backend.called('create_profile')).toHaveLength(0)
  })
})

describe('focus', () => {
  it('Mod+Shift+E focuses the navigator filter', async () => {
    const { user } = await start()
    await act(async () => {
      await user.keyboard('{Control>}{Shift>}e{/Shift}{/Control}')
    })
    expect(document.activeElement?.id).toBe('navigator-filter')
  })
})
