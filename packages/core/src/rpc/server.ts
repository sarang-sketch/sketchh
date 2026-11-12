// The dispatch loop: lines in, frames out.
//
// STDOUT IS PROTOCOL ONLY (Requirement 12.5). Every byte written to stdout passes
// through `#write` below, which is the only place in this module that touches it.
// There is no `console.log` anywhere under `src/rpc/`, no banner, and no progress
// rendering. Diagnostics — skill load failures, missing skills, the fatal handler
// — go to stderr through `writeErr`.
//
// TWO LANES. Long-running, project-mutating work — `run`, `eval`, `skill-train` —
// is queued and handled one at a time, in arrival order, exactly as every request
// used to be: two overlapping runs cannot fight over the same project root and plan
// directory, and their responses come back in request order.
//
// EVERYTHING ELSE IS ANSWERED IMMEDIATELY, even while a run is in flight. This is
// not an optimisation, it is what makes the control plane exist at all: `cancel`
// and `reply` address a run that is STILL OPEN, so a server that queued them behind
// that run could never deliver them — the packaged app's Stop button and its answer
// box were dead for exactly that reason, while the concurrent HTTP dev bridge masked
// it. The same queue also froze every panel (git, search, cost, settings) for the
// whole length of a run.
//
// Correlation therefore rests on `id` and on the `requestId` every event frame
// carries, which both clients already use. An event frame written while two
// requests are open belongs to the request named in its `requestId`, not to
// whichever response happens to come next.
//
// RESILIENCE (Requirements 12.3, 12.4). Malformed JSON, an unknown method, bad
// params, and a handler that throws all produce an error frame and NOTHING else:
// the queue keeps draining and the next request is served normally. The only exit
// is stdin closing.
//
// SECRETS. `#write` sanitizes every outgoing frame with `sanitizePayload` against
// the environment's credential-shaped values plus any credential seen in a
// request's params. That is belt-and-braces on top of the event store's write-path
// sanitation: the store already guarantees no event payload carries a secret, and
// this guarantees no RESPONSE or ERROR frame does either — an error message
// echoing a 401 body, for instance.
//
// Validates: Requirements 12.1, 12.3, 12.4, 12.5, 12.6

import { createInterface } from 'node:readline'

import type { ExtensionBundle } from '../extensions/index.js'
import { sanitizePayload } from '../events/index.js'
import { isSensitiveKeyName, MIN_SECRET_LENGTH } from '../secrets/index.js'
import { encodeFrame, parseRequest } from './frames.js'
import type { ErrorCode, Frame, FrameId, RequestFrame } from './frames.js'
import { installNetworkGuard } from '../privacy/offline.js'
import {
  envSecrets,
  InvalidParamsError,
  METHODS,
  NotImplementedError,
} from './methods.js'
import type { MethodContext, MethodHandler } from './methods.js'

export interface ServerIO {
  /** Write one protocol line to stdout. The newline is added by the server. */
  writeOut(line: string): void
  /** Write one diagnostic line to stderr. */
  writeErr(line: string): void
  /** Environment. Injected so a test never has to mutate `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Working directory, used as the default project root. */
  cwd?: () => string
  /** Method table override, for tests. Defaults to {@link METHODS}. */
  methods?: Readonly<Record<string, MethodHandler>>
  /** Optional immutable extension bundle owned by the embedding host. */
  extensions?: ExtensionBundle
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Map a thrown error to its wire code. Unrecognized throws are handler errors. */
function codeFor(err: unknown): ErrorCode {
  if (err instanceof InvalidParamsError) return 'invalid_params'
  if (err instanceof NotImplementedError) return 'not_implemented'
  return 'handler_error'
}

/**
 * Collect credential-shaped values out of a params object by KEY NAME, at any
 * depth, so `{ provider: { apiKey } }` is covered without the handler having to
 * remember. Handlers additionally register keys explicitly; both paths feed the
 * same set.
 *
 * Exported because a second transport (the Vite dev bridge, Requirement 13.5)
 * has to collect exactly the same values before dispatching, and a divergent
 * second copy of this walk is precisely how a key leaks on one transport only.
 */
export function collectParamSecrets(
  value: unknown,
  into: (secret: string) => void,
  depth = 0,
): void {
  if (depth > 8 || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectParamSecrets(item, into, depth + 1)
    return
  }
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (typeof inner === 'string') {
      if (isSensitiveKeyName(key) && inner.length >= MIN_SECRET_LENGTH) into(inner)
      continue
    }
    collectParamSecrets(inner, into, depth + 1)
  }
}

