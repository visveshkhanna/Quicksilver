// @vitest-environment jsdom
//
// The editor, the grid and the plan, end to end against the fake backend.
// jsdom has no layout or canvas, so the grid is driven by keyboard and its
// screen-reader description is what the tests read.

import { clearMocks } from '@tauri-apps/api/mocks'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { editorFor } from '../features/editor/registry'
import { boot, ROW_CAP, resetApp, useApp } from '../state/app'
import { databaseEntry, fakeBackend, objectEntry, profile } from '../test/backend'
import { App } from './App'

const pg = profile('pg', 'prod-pg')
const catalog = [
  databaseEntry('pg', 'quicksilver_dev'),
  objectEntry('pg', 'quicksilver_dev', 'sales', 'orders'),
]

async function start() {
  const backend = fakeBackend({ profiles: [pg], catalog })
  await boot()
  const user = userEvent.setup()
  render(<App />)
  // A tab on the database, with its editor focused.
  await user.keyboard('{Control>}k{/Control}')
  await user.type(await screen.findByRole('combobox'), 'quicksilver')
  await user.keyboard('{Enter}')
  await waitFor(() => expect(Object.keys(useApp.getState().sessions).length).toBeGreaterThan(0))
  return { backend, user }
}

const tab = () => {
  const s = useApp.getState()
  const found = s.tabs.find((t) => t.id === s.activeTabId)
  if (!found) throw new Error('no front tab')
  return found
}
const editorText = () => screen.getByRole('textbox', { name: 'SQL editor' }).textContent
const gridCursor = () => screen.getByTestId('grid-cursor').textContent

/** Replaces the editor's text and puts the cursor at `cursor` (the end by default). */
function setEditor(text: string, cursor = text.length, head = cursor) {
  const view = editorFor(tab().id)
  if (!view) throw new Error('no editor')
  act(() => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: cursor, head },
    })
  })
}

beforeEach(() => resetApp())
afterEach(() => {
  cleanup()
  clearMocks()
})

describe('running', () => {
  it('runs the statement under the cursor and pages its rows into the grid', async () => {
    const { user, backend } = await start()
    setEditor('select 1;\nselect * from people')
    await user.keyboard('{Control>}{Enter}{/Control}')

    await waitFor(() => expect(backend.called('run').at(-1)?.args.script).toBe('select * from people'))
    expect(backend.called('run').at(-1)?.args.rowCap).toBe(ROW_CAP)
    const grid = await screen.findByRole('grid', { name: 'Result rows' })
    await waitFor(() => expect(grid.getAttribute('aria-rowcount')).toBe('3'))
    expect(screen.getByRole('status').textContent).toContain('3 rows')
    expect(gridCursor()).toBe('3 rows, 2 columns')
  })

  it('runs only the selection when there is one', async () => {
    const { user, backend } = await start()
    setEditor('select * from a; select * from b', 0, 15)
    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(backend.called('run').at(-1)?.args.script).toBe('select * from a'))
  })

  it('marks where an error points in the editor', async () => {
    const { user } = await start()
    setEditor('select error from t')
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect((await screen.findByRole('alert')).textContent).toContain('column "error" does not exist')
    await waitFor(() => expect(document.querySelector('.cm-error-at')?.textContent).toBe('error'))
    // Typing clears it: the text it was about has changed.
    setEditor('select fine from t')
    expect(document.querySelector('.cm-error-at')).toBeNull()
  })

  it('says when the row cap stopped a result and can run again without it', async () => {
    const { user, backend } = await start()
    setEditor('select * from many')
    await user.keyboard('{Control>}{Enter}{/Control}')
    const notice = await screen.findByText(`Stopped at ${ROW_CAP.toLocaleString()} rows`, { exact: false })
    await user.click(within(notice).getByRole('button', { name: 'Run again without the limit' }))
    await waitFor(() => expect(backend.called('run').at(-1)?.args.rowCap).toBeNull())
    expect(backend.called('run').at(-1)?.args.script).toBe('select * from many')
  })
})

