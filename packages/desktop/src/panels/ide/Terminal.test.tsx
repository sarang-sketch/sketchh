// The terminal panel, end to end through the real runner and reducer, against a scripted
// engine terminal. What these pin, in user terms:
//   * The first command in a folder asks once; "Always allow" is remembered.
//   * Output appears while a command runs, and the panel reports how it ended.
//   * Stop (and Ctrl+C) ends a running command.
//   * While a command runs, Enter sends the typed line to it.
//   * `cd` moves the prompt; `clear` clears; ↑ recalls the previous command.
//   * Tabs are independent terminals.
//   * Output is text: markup in stdout reaches the DOM as characters.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import Terminal from './Terminal'
import { AppStateProvider, useAppState } from '../../state/AppState'
import { FileIoProvider } from '../../editor/FileIoProvider'
import { createFakeDisk } from '../../editor/fakeDisk'
import { SketchClientProvider } from '../../lib/ClientProvider'
import { MockSketchClient } from '../../lib/mockClient'
import type { SketchClient, TerminalReadResult, TerminalStartResult } from '../../lib/client'
import { TerminalRunnerProvider } from '../../terminal/TerminalRunner'
import { isFolderTrusted } from '../../terminal/trust'

const ROOT = 'C:/work/app'

interface FakeSession {
  id: string
  line: string
  cwd: string
  out: Array<{ seq: number; stream: 'stdout' | 'stderr'; text: string }>
  running: boolean
  exitCode: number | null
  input: string[]
  killed: boolean
}

/** A scripted engine terminal: the test decides what each command prints and when it ends. */
class FakeTerminal {
  sessions: FakeSession[] = []
  starts: Array<{ root: string; cwd?: string; line: string; confirmed: boolean }> = []
  cdTo: string | null = null

  start(params: { root: string; cwd?: string; line: string; confirmed: true }): TerminalStartResult {
    this.starts.push(params)
    if (/^cd\b/.test(params.line)) {
      const target = params.line.slice(2).trim()
      return { kind: 'cd', cwd: target === '' ? params.root : `${params.root}/${target}` }
    }
    const session: FakeSession = {
      id: `term-x-${this.sessions.length + 1}`,
      line: params.line,
      cwd: params.cwd ?? params.root,
      out: [],
      running: true,
      exitCode: null,
      input: [],
      killed: false,
    }
    this.sessions.push(session)
    return { kind: 'run', id: session.id, cwd: session.cwd, shellName: 'PowerShell' }
  }

  print(index: number, text: string, stream: 'stdout' | 'stderr' = 'stdout') {
    const s = this.sessions[index]!
    s.out.push({ seq: s.out.length, stream, text })
  }

  exit(index: number, code: number) {
    const s = this.sessions[index]!
    s.running = false
    s.exitCode = code
  }

  read(id: string, since = 0): TerminalReadResult {
    const s = this.sessions.find((x) => x.id === id)!
    return {
      id,
      chunks: s.out.filter((c) => c.seq >= since),
      next: s.out.length,
      running: s.running,
      exitCode: s.exitCode,
      signal: null,
      error: null,
      truncated: false,
      durationMs: 1200,
    }
  }
}

function clientFor(fake: FakeTerminal): SketchClient {
  const base = new MockSketchClient()
  return Object.assign(base, {
    termStart: async (params: { root: string; cwd?: string; line: string; confirmed: true }) => fake.start(params),
    termRead: async (params: { id: string; since?: number }) => fake.read(params.id, params.since),
    termWrite: async (params: { id: string; data?: string; end?: boolean }) => {
      const s = fake.sessions.find((x) => x.id === params.id)!
      if (params.data !== undefined) s.input.push(params.data)
      return { ok: Boolean(s) }
    },
    termKill: async (params: { id: string }) => {
      const s = fake.sessions.find((x) => x.id === params.id)!
      s.killed = true
      s.running = false
      s.exitCode = 1
      return { stopped: true }
    },
  })
}

