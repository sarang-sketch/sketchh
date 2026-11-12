// The sidecar transport, driven through an injected process instead of a webview.
//
// Two things are under test and they are equally important: the framing (a byte
// stream reassembled into frames, correlated by id, events routed to the bus) and
// the HONESTY of the failure path (no sidecar → nothing succeeds, nothing is
// invented). The last test is a regression guard: this file used to answer
// `ok: true` with a fabricated RunResult and no process at all.
//
// Validates: Requirements 13.2, 13.4, 13.6, 13.7, 12.1, 12.6

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  StdioSketchClient,
  type SidecarHandlers,
  type SidecarProcess,
  type SidecarSpawner,
} from './stdioClient'
import type { SketchEvent } from './contracts'

/** A fake process: records what was written, lets a test push stdout chunks. */
class FakeSidecar {
  readonly written: string[] = []
  handlers!: SidecarHandlers
  killed = false

  readonly spawn: SidecarSpawner = async (handlers) => {
    this.handlers = handlers
    const process: SidecarProcess = {
      write: async (data) => {
        this.written.push(data)
      },
      kill: async () => {
        this.killed = true
      },
    }
    return process
  }

  /** The frames written so far, decoded. */
  requests(): Array<{ id: string; method: string; params: Record<string, unknown> }> {
    return this.written
      .join('')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line))
  }

  stdout(chunk: string) {
    this.handlers.stdout(chunk)
  }
}

/** Wait for the client to have written its request before answering it. */
async function nextRequest(fake: FakeSidecar) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const requests = fake.requests()
    if (requests.length > 0) return requests[requests.length - 1]!
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('the client never wrote a request frame')
}

function makeEvent(runId: string, id: string): SketchEvent {
  return { id, ts: 1_735_689_600_000, runId, kind: 'run_started', payload: {} }
}