describe('the grid', () => {
  async function withRows() {
    const started = await start()
    setEditor('select * from people')
    await started.user.keyboard('{Control>}{Enter}{/Control}')
    const grid = await screen.findByRole('grid', { name: 'Result rows' })
    await waitFor(() => expect(grid.getAttribute('aria-rowcount')).toBe('3'))
    return { ...started, grid }
  }

  it('moves a cell cursor with the keyboard and copies the selection as TSV', async () => {
    const { user, backend } = await withRows()
    // Mod+J moves focus from the editor to the results.
    await user.keyboard('{Control>}j{/Control}')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Result rows')
    await user.keyboard('{ArrowDown}')
    await waitFor(() => expect(gridCursor()).toBe('Row 1 of 3, id: 2'))
    await user.keyboard('{ArrowDown}{ArrowRight}')
    await waitFor(() => expect(gridCursor()).toBe('Row 2 of 3, name: c'))
    await user.keyboard('{Shift>}{ArrowUp}{ArrowLeft}{/Shift}')

    await user.keyboard('{Control>}c{/Control}')
    await waitFor(() => expect(backend.called('copy_rows')).toHaveLength(1))
    expect(backend.called('copy_rows')[0]?.args).toMatchObject({
      offset: 0,
      count: 2,
      columns: [0, 1],
      format: { kind: 'tsv', header: false },
    })
    expect(await navigator.clipboard.readText()).toBe('2\tb\n10\tc\n')

    await user.keyboard('{Control>}{Shift>}c{/Shift}{/Control}')
    await waitFor(() => expect(backend.called('copy_rows')).toHaveLength(2))
    expect(await navigator.clipboard.readText()).toBe('id\tname\n2\tb\n10\tc\n')

    // Mod+J goes back to the editor.
    await user.keyboard('{Control>}j{/Control}')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('SQL editor')
  })

  it('shows the cursor row in the inspector as the cursor moves', async () => {
    const { user } = await withRows()
    await user.keyboard('{Control>}j{/Control}{ArrowDown}{ArrowDown}{ArrowDown}')
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    await waitFor(() => expect(within(inspector).getByText('NULL')).toBeTruthy())
    await user.keyboard('{ArrowUp}')
    await waitFor(() => expect(within(inspector).getByText('c')).toBeTruthy())
  })

  it('is as it was left after switching tabs, and re-running keeps focus in it', async () => {
    const { user, backend } = await withRows()
    await user.keyboard('{Control>}j{/Control}{ArrowDown}{ArrowDown}{ArrowRight}')
    await waitFor(() => expect(gridCursor()).toBe('Row 2 of 3, name: c'))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    await user.keyboard('{Control>}t{/Control}')
    // Another tab's row is not left in the inspector.
    expect(within(inspector).queryByText('c')).toBeNull()
    await user.keyboard('{Control>}1{/Control}')
    await waitFor(() => expect(gridCursor()).toBe('Row 2 of 3, name: c'))

    act(() => screen.getByRole('grid', { name: 'Result rows' }).focus())
    const runs = backend.called('run').length
    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(backend.called('run')).toHaveLength(runs + 1))
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Result rows'))
  })

  it('sorts from the header menu and refetches in the new order', async () => {
    const { user, backend, grid } = await withRows()
    // The header is the top 28px; the first column starts after the gutter.
    fireEvent.contextMenu(grid, { clientX: 60, clientY: 10 })
    await user.click(await screen.findByRole('menuitem', { name: 'Sort descending' }))
    await waitFor(() =>
      expect(backend.called('sort_result').at(-1)?.args).toMatchObject({
        column: 0,
        direction: 'descending',
      }),
    )
    grid.focus()
    await user.keyboard('{ArrowDown}')
    await waitFor(() => expect(gridCursor()).toBe('Row 1 of 3, id: 10'))

    fireEvent.contextMenu(grid, { clientX: 60, clientY: 10 })
    await user.click(await screen.findByRole('menuitem', { name: 'Back to the order rows arrived in' }))
    await waitFor(() => expect(backend.called('sort_result').at(-1)?.args.column).toBeNull())
  })

  it('copies as INSERT statements from the cell menu', async () => {
    const { user, backend, grid } = await withRows()
    fireEvent.contextMenu(grid, { clientX: 60, clientY: 40 })
    await user.click(await screen.findByRole('menuitem', { name: 'Copy as INSERT statements' }))
    await waitFor(() =>
      expect(backend.called('copy_rows').at(-1)?.args.format).toEqual({
        kind: 'insert',
        table: 'table_name',
      }),
    )
  })
})