function mount(fake: FakeTerminal, root: string | null = ROOT) {
  return render(
    <SketchClientProvider client={clientFor(fake)}>
      <AppStateProvider initial={{ projectRoot: root }}>
        <TerminalRunnerProvider>
          <Terminal />
        </TerminalRunnerProvider>
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

function type(line: string) {
  const input = (screen.queryByLabelText('Command to run') ?? screen.getByLabelText('Input for the running command')) as HTMLInputElement
  fireEvent.change(input, { target: { value: line } })
  fireEvent.submit(input.closest('form')!)
  return input
}

beforeEach(() => window.localStorage.clear())
afterEach(() => cleanup())

describe('Terminal source guards', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Terminal.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')

  it('has no fixture transcript and never sets HTML', () => {
    expect(source).not.toMatch(/const MOCK_|MOCK_TERMINAL|mockTerminal/)
    expect(source).not.toContain('dangerouslySetInnerHTML')
    expect(source).not.toMatch(/\.innerHTML\s*=/)
  })

  it('no longer runs commands through the blocking Tauri command', () => {
    expect(source).not.toContain('run_command')
    expect(source).not.toContain('useCommandIo')
  })
})

describe('the terminal panel', () => {
  it('turns file locations and URLs in the output into links that open the right place', async () => {
    const fake = new FakeTerminal()
    window.localStorage.setItem('sketch.terminal.trusted.v1', JSON.stringify([ROOT.toLowerCase()]))
    const opened: string[] = []
    const realOpen = window.open
    window.open = ((url?: string | URL) => {
      opened.push(String(url))
      return null
    }) as typeof window.open
    try {
      const disk = createFakeDisk({ [`${ROOT}/src/app.ts`]: 'a\nb\nconst y = x\n' })
      function Probe() {
        const s = useAppState()
        return (
          <div data-testid="probe">
            {s.revealRequest ? `${s.revealRequest.path}:${s.revealRequest.line}:${s.revealRequest.column}` : ''}|
            {s.openFiles.join(',')}|{s.editorNotice?.message ?? ''}
          </div>
        )
      }
      render(
        <SketchClientProvider client={clientFor(fake)}>
          <AppStateProvider initial={{ projectRoot: ROOT }}>
            <FileIoProvider io={disk.io}>
              <TerminalRunnerProvider>
                <Terminal />
                <Probe />
              </TerminalRunnerProvider>
            </FileIoProvider>
          </AppStateProvider>
        </SketchClientProvider>,
      )
      type('npx tsc --noEmit')
      await waitFor(() => expect(fake.sessions).toHaveLength(1))
      act(() => {
        fake.print(0, "src/app.ts(3,7): error TS2304: Cannot find name 'x'.\n")
        fake.print(0, 'Docs: https://www.typescriptlang.org/tsconfig\n')
        fake.print(0, 'C:/elsewhere/lib.ts:1:1 - outside\n')
        fake.exit(0, 2)
      })
      const fileLink = await screen.findByRole('link', { name: 'src/app.ts(3,7)' })
      expect(fileLink.getAttribute('title')).toBe('Open src/app.ts at line 3 (click)')
      fireEvent.click(fileLink)
      await waitFor(() =>
        expect(screen.getByTestId('probe').textContent).toContain(`${ROOT}/src/app.ts:3:7|${ROOT}/src/app.ts|`),
      )

      fireEvent.click(screen.getByRole('link', { name: 'https://www.typescriptlang.org/tsconfig' }))
      await waitFor(() => expect(opened).toEqual(['https://www.typescriptlang.org/tsconfig']))

      fireEvent.click(screen.getByRole('link', { name: 'C:/elsewhere/lib.ts:1:1' }))
      await waitFor(() => expect(screen.getByTestId('probe').textContent).toMatch(/outside the open folder/))

      // Markup-free all the way: the link is text in a span, not an anchor with an href.
      expect(fileLink.tagName).toBe('SPAN')
      expect(fileLink.getAttribute('href')).toBeNull()
    } finally {
      window.open = realOpen
    }
  })

  it('looks at the disk while a long-running command prints, not only when it ends — and not on every line', async () => {
    const fake = new FakeTerminal()
    window.localStorage.setItem('sketch.terminal.trusted.v1', JSON.stringify([ROOT.toLowerCase()]))
    const heard: string[] = []
    const listen = (event: Event) => heard.push(String((event as CustomEvent<{ reason?: string }>).detail?.reason))
    window.addEventListener('sketch:disk-changed', listen)
    try {
      mount(fake)
      type('npm run dev')
      await waitFor(() => expect(fake.sessions).toHaveLength(1))
      expect(heard).toEqual([])
      // The watcher rebuilt and says so: the window looks again while it keeps running.
      act(() => fake.print(0, 'page reload src/App.tsx\n'))
      await waitFor(() => expect(heard).toEqual(['terminal']))
      // More output right away is the same burst, not another look.
      act(() => fake.print(0, 'hmr update /src/App.css\n'))
      // (The path in that line is a link now, so the line is more than one text node.)
      await screen.findByRole('link', { name: '/src/App.css' })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(heard).toEqual(['terminal'])
      expect(fake.sessions[0]!.running).toBe(true)
    } finally {
      window.removeEventListener('sketch:disk-changed', listen)
    }
  })

  it('tells the window to look at the disk again after a command ran, but not after cd', async () => {
    const fake = new FakeTerminal()
    window.localStorage.setItem('sketch.terminal.trusted.v1', JSON.stringify([ROOT.toLowerCase()]))
    const heard: string[] = []
    const listen = (event: Event) => heard.push(String((event as CustomEvent<{ reason?: string }>).detail?.reason))
    window.addEventListener('sketch:disk-changed', listen)
    try {
      mount(fake)
      type('cd src')
      await waitFor(() => expect(fake.starts).toHaveLength(1))
      await waitFor(() => expect(screen.getByLabelText('Command to run')).toBeTruthy())
      expect(heard).toEqual([])

      type('npx prettier --write .')
      await waitFor(() => expect(fake.sessions).toHaveLength(1))
      expect(heard).toEqual([])
      act(() => fake.exit(0, 0))
      await waitFor(() => expect(heard).toEqual(['terminal']))
    } finally {
      window.removeEventListener('sketch:disk-changed', listen)
    }
  })

  it('asks once per folder, and remembers "Always allow"', async () => {
    const fake = new FakeTerminal()
    mount(fake)
    type('npm test')
    expect(screen.getByRole('alertdialog', { name: 'Allow commands in this folder' })).toBeTruthy()
    expect(fake.starts).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: /Always allow in this folder/ }))
    await waitFor(() => expect(fake.starts).toHaveLength(1))
    expect(fake.starts[0]).toMatchObject({ root: ROOT, line: 'npm test', confirmed: true })
    expect(isFolderTrusted(ROOT)).toBe(true)

    // Trusted now: the next command runs straight away.
    act(() => fake.exit(0, 0))
    await waitFor(() => expect(screen.getByText(/Done/)).toBeTruthy())
    type('git status')
    await waitFor(() => expect(fake.starts).toHaveLength(2))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('streams output while the command runs, then says how it ended', async () => {
    const fake = new FakeTerminal()
    window.localStorage.setItem('sketch.terminal.trusted.v1', JSON.stringify([ROOT.toLowerCase()]))
    mount(fake)
    type('npm run build')
    await waitFor(() => expect(fake.sessions).toHaveLength(1))

    act(() => fake.print(0, 'compiling…\n'))
    await waitFor(() => expect(screen.getByText('compiling…')).toBeTruthy())
    expect(screen.getByRole('button', { name: /Stop/ })).toBeTruthy()

    act(() => {
      fake.print(0, 'error TS2304\n', 'stderr')
      fake.exit(0, 2)
    })
    await waitFor(() => expect(screen.getByText(/Exited with code 2/)).toBeTruthy())
    expect(screen.getByText('error TS2304')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Stop/ })).toBeNull()
  })

  it('stops a running command with the Stop button and with Ctrl+C', async () => {
    const fake = new FakeTerminal()
    window.localStorage.setItem('sketch.terminal.trusted.v1', JSON.stringify([ROOT.toLowerCase()]))
    mount(fake)
    type('npm run dev')
    await waitFor(() => expect(fake.sessions).toHaveLength(1))
    fireEvent.click(await screen.findByRole('button', { name: /Stop/ }))
    await waitFor(() => expect(screen.getByText(/Stopped/)).toBeTruthy())
    expect(fake.sessions[0]!.killed).toBe(true)

    type('npm run dev')
    await waitFor(() => expect(fake.sessions).toHaveLength(2))
    const input = await screen.findByLabelText('Input for the running command')
    fireEvent.keyDown(input, { key: 'c', ctrlKey: true })
    await waitFor(() => expect(fake.sessions[1]!.killed).toBe(true))
  })

  it('sends a typed line to a command that is waiting for input', async () => {
    const fake = new FakeTerminal()
    window.localStorage.setItem('sketch.terminal.trusted.v1', JSON.stringify([ROOT.toLowerCase()]))
    mount(fake)
    type('npm init')
    await waitFor(() => expect(fake.sessions).toHaveLength(1))
    act(() => fake.print(0, 'package name: '))
    await screen.findByLabelText('Input for the running command')
    type('my-app')
    await waitFor(() => expect(fake.sessions[0]!.input).toEqual(['my-app\n']))
    // Nothing new was started: the line went to the program.
    expect(fake.starts).toHaveLength(1)
  })

  it('moves with cd, clears with clear, and recalls history with the up arrow', async () => {
    const fake = new FakeTerminal()
    window.localStorage.setItem('sketch.terminal.trusted.v1', JSON.stringify([ROOT.toLowerCase()]))
    mount(fake)
    type('cd src')
    await waitFor(() => expect(screen.getAllByText('app/src').length).toBeGreaterThan(0))

    type('npm test')
    await waitFor(() => expect(fake.starts.at(-1)).toMatchObject({ line: 'npm test', cwd: `${ROOT}/src` }))
    act(() => fake.exit(0, 0))
    await waitFor(() => expect(screen.getByText(/Done/)).toBeTruthy())

    const input = screen.getByLabelText('Command to run') as HTMLInputElement
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.value).toBe('npm test')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.value).toBe('cd src')

    type('clear')
    await waitFor(() => expect(screen.queryByText(/Done/)).toBeNull())
    expect(fake.starts.some((s) => s.line === 'clear')).toBe(false)
  })

  it('keeps each terminal tab separate', async () => {
    const fake = new FakeTerminal()
    window.localStorage.setItem('sketch.terminal.trusted.v1', JSON.stringify([ROOT.toLowerCase()]))
    mount(fake)
    type('npm run dev')
    await waitFor(() => expect(fake.sessions).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: 'New terminal' }))
    expect(screen.getByRole('tab', { name: /Terminal 2/, selected: true })).toBeTruthy()
    // The new tab is idle, so the prompt runs a command rather than feeding the dev server.
    type('git status')
    await waitFor(() => expect(fake.sessions).toHaveLength(2))
    expect(fake.sessions[0]!.input).toEqual([])
  })

  it('renders markup in output as text', async () => {
    const fake = new FakeTerminal()
    window.localStorage.setItem('sketch.terminal.trusted.v1', JSON.stringify([ROOT.toLowerCase()]))
    const { container } = mount(fake)
    type('node x.js')
    await waitFor(() => expect(fake.sessions).toHaveLength(1))
    act(() => fake.print(0, '<img src=x onerror=alert(1)>\n'))
    await waitFor(() => expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy())
    expect(container.querySelector('img')).toBeNull()
  })

  it('shows the latest state of a line that rewrites itself', async () => {
    const fake = new FakeTerminal()
    window.localStorage.setItem('sketch.terminal.trusted.v1', JSON.stringify([ROOT.toLowerCase()]))
    mount(fake)
    type('npm install')
    await waitFor(() => expect(fake.sessions).toHaveLength(1))
    act(() => fake.print(0, 'progress 10%\rprogress 55%\rprogress 100%\n'))
    await waitFor(() => expect(screen.getByText('progress 100%')).toBeTruthy())
    expect(screen.queryByText(/10%progress/)).toBeNull()
  })

  it('says plainly when no folder is open', () => {
    mount(new FakeTerminal(), null)
    expect(screen.getByText(/No folder is open/)).toBeTruthy()
    expect((screen.getByLabelText('Command to run') as HTMLInputElement).disabled).toBe(true)
  })
})
