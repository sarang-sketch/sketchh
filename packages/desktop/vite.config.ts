// Vite dev server + the dev-mode bridge to the engine (Requirements 13.5, 13.6, 12.6).
//
// THE BRIDGE IS A REAL TRANSPORT FOR THE STDIO PROTOCOL, not a lookalike. It
// parses a request with core's `parseRequest`, dispatches through core's `METHODS`
// with a context built by core's `createMethodContext`, and scrubs every outgoing
// frame with core's `sanitizeFrame`. Nothing about frames, contexts, or secrets is
// re-implemented here — a second copy of any of those is exactly how the browser
// transport and the sidecar transport drift apart.
//
// TWO ENDPOINTS:
//   POST /__sketch          one request frame in, one response frame out
//   GET  /__sketch/events   server-sent events, one `SketchEvent` per message
//
// FRAME SHAPE IS THE SAME ON BOTH TRANSPORTS, deliberately, so `HttpSketchClient`
// and `StdioSketchClient` differ only in how bytes move. A failed call answers
// HTTP 200 carrying `{ id, ok: false, error, code }` — NOT an HTTP 4xx/5xx, which
// would make the client surface "HTTP 400" instead of the engine's own message and
// lose the `code` entirely.
//
// SSE PAYLOAD IS THE INNER `SketchEvent`, not the enclosing event frame: that is
// what `HttpSketchClient.initSse` parses (`JSON.parse(msg.data)` emitted straight
// onto the bus) and what `StdioSketchClient` emits off `frame.event`. Correlation
// by `runId` (Requirement 12.6) still holds — `runId` is a field of the event
// itself, so no wrapper is needed to carry it.
//
// SECRETS DO NOT CROSS THE BRIDGE. Credential-shaped params are collected by key
// name on arrival (`collectParamSecrets`), handlers register their own
// (`ctx.rememberSecret`), and both feed the one `secrets` set that every response
// frame and every streamed event is sanitized against.

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Frame } from '@sketch/core'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import type { Plugin, ViteDevServer } from 'vite'

const RPC_PATH = '/__sketch'
const EVENTS_PATH = '/__sketch/events'

/**
 * Idle comment interval. Proxies and browsers drop a stream that says nothing for
 * long enough; a comment line is valid SSE and is ignored by `EventSource`.
 */
const KEEPALIVE_MS = 15_000

/** A request body larger than this is refused rather than buffered. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

export interface SketchBridgeOptions {
  env?: NodeJS.ProcessEnv
  /** Default project root for methods that take an optional `root`. */
  cwd?: () => string
  /** Override for tests that do not want to wait on the real interval. */
  keepAliveMs?: number
}

type Next = (err?: unknown) => void
export type BridgeMiddleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void

/** Loaded once per process, on first request, so config load stays cheap. */
let corePromise: Promise<typeof import('@sketch/core')> | undefined
function loadCore(): Promise<typeof import('@sketch/core')> {
  corePromise ??= import('@sketch/core')
  return corePromise
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buf.byteLength
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', (err) => rejectPromise(err))
  })
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The bridge as a plain Connect middleware, independent of Vite. Exported so a
 * test can mount it on a bare `node:http` server and exercise both endpoints for
 * real, which is the only way either of them stays honest.
 */
