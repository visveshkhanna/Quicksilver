// @vitest-environment jsdom
//
// Safe editing, end to end against the fake backend: edits go to a draft,
// the draft is reviewed as the exact statements the service generated, and
// a read-write connection asks before a schema change.

import { clearMocks } from '@tauri-apps/api/mocks'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { editorFor } from '../features/editor/registry'
import { boot, resetApp, useApp } from '../state/app'
import { databaseEntry, fakeBackend, objectEntry, profile } from '../test/backend'
import { App } from './App'

const pg = profile('pg', 'prod-pg')
const catalog = [
  databaseEntry('pg', 'quicksilver_dev'),
  objectEntry('pg', 'quicksilver_dev', 'sales', 'orders'),
]

const tab = () => {
  const s = useApp.getState()
  const found = s.tabs.find((t) => t.id === s.activeTabId)
  if (!found) throw new Error('no front tab')
  return found
}
const gridCursor = () => screen.getByTestId('grid-cursor').textContent

async function start(sql = 'select * from people') {
  const backend = fakeBackend({ profiles: [pg], catalog })
  await boot()
  const user = userEvent.setup()
  render(<App />)
  await user.keyboard('{Control>}k{/Control}')
  await user.type(await screen.findByRole('combobox'), 'quicksilver')
  await user.keyboard('{Enter}')
  await waitFor(() => expect(Object.keys(useApp.getState().sessions).length).toBeGreaterThan(0))
  const view = editorFor(tab().id)
  act(() => {
    view?.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: sql },
      selection: { anchor: sql.length },
    })
  })
  await user.keyboard('{Control>}{Enter}{/Control}')
  return { backend, user }
}

/** Runs the people query and focuses the grid once its rows can be edited. */
async function editable() {
  const started = await start()
  await screen.findByText(/Editable · rows named by primary key/)
  await started.user.keyboard('{Control>}j{/Control}')
  return started
}

beforeEach(() => resetApp())
afterEach(() => {
  cleanup()
  clearMocks()
})

