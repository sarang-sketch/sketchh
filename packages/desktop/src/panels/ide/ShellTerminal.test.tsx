// The terminal panel with real shells, through the real reducer and panel, against a
// scripted pseudo-terminal backend. What these pin, in user terms:
//   * In the desktop app the terminal is a real shell; it asks once per folder first.
//   * The tab is named after its shell.
//   * The ⌄ menu lists every shell on the machine, plus the classic command runner.
//   * Closing a tab ends its shell. Run panel scripts keep the classic runner.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import Terminal from './Terminal'
import { AppStateProvider, useAppDispatch, useAppState } from '../../state/AppState'
import { SketchClientProvider } from '../../lib/ClientProvider'
import { MockSketchClient } from '../../lib/mockClient'
import { TerminalRunnerProvider } from '../../terminal/TerminalRunner'
import type { PtyBackend, PtyEvent, PtyOpenParams, ShellProfile } from '../../terminal/ptyBackend'
import { ShellTerminalsProvider, type Emulator, type EmulatorLike } from '../../terminal/ShellSessions'
import { forgetTrustedFolder } from '../../terminal/trust'

const ROOT = 'C:/work/app'
const PWSH: ShellProfile = { id: 'powershell', name: 'Windows PowerShell', program: 'powershell.exe', args: [], family: 'powershell' }
const BASH: ShellProfile = { id: 'git-bash', name: 'Git Bash', program: 'bash.exe', args: [], family: 'bash' }

class FakePty implements PtyBackend {
  opens: PtyOpenParams[] = []
  writes: Array<{ id: number; data: string }> = []
  closed: number[] = []
  private next = 1
  async profiles() {
    return [PWSH, BASH]
  }
  async open(params: PtyOpenParams) {
    this.opens.push(params)
    const id = this.next++
    return { id, pid: 100 + id, profile: params.profileId === 'git-bash' ? BASH : PWSH, cwd: params.cwd ?? params.projectRoot, windowsBuild: null }
  }
  async write(id: number, data: string) {
    this.writes.push({ id, data })
  }
  async resize() {}
  async close(id: number) {
    this.closed.push(id)
    return true
  }
  emit(index: number, event: PtyEvent) {
    this.opens[index]!.onEvent(event)
  }
}

function fakeEmulator(): Emulator {
  let element: HTMLElement | undefined
  let written = ''
  const term = {
    cols: 80,
    rows: 24,
    get element() {
      return element
    },
    options: {},
    buffer: { active: { length: 0, getLine: () => undefined } },
    open(parent: HTMLElement) {
      element = document.createElement('div')
      element.setAttribute('data-emulator', 'xterm')
      parent.appendChild(element)
    },
    write(data: string) {
      written += data
      if (element !== undefined) element.textContent = written
    },
    onData: () => ({ dispose() {} }),
    onResize: () => ({ dispose() {} }),
    onTitleChange: () => ({ dispose() {} }),
    attachCustomKeyEventHandler() {},
    registerLinkProvider: () => ({ dispose() {} }),
    hasSelection: () => false,
    getSelection: () => '',
    clearSelection() {},
    selectAll() {},
    clear() {
      written = ''
      if (element !== undefined) element.textContent = ''
    },
    focus() {},
    dispose() {},
    scrollToBottom() {},
    paste() {},
  }
  return { term: term as unknown as EmulatorLike, fit: () => {} }
}

let probe: { state: ReturnType<typeof useAppState>; dispatch: ReturnType<typeof useAppDispatch> } | null = null
function Probe() {
  probe = { state: useAppState(), dispatch: useAppDispatch() }
  return null
}

