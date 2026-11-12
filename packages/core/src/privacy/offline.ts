// Offline Mode: one switch that keeps every engine request on this computer.
//
// ── WHAT IT IS ───────────────────────────────────────────────────────────────
//
// A saved setting (`~/.sketch/privacy.json`, `{ "offline": true }`) or the
// environment variable `SKETCH_OFFLINE=1`. While it is on, the engine refuses to
// open an HTTP request to any host that is not this machine (localhost, 127.x.x.x,
// ::1). Local model servers (Ollama, LM Studio, llama.cpp) keep working; OpenAI,
// Anthropic, ChatGPT sign-in, connection tests against internet providers,
// embedding fallbacks and MCP servers that need the network do not.
//
// ── TWO LAYERS, ON PURPOSE ───────────────────────────────────────────────────
//
//   1. Explicit checks where the engine knows what it is about to call (resolving a
//      provider for a run, a connection test, a sign-in, a git push). These fail
//      before any work starts, with a message that names the host and the fix.
//   2. A guard around the process's global `fetch` (`installNetworkGuard`), installed
//      by the engine's entry points. Every engine request goes through `fetch`, so
//      this catches a path the first layer missed, including future ones. It also
//      records each request (origin and outcome only, never the path or query, which
//      can carry keys) for the privacy view's network activity list.
//
// ── WHAT IT CANNOT SEE ───────────────────────────────────────────────────────
//
// Programs the engine starts are separate processes: the user's terminal, `git`,
// a project's own scripts, MCP servers. The guard cannot stop their sockets, so the
// engine refuses to START the ones whose job is the network (MCP servers that cost
// `net:http`, git push/pull/fetch/clone) and the privacy view says plainly that the
// terminal and project scripts are not covered.
//
// ── FAIL CLOSED ──────────────────────────────────────────────────────────────
//
// A settings file that exists but cannot be read or parsed counts as ON. A user who
// switched Offline Mode on must not be switched back online by a damaged file;
// saving the setting again rewrites it.

import { readFileSync, statSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isLoopbackUrl } from '../providers/http.js'

/** `1`/`true` forces Offline Mode on, `0`/`false` forces it off; anything else defers to the setting. */
export const OFFLINE_ENV = 'SKETCH_OFFLINE'

/** The settings file, under the user's home. */
export function privacyFile(home: string = homedir()): string {
  return join(home, '.sketch', 'privacy.json')
}

export interface OfflineState {
  offline: boolean
  /** What decided it: the environment variable, the saved setting, or the default (off). */
  source: 'environment' | 'setting' | 'default'
  /** The settings file consulted. */
  file: string
  /** Set when the file exists but could not be read; Offline Mode is then ON. */
  error?: string
}

export interface OfflineOptions {
  env?: NodeJS.ProcessEnv
  home?: string
}

let cached: { file: string; mtimeMs: number; size: number; state: OfflineState } | null = null

function parseFlag(value: string | undefined): boolean | undefined {
  const flag = (value ?? '').trim().toLowerCase()
  if (flag === '1' || flag === 'true') return true
  if (flag === '0' || flag === 'false') return false
  return undefined
}

function fromFile(file: string): OfflineState {
  let mtimeMs: number
  let size: number
  try {
    const stat = statSync(file)
    mtimeMs = stat.mtimeMs
    size = stat.size
  } catch {
    return { offline: false, source: 'default', file }
  }
  if (cached !== null && cached.file === file && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.state
  }
  let state: OfflineState
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const record = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
    if (record === null || typeof record['offline'] !== 'boolean') {
      state = { offline: true, source: 'setting', file, error: 'the file does not say "offline": true or false' }
    } else {
      state = { offline: record['offline'], source: 'setting', file }
    }
  } catch (err) {
    state = { offline: true, source: 'setting', file, error: err instanceof Error ? err.message : String(err) }
  }
  cached = { file, mtimeMs, size, state }
  return state
}

/** Whether Offline Mode is on right now. Cheap: one `stat`, and a read only when the file changed. */
export function offlineState(options: OfflineOptions = {}): OfflineState {
  const env = options.env ?? process.env
  const file = privacyFile(options.home)
  // `SKETCH_OFFLINE=1` on the engine process is a promise about the whole process,
  // so it holds even when a caller injected a narrower environment. Forcing OFF is
  // weaker: an injected environment that names the variable decides for itself.
  const own = parseFlag(process.env[OFFLINE_ENV])
  const injected = parseFlag(env[OFFLINE_ENV])
  if (own === true || injected === true) return { offline: true, source: 'environment', file }
  const forcedOff = OFFLINE_ENV in env ? injected === false : own === false
  if (forcedOff) return { offline: false, source: 'environment', file }
  return fromFile(file)
}

