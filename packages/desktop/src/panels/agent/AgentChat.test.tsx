import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunOptions, SketchClient } from '../../lib/client'
import { SketchClientProvider } from '../../lib/ClientProvider'
import type { ProviderSettingsEntry, RunResult, Task } from '../../lib/contracts'
import { AppStateProvider } from '../../state/AppState'
import { AgentChat } from './AgentChat'

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