// Tests for the offline provider: the scripted FakeChatAdapter and the
// SKETCH_FAKE_PROVIDER registry switch.
//
// Uses REAL: the real adapter, the real registry, the real env var. Nothing is
// mocked except `global.fetch`, and that is replaced with a tripwire that FAILS
// the test if anything calls it — the whole point of this layer is that no socket
// is ever opened.
//
// Validates: Requirements 2.7, 1.6

import { describe, it, expect, afterEach } from 'vitest'
import {
  FakeChatAdapter,
  FAKE_DEFAULT_SCRIPT,
  FAKE_PLAN_RESPONSE,
  FAKE_VERIFY_RESPONSE,
  FAKE_DONE_RESPONSE,
} from '../src/providers/fake.js'
import {
  resolveAdapter,
  fakeProviderEnabled,
  FAKE_PROVIDER_ENV_VAR,
} from '../src/providers/registry.js'
import { OpenAICompatibleAdapter } from '../src/providers/openaiCompatible.js'
import type { ChatAdapter, Message, ProviderConfig } from '../src/types.js'

const HELLO: Message[] = [
  { role: 'system', content: 'you are a coding agent' },
  { role: 'user', content: 'build the thing' },
]

/** A config naming a real provider, a real-looking endpoint, and a real-looking key. */
const REAL_CONFIG: ProviderConfig = {
  id: 'openai',
  kind: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o',
  apiKey: 'sk-live-DEADBEEF0123456789',
}

const realFetch = global.fetch

/**
 * The ambient value of the switch, captured once before any test runs.
 *
 * This file is the one place that touches the REAL `process.env`, because the
 * production default reads it and an injected-env test would not catch a
 * regression where that default stops working. Ambient state that a test mutates
 * has to be put back EXACTLY as found — including the case where it was already
 * set, e.g. an offline run with `SKETCH_FAKE_PROVIDER=1` in the environment.
 * Deleting it unconditionally would be its own leak.
 */
const ambientFakeProvider = process.env[FAKE_PROVIDER_ENV_VAR]

/** Puts the switch back to the value the process started with. */
function restoreAmbientFakeProvider(): void {
  if (ambientFakeProvider === undefined) delete process.env[FAKE_PROVIDER_ENV_VAR]
  else process.env[FAKE_PROVIDER_ENV_VAR] = ambientFakeProvider
}

/** Replaces fetch with a tripwire. Any call records itself and the test fails. */
function forbidNetwork(): { calls: unknown[][] } {
  const calls: unknown[][] = []
  global.fetch = ((...args: unknown[]) => {
    calls.push(args)
    throw new Error(`network access attempted: ${String(args[0])}`)
  }) as unknown as typeof fetch
  return { calls }
}

afterEach(() => {
  global.fetch = realFetch
  restoreAmbientFakeProvider()
})

// ── the scripted sequence ────────────────────────────────────────────────────

describe('FakeChatAdapter default script', () => {
  it('returns plan, then verify, then done, each parseable as JSON', async () => {
    const fake = new FakeChatAdapter()

    const first = await fake.chat(HELLO)
    const second = await fake.chat(HELLO)
    const third = await fake.chat(HELLO)

    expect(JSON.parse(first.text).action).toBe('plan')
    expect(JSON.parse(second.text)).toEqual({ action: 'verify' })
    expect(JSON.parse(third.text).action).toBe('done')

    // Call 2 is the exact literal Requirement 2.7 names.
    expect(second.text).toBe('{"action":"verify"}')
  })

  it('emits a plan whose artifacts match the design protocol shape', async () => {
    const fake = new FakeChatAdapter()
    const { text } = await fake.chat(HELLO)
    const action = JSON.parse(text) as {
      action: string
      artifacts: Record<string, unknown>
    }

    expect(action.action).toBe('plan')
    expect(Object.keys(action.artifacts).sort()).toEqual(['arch', 'prd', 'schema', 'tests'])
    for (const value of Object.values(action.artifacts)) {
      expect(typeof value).toBe('string')
      expect((value as string).length).toBeGreaterThan(0)
    }
  })

  it('keeps returning done on the fourth and fifth calls', async () => {
    const fake = new FakeChatAdapter()
    for (let i = 0; i < 3; i++) await fake.chat(HELLO)

    const fourth = await fake.chat(HELLO)
    const fifth = await fake.chat(HELLO)

    // Clamped, not cycled: a loop with a high iteration cap terminates instead of
    // looping back round to `plan`.
    expect(JSON.parse(fourth.text).action).toBe('done')
    expect(JSON.parse(fifth.text).action).toBe('done')
    expect(fake.callCount).toBe(5)
  })

  it('exports the default script as the three protocol responses', () => {
    expect(FAKE_DEFAULT_SCRIPT).toEqual([
      FAKE_PLAN_RESPONSE,
      FAKE_VERIFY_RESPONSE,
      FAKE_DONE_RESPONSE,
    ])
  })

  it('is obviously not a real provider', () => {
    expect(new FakeChatAdapter().id).toBe('fake')
  })
})