export function createSketchBridge(options: SketchBridgeOptions = {}): BridgeMiddleware {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? (() => process.cwd())
  const keepAliveMs = options.keepAliveMs ?? KEEPALIVE_MS

  /** Every credential value this bridge has seen, in params or from a handler. */
  const secrets = new Set<string>()
  const sseClients = new Set<ServerResponse>()

  function dropClient(res: ServerResponse): void {
    sseClients.delete(res)
  }

  /**
   * Push one already-sanitized event to every live stream. A client that vanished
   * mid-run fails its write; it is dropped and the run continues, which is the
   * whole point of doing this per-client instead of in one buffer.
   */
  function broadcast(event: unknown): void {
    const line = `data: ${JSON.stringify(event)}\n\n`
    for (const res of [...sseClients]) {
      if (res.writableEnded || res.destroyed) {
        dropClient(res)
        continue
      }
      try {
        res.write(line)
      } catch {
        dropClient(res)
      }
    }
  }

  function openStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Defeats nginx-style response buffering, which otherwise holds events
      // until the stream closes — i.e. until the run is over.
      'X-Accel-Buffering': 'no',
    })
    // A first comment flushes headers so `EventSource` reaches `open` immediately.
    res.write(': sketch stream open\n\n')

    const timer = setInterval(() => {
      if (res.writableEnded || res.destroyed) return
      try {
        res.write(': keep-alive\n\n')
      } catch {
        dropClient(res)
      }
    }, keepAliveMs)
    // Never hold the event loop open on the keep-alive alone. `setInterval` is
    // typed as the DOM's in this project (a number), so unref is reached
    // defensively rather than through the Node typing.
    ;(timer as unknown as { unref?: () => void }).unref?.()

    const close = (): void => {
      clearInterval(timer)
      dropClient(res)
    }
    sseClients.add(res)
    req.on('close', close)
    req.on('error', close)
    res.on('close', close)
    res.on('error', close)
  }

  function sendFrame(res: ServerResponse, frame: Frame): void {
    if (res.writableEnded || res.destroyed) return
    const body = JSON.stringify(frame)
    // 200 even for `ok: false`: the frame carries the outcome, exactly as on stdio.
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    })
    res.end(body)
  }

  async function handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const core = await loadCore()
    const {
      METHODS,
      parseRequest,
      sanitizeFrame,
      createMethodContext,
      collectParamSecrets,
      isEventFrame,
      InvalidParamsError,
      NotImplementedError,
    } = core

    const scrub = (frame: Frame): Frame => sanitizeFrame(frame, env, secrets)

    let body: string
    try {
      body = await readBody(req)
    } catch (err) {
      // An aborted or oversized upload is answered if the socket is still there,
      // and dropped silently if it is not. Either way the server stays up.
      sendFrame(
        res,
        scrub({ id: null, ok: false, code: 'invalid_request', error: messageOf(err) }),
      )
      return
    }

    const parsed = parseRequest(body)
    if (!parsed.ok) {
      sendFrame(res, scrub({ id: parsed.id, ok: false, code: parsed.code, error: parsed.error }))
      return
    }

    const request = parsed.request
    const handler = METHODS[request.method]
    if (handler === undefined) {
      sendFrame(
        res,
        scrub({
          id: request.id,
          ok: false,
          code: 'unknown_method',
          error: `unknown method ${JSON.stringify(request.method)}; known methods: ${Object.keys(
            METHODS,
          )
            .sort()
            .join(', ')}`,
        }),
      )
      return
    }

    collectParamSecrets(request.params, (secret) => secrets.add(secret))

    const ctx = createMethodContext(request.id, {
      // Event frames land here as the run proceeds. Sanitize, then stream the
      // inner event — the shape `HttpSketchClient` parses.
      writeFrame: (frame) => {
        const safe = scrub(frame)
        if (isEventFrame(safe)) broadcast(safe.event)
      },
      writeErr: (line) => {
        process.stderr.write(`[sketch-bridge] ${line}\n`)
      },
      env,
      cwd,
      secrets,
    })

    try {
      const result = await handler(request.params, ctx)
      sendFrame(res, scrub({ id: request.id, ok: true, result }))
    } catch (err) {
      const code =
        err instanceof InvalidParamsError
          ? 'invalid_params'
          : err instanceof NotImplementedError
            ? 'not_implemented'
            : 'handler_error'
      sendFrame(res, scrub({ id: request.id, ok: false, code, error: messageOf(err) }))
    }
  }

  return function sketchBridge(req, res, next) {
    // `req.url` on a Connect stack is path + query; match on the path alone.
    const path = (req.url ?? '').split('?')[0]

    if (path === EVENTS_PATH && req.method === 'GET') {
      openStream(req, res)
      return
    }

    if (path === RPC_PATH && req.method === 'POST') {
      void handleRpc(req, res).catch((err: unknown) => {
        // Last-resort guard: a throw here must not take the dev server down.
        try {
          sendFrame(res, { id: null, ok: false, code: 'handler_error', error: messageOf(err) })
        } catch {
          if (!res.writableEnded) res.end()
        }
      })
      return
    }

    next()
  }
}

export function sketchBridgePlugin(options: SketchBridgeOptions = {}): Plugin {
  return {
    name: 'sketch-dev-bridge',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(
        createSketchBridge({
          cwd: () => server.config.root,
          ...options,
        }),
      )
    },
  }
}

export default defineConfig({
  plugins: [react(), sketchBridgePlugin()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { usePolling: true },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'esnext',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
})