describe('editing cells', () => {
  it('edits a cell into the draft, reviews the statements and saves them', async () => {
    const { user, backend } = await editable()
    await user.keyboard('{ArrowDown}{ArrowRight}{Enter}')
    const input = await screen.findByRole('textbox', { name: 'New value for name' })
    expect((input as HTMLInputElement).value).toBe('b')
    await user.keyboard('{Control>}a{/Control}zed{Enter}')
    // Enter keeps the value and moves down.
    await waitFor(() => expect(gridCursor()).toBe('Row 2 of 3, name: c'))
    await user.keyboard('{ArrowUp}')
    await waitFor(() => expect(gridCursor()).toBe('Row 1 of 3, name: zed (edited)'))
    expect(screen.getByText('1 unsaved change')).toBeTruthy()

    await user.keyboard('{Control>}s{/Control}')
    const review = await screen.findByRole('dialog', { name: 'Review changes' })
    expect(backend.called('preview_edits').at(-1)?.args.edits).toEqual([
      { kind: 'update', row: 0, set: [{ column: 1, value: 'zed' }] },
    ])
    expect(within(review).getByText('UPDATE row 0;')).toBeTruthy()
    expect(backend.called('apply_edits')).toHaveLength(0)

    const runs = backend.called('run').length
    await user.click(within(review).getByRole('button', { name: 'Save in one transaction' }))
    await waitFor(() => expect(backend.called('apply_edits')).toHaveLength(1))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(tab().draft).toBeNull()
    // The query only reads, so it runs again to show the saved rows.
    await waitFor(() => expect(backend.called('run').length).toBe(runs + 1))
  })

  it('typing on a cell replaces its value', async () => {
    const { user } = await editable()
    await user.keyboard('{ArrowDown}{ArrowRight}q')
    const input = await screen.findByRole('textbox', { name: 'New value for name' })
    expect((input as HTMLInputElement).value).toBe('q')
    await user.keyboard('rs{Enter}')
    await waitFor(() => expect(tab().draft?.updates).toEqual({ 0: { 1: 'qrs' } }))
  })

  it('Escape cancels an edit and setting a value back forgets it', async () => {
    const { user } = await editable()
    await user.keyboard('{ArrowDown}{ArrowRight}{Enter}')
    await screen.findByRole('textbox', { name: 'New value for name' })
    await user.keyboard('{Control>}a{/Control}nope{Escape}')
    expect(screen.queryByRole('textbox', { name: 'New value for name' })).toBeNull()
    expect(tab().draft).toBeNull()

    await user.keyboard('{Enter}{Control>}a{/Control}x{Enter}{ArrowUp}')
    await waitFor(() => expect(tab().draft).not.toBeNull())
    await user.keyboard('{Enter}{Control>}a{/Control}b{Enter}')
    await waitFor(() => expect(tab().draft).toBeNull())
  })

  it('names rows by where they arrived, even after sorting', async () => {
    const { user, backend } = await editable()
    const grid = screen.getByRole('grid', { name: 'Result rows' })
    fireEvent.contextMenu(grid, { clientX: 60, clientY: 10 })
    await user.click(await screen.findByRole('menuitem', { name: 'Sort descending' }))
    await waitFor(() => expect(backend.called('sort_result')).toHaveLength(1))
    grid.focus()
    await user.keyboard('{ArrowDown}')
    await waitFor(() => expect(gridCursor()).toBe('Row 1 of 3, id: 10'))
    // Rows 1 and 2 shown are rows 1 and 0 as they arrived.
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}{Control>}{Backspace}{/Control}')
    await waitFor(() => expect(tab().draft?.deletes).toEqual([0, 1]))
    expect(gridCursor()).toContain('row marked for deletion')

    // That row's name is already NULL, so setting it to NULL changes nothing;
    // its id does change.
    await user.keyboard('{ArrowDown}{ArrowRight}{Control>}{Shift>}{Backspace}{/Shift}{/Control}')
    expect(tab().draft?.updates).toEqual({})
    await user.keyboard('{ArrowLeft}{Control>}{Shift>}{Backspace}{/Shift}{/Control}')
    await waitFor(() => expect(tab().draft?.updates).toEqual({ 2: { 0: null } }))
    expect(screen.getByText('3 unsaved changes')).toBeTruthy()

    await user.keyboard('{Control>}s{/Control}')
    await screen.findByRole('dialog', { name: 'Review changes' })
    expect(backend.called('preview_edits').at(-1)?.args.edits).toEqual([
      { kind: 'update', row: 2, set: [{ column: 0, value: null }] },
      { kind: 'delete', row: 0 },
      { kind: 'delete', row: 1 },
    ])
  })

  it('adds a row through the form, leaving empty columns to their defaults', async () => {
    const { user, backend } = await editable()
    await user.click(screen.getByRole('button', { name: 'Add row' }))
    const form = await screen.findByRole('dialog', { name: 'Add a row to people' })
    await user.type(within(form).getByLabelText(/^id/), '7')
    await user.click(within(form).getAllByRole('checkbox')[1] as HTMLElement)
    await user.click(within(form).getByRole('button', { name: 'Add to changes' }))
    expect(tab().draft?.inserts).toEqual([{ 0: '7', 1: null }])
    await user.keyboard('{Control>}s{/Control}')
    await screen.findByRole('dialog', { name: 'Review changes' })
    expect(backend.called('preview_edits').at(-1)?.args.edits).toEqual([
      {
        kind: 'insert',
        values: [
          { column: 0, value: '7' },
          { column: 1, value: null },
        ],
      },
    ])
  })

  it('says why rows cannot be edited', async () => {
    const { user } = await start('select computed from people')
    expect(await screen.findByText(/Read only: a column is computed/)).toBeTruthy()
    await user.keyboard('{Control>}j{/Control}{ArrowDown}{Enter}')
    expect(screen.queryByRole('textbox', { name: /New value/ })).toBeNull()
    expect(screen.getByText(/These rows cannot be edited/)).toBeTruthy()
  })
})

