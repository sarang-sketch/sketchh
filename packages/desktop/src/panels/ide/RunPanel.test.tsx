// The Run view: reachable from the activity bar, lists what the project declares it can
// run, runs one in its own terminal tab, and draws no fabricated debugger.
// Validates: Requirements 14.4, 27.3, 27.4

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import ActivityBar from '../../components/ide/ActivityBar'
import SidePanel from '../../components/ide/SidePanel'
import { FileIoProvider } from '../../editor/FileIoProvider'
import { createFakeDisk } from '../../editor/fakeDisk'
import { SketchClientProvider } from '../../lib/ClientProvider'
import { MockSketchClient } from '../../lib/mockClient'
import { AppStateProvider, useAppState } from '../../state/AppState'
import { TerminalRunnerProvider } from '../../terminal/TerminalRunner'
import { RUN_DOUBLE_CLICK_MS } from './RunPanel'

afterEach(cleanup)

const ROOT = 'C:/work/web'

function Terminals() {
  const state = useAppState()
  return <div data-testid="terminals">{state.terminals.map((t) => t.title).join('|')}</div>
}

function mount() {
  const disk = createFakeDisk({
    [`${ROOT}/package.json`]: JSON.stringify({ scripts: { dev: 'vite', test: 'vitest run' } }),
    [`${ROOT}/pnpm-lock.yaml`]: '',
    [`${ROOT}/src/main.ts`]: '',
  })
  const starts: Array<{ line: string }> = []
  const kills: string[] = []
  const client = Object.assign(new MockSketchClient(), {
    termStart: async (p: { line: string }) => {
      starts.push(p)
      return { kind: 'run' as const, id: `term-x-${starts.length}`, cwd: ROOT, shellName: 'PowerShell' }
    },
    termRead: async (p: { id: string }) => ({
      id: p.id, chunks: [], next: 0, running: true, exitCode: null, signal: null, error: null, truncated: false, durationMs: 0,
    }),
    termKill: async (p: { id: string }) => {
      kills.push(p.id)
      return { stopped: true }
    },
  })
  render(
    <SketchClientProvider client={client}>
      <AppStateProvider initial={{ mode: 'ide', ideActivePanel: null, projectRoot: ROOT }}>
        <FileIoProvider io={disk.io}>
          <TerminalRunnerProvider>
            <ActivityBar />
            <SidePanel />
            <Terminals />
          </TerminalRunnerProvider>
        </FileIoProvider>
      </AppStateProvider>
    </SketchClientProvider>,
  )
  return { starts, kills }
}

describe('the Run view', () => {
  it('lists the project’s scripts with its package manager, and runs one in its own terminal', async () => {
    const { starts } = mount()
    fireEvent.click(screen.getByTitle('Run'))

    await screen.findByRole('button', { name: 'Run dev' })
    expect(screen.getByText('pnpm dev')).toBeTruthy()
    expect(screen.getByText('pnpm test')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Run dev' }))
    await waitFor(() => expect(starts.map((s) => s.line)).toEqual(['pnpm dev']))
    expect(screen.getByTestId('terminals').textContent).toContain('dev')
    // While it runs, the button offers Stop instead.
    expect(await screen.findByRole('button', { name: 'Stop dev' })).toBeTruthy()
  })

  it('a double-click on Run starts the script and does not stop it again', async () => {
    const { starts, kills } = mount()
    fireEvent.click(screen.getByTitle('Run'))
    fireEvent.click(await screen.findByRole('button', { name: 'Run dev' }))
    // Stop takes Run's place, so the second click of the double-click lands on it.
    const stopButton = await screen.findByRole('button', { name: 'Stop dev' })
    await waitFor(() => expect(starts).toHaveLength(1))
    fireEvent.click(stopButton)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(kills).toEqual([])
    expect(screen.getByRole('button', { name: 'Stop dev' })).toBeTruthy()

    // A deliberate Stop, a moment later, still stops it.
    await new Promise((resolve) => setTimeout(resolve, RUN_DOUBLE_CLICK_MS))
    fireEvent.click(screen.getByRole('button', { name: 'Stop dev' }))
    await waitFor(() => expect(kills).toEqual(['term-x-1']))
  })

  it('draws no fabricated debugger, and says how to debug instead', async () => {
    mount()
    fireEvent.click(screen.getByTitle('Run'))
    await screen.findByText(/Breakpoint debugging is not available/)
    expect(screen.queryByText(/Call Stack|Variables|main\.rs:\d+/)).toBeNull()
  })
})