/**
 * What a {@link MethodContext} needs from its transport. The stdio server below
 * supplies stdout and stderr; the dev bridge supplies an HTTP response and an SSE
 * fan-out. Nothing else differs, which is why both build their context through
 * {@link createMethodContext} rather than each inventing one.
 */
export interface MethodContextIO {
  /**
   * Deliver one frame produced by a handler — in practice always an event frame.
   * The callee is responsible for sanitation; use {@link sanitizeFrame}.
   */
  writeFrame(frame: Frame): void
  /** Diagnostics. Never the protocol channel (Requirement 12.5). */
  writeErr(line: string): void
  env: NodeJS.ProcessEnv
  cwd: () => string
  /**
   * Credential values seen so far, MUTATED by `rememberSecret`. Shared across
   * requests on one transport so a key seen in request 1 is still redacted out of
   * request 2's frames.
   */
  secrets: Set<string>
  extensions?: ExtensionBundle
}

/**
 * The one construction of a handler context. Both transports call this; neither
 * has its own copy of the emit/log/remember trio.
 */
export function createMethodContext(requestId: FrameId, io: MethodContextIO): MethodContext {
  return {
    emitEvent: (event) => {
      io.writeFrame({
        kind: 'event',
        runId: event.runId,
        requestId,
        event,
      })
    },
    log: (message) => io.writeErr(message),
    rememberSecret: (value) => {
      if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH) {
        io.secrets.add(value)
      }
    },
    secrets: () => [...envSecrets(io.env), ...io.secrets],
    env: io.env,
    cwd: io.cwd,
    ...(io.extensions !== undefined ? { extensions: io.extensions } : {}),
  }
}

/**
 * Scrub a frame against the environment's credential-shaped values plus every
 * value remembered during this transport's lifetime. Applied to EVERY outgoing
 * frame — response, error, and event alike — on every transport.
 */
export function sanitizeFrame(
  frame: Frame,
  env: NodeJS.ProcessEnv,
  secrets: Iterable<string>,
): Frame {
  return sanitizePayload(frame as unknown as Record<string, unknown>, [
    ...envSecrets(env),
    ...secrets,
  ]) as unknown as Frame
}

/**
 * Methods that do long-running, project-mutating work and therefore keep the
 * original one-at-a-time, arrival-order discipline among themselves. Every other
 * method is answered as soon as it arrives — see the header.
 */
export const EXCLUSIVE_METHODS: ReadonlySet<string> = new Set(['run', 'eval', 'skill-train'])

/** The `method` of a request line, or null when the line is not a request object. */
function methodOf(line: string): string | null {
  try {
    const value = JSON.parse(line) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const method = (value as Record<string, unknown>)['method']
    return typeof method === 'string' ? method : null
  } catch {
    return null
  }
}

export class ProtocolServer {
  readonly #io: ServerIO
  readonly #methods: Readonly<Record<string, MethodHandler>>
  readonly #env: NodeJS.ProcessEnv
  readonly #cwd: () => string
  /** Credential values seen in requests, redacted from every outgoing frame. */
  readonly #secrets = new Set<string>()
  /** The exclusive lane. Each exclusive line's work is chained onto the previous one's. */
  #exclusiveTail: Promise<void> = Promise.resolve()
  /** Every line still being handled, in either lane. What `drain` waits for. */
  readonly #inflight = new Set<Promise<void>>()
  #handled = 0

  constructor(io: ServerIO) {
    this.#io = io
    this.#methods = io.methods ?? METHODS
    this.#env = io.env ?? process.env
    this.#cwd = io.cwd ?? (() => process.cwd())
  }

  /** Requests fully handled, responses included. Convenience for assertions. */
  get handled(): number {
    return this.#handled
  }

