// @vitest-environment jsdom
//
// Finding things and keeping connections in order: searching every
// database, showing what was picked in the navigator, project folders,
// importing from DBeaver, the connection form's URL and file fields, and
// hiding the inspector.

import { clearMocks } from '@tauri-apps/api/mocks'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatUrl } from '../features/connections/url'
import { badFolderName, buildTree, moved, normalPath } from '../features/navigator/projects'
import { boot, resetApp, useApp } from '../state/app'
import { databaseEntry, fakeBackend, objectEntry, profile } from '../test/backend'
import { App } from './App'

const pg = profile('pg', 'prod-pg')
const work = profile('w', 'billing', { project: 'Work/Client A' })
const catalog = [
  databaseEntry('pg', 'quicksilver_dev'),
  objectEntry('pg', 'quicksilver_dev', 'sales', 'orders'),
]

async function start(options: Parameters<typeof fakeBackend>[0] = { profiles: [pg, work], catalog }) {
  const backend = fakeBackend(options)
  await boot()
  const user = userEvent.setup()
  render(<App />)
  return { backend, user }
}

const tree = () => screen.getByRole('tree', { name: 'Connections' })
const row = (name: string) => within(tree()).findByText(name, { selector: '[role=treeitem] *' })

beforeEach(() => resetApp())
afterEach(() => {
  cleanup()
  clearMocks()
})

describe('project folders', () => {
  it('nest to any depth, from "/"-joined paths', () => {
    const root = buildTree(
      [work, profile('x', 'api', { project: 'Work/Client A/Backend' }), pg],
      ['Personal'],
    )
    expect(root.folders.map((f) => f.path)).toEqual(['Personal', 'Work'])
    const clientA = root.folders[1]?.folders[0]
    expect(clientA?.path).toBe('Work/Client A')
    expect(clientA?.profiles.map((p) => p.name)).toEqual(['billing'])
    expect(clientA?.folders[0]?.profiles.map((p) => p.name)).toEqual(['api'])
    expect(root.profiles.map((p) => p.name)).toEqual(['prod-pg'])
  })

  it('move and rename by path, and refuse names with "/"', () => {
    expect(normalPath(' Work / A/ ')).toBe('Work/A')
    expect(moved('Work/A/B', 'Work/A', 'Home')).toBe('Home/B')
    expect(moved('Work/AB', 'Work/A', 'Home')).toBe('Work/AB')
    expect(moved('Work/A', 'Work/A', null)).toBeNull()
    expect(badFolderName('a/b')).toMatch('/')
  })

  it('show in the navigator, and take new folders and moved connections', async () => {
    const { user, backend } = await start()
    expect(await row('Work')).toBeTruthy()
    expect(await row('Client A')).toBeTruthy()
    expect(await row('billing')).toBeTruthy()

    act(() => screen.getByRole('button', { name: 'Add' }).focus())
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('menuitem', { name: 'New folder…' }))
    const dialog = await screen.findByRole('dialog', { name: 'New folder' })
    await user.type(within(dialog).getByRole('textbox'), 'Personal')
    await user.keyboard('{Enter}')
    expect(await row('Personal')).toBeTruthy()
    expect(useApp.getState().folders).toEqual(['Personal'])

    fireEvent.contextMenu(await row('prod-pg'))
    await user.click(await screen.findByRole('menuitem', { name: 'Move to folder…' }))
    const move = await screen.findByRole('dialog', { name: 'Move prod-pg' })
    await user.type(within(move).getByRole('combobox'), 'Personal/Side')
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(useApp.getState().profiles.find((p) => p.id === 'pg')?.project).toBe('Personal/Side'),
    )
    expect(backend.called('update_profile').at(-1)?.args).toMatchObject({
      fields: { project: 'Personal/Side' },
    })
    expect(backend.called('disconnect')).toHaveLength(0)
  })
})

describe('finding tables', () => {
  it('Mod+P reads every database, finds a table in one never opened, and shows it in the navigator', async () => {
    const { user, backend } = await start()
    await user.keyboard('{Control>}k{/Control}')
    await user.type(await screen.findByRole('combobox'), 'prod quicksilver')
    await user.keyboard('{Enter}')

    await user.keyboard('{Control>}p{/Control}')
    await waitFor(() => expect(backend.called('index_database')).toHaveLength(3))
    // The tab's own database is read first.
    expect(backend.called('index_database')[0]?.args.database).toBe('quicksilver_dev')
    await waitFor(() => expect(useApp.getState().catalog.map((e) => e.name)).toContain('staging_events'))
    await user.type(await screen.findByRole('combobox', { name: 'Go to object' }), 'staging_ev')
    await waitFor(() =>
      expect(screen.getAllByRole('option')[0]?.textContent).toContain('public.staging_events'),
    )
    await user.keyboard('{Enter}')

    // Shown in the navigator: picked, with every level above it open. (The fake's
    // schema listing does not hold the indexed table, so the row itself is not drawn.)
    await waitFor(() =>
      expect(useApp.getState().current).toBe('c:pg/d:staging/s:public/o:table:staging_events'),
    )
    expect(useApp.getState().expanded).toMatchObject({
      'c:pg': true,
      'c:pg/d:staging': true,
      'c:pg/d:staging/s:public': true,
      'c:pg/d:staging/s:public/g:tables': true,
    })
    expect(useApp.getState().tabs.at(-1)).toMatchObject({ database: 'staging', title: 'staging_events' })
  })

  it('the navigator filter finds tables from the index without opening each database', async () => {
    const { user } = await start({
      profiles: [pg],
      catalog: [...catalog, objectEntry('pg', 'analytics', 'public', 'page_views')],
    })
    act(() => document.getElementById('navigator-filter')?.focus())
    await user.keyboard('page_v')
    expect(await row('page_views')).toBeTruthy()
    expect(await row('analytics')).toBeTruthy()
    expect(Object.keys(useApp.getState().sessions)).toHaveLength(0)
  })
})

