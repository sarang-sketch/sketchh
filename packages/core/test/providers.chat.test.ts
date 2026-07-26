// Tests for the canonical ChatAdapter provider layer: the two dependency-free
// adapters, centralized redaction, and the registry's per-call resolution.
//
// Everything here is offline — `global.fetch` is mocked in every test that makes
// a request, and every resolution is handed an EXPLICIT env (see `FAKE_OFF`), so
// no assertion in this file depends on the ambient process environment.
//
// Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.8, 2.9

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ChatAdapter, Message, ProviderConfig } from '../src/types.js'
import { OpenAICompatibleAdapter } from '../src/providers/openaiCompatible.js'
import {
  AnthropicMessagesAdapter,
  toAnthropicBody,
  fromAnthropicResponse,
} from '../src/providers/anthropicMessages.js'
import { redact, providerErrorMessage, REDACTED } from '../src/providers/redact.js'
import {
  ProviderRegistry,
  resolveAdapter,
  describeProvider,
  serverlessProviders,
  PROVIDER_CATALOG,
} from '../src/providers/registry.js'
import type { ProviderEnv } from '../src/providers/registry.js'
import { OpenAIAdapter } from '../src/providers/openai.js'
import { AnthropicAdapter } from '../src/providers/anthropic.js'
import { GeminiAdapter } from '../src/providers/gemini.js'

const SECRET = 'sk-SECRET123'

/**
 * The env every resolution in this file is handed: the offline switch OFF.
 *
 * Resolution defaults its `env` argument to the real `process.env`, so a call
 * that omits it asserts against whatever the ambient environment happens to
 * hold. `SKETCH_FAKE_PROVIDER=1` is a supported way to run the whole product
 * (and the offline gate), which means "no argument" is not a neutral choice: in
 * that environment the registry correctly hands back a `FakeChatAdapter` and
 * these assertions fail for a reason that has nothing to do with the code under
 * test. The injectable parameter exists exactly so the expectation is stated,
 * not inherited.
 */
const FAKE_OFF: ProviderEnv = {}

/** Restore fetch after the tests that swap it, so nothing ambient is left behind. */
const realFetch = global.fetch
afterEach(() => {
  global.fetch = realFetch
})

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  })
}

const HELLO: Message[] = [{ role: 'user', content: 'Hello' }]

/** Await a rejection and hand back the Error, typed. Fails loudly if it resolves. */
async function captureError(call: Promise<unknown>): Promise<Error> {
  const outcome = await call.then(
    () => null,
    (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
  )
  if (!outcome) throw new Error('expected the call to reject, but it resolved')
  return outcome
}

function oaiConfig(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'openai',
    kind: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    model: 'test-model',
    apiKey: SECRET,
    ...over,
  }
}

function anthropicConfig(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'anthropic',
    kind: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.example',
    model: 'claude-test',
    apiKey: SECRET,
    ...over,
  }
}

// ── OpenAICompatibleAdapter ──────────────────────────────────────────────────

describe('OpenAICompatibleAdapter', () => {
  it('returns { text, usage } from a chat/completions response', async () => {
    const fetchSpy = mockFetch({
      choices: [{ message: { content: 'Hi there' } }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    })
    global.fetch = fetchSpy

    const adapter = new OpenAICompatibleAdapter(oaiConfig())
    const res = await adapter.chat(HELLO)

    expect(res.text).toBe('Hi there')
    expect(res.usage).toEqual({ in: 11, out: 7 })
    expect(adapter.id).toBe('openai')

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.com/v1/chat/completions')
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe(`Bearer ${SECRET}`)
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('test-model')
    expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }])
  })

  it('merges configured headers and forwards the abort signal', async () => {
    const fetchSpy = mockFetch({ choices: [{ message: { content: 'ok' } }] })
    global.fetch = fetchSpy

    const controller = new AbortController()
    const adapter = new OpenAICompatibleAdapter(
      oaiConfig({ headers: { 'HTTP-Referer': 'https://sketch.local' } }),
    )
    const res = await adapter.chat(HELLO, { signal: controller.signal })

    // No usage block in the response means no usage in the result.
    expect(res).toEqual({ text: 'ok' })
    const init = (fetchSpy.mock.calls[0] as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>)['HTTP-Referer']).toBe('https://sketch.local')
    expect(init.signal).toBe(controller.signal)
  })

  it('throws with status and provider id, and never the key, on a 401', async () => {
    // Worst case: the endpoint echoes the credential back inside the error body.
    global.fetch = mockFetch(
      { error: { message: `Incorrect API key provided: ${SECRET}` } },
      401,
    )
    const adapter = new OpenAICompatibleAdapter(oaiConfig())

    const err = await captureError(adapter.chat(HELLO))
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('openai')
    expect(err.message).toContain('401')
    expect(err.message).not.toContain(SECRET)
    expect(err.message).not.toContain(`Bearer ${SECRET}`)
    expect(err.message).toContain(REDACTED)
  })
})

