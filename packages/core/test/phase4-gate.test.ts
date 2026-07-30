// Phase 4 gate — the four claims, proved as one chain, offline, with no key.
//
// Requirement 17.7 names a specific endpoint: `http://localhost:11434/v1`. Every
// other connection test in this suite uses an ephemeral port, which proves the code
// path but not the claim in the requirement, so this file targets that literal URL.
//
// HOW THE ENDPOINT IS PROVIDED
// If something is already listening on 11434 — a real Ollama — the test uses it and
// asks it which models it serves. If nothing is listening, the test STANDS UP A STUB
// on that port that answers `GET /v1/models` the way Ollama's OpenAI-compatible
// surface does. Which one ran is printed, because "it passed against the real thing"
// and "it passed against our own stub" are different sentences and only one of them
// is true on any given machine.
//
// Either way the only host contacted is loopback, which is the point: this passes
// with the network cable out.
//
// THE CHAIN
//   configure a local provider → save it → the BYTES on disk carry no key →
//   load it back → resolve the key from an injected store AT CALL TIME →
//   connection test against http://localhost:11434/v1 succeeds
//
// and then the same endpoint with nothing listening, which must fail with a
// diagnostic that names the host rather than a generic "connection failed".
//
// WHAT THIS FILE DOES NOT CLAIM
// That a stored key can reach a model call in the shipped app. It cannot: the Rust
// side deliberately exposes no command that reads a key back into the window (task
// 4.2), so today the only key that reaches a run is one the user just typed. The
// store→run path is proved here at the ENGINE level, with an injected store, which
// is exactly as far as it is wired.
//
// Validates: Requirements 17.2, 17.4, 17.7, 1.6

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertKeyFree,
  loadProviderSettings,
  providersFilePath,
  resolveProviderConfig,
  saveProviderSettings,
  testProviderConnection,
} from '../src/settings/index.js'
import { MemorySecretStore } from '../src/secrets/store.js'
import { SECRET_KEY_SHAPES } from '../src/secrets/patterns.js'

/** The endpoint Requirement 17.7 names, verbatim. */
const OLLAMA_URL = 'http://localhost:11434/v1'
const OLLAMA_PORT = 11434
const STUB_MODEL = 'llama3.2'

/** A vendor-shaped key, so the pattern table has something real to catch. */
const SECRET = 'sk-ant-api03-DEADBEEFdeadbeef0123456789abcdefghij'

const cleanup: Array<() => void> = []
afterAll(() => {
  for (const undo of cleanup) {
    try {
      undo()
    } catch {
      // A locked temp directory or an already-closed socket is not a failure.
    }
  }
})

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sketch-phase4-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ── the local endpoint ──────────────────────────────────────────────────────

/** Ollama's OpenAI-compatible model list, which is what `GET /v1/models` returns. */
function ollamaShapedModels(models: string[]): string {
  return JSON.stringify({
    object: 'list',
    data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'library' })),
  })
}

interface LocalEndpoint {
  /** 'real' when something was already listening on 11434, 'stub' when we started one. */
  source: 'real' | 'stub'
  /** A model the endpoint actually serves. */
  model: string
}

/**
 * Try to own port 11434. `EADDRINUSE` means a real Ollama (or something wearing its
 * port) is already there, and the test defers to it rather than fighting it.
 */
async function listenOn11434(): Promise<Server | null> {
  const server = createServer((req, res) => {
    // Only the model list is needed, and it is answered on both the bare and the
    // `/v1` path so a stray trailing segment does not read as a 404.
    if ((req.url ?? '').endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(ollamaShapedModels([`${STUB_MODEL}:latest`, 'nomic-embed-text:latest']))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  return await new Promise<Server | null>((resolve) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      resolve(err.code === 'EADDRINUSE' ? null : null)
    })
    // 127.0.0.1, not 0.0.0.0: a test server must not be reachable from the network.
    server.listen(OLLAMA_PORT, '127.0.0.1', () => resolve(server))
  })
}

/** Ask whatever is on 11434 which models it serves. Used only for the 'real' case. */
async function firstModelOf(url: string): Promise<string | null> {
  const res = await fetch(`${url}/models`).catch(() => null)
  if (res === null || !res.ok) return null
  const body = (await res.json().catch(() => null)) as { data?: Array<{ id?: string }> } | null
  const id = body?.data?.[0]?.id
  return typeof id === 'string' ? id : null
}

async function localEndpoint(): Promise<LocalEndpoint> {
  const server = await listenOn11434()
  if (server !== null) {
    cleanup.push(() => server.close())
    return { source: 'stub', model: STUB_MODEL }
  }
  const model = await firstModelOf(OLLAMA_URL)
  return { source: 'real', model: model ?? STUB_MODEL }
}

const endpoint = await localEndpoint()

