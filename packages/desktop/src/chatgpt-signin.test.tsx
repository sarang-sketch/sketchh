// "Sign in with ChatGPT" from the window's side: one click connects the account's best
// model with no key anywhere, a busy callback port falls back to a sign-in code, the
// model picker lists every ChatGPT model, and Settings can sign out.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConnectWizard } from './components/settings/ConnectWizard'
import ModelSelector from './components/ModelSelector'
import { SketchClientProvider } from './lib/ClientProvider'
import type { ChatGPTLoginOutcome, ChatGPTLoginStart, SketchClient } from './lib/client'
import type { ProviderDescriptor, ProviderSettingsEntry } from './lib/contracts'
import { ProviderSettings } from './panels/ProviderSettings'
import { KeyStoreProvider } from './settings/KeyStoreProvider'
import type { KeyStore } from './settings/keyStore'
import { describeAccount, describePlan } from './settings/chatgpt'
import { AppStateProvider } from './state/AppState'

const resolveApiKeyForRun = vi.hoisted(() => vi.fn(async () => null as string | null))
vi.mock('./lib/secrets', () => ({ resolveApiKeyForRun }))

const CHATGPT: ProviderDescriptor = {
  id: 'chatgpt',
  name: 'ChatGPT (sign in)',
  kind: 'openai-compatible',
  defaultBaseUrl: 'https://chatgpt.com/backend-api/codex',
  needsKey: false,
  serverless: false,
}
const OPENROUTER: ProviderDescriptor = {
  id: 'openrouter',
  name: 'OpenRouter',
  kind: 'openai-compatible',
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  needsKey: true,
  serverless: true,
}
const CATALOG = [CHATGPT, OPENROUTER]

const MODELS = {
  ok: true,
  source: 'live' as const,
  models: [
    { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', description: 'Latest workhorse model.' },
    { id: 'gpt-6-luna', name: 'GPT-6-Luna', description: 'Fast and affordable.' },
  ],
  defaultModel: 'gpt-6.1-sol',
  message: '2 models available on your ChatGPT plan.',
}

const open = vi.fn()
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  open.mockReset()
  window.open = open as unknown as typeof window.open
  resolveApiKeyForRun.mockReset()
  resolveApiKeyForRun.mockResolvedValue(null)
})
afterEach(() => cleanup())

function fakeClient(overrides: Partial<SketchClient> = {}) {
  const saved: Array<{ providers: ProviderSettingsEntry[]; selected: string | null }> = []
  const client = {
    transport: 'mock',
    ping: async () => ({ ok: true, version: 'test', transport: 'mock' }),
    subscribe: () => () => {},
    providerCatalog: async () => ({ catalog: CATALOG, settings: { version: 1, providers: [], selected: null }, path: '/p' }),
    saveProviderSettings: vi.fn(async ({ settings }: { settings: { providers: ProviderSettingsEntry[]; selected: string | null } }) => {
      saved.push(settings)
      return { settings, path: '/p' }
    }),
    testProvider: vi.fn(async () => ({ ok: true, code: 'ok', message: 'ChatGPT answered as me@example.com', url: 'x', durationMs: 900 })),
    chatgptStatus: vi.fn(async () => ({ signedIn: false, needsSignIn: false, path: '/home/.sketch/auth/chatgpt.json' })),
    chatgptLoginStart: vi.fn(
      async (): Promise<ChatGPTLoginStart> => ({
        ok: true,
        mode: 'browser',
        id: 'login-1',
        authUrl: 'https://auth.openai.com/oauth/authorize?client_id=x',
        port: 1455,
        expiresAt: Date.now() + 600_000,
      }),
    ),
    chatgptLoginWait: vi.fn(async (): Promise<ChatGPTLoginOutcome> => ({ ok: true, account: { email: 'me@example.com', plan: 'plus' } })),
    chatgptLoginCancel: vi.fn(async ({ id }: { id: string }) => ({ id, cancelled: true })),
    chatgptLogout: vi.fn(async () => ({ signedOut: true, revoked: true })),
    chatgptModels: vi.fn(async () => MODELS),
    ...overrides,
  } as unknown as SketchClient
  return { client, saved }
}

function noKeys(): KeyStore {
  return {
    presence: vi.fn(async () => []),
    save: vi.fn(async () => 'Windows Credential Manager'),
    remove: vi.fn(async () => 'Windows Credential Manager'),
  }
}