// ── AnthropicMessagesAdapter ─────────────────────────────────────────────────

describe('AnthropicMessagesAdapter', () => {
  it('hoists system messages and maps usage', async () => {
    const fetchSpy = mockFetch({
      content: [{ type: 'text', text: 'Hello from Claude' }],
      usage: { input_tokens: 8, output_tokens: 4 },
    })
    global.fetch = fetchSpy

    const adapter = new AnthropicMessagesAdapter(anthropicConfig())
    const res = await adapter.chat([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'and kind' },
    ])

    expect(res.text).toBe('Hello from Claude')
    expect(res.usage).toEqual({ in: 8, out: 4 })

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.example/v1/messages')
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe(SECRET)
    expect(headers['anthropic-version']).toBe('2023-06-01')

    const body = JSON.parse(init.body as string)
    expect(body.system).toBe('be terse\n\nand kind')
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('translates tool turns to user turns and concatenates text blocks', () => {
    const body = toAnthropicBody('claude-test', [
      { role: 'user', content: 'run it' },
      { role: 'assistant', content: 'running' },
      { role: 'tool', content: 'exit 0' },
    ])
    expect(body.system).toBeUndefined()
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])

    const out = fromAnthropicResponse({
      content: [
        { type: 'text', text: 'a' },
        { type: 'thinking', text: 'ignored' },
        { type: 'text', text: 'b' },
      ],
    })
    expect(out).toEqual({ text: 'ab' })
  })

  it('throws without the key when the endpoint echoes it on a 401', async () => {
    global.fetch = mockFetch(`authentication_error: x-api-key: ${SECRET} is invalid`, 401)
    const adapter = new AnthropicMessagesAdapter(anthropicConfig())

    const err = await captureError(adapter.chat(HELLO))
    expect(err.message).toContain('anthropic')
    expect(err.message).toContain('401')
    expect(err.message).not.toContain(SECRET)
  })
})

// ── redact ───────────────────────────────────────────────────────────────────

describe('redact', () => {
  it('removes a bare key value from a message', () => {
    const out = redact(`invalid key ${SECRET} for account`, [SECRET])
    expect(out).not.toContain(SECRET)
    expect(out).toBe(`invalid key ${REDACTED} for account`)
  })

  it('removes the value of an Authorization: Bearer header', () => {
    const out = redact('sent Authorization: Bearer abcdefghijklmnop while retrying', [])
    expect(out).not.toContain('abcdefghijklmnop')
    expect(out).toContain(`Authorization: ${REDACTED}`)
  })

  it('removes the value of an x-api-key header', () => {
    const out = redact('headers { x-api-key: aaaa-bbbb-cccc-dddd }', [])
    expect(out).not.toContain('aaaa-bbbb-cccc-dddd')
    expect(out).toContain(`x-api-key: ${REDACTED}`)
  })

  it('removes a ?key= query parameter value', () => {
    const out = redact(
      'GET https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=AIzaLEAKED123 failed',
      [],
    )
    expect(out).not.toContain('AIzaLEAKED123')
    expect(out).toContain(`?key=${REDACTED}`)
    // The rest of the URL survives, so the error is still diagnosable.
    expect(out).toContain('generateContent')
  })

  it('removes an &key= query parameter value', () => {
    const out = redact('POST /v1beta/x?alt=sse&key=AIzaLEAKED456', [])
    expect(out).not.toContain('AIzaLEAKED456')
    expect(out).toContain(`&key=${REDACTED}`)
  })

  it('builds a provider error message with id, status, and redacted detail', () => {
    const msg = providerErrorMessage({
      providerId: 'groq',
      status: 401,
      detail: `Authorization: Bearer ${SECRET}`,
      secrets: [SECRET],
    })
    expect(msg).toContain('groq')
    expect(msg).toContain('401')
    expect(msg).not.toContain(SECRET)
  })
})

// ── Legacy adapters as ChatAdapter (Req 2.3) ─────────────────────────────────

