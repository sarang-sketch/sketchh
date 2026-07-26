// @vitest-environment node
//
// The dev bridge, exercised over a real socket (Requirements 13.5, 13.6, 12.6).
//
// Both endpoints are driven for real: the middleware is mounted on a `node:http`
// server, requests go out over `fetch`, and the SSE stream is read off the
// response body and parsed the way `EventSource` would. Nothing here asserts on
// the plugin OBJECT — a shape assertion is what let two dead endpoints ship.
//
// Offline and free: `SKETCH_FAKE_PROVIDER=1` is passed to the bridge's env, so
// `run` resolves the scripted adapter and never opens a socket to a provider.

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createSketchBridge } from '../../vite.config'
import type { SketchEvent } from './contracts'

/** A value shaped like a credential but matching no vendor prefix, so only the */
/** registered-value path can redact it. If it survives, the bridge leaks keys.  */
const API_KEY = 'ZmFrZUtleTAxMjM0NTY3ODlhYmNkZWZnaGlqa2xtbm9w'

let server: Server
let base: string
let root: string

function listen(s: Server): Promise<number> {
  return new Promise((resolvePort) => {
    s.listen(0, '127.0.0.1', () => {
      const address = s.address()
      resolvePort(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sketch-bridge-'))
  const bridge = createSketchBridge({
    env: { ...process.env, SKETCH_FAKE_PROVIDER: '1' },
    cwd: () => root,
    keepAliveMs: 50,
  })
  server = createServer((req, res) => {
    bridge(req, res, () => {
      res.statusCode = 404
      res.end('not the bridge')
    })
  })
  const port = await listen(server)
  base = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()))
  await rm(root, { recursive: true, force: true })
})

interface Frame {
  id: string | number | null
  ok: boolean
  result?: unknown
  error?: string
  code?: string
}

async function post(body: string): Promise<{ status: number; text: string; frame: Frame }> {
  const res = await fetch(`${base}/__sketch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  const text = await res.text()
  return { status: res.status, text, frame: JSON.parse(text) as Frame }
}

function call(method: string, params?: unknown, id: string = method): Promise<{
  status: number
  text: string
  frame: Frame
}> {
  return post(JSON.stringify({ id, method, params }))
}

/** A live SSE subscriber, parsed exactly as `EventSource` parses the wire. */
interface Stream {
  events: SketchEvent[]
  /** Every byte received, for leak scanning. */
  raw(): string
  close(): void
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>
}

async function openStream(): Promise<Stream> {
  const controller = new AbortController()
  const res = await fetch(`${base}/__sketch/events`, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/event-stream')

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const events: SketchEvent[] = []
  let all = ''
  let buffer = ''

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        const chunk = decoder.decode(value, { stream: true })
        all += chunk
        buffer += chunk
        // SSE messages are separated by a blank line; `data:` lines carry payload.
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const message = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          for (const line of message.split('\n')) {
            if (line.startsWith('data: ')) {
              events.push(JSON.parse(line.slice(6)) as SketchEvent)
            }
          }
          boundary = buffer.indexOf('\n\n')
        }
      }
    } catch {
      // Aborted by close(), or the server went away. Either is a normal end.
    }
  })()

  return {
    events,
    raw: () => all,
    close: () => controller.abort(),
    async waitFor(predicate, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for SSE events')
        await new Promise((r) => setTimeout(r, 10))
      }
    },
  }
}

function task(prompt: string, id = 'bridge-task') {
  return { id, prompt, verify: [] as unknown[] }
}

describe('vite dev bridge — POST /__sketch', () => {
  it('answers ping with a real engine result', async () => {
    const { status, frame } = await call('ping')
    expect(status).toBe(200)
    expect(frame.ok).toBe(true)
    expect(frame.id).toBe('ping')
    const result = frame.result as Record<string, unknown>
    // These come from the engine itself, not from the bridge.
    expect(result['engine']).toBe('@sketch/core')
    expect(result['protocol']).toBe(1)
    expect(result['version']).toBe('0.1.0')
    expect(result['fakeProvider']).toBe(true)
    expect(result['pid']).toBe(process.pid)
  })

  it('answers an unknown method with an ok:false frame and stays up', async () => {
    const { status, frame } = await call('no-such-method')
    expect(status).toBe(200)
    expect(frame.ok).toBe(false)
    expect(frame.code).toBe('unknown_method')
    expect(frame.error).toContain('no-such-method')
    // Still serving.
    expect((await call('ping', undefined, 'after-unknown')).frame.ok).toBe(true)
  })

  it('answers a malformed body with an ok:false frame and stays up', async () => {
    const { status, frame } = await post('{ this is not json')
    expect(status).toBe(200)
    expect(frame.ok).toBe(false)
    expect(frame.code).toBe('malformed_json')
    expect(frame.id).toBeNull()
    expect((await call('ping', undefined, 'after-malformed')).frame.ok).toBe(true)
  })

  it('answers invalid params with the engine error message, not an HTTP error', async () => {
    const { status, frame } = await call('run', { task: { id: '', prompt: '' } })
    expect(status).toBe(200)
    expect(frame.ok).toBe(false)
    expect(frame.code).toBe('invalid_params')
    expect(frame.error).toContain('params.task.id')
  })
})

describe('vite dev bridge — GET /__sketch/events', () => {
  it('streams run events, correlated by runId, to a live subscriber', async () => {
    const stream = await openStream()
    try {
      const { frame } = await call('run', { task: task('stream me'), root }, 'streamed-run')
      expect(frame.ok).toBe(true)
      const result = frame.result as { runId: string; ok: boolean }

      await stream.waitFor(() => stream.events.length > 0)
      expect(stream.events.length).toBeGreaterThan(0)
      expect(stream.events.map((e) => e.kind)).toContain('run_started')
      // Requirement 12.6: every streamed event names the run it belongs to.
      for (const event of stream.events) expect(event.runId).toBe(result.runId)
      // The stream is the log, not a summary of it.
      expect(stream.events.every((e) => typeof e.id === 'string' && typeof e.ts === 'number')).toBe(
        true,
      )
    } finally {
      stream.close()
    }
  })

  it('frames each event as its own SSE message and keeps the idle stream alive', async () => {
    const stream = await openStream()
    try {
      await call('run', { task: task('framing'), root }, 'framing-run')
      await stream.waitFor(() => stream.events.length > 0)
      const raw = stream.raw()
      expect(raw).toContain('data: {')
      expect(raw).toContain('\n\n')
      // Keep-alive comments are what stop a proxy dropping an idle stream.
      await stream.waitFor(() => stream.raw().includes(': keep-alive'))
    } finally {
      stream.close()
    }
  })

  it('survives a subscriber disconnecting mid-run', async () => {
    const stream = await openStream()
    const pending = call('run', { task: task('drop me'), root }, 'dropped-run')
    // Cut the stream while the run is still producing events.
    stream.close()
    const { frame } = await pending
    expect(frame.ok).toBe(true)
    expect((frame.result as { ok: boolean }).ok).toBe(true)
    // The server is unharmed and a new subscriber still works.
    const second = await openStream()
    try {
      await call('run', { task: task('after drop'), root }, 'after-drop-run')
      await second.waitFor(() => second.events.length > 0)
    } finally {
      second.close()
    }
  })
})

describe('vite dev bridge — secrets', () => {
  it('never returns a credential from params in a response or an event', async () => {
    const stream = await openStream()
    try {
      const { text, frame } = await call(
        'run',
        {
          // The key arrives in params …
          provider: {
            id: 'test',
            kind: 'anthropic-messages',
            baseUrl: '',
            model: 'test-model',
            apiKey: API_KEY,
          },
          // … and the same value is echoed by the engine inside run_started.
          task: task(`use ${API_KEY} to authenticate`),
          root,
        },
        'secret-run',
      )
      expect(frame.ok).toBe(true)

      await stream.waitFor(() => stream.events.some((e) => e.kind === 'run_started'))

      expect(text).not.toContain(API_KEY)
      expect(JSON.stringify(frame)).not.toContain(API_KEY)
      expect(stream.raw()).not.toContain(API_KEY)
      expect(JSON.stringify(stream.events)).not.toContain(API_KEY)
      // Redacted, not merely absent: the event still reports the prompt.
      const started = stream.events.find((e) => e.kind === 'run_started')!
      expect(String(started.payload['prompt'])).toContain('[redacted]')
    } finally {
      stream.close()
    }
  })
})

describe('vite dev bridge — routing', () => {
  it('passes non-bridge requests to the next middleware', async () => {
    const res = await fetch(`${base}/index.html`)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('not the bridge')
  })
})
