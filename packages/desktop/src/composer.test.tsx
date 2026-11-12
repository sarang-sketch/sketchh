// The composer and its neighbours, as a person uses them.
//
//   * Ask / Agent / Auto decide what the ENGINE is asked to allow — read-only, ask
//     before commands, or work unattended — and Shift+Tab cycles them.
//   * "/" opens a command menu; a picked command sends its expanded prompt.
//   * "@" searches the project's files; a picked file reaches the run.
//   * A command the run wants to execute is put to the user, and Allow answers it.
//   * Each reply carries a receipt built from events, not from the model's words.
//   * Ctrl+P / Ctrl+Shift+P open Quick Open and the Command Palette.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import type { RunOptions, SketchClient } from './lib/client'
import { SketchClientProvider } from './lib/ClientProvider'
import type { ProviderSettingsEntry, RunResult, SketchEvent, Task } from './lib/contracts'
import { AppStateProvider, DEFAULT_AGENT_PREFS, appReducer, initialAppState } from './state/AppState'
import { AgentChat } from './panels/agent/AgentChat'
import { AgentSessionProvider, modeRunOptions, parseApprovalText } from './lib/AgentSession'
import { menuAt, mentionedPaths, nextMode } from './panels/agent/Composer'
import { fuzzyFilter, fuzzyScore } from './lib/fuzzy'
import { BUILTIN_COMMANDS, expandTemplate, parseSlash } from './lib/slashCommands'
import { receiptFor } from './lib/runSummary'
import { CommandPalette } from './components/CommandPalette'

const resolveApiKeyForRun = vi.hoisted(() => vi.fn<(id: string, onProblem?: (reason: string) => void) => Promise<string | null>>())
vi.mock('./lib/secrets', () => ({ resolveApiKeyForRun }))

const ollama: ProviderSettingsEntry = {
  id: 'ollama-local',
  kind: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen2.5-coder:7b',
  label: 'Local Ollama',
}

const base = {
  projectRoot: 'C:\\workspace',
  providerSettingsPath: 'C:\\Users\\test\\.sketch\\providers.json',
  providers: [ollama],
  selectedProvider: ollama.id,
  selectedModel: ollama.model,
}

function done(): RunResult {
  return { runId: 'r', ok: true, finalText: 'done', iterations: 1, verify: [], events: [] }
}

interface FakeClient extends SketchClient {
  emit(event: SketchEvent): void
}

function fakeClient(run: (task: Task, options?: RunOptions) => Promise<RunResult>, extra: Partial<SketchClient> = {}): FakeClient {
  const handlers = new Set<(event: SketchEvent) => void>()
  return {
    transport: 'mock',
    ping: async () => ({ ok: true, version: 'test', transport: 'mock' }),
    run,
    reply: vi.fn(async (runId: string) => ({ runId, answered: true })),
    cancel: vi.fn(async (runId: string) => ({ runId, cancelled: true })),
    subscribe: (handler: (event: SketchEvent) => void) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    emit: (event: SketchEvent) => {
      for (const handler of handlers) handler(event)
    },
    ...extra,
  } as unknown as FakeClient
}