describe('unsaved changes', () => {
  /** Edits the name in the first row, leaving the grid focused. */
  async function withChange() {
    const started = await editable()
    await started.user.keyboard('{ArrowDown}{ArrowRight}{Enter}{Control>}a{/Control}zed{Enter}')
    await waitFor(() => expect(tab().draft).not.toBeNull())
    return started
  }

  it('asks before a run throws them away', async () => {
    const { user, backend } = await withChange()
    const runs = backend.called('run').length
    await user.keyboard('{Control>}{Enter}{/Control}')
    const ask = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }))
    expect(tab().draft).not.toBeNull()
    expect(backend.called('run')).toHaveLength(runs)

    await user.keyboard('{Control>}{Enter}{/Control}')
    await user.click(await screen.findByRole('button', { name: 'Discard changes' }))
    await waitFor(() => expect(backend.called('run')).toHaveLength(runs + 1))
    expect(tab().draft).toBeNull()
  })

  it('asks before the tab closes', async () => {
    const { user } = await withChange()
    const id = tab().id
    await user.keyboard('{Control>}w{/Control}')
    const ask = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }))
    expect(useApp.getState().tabs.some((t) => t.id === id)).toBe(true)
  })

  it('reviews the cell still being edited, and can take one change back out', async () => {
    const { user, backend } = await withChange()
    // Mark row 2 for deletion, then start editing row 3 and save mid-edit.
    await user.keyboard(
      '{Control>}{Backspace}{/Control}{ArrowDown}{Enter}{Control>}a{/Control}new{Control>}s{/Control}',
    )
    const review = await screen.findByRole('dialog', { name: 'Review changes' })
    expect(backend.called('preview_edits').at(-1)?.args.edits).toEqual([
      { kind: 'update', row: 0, set: [{ column: 1, value: 'zed' }] },
      { kind: 'update', row: 2, set: [{ column: 1, value: 'new' }] },
      { kind: 'delete', row: 1 },
    ])
    await user.click(within(review).getAllByRole('button', { name: 'Undo' })[2] as HTMLElement)
    await waitFor(() =>
      expect(backend.called('preview_edits').at(-1)?.args.edits).toEqual([
        { kind: 'update', row: 0, set: [{ column: 1, value: 'zed' }] },
        { kind: 'update', row: 2, set: [{ column: 1, value: 'new' }] },
      ]),
    )
    await user.click(within(review).getByRole('button', { name: 'Save in one transaction' }))
    await waitFor(() => expect(backend.called('apply_edits')).toHaveLength(1))
    expect(backend.called('apply_edits')[0]?.args.edits).toHaveLength(2)
  })
})

describe('connection modes', () => {
  it('asks before a script that changes the schema and runs it once confirmed', async () => {
    const { user, backend } = await start('create table x (a int)')
    const confirm = await screen.findByRole('dialog', { name: 'Change the schema?' })
    expect(within(confirm).getByText('create table x (a int);')).toBeTruthy()
    expect(backend.called('run').at(-1)?.args.confirmed).toBe(false)
    await user.click(within(confirm).getByRole('button', { name: 'Run the script' }))
    await waitFor(() => expect(backend.called('run').at(-1)?.args.confirmed).toBe(true))
  })

  it('does not run when the question is declined, and keeps the last results', async () => {
    const { user, backend } = await start()
    await screen.findByRole('grid', { name: 'Result rows' })
    const view = editorFor(tab().id)
    act(() => {
      view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'drop table x' } })
    })
    await user.keyboard('{Control>}{Enter}{/Control}')
    const confirm = await screen.findByRole('dialog', { name: 'Change the schema?' })
    const runs = backend.called('run').length
    await user.click(within(confirm).getByRole('button', { name: 'Don’t run' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(backend.called('run')).toHaveLength(runs)
    expect(screen.getByRole('grid', { name: 'Result rows' })).toBeTruthy()
    expect(backend.called('close_result')).toHaveLength(0)
  })
})

describe('the filter bar', () => {
  it('uses the query built and gated in Rust, and shows a refusal', async () => {
    const { user, backend } = await start()
    await user.keyboard('{Control>}p{/Control}')
    await user.type(await screen.findByRole('combobox', { name: 'Go to object' }), 'orders')
    await user.keyboard('{Enter}')
    const filter = await screen.findByRole('textbox', { name: 'Filter rows' })
    // Opening the table built its query in Rust and ran it.
    const opened = 'SELECT * FROM "sales"."orders";\n'
    await waitFor(() => expect(backend.called('run').at(-1)?.args.script).toBe(opened))
    expect(backend.called('filter_query')).toHaveLength(1)
    act(() => filter.focus())
    await user.keyboard('1 = 1; delete from orders{Enter}')
    await waitFor(() => expect(backend.called('filter_query')).toHaveLength(2))
    expect(await screen.findByText(/That filter cannot be used/)).toBeTruthy()
    expect(backend.called('run').at(-1)?.args.script).toBe(opened)
  })
})
