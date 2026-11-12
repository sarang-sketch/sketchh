import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConnectWizard, LOCAL_PROBE_MS } from './components/settings/ConnectWizard'
import { SettingsDialog } from './components/settings/SettingsDialog'
import { SketchClientProvider } from './lib/ClientProvider'
import type { RunOptions, SketchClient } from './lib/client'
import type { ProviderDescriptor, RunResult, Task } from './lib/contracts'
import IdeChatSidebar from './panels/ide/IdeChatSidebar'
import { KeyStoreProvider } from './settings/KeyStoreProvider'
import type { KeyStore } from './settings/keyStore'
import { AppStateProvider } from './state/AppState'

const resolveApiKeyForRun = vi.hoisted(() => vi.fn(async () => null as string | null))
vi.mock('./lib/secrets', () => ({ resolveApiKeyForRun }))

const CATALOG: ProviderDescriptor[] = [
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai-compatible', defaultBaseUrl: 'https://openrouter.ai/api/v1', needsKey: true, serverless: true },
  { id: 'groq', name: 'Groq', kind: 'openai-compatible', defaultBaseUrl: 'https://api.groq.com/openai/v1', needsKey: true, serverless: true },
  { id: 'ollama', name: 'Ollama (local)', kind: 'openai-compatible', defaultBaseUrl: 'http://localhost:11434/v1', needsKey: false, serverless: false },
]

const KEY = 'gsk_wizardtest0123456789'

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  resolveApiKeyForRun.mockReset()
  resolveApiKeyForRun.mockResolvedValue(null)
})
afterEach(() => cleanup())

function fakeClient(overrides: Partial<SketchClient> = {}) {
  const saved: unknown[] = []
  const client = {
    transport: 'mock',
    ping: async () => ({ ok: true, version: 'test', transport: 'mock' }),
    subscribe: () => () => {},
    providerCatalog: async () => ({ catalog: CATALOG, settings: { version: 1, providers: [], selected: null }, path: '/home/.sketch/providers.json' }),
    providerModels: vi.fn(async () => ({
      ok: true,
      code: 'ok',
      message: '3 models',
      url: 'x',
      models: [{ id: 'whisper-large-v3' }, { id: 'llama-3.3-70b-versatile', contextLength: 131072 }, { id: 'qwen-2.5-coder-32b' }],
    })),
    saveProviderSettings: vi.fn(async ({ settings }: { settings: unknown }) => {
      saved.push(settings)
      return { settings, path: '/home/.sketch/providers.json' }
    }),
    testProvider: vi.fn(async () => ({ ok: true, code: 'ok', message: 'groq: api.groq.com answered and serves the model', url: 'x', durationMs: 5 })),
    ...overrides,
  } as unknown as SketchClient
  return { client, saved }
}

