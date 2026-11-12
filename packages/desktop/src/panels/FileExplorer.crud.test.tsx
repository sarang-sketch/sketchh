// The Explorer's file operations and the editor's close prompts, end to end: the real
// panel, the real reducer, the real engine methods, a real temporary folder.
//
// In user terms: New File creates the file (and its folders) on disk and opens it;
// Rename renames it on disk and the open tab follows; Delete asks, and when there is
// no trash it asks again before deleting for good; closing a tab with unsaved edits
// asks Save / Don't Save / Cancel and does exactly what was chosen.

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FileExplorer } from './FileExplorer'
import { ConfirmProvider } from '../components/ConfirmDialog'
import { FileIoProvider } from '../editor/FileIoProvider'
import { useFileActions } from '../editor/useFileActions'
import { SketchClientProvider } from '../lib/ClientProvider'
import type { FsDeleteResult, SketchClient } from '../lib/client'
import { AppStateProvider, useAppDispatch, useAppState } from '../state/AppState'
import { canonical, engineClient, nodeFileIo } from '../test/engineHarness'

const dirs: string[] = []
afterEach(async () => {
  cleanup()
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

async function project(files: Record<string, string> = {}): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sketch-explorer-')))
  dirs.push(root)
  for (const [rel, content] of Object.entries(files)) await writeFile(join(root, rel), content)
  return root
}

const exists = (path: string) => stat(path).then(() => true, () => false)

/** The open tabs, as the one state owner has them. */
function Tabs() {
  const state = useAppState()
  return (
    <>
      <ul data-testid="tabs">{state.openFiles.map((p) => <li key={p}>{p}{state.files[p]?.isDirty ? ' *' : ''}</li>)}</ul>
      <div data-testid="notice">{state.editorNotice?.message ?? ''}</div>
    </>
  )
}

/** Buttons that call the real file actions, for the close-prompt tests. */
function Controls({ path }: { path: string }) {
  const actions = useFileActions()
  const dispatch = useAppDispatch()
  return (
    <>
      <button onClick={() => void actions.openPath(path)}>open</button>
      <button onClick={() => dispatch({ type: 'UPDATE_FILE_CONTENT', payload: { path, content: 'my unsaved edit' } })}>edit</button>
      <button onClick={() => void actions.closePath(path)}>close</button>
    </>
  )
}

function mount(root: string, client: SketchClient, extra?: React.ReactNode) {
  return render(
    <SketchClientProvider client={client}>
      <AppStateProvider initial={{ projectRoot: canonical(root), mode: 'ide' }}>
        <FileIoProvider io={nodeFileIo()}>
          <ConfirmProvider>
            <FileExplorer />
            <Tabs />
            {extra}
          </ConfirmProvider>
        </FileIoProvider>
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

function tabs(): string[] {
  return Array.from(screen.getByTestId('tabs').querySelectorAll('li')).map((li) => li.textContent ?? '')
}

describe('the Explorer', () => {
  it('creates a file, with its folders, and opens it', async () => {
    const root = await project({ 'README.md': '# hi' })
    mount(root, engineClient())
    await screen.findByText('README.md')

    fireEvent.click(screen.getByRole('button', { name: 'New file' }))
    const input = await screen.findByLabelText(/File name/)
    fireEvent.change(input, { target: { value: 'src/util.ts' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect({ tabs: tabs(), notice: screen.getByTestId('notice').textContent }).toEqual({ tabs: [`${canonical(root)}/src/util.ts`], notice: '' }))
    expect(await readFile(join(root, 'src', 'util.ts'), 'utf8')).toBe('')
    // The tree re-read the root on its own and shows the new folder.
    await screen.findByText('src')
  })

  it('renames a file on disk and the open tab follows', async () => {
    const root = await project({ 'old.ts': 'export const x = 1\n' })
    mount(root, engineClient(), <Controls path={`${canonical(root)}/old.ts`} />)
    fireEvent.click(screen.getByText('open'))
    await waitFor(() => expect(tabs()).toEqual([`${canonical(root)}/old.ts`]))

    fireEvent.contextMenu(await screen.findByText('old.ts'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Rename/ }))
    const input = await screen.findByLabelText('New name')
    fireEvent.change(input, { target: { value: 'new.ts' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(tabs()).toEqual([`${canonical(root)}/new.ts`]))
    expect(await exists(join(root, 'old.ts'))).toBe(false)
    expect(await readFile(join(root, 'new.ts'), 'utf8')).toBe('export const x = 1\n')
  })

  it('asks before deleting, and asks again before deleting for good when there is no trash', async () => {
    const root = await project({ 'gone.txt': 'bye' })
    const base = engineClient()
    // No real Recycle Bin in a test: the trash is "unavailable", so the permanent path runs.
    const client = engineClient({
      fsDelete: async (p): Promise<FsDeleteResult> =>
        p.trash === false ? base.fsDelete!(p) : { deleted: false, trashUnavailable: true, message: 'There is no trash in this test.' },
    })
    mount(root, client)
    const row = await screen.findByText('gone.txt')
    fireEvent.keyDown(row.closest('[role="treeitem"]')!, { key: 'Delete' })

    fireEvent.click(await screen.findByRole('button', { name: 'Move to Trash' }))
    expect(await screen.findByText(/Delete gone.txt permanently/)).toBeTruthy()
    expect(await exists(join(root, 'gone.txt'))).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Delete Permanently' }))
    await waitFor(async () => expect(await exists(join(root, 'gone.txt'))).toBe(false))
  })

  it('cancels a delete without touching the disk', async () => {
    const root = await project({ 'keep.txt': 'stay' })
    mount(root, engineClient())
    const row = await screen.findByText('keep.txt')
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await act(async () => {})
    expect(await exists(join(root, 'keep.txt'))).toBe(true)
  })
})

describe('closing a tab with unsaved edits', () => {
  async function editedTab() {
    const root = await project({ 'a.ts': 'original' })
    const path = `${canonical(root)}/a.ts`
    mount(root, engineClient(), <Controls path={path} />)
    fireEvent.click(screen.getByText('open'))
    await waitFor(() => expect(tabs()).toEqual([path]))
    fireEvent.click(screen.getByText('edit'))
    await waitFor(() => expect(tabs()).toEqual([`${path} *`]))
    fireEvent.click(screen.getByText('close'))
    await screen.findByRole('alertdialog', { name: /Save changes to a.ts/ })
    return { root, path }
  }

  it('Cancel keeps the tab and the edit', async () => {
    const { root, path } = await editedTab()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(tabs()).toEqual([`${path} *`])
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('original')
  })

  it('Don’t Save closes it and leaves the file as it was', async () => {
    const { root } = await editedTab()
    fireEvent.click(screen.getByRole('button', { name: 'Don’t Save' }))
    await waitFor(() => expect(tabs()).toEqual([]))
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('original')
  })

  it('Save writes the edit, then closes', async () => {
    const { root } = await editedTab()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(tabs()).toEqual([]))
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('my unsaved edit')
  })
})