function mount(client: SketchClient, initial: Record<string, unknown> = {}) {
  return render(
    <SketchClientProvider client={client}>
      <AppStateProvider initial={{ ...base, ...initial }}>
        <AgentSessionProvider>
          <AgentChat />
          <CommandPalette />
        </AgentSessionProvider>
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

function type(text: string) {
  const box = screen.getByLabelText('Message the agent') as HTMLTextAreaElement
  fireEvent.change(box, { target: { value: text, selectionStart: text.length } })
  return box
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  resolveApiKeyForRun.mockReset()
  resolveApiKeyForRun.mockResolvedValue(null)
})
afterEach(() => cleanup())

// ── modes ───────────────────────────────────────────────────────────────────

describe('Ask / Agent / Auto', () => {
  it('maps each mode to what the engine is asked to allow', () => {
    const ask = modeRunOptions({ ...DEFAULT_AGENT_PREFS, mode: 'ask' })
    expect(ask.readOnly).toBe(true)
    expect(ask.commands).toBeUndefined()
    const agent = modeRunOptions({ ...DEFAULT_AGENT_PREFS, mode: 'agent' })
    expect(agent.readOnly).toBeUndefined()
    expect(agent.commands).toBe('ask')
    expect(agent.autonomous).toBeUndefined()
    const auto = modeRunOptions({ ...DEFAULT_AGENT_PREFS, mode: 'auto' })
    expect(auto.commands).toBe('auto')
    expect(auto.autonomous).toBe(true)
    expect(auto.reviewEdits).toBe(false)
    expect(auto.maxIterations).toBeGreaterThanOrEqual(50)
  })

  it('cycles with Shift+Tab and sends the chosen mode with the run', async () => {
    const run = vi.fn(async (_task: Task, _options?: RunOptions) => done())
    mount(fakeClient(run))
    const box = type('tidy the imports')
    expect(screen.getByRole('radio', { name: /Agent/ }).getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(box, { key: 'Tab', shiftKey: true })
    expect(screen.getByRole('radio', { name: /Auto/ }).getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    const options = run.mock.calls[0]![1]!
    expect(options.commands).toBe('auto')
    expect(options.autonomous).toBe(true)
    expect(options.interactive).toBe(true)
    expect(options.autoSkills).toBe(true)
  })

  it('runs Ask mode read-only in the engine', async () => {
    const run = vi.fn(async (_task: Task, _options?: RunOptions) => done())
    mount(fakeClient(run), { agentPrefs: { ...DEFAULT_AGENT_PREFS, mode: 'ask' } })
    const box = type('what does this project do?')
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    expect(run.mock.calls[0]![1]!.readOnly).toBe(true)
    expect(run.mock.calls[0]![1]!.commands).toBeUndefined()
  })

  it('cycles in a fixed order and validates stored values', () => {
    expect(nextMode('ask')).toBe('agent')
    expect(nextMode('agent')).toBe('auto')
    expect(nextMode('auto')).toBe('ask')
    const state = appReducer(initialAppState, { type: 'SET_AGENT_PREFS', payload: { mode: 'bogus' as never } })
    expect(state.agentPrefs.mode).toBe('agent')
  })
})

// ── slash commands and mentions ─────────────────────────────────────────────

describe('the "/" menu', () => {
  it('opens on "/", filters as you type, and runs a no-argument command on Enter', async () => {
    const run = vi.fn(async (_task: Task, _options?: RunOptions) => done())
    mount(fakeClient(run))
    const box = type('/ini')
    const menu = await screen.findByRole('listbox', { name: 'Commands' })
    expect(menu.textContent).toContain('/init')
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    expect(run.mock.calls[0]![0].prompt).toContain('AGENTS.md')
    // The transcript shows what the person typed, not the expanded template.
    expect(await within(screen.getByRole('log', { name: 'Conversation messages' })).findByText('/init')).toBeDefined()
  })

  it('runs /review read-only whatever mode the composer is in', async () => {
    const run = vi.fn(async (_task: Task, _options?: RunOptions) => done())
    mount(fakeClient(run), { agentPrefs: { ...DEFAULT_AGENT_PREFS, mode: 'auto' } })
    const box = type('/review')
    fireEvent.keyDown(box, { key: 'Escape' })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    expect(run.mock.calls[0]![1]!.readOnly).toBe(true)
    expect(run.mock.calls[0]![0].prompt).toMatch(/uncommitted changes/)
  })

  it('performs app actions instead of sending them to a model', async () => {
    const run = vi.fn(async (_task: Task, _options?: RunOptions) => done())
    mount(fakeClient(run))
    const box = type('/auto')
    fireEvent.keyDown(box, { key: 'Escape' })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(screen.getByRole('radio', { name: /Auto/ }).getAttribute('aria-checked')).toBe('true')
    expect(run).not.toHaveBeenCalled()
  })

  it('parses and expands templates the way command files expect', () => {
    expect(parseSlash('/test src/a.ts')).toEqual({ name: 'test', args: 'src/a.ts' })
    expect(parseSlash('not a command')).toBeNull()
    expect(expandTemplate('Review $ARGUMENTS now', 'src/x.ts')).toBe('Review src/x.ts now')
    expect(expandTemplate('Compare $1 with $2', 'a b')).toBe('Compare a with b')
    expect(expandTemplate('Summarise', 'today')).toBe('Summarise\n\ntoday')
    expect(BUILTIN_COMMANDS.map((c) => c.name)).toEqual(expect.arrayContaining(['init', 'fix', 'test', 'review', 'explain', 'clear', 'undo', 'auto']))
  })
})

describe('the "@" menu', () => {
  it('searches project files and sends the picked file with the message', async () => {
    const run = vi.fn(async (_task: Task, _options?: RunOptions) => done())
    const projectFiles = vi.fn(async () => ({ root: 'C:\\workspace', files: ['README.md', 'src/app.ts', 'src/util/math.ts'], truncated: false, maxFiles: 20000 }))
    mount(fakeClient(run, { projectFiles }))
    const box = type('look at @math')
    const menu = await screen.findByRole('listbox', { name: 'Files' })
    await waitFor(() => expect(menu.textContent).toContain('src/util/math.ts'))
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(box.value).toContain('@src/util/math.ts')
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    expect(run.mock.calls[0]![0].prompt).toContain('`src/util/math.ts`')
  })

  it('finds the menu and mentions from the text at the caret', () => {
    expect(menuAt('/te', 3)).toEqual({ kind: 'slash', query: 'te' })
    expect(menuAt('/test now', 9)).toBeNull()
    expect(menuAt('see @src/a', 10)).toEqual({ kind: 'mention', query: 'src/a', start: 4, end: 10 })
    expect(menuAt('email me@x.com', 14)).toBeNull()
    expect(mentionedPaths('fix @src/a.ts and @b.ts.')).toEqual(['src/a.ts', 'b.ts'])
  })
})

// ── approvals ───────────────────────────────────────────────────────────────

describe('command approval', () => {
  it('shows the command the run wants to execute and answers it on Allow', async () => {
    let finish: (value: RunResult) => void = () => {}
    let runId = ''
    const run = vi.fn((_task: Task, options?: RunOptions) => {
      runId = options!.runId!
      return new Promise<RunResult>((resolve) => {
        finish = resolve
      })
    })
    const client = fakeClient(run)
    mount(client)
    const box = type('run the tests')
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    act(() => {
      client.emit({
        id: 'e-ask',
        ts: Date.now(),
        runId,
        kind: 'ask',
        payload: { question: 'Allow this command to run?\nnpm test', approval: { kind: 'command', command: 'npm test', cwd: '.', risk: null } },
      })
    })
    const card = await screen.findByRole('alertdialog', { name: 'Command approval' })
    expect(card.textContent).toContain('npm test')
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(client.reply).toHaveBeenCalledWith(runId, 'yes'))
    expect(screen.queryByRole('alertdialog', { name: 'Command approval' })).toBeNull()
    act(() => finish(done()))
  })

  it('reads a typed answer conservatively', () => {
    expect(parseApprovalText('yes please')).toBe('allow')
    expect(parseApprovalText('always')).toBe('allow-always')
    expect(parseApprovalText('nope')).toBe('deny')
  })
})

// ── receipts ────────────────────────────────────────────────────────────────

describe('the receipt under a reply', () => {
  it('is built from events: last outcome per check, commands with exit codes, calls, tokens, time', () => {
    const ev = (kind: SketchEvent['kind'], payload: Record<string, unknown>, ts: number): SketchEvent => ({ id: `${kind}-${ts}`, ts, runId: 'r', kind, payload })
    const receipt = receiptFor([
      ev('run_started', {}, 1000),
      ev('llm_response', { usage: { in: 100, out: 20 } }, 1100),
      ev('verify_result', { name: 'unit', ok: false }, 1200),
      ev('tool_called', { phase: 'result', name: 'run_command', detail: { command: 'npm test', exitCode: 1 } }, 1300),
      ev('llm_response', { usage: { in: 150, out: 30 } }, 1400),
      ev('verify_result', { name: 'unit', ok: true }, 1500),
      ev('run_completed', { ok: true }, 4000),
    ])
    expect(receipt.checks).toEqual([{ name: 'unit', ok: true }])
    expect(receipt.commands).toEqual([{ command: 'npm test', exitCode: 1 }])
    expect(receipt.modelCalls).toBe(2)
    expect(receipt.tokens).toEqual({ in: 250, out: 50 })
    expect(receipt.durationMs).toBe(3000)
  })
})

// ── fuzzy matching and the palette ──────────────────────────────────────────

describe('fuzzy matching', () => {
  it('prefers file-name and word-boundary hits', () => {
    const files = ['src/components/StatusBar.tsx', 'docs/status-report.md', 'src/state/AppState.tsx', 'src/lib/stats.ts']
    expect(fuzzyFilter(files, 'stbar', (f) => f)[0]).toBe('src/components/StatusBar.tsx')
    expect(fuzzyFilter(files, 'appst', (f) => f)[0]).toBe('src/state/AppState.tsx')
    expect(fuzzyScore('xyz', 'src/app.ts')).toBeNull()
  })
})

describe('Quick Open and the Command Palette', () => {
  it('Ctrl+P lists project files; Ctrl+Shift+P runs an app action', async () => {
    const run = vi.fn(async (_task: Task, _options?: RunOptions) => done())
    const projectFiles = vi.fn(async () => ({ root: 'C:\\workspace', files: ['src/app.ts', 'README.md'], truncated: false, maxFiles: 20000 }))
    const client = fakeClient(run, { projectFiles })
    render(
      <SketchClientProvider client={client}>
        <AppStateProvider initial={base}>
          <AgentSessionProvider>
            <PaletteHarness />
          </AgentSessionProvider>
        </AppStateProvider>
      </SketchClientProvider>,
    )
    fireEvent.click(screen.getByText('open files'))
    const fileBox = await screen.findByLabelText('File name')
    fireEvent.change(fileBox, { target: { value: 'app' } })
    expect(await screen.findByText('app.ts')).toBeDefined()
    fireEvent.keyDown(fileBox, { key: 'Escape' })

    fireEvent.click(screen.getByText('open commands'))
    const commandBox = await screen.findByLabelText('Command')
    fireEvent.change(commandBox, { target: { value: '>mode auto' } })
    expect(await screen.findByText('Agent Mode: Auto')).toBeDefined()
    fireEvent.keyDown(commandBox, { key: 'Enter' })
    expect(await screen.findByText('mode: auto')).toBeDefined()
  })

  it('an editor command with no editor to run it says so instead of doing nothing', async () => {
    const run = vi.fn(async (_task: Task, _options?: RunOptions) => done())
    const file = 'C:/workspace/src/app.ts'
    render(
      <SketchClientProvider client={fakeClient(run)}>
        <AppStateProvider initial={{ ...base, projectRoot: 'C:/workspace', openFiles: [file], files: { [file]: makeFileEntry(file, 'x') }, activeFile: file }}>
          <AgentSessionProvider>
            <PaletteHarness />
          </AgentSessionProvider>
        </AppStateProvider>
      </SketchClientProvider>,
    )
    fireEvent.click(screen.getByText('open commands'))
    const commandBox = await screen.findByLabelText('Command')
    fireEvent.change(commandBox, { target: { value: '>format document' } })
    expect(await screen.findByText('Format Document')).toBeDefined()
    fireEvent.keyDown(commandBox, { key: 'Enter' })
    expect(await screen.findByText(/works in the code editor, which is not ready yet/)).toBeDefined()
  })
})

import { makeFileEntry, useAppDispatch, useAppState } from './state/AppState'
function PaletteHarness() {
  const dispatch = useAppDispatch()
  const state = useAppState()
  return (
    <>
      <button onClick={() => dispatch({ type: 'OPEN_PALETTE', payload: 'files' })}>open files</button>
      <button onClick={() => dispatch({ type: 'OPEN_PALETTE', payload: 'commands' })}>open commands</button>
      <span>mode: {state.agentPrefs.mode}</span>
      <span>{state.editorNotice?.message ?? ''}</span>
      <CommandPalette />
    </>
  )
}