describe('StdioSketchClient — framing', () => {
  it('writes one newline-delimited request frame per call and correlates the response by id', async () => {
    const fake = new FakeSidecar()
    const client = new StdioSketchClient({ spawn: fake.spawn, onDiagnostic: () => {} })

    const pending = client.ping()
    const request = await nextRequest(fake)

    expect(request.method).toBe('ping')
    expect(fake.written[0]!.endsWith('\n')).toBe(true)

    fake.stdout(`${JSON.stringify({ id: request.id, ok: true, result: { version: '9.9.9' } })}\n`)

    await expect(pending).resolves.toEqual({ ok: true, version: '9.9.9', transport: 'stdio' })
  })

  it('reassembles a response split across chunks that do not align to lines', async () => {
    const fake = new FakeSidecar()
    const client = new StdioSketchClient({ spawn: fake.spawn, onDiagnostic: () => {} })

    const pending = client.ping()
    const request = await nextRequest(fake)

    const line = `${JSON.stringify({ id: request.id, ok: true, result: { version: '0.1.0' } })}\n`
    for (const piece of [line.slice(0, 5), line.slice(5, 12), line.slice(12)]) {
      fake.stdout(piece)
    }

    await expect(pending).resolves.toMatchObject({ ok: true, version: '0.1.0' })
  })

  it('carries a large run response, chunked, without truncating it', async () => {
    const fake = new FakeSidecar()
    const client = new StdioSketchClient({ spawn: fake.spawn, onDiagnostic: () => {} })

    const pending = client.run({ id: 't1', prompt: 'do the thing', verify: [] })
    const request = await nextRequest(fake)
    expect(request.method).toBe('run')
    expect(request.params).toMatchObject({ task: { id: 't1' } })

    const events = Array.from({ length: 400 }, (_, index) => makeEvent('run-1', `ev-${index}`))
    const result = {
      runId: 'run-1',
      ok: false,
      finalText: 'x'.repeat(40_000),
      iterations: 3,
      verify: [],
      events,
    }
    const line = `${JSON.stringify({ id: request.id, ok: true, result })}\n`
    expect(line.length).toBeGreaterThan(60_000)

    for (let at = 0; at < line.length; at += 8_192) {
      fake.stdout(line.slice(at, at + 8_192))
    }

    const received = await pending
    expect(received.finalText).toHaveLength(40_000)
    expect(received.events).toHaveLength(400)
    expect(received.ok).toBe(false)
  })

  it('forwards the exact key-free provider entry in a run frame', async () => {
    const fake = new FakeSidecar()
    const client = new StdioSketchClient({ spawn: fake.spawn, onDiagnostic: () => {} })
    const provider = {
      id: 'local-ollama',
      kind: 'openai-compatible' as const,
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5-coder:7b',
      label: 'Local Ollama',
    }

    const pending = client.run(
      { id: 'provider-run', prompt: 'edit locally', verify: [] },
      { provider },
    )
    const request = await nextRequest(fake)

    expect(request.method).toBe('run')
    expect(request.params.provider).toEqual(provider)
    expect(JSON.stringify(request.params.provider)).not.toContain('apiKey')

    fake.stdout(`${JSON.stringify({
      id: request.id,
      ok: true,
      result: { runId: 'r-provider', ok: true, finalText: 'done', iterations: 1, verify: [], events: [] },
    })}\n`)
    await expect(pending).resolves.toMatchObject({ runId: 'r-provider' })
  })

  it('merges the invocation-time key onto the wire provider and leaves the entry key-free', async () => {
    const fake = new FakeSidecar()
    const client = new StdioSketchClient({ spawn: fake.spawn, onDiagnostic: () => {} })
    const provider = {
      id: 'anthropic',
      kind: 'anthropic-messages' as const,
      baseUrl: '',
      model: 'claude-sonnet-4',
      label: 'Anthropic',
    }

    client.run({ id: 'keyed', prompt: 'authenticate', verify: [] }, {
      provider,
      apiKey: 'sk-ant-test-0123456789',
    })
    const request = await nextRequest(fake)

    // Requirement 17.4: the key is on the request, which is the one place the engine
    // scrubs it from everything downstream.
    expect(request.params.provider).toEqual({ ...provider, apiKey: 'sk-ant-test-0123456789' })
    // And the caller's persisted entry was not mutated into carrying a secret.
    expect(Object.keys(provider)).not.toContain('apiKey')
  })

  it('sends no apiKey property when no key was resolved', async () => {
    const fake = new FakeSidecar()
    const client = new StdioSketchClient({ spawn: fake.spawn, onDiagnostic: () => {} })
    const provider = {
      id: 'local-ollama',
      kind: 'openai-compatible' as const,
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5-coder:7b',
      label: 'Local Ollama',
    }

    // A local model needs no key, and an `apiKey: undefined` own property would still
    // be a key on the wire for the engine to validate.
    client.run({ id: 'keyless', prompt: 'run locally', verify: [] }, { provider })
    const request = await nextRequest(fake)
    expect(Object.keys(request.params.provider as object)).not.toContain('apiKey')
  })

  it('forwards the retrieval and spend ceilings', async () => {
    const fake = new FakeSidecar()
    const client = new StdioSketchClient({ spawn: fake.spawn, onDiagnostic: () => {} })
    const budget = { maxCalls: 40, maxTokens: 250_000, maxUsd: 2, onBreach: 'stop' as const }

    client.run({ id: 'bounded', prompt: 'fix the retry bug', verify: [] }, {
      contextBudgetTokens: 6_000,
      budget,
    })
    const request = await nextRequest(fake)
    expect(request.params.contextBudgetTokens).toBe(6_000)
    expect(request.params.budget).toEqual(budget)
  })

  it('omits both ceilings when the caller set neither', async () => {
    const fake = new FakeSidecar()
    const client = new StdioSketchClient({ spawn: fake.spawn, onDiagnostic: () => {} })

    // Absent must stay absent on the wire. Retrieval keys off the parameter existing at
    // all, and a null budget is a malformed one the engine would refuse outright.
    client.run({ id: 'unbounded', prompt: 'no ceilings', verify: [] })
    const request = await nextRequest(fake)
    expect(Object.keys(request.params)).not.toContain('contextBudgetTokens')
    expect(Object.keys(request.params)).not.toContain('budget')
  })

  it('forwards explicit skill promotion with the exact root and name', async () => {
    const fake = new FakeSidecar()
    const client = new StdioSketchClient({ spawn: fake.spawn, onDiagnostic: () => {} })

    const pending = client.skillPromote({ root: 'C:/repo', name: 'reviewer' })
    const request = await nextRequest(fake)
    expect(request).toMatchObject({
      method: 'skill-promote',
      params: { root: 'C:/repo', name: 'reviewer' },
    })

    fake.stdout(`${JSON.stringify({
      id: request.id,
      ok: true,
      result: { ok: true, name: 'reviewer', path: 'C:/repo/.sketch/skills/reviewer/SKILL.md', reason: null },
    })}\n`)
    await expect(pending).resolves.toMatchObject({ ok: true, name: 'reviewer' })
  })

  it('accepts a whole frame delivered without a trailing newline', async () => {
    // Tauri's shell plugin emits one `data` event per line, terminator stripped.
    const fake = new FakeSidecar()
    const client = new StdioSketchClient({ spawn: fake.spawn, onDiagnostic: () => {} })

    const pending = client.ping()
    const request = await nextRequest(fake)
    fake.stdout(JSON.stringify({ id: request.id, ok: true, result: { version: '1.2.3' } }))

    await expect(pending).resolves.toMatchObject({ version: '1.2.3' })
  })

  it('routes an event frame onto the bus instead of resolving a request', async () => {
    const fake = new FakeSidecar()
    const client = new StdioSketchClient({ spawn: fake.spawn, onDiagnostic: () => {} })

    const seen: SketchEvent[] = []
    client.subscribe((event) => seen.push(event))

    const pending = client.run({ id: 't2', prompt: 'stream', verify: [] })
    const request = await nextRequest(fake)

    fake.stdout(
      `${JSON.stringify({
        kind: 'event',
        runId: 'run-2',
        requestId: request.id,
        event: makeEvent('run-2', 'ev-1'),
      })}\n`,
    )

    expect(seen).toHaveLength(1)
    expect(seen[0]!.id).toBe('ev-1')

    fake.stdout(
      `${JSON.stringify({
        id: request.id,
        ok: true,
        result: { runId: 'run-2', ok: true, finalText: '', iterations: 1, verify: [], events: [] },
      })}\n`,
    )
    await expect(pending).resolves.toMatchObject({ runId: 'run-2' })
  })

  it('rejects with the engine error message when the frame reports failure', async () => {
    const fake = new FakeSidecar()
    const client = new StdioSketchClient({ spawn: fake.spawn, onDiagnostic: () => {} })

    const pending = client.run({ id: 't3', prompt: 'nope', verify: [] })
    const request = await nextRequest(fake)

    fake.stdout(
      `${JSON.stringify({
        id: request.id,
        ok: false,
        error: 'params.provider is required',
        code: 'invalid_params',
      })}\n`,
    )

    await expect(pending).rejects.toThrow('params.provider is required')
  })

  it('fails everything in flight when the sidecar exits, quoting its stderr', async () => {
    const fake = new FakeSidecar()
    const client = new StdioSketchClient({ spawn: fake.spawn, onDiagnostic: () => {} })

    const pending = client.ping()
    await nextRequest(fake)

    fake.handlers.stderr('sketch: fatal: cannot find module\n')
    fake.handlers.exit({ code: 1 })

    await expect(pending).rejects.toThrow(/cannot find module/)
  })
})

