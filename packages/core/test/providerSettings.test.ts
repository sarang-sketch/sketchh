// Provider settings: the key-free file, and the connection test that says WHICH
// thing is broken.
//
// Nothing here is mocked. `providers.json` is written to a real temp home and read
// back as bytes; the connection tests run against real `node:http` servers on the
// loopback interface and against a real CLOSED port, so the failure paths are the
// ones the OS produces and the suite still needs no internet and no key.
//
// Validates: Requirements 17.1, 17.2, 17.4, 17.7

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SecretInSettingsError,
  assertKeyFree,
  backupCorruptConfig,
  checkEndpoint,
  loadProviderSettings,
  providerMatrix,
  providersFilePath,
  sanitizeEntry,
  saveProviderSettings,
  serializeProviderSettings,
  testProviderConnection,
  toProviderConfig,
} from '../src/settings/index.js'
import { PROVIDER_CATALOG } from '../src/providers/registry.js'
import { SECRET_KEY_SHAPES, isSensitiveKeyName } from '../src/secrets/patterns.js'
import { METHODS } from '../src/rpc/methods.js'
import type { MethodContext } from '../src/rpc/methods.js'

// ── real temp homes ─────────────────────────────────────────────────────────

const homes: string[] = []

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sketch-providers-'))
  homes.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of homes) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A locked temp directory is not a test failure.
    }
  }
})

/** A key with a real vendor shape, so the pattern table has something to catch. */
const SECRET = 'sk-ant-api03-DEADBEEFdeadbeef0123456789abcdefghij'

// ── 1. the file holds no key ────────────────────────────────────────────────