// ── injectable script ────────────────────────────────────────────────────────

describe('FakeChatAdapter injected script', () => {
  it('drives an arbitrary action sequence', async () => {
    const script = [
      '{"action":"think","text":"considering"}',
      '{"action":"edit","edits":[{"path":"a.ts","search":"x","replace":"y"}]}',
      '{"action":"tool","name":"read","args":{}}',
      '{"action":"ask","question":"which db?"}',
    ]
    const fake = new FakeChatAdapter({ script, id: 'fake-scripted' })

    const seen: string[] = []
    for (let i = 0; i < script.length; i++) {
      seen.push((JSON.parse((await fake.chat(HELLO)).text) as { action: string }).action)
    }

    expect(seen).toEqual(['think', 'edit', 'tool', 'ask'])
    expect(fake.id).toBe('fake-scripted')
    // Past the end, the tail repeats.
    expect(JSON.parse((await fake.chat(HELLO)).text).action).toBe('ask')
  })

  it('falls back to the default script when handed an empty one', async () => {
    const fake = new FakeChatAdapter({ script: [] })
    expect(JSON.parse((await fake.chat(HELLO)).text).action).toBe('plan')
  })

  it('records the messages it received and its call count', async () => {
    const fake = new FakeChatAdapter()
    expect(fake.callCount).toBe(0)
    expect(fake.lastMessages).toBeUndefined()

    await fake.chat(HELLO)
    await fake.chat([{ role: 'user', content: 'again' }])

    expect(fake.callCount).toBe(2)
    expect(fake.calls[0]).toEqual(HELLO)
    expect(fake.lastMessages).toEqual([{ role: 'user', content: 'again' }])

    fake.reset()
    expect(fake.callCount).toBe(0)
  })
})

// ── usage accounting ─────────────────────────────────────────────────────────

describe('FakeChatAdapter usage', () => {
  it('populates usage and scales it with input size', async () => {
    const small = new FakeChatAdapter()
    const large = new FakeChatAdapter()

    const smallRes = await small.chat([{ role: 'user', content: 'hi' }])
    const largeRes = await large.chat([{ role: 'user', content: 'x'.repeat(4_000) }])

    expect(smallRes.usage).toBeDefined()
    expect(largeRes.usage).toBeDefined()
    expect(smallRes.usage!.in).toBeGreaterThan(0)
    expect(smallRes.usage!.out).toBeGreaterThan(0)
    // Derived from input, not hardcoded: a 2000x longer prompt costs more.
    expect(largeRes.usage!.in).toBeGreaterThan(smallRes.usage!.in * 100)
    // The response is fixed, so output tokens do not move with input.
    expect(largeRes.usage!.out).toBe(smallRes.usage!.out)
  })

  it('sums to a non-zero total over a full three-call run', async () => {
    const fake = new FakeChatAdapter()
    let totalIn = 0
    let totalOut = 0
    for (let i = 0; i < 3; i++) {
      const { usage } = await fake.chat(HELLO)
      totalIn += usage!.in
      totalOut += usage!.out
    }
    expect(totalIn).toBeGreaterThan(0)
    expect(totalOut).toBeGreaterThan(0)
  })
})

// ── cancellation ─────────────────────────────────────────────────────────────