/** Save the switch. Written to a temporary file and renamed, so a crash cannot leave half a file. */
export async function saveOfflineSetting(offline: boolean, options: OfflineOptions = {}): Promise<OfflineState> {
  const file = privacyFile(options.home)
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  await writeFile(temp, `${JSON.stringify({ offline, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  await rename(temp, file)
  cached = null
  return offlineState(options)
}

/** `scheme://host[:port]` of a URL, which is all the activity list ever keeps. */
export function originOf(raw: string): string {
  try {
    const url = new URL(raw)
    // Non-web schemes (git://, ssh://) report the origin "null"; spell it out instead.
    return url.origin !== 'null' ? url.origin : `${url.protocol}//${url.host}`
  } catch {
    return '(not a URL)'
  }
}

/** The refusal. `code` lets a caller tell it from a network failure without parsing the text. */
export class OfflineModeError extends Error {
  readonly code = 'OFFLINE_MODE'
  readonly origin: string
  constructor(target: string, what?: string) {
    const origin = originOf(target)
    super(
      `Offline Mode is on, so Sketch did not contact ${origin}${what !== undefined ? ` (${what})` : ''}. ` +
        'Use a model on this computer (Ollama, LM Studio or llama.cpp), or turn Offline Mode off in Settings → Privacy.',
    )
    this.name = 'OfflineModeError'
    this.origin = origin
  }
}

export function isOfflineModeError(err: unknown): err is OfflineModeError {
  return err instanceof Error && (err as { code?: unknown }).code === 'OFFLINE_MODE'
}

/** Throw {@link OfflineModeError} when Offline Mode is on and `url` is not on this machine. */
export function assertReachable(url: string, state: OfflineState, what?: string): void {
  if (state.offline && !isLoopbackUrl(url)) throw new OfflineModeError(url, what)
}

// ── network activity ─────────────────────────────────────────────────────────

export interface NetworkActivity {
  /** Epoch milliseconds. */
  at: number
  method: string
  /** `scheme://host[:port]` only. */
  origin: string
  /** True for this machine. */
  local: boolean
  outcome: 'sent' | 'blocked' | 'failed'
  /** HTTP status, when an answer came back. */
  status?: number
}

const ACTIVITY_LIMIT = 200
const activity: NetworkActivity[] = []

export function recordActivity(entry: NetworkActivity): void {
  activity.push(entry)
  if (activity.length > ACTIVITY_LIMIT) activity.splice(0, activity.length - ACTIVITY_LIMIT)
}

/** Newest first. */
export function recentActivity(limit = 50): NetworkActivity[] {
  return activity.slice(-Math.max(0, limit)).reverse()
}

/** Tests only: forget what was recorded. */
export function clearActivity(): void {
  activity.length = 0
}

// ── the fetch guard ──────────────────────────────────────────────────────────

const GUARD_KEY = Symbol.for('sketch.networkGuard')

type GuardHolder = { [GUARD_KEY]?: { original: typeof fetch; guarded: typeof fetch } }

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return (input as Request).url
}

function requestMethod(input: Parameters<typeof fetch>[0], init?: RequestInit): string {
  const method = init?.method ?? (typeof input === 'object' && !(input instanceof URL) ? (input as Request).method : undefined)
  return (method ?? 'GET').toUpperCase()
}

/** Whether the guard is in place in this process. */
export function networkGuardInstalled(): boolean {
  const holder = globalThis as GuardHolder
  return holder[GUARD_KEY] !== undefined && globalThis.fetch === holder[GUARD_KEY]!.guarded
}

/**
 * Wrap the global `fetch` so Offline Mode holds for every request this process makes,
 * and so each request is recorded. Idempotent. Returns a function that removes it.
 */
export function installNetworkGuard(options: OfflineOptions = {}): () => void {
  const holder = globalThis as GuardHolder
  const original = globalThis.fetch
  if (typeof original !== 'function') return () => {}
  if (holder[GUARD_KEY] !== undefined) return () => {}

  const guarded: typeof fetch = async (input, init) => {
    const url = requestUrl(input)
    const base = { at: Date.now(), method: requestMethod(input, init), origin: originOf(url), local: isLoopbackUrl(url) }
    if (!base.local && offlineState(options).offline) {
      recordActivity({ ...base, outcome: 'blocked' })
      throw new OfflineModeError(url)
    }
    try {
      const response = await original(input, init)
      recordActivity({ ...base, outcome: 'sent', status: response.status })
      return response
    } catch (err) {
      recordActivity({ ...base, outcome: 'failed' })
      throw err
    }
  }

  holder[GUARD_KEY] = { original, guarded }
  globalThis.fetch = guarded
  return () => {
    if (globalThis.fetch === guarded) globalThis.fetch = original
    delete holder[GUARD_KEY]
  }
}