describe('existing adapters satisfy ChatAdapter', () => {
  it('OpenAIAdapter.chat() delegates to complete() and maps usage', async () => {
    global.fetch = mockFetch({
      choices: [{ message: { content: 'legacy hi' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    })
    const adapter = new OpenAIAdapter()
    adapter.configure({ apiKey: 'sk-test' })
    const asChat: ChatAdapter = adapter

    const res = await asChat.chat([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ])
    expect(res.text).toBe('legacy hi')
    expect(res.usage).toEqual({ in: 3, out: 2 })
    expect(asChat.id).toBe('openai')
  })

  it('AnthropicAdapter and GeminiAdapter expose the same seam', async () => {
    const anthropic: ChatAdapter = new AnthropicAdapter()
    const gemini: ChatAdapter = new GeminiAdapter()
    expect(typeof anthropic.chat).toBe('function')
    expect(typeof gemini.chat).toBe('function')

    const a = new AnthropicAdapter()
    a.configure({ apiKey: 'sk-ant-test' })
    global.fetch = mockFetch({
      content: [{ type: 'text', text: 'claude hi' }],
      usage: { input_tokens: 5, output_tokens: 1 },
    })
    const res = await (a as ChatAdapter).chat(HELLO)
    expect(res.text).toBe('claude hi')
    expect(res.usage).toEqual({ in: 5, out: 1 })
  })

  it('legacy adapters redact the key when the body echoes it (Req 2.6)', async () => {
    const adapter = new OpenAIAdapter()
    adapter.configure({ apiKey: SECRET })
    global.fetch = mockFetch(`401 Unauthorized: Bearer ${SECRET} rejected`, 401)

    const err = await captureError(
      adapter.complete([{ role: 'user', content: 'Hello' }], { model: 'gpt-4o' }),
    )
    expect(err.message).not.toContain(SECRET)
    expect(err.message).not.toContain(`Bearer ${SECRET}`)
  })

  it('estimateCost returns 0 for unknown models instead of throwing (Req 2.9)', () => {
    const usage = { inputTokens: 1_000, outputTokens: 1_000 }
    expect(new OpenAIAdapter().estimateCost(usage, 'no-such-model')).toBe(0)
    expect(new AnthropicAdapter().estimateCost(usage, 'no-such-model')).toBe(0)
    expect(new GeminiAdapter().estimateCost(usage, 'no-such-model')).toBe(0)
  })
})

// ── Registry ─────────────────────────────────────────────────────────────────

describe('registry resolution', () => {
  it('resolves a fresh adapter instance per call (Req 2.8)', () => {
    const reg = new ProviderRegistry()
    const first = reg.resolve(oaiConfig(), FAKE_OFF)
    const second = reg.resolve(oaiConfig(), FAKE_OFF)
    expect(first).not.toBe(second)
    expect(first).toBeInstanceOf(OpenAICompatibleAdapter)

    const direct = resolveAdapter(oaiConfig(), FAKE_OFF)
    expect(direct).not.toBe(first)
  })

  it('resolves each kind to the matching adapter', () => {
    expect(resolveAdapter(oaiConfig(), FAKE_OFF)).toBeInstanceOf(OpenAICompatibleAdapter)
    expect(resolveAdapter(anthropicConfig(), FAKE_OFF)).toBeInstanceOf(AnthropicMessagesAdapter)
  })

  it('falls back to the catalog baseUrl when the config omits one', async () => {
    const fetchSpy = mockFetch({ choices: [{ message: { content: 'local' } }] })
    global.fetch = fetchSpy
    const adapter = resolveAdapter(
      {
        id: 'ollama',
        kind: 'openai-compatible',
        baseUrl: '',
        model: 'llama3',
      },
      FAKE_OFF,
    )
    await adapter.chat(HELLO)
    expect((fetchSpy.mock.calls[0] as [string, RequestInit])[0]).toBe(
      'http://localhost:11434/v1/chat/completions',
    )
  })

  it('throws when no baseUrl is available', () => {
    expect(() =>
      resolveAdapter(
        { id: 'custom', kind: 'openai-compatible', baseUrl: '', model: 'x' },
        FAKE_OFF,
      ),
    ).toThrow(/no baseUrl/)
  })
})

describe('provider catalog', () => {
  it('covers the full provider matrix (Req 2.4)', () => {
    const ids = PROVIDER_CATALOG.map((p) => p.id)
    for (const id of [
      'openai',
      'anthropic',
      'gemini',
      'groq',
      'openrouter',
      'ollama',
      'github-models',
      'azure-openai',
      'cloudflare-workers-ai',
      'llamacpp',
      'custom',
    ]) {
      expect(ids).toContain(id)
    }
  })

  it('flags exactly the serverless inference endpoints (Req 2.5)', () => {
    expect(serverlessProviders().map((p) => p.id).sort()).toEqual([
      'azure-openai',
      'cloudflare-workers-ai',
      'github-models',
      'groq',
      'openrouter',
    ])
  })

  it('marks local runtimes as key-free', () => {
    expect(describeProvider('ollama')?.needsKey).toBe(false)
    expect(describeProvider('llamacpp')?.needsKey).toBe(false)
    expect(describeProvider('llamacpp')?.serverless).toBe(false)
    expect(describeProvider('openai')?.needsKey).toBe(true)
  })

  it('routes Anthropic through the anthropic-messages kind', () => {
    expect(describeProvider('anthropic')?.kind).toBe('anthropic-messages')
    expect(describeProvider('gemini')?.kind).toBe('openai-compatible')
    expect(describeProvider('nope')).toBeUndefined()
  })
})
