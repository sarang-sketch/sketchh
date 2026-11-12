import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunOptions, SketchClient } from '../../lib/client'
import { SketchClientProvider } from '../../lib/ClientProvider'
import { DESKTOP_RUN_DEFAULTS } from '../../lib/runDefaults'
import type { ProviderSettingsEntry, RunResult, SketchEvent, Task } from '../../lib/contracts'
import { AppStateProvider, DEFAULT_AGENT_PREFS, type ChatMessage } from '../../state/AppState'
import { AgentChat } from './AgentChat'

// The credential store is native, so the resolve seam is the boundary a webview test can
// stand at. What matters here is that the panel ASKS for the selected provider's key and
// puts the answer on the run — not how Rust reads it.
const resolveApiKeyForRun = vi.hoisted(() => vi.fn<(id: string, onProblem?: (reason: string) => void) => Promise<string | null>>())
vi.mock('../../lib/secrets', () => ({ resolveApiKeyForRun }))

const ollama: ProviderSettingsEntry = {
  id: 'ollama-local',
  kind: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen2.5-coder:7b',
  label: 'Local Ollama',
}
const other: ProviderSettingsEntry = {
  id: 'llama-local',
  kind: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: 'coder',
  label: 'Other local',
}

function clientWith(run: (task: Task, options?: RunOptions) => Promise<RunResult>): SketchClient {
  return {
    transport: 'mock',
    ping: async () => ({ ok: true, version: 'test', transport: 'mock' }),
    run,
    subscribe: () => () => {},
  } as unknown as SketchClient
}

function result(): RunResult {
  return {
    runId: 'agent-chat-run',
    ok: true,
    finalText: 'done',
    iterations: 1,
    verify: [],
    events: [],
  }
}

function send(client: SketchClient, initial: Parameters<typeof AppStateProvider>[0]['initial']) {
  render(
    <SketchClientProvider client={client}>
      <AppStateProvider initial={initial}>
        <AgentChat />
      </AppStateProvider>
    </SketchClientProvider>,
  )
  const box = screen.getByLabelText('Message the agent')
  fireEvent.change(box, { target: { value: 'Make the local edit' } })
  fireEvent.keyDown(box, { key: 'Enter' })
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  resolveApiKeyForRun.mockReset()
  resolveApiKeyForRun.mockResolvedValue(null)
})

afterEach(() => cleanup())