  /**
   * Accept one input line. The returned promise resolves when THIS line's response
   * has been written; it never rejects.
   *
   * An exclusive method (see {@link EXCLUSIVE_METHODS}) waits for every exclusive
   * line before it. Anything else starts now, so `cancel` and `reply` reach a run
   * that is still open.
   */
  handleLine(line: string): Promise<void> {
    const method = methodOf(line)
    let work: Promise<void>
    if (method !== null && EXCLUSIVE_METHODS.has(method)) {
      work = this.#exclusiveTail.then(() => this.#process(line))
      // Detach failures from the chain: one poisoned line must not stop the lane.
      this.#exclusiveTail = work.catch(() => {})
    } else {
      work = this.#process(line)
    }
    const settled = work.catch(() => {})
    this.#inflight.add(settled)
    void settled.then(() => this.#inflight.delete(settled))
    return settled
  }

  /** Resolves when every line accepted so far — in both lanes — has been handled. */
  async drain(): Promise<void> {
    while (this.#inflight.size > 0) {
      await Promise.all([...this.#inflight])
    }
  }

  async #process(line: string): Promise<void> {
    // A blank line is framing noise (a trailing newline, a keep-alive), not a
    // request. Answering it with an error would spam a client that flushes.
    if (line.trim() === '') return

    const parsed = parseRequest(line)
    if (!parsed.ok) {
      this.#error(parsed.id, parsed.code, parsed.error)
      this.#handled++
      return
    }

    const request = parsed.request
    const handler = this.#methods[request.method]
    if (handler === undefined) {
      this.#error(
        request.id,
        'unknown_method',
        `unknown method ${JSON.stringify(request.method)}; known methods: ${Object.keys(
          this.#methods,
        )
          .sort()
          .join(', ')}`,
      )
      this.#handled++
      return
    }

    collectParamSecrets(request.params, (secret) => this.#secrets.add(secret))

    try {
      const result = await handler(request.params, this.#contextFor(request))
      this.#write({ id: request.id, ok: true, result })
    } catch (err) {
      this.#error(request.id, codeFor(err), messageOf(err))
    }
    this.#handled++
  }

  #contextFor(request: RequestFrame): MethodContext {
    return createMethodContext(request.id, {
      writeFrame: (frame) => this.#write(frame),
      writeErr: (message) => this.#io.writeErr(message),
      env: this.#env,
      cwd: this.#cwd,
      secrets: this.#secrets,
      ...(this.#io.extensions !== undefined ? { extensions: this.#io.extensions } : {}),
    })
  }

  #error(id: FrameId, code: ErrorCode, error: string): void {
    this.#write({ id, ok: false, error, code })
  }

  /** The ONE stdout write. Sanitizes, serializes, and terminates the line. */
  #write(frame: Frame): void {
    this.#io.writeOut(encodeFrame(sanitizeFrame(frame, this.#env, this.#secrets)))
  }
}

/** Build a server over the given IO. */
export function createServer(io: ServerIO): ProtocolServer {
  return new ProtocolServer(io)
}

/**
 * Wire the server to this process's stdio and serve until stdin ends.
 *
 * `readline` splits on both `\n` and `\r\n` (`crlfDelay: Infinity` keeps a CRLF
 * from being read as two lines), so a Windows client writing CRLF is fine.
 *
 * Shutdown is graceful: on stdin close the queue is drained so an in-flight run
 * still writes its response, and then the function returns. It deliberately does
 * NOT call `process.exit` — a forced exit truncates pending stdout writes, which
 * on a pipe is exactly how a client loses the last frame.
 */
export async function main(io: Partial<ServerIO> = {}): Promise<void> {
  // Offline Mode's backstop: every request this process makes goes through `fetch`,
  // and from here on `fetch` refuses non-local hosts while Offline Mode is on.
  installNetworkGuard(io.env ? { env: io.env } : {})
  const server = new ProtocolServer({
    writeOut: io.writeOut ?? ((line) => void process.stdout.write(`${line}\n`)),
    writeErr: io.writeErr ?? ((line) => void process.stderr.write(`${line}\n`)),
    ...(io.env ? { env: io.env } : {}),
    ...(io.cwd ? { cwd: io.cwd } : {}),
    ...(io.methods ? { methods: io.methods } : {}),
    ...(io.extensions ? { extensions: io.extensions } : {}),
  })

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  input.on('line', (line) => {
    void server.handleLine(line)
  })

  await new Promise<void>((resolveClose) => {
    input.once('close', () => resolveClose())
  })

  await server.drain()
}