describe('StdioSketchClient — process lifecycle (W10 invariant 3)', () => {
  /** A spawner that counts how many times it was actually asked to start a process. */
  class CountingSidecar extends FakeSidecar {
    spawnCount = 0
    override readonly spawn: SidecarSpawner = async (handlers) => {
      this.spawnCount += 1
      this.handlers = handlers
      return {
        write: async (data: string) => {
          this.written.push(data)
        },
        kill: async () => {
          this.killed = true
        },
      }
    }
  }

  it('does not double-spawn when two first calls race (single-flight ensureStarted)', async () => {
    const fake = new CountingSidecar()
    const client = new StdioSketchClient({ spawn: fake.spawn, onDiagnostic: () => {} })

    // Two calls before any response: both must share the one in-flight spawn.
    const a = client.ping()
    const b = client.ping()
    const reqs = await (async () => {
      for (let i = 0; i < 50; i++) {
        if (fake.requests().length >= 2) return fake.requests()
        await new Promise((r) => setTimeout(r, 1))
      }
      return fake.requests()
    })()

    expect(fake.spawnCount).toBe(1) // one process, not two
    expect(reqs.length).toBe(2) // both requests were written to that one process
    for (const req of reqs) {
      fake.stdout(`${JSON.stringify({ id: req.id, ok: true, result: { version: '1' } })}\n`)
    }
    await Promise.all([a, b])
  })

  it('shows a clear engine-stopped error mid-request, then the next call restarts the engine', async () => {
    const fake = new CountingSidecar()
    const client = new StdioSketchClient({ spawn: fake.spawn, onDiagnostic: () => {} })

    // A request is in flight when the child dies.
    const first = client.run({ id: 'r1', prompt: 'work', verify: [] })
    await nextRequest(fake)
    expect(fake.spawnCount).toBe(1)
    fake.handlers.exit({ code: null, message: 'killed' })

    // The in-flight request rejects with a clear "engine stopped" message — not a hang,
    // not a leak.
    await expect(first).rejects.toThrow(/sidecar stopped/)

    // Drop the dead request's frame so the next poll only sees the restart request.
    fake.written.length = 0

    // The NEXT call restarts the engine (ensureStarted spawns again) and succeeds.
    const second = client.ping()
    const req = await nextRequest(fake)
    expect(fake.spawnCount).toBe(2) // a fresh process for the new call
    fake.stdout(`${JSON.stringify({ id: req.id, ok: true, result: { version: '2' } })}\n`)
    await expect(second).resolves.toMatchObject({ ok: true, version: '2' })
  })

  it('close() terminates the child and fails anything still in flight', async () => {
    const fake = new CountingSidecar()
    const client = new StdioSketchClient({ spawn: fake.spawn, onDiagnostic: () => {} })

    const pending = client.run({ id: 'r2', prompt: 'long', verify: [] })
    await nextRequest(fake)
    await client.close()

    expect(fake.killed).toBe(true)
    await expect(pending).rejects.toThrow(/closed/)
    // close() is idempotent.
    await expect(client.close()).resolves.toBeUndefined()
  })
})