describe('providers.json is key-free (Requirement 17.2)', () => {
  it('drops every credential-shaped field, whatever it is called', () => {
    const entry = sanitizeEntry({
      id: 'ollama',
      kind: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3',
      label: 'Ollama (local)',
      // Everything below is a credential a caller might hand over by accident.
      apiKey: SECRET,
      api_key: SECRET,
      'x-api-key': SECRET,
      token: SECRET,
      secret: SECRET,
      password: SECRET,
      headers: { Authorization: `Bearer ${SECRET}` },
    })

    expect(entry).not.toBeNull()
    expect(Object.keys(entry!).sort()).toEqual(['baseUrl', 'id', 'kind', 'label', 'model'])
    expect(JSON.stringify(entry)).not.toContain(SECRET)
  })

  it('writes a file whose BYTES match no secret pattern, and reads it back', async () => {
    const home = makeHome()
    const path = providersFilePath(home)
    expect(path).toBe(join(home, '.sketch', 'providers.json'))

    await saveProviderSettings(
      {
        version: 1,
        selected: 'ollama',
        providers: [
          {
            id: 'ollama',
            kind: 'openai-compatible',
            baseUrl: 'http://localhost:11434/v1',
            model: 'llama3',
            label: 'Ollama (local)',
            apiKey: SECRET,
            headers: { 'x-api-key': SECRET },
          },
          {
            id: 'anthropic',
            kind: 'anthropic-messages',
            baseUrl: 'https://api.anthropic.com',
            model: 'claude-3-5-sonnet-latest',
            label: 'Anthropic',
            apiKey: SECRET,
          },
        ],
      },
      path,
    )

    // THE MUTATION TARGET. Read the file the way an auditor would: as bytes.
    const bytes = readFileSync(path, 'utf8')
    expect(bytes).not.toContain(SECRET)
    for (const shape of SECRET_KEY_SHAPES) {
      shape.lastIndex = 0
      expect(shape.test(bytes), `secret shape ${String(shape)} appears in providers.json`).toBe(
        false,
      )
      shape.lastIndex = 0
    }
    for (const [, name] of bytes.matchAll(/"([^"\\]+)"\s*:/g)) {
      expect(isSensitiveKeyName(name), `credential-shaped field '${name}' in providers.json`).toBe(
        false,
      )
    }

    const loaded = await loadProviderSettings(path)
    expect(loaded.settings.providers.map((p) => p.id)).toEqual(['anthropic', 'ollama'])
    expect(loaded.settings.selected).toBe('ollama')
    expect(loaded.diagnostic).toBeUndefined()
  })

  it('refuses to write a key smuggled inside a whitelisted field', () => {
    expect(() =>
      serializeProviderSettings({
        version: 1,
        selected: 'custom',
        providers: [
          {
            id: 'custom',
            kind: 'openai-compatible',
            baseUrl: 'https://proxy.example.com/v1',
            model: 'gpt-4o',
            // A user pasting a curl line into the label.
            label: `curl -H "Authorization: Bearer ${SECRET}"`,
          },
        ],
      }),
    ).toThrow(SecretInSettingsError)
  })

  it('names the offence rather than writing it, and assertKeyFree passes clean text', () => {
    expect(() => assertKeyFree('{"apiKey":"whatever"}', 'providers.json')).toThrow(
      /credential-shaped field 'apiKey'/,
    )
    expect(() =>
      assertKeyFree('{"baseUrl":"http://localhost:11434/v1","model":"llama3"}', 'providers.json'),
    ).not.toThrow()
  })

  it('strips a key from a hand-edited file and says the file carried one', async () => {
    const home = makeHome()
    const path = providersFilePath(home)
    mkdirSync(join(home, '.sketch'), { recursive: true })
    // Exactly what "someone edited it by hand" looks like.
    writeFileSync(
      path,
      JSON.stringify(
        {
          version: 1,
          selected: 'openai',
          providers: [
            {
              id: 'openai',
              kind: 'openai-compatible',
              baseUrl: 'https://api.openai.com/v1',
              model: 'gpt-4o',
              label: 'OpenAI',
              apiKey: SECRET,
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    )

    const loaded = await loadProviderSettings(path)
    expect(loaded.diagnostic).toMatch(/contained credential-shaped content/)
    expect(JSON.stringify(loaded.settings)).not.toContain(SECRET)
    expect(loaded.settings.providers[0]).toEqual({
      id: 'openai',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      label: 'OpenAI',
    })
  })

  it('supplies the key at invocation time only', () => {
    const entry = {
      id: 'openai',
      kind: 'openai-compatible' as const,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      label: 'OpenAI',
    }
    expect(toProviderConfig(entry).apiKey).toBeUndefined()
    expect(toProviderConfig(entry, SECRET).apiKey).toBe(SECRET)
    // The entry itself is untouched, so nothing downstream can persist the key.
    expect(JSON.stringify(entry)).not.toContain(SECRET)
  })
})

// ── 1b. a corrupt providers.json never bricks the app (W10 invariant 5) ──────

describe('a corrupt providers.json is set aside, not silently kept or deleted', () => {
  it('backs up unreadable JSON, starts clean, and says where the old bytes went', async () => {
    const home = makeHome()
    const path = providersFilePath(home)
    mkdirSync(join(home, '.sketch'), { recursive: true })
    writeFileSync(path, '{ this is not valid json ]', 'utf8')

    const loaded = await loadProviderSettings(path)

    // Clean start: no provider, honest empty state — not a crash.
    expect(loaded.settings.providers).toEqual([])
    expect(loaded.settings.selected).toBeNull()
    // A plain notice that names the problem and the backup.
    expect(loaded.diagnostic).toMatch(/not valid JSON/)
    expect(loaded.diagnostic).toMatch(/moved to .*\.corrupt-/)
    // The user's bytes were preserved (never deleted): the corrupt backup exists and
    // the original path is gone.
    const siblings = readdirSync(join(home, '.sketch'))
    const backup = siblings.find((f) => f.startsWith('providers.json.corrupt-'))
    expect(backup).toBeDefined()
    expect(readFileSync(join(home, '.sketch', backup!), 'utf8')).toBe('{ this is not valid json ]')
    expect(existsSync(path)).toBe(false)
  })

  it('backupCorruptConfig preserves the file and reports a rename failure instead of throwing', async () => {
    const home = makeHome()
    const path = join(home, 'does-not-exist.json')
    // Inject a rename that fails; the helper must report, not throw.
    const result = await backupCorruptConfig(path, async () => {
      throw new Error('read-only volume')
    })
    expect(result.backedUpTo).toBeNull()
    expect('reason' in result && result.reason).toMatch(/read-only volume/)
  })

  it('leaves a merely-missing file as the honest empty state (no backup, no notice)', async () => {
    const home = makeHome()
    const path = providersFilePath(home)
    const loaded = await loadProviderSettings(path)
    expect(loaded.settings.providers).toEqual([])
    expect(loaded.diagnostic).toBeUndefined()
  })
})

// ── 2. the matrix and the custom endpoint ───────────────────────────────────

describe('the provider matrix comes from the registry (Requirement 17.1)', () => {
  it('is the registry catalog, not a copy, and flags serverless endpoints', () => {
    expect(providerMatrix()).toBe(PROVIDER_CATALOG)
    // The eight the plan names, plus the local runtimes and the custom endpoint.
    for (const id of [
      'openai',
      'anthropic',
      'gemini',
      'groq',
      'openrouter',
      'github-models',
      'azure-openai',
      'cloudflare-workers-ai',
      'ollama',
      'llamacpp',
      'custom',
    ]) {
      expect(providerMatrix().map((p) => p.id)).toContain(id)
    }
    expect(providerMatrix().filter((p) => p.serverless).map((p) => p.id)).toContain('groq')
    expect(providerMatrix().find((p) => p.id === 'ollama')?.serverless).toBe(false)
  })

  it('accepts an http endpoint, resolves it, and refuses the rest', () => {
    expect(checkEndpoint('  http://localhost:11434/v1/  ')).toEqual({
      ok: true,
      resolvedUrl: 'http://localhost:11434/v1',
    })
    expect(checkEndpoint('https://proxy.example.com/v1').ok).toBe(true)

    for (const bad of [
      'file:///etc/passwd',
      'ftp://example.com',
      'localhost:11434',
      '',
      'https://user:pw@example.com/v1',
      'https://example.com/v1?api_key=abc',
    ]) {
      const result = checkEndpoint(bad)
      expect(result.ok, `${bad} must be refused`).toBe(false)
      expect(result.reason).toBeTruthy()
    }
  })

  it('keeps a custom endpoint but drops a half-filled row', () => {
    expect(sanitizeEntry({ id: 'custom', baseUrl: 'http://127.0.0.1:8080/v1', model: 'local' }))
      .toEqual({
        id: 'custom',
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'local',
        label: 'Custom (OpenAI-compatible)',
      })
    // No model, no endpoint, no id: each one is not a provider.
    expect(sanitizeEntry({ id: 'custom', baseUrl: 'http://127.0.0.1:8080/v1' })).toBeNull()
    expect(sanitizeEntry({ id: 'custom', model: 'local' })).toBeNull()
    expect(sanitizeEntry({ baseUrl: 'http://127.0.0.1:8080/v1', model: 'local' })).toBeNull()
  })

  it('is deterministic, so an unchanged rewrite produces no diff', () => {
    const settings = {
      version: 1,
      selected: 'ollama',
      providers: [
        { id: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
        { id: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
      ],
    }
    const once = serializeProviderSettings(settings)
    const reversed = { ...settings, providers: [...settings.providers].reverse() }
    expect(serializeProviderSettings(reversed)).toBe(once)
  })

  it('treats a missing file as "nothing configured", not as an error', async () => {
    const loaded = await loadProviderSettings(providersFilePath(makeHome()))
    expect(loaded.settings).toEqual({ version: 1, providers: [], selected: null })
    expect(loaded.diagnostic).toBeUndefined()
  })
})

// ── 3. the connection test, against real servers ────────────────────────────

const servers: Server[] = []

/** A real HTTP server on 127.0.0.1. Returns its base URL. */
async function serve(handler: (url: string, headers: Record<string, unknown>) => {
  status: number
  body: string
}): Promise<string> {
  const server = createServer((req, res) => {
    const { status, body } = handler(req.url ?? '', req.headers as Record<string, unknown>)
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

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

describe('the connection test names WHICH failure it is (Requirements 17.1, 17.7)', () => {
  it('reports an unreachable host, with the host in the message', async () => {
    const port = await closedPort()
    const result = await testProviderConnection({
      id: 'ollama',
      kind: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'llama3',
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('unreachable')
    expect(result.message).toContain(`127.0.0.1:${port}`)
    expect(result.status).toBeUndefined()
  })

  it('reports a rejected key differently from a missing one', async () => {
    const baseUrl = await serve(() => ({
      status: 401,
      body: JSON.stringify({ error: { message: 'invalid api key' } }),
    }))

    const withKey = await testProviderConnection({
      id: 'openai',
      kind: 'openai-compatible',
      baseUrl,
      model: 'gpt-4o',
      apiKey: SECRET,
    })
    expect(withKey.code).toBe('unauthorized')
    expect(withKey.status).toBe(401)
    expect(withKey.message).toMatch(/rejected the supplied key/)
    // The key never rides back out in the diagnostic.
    expect(withKey.message).not.toContain(SECRET)

    const withoutKey = await testProviderConnection({
      id: 'openai',
      kind: 'openai-compatible',
      baseUrl,
      model: 'gpt-4o',
    })
    expect(withoutKey.code).toBe('unauthorized')
    expect(withoutKey.message).toMatch(/requires a key, but none was supplied/)
    expect(withoutKey.message).not.toBe(withKey.message)
  })

  it('reports a wrong model name, and lists what the endpoint does serve', async () => {
    const baseUrl = await serve(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ id: 'llama3:latest' }, { id: 'mistral' }] }),
    }))

    const wrong = await testProviderConnection({
      id: 'ollama',
      kind: 'openai-compatible',
      baseUrl,
      model: 'gpt-4o',
    })
    expect(wrong.ok).toBe(false)
    expect(wrong.code).toBe('model-not-found')
    expect(wrong.message).toContain('gpt-4o')
    expect(wrong.models).toEqual(['llama3:latest', 'mistral'])

    // Three failures, three distinct messages — the point of the requirement.
    const port = await closedPort()
    const unreachable = await testProviderConnection({
      id: 'ollama',
      kind: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'llama3',
    })
    const unauthorizedUrl = await serve(() => ({ status: 403, body: 'forbidden' }))
    const unauthorized = await testProviderConnection({
      id: 'ollama',
      kind: 'openai-compatible',
      baseUrl: unauthorizedUrl,
      model: 'llama3',
      apiKey: SECRET,
    })
    expect(new Set([wrong.code, unreachable.code, unauthorized.code]).size).toBe(3)
    expect(new Set([wrong.message, unreachable.message, unauthorized.message]).size).toBe(3)
  })

  it('succeeds against a local OpenAI-compatible endpoint with no key and no internet', async () => {
    const seen: string[] = []
    const baseUrl = await serve((url) => {
      seen.push(url)
      return { status: 200, body: JSON.stringify({ data: [{ id: 'llama3' }] }) }
    })

    const result = await testProviderConnection({
      id: 'ollama',
      kind: 'openai-compatible',
      baseUrl,
      model: 'llama3',
    })
    expect(result.ok).toBe(true)
    expect(result.code).toBe('ok')
    expect(seen).toEqual(['/v1/models'])
  })

  it('accepts an endpoint that will not list its models, and says so', async () => {
    const baseUrl = await serve(() => ({ status: 200, body: JSON.stringify({ object: 'list' }) }))
    const result = await testProviderConnection({
      id: 'azure-openai',
      kind: 'openai-compatible',
      baseUrl,
      model: 'my-deployment',
      apiKey: SECRET,
    })
    expect(result.ok).toBe(true)
    expect(result.message).toMatch(/does not list its models/)
    expect(result.message).not.toContain(SECRET)
  })

  it('refuses a bad endpoint before opening a socket', async () => {
    const result = await testProviderConnection(
      {
        id: 'custom',
        kind: 'openai-compatible',
        baseUrl: 'file:///etc/passwd',
        model: 'anything',
      },
      {
        // A fetch that would fail the test if it were ever called.
        fetchImpl: () => {
          throw new Error('the connection test opened a socket for an invalid endpoint')
        },
      },
    )
    expect(result.code).toBe('invalid-endpoint')
    expect(result.message).toMatch(/not supported/)
  })

  it('is cancellable, and a cancelled test is not a failed connection', async () => {
    // A server that never answers: the only way out is the abort.
    const server = createServer(() => {})
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')

    const controller = new AbortController()
    const pending = testProviderConnection(
      {
        id: 'ollama',
        kind: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: 'llama3',
      },
      { signal: controller.signal, timeoutMs: 10_000 },
    )
    controller.abort()

    const result = await pending
    expect(result.code).toBe('cancelled')
    expect(result.ok).toBe(false)
  })

  it('gives up on a silent server rather than hanging', async () => {
    const server = createServer(() => {})
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')

    const result = await testProviderConnection(
      {
        id: 'ollama',
        kind: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: 'llama3',
      },
      { timeoutMs: 150 },
    )
    expect(result.code).toBe('timeout')
    expect(result.message).toContain('150 ms')
  })

  it('reports a 403 as forbidden — a key accepted but not permitted, distinct from 401', async () => {
    const baseUrl = await serve(() => ({ status: 403, body: JSON.stringify({ error: { message: 'no access to this model' } }) }))
    const result = await testProviderConnection({ id: 'openai', kind: 'openai-compatible', baseUrl, model: 'gpt-4o', apiKey: SECRET })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('forbidden')
    expect(result.status).toBe(403)
    expect(result.message).toMatch(/not permitted|permission|plan|organisation/i)
    expect(result.message).not.toContain(SECRET)
  })

  it('reports a 429 as rate-limited and parses Retry-After seconds', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '42' })
      res.end(JSON.stringify({ error: { message: 'slow down' } }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')

    const result = await testProviderConnection({
      id: 'groq',
      kind: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: 'llama-3.3-70b',
      apiKey: SECRET,
    })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('rate-limited')
    expect(result.status).toBe(429)
    expect(result.retryAfterSeconds).toBe(42)
    expect(result.message).toMatch(/42 seconds/)
    expect(result.message).not.toContain(SECRET)
  })

  it('reports a 429 without Retry-After and leaves the seconds unset', async () => {
    const baseUrl = await serve(() => ({ status: 429, body: JSON.stringify({ error: { message: 'slow down' } }) }))
    const result = await testProviderConnection({ id: 'groq', kind: 'openai-compatible', baseUrl, model: 'x', apiKey: SECRET })
    expect(result.code).toBe('rate-limited')
    expect(result.retryAfterSeconds).toBeUndefined()
    expect(result.message).toMatch(/rate-limiting/i)
  })
})

// ── 4. the same three things over the protocol the panel uses ───────────────

function testCtx(): { ctx: MethodContext; remembered: string[] } {
  const remembered: string[] = []
  const ctx: MethodContext = {
    emitEvent: () => {},
    log: () => {},
    rememberSecret: (value) => remembered.push(value),
    secrets: () => remembered,
    env: {},
    cwd: () => process.cwd(),
  }
  return { ctx, remembered }
}

describe('the provider-* RPC methods', () => {
  let home: string
  beforeEach(() => {
    home = makeHome()
  })

  it('answers provider-catalog with the registry matrix and an empty config', async () => {
    const { ctx } = testCtx()
    const result = (await METHODS['provider-catalog']!({ home }, ctx)) as {
      catalog: Array<{ id: string; serverless: boolean }>
      settings: { providers: unknown[]; selected: string | null }
      path: string
    }
    expect(result.catalog.length).toBe(PROVIDER_CATALOG.length)
    expect(result.settings).toEqual({ version: 1, providers: [], selected: null })
    expect(result.path).toBe(providersFilePath(home))
  })

  it('saves key-free configuration through the wire and reads it back', async () => {
    const { ctx } = testCtx()
    await METHODS['provider-config-save']!(
      {
        home,
        settings: {
          version: 1,
          selected: 'ollama',
          providers: [
            {
              id: 'ollama',
              kind: 'openai-compatible',
              baseUrl: 'http://localhost:11434/v1',
              model: 'llama3',
              label: 'Ollama (local)',
              apiKey: SECRET,
            },
          ],
        },
      },
      ctx,
    )

    const bytes = readFileSync(providersFilePath(home), 'utf8')
    expect(bytes).not.toContain(SECRET)
    expect(bytes).toContain('http://localhost:11434/v1')

    const reloaded = (await METHODS['provider-catalog']!({ home }, ctx)) as {
      settings: { providers: Array<Record<string, unknown>> }
    }
    expect(reloaded.settings.providers).toHaveLength(1)
    expect(reloaded.settings.providers[0]).not.toHaveProperty('apiKey')
  })

  it('registers the tested key as a secret so it cannot ride an outgoing frame', async () => {
    const { ctx, remembered } = testCtx()
    const port = await closedPort()
    const result = (await METHODS['provider-test']!(
      {
        provider: {
          id: 'ollama',
          kind: 'openai-compatible',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: 'llama3',
          apiKey: SECRET,
        },
        timeoutMs: 2_000,
      },
      ctx,
    )) as { ok: boolean; code: string; message: string }

    expect(remembered).toContain(SECRET)
    expect(result.code).toBe('unreachable')
    expect(result.message).not.toContain(SECRET)
  })
})
