// providerFetch: the timeout and bounded-retry layer under every chat adapter.
//
// Driven with an injected `fetchImpl` and an injected `sleep`, so nothing opens a
// socket and no test waits for a real backoff. The properties pinned here are the
// ones a user feels: a rate limit is retried (and `Retry-After` honoured), a
// rejected key is NOT retried, a silent provider times out instead of hanging, and
// a Stop during a backoff wait ends the wait at once.

import { describe, expect, it, vi } from 'vitest'

import {
  ProviderTimeoutError,
  backoffMs,
  isLoopbackUrl,
  providerFetch,
  readableErrorDetail,
  retryAfterMs,
  statusHint,
} from '../src/providers/http.js'
import { OpenAICompatibleAdapter, contentText } from '../src/providers/openaiCompatible.js'

function response(status: number, body = '', headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers })
}

const noSleep = async (): Promise<void> => {}

describe('providerFetch retries', () => {
  it('retries a 429 and returns the eventual success', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(429, 'slow down'))
      .mockResolvedValueOnce(response(200, '{"ok":true}'))
    const retries: string[] = []
    const res = await providerFetch('https://api.example.com/v1/x', { method: 'POST' }, {
      fetchImpl,
      sleep: noSleep,
      onRetry: (info) => retries.push(info.reason),
    })
    expect(res.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(retries).toEqual(['HTTP 429'])
  })

  it('honours Retry-After when the provider sends one', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(503, '', { 'retry-after': '3' }))
      .mockResolvedValueOnce(response(200, 'ok'))
    const waits: number[] = []
    await providerFetch('https://api.example.com/v1/x', {}, {
      fetchImpl,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    expect(waits).toEqual([3000])
  })

  it('does not wait on the body of an answer it is about to retry', async () => {
    // A 503 whose body never finishes. Reading it to the end would hang the run:
    // by then this attempt's timeout and Stop hook are already gone.
    const stalled = new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 503 })
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(stalled)
      .mockResolvedValueOnce(response(200, 'ok'))
    const res = await providerFetch('https://api.example.com/v1/x', {}, { fetchImpl, sleep: noSleep })
    expect(res.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  }, 3000)

  it('does not retry a rejected key: one request, one refusal', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(401, 'bad key'))
    const res = await providerFetch('https://api.example.com/v1/x', {}, { fetchImpl, sleep: noSleep })
    expect(res.status).toBe(401)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('gives up after the configured retries and returns the last answer', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(502, 'gateway'))
    const res = await providerFetch('https://api.example.com/v1/x', {}, {
      fetchImpl,
      sleep: noSleep,
      retries: 2,
    })
    expect(res.status).toBe(502)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('retries a reset socket but not a refused connection', async () => {
    const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })

    const flaky = vi.fn().mockRejectedValueOnce(reset).mockResolvedValueOnce(response(200, 'ok'))
    const ok = await providerFetch('https://api.example.com/v1/x', {}, { fetchImpl: flaky, sleep: noSleep })
    expect(ok.status).toBe(200)
    expect(flaky).toHaveBeenCalledTimes(2)

    const down = vi.fn().mockRejectedValue(refused)
    await expect(
      providerFetch('http://127.0.0.1:11434/v1/x', {}, { fetchImpl: down, sleep: noSleep }),
    ).rejects.toBe(refused)
    expect(down).toHaveBeenCalledTimes(1)
  })
})

describe('providerFetch ceilings and cancellation', () => {
  it('times out a provider that never answers, naming the ceiling', async () => {
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        }),
    )
    const err = await providerFetch('https://api.example.com/v1/x', {}, {
      fetchImpl,
      timeoutMs: 20,
      sleep: noSleep,
    }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ProviderTimeoutError)
    expect((err as Error).message).toMatch(/no answer within/)
    // A timeout is not retried: the next attempt would wait just as long.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('ends a backoff wait at once when the caller aborts', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn().mockResolvedValue(response(429, ''))
    const pending = providerFetch('https://api.example.com/v1/x', {}, {
      fetchImpl,
      signal: controller.signal,
      // A real sleep, long enough that only the abort can end it inside the test.
    })
    setTimeout(() => controller.abort(), 20)
    const started = Date.now()
    const err = await pending.then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err?.name).toBe('AbortError')
    expect(Date.now() - started).toBeLessThan(900)
  })
})