describe('AgentChat provider selection', () => {
  it('passes the authoritative selected key-free entry to the run', async () => {
    const run = vi.fn(async (_task: Task, _options?: RunOptions) => result())
    send(clientWith(run), {
      projectRoot: 'C:\\workspace',
      providerSettingsPath: 'C:\\Users\\test\\.sketch\\providers.json',
      providers: [other, ollama],
      selectedProvider: ollama.id,
      selectedModel: ollama.model,
    })

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    const options = run.mock.calls[0]![1]
    expect(options?.provider).toEqual(ollama)
    expect(options?.provider).toBe(ollama)
    expect(JSON.stringify(options?.provider)).not.toContain('apiKey')
    // Auto-apply is the default preference: edits are written as the run makes them,
    // and every run can be undone from its snapshot.
    expect(options?.reviewEdits).toBe(false)
    // A desktop run must reach the model with repository context and a spend ceiling.
    // Without these the retrieval engine is unreachable and the bill is unbounded.
    expect(options?.contextBudgetTokens).toBe(DESKTOP_RUN_DEFAULTS.contextBudgetTokens)
    expect(options?.contextBudgetTokens).toBeGreaterThan(0)
    expect(options?.budget?.onBreach).toBe('stop')
    expect(options?.budget?.maxCalls).toBeGreaterThan(0)
    expect(options?.budget?.maxUsd).toBeGreaterThan(0)
    // Without this the project never remembers anything it was not told by hand.
    expect(options?.rememberRun).toBe(true)
    // The agent can read the project, and a fresh folder is indexed for retrieval.
    expect(options?.projectTools).toBe(true)
    expect(options?.autoIndex).toBe(true)
    expect(options?.maxIterations).toBeGreaterThanOrEqual(DESKTOP_RUN_DEFAULTS.maxIterations)
    expect(options?.root).toBe('C:\\workspace')
  })

  it('leaves edits for review when the user chose "Ask me first"', async () => {
    const run = vi.fn(async (_task: Task, _options?: RunOptions) => result())
    send(clientWith(run), {
      projectRoot: 'C:\\workspace',
      providerSettingsPath: 'C:\\Users\\test\\.sketch\\providers.json',
      providers: [ollama],
      selectedProvider: ollama.id,
      selectedModel: ollama.model,
      agentPrefs: { ...DEFAULT_AGENT_PREFS, autoApply: false },
    })
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    expect(run.mock.calls[0]![1]?.reviewEdits).toBe(true)
  })

  it('sends the conversation so far, so a follow-up keeps its context', async () => {
    const run = vi.fn(async (_task: Task, _options?: RunOptions) => result())
    render(
      <SketchClientProvider client={clientWith(run)}>
        <AppStateProvider
          initial={{
            projectRoot: 'C:\\workspace',
            providerSettingsPath: 'C:\\Users\\test\\.sketch\\providers.json',
            providers: [ollama],
            selectedProvider: ollama.id,
            selectedModel: ollama.model,
            chatMessages: [
              { id: 'u1', role: 'user', content: 'write a slugify helper', timestamp: 1 },
              { id: 'a1', role: 'agent', content: 'Added slugify().', timestamp: 2 },
              { id: 's1', role: 'system', content: 'a notice the model should not see', timestamp: 3 },
            ],
          }}
        >
          <AgentChat />
        </AppStateProvider>
      </SketchClientProvider>,
    )
    const box = screen.getByLabelText('Message the agent')
    fireEvent.change(box, { target: { value: 'now add tests for it' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    expect(run.mock.calls[0]![1]?.history).toEqual([
      { role: 'user', content: 'write a slugify helper' },
      { role: 'assistant', content: 'Added slugify().' },
    ])
  })

  it('does not start a run without an open folder, and says how to fix it', async () => {
    const run = vi.fn(async (_task: Task, _options?: RunOptions) => result())
    send(clientWith(run), {
      projectRoot: null,
      providerSettingsPath: 'C:\\Users\\test\\.sketch\\providers.json',
      providers: [ollama],
      selectedProvider: ollama.id,
      selectedModel: ollama.model,
    })
    expect(await screen.findAllByText(/Open a project folder/)).not.toHaveLength(0)
    expect(run).not.toHaveBeenCalled()
  })

  it('does not start a run when no model is connected, and offers to connect one', async () => {
    const run = vi.fn(async (_task: Task, _options?: RunOptions) => result())
    send(clientWith(run), {
      projectRoot: 'C:\\workspace',
      providerSettingsPath: 'C:\\Users\\test\\.sketch\\providers.json',
      providers: [],
      selectedProvider: null,
      selectedModel: null,
    })
    expect(await screen.findAllByText(/Connect a model to start/)).not.toHaveLength(0)
    expect(run).not.toHaveBeenCalled()
  })

  it('resolves the stored key for the selected provider at invocation time', async () => {
    resolveApiKeyForRun.mockResolvedValue('sk-stored-0123456789')
    const run = vi.fn(async (_task: Task, _options?: RunOptions) => result())
    send(clientWith(run), {
      projectRoot: 'C:\\workspace',
      providerSettingsPath: 'C:\\Users\\test\\.sketch\\providers.json',
      providers: [other, ollama],
      selectedProvider: ollama.id,
      selectedModel: ollama.model,
    })

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    // Asked for exactly the selected provider, and only that one.
    expect(resolveApiKeyForRun).toHaveBeenCalledTimes(1)
    expect(resolveApiKeyForRun.mock.calls[0]![0]).toBe(ollama.id)

    // A key saved before a restart now reaches the run (Requirement 17.4). Before this
    // path existed, only a key typed for that call could.
    const options = run.mock.calls[0]![1]
    expect(options?.apiKey).toBe('sk-stored-0123456789')
    // And the persisted entry is still the key-free row from settings.
    expect(JSON.stringify(options?.provider)).not.toContain('sk-stored')
    expect(options?.provider).toBe(ollama)
  })

  it('offers Stop while a run is in flight and cancels the id it started', async () => {
    let settle: (result: RunResult) => void = () => {}
    const run = vi.fn(
      (_task: Task, _options?: RunOptions) => new Promise<RunResult>((resolve) => { settle = resolve }),
    )
    const cancel = vi.fn(async (runId: string) => ({ runId, cancelled: true, detail: 'ok' }))
    const client = { ...clientWith(run), cancel } as unknown as SketchClient
    send(client, {
      projectRoot: 'C:\\workspace',
      providerSettingsPath: 'C:\\Users\\test\\.sketch\\providers.json',
      providers: [ollama],
      selectedProvider: ollama.id,
      selectedModel: ollama.model,
    })

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    // The panel supplies the id, so Stop works without waiting for `run_started`.
    const runId = run.mock.calls[0]![1]!.runId
    expect(typeof runId).toBe('string')

    const stop = await waitFor(() => screen.getByLabelText('Stop this run'))
    fireEvent.click(stop)
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
    // Exactly the run this panel started — not a guess, and not every run.
    expect(cancel).toHaveBeenCalledWith(runId)

    // The run's own terminal result is still what gets reported: cancel writes no
    // message of its own.
    settle({ runId: runId!, ok: false, finalText: 'Run aborted.', iterations: 1, verify: [], events: [] })
    await waitFor(() => expect(screen.getByLabelText('Send')).toBeTruthy())
  })

  it('refuses a second concurrent run from the same panel', async () => {
    const run = vi.fn((_task: Task, _options?: RunOptions) => new Promise<RunResult>(() => {}))
    send(clientWith(run), {
      projectRoot: 'C:\\workspace',
      providerSettingsPath: 'C:\\Users\\test\\.sketch\\providers.json',
      providers: [ollama],
      selectedProvider: ollama.id,
      selectedModel: ollama.model,
    })

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    // The first message moves the panel into its conversation view, which has its own
    // follow-up box.
    const box = await waitFor(() => screen.getByLabelText('Message the agent'))
    fireEvent.change(box, { target: { value: 'And another thing' } })
    fireEvent.keyDown(box, { key: 'Enter' })

    // A second bill nobody asked for. The engine would refuse the duplicate id anyway;
    // the panel must not send it.
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('answers a paused run instead of starting a second one', async () => {
    let emit: (event: SketchEvent) => void = () => {}
    const run = vi.fn((_task: Task, _options?: RunOptions) => new Promise<RunResult>(() => {}))
    const reply = vi.fn(async (runId: string, _answer: string) => ({ runId, answered: true }))
    const client = {
      ...clientWith(run),
      reply,
      subscribe: (handler: (event: SketchEvent) => void) => { emit = handler; return () => {} },
    } as unknown as SketchClient
    send(client, {
      projectRoot: 'C:\\workspace',
      providerSettingsPath: 'C:\\Users\\test\\.sketch\\providers.json',
      providers: [ollama],
      selectedProvider: ollama.id,
      selectedModel: ollama.model,
    })

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    const options = run.mock.calls[0]![1]!
    // The panel has a person in front of it, so a question must pause rather than end.
    expect(options.interactive).toBe(true)
    const runId = options.runId!

    // The paused run announces itself on the event stream; the run promise is still open.
    emit({ id: 'e1', ts: 1, runId, kind: 'ask', payload: { question: 'Which database?' } })
    const box = await waitFor(() => screen.getByPlaceholderText('Answer the question above...'))

    fireEvent.change(box, { target: { value: 'Postgres' } })
    fireEvent.keyDown(box, { key: 'Enter' })

    // Answered, not restarted. Sending a new task here would abandon the paused run and
    // start a second bill.
    await waitFor(() => expect(reply).toHaveBeenCalledWith(runId, 'Postgres'))
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('ignores a question belonging to a different run', async () => {
    let emit: (event: SketchEvent) => void = () => {}
    const run = vi.fn((_task: Task, _options?: RunOptions) => new Promise<RunResult>(() => {}))
    const client = {
      ...clientWith(run),
      subscribe: (handler: (event: SketchEvent) => void) => { emit = handler; return () => {} },
    } as unknown as SketchClient
    send(client, {
      projectRoot: 'C:\\workspace',
      providerSettingsPath: 'C:\\Users\\test\\.sketch\\providers.json',
      providers: [ollama],
      selectedProvider: ollama.id,
      selectedModel: ollama.model,
    })

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    const runId = run.mock.calls[0]![1]!.runId!

    // One engine serves several runs. A question from somebody else's run must not hijack
    // this panel's box.
    await act(async () => {
      emit({ id: 'e1', ts: 1, runId: 'someone-elses-run', kind: 'ask', payload: { question: 'Not yours' } })
    })
    expect(screen.queryByPlaceholderText('Answer the question above...')).toBeNull()

    // The panel's OWN question does open it, so the check above is scoping and not a
    // subscription that never fires.
    await act(async () => {
      emit({ id: 'e2', ts: 2, runId, kind: 'ask', payload: { question: 'Which database?' } })
    })
    expect(screen.getByPlaceholderText('Answer the question above...')).toBeTruthy()
  })

  it('runs key-free when nothing is stored, without an apiKey property', async () => {
    resolveApiKeyForRun.mockResolvedValue(null)
    const run = vi.fn(async (_task: Task, _options?: RunOptions) => result())
    send(clientWith(run), {
      projectRoot: 'C:\\workspace',
      providerSettingsPath: 'C:\\Users\\test\\.sketch\\providers.json',
      providers: [ollama],
      selectedProvider: ollama.id,
      selectedModel: ollama.model,
    })

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    // The common local case. An `apiKey: undefined` own property would still be a key
    // on the wire for the engine to validate.
    expect(Object.keys(run.mock.calls[0]![1] ?? {})).not.toContain('apiKey')
  })

  it('passes no fabricated fallback when the selected id resolves to no entry', async () => {
    const run = vi.fn(async (_task: Task, _options?: RunOptions) => result())
    send(clientWith(run), {
      projectRoot: 'C:\\workspace',
      providerSettingsPath: 'C:\\Users\\test\\.sketch\\providers.json',
      providers: [ollama],
      selectedProvider: 'missing-provider',
      selectedModel: null,
    })

    // A stale selection is named, not silently swapped for another provider and not
    // sent provider-less: the run does not start at all.
    expect(await screen.findByText(/no longer configured/)).toBeTruthy()
    expect(run).not.toHaveBeenCalled()
  })
})

describe('AgentChat message actions (Copy / Retry)', () => {
  const connected = {
    projectRoot: 'C:\\workspace',
    providerSettingsPath: 'C:\\Users\\test\\.sketch\\providers.json',
    providers: [ollama],
    selectedProvider: ollama.id,
    selectedModel: ollama.model,
  }
  const finished: ChatMessage[] = [
    { id: 'u1', role: 'user', content: 'write a slugify helper', timestamp: 1 },
    { id: 'a1', role: 'agent', content: 'Added slugify().', timestamp: 2, ok: true, runId: 'r1' },
  ]

  function mount(run: (task: Task, options?: RunOptions) => Promise<RunResult>, messages: ChatMessage[] = finished) {
    render(
      <SketchClientProvider client={clientWith(run)}>
        <AppStateProvider initial={{ ...connected, chatMessages: messages }}>
          <AgentChat />
        </AppStateProvider>
      </SketchClientProvider>,
    )
  }

  it('Copy writes the reply text to the clipboard and shows a Copied state', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    mount(async () => result())

    fireEvent.click(screen.getByRole('button', { name: 'Copy reply' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Added slugify().'))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy()
  })

  it('Retry re-sends the request this reply answered, as one fresh run', async () => {
    const run = vi.fn(async (_task: Task, _options?: RunOptions) => result())
    mount(run)

    fireEvent.click(screen.getByRole('button', { name: 'Retry this request' }))
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    // The prompt the reply answered — the user turn before it — is what is re-sent.
    expect(run.mock.calls[0]![0]!.prompt).toContain('write a slugify helper')
  })

  it('shows no Retry when there is no earlier request behind the reply (no dead button)', () => {
    // An agent reply with no user turn before it: Retry would have nothing to send.
    mount(async () => result(), [
      { id: 'a1', role: 'agent', content: 'A reply with no prompt before it.', timestamp: 1, ok: true },
    ])
    expect(screen.queryByRole('button', { name: 'Retry this request' })).toBeNull()
    // Copy is still offered, because there IS text to copy.
    expect(screen.getByRole('button', { name: 'Copy reply' })).toBeTruthy()
  })
})

describe('AgentChat — a stopped run reads as Stopped, not as a failure', () => {
  const connected = {
    projectRoot: 'C:\\workspace',
    providerSettingsPath: 'C:\\Users\\test\\.sketch\\providers.json',
    providers: [ollama],
    selectedProvider: ollama.id,
    selectedModel: ollama.model,
  }
  const abortedEvent = (runId: string): SketchEvent =>
    ({ id: 'ev-abort', ts: 1, runId, kind: 'run_failed', payload: { reason: 'aborted' } } as SketchEvent)

  it('a run the USER stopped shows a neutral "Stopped", no "did not finish"', async () => {
    let settle: (r: RunResult) => void = () => {}
    const run = vi.fn((_t: Task, _o?: RunOptions) => new Promise<RunResult>((r) => { settle = r }))
    const cancel = vi.fn(async (runId: string) => ({ runId, cancelled: true, detail: 'ok' }))
    render(
      <SketchClientProvider client={{ ...clientWith(run), cancel } as unknown as SketchClient}>
        <AppStateProvider initial={connected}>
          <AgentChat />
        </AppStateProvider>
      </SketchClientProvider>,
    )
    const box = screen.getByLabelText('Message the agent')
    fireEvent.change(box, { target: { value: 'do a long thing' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    const runId = run.mock.calls[0]![1]!.runId!

    // The user presses Stop, then the run ends aborted (the engine's own terminal event).
    fireEvent.click(await waitFor(() => screen.getByLabelText('Stop this run')))
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(runId))
    settle({ runId, ok: false, finalText: 'Run aborted.', iterations: 1, verify: [], events: [abortedEvent(runId)] })

    // Neutral Stopped state: the plain sentence, a "Stopped" chip, and NO failure marker
    // and NOT the engine's raw "Run aborted." text.
    expect(await screen.findByText(/Nothing more was changed after you pressed Stop/)).toBeTruthy()
    expect(screen.getByText('Stopped')).toBeTruthy()
    expect(screen.queryByText('did not finish')).toBeNull()
    expect(screen.queryByText('Run aborted.')).toBeNull()
  })

  it('an abort the user did NOT request keeps the failure styling and text', async () => {
    let settle: (r: RunResult) => void = () => {}
    const run = vi.fn((_t: Task, _o?: RunOptions) => new Promise<RunResult>((r) => { settle = r }))
    render(
      <SketchClientProvider client={clientWith(run)}>
        <AppStateProvider initial={connected}>
          <AgentChat />
        </AppStateProvider>
      </SketchClientProvider>,
    )
    const box = screen.getByLabelText('Message the agent')
    fireEvent.change(box, { target: { value: 'do a thing' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    const runId = run.mock.calls[0]![1]!.runId!

    // No Stop was pressed; the run is aborted for some other reason (e.g. engine shutdown).
    settle({ runId, ok: false, finalText: 'Run aborted.', iterations: 1, verify: [], events: [abortedEvent(runId)] })

    // Failure styling and the engine's text are kept; no neutral "Stopped".
    expect(await screen.findByText('Run aborted.')).toBeTruthy()
    expect(screen.getByText('did not finish')).toBeTruthy()
    expect(screen.queryByText('Stopped')).toBeNull()
  })
})