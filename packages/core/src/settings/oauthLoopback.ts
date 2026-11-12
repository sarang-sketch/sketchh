// The loopback half of a desktop OAuth sign-in (RFC 8252 §7.3).
//
// "Connect your account" for a desktop app works the same way everywhere: the app
// opens the provider's consent page in the user's own browser with a
// `callback_url` pointing at a port on THIS machine, the provider redirects back
// there with a one-time `code`, and the app exchanges that code — together with the
// PKCE verifier only it knows — for a credential. This module is the listener: it
// binds a random port on loopback, waits for exactly one callback, answers the
// browser with a small "you can close this tab" page, and hands the code back.
//
// WHAT IT NEVER DOES:
//   * bind anything but loopback — the callback is for this machine only;
//   * accept a second callback — the session closes on the first one;
//   * exchange the code or hold a credential — the code is useless without the
//     verifier, which never leaves the surface that generated it, and the key the
//     exchange returns goes straight to the OS credential store from there;
//   * live forever — every session has a deadline and is closed when it passes.

import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

const DEFAULT_TIMEOUT_MS = 5 * 60_000
const MAX_TIMEOUT_MS = 15 * 60_000
/** Sessions open at once. Each holds a port; a stuck surface must not leak dozens. */
const MAX_SESSIONS = 4

export type LoopbackOutcome =
  | { ok: true; code: string }
  | { ok: false; error: string }

interface Session {
  id: string
  servers: Server[]
  callbackPath: string
  settled: Promise<LoopbackOutcome>
  settle: (outcome: LoopbackOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

const sessions = new Map<string, Session>()
/**
 * Outcomes of sessions whose listener has already closed, kept briefly so a surface
 * that calls `wait` a moment after the callback landed still receives the code.
 */
const finished = new Map<string, Promise<LoopbackOutcome>>()
const FINISHED_RETENTION_MS = 2 * 60_000

const DONE_PAGE = (title: string, body: string): string =>
  [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    `<title>${title}</title>`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0f1115;color:#e7e9ee;',
    'display:flex;align-items:center;justify-content:center;height:100vh;margin:0}',
    'main{max-width:420px;text-align:center;padding:32px;border:1px solid #2a2f3a;border-radius:14px;background:#161a22}',
    'h1{font-size:20px;margin:0 0 8px}p{color:#a3aab8;line-height:1.5;margin:0}</style></head>',
    `<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`,
  ].join('')

/**
 * The small "you can close this tab" page a sign-in callback answers with. No
 * scripts, nothing loaded. `body` must already be HTML-escaped by the caller.
 */
export function renderCallbackPage(title: string, body: string): string {
  return DONE_PAGE(title, body)
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
  )
}

function respond(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // The page has no scripts and loads nothing; say so to the browser.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'Referrer-Policy': 'no-referrer',
  })
  res.end(html)
}

function close(session: Session): void {
  clearTimeout(session.timer)
  for (const server of session.servers) server.close()
  sessions.delete(session.id)
  finished.set(session.id, session.settled)
  const expiry = setTimeout(() => finished.delete(session.id), FINISHED_RETENTION_MS)
  expiry.unref?.()
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolve((server.address() as AddressInfo).port)
    })
  })
}

export interface LoopbackStart {
  id: string
  /** The exact URL to hand the provider as its callback. */
  callbackUrl: string
  port: number
  expiresAt: number
}

/**
 * Open a callback listener on a random loopback port.
 *
 * The callback URL uses the `localhost` name, which is what providers allow for
 * desktop apps; the listener answers on both 127.0.0.1 and ::1 so it is reachable
 * whichever address the browser resolves `localhost` to.
 */
export async function startLoopback(options: { timeoutMs?: number; now?: () => number } = {}): Promise<LoopbackStart> {
  if (sessions.size >= MAX_SESSIONS) {
    // The oldest abandoned sign-in gives way to the new one.
    const oldest = sessions.values().next().value as Session | undefined
    if (oldest !== undefined) {
      oldest.settle({ ok: false, error: 'superseded by a newer sign-in' })
      close(oldest)
    }
  }

  const id = randomBytes(12).toString('hex')
  const callbackPath = `/callback/${randomBytes(9).toString('hex')}`
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(5_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  const now = options.now ?? (() => Date.now())

  let settle: (outcome: LoopbackOutcome) => void = () => {}
  let done = false
  const settled = new Promise<LoopbackOutcome>((resolve) => {
    settle = (outcome) => {
      if (done) return
      done = true
      resolve(outcome)
    }
  })

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method !== 'GET' || url.pathname !== callbackPath) {
      respond(res, 404, DONE_PAGE('Not found', 'This address only accepts a sign-in callback.'))
      return
    }
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error') ?? url.searchParams.get('error_description')
    if (code !== null && code.trim() !== '') {
      respond(
        res,
        200,
        DONE_PAGE('Connected to Sketch', 'Your account is connected. You can close this tab and return to Sketch.'),
      )
      settle({ ok: true, code: code.trim() })
    } else {
      const reason = error ?? 'the provider did not return a code'
      respond(res, 400, DONE_PAGE('Sign-in did not complete', escapeHtml(reason)))
      settle({ ok: false, error: reason })
    }
    // Let the page reach the browser before the listener goes away.
    setTimeout(() => {
      const session = sessions.get(id)
      if (session !== undefined) close(session)
    }, 250).unref?.()
  }

  const primary = createServer(handler)
  const port = await listen(primary, '127.0.0.1', 0)
  const servers: Server[] = [primary]
  const secondary = createServer(handler)
  try {
    await listen(secondary, '::1', port)
    servers.push(secondary)
  } catch {
    // No IPv6 loopback on this machine: 127.0.0.1 alone is enough.
  }

  const timer = setTimeout(() => {
    settle({ ok: false, error: 'the sign-in was not completed in time' })
    const session = sessions.get(id)
    if (session !== undefined) close(session)
  }, timeoutMs)
  timer.unref?.()

  sessions.set(id, { id, servers, callbackPath, settled, settle, timer })
  return {
    id,
    callbackUrl: `http://localhost:${port}${callbackPath}`,
    port,
    expiresAt: now() + timeoutMs,
  }
}

/** Wait for the session's callback. Resolves once; a finished session reports why. */
export async function waitLoopback(id: string): Promise<LoopbackOutcome> {
  const session = sessions.get(id)
  if (session !== undefined) return session.settled
  const done = finished.get(id)
  if (done !== undefined) return done
  return { ok: false, error: 'no sign-in is waiting under that id' }
}

/** Abandon a session. Idempotent. */
export function cancelLoopback(id: string): boolean {
  const session = sessions.get(id)
  if (session === undefined) return false
  session.settle({ ok: false, error: 'cancelled' })
  close(session)
  return true
}

/** Sessions currently listening. For tests and diagnostics. */
export function openLoopbackCount(): number {
  return sessions.size
}
