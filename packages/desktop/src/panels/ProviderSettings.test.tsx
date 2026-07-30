// Provider Settings, driven against the REAL engine and a REAL file on disk.
//
// The client below is not a stand-in for the engine: it dispatches the same
// `METHODS` table the sidecar and the dev bridge dispatch, in process instead of over
// a pipe, pointed at a temp home. So the provider matrix on screen is
// `PROVIDER_CATALOG` from packages/core/src/providers/registry.ts, a save writes
// `<temp>/.sketch/providers.json` for real, and the connection tests talk to real
// `node:http` servers on the loopback interface and to a real CLOSED port. No
// internet, no key, no fixture.
//
// THE ASSERTION THAT MATTERS MOST is in section 4: a key is typed into the form, a
// save is performed, and the file's BYTES are then checked against the shared secret
// pattern table (packages/core/src/secrets/patterns.ts). That is the guard on
// Requirement 17.2, and it is mutation-verifiable — put the key into the payload the
// engine writes and this test fails.
//
// Validates: Requirements 17.1, 17.2, 27.1, 27.3, 27.4, 14.6

import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { METHODS, providers, secrets, type MethodContext } from '@sketch/core'

import { ProviderSettings } from './ProviderSettings'
import ActivityBar from '../components/ide/ActivityBar'
import SidePanel from '../components/ide/SidePanel'
import { SketchClientProvider } from '../lib/ClientProvider'
import {
  createEventBus,
  type EventHandler,
  type PingResult,
  type ProviderCatalogResult,
  type ProviderTestRequest,
  type SketchClient,
} from '../lib/client'
import type { ProviderSettingsFile, ProviderTestResult } from '../lib/contracts'
import { AppStateProvider } from '../state/AppState'

// ── a real home directory, and real servers ─────────────────────────────────

const tmpDirs: string[] = []

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sketch-providers-ui-'))
  tmpDirs.push(dir)
  return dir
}

function settingsPath(home: string): string {
  return join(home, '.sketch', 'providers.json')
}

const servers: Server[] = []