describe('importing from DBeaver', () => {
  it('is offered on first run and brings connections in, folders and all', async () => {
    const { user, backend } = await start({ profiles: [], catalog: [] })
    await user.click(await screen.findByRole('button', { name: 'Import 2 connections from DBeaver' }))
    const dialog = await screen.findByRole('dialog', { name: 'Import from DBeaver' })
    expect(await within(dialog).findByText('Work / Client A')).toBeTruthy()
    expect(within(dialog).getByText('Skipped: elasticsearch connections are not supported')).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Import 2 connections' }))

    await waitFor(() => expect(backend.called('dbeaver_import')).toHaveLength(1))
    expect(backend.called('dbeaver_import')[0]?.args).toMatchObject({ passwords: true })
    expect(await row('Orders')).toBeTruthy()
    expect(await row('Client A')).toBeTruthy()
    expect(useApp.getState().message?.text).toBe('Imported 2 connections from DBeaver.')
  })

  it('stays in the command palette after the first run', async () => {
    const { user } = await start()
    await user.keyboard('{Control>}{Shift>}p{/Shift}{/Control}')
    await user.type(await screen.findByRole('combobox'), 'dbeaver')
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('dialog', { name: 'Import from DBeaver' })).toBeTruthy()
  })
})

describe('the connection form', () => {
  it('fills the fields from a pasted URL, JDBC too, and keeps the URL in step', async () => {
    const { user } = await start()
    await user.keyboard('{Control>}{Shift>}n{/Shift}{/Control}')
    const form = await screen.findByRole('dialog', { name: 'New connection' })
    const url = within(form).getByLabelText('URL') as HTMLInputElement
    act(() => url.focus())
    await user.paste('jdbc:postgresql://db.example.com:6543/orders?user=app&password=pw')
    await waitFor(() =>
      expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe('orders'),
    )
    expect((within(form).getByLabelText('Port') as HTMLInputElement).value).toBe('6543')
    expect((within(form).getByLabelText('User') as HTMLInputElement).value).toBe('app')
    expect((within(form).getByLabelText('Password to save') as HTMLInputElement).value).toBe('pw')

    // Editing a field rewrites the URL; it never shows the password.
    act(() => url.blur())
    await user.clear(within(form).getByLabelText('Database'))
    await user.type(within(form).getByLabelText('Database'), 'billing')
    expect(url.value).toBe('postgres://app@db.example.com:6543/billing')

    // A URL that cannot be read is said beside it and left as typed.
    act(() => url.focus())
    await user.paste('not a url')
    expect(await within(form).findByText(/not a connection URL/)).toBeTruthy()
    expect(url.value).toBe('not a url')
  })

  it('chooses a database file with the OS file chooser', async () => {
    const { user } = await start()
    await user.keyboard('{Control>}{Shift>}n{/Shift}{/Control}')
    const form = await screen.findByRole('dialog', { name: 'New connection' })
    await user.selectOptions(within(form).getByLabelText('Engine'), 'sqlite')
    await user.click(within(form).getByRole('button', { name: 'Choose…' }))
    await waitFor(() =>
      expect((within(form).getByLabelText('File') as HTMLInputElement).value).toBe(
        '/Users/me/data/app.sqlite',
      ),
    )
    expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe('app.sqlite')
  })

  it('writes URLs from fields', () => {
    const fields = { ...profile('', 'x'), user: 'alice@corp', sslMode: 'require' as const }
    expect(formatUrl(fields)).toBe('postgres://alice%40corp@127.0.0.1:15432/quicksilver_dev?sslmode=require')
    expect(formatUrl({ ...fields, engine: 'sqlite', path: '/tmp/my db.sqlite' })).toBe(
      'sqlite:///tmp/my%20db.sqlite',
    )
  })
})

describe('the inspector', () => {
  it('hides from its own button and comes back from the title bar', async () => {
    const { user } = await start()
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    await user.click(within(inspector).getByRole('button', { name: 'Hide the inspector' }))
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull()
    expect(useApp.getState().panels.inspector).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Show the inspector' }))
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeTruthy()
  })
})