describe('Sign in with ChatGPT', () => {
  it('connects the account’s best model in one click, with no key stored anywhere', async () => {
    const { client, saved } = fakeClient()
    const keyStore = noKeys()
    render(
      <SketchClientProvider client={client}>
        <KeyStoreProvider store={keyStore}>
          <AppStateProvider initial={{ connectOpen: true, providerCatalog: CATALOG, providerSettingsPath: '/p' }}>
            <ConnectWizard />
          </AppStateProvider>
        </KeyStoreProvider>
      </SketchClientProvider>,
    )

    fireEvent.click(await screen.findByText('Sign in with ChatGPT'))
    expect(await screen.findByText(/Connected to ChatGPT · GPT-6.1-Sol/)).toBeTruthy()

    // The consent page opened in the user's own browser.
    expect(open).toHaveBeenCalledWith('https://auth.openai.com/oauth/authorize?client_id=x', '_blank', 'noopener,noreferrer')
    expect(client.chatgptLoginStart).toHaveBeenCalledWith({ mode: 'browser' })
    expect(client.chatgptLoginWait).toHaveBeenCalledWith({ id: 'login-1' })

    // Saved key-free, selected, and tested — no credential went to the OS store.
    expect(saved[0]).toMatchObject({
      selected: 'chatgpt',
      providers: [{ id: 'chatgpt', model: 'gpt-6.1-sol', baseUrl: 'https://chatgpt.com/backend-api/codex', label: 'ChatGPT' }],
    })
    expect(keyStore.save).not.toHaveBeenCalled()
    const tested = (client.testProvider as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(tested.provider).toMatchObject({ id: 'chatgpt', model: 'gpt-6.1-sol' })
    expect(tested.provider).not.toHaveProperty('apiKey')
    expect(screen.getByText(/Signed in as me@example.com · Plus/)).toBeTruthy()

    // Switching to another model of the account is one choice away.
    fireEvent.change(screen.getByLabelText('ChatGPT model'), { target: { value: 'gpt-6-luna' } })
    await waitFor(() => expect(saved.at(-1)?.providers[0]?.model).toBe('gpt-6-luna'))

    // Choosing records the model; it does not start a network test per choice. Arrowing
    // back and forth quickly saves once, with the last choice.
    const testCalls = () => (client.testProvider as ReturnType<typeof vi.fn>).mock.calls
    expect(testCalls()).toHaveLength(1)
    const savesBefore = saved.length
    fireEvent.change(screen.getByLabelText('ChatGPT model'), { target: { value: 'gpt-6.1-sol' } })
    fireEvent.change(screen.getByLabelText('ChatGPT model'), { target: { value: 'gpt-6-luna' } })
    fireEvent.change(screen.getByLabelText('ChatGPT model'), { target: { value: 'gpt-6.1-sol' } })
    await waitFor(() => expect(saved.at(-1)?.providers[0]?.model).toBe('gpt-6.1-sol'))
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(saved.length).toBe(savesBefore + 1)
    expect(testCalls()).toHaveLength(1)

    // Testing is an explicit choice, and tests the model now selected.
    fireEvent.click(screen.getByRole('button', { name: 'Test this model' }))
    await waitFor(() => expect(testCalls()).toHaveLength(2))
    expect(testCalls()[1]![0].provider).toMatchObject({ id: 'chatgpt', model: 'gpt-6.1-sol' })
    expect(testCalls()[1]![0].provider).not.toHaveProperty('apiKey')
    expect(await screen.findByText(/ChatGPT answered as me@example.com/)).toBeTruthy()
  })

  it('falls back to a sign-in code when the callback ports are taken, and cancels cleanly', async () => {
    const start = vi
      .fn<() => Promise<ChatGPTLoginStart>>()
      .mockResolvedValueOnce({ ok: false, code: 'port-busy', error: 'Another program is using the sign-in ports.' })
      .mockResolvedValueOnce({
        ok: true,
        mode: 'device',
        id: 'device-1',
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-EFGH',
        expiresAt: Date.now() + 900_000,
      })
    const { client } = fakeClient({
      chatgptLoginStart: start,
      chatgptLoginWait: vi.fn(() => new Promise<ChatGPTLoginOutcome>(() => {})),
    } as Partial<SketchClient>)
    render(
      <SketchClientProvider client={client}>
        <AppStateProvider initial={{ connectOpen: true, providerCatalog: CATALOG, providerSettingsPath: '/p' }}>
          <ConnectWizard />
        </AppStateProvider>
      </SketchClientProvider>,
    )

    fireEvent.click(await screen.findByText('Sign in with ChatGPT'))
    expect((await screen.findByLabelText('Sign-in code')).textContent).toBe('ABCD-EFGH')
    expect(start).toHaveBeenNthCalledWith(2, { mode: 'device' })
    expect(screen.getByRole('alert').textContent).toContain('Showing a sign-in code instead')
    expect(open).toHaveBeenCalledWith('https://auth.openai.com/codex/device', '_blank', 'noopener,noreferrer')

    fireEvent.click(screen.getByText('Cancel'))
    expect(client.chatgptLoginCancel).toHaveBeenCalledWith({ id: 'device-1' })
    expect(await screen.findByText('Sign in with ChatGPT')).toBeTruthy()
  })

  it('reports a refused sign-in in words and goes back to the choices', async () => {
    const { client } = fakeClient({
      chatgptLoginWait: vi.fn(async (): Promise<ChatGPTLoginOutcome> => ({ ok: false, code: 'denied', error: 'ChatGPT sign-in was not completed: access_denied' })),
    } as Partial<SketchClient>)
    render(
      <SketchClientProvider client={client}>
        <AppStateProvider initial={{ connectOpen: true, providerCatalog: CATALOG, providerSettingsPath: '/p' }}>
          <ConnectWizard />
        </AppStateProvider>
      </SketchClientProvider>,
    )
    fireEvent.click(await screen.findByText('Sign in with ChatGPT'))
    expect((await screen.findByRole('alert')).textContent).toContain('access_denied')
    expect(client.saveProviderSettings).not.toHaveBeenCalled()
  })

  it('skips the browser when the account is already signed in', async () => {
    const { client } = fakeClient({
      chatgptStatus: vi.fn(async () => ({ signedIn: true, needsSignIn: false, email: 'me@example.com', plan: 'pro', path: '/p' })),
    } as Partial<SketchClient>)
    render(
      <SketchClientProvider client={client}>
        <AppStateProvider initial={{ connectOpen: true, providerCatalog: CATALOG, providerSettingsPath: '/p' }}>
          <ConnectWizard />
        </AppStateProvider>
      </SketchClientProvider>,
    )
    fireEvent.click(await screen.findByText('Sign in with ChatGPT'))
    expect(await screen.findByText(/Connected to ChatGPT/)).toBeTruthy()
    expect(client.chatgptLoginStart).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })
})

describe('ChatGPT in the model picker and in Settings', () => {
  const entry: ProviderSettingsEntry = {
    id: 'chatgpt',
    kind: 'openai-compatible',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    model: 'gpt-6.1-sol',
    label: 'ChatGPT',
  }

  it('lists every model of the account and remembers the one chosen', async () => {
    const { client, saved } = fakeClient()
    render(
      <SketchClientProvider client={client}>
        <AppStateProvider
          initial={{ providerCatalog: CATALOG, providers: [entry], selectedProvider: 'chatgpt', selectedModel: 'gpt-6.1-sol', providerSettingsPath: '/p' }}
        >
          <ModelSelector />
        </AppStateProvider>
      </SketchClientProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /ChatGPT · gpt-6.1-sol/ }))
    fireEvent.click(await screen.findByText('GPT-6-Luna'))
    await waitFor(() => expect(saved[0]).toMatchObject({ selected: 'chatgpt', providers: [{ id: 'chatgpt', model: 'gpt-6-luna' }] }))
  })

  it('shows who is signed in and signs out from the ChatGPT row', async () => {
    const { client, saved } = fakeClient({
      chatgptStatus: vi.fn(async () => ({ signedIn: true, needsSignIn: false, email: 'me@example.com', plan: 'plus', path: '/p' })),
    } as Partial<SketchClient>)
    render(
      <SketchClientProvider client={client}>
        <KeyStoreProvider store={noKeys()}>
          <AppStateProvider
            initial={{ providerCatalog: CATALOG, providers: [entry], selectedProvider: 'chatgpt', providerSettingsPath: '/p' }}
          >
            <ProviderSettings />
          </AppStateProvider>
        </KeyStoreProvider>
      </SketchClientProvider>,
    )
    expect(await screen.findByText(/Signed in as me@example.com · Plus\. Renewed automatically/)).toBeTruthy()
    // No endpoint/key form for an account.
    expect(screen.queryByText('Edit', { selector: '[data-provider="chatgpt"] button' })).toBeNull()

    fireEvent.click(screen.getByText('Sign out'))
    await waitFor(() => expect(client.chatgptLogout).toHaveBeenCalled())
    await waitFor(() => expect(saved.at(-1)).toMatchObject({ providers: [], selected: null }))
  })
})

describe('plan names', () => {
  it('reads like the ChatGPT website, and never hides an unknown plan', () => {
    expect(describePlan('plus')).toBe('Plus')
    expect(describePlan('team')).toBe('Business')
    expect(describePlan('free_workspace')).toBe('Free')
    expect(describePlan('new_fancy_plan')).toBe('New Fancy Plan')
    expect(describePlan(undefined)).toBeNull()
    expect(describeAccount({ email: 'a@b.c', plan: 'pro' })).toBe('Signed in as a@b.c · Pro')
    expect(describeAccount({})).toBe('Signed in to ChatGPT')
  })
})