function mount(pty: FakePty) {
  return render(
    <SketchClientProvider client={new MockSketchClient()}>
      <AppStateProvider initial={{ projectRoot: ROOT }}>
        <TerminalRunnerProvider>
          <ShellTerminalsProvider backend={pty} createEmulator={fakeEmulator}>
            <Probe />
            <Terminal />
          </ShellTerminalsProvider>
        </TerminalRunnerProvider>
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

beforeEach(() => {
  window.localStorage.clear()
  // "Allow until I restart" lasts for the process, which here spans the tests.
  forgetTrustedFolder(ROOT)
  probe = null
})

afterEach(() => {
  cleanup()
})

describe('the terminal panel with real shells', () => {
  it('becomes a real shell, asks once for the folder, then starts the default shell there', async () => {
    const pty = new FakePty()
    mount(pty)
    await screen.findByRole('alertdialog', { name: 'Allow terminals in this folder' })
    expect(screen.getByText(/Windows PowerShell/)).toBeTruthy()
    // No classic command box on a shell tab.
    expect(screen.queryByLabelText('Command to run')).toBeNull()
    expect(pty.opens).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Allow until I restart' }))
    await waitFor(() => expect(pty.opens).toHaveLength(1))
    expect(pty.opens[0]).toMatchObject({ projectRoot: ROOT, cwd: null, profileId: null })
    await waitFor(() => expect(document.querySelector('[data-emulator="xterm"]')).not.toBeNull())

    act(() => pty.emit(0, { kind: 'data', data: 'PS C:\\work\\app> ' }))
    expect(document.querySelector('[data-emulator="xterm"]')!.textContent).toContain('PS C:\\work\\app>')
    // Named after its shell.
    await waitFor(() => expect(screen.getByRole('tab', { name: /Windows PowerShell/ })).toBeTruthy())
  })

  it('lists every shell in the ⌄ menu and opens the chosen one in a new tab', async () => {
    const pty = new FakePty()
    mount(pty)
    fireEvent.click(await screen.findByRole('button', { name: 'Always allow in this folder' }))
    await waitFor(() => expect(pty.opens).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: 'Choose a shell for a new terminal' }))
    const menu = await screen.findByRole('menu', { name: 'New terminal' })
    expect(menu.textContent).toContain('Windows PowerShell')
    expect(menu.textContent).toContain('Git Bash')
    expect(menu.textContent).toContain('Command runner')
    fireEvent.click(screen.getByRole('menuitem', { name: /Git Bash/ }))

    // The folder is trusted now, so the new shell starts without asking.
    await waitFor(() => expect(pty.opens).toHaveLength(2))
    expect(pty.opens[1]).toMatchObject({ profileId: 'git-bash' })
    expect(probe!.state.terminals.map((t) => [t.title, t.kind])).toEqual([
      ['Windows PowerShell', 'shell'],
      ['Git Bash', 'shell'],
    ])
  })

  it('ends a shell when its tab is closed', async () => {
    const pty = new FakePty()
    mount(pty)
    fireEvent.click(await screen.findByRole('button', { name: 'Allow until I restart' }))
    await waitFor(() => expect(pty.opens).toHaveLength(1))
    act(() => probe!.dispatch({ type: 'TERMINAL_NEW' }))
    await waitFor(() => expect(pty.opens).toHaveLength(2))
    // Two shells of the same kind get distinct names.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close Windows PowerShell 2' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Close Windows PowerShell' }))
    await waitFor(() => expect(pty.closed).toEqual([1]))
  })

  it('still offers the classic command runner, and Run panel scripts use it', async () => {
    const pty = new FakePty()
    mount(pty)
    fireEvent.click(await screen.findByRole('button', { name: 'Choose a shell for a new terminal' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Command runner/ }))
    await screen.findByLabelText('Command to run')
    expect(probe!.state.terminals.at(-1)!.kind).toBe('commands')

    act(() => probe!.dispatch({ type: 'TERMINAL_NEW', payload: { id: 'run:dev', title: 'dev', kind: 'commands' } }))
    expect(probe!.state.terminals.at(-1)).toMatchObject({ id: 'run:dev', kind: 'commands' })
  })
})