describe('FakeChatAdapter cancellation', () => {
  it('throws an abort-shaped error when the signal is already aborted', async () => {
    const fake = new FakeChatAdapter()
    const controller = new AbortController()
    controller.abort()

    await expect(fake.chat(HELLO, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    // A rejected call is not a scripted turn.
    expect(fake.callCount).toBe(0)
  })
})

// ── no network, ever ─────────────────────────────────────────────────────────

describe('FakeChatAdapter is offline', () => {
  it('makes no network call across the full sequence', async () => {
    const tripwire = forbidNetwork()
    const fake = new FakeChatAdapter()

    for (let i = 0; i < 5; i++) await fake.chat(HELLO)

    expect(tripwire.calls).toEqual([])
    expect(fake.callCount).toBe(5)
  })

  it('never references fetch in its source', async () => {
    const { readFileSync } = await import('node:fs')
    const { join, dirname, resolve } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(
      join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'src/providers/fake.ts'),
      'utf8',
    )
    // Comments are stripped first: the file DISCUSSES fetch in prose, and that
    // documentation should not be what keeps this guard green.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    expect(code).not.toContain('fetch')
    expect(code).not.toContain('http')
  })

  it('completes a full three-call run with no key and no network', async () => {
    const tripwire = forbidNetwork()
    const keyless: ProviderConfig = {
      id: 'openai',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      // Deliberately no apiKey.
    }
    expect(keyless.apiKey).toBeUndefined()

    const adapter: ChatAdapter = resolveAdapter(keyless, { SKETCH_FAKE_PROVIDER: '1' })
    const actions: string[] = []
    for (let i = 0; i < 3; i++) {
      actions.push((JSON.parse((await adapter.chat(HELLO)).text) as { action: string }).action)
    }

    expect(actions).toEqual(['plan', 'verify', 'done'])
    expect(tripwire.calls).toEqual([])
  })
})

// ── the registry switch ──────────────────────────────────────────────────────

describe('SKETCH_FAKE_PROVIDER switch', () => {
  it('resolves to the fake even for a real provider with a real-looking baseUrl', () => {
    const adapter = resolveAdapter(REAL_CONFIG, { SKETCH_FAKE_PROVIDER: '1' })
    expect(adapter).toBeInstanceOf(FakeChatAdapter)
    expect(adapter.id).toBe('fake')
  })

  it('resolves the real adapter for that same config without the flag', () => {
    const adapter = resolveAdapter(REAL_CONFIG, {})
    expect(adapter).toBeInstanceOf(OpenAICompatibleAdapter)
    expect(adapter.id).toBe('openai')
  })

  it('only treats the exact value "1" as on', () => {
    for (const value of ['0', 'true', 'yes', '', ' 1']) {
      expect(fakeProviderEnabled({ SKETCH_FAKE_PROVIDER: value })).toBe(false)
    }
    expect(fakeProviderEnabled({ SKETCH_FAKE_PROVIDER: '1' })).toBe(true)
    expect(fakeProviderEnabled({})).toBe(false)
  })

  // Explicitly sequential — the default inside a file, stated so that a future
  // `describe.concurrent` cannot let a sibling test observe the window in which
  // the real switch is flipped. `finally` (plus the `afterEach`) puts the ambient
  // value back whether the assertions pass, fail, or throw.
  it.sequential('reads the real process.env at call time (the actual code path)', () => {
    try {
      // Unset: real adapter.
      delete process.env[FAKE_PROVIDER_ENV_VAR]
      expect(resolveAdapter(REAL_CONFIG)).toBeInstanceOf(OpenAICompatibleAdapter)

      // Set: fake. Read per call, not captured at module load.
      process.env[FAKE_PROVIDER_ENV_VAR] = '1'
      expect(resolveAdapter(REAL_CONFIG)).toBeInstanceOf(FakeChatAdapter)

      // Unset again in the same process: back to real.
      delete process.env[FAKE_PROVIDER_ENV_VAR]
      expect(resolveAdapter(REAL_CONFIG)).toBeInstanceOf(OpenAICompatibleAdapter)
    } finally {
      restoreAmbientFakeProvider()
    }
  })

  it('hands out a fresh fake per resolution, so call counts never bleed', async () => {
    const first = resolveAdapter(REAL_CONFIG, { SKETCH_FAKE_PROVIDER: '1' })
    await first.chat(HELLO)
    const second = resolveAdapter(REAL_CONFIG, { SKETCH_FAKE_PROVIDER: '1' })

    expect(second).not.toBe(first)
    expect((second as FakeChatAdapter).callCount).toBe(0)
    expect(JSON.parse((await second.chat(HELLO)).text).action).toBe('plan')
  })
})