describe('StdioSketchClient — honest failure', () => {
  const unavailable: SidecarSpawner = async () => {
    throw new Error('sidecar binary not found')
  }

  it('rejects ping when the sidecar cannot be spawned', async () => {
    const client = new StdioSketchClient({ spawn: unavailable, onDiagnostic: () => {} })
    await expect(client.ping()).rejects.toThrow(/sidecar unavailable: sidecar binary not found/)
  })

  it('rejects run instead of returning a fabricated result', async () => {
    const client = new StdioSketchClient({ spawn: unavailable, onDiagnostic: () => {} })
    await expect(client.run({ id: 't', prompt: 'anything', verify: [] })).rejects.toThrow(
      /sidecar unavailable/,
    )
  })

  it('rejects eval and captureEval too', async () => {
    const client = new StdioSketchClient({ spawn: unavailable, onDiagnostic: () => {} })
    await expect(client.eval([])).rejects.toThrow(/sidecar unavailable/)
    await expect(client.captureEval({ run: { runId: 'r' } })).rejects.toThrow(/sidecar unavailable/)
  })

  it('reports the missing Tauri runtime by name when no spawner is injected', async () => {
    // jsdom has no __TAURI_INTERNALS__, which is exactly the browser-dev case.
    const client = new StdioSketchClient({ onDiagnostic: () => {} })
    await expect(client.ping()).rejects.toThrow(/no Tauri runtime/)
  })
})

describe('StdioSketchClient — no fabricated success', () => {
  // Comments are stripped: prose about the old behaviour is not the old behaviour.
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'stdioClient.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')

  it('contains no hardcoded ok: true response', () => {
    // The regression: `run` used to return `{ ok: true, finalText: ... }` with no
    // process behind it, so a dead engine looked healthy.
    expect(source).not.toMatch(/ok:\s*true/)
    expect(source).not.toMatch(/finalText:\s*[`'"]/)
    expect(source).not.toMatch(/runId:\s*[`'"]/)
    expect(source).not.toMatch(/passed:\s*true/)
  })

  it('actually spawns something and writes frames', () => {
    expect(source).toContain('Command.sidecar')
    expect(source).toContain('spawn()')
    expect(source).toContain('child.write')
  })
})
