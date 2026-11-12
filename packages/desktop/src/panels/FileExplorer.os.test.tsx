// The Explorer's operating-system actions. In user terms: right-click a file → Reveal
// shows it in the system file manager; right-click → Open in External Terminal opens
// the system terminal in its folder; Open in Integrated Terminal opens a terminal tab
// there; a refusal (the engine said no) is shown, not swallowed. Hidden when the engine
// cannot do them.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FileExplorer, revealLabel } from './FileExplorer'
import { ConfirmProvider } from '../components/ConfirmDialog'
import { FileIoProvider } from '../editor/FileIoProvider'
import { SketchClientProvider } from '../lib/ClientProvider'
import type { SketchClient } from '../lib/client'
import { AppStateProvider, useAppState } from '../state/AppState'
import { canonical, engineClient, nodeFileIo } from '../test/engineHarness'

const dirs: string[] = []
afterEach(async () => {
  cleanup()
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

function Probe() {
  const state = useAppState()
  return (
    <>
      <div data-testid="terminals">{JSON.stringify(state.terminals.map((t) => t.cwd))}</div>
      <div data-testid="notice">{state.editorNotice?.message ?? ''}</div>
    </>
  )
}

async function setup(client: SketchClient) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sketch-explorer-os-')))
  dirs.push(root)
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'app.ts'), 'export {}\n')
  render(
    <SketchClientProvider client={client}>
      <AppStateProvider initial={{ projectRoot: canonical(root), mode: 'ide' }}>
        <FileIoProvider io={nodeFileIo()}>
          <ConfirmProvider>
            <FileExplorer />
            <Probe />
          </ConfirmProvider>
        </FileIoProvider>
      </AppStateProvider>
    </SketchClientProvider>,
  )
  return root
}

describe('the Explorer hands paths to the operating system', () => {
  it('names the file manager the way each system does', () => {
    expect(revealLabel(true, false)).toBe('Reveal in Finder')
    expect(revealLabel(false, true)).toBe('Reveal in File Explorer')
    expect(revealLabel(false, false)).toBe('Open Containing Folder')
  })

  it('reveals a file, opens an external terminal in its folder, and an integrated one there', async () => {
    const client = engineClient()
    const osReveal = vi.fn(async () => ({ label: 'File Explorer' }))
    const osOpenTerminal = vi.fn(async () => ({ label: 'Windows Terminal' }))
    Object.assign(client, { osReveal, osOpenTerminal })
    const root = await setup(client)

    fireEvent.click(await screen.findByText('src'))
    const file = await screen.findByText('app.ts')

    fireEvent.contextMenu(file)
    fireEvent.click(screen.getByRole('menuitem', { name: /Reveal in|Open Containing Folder/ }))
    await waitFor(() => expect(osReveal).toHaveBeenCalledTimes(1))
    expect((osReveal.mock.calls[0] as unknown as [{ root: string; path: string }])[0].path.replace(/\\/g, '/')).toMatch(/src\/app\.ts$/)

    fireEvent.contextMenu(file)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in External Terminal' }))
    await waitFor(() => expect(osOpenTerminal).toHaveBeenCalledTimes(1))
    // A file's terminal opens in the file's folder.
    expect((osOpenTerminal.mock.calls[0] as unknown as [{ path: string }])[0].path.replace(/\\/g, '/')).toMatch(/\/src$/)

    fireEvent.contextMenu(file)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in Integrated Terminal' }))
    await waitFor(() => expect(screen.getByTestId('terminals').textContent).toMatch(/src/))
    expect(canonical(root)).not.toBe('')
  })

  it('shows a refusal instead of failing silently', async () => {
    const client = engineClient()
    Object.assign(client, {
      osReveal: async () => {
        throw new Error('Could not open File Explorer: access denied')
      },
      osOpenTerminal: async () => ({ label: 'x' }),
    })
    await setup(client)
    fireEvent.contextMenu(await screen.findByText('src'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Reveal in|Open Containing Folder/ }))
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toContain('access denied'))
  })

  it('offers neither action when the engine cannot do them', async () => {
    const client = engineClient()
    Object.assign(client, { osReveal: undefined, osOpenTerminal: undefined })
    await setup(client)
    fireEvent.contextMenu(await screen.findByText('src'))
    expect(screen.queryByRole('menuitem', { name: /Reveal in|Open Containing Folder/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Open in External Terminal' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Open in Integrated Terminal' })).toBeTruthy()
  })
})