describe('helpers', () => {
  it('reads Retry-After as seconds or as an HTTP date', () => {
    expect(retryAfterMs('2')).toBe(2000)
    expect(retryAfterMs(null)).toBeNull()
    expect(retryAfterMs('soon')).toBeNull()
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(retryAfterMs('Thu, 01 Jan 2026 00:00:05 GMT', now)).toBe(5000)
  })

  it('backs off exponentially within the cap', () => {
    expect(backoffMs(1)).toBeGreaterThanOrEqual(1000)
    expect(backoffMs(2)).toBeGreaterThanOrEqual(2000)
    expect(backoffMs(30)).toBeLessThanOrEqual(20_000)
  })

  it('tells a loopback endpoint from a hosted one', () => {
    expect(isLoopbackUrl('http://localhost:11434/v1')).toBe(true)
    expect(isLoopbackUrl('http://127.0.0.1:1234/v1')).toBe(true)
    expect(isLoopbackUrl('http://[::1]:8080/v1')).toBe(true)
    expect(isLoopbackUrl('https://api.openai.com/v1')).toBe(false)
  })

  it('explains the statuses a user can act on', () => {
    expect(statusHint(401)).toMatch(/API key/)
    expect(statusHint(429)).toMatch(/Rate limited/)
    expect(statusHint(503)).toMatch(/trouble/)
    expect(statusHint(418)).toBe('')
  })

  it('extracts reply text from strings, content-part arrays, and reasoning output', () => {
    expect(contentText('plain')).toBe('plain')
    expect(contentText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab')
    expect(contentText('<think>{"brace": "noise"}</think>\n{"action":"done","text":"x"}')).toBe(
      '{"action":"done","text":"x"}',
    )
    expect(contentText(null)).toBe('')
  })
})

describe('provider error bodies a person can read', () => {
  it('pulls the message out of the common JSON shapes, keeping the code', () => {
    expect(
      readableErrorDetail('{"error":{"message":"Daily token quota exceeded. Retry after 19 seconds.","type":"insufficient_quota","code":"quota_exceeded"}}'),
    ).toBe('Daily token quota exceeded. Retry after 19 seconds. (quota_exceeded)')
    expect(readableErrorDetail('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toBe('Overloaded (overloaded_error)')
    expect(readableErrorDetail('{"error":"model not found"}')).toBe('model not found')
    expect(readableErrorDetail('[{"error":{"message":"bad","code":"x"}}]')).toBe('bad (x)')
    expect(readableErrorDetail('{"detail":"Not authenticated"}')).toBe('Not authenticated')
  })

  it('leaves anything else exactly as it came', () => {
    expect(readableErrorDetail('<html>Bad Gateway</html>')).toBe('<html>Bad Gateway</html>')
    expect(readableErrorDetail('{"unexpected":true}')).toBe('{"unexpected":true}')
    expect(readableErrorDetail('{not json')).toBe('{not json')
    expect(readableErrorDetail('  ')).toBe('')
    // An empty object says nothing; the status hint carries the meaning.
    expect(readableErrorDetail('{}')).toBe('')
  })

  it('reaches the person through the adapter, still redacted', async () => {
    const key = 'sk-readable-0123456789abcdef'
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      response(400, JSON.stringify({ error: { message: `Invalid model for key ${key}`, code: 'model_not_found' } }))) as typeof fetch
    try {
      const adapter = new OpenAICompatibleAdapter({ id: 'custom', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', model: 'm', apiKey: key })
      const error = await adapter.chat([{ role: 'user', content: 'hi' }]).then(
        () => null,
        (err: unknown) => err as Error,
      )
      expect(error?.message).toContain('custom: HTTP 400')
      expect(error?.message).toContain('Invalid model for key')
      expect(error?.message).toContain('(model_not_found)')
      expect(error?.message).not.toContain('{"error"')
      expect(error?.message).not.toContain(key)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})