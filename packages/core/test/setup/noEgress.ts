// The core suite's no-egress tripwire, installed for EVERY core test file.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//
// "Nothing has ever run against a real provider" is the strongest claim this
// repository makes. Until this file existed the claim was CONVENTIONAL: it was
// asserted in HANDOFF.md, NEED-TO-DO.md, tasks.md and tasks-executed.md, and
// corroborated by every `.sketch/bench` artifact carrying a synthetic provider
// identity — but nothing structurally stopped a future test from constructing a
// real adapter with a real key and dialling out. `providers.fake.test.ts` puts a
// tripwire over one run, `verify-live.test.ts` refuses to probe anything but
// loopback, and the desktop has a source-level egress guard. None of those covers
// the core suite as a whole.
//
// Every other invariant in this project has a tripwire. This is that tripwire.
//
// ── WHAT IT REFUSES, AND WHAT IT MUST NOT ───────────────────────────────────
//
// Refused: any `fetch`, and any socket connect, whose destination host is not
// loopback. The refusal names the destination AND the test that attempted it,
// because "something in the suite tried to reach the internet" is not actionable.
//
// Allowed, deliberately and permanently:
//   * loopback — `127.0.0.0/8`, `::1`, `localhost` and `*.localhost`. The suite
//     depends on it: `verify-live.test.ts` starts real servers on ephemeral ports
//     and probes them, `providerSettings.test.ts` runs real `node:http` servers
//     and an Ollama-shaped stub, and the desktop dev bridge is loopback HTTP.
//   * non-network schemes (`data:`, `file:`, `blob:`) — no socket is opened.
//   * unix/named-pipe sockets — an IPC path is not egress.
//
// It is NOT a substitute for the mocked-`fetch` and injected-`fetchImpl` provider
// tests. Those exercise real HTTP request/response SHAPES against a fake
// transport, which is the only honest way to test an adapter offline. They keep
// working because replacing `global.fetch` replaces this wrapper too — a mocked
// fetch opens no socket, so there is nothing for a tripwire to catch.
//
// ── SCOPE ───────────────────────────────────────────────────────────────────
//
// This is an in-process guard for THIS process. A child process spawned by a test
// (`verify-live.test.ts` starts real `node -e` servers) has its own globals and is
// not covered; those children bind loopback only, and the containment that
// matters for them lives in `verify/runner.ts` and `command_policy.rs`.
//
// Validates: Requirements 2.7, 1.6, 20.4

import { expect } from 'vitest'
import { Socket } from 'node:net'

/** Every refusal starts with this, so a test can assert on the cause not the prose. */
export const NO_EGRESS_PREFIX = 'NO-EGRESS TRIPWIRE'

/**
 * Hosts the core suite may reach.
 *
 * `0.0.0.0` is NOT here. It is a bind address, not a destination, and on some
 * platforms connecting to it reaches a listener the test did not start.
 */
export function isLoopbackHost(host: string): boolean {
  const bare = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true
  if (bare.startsWith('::ffff:')) return isLoopbackHost(bare.slice('::ffff:'.length))
  // 127.0.0.0/8, all of it: 127.0.0.1 is the common case, not the only one.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
}

/** Schemes that open a socket. Anything else cannot be egress. */
const NETWORK_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:'])

/**
 * The destination of a `fetch` argument, or `null` when it cannot be determined.
 *
 * `null` means "let the real implementation deal with it" — an unparseable input
 * throws in `fetch` anyway, and guessing would be a second, wronger parser.
 */
export function fetchDestination(input: unknown): URL | null {
  const raw =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : typeof (input as { url?: unknown } | null)?.url === 'string'
          ? (input as { url: string }).url
          : null
  if (raw === null) return null
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

/** True when this URL would open a socket to somewhere other than loopback. */
export function isEgress(url: URL): boolean {
  if (!NETWORK_PROTOCOLS.has(url.protocol)) return false
  return !isLoopbackHost(url.hostname)
}

/**
 * A provider identity that is honestly synthetic.
 *
 * Both halves matter. A synthetic token must be present, AND no hosted-provider
 * name may be, so `openai-offline` is refused rather than waved through by the
 * first check.
 */
const SYNTHETIC_TOKENS = new Set(['synthetic', 'offline', 'fake', 'scripted', 'stub'])
const HOSTED_TOKENS = new Set([
  'openai',
  'anthropic',
  'claude',
  'gemini',
  'google',
  'groq',
  'azure',
  'bedrock',
  'mistral',
  'openrouter',
  'deepseek',
  'xai',
  'cohere',
])

export function isSyntheticProviderIdentity(provider: unknown): boolean {
  if (typeof provider !== 'string' || provider.trim() === '') return false
  const tokens = provider.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token !== '')
  if (tokens.some((token) => HOSTED_TOKENS.has(token))) return false
  return tokens.some((token) => SYNTHETIC_TOKENS.has(token))
}

/** The test that is running, for the refusal message. */
function attribution(): string {
  const name = expect.getState().currentTestName
  return typeof name === 'string' && name !== '' ? name : '(outside any test)'
}

function refuse(what: string): Error {
  return new Error(
    `${NO_EGRESS_PREFIX}: refused ${what} from test ${JSON.stringify(attribution())}. ` +
      'The core suite has never run against a real provider and must not open a socket to a ' +
      'non-loopback host. Use FakeChatAdapter, an injected fetchImpl, a mocked fetch, or a ' +
      'loopback stub. If a test genuinely needs a remote host, that is a finding to report, ' +
      'not a hole to punch in this guard.',
  )
}

// ── installation ────────────────────────────────────────────────────────────
//
// Idempotent: a setup file can be evaluated more than once in a worker (it is also
// imported directly by `no-egress.test.ts`), and wrapping a wrapper would report
// the same refusal twice and leave no way back to the real implementation.

const INSTALLED = Symbol.for('sketch.core.noEgressTripwire')
const marker = globalThis as unknown as Record<symbol, boolean | undefined>

if (marker[INSTALLED] !== true) {
  marker[INSTALLED] = true

  const realFetch = globalThis.fetch
  // Taken from the real signature rather than named: `RequestInfo` is not a global
  // under `lib: ES2022` plus `@types/node`, and inventing a narrower type here
  // would make the wrapper reject calls the real implementation accepts.
  type FetchArgs = Parameters<typeof globalThis.fetch>
  globalThis.fetch = function guardedFetch(input: FetchArgs[0], init?: FetchArgs[1]) {
    const url = fetchDestination(input)
    if (url !== null && isEgress(url)) throw refuse(`fetch to ${url.href}`)
    return realFetch(input, init)
  } as typeof fetch

  // The backstop. `fetch` is what core code uses, but a raw `node:http` request,
  // a WebSocket, or a bare socket would all bypass a fetch-only wrapper — and all
  // three end up here, including Node's own fetch implementation.
  const realConnect = Socket.prototype.connect
  type ConnectArgs = Parameters<typeof realConnect>
  Socket.prototype.connect = function guardedConnect(
    this: Socket,
    ...args: ConnectArgs
  ): Socket {
    const host = connectHost(args)
    if (host !== null && !isLoopbackHost(host)) {
      throw refuse(`socket connect to ${host}`)
    }
    return realConnect.apply(this, args) as Socket
  } as typeof realConnect
}

/**
 * The host a `Socket.connect` call is aimed at, or `null` when there is no host to
 * judge — an IPC path, or an omitted host, which Node resolves to localhost.
 */
function connectHost(args: readonly unknown[]): string | null {
  const first = args[0]
  // `net.connect(...)` and `http`'s agent do NOT call this method with the caller's
  // arguments: they normalise first and pass ONE array, `[options, listener]`. A
  // reader of the public signature would never guess that, and a guard that only
  // understood the public signature let every `node:http` request and Node's own
  // fetch implementation through while looking correct.
  if (Array.isArray(first)) return connectHost(first as readonly unknown[])
  if (typeof first === 'object' && first !== null) {
    const options = first as { host?: unknown; path?: unknown }
    if (typeof options.path === 'string') return null
    return typeof options.host === 'string' ? options.host : null
  }
  // (port, host?, listener?)
  const second = args[1]
  return typeof second === 'string' ? second : null
}