describe('Connect a model', () => {
  it('walks pick → key → model from the provider list → saved and tested, key to the OS store only', async () => {
    const { client, saved } = fakeClient()
    const keyStore: KeyStore = {
      presence: vi.fn(async () => []),
      save: vi.fn(async () => 'Windows Credential Manager'),
      remove: vi.fn(async () => 'Windows Credential Manager'),
    }
    render(
      <SketchClientProvider client={client}>
        <KeyStoreProvider store={keyStore}>
          <AppStateProvider
            initial={{ connectOpen: true, providerCatalog: CATALOG, providerSettingsPath: '/home/.sketch/providers.json' }}
          >
            <ConnectWizard />
          </AppStateProvider>
        </KeyStoreProvider>
      </SketchClientProvider>,
    )

    fireEvent.click(await screen.findByText('Groq'))
    fireEvent.change(screen.getByLabelText('API key for Groq'), { target: { value: KEY } })
    fireEvent.click(screen.getByText('Continue'))

    // The provider's own list, chat models first, a coder preselected by pattern.
    await screen.findByRole('listbox', { name: 'Models' })
    const listCalls = (client.providerModels as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0] as { provider: { id: string } },
    )
    expect(listCalls.find((call) => call.provider.id === 'groq')).toMatchObject({
      provider: { id: 'groq', apiKey: KEY },
    })
    expect((screen.getByLabelText('Model id') as HTMLInputElement).value).toBe('qwen-2.5-coder-32b')

    fireEvent.click(screen.getByText('Finish setup'))
    await screen.findByText(/Connected to Groq/)

    expect(keyStore.save).toHaveBeenCalledWith('groq', KEY)
    // providers.json gets the five key-free fields and nothing else.
    expect(JSON.stringify(saved)).not.toContain(KEY)
    expect(saved[0]).toMatchObject({ selected: 'groq', providers: [{ id: 'groq', model: 'qwen-2.5-coder-32b' }] })
    expect(client.testProvider).toHaveBeenCalled()
    expect(screen.getByText(/Your key is stored in Windows Credential Manager/)).toBeTruthy()
  })

  it('explains a local runtime that is not running instead of failing silently', async () => {
    const { client } = fakeClient({
      providerModels: vi.fn(async () => ({ ok: false, code: 'unreachable', message: 'nothing', url: 'x', models: [] })),
    } as Partial<SketchClient>)
    render(
      <SketchClientProvider client={client}>
        <AppStateProvider initial={{ connectOpen: true, providerCatalog: CATALOG, providerSettingsPath: '/p' }}>
          <ConnectWizard />
        </AppStateProvider>
      </SketchClientProvider>,
    )
    fireEvent.click(await screen.findByText('Ollama (local)'))
    fireEvent.click(screen.getByText('Find models'))
    expect(await screen.findByText(/Install Ollama from ollama.com/)).toBeTruthy()
  })

  it('offers a model server running on this computer first, and connects it in one click with no key', async () => {
    const { client, saved } = fakeClient()
    render(
      <SketchClientProvider client={client}>
        <AppStateProvider initial={{ connectOpen: true, providerCatalog: CATALOG, providerSettingsPath: '/p' }}>
          <ConnectWizard />
        </AppStateProvider>
      </SketchClientProvider>,
    )

    const offer = await screen.findByText(/Ollama is running on this computer/)
    // Only the local runtime is probed: no hosted provider is contacted before a choice.
    const probes = (client.providerModels as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])
    expect(probes).toEqual([
      { provider: { id: 'ollama', kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }, timeoutMs: LOCAL_PROBE_MS },
    ])
    expect(screen.getByText(/Use qwen-2.5-coder-32b in one click/)).toBeTruthy()

    fireEvent.click(offer)
    await screen.findByText(/Connected to Ollama \(local\)/)
    expect(saved[0]).toMatchObject({
      selected: 'ollama',
      providers: [{ id: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen-2.5-coder-32b' }],
    })
    expect(client.testProvider).toHaveBeenCalled()
    expect(screen.getByText(/nothing leaves the machine/)).toBeTruthy()
    expect(screen.getByText(/OLLAMA_CONTEXT_LENGTH=32768/)).toBeTruthy()
  })

  it('does not offer a local runtime that did not answer the probe', async () => {
    const { client } = fakeClient({
      providerModels: vi.fn(async () => ({ ok: false, code: 'unreachable', message: 'nothing', url: 'x', models: [] })),
    } as Partial<SketchClient>)
    render(
      <SketchClientProvider client={client}>
        <AppStateProvider initial={{ connectOpen: true, providerCatalog: CATALOG, providerSettingsPath: '/p' }}>
          <ConnectWizard />
        </AppStateProvider>
      </SketchClientProvider>,
    )
    await waitFor(() => expect(client.providerModels).toHaveBeenCalledTimes(1))
    await screen.findByText('Ollama (local)')
    expect(screen.queryByText(/is running on this computer/)).toBeNull()
  })

  it('does not probe a local runtime that is already connected', async () => {
    const { client } = fakeClient()
    render(
      <SketchClientProvider client={client}>
        <AppStateProvider
          initial={{
            connectOpen: true,
            providerCatalog: CATALOG,
            providerSettingsPath: '/p',
            providers: [{ id: 'ollama', kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'llama3', label: 'Ollama (local)' }],
          }}
        >
          <ConnectWizard />
        </AppStateProvider>
      </SketchClientProvider>,
    )
    await screen.findByText('Ollama (local)')
    expect(client.providerModels).not.toHaveBeenCalled()
    expect(screen.queryByText(/is running on this computer/)).toBeNull()
  })

  it('is reachable from Settings in either surface', async () => {
    const { client } = fakeClient()
    render(
      <SketchClientProvider client={client}>
        <AppStateProvider initial={{ settingsOpen: true, providerCatalog: CATALOG, providerSettingsPath: '/p' }}>
          <SettingsDialog />
          <ConnectWizard />
        </AppStateProvider>
      </SketchClientProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Connect a model/ }))
    expect(await screen.findByRole('dialog', { name: 'Connect a model' })).toBeTruthy()
  })
})

describe('the Code sidebar talks to the engine', () => {
  it('starts a real run with the selected provider — no canned reply', async () => {
    const run = vi.fn(async (_task: Task, _options?: RunOptions): Promise<RunResult> => ({
      runId: 'x',
      ok: true,
      finalText: 'The **answer** from the model.',
      iterations: 2,
      verify: [],
      events: [],
    }))
    const { client } = fakeClient({ run } as Partial<SketchClient>)
    const provider = { id: 'groq', kind: 'openai-compatible' as const, baseUrl: 'https://api.groq.com/openai/v1', model: 'm', label: 'Groq' }
    render(
      <SketchClientProvider client={client}>
        <AppStateProvider
          initial={{
            mode: 'ide',
            projectRoot: 'C:\\work',
            providerSettingsPath: '/p',
            providers: [provider],
            selectedProvider: 'groq',
            selectedModel: 'm',
          }}
        >
          <IdeChatSidebar />
        </AppStateProvider>
      </SketchClientProvider>,
    )
    const box = screen.getByLabelText('Message the agent')
    fireEvent.change(box, { target: { value: 'what does this repo do?' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    expect(run.mock.calls[0]![0].prompt).toBe('what does this repo do?')
    expect(run.mock.calls[0]![1]?.provider).toBe(provider)
    // The engine's reply, rendered as Markdown — not the old fixed sentence.
    expect((await screen.findByText('answer')).tagName).toBe('STRONG')
    expect(screen.queryByText(/applying the required code changes directly/)).toBeNull()
  })
})
