// Terminal UI boundary: controlled input -> visible confirmation -> scoped vector call.
// Validates: Requirements 14.6, 22.6, 27.1, 27.3, 27.5

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import Terminal from './Terminal'
import { AppStateProvider, useAppState, type AppState } from '../../state/AppState'
import { CommandIoProvider } from '../../terminal/CommandIoProvider'
import type { CommandIo, CommandOutput, RunCommandRequest } from '../../terminal/commandIo'

/**
 * The transcript as the single state owner records it. Assertions about "recorded as
 * denied" read this rather than inferring a status from the panel's styling.
 */
function HistoryProbe() {
  const runs = useAppState().terminalHistory
  return (
    <ul data-testid="history">
      {runs.map((run) => (
        <li key={run.id} data-testid="run">
          {`${run.status}|${run.exitCode ?? '-'}|${run.message ?? '-'}`}
        </li>
      ))}
    </ul>
  )
}

function recordedRuns(): string[] {
  return screen.getAllByTestId('run').map((row) => row.textContent ?? '')
}

class RecordingCommandIo implements CommandIo {
  readonly calls: RunCommandRequest[] = []
  allowed: string[] = ['git', 'npm', 'node']
  allowError: Error | null = null
  runImpl: (request: RunCommandRequest) => Promise<CommandOutput> = async () => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
  })

  async allowedPrograms(): Promise<string[]> {
    if (this.allowError !== null) throw this.allowError
    return this.allowed
  }

  async run(request: RunCommandRequest): Promise<CommandOutput> {
    this.calls.push(request)
    return this.runImpl(request)
  }
}

function mount(root: string | null, io: CommandIo, initial: Partial<AppState> = {}) {
  return render(
    <AppStateProvider initial={{ projectRoot: root, terminalHistory: [], ...initial }}>
      <CommandIoProvider io={io}>
        <Terminal />
        <HistoryProbe />
      </CommandIoProvider>
    </AppStateProvider>,
  )
}

function enter(line: string): HTMLInputElement {
  const input = screen.getByLabelText('Command to run') as HTMLInputElement
  fireEvent.change(input, { target: { value: line } })
  fireEvent.submit(input.closest('form')!)
  return input
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Terminal source guards', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Terminal.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')

  it('contains no fixture transcript and never sets HTML', () => {
    expect(source).not.toMatch(/const MOCK_|MOCK_TERMINAL|mockTerminal/)
    expect(source).not.toContain('[1/4] Resolving packages')
    expect(source).not.toContain('success Saved lockfile')
    expect(source).not.toContain('dangerouslySetInnerHTML')
  })
})

describe('Terminal command flow', () => {
  it('uses controlled input and the backend-provided allowlist', async () => {
    const io = new RecordingCommandIo()
    io.allowed = ['git']
    mount('C:/project', io)

    expect(await screen.findByText(/Runnable here: git\./)).toBeDefined()
    const input = screen.getByLabelText('Command to run') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'npm test' } })
    expect(input.value).toBe('npm test')
    fireEvent.submit(input.closest('form')!)

    expect(screen.getByRole('alert').textContent).toContain("'npm' is not on the terminal allowlist")
    expect(io.calls).toEqual([])
    // The attempt is kept, marked denied, with the reason attached to the record.
    expect(recordedRuns()).toEqual([
      "denied|-|'npm' is not on the terminal allowlist. Allowed: git.",
    ])
  })

  it('does not run before explicit confirmation and sends a vector with no shell', async () => {
    const io = new RecordingCommandIo()
    mount('C:/project', io)
    await screen.findByText(/Runnable here:/)

    const input = enter('git commit -m "hello world"')
    expect(screen.getByRole('alertdialog').textContent).toContain('git commit -m "hello world"')
    expect(io.calls).toEqual([])
    expect(input.disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /Run/ }))
    await waitFor(() => expect(io.calls).toHaveLength(1))
    expect(io.calls[0]).toEqual({
      projectRoot: 'C:/project',
      cwd: '',
      program: 'git',
      args: ['commit', '-m', 'hello world'],
      confirmed: true,
    })
    expect(io.calls[0]).not.toHaveProperty('command')
  })

  it('cancels confirmation without running anything', async () => {
    const io = new RecordingCommandIo()
    mount('C:/project', io)
    await screen.findByText(/Runnable here:/)

    enter('git status')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(io.calls).toEqual([])
  })

  it('refuses shell syntax instead of passing it as misleading arguments', async () => {
    const io = new RecordingCommandIo()
    mount('C:/project', io)
    await screen.findByText(/Runnable here:/)

    enter('git status | more')

    expect(screen.getByRole('alert').textContent).toContain("There is no shell here, so '|'")
    expect(io.calls).toEqual([])
  })
})

