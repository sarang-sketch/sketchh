import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunOptions, SketchClient } from '../../lib/client'
import { SketchClientProvider } from '../../lib/ClientProvider'
import { DESKTOP_RUN_DEFAULTS } from '../../lib/runDefaults'
import type { ProviderSettingsEntry, RunResult, Task } from '../../lib/contracts'
import { AppStateProvider } from '../../state/AppState'
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
  const box = screen.getByPlaceholderText('How can I help you today?')
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
    expect(options?.reviewEdits).toBe(true)
    // A desktop run must reach the model with repository context and a spend ceiling.
    // Without these the retrieval engine is unreachable and the bill is unbounded.
    expect(options?.contextBudgetTokens).toBe(DESKTOP_RUN_DEFAULTS.contextBudgetTokens)
    expect(options?.contextBudgetTokens).toBeGreaterThan(0)
    expect(options?.budget).toEqual({ ...DESKTOP_RUN_DEFAULTS.budget })
    expect(options?.budget?.onBreach).toBe('stop')
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

  it('runs key-free when nothing is stored, without an apiKey property', async () => {
    resolveApiKeyForRun.mockResolvedValue(null)
    const run = vi.fn(async (_task: Task, _options?: RunOptions) => result())
    send(clientWith(run), {
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
      providerSettingsPath: 'C:\\Users\\test\\.sketch\\providers.json',
      providers: [ollama],
      selectedProvider: 'missing-provider',
      selectedModel: null,
    })

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    expect(run.mock.calls[0]![1]).not.toHaveProperty('provider')
  })
})