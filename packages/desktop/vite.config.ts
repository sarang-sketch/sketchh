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
//
// WHO MAY CALL IT. `run` writes files and spawns processes, so reachability is part
// of the design, not a deployment detail. Two checks, both in `refusalReason`:
//   - the `Host` must be loopback, so `vite --host` (which overrides any `server.host`
//     in this file) cannot expose the engine to the local network;
//   - a present `Origin` (or, failing that, `Referer`) must be this dev server's own
//     origin, so a page on another local port cannot drive a run in the background.
// An ABSENT `Origin` is allowed: browsers omit it on same-origin GETs, `EventSource`
// sends none, and the dev page's own `fetch` may not carry one either.
// A refusal answers HTTP 403, NOT the usual 200-with-`ok:false`: nothing was parsed
// and no method ran, so it is not an engine outcome to report as one. The body is
// still frame-shaped so a legitimate misconfiguration reads a reason instead of a
// bare status.

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { ExtensionBundle, Frame } from '@sketch/core'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import type { Plugin, ViteDevServer } from 'vite'

import { themeColors } from './src/styles/themeColors'

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
  /** Optional host-owned production extensions, shared with stdio's ServerIO contract. */
  extensions?: ExtensionBundle
}

type Next = (err?: unknown) => void
export type BridgeMiddleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void

/** Loaded once per process, on first request, so config load stays cheap. */
let corePromise: Promise<typeof import('@sketch/core')> | undefined
function loadCore(): Promise<typeof import('@sketch/core')> {
  // The bridge hosts the engine in this process, so it installs the engine's Offline
  // Mode guard here, as the sidecar's entry point does. Older builds of core lack it.
  corePromise ??= import('@sketch/core').then((core) => {
    core.installNetworkGuard?.()
    return core
  })
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

// ── Reachability ────────────────────────────────────────────────────────────

/** Strip the port from a Host header value, keeping the IPv6 bracket form intact. */
function hostnameOf(host: string): string {
  const value = host.trim().toLowerCase()
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1)
  const colon = value.indexOf(':')
  return colon === -1 ? value : value.slice(0, colon)
}

/** `localhost`, the whole 127/8 block, and IPv6 `::1`. Nothing else is this machine. */
function isLoopback(hostname: string): boolean {
  const bare = hostname.replace(/^\[/, '').replace(/\]$/, '')
  return bare === 'localhost' || bare === '::1' || /^127(\.\d{1,3}){3}$/.test(bare)
}

/** Keeps a reflected header value out of the response beyond what a reason needs. */
function clip(value: string): string {
  return value.length > 96 ? `${value.slice(0, 96)}…` : value
}

/**
 * Why this request may not use the bridge, or null if it may.
 *
 * The `Host` header is what the caller addressed, so it is also what the same-origin
 * comparison uses: matching `Origin` against a hardcoded port would break the moment
 * the dev server moves.
 */
function refusalReason(req: IncomingMessage): string | null {
  const host = (req.headers.host ?? '').trim()
  if (host === '') return 'refused: request has no Host header'
  if (!isLoopback(hostnameOf(host))) {
    return `refused: the dev bridge answers on loopback only, not ${clip(host)}`
  }

  // `Origin` is authoritative when present. `Referer` is only consulted in its
  // absence, and never treated as proof of anything on its own.
  const stated = req.headers.origin ?? req.headers.referer
  if (stated === undefined) return null

  let url: URL
  try {
    url = new URL(stated)
  } catch {
    // Includes the opaque `Origin: null` a sandboxed frame or a file:// page sends.
    return `refused: unusable Origin ${clip(stated)}`
  }
  if (url.host.toLowerCase() !== host.toLowerCase()) {
    return `refused: cross-origin request from ${clip(url.origin)}`
  }
  return null
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
      ...(options.extensions !== undefined ? { extensions: options.extensions } : {}),
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

  /**
   * A refused caller gets 403 and a frame-shaped body. `invalid_request` is the
   * engine's existing code for "this never became a request" — no new code is minted
   * here, because the code vocabulary lives in core and this transport does not own
   * it.
   */
  function sendRefusal(res: ServerResponse, reason: string): void {
    if (res.writableEnded || res.destroyed) return
    const body = JSON.stringify({ id: null, ok: false, code: 'invalid_request', error: reason })
    res.writeHead(403, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    })
    res.end(body)
  }

  return function sketchBridge(req, res, next) {
    // `req.url` on a Connect stack is path + query; match on the path alone.
    const path = (req.url ?? '').split('?')[0]
    const isBridgePath = path === EVENTS_PATH || path === RPC_PATH

    // Checked before either endpoint, and only for them: a request Vite itself
    // serves is none of this middleware's business.
    if (isBridgePath) {
      const refusal = refusalReason(req)
      if (refusal !== null) {
        sendRefusal(res, refusal)
        return
      }
    }

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
  css: {
    postcss: {
      // The light theme is derived from the dark stylesheets here (src/styles/themeColors.ts).
      // Only the app's own CSS: Monaco and xterm are themed through their own options.
      plugins: [themeColors((file) => /[\\/]src[\\/]/.test(file) && !/[\\/]node_modules[\\/]/.test(file))],
    },
  },
  server: {
    // Stated rather than left to the default. `--host` on the command line still
    // overrides it, which is why the bridge refuses a non-loopback Host itself.
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: { usePolling: true },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    manifest: true,
    target: 'esnext',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
})