describe('Terminal output rendering', () => {
  it('renders markup in real stdout as text, never as HTML', async () => {
    const hostile =
      '<img src=x onerror="window.__pwned=true">' +
      '<script>window.__pwned=true</script>' +
      '\u001b[31mFAIL <b>bold</b>\u001b[0m'
    const io = new RecordingCommandIo()
    io.runImpl = async () => ({ exitCode: 0, stdout: hostile, stderr: '' })
    const { container } = mount('C:/project', io)
    await screen.findByText(/Runnable here:/)

    enter('npm test')
    fireEvent.click(screen.getByRole('button', { name: /Run/ }))
    await waitFor(() => expect(recordedRuns()).toEqual(['exited|0|-']))

    // The dangerous strings are present as text …
    expect(
      screen.getByText('<img src=x onerror="window.__pwned=true"><script>window.__pwned=true</script>'),
    ).toBeDefined()
    expect(screen.getByText('FAIL <b>bold</b>')).toBeDefined()
    // … and not as elements. Nothing was parsed, so nothing could execute.
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined()
    // The colour arrived as a class, not as markup or inline CSS.
    const coloured = screen.getByText('FAIL <b>bold</b>')
    expect(coloured.className).not.toBe('')
    expect(coloured.getAttribute('style')).toBeNull()
  })

  it('shows the exit code and stderr when a command exits non-zero', async () => {
    const io = new RecordingCommandIo()
    io.runImpl = async () => ({
      exitCode: 2,
      stdout: 'running 1 test\n',
      stderr: 'error TS2304: Cannot find name "wat".\n',
    })
    mount('C:/project', io)
    await screen.findByText(/Runnable here:/)

    enter('npm test')
    fireEvent.click(screen.getByRole('button', { name: /Run/ }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Exited with code 2.'))
    expect(screen.getByText('error TS2304: Cannot find name "wat".')).toBeDefined()
    expect(screen.getByText('running 1 test')).toBeDefined()
    expect(recordedRuns()).toEqual([
      'exited|2|-',
    ])
  })

  it('records a policy refusal as denied and a broken spawn as a failure', async () => {
    const io = new RecordingCommandIo()
    io.runImpl = async () => {
      throw new Error("program 'git' is not on the terminal allowlist")
    }
    mount('C:/project', io)
    await screen.findByText(/Runnable here:/)

    enter('git status')
    fireEvent.click(screen.getByRole('button', { name: /Run/ }))
    await waitFor(() =>
      expect(recordedRuns()).toEqual([
        "denied|-|program 'git' is not on the terminal allowlist",
      ]),
    )
    expect(screen.getByRole('alert').textContent).toContain(
      "Not run: program 'git' is not on the terminal allowlist",
    )
    expect(screen.queryByText(/Could not start/)).toBeNull()
    cleanup()

    io.runImpl = async () => {
      throw new Error('program not found (os error 2)')
    }
    mount('C:/project', io)
    await screen.findByText(/Runnable here:/)

    enter('git status')
    fireEvent.click(screen.getByRole('button', { name: /Run/ }))
    await waitFor(() =>
      expect(recordedRuns()).toEqual(['failed|-|program not found (os error 2)']),
    )
    expect(screen.getByRole('alert').textContent).toContain(
      'Could not start: program not found (os error 2)',
    )
    expect(screen.queryByText(/Not run:/)).toBeNull()
  })
})
