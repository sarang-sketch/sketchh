// W10 invariant 7: a restored project root whose folder no longer exists.
//
// Persisted state can carry a projectRoot that has since been deleted or renamed. At
// startup Sketch must clear it to the welcome / no-folder state and show ONE plain
// notice — not leave a dead explorer, a stuck spinner, or a stream of not-found errors.
// Tabs restored for that root are dropped with it; any UNSAVED buffer is kept (a vanished
// folder has none on a fresh start, but if one somehow exists it must not be discarded).
//
// The detection reuses the Explorer's own root read (no extra disk call): when the ROOT
// directory read comes back as a not-found, FileExplorer dispatches CLEAR_PROJECT_ROOT
// with the notice. The io double here rejects readDir for the persisted root with a
// not-found error (os error 2), which `describeFileFailure` turns into the "no longer
// exists on disk" message the detector matches. Mutation note (fix-stability.md):
// disabling the detector leaves projectRoot set and no notice, failing this test.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import { FileExplorer } from '../panels/FileExplorer'
import { AppStateProvider, useAppState } from '../state/AppState'
import { FileIoProvider } from './FileIoProvider'
import type { FileIo } from './fileIo'

afterEach(cleanup)

const GONE = 'C:/was/here/project'

/** An io whose reads reject as not-found (os error 2) — the vanished-folder case. */
function missingIo(): FileIo {
  const notFound = () =>
    Promise.reject(new Error('failed to read: The system cannot find the file (os error 2)'))
  return {
    readFile: () => notFound(),
    readDir: () => notFound() as Promise<never>,
    writeFile: () => notFound(),
    pickFolder: () => Promise.resolve(null),
  }
}

/** An io whose root reads fine (empty folder) — the control: a present folder stays open. */
function presentIo(): FileIo {
  return {
    readFile: () => Promise.resolve(''),
    readDir: () => Promise.resolve([]),
    writeFile: () => Promise.resolve(),
    pickFolder: () => Promise.resolve(null),
  }
}

/** Reads the slice of state the assertions care about. */
function Probe() {
  const state = useAppState()
  return (
    <div>
      <span data-testid="root">{`root:${state.projectRoot ?? 'none'}`}</span>
      <span data-testid="notice">{`notice:${state.editorNotice?.message ?? 'none'}`}</span>
      <span data-testid="tabs">{`tabs:${state.openFiles.length}`}</span>
    </div>
  )
}

describe('a restored folder that no longer exists (invariant 7)', () => {
  it('clears to the welcome state with one plain notice', async () => {
    render(
      <AppStateProvider initial={{ projectRoot: GONE }}>
        <FileIoProvider io={missingIo()}>
          <FileExplorer />
          <Probe />
        </FileIoProvider>
      </AppStateProvider>,
    )

    // The restored root starts set…
    expect(screen.getByTestId('root').textContent).toBe(`root:${GONE}`)

    // …and once the Explorer's root read comes back not-found, it is cleared to
    // no-folder with a notice — not left as a dead tree of errors.
    await waitFor(() => {
      expect(screen.getByTestId('root').textContent).toBe('root:none')
    })
    const notice = screen.getByTestId('notice').textContent!
    expect(notice).toContain('is no longer available')
    expect(notice).toContain('Open a folder to continue')
    // Its restored tabs were dropped with it; no unsaved buffers existed on this start.
    expect(screen.getByTestId('tabs').textContent).toBe('tabs:0')
    // The welcome / no-folder empty state is shown (not an error row).
    expect(screen.getByText('No folder opened')).toBeDefined()
  })

  it('leaves a folder that still exists open, with no vanished-folder notice', async () => {
    render(
      <AppStateProvider initial={{ projectRoot: GONE }}>
        <FileIoProvider io={presentIo()}>
          <FileExplorer />
          <Probe />
        </FileIoProvider>
      </AppStateProvider>,
    )

    await waitFor(() => {
      // the root read resolved; the root must NOT have been cleared
      expect(screen.getByTestId('root').textContent).toBe(`root:${GONE}`)
    })
    expect(screen.getByTestId('notice').textContent).toBe('notice:none')
  })
})