/** A real HTTP server on 127.0.0.1. Returns its base URL. */
async function serve(reply: () => { status: number; body: string }): Promise<string> {
  const server = createServer((_req, res) => {
    const { status, body } = reply()
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(body)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}/v1`
}

/** A port with nothing behind it: listen, note the port, close it again. */
async function closedPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  const port = address.port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

// ── the client: the real engine, in process ─────────────────────────────────

function methodContext(): MethodContext {
  return {
    emitEvent: () => {},
    log: () => {},
    rememberSecret: () => {},
    secrets: () => [],
    env: {},
    cwd: () => process.cwd(),
  }
}

/**
 * `transport` says 'stdio' because that is what this stands in for: the sidecar
 * dispatching `METHODS`. Nothing in the panel branches on it.
 */
class EngineClient implements SketchClient {
  readonly transport = 'stdio' as const
  private readonly bus = createEventBus()
  private readonly ctx = methodContext()

  constructor(private readonly home: string) {}

  ping(): Promise<PingResult> {
    return Promise.resolve({ ok: true, version: 'test', transport: 'stdio' })
  }

  run(): Promise<never> {
    return Promise.reject(new Error('the settings panel never starts a run'))
  }

  eval(): Promise<never[]> {
    return Promise.resolve([])
  }

  subscribe(handler: EventHandler) {
    return this.bus.subscribe(handler)
  }

  private call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return METHODS[method]!({ home: this.home, ...params }, this.ctx) as Promise<T>
  }

  gitStatus(): Promise<never> {
    return Promise.reject(new Error('no repository in this test'))
  }
  gitDiff(): Promise<never> {
    return Promise.reject(new Error('no repository in this test'))
  }
  gitStage(): Promise<never> {
    return Promise.reject(new Error('no repository in this test'))
  }
  gitUnstage(): Promise<never> {
    return Promise.reject(new Error('no repository in this test'))
  }
  gitCommit(): Promise<never> {
    return Promise.reject(new Error('no repository in this test'))
  }

  providerCatalog(): Promise<ProviderCatalogResult> {
    return this.call<ProviderCatalogResult>('provider-catalog', {})
  }

  /**
   * Every save payload the panel produced, as sent. Kept so a test can audit what
   * LEFT THE WINDOW, not only what the engine chose to write — the engine's
   * whitelist would silently absorb a key the panel should never have sent, and
   * then the file on disk would prove nothing about the panel.
   */
  readonly sent: string[] = []

  saveProviderSettings(params: {
    settings: ProviderSettingsFile
  }): Promise<{ settings: ProviderSettingsFile; path: string }> {
    this.sent.push(JSON.stringify(params.settings))
    return this.call<{ settings: ProviderSettingsFile; path: string }>('provider-config-save', {
      settings: params.settings,
    })
  }

  testProvider(params: ProviderTestRequest): Promise<ProviderTestResult> {
    return this.call<ProviderTestResult>('provider-test', {
      provider: params.provider,
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    })
  }
}

/** A client whose engine is unreachable, for the "name the reason" case. */
class DeadEngineClient extends EngineClient {
  override providerCatalog(): Promise<never> {
    return Promise.reject(new Error('the sidecar is not running: ENOENT'))
  }
}

function mount(client: SketchClient) {
  return render(
    <SketchClientProvider client={client}>
      <AppStateProvider>
        <ProviderSettings />
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

/** Fill in the add/edit form for one provider row. */
function fillForm(id: string, values: { baseUrl?: string; model?: string; apiKey?: string }) {
  if (values.baseUrl !== undefined) {
    fireEvent.change(screen.getByLabelText(`Endpoint for ${id}`), {
      target: { value: values.baseUrl },
    })
  }
  if (values.model !== undefined) {
    fireEvent.change(screen.getByLabelText(`Model for ${id}`), {
      target: { value: values.model },
    })
  }
  if (values.apiKey !== undefined) {
    fireEvent.change(
      screen.getByLabelText(`API key for ${id}, used for this connection test only`),
      { target: { value: values.apiKey } },
    )
  }
}

/** A key with a real vendor shape, so the pattern table has something to catch. */
const SECRET = 'sk-ant-api03-DEADBEEFdeadbeef0123456789abcdefghij'

afterEach(async () => {
  cleanup()
  while (servers.length > 0) {
    const server = servers.pop()!
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

// ── 1. the fixtures are gone ────────────────────────────────────────────────

describe('the provider fixtures are gone (Requirement 14.6)', () => {
  /**
   * Source with comments removed. Both files document what they replaced, and a
   * raw-text check cannot tell an explanation of a removal from the removal itself.
   */
  function code(relative: string): string {
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), relative), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
  }

  const panel = code('ProviderSettings.tsx')
  const picker = code('../components/ModelSelector.tsx')

  it('declares no provider list of its own — the matrix comes from the registry', () => {
    for (const source of [panel, picker]) {
      expect(source).not.toMatch(/const MOCK_/)
      expect(source).not.toMatch(/const PROVIDERS\s*=/)
      // No provider or model NAME is written in either file.
      expect(source).not.toMatch(/claude-3|gpt-4|claude-opus|Claude 3|GPT-4/)
    }
    // The picker reads the two real arrays instead.
    expect(picker).toContain('state.providerCatalog')
    expect(picker).toContain('state.providers')
  })

  it('claims no connection that was not tested', () => {
    // The dot is `describeTest`'s tone, and untested is its own state.
    expect(picker).toContain('describeTest')
    expect(picker).not.toMatch(/connected:\s*true/)
    expect(picker).not.toMatch(/providerConnected/)
    // Invented prices are gone with the fixture; cost is task 8.4.
    expect(picker).not.toMatch(/'\$+'/)
  })

  it('never sets HTML directly, in either file', () => {
    // Endpoint URLs, model names and provider error text are all attacker-influenced.
    expect(panel).not.toContain('dangerouslySetInnerHTML')
    expect(picker).not.toContain('dangerouslySetInnerHTML')
  })
})

// ── 2. the full matrix, from the registry ───────────────────────────────────

describe('the matrix on screen is the engine registry (Requirement 17.1)', () => {
  it('lists every provider the registry knows, with the serverless flag', async () => {
    mount(new EngineClient(makeHome()))

    await waitFor(() => expect(screen.getByText('No provider configured')).toBeDefined())

    for (const descriptor of providers.PROVIDER_CATALOG) {
      expect(screen.getByText(descriptor.name), `${descriptor.id} is missing`).toBeDefined()
    }
    // Rows carry the id, so a registry addition needs no change here.
    const rendered = Array.from(document.querySelectorAll('[data-provider]')).map((el) =>
      el.getAttribute('data-provider'),
    )
    expect(rendered.sort()).toEqual(providers.PROVIDER_CATALOG.map((p) => p.id).sort())
    expect(screen.getAllByText(/serverless/).length).toBe(
      providers.PROVIDER_CATALOG.filter((p) => p.serverless).length,
    )
  })

  it('names a dead engine instead of showing an empty provider list', async () => {
    mount(new DeadEngineClient(makeHome()))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('the sidecar is not running')
    expect(document.querySelectorAll('[data-provider]').length).toBe(0)
  })
})

// ── 2b. the surface is reachable ────────────────────────────────────────────

describe('the settings entry point (Requirements 27.1, 27.4)', () => {
  it('opens from the ActivityBar, where the button used to do nothing', async () => {
    render(
      <SketchClientProvider client={new EngineClient(makeHome())}>
        <AppStateProvider initial={{ mode: 'ide', ideActivePanel: null }}>
          <ActivityBar />
          <SidePanel />
        </AppStateProvider>
      </SketchClientProvider>,
    )

    fireEvent.click(screen.getByTitle('Provider Settings'))

    // The real panel, not a placeholder: the matrix loaded from the engine.
    expect(await screen.findByText('No provider configured')).toBeDefined()
    expect(document.querySelectorAll('[data-provider]').length).toBe(
      providers.PROVIDER_CATALOG.length,
    )
  })
})

// ── 3. the custom endpoint ──────────────────────────────────────────────────

describe('a custom endpoint (Requirement 17.1)', () => {
  it('shows the URL that will be called and refuses a scheme that cannot be', async () => {
    mount(new EngineClient(makeHome()))
    fireEvent.click(await screen.findByLabelText('Add Ollama (local)'))

    fillForm('ollama', { baseUrl: 'http://localhost:11434/v1/', model: 'llama3' })
    expect(screen.getByText('Will call http://localhost:11434/v1')).toBeDefined()

    fillForm('ollama', { baseUrl: 'file:///etc/passwd' })
    expect(screen.getByText(/scheme file is not supported/)).toBeDefined()
    expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(true)
  })

  it('persists to providers.json and reads it back from disk', async () => {
    const home = makeHome()
    mount(new EngineClient(home))
    fireEvent.click(await screen.findByLabelText('Add Ollama (local)'))

    fillForm('ollama', { baseUrl: 'http://localhost:11434/v1', model: 'llama3' })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(existsSync(settingsPath(home))).toBe(true))
    const written = JSON.parse(readFileSync(settingsPath(home), 'utf8')) as ProviderSettingsFile
    expect(written.providers).toEqual([
      {
        id: 'ollama',
        kind: 'openai-compatible',
        baseUrl: 'http://localhost:11434/v1',
        model: 'llama3',
        label: 'Ollama (local)',
      },
    ])
    expect(written.selected).toBe('ollama')

    // And the panel now renders what the engine wrote, not what was typed.
    await waitFor(() => expect(screen.getByText('http://localhost:11434/v1')).toBeDefined())
    expect(screen.getByText(`Configuration: ${settingsPath(home)}`)).toBeDefined()
  })
})

// ── 4. the key never reaches the file ───────────────────────────────────────

describe('providers.json is key-free (Requirement 17.2)', () => {
  it('keeps a key typed into the form out of the file bytes', async () => {
    const home = makeHome()
    const client = new EngineClient(home)
    mount(client)

    fireEvent.click(await screen.findByLabelText('Add OpenAI'))
    fillForm('openai', {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      apiKey: SECRET,
    })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(existsSync(settingsPath(home))).toBe(true))

    // THE PANEL'S OWN MUTATION TARGET. The engine's whitelist would absorb a key
    // the panel sent, so the file alone cannot prove the panel did not send one.
    // This asserts the payload that crossed the seam was already key-free: put the
    // key into what the panel saves and this fails, with the engine untouched.
    expect(client.sent.length).toBeGreaterThan(0)
    for (const payload of client.sent) {
      expect(payload).not.toContain(SECRET)
      for (const shape of secrets.SECRET_KEY_SHAPES) {
        shape.lastIndex = 0
        expect(shape.test(payload), `secret shape ${String(shape)} left the window`).toBe(false)
        shape.lastIndex = 0
      }
      for (const [, name] of payload.matchAll(/"([^"\\]+)"\s*:/g)) {
        expect(
          secrets.isSensitiveKeyName(name),
          `credential-shaped field '${name}' left the window`,
        ).toBe(false)
      }
    }

    // THE ENGINE'S. Read the file the way an auditor would: as bytes.
    const bytes = readFileSync(settingsPath(home), 'utf8')
    expect(bytes).not.toContain(SECRET)
    for (const shape of secrets.SECRET_KEY_SHAPES) {
      shape.lastIndex = 0
      expect(shape.test(bytes), `secret shape ${String(shape)} reached providers.json`).toBe(false)
      shape.lastIndex = 0
    }
    for (const [, name] of bytes.matchAll(/"([^"\\]+)"\s*:/g)) {
      expect(
        secrets.isSensitiveKeyName(name),
        `credential-shaped field '${name}' reached providers.json`,
      ).toBe(false)
    }
    // Five fields, and none of them is a place to put one.
    const written = JSON.parse(bytes) as ProviderSettingsFile
    expect(Object.keys(written.providers[0]!).sort()).toEqual([
      'baseUrl',
      'id',
      'kind',
      'label',
      'model',
    ])
  })
})

// ── 5. the connection test says WHICH failure it is ─────────────────────────

describe('the connection test (Requirements 17.1, 17.7, 27.5)', () => {
  async function configured(
    home: string,
    values: { id: string; label: string; baseUrl: string; model: string; apiKey?: string },
  ) {
    mount(new EngineClient(home))
    fireEvent.click(await screen.findByLabelText(`Add ${values.label}`))
    fillForm(values.id, {
      baseUrl: values.baseUrl,
      model: values.model,
      ...(values.apiKey !== undefined ? { apiKey: values.apiKey } : {}),
    })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(existsSync(settingsPath(home))).toBe(true))
  }

  it('succeeds against a local endpoint with no key and no internet', async () => {
    const baseUrl = await serve(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ id: 'llama3' }] }),
    }))
    await configured(makeHome(), {
      id: 'ollama',
      label: 'Ollama (local)',
      baseUrl,
      model: 'llama3',
    })

    // Nothing was tested until this click. That is the whole point.
    expect(screen.getByText('Not tested')).toBeDefined()
    fireEvent.click(await screen.findByText('Test connection'))

    expect(await screen.findByText('Reachable')).toBeDefined()
    expect(screen.getByText(/serves 'llama3'/)).toBeDefined()
  })

  it('reports an unreachable host, naming the host', async () => {
    const port = await closedPort()
    await configured(makeHome(), {
      id: 'ollama',
      label: 'Ollama (local)',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'llama3',
    })

    fireEvent.click(await screen.findByText('Test connection'))

    const status = await screen.findByText('Unreachable')
    // Scoped to the row that failed, because the host appears twice on screen by
    // design: once as the configured endpoint, once inside the failure sentence.
    // The assertion is that the FAILING row names it, not that it is unique.
    const row = status.closest('[data-provider]')
    expect(row?.getAttribute('data-provider')).toBe('ollama')
    expect(row?.textContent ?? '').toMatch(new RegExp(`nothing answered at 127\\.0\\.0\\.1:${port}`))
  })

  it('reports a rejected key without echoing it', async () => {
    const baseUrl = await serve(() => ({ status: 401, body: '{"error":"invalid api key"}' }))
    await configured(makeHome(), {
      id: 'openai',
      label: 'OpenAI',
      baseUrl,
      model: 'gpt-4o',
      apiKey: SECRET,
    })

    fireEvent.click(await screen.findByText('Test connection'))

    expect(await screen.findByText('Key rejected')).toBeDefined()
    expect(document.body.textContent ?? '').not.toContain(SECRET)
  })

  it('reports a wrong model name as its own problem, listing what is served', async () => {
    const baseUrl = await serve(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ id: 'llama3' }, { id: 'mistral' }] }),
    }))
    await configured(makeHome(), {
      id: 'ollama',
      label: 'Ollama (local)',
      baseUrl,
      model: 'gpt-4o',
    })

    fireEvent.click(await screen.findByText('Test connection'))

    expect(await screen.findByText('Model not found')).toBeDefined()
    expect(screen.getByText(/It offers: llama3, mistral/)).toBeDefined()
    // Three failures, three labels — never one generic "failed".
    expect(screen.queryByText('Failed')).toBeNull()
  })
})

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A locked temp directory is not a test failure.
    }
  }
})