// This line is the honesty requirement, and it runs on every gate.
// eslint-disable-next-line no-console
console.log(
  endpoint.source === 'real'
    ? `[phase 4 gate] port ${OLLAMA_PORT} was already serving; testing against the REAL local endpoint, model '${endpoint.model}'`
    : `[phase 4 gate] no local model server found; testing against a STUB on 127.0.0.1:${OLLAMA_PORT} answering like Ollama, model '${endpoint.model}'`,
)

// ── the chain ───────────────────────────────────────────────────────────────

describe('Requirements 17.2, 17.4, 17.7 — configure, persist key-free, resolve, connect', () => {
  it('writes bytes that carry no key, then reaches localhost:11434 with no internet', async () => {
    const home = makeHome()
    const path = providersFilePath(home)

    // 1. Configure the local provider FROM AN OBJECT THAT CARRIES A KEY. This is the
    //    realistic mistake — handing the settings layer a live ProviderConfig — and
    //    the whitelist is what makes it harmless.
    const saved = await saveProviderSettings(
      {
        version: 1,
        selected: 'ollama',
        providers: [
          {
            id: 'ollama',
            kind: 'openai-compatible',
            baseUrl: OLLAMA_URL,
            model: endpoint.model,
            label: 'Ollama (local)',
            apiKey: SECRET,
            headers: { authorization: `Bearer ${SECRET}` },
          },
        ],
      },
      path,
    )
    expect(saved.settings.providers).toHaveLength(1)

    // 2. The BYTES on disk. Not the object — the file.
    const bytes = readFileSync(path, 'utf8')
    expect(bytes).not.toContain(SECRET)
    expect(bytes).not.toContain('apiKey')
    expect(bytes).not.toContain('authorization')
    for (const shape of SECRET_KEY_SHAPES) {
      shape.lastIndex = 0
      expect(shape.test(bytes), `${shape} matched providers.json`).toBe(false)
      shape.lastIndex = 0
    }
    expect(() => assertKeyFree(bytes, path)).not.toThrow()

    // 3. Load it back. A key-free file loads clean, with no diagnostic.
    const loaded = await loadProviderSettings(path)
    expect(loaded.diagnostic).toBeUndefined()
    const entry = loaded.settings.providers[0]!
    expect(entry.baseUrl).toBe(OLLAMA_URL)

    // 4. The key comes from the store AT THE MOMENT OF THE CALL, and only then.
    //    A local endpoint needs none, so this proves the plumbing, not a dependency:
    //    the store holds a key, the config gets it, and the FILE still does not.
    const store = new MemorySecretStore()
    await store.set('ollama', SECRET)
    const config = await resolveProviderConfig(entry, store)
    expect(config.apiKey).toBe(SECRET)
    expect(readFileSync(path, 'utf8')).not.toContain(SECRET)

    // 5. The connection test itself, against the URL the requirement names.
    const result = await testProviderConnection(
      { id: 'ollama', kind: 'openai-compatible', baseUrl: OLLAMA_URL, model: endpoint.model },
      { timeoutMs: 4_000 },
    )
    expect(result.code, result.message).toBe('ok')
    expect(result.ok).toBe(true)
    expect(result.url).toBe(`${OLLAMA_URL}/models`)
    // Loopback, therefore no internet was involved. Asserted rather than asserted-in-prose.
    expect(new URL(result.url).hostname).toBe('localhost')
    expect(result.message).toContain(`localhost:${OLLAMA_PORT}`)
  })

  it('does not leak the key into the verdict, even on the happy path', async () => {
    const result = await testProviderConnection(
      {
        id: 'ollama',
        kind: 'openai-compatible',
        baseUrl: OLLAMA_URL,
        model: endpoint.model,
        apiKey: SECRET,
      },
      { timeoutMs: 4_000 },
    )
    expect(result.ok, result.message).toBe(true)
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it('fails with a diagnostic that names the host when nothing is listening', async () => {
    // Requirement 17.7's second half. A closed port on the same interface: the OS
    // produces the real refusal, so this is not a simulated failure.
    const closed = await new Promise<number>((resolve) => {
      const probe = createServer()
      probe.listen(0, '127.0.0.1', () => {
        const port = (probe.address() as { port: number }).port
        probe.close(() => resolve(port))
      })
    })

    const result = await testProviderConnection(
      {
        id: 'ollama',
        kind: 'openai-compatible',
        baseUrl: `http://localhost:${closed}/v1`,
        model: endpoint.model,
      },
      { timeoutMs: 4_000 },
    )
    expect(result.ok).toBe(false)
    expect(result.code).toBe('unreachable')
    expect(result.message).toContain(`localhost:${closed}`)
    // Actionable, not just negative.
    expect(result.message).toMatch(/running|host|port/i)
  })
})
