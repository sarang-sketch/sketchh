// W10 invariant 6 — the RPC dispatch loop is robust.
//
// The real ProtocolServer is driven in process with crafted input lines: malformed
// JSON, a non-object line, an unknown method, bad params, a handler that throws, an
// oversized frame, and two concurrent exclusive runs. Each must produce a specific
// JSON-RPC error frame (or an ordered pair of results) and NOTHING else — the loop
// keeps draining and the process never crashes. A handler's own unhandled rejection
// becomes an error response rather than taking the engine down.
//
// This is the in-process half (fast, deterministic). The doc also records a crafted-
// frame smoke run over the real stdio CLI (packages/core/dist/cli.js).

import { describe, expect, it } from 'vitest'

import { ProtocolServer } from '../src/rpc/index.js'
import type { MethodHandler } from '../src/rpc/index.js'

interface Frame {
  id?: unknown
  ok?: boolean
  error?: string
  code?: string
  result?: unknown
  kind?: string
}

/** Drive a server with a fixed method table and collect every stdout frame. */
function makeServer(methods: Record<string, MethodHandler>) {
  const out: Frame[] = []
  const err: string[] = []
  const server = new ProtocolServer({
    writeOut: (line) => out.push(JSON.parse(line) as Frame),
    writeErr: (line) => err.push(line),
    methods,
    env: {},
    cwd: () => '/tmp',
  })
  return { server, out, err }
}

describe('ProtocolServer — malformed and hostile input never crashes the loop', () => {
  it('answers malformed JSON with a malformed_json error and a null id', async () => {
    const { server, out } = makeServer({})
    await server.handleLine('{ not json ]')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: null, ok: false, code: 'malformed_json' })
  })

  it('answers a non-object line with invalid_request', async () => {
    const { server, out } = makeServer({})
    await server.handleLine('[1,2,3]')
    expect(out[0]).toMatchObject({ ok: false, code: 'invalid_request' })
  })

  it('answers an unknown method with unknown_method, echoing the id', async () => {
    const { server, out } = makeServer({})
    await server.handleLine(JSON.stringify({ id: 'x1', method: 'no-such-method', params: {} }))
    expect(out[0]).toMatchObject({ id: 'x1', ok: false, code: 'unknown_method' })
    expect(out[0]!.error).toMatch(/known methods:/)
  })

  it('answers a request whose params is not an object with invalid_request', async () => {
    const { server, out } = makeServer({ echo: async () => ({ ok: true }) })
    await server.handleLine(JSON.stringify({ id: 7, method: 'echo', params: [1, 2] }))
    expect(out[0]).toMatchObject({ id: 7, ok: false, code: 'invalid_request' })
  })

  it('turns a handler throw into a handler_error response, then keeps serving', async () => {
    const { server, out } = makeServer({
      boom: async () => {
        throw new Error('handler blew up')
      },
      ok: async () => ({ fine: true }),
    })
    await server.handleLine(JSON.stringify({ id: 'a', method: 'boom', params: {} }))
    await server.handleLine(JSON.stringify({ id: 'b', method: 'ok', params: {} }))

    expect(out[0]).toMatchObject({ id: 'a', ok: false, code: 'handler_error', error: 'handler blew up' })
    // The next request is served normally — the throw did not stop the loop.
    expect(out[1]).toMatchObject({ id: 'b', ok: true, result: { fine: true } })
  })

  it('a blank line is framing noise, answered with nothing', async () => {
    const { server, out } = makeServer({})
    await server.handleLine('')
    await server.handleLine('   ')
    expect(out).toHaveLength(0)
  })

  it('carries an oversized frame without crashing (one big params string)', async () => {
    const seen: number[] = []
    const { server, out } = makeServer({
      sink: async (params) => {
        seen.push(String((params as { blob?: unknown }).blob ?? '').length)
        return { got: true }
      },
    })
    const big = 'x'.repeat(2_000_000) // 2 MB payload on one line
    await server.handleLine(JSON.stringify({ id: 'big', method: 'sink', params: { blob: big } }))
    expect(out[0]).toMatchObject({ id: 'big', ok: true })
    expect(seen[0]).toBe(2_000_000)
  })
})

describe('ProtocolServer — exclusive runs do not fight (invariant 6)', () => {
  it('serializes two concurrent run requests in arrival order', async () => {
    const started: string[] = []
    const finished: string[] = []
    let releaseFirst: (() => void) | null = null

    const run: MethodHandler = async (params) => {
      const tag = String((params as { tag?: unknown }).tag)
      started.push(tag)
      if (tag === 'one') {
        // Hold the first run open until the test releases it, so if the second ran
        // concurrently its start would interleave before the first finished.
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
      }
      finished.push(tag)
      return { tag }
    }

    const { server, out } = makeServer({ run })

    // 'run' is an EXCLUSIVE method: the second must wait for the first.
    const first = server.handleLine(JSON.stringify({ id: 1, method: 'run', params: { tag: 'one' } }))
    const second = server.handleLine(JSON.stringify({ id: 2, method: 'run', params: { tag: 'two' } }))

    // Let microtasks settle; the second run must NOT have started yet.
    await new Promise((r) => setTimeout(r, 5))
    expect(started).toEqual(['one']) // 'two' has not started while 'one' is open

    releaseFirst!()
    await Promise.all([first, second])

    expect(started).toEqual(['one', 'two'])
    expect(finished).toEqual(['one', 'two'])
    // Responses come back in request order.
    expect(out.map((f) => f.id)).toEqual([1, 2])
  })

  it('a non-exclusive method is answered while an exclusive run is still open', async () => {
    let releaseRun: (() => void) | null = null
    const methods: Record<string, MethodHandler> = {
      run: async () => {
        await new Promise<void>((resolve) => {
          releaseRun = resolve
        })
        return { ran: true }
      },
      ping: async () => ({ pong: true }),
    }
    const { server, out } = makeServer(methods)

    const runPromise = server.handleLine(JSON.stringify({ id: 'run-1', method: 'run', params: {} }))
    // ping is NOT exclusive, so it is answered immediately even though run is open.
    await server.handleLine(JSON.stringify({ id: 'ping-1', method: 'ping', params: {} }))

    expect(out.find((f) => f.id === 'ping-1')).toMatchObject({ ok: true, result: { pong: true } })
    // The run has not answered yet.
    expect(out.find((f) => f.id === 'run-1')).toBeUndefined()

    releaseRun!()
    await runPromise
    expect(out.find((f) => f.id === 'run-1')).toMatchObject({ ok: true, result: { ran: true } })
  })
})