describe('table tabs', () => {
  it('filters with the WHERE bar, showing the query it runs', async () => {
    const { user, backend } = await start()
    await user.keyboard('{Control>}p{/Control}')
    await user.type(await screen.findByRole('combobox', { name: 'Go to object' }), 'orders')
    await user.keyboard('{Enter}')
    const filter = await screen.findByRole('textbox', { name: 'Filter rows' })
    // Focus rather than click: jsdom has no layout, so the panel separator's
    // hit test would take the click.
    act(() => filter.focus())
    await user.keyboard('id > 1{Enter}')
    const expected = 'SELECT * FROM "sales"."orders" WHERE id > 1;\n'
    await waitFor(() => expect(backend.called('run').at(-1)?.args.script).toBe(expected))
    expect(tab().sql).toBe(expected)
    expect(editorText()).toBe(expected.trimEnd())

    act(() => filter.focus())
    await user.keyboard('{Control>}a{/Control}{Backspace}order by id desc{Enter}')
    await waitFor(() =>
      expect(backend.called('run').at(-1)?.args.script).toBe(
        'SELECT * FROM "sales"."orders" order by id desc;\n',
      ),
    )
  })
})

describe('explain and format', () => {
  it('explains the statement under the cursor without running it', async () => {
    const { user, backend } = await start()
    setEditor('select * from orders where id > 1')
    await user.keyboard('{Control>}e{/Control}')
    await waitFor(() =>
      expect(backend.called('explain').at(-1)?.args.statement).toBe('select * from orders where id > 1'),
    )
    expect(backend.called('run')).toHaveLength(0)
    const plan = await screen.findByRole('region', { name: 'Query plan' })
    expect(within(plan).getByText('Seq Scan on orders')).toBeTruthy()
    await user.click(within(plan).getByRole('button', { name: /Seq Scan on orders/ }))
    expect(within(plan).getByText('(id > 1)')).toBeTruthy()
  })

  it('formats only on command, as one undoable change', async () => {
    const { user } = await start()
    setEditor('select a, b from t where a = 1')
    await user.keyboard('{Control>}{Shift>}f{/Shift}{/Control}')
    await waitFor(() => expect(tab().sql).toContain('\n'))
    expect(tab().sql).toMatch(/^select\n {2}a,\n {2}b\nfrom\n {2}t\nwhere\n {2}a = 1$/)
    await user.keyboard('{Control>}z{/Control}')
    await waitFor(() => expect(tab().sql).toBe('select a, b from t where a = 1'))
  })
})

describe('navigator', () => {
  it('copies an object’s DDL', async () => {
    const { user, backend } = await start()
    const tree = screen.getByRole('tree', { name: 'Connections' })
    const node = (name: string) => within(tree).findByText(name, { selector: '[role=treeitem] *' })
    await user.click(await node('prod-pg'))
    await user.click(await node('quicksilver_dev'))
    await user.click(await node('sales'))
    await user.click(await node('Tables'))
    fireEvent.contextMenu(await node('orders'))
    await user.click(await screen.findByRole('menuitem', { name: 'Copy DDL' }))
    await waitFor(() => expect(backend.called('object_ddl')).toHaveLength(1))
    expect(await navigator.clipboard.readText()).toBe('CREATE TABLE "sales"."orders" (id int);\n')
  })
})
