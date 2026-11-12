// "Sign in with ChatGPT" — use a ChatGPT plan (Free, Go, Plus, Pro, Business, Edu,
// Enterprise) as the model, with no API key.
//
// This is the same account sign-in OpenAI's own Codex CLI performs, and the same one
// OpenCode and Cline ship. Every constant below was read from those sources, not
// guessed:
//
//   * openai/codex  codex-rs/login/src/server.rs, oauth/*.rs, auth/manager.rs,
//                   device_code_auth.rs, token_data.rs, auth/revoke.rs
//   * OpenCode      packages/opencode/src/plugin/openai/codex.ts
//   * Cline         sdk/packages/core/src/auth/codex.ts
//
// THE FLOW (RFC 8252 loopback + PKCE):
//   1. a listener on http://localhost:1455/auth/callback (1457 when 1455 is busy —
//      both are registered redirect URIs for this client);
//   2. the user's own browser opens auth.openai.com/oauth/authorize with an S256
//      challenge and a random `state`;
//   3. the callback brings a one-time `code`; it is exchanged, with the verifier,
//      for an access token, a refresh token and an id token;
//   4. the account id the ChatGPT backend wants in `ChatGPT-Account-Id` is read
//      from the id token's claims.
//
// A device-code variant (enter a short code at auth.openai.com/codex/device) covers
// a machine where neither port can be bound.
//
// ── WHERE THE TOKENS LIVE, AND WHY HERE ─────────────────────────────────────
// OpenAI ROTATES refresh tokens: every refresh returns a new one and the old one is
// dead ("refresh_token_reused"). A token that has to make a round trip through the
// window to reach the OS credential store after every refresh is a token that gets
// lost the first time that round trip fails — and a lost refresh token means
// signing in again. So the engine, which performs the refresh, also keeps the
// result: `~/.sketch/auth/chatgpt.json`, owner-only permissions, written atomically,
// one refresh at a time per file. That is the layout Codex itself uses
// (`~/.codex/auth.json`) and the one OpenCode uses.
//
// What never happens: a token in a frame, an event, a log line, providers.json, or
// the desktop window. `chatgptStatus` reports an email and a plan name, nothing more.

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { isLoopbackUrl, sleepFor } from '../providers/http.js'
import { redact } from '../providers/redact.js'
import { renderCallbackPage } from './oauthLoopback.js'

// ── constants (verified, see header) ─────────────────────────────────────────

export const CHATGPT_PROVIDER_ID = 'chatgpt'
/** The public OAuth client id of OpenAI's Codex CLI. Not a secret. */
export const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CHATGPT_ISSUER = 'https://auth.openai.com'
/** The ChatGPT backend that serves Codex models to a signed-in account. */
export const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
/** Registered callback ports, in order of preference. */
export const CHATGPT_CALLBACK_PORTS: readonly number[] = [1455, 1457]
export const CHATGPT_CALLBACK_PATH = '/auth/callback'
/** Who is calling, as the `originator` parameter/header. OpenCode sends "opencode", Cline "cline". */
export const CHATGPT_ORIGINATOR = 'sketch'
const SCOPE = 'openid profile email offline_access'
const AUTH_CLAIMS = 'https://api.openai.com/auth'
const PROFILE_CLAIMS = 'https://api.openai.com/profile'

/** Refresh this long before the access token's own expiry (Codex uses five minutes). */
export const REFRESH_WINDOW_MS = 5 * 60_000
/** When neither `expires_in` nor a JWT `exp` says otherwise. */
const DEFAULT_ACCESS_LIFETIME_MS = 60 * 60_000
const TOKEN_HTTP_TIMEOUT_MS = 30_000
const REVOKE_HTTP_TIMEOUT_MS = 10_000
const BROWSER_LOGIN_TIMEOUT_MS = 10 * 60_000
const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60_000
const FINISHED_RETENTION_MS = 2 * 60_000

// ── errors ───────────────────────────────────────────────────────────────────

export type ChatGPTAuthCode =
  | 'signed-out'
  | 'reauth'
  | 'transient'
  | 'port-busy'
  | 'device-disabled'
  | 'cancelled'
  | 'timeout'
  | 'denied'
  | 'state-mismatch'
  | 'exchange-failed'
  | 'unknown-session'

/** Every message is written for the person reading it and carries no token. */
export class ChatGPTAuthError extends Error {
  readonly code: ChatGPTAuthCode
  constructor(code: ChatGPTAuthCode, message: string) {
    super(message)
    this.name = 'ChatGPTAuthError'
    this.code = code
  }
}

const SIGN_IN_HINT = 'Open Settings → Models and choose “Sign in with ChatGPT”.'

// ── endpoints (overridable for tests, loopback only) ─────────────────────────

export interface ChatGPTEndpoints {
  issuer: string
  codexBaseUrl: string
}

/**
 * The real endpoints, unless the environment points them at THIS machine — which
 * is how the tests and the end-to-end driver stand in a fake auth server and a fake
 * backend. An override to any other host is ignored: an environment variable must
 * not be able to send someone's ChatGPT tokens to a third party.
 */
export function chatgptEndpoints(env: NodeJS.ProcessEnv = process.env): ChatGPTEndpoints {
  const pick = (value: string | undefined, fallback: string) =>
    typeof value === 'string' && value.trim() !== '' && isLoopbackUrl(value.trim())
      ? value.trim().replace(/\/+$/, '')
      : fallback
  return {
    issuer: pick(env['SKETCH_CHATGPT_ISSUER'], CHATGPT_ISSUER),
    codexBaseUrl: pick(env['SKETCH_CHATGPT_BASE_URL'], CHATGPT_CODEX_BASE_URL),
  }
}

// ── JWT claims ───────────────────────────────────────────────────────────────

/** The payload of a JWT, unverified — it only ever describes OUR OWN token. */
export function decodeJwtClaims(token: string | undefined): Record<string, unknown> | null {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3 || parts[1] === undefined || parts[1] === '') return null
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    const value = JSON.parse(json) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export interface ChatGPTAccountClaims {
  accountId?: string
  email?: string
  plan?: string
  /** Data-residency constraint for the backend, when the workspace has one. */
  residency?: string
  /** Access-token expiry, epoch ms, from its `exp`. */
  expiresAt?: number
}

/**
 * What the tokens say about the account. The id token is authoritative for the
 * account; the access token fills gaps. The account id falls back the way OpenCode
 * and Cline fall back: the namespaced claim, a top-level claim, the first
 * organization.
 */
export function accountClaims(idToken: string | undefined, accessToken: string | undefined): ChatGPTAccountClaims {
  const id = decodeJwtClaims(idToken)
  const access = decodeJwtClaims(accessToken)
  const out: ChatGPTAccountClaims = {}
  for (const claims of [id, access]) {
    if (claims === null) continue
    const auth = asRecord(claims[AUTH_CLAIMS])
    const profile = asRecord(claims[PROFILE_CLAIMS])
    const orgs = Array.isArray(claims['organizations']) ? (claims['organizations'] as unknown[]) : []
    out.accountId ??=
      nonEmpty(auth?.['chatgpt_account_id']) ?? nonEmpty(claims['chatgpt_account_id']) ?? nonEmpty(asRecord(orgs[0])?.['id'])
    out.email ??= nonEmpty(claims['email']) ?? nonEmpty(profile?.['email'])
    out.plan ??= nonEmpty(auth?.['chatgpt_plan_type'])
    const residency = nonEmpty(auth?.['chatgpt_compute_residency']) ?? nonEmpty(claims['chatgpt_compute_residency'])
    if (residency !== undefined && residency !== 'no_constraint') out.residency ??= residency
  }
  const exp = access?.['exp']
  if (typeof exp === 'number' && Number.isFinite(exp) && exp > 0) out.expiresAt = exp * 1000
  return out
}

// ── the stored credential ────────────────────────────────────────────────────

export interface ChatGPTCredential {
  version: 1
  accessToken: string
  refreshToken: string
  /** Epoch ms after which the access token is no longer accepted. */
  expiresAt: number
  accountId: string
  email?: string
  plan?: string
  residency?: string
  createdAt: number
  refreshedAt: number
  /** Set after the auth server PERMANENTLY refused the refresh token. */
  reauthRequired?: boolean
}

export interface ChatGPTStoreOptions {
  /** Home directory the store lives under. Defaults to the OS home. */
  home?: string
  /** The store file itself, overriding `home`. */
  path?: string
}

/** `~/.sketch/auth/chatgpt.json`. */
export function chatgptAuthPath(options: ChatGPTStoreOptions = {}): string {
  return options.path ?? join(options.home ?? homedir(), '.sketch', 'auth', 'chatgpt.json')
}

function parseCredential(text: string): ChatGPTCredential | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  const record = asRecord(value)
  if (record === undefined || record['version'] !== 1) return null
  const accessToken = nonEmpty(record['accessToken'])
  const refreshToken = nonEmpty(record['refreshToken'])
  const accountId = nonEmpty(record['accountId'])
  const expiresAt = record['expiresAt']
  if (accessToken === undefined || refreshToken === undefined || accountId === undefined) return null
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null
  const cred: ChatGPTCredential = {
    version: 1,
    accessToken,
    refreshToken,
    accountId,
    expiresAt,
    createdAt: typeof record['createdAt'] === 'number' ? record['createdAt'] : 0,
    refreshedAt: typeof record['refreshedAt'] === 'number' ? record['refreshedAt'] : 0,
  }
  const email = nonEmpty(record['email'])
  const plan = nonEmpty(record['plan'])
  const residency = nonEmpty(record['residency'])
  if (email !== undefined) cred.email = email
  if (plan !== undefined) cred.plan = plan
  if (residency !== undefined) cred.residency = residency
  if (record['reauthRequired'] === true) cred.reauthRequired = true
  return cred
}

/** The stored credential, or null when there is none (or it is unreadable). */
export async function readChatGPTCredential(options: ChatGPTStoreOptions = {}): Promise<ChatGPTCredential | null> {
  try {
    return parseCredential(await readFile(chatgptAuthPath(options), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Write atomically (temp file + rename), owner-only. A crash mid-write leaves the
 * previous credential intact rather than half a JSON document — which matters more
 * than usual here, because the previous file may hold the only live refresh token.
 */
export async function writeChatGPTCredential(cred: ChatGPTCredential, options: ChatGPTStoreOptions = {}): Promise<void> {
  const path = chatgptAuthPath(options)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temp, `${JSON.stringify(cred, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  // Windows can refuse a rename for a moment while a scanner holds the target open.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temp, path)
      break
    } catch (err) {
      if (attempt >= 4) {
        await rm(temp, { force: true }).catch(() => {})
        throw err
      }
      await sleepFor(50 * (attempt + 1))
    }
  }
  await chmod(path, 0o600).catch(() => {})
}

export async function deleteChatGPTCredential(options: ChatGPTStoreOptions = {}): Promise<boolean> {
  const path = chatgptAuthPath(options)
  const existed = (await readChatGPTCredential(options)) !== null
  await rm(path, { force: true })
  return existed
}

// ── token endpoint ───────────────────────────────────────────────────────────

interface TokenResponse {
  access_token?: unknown
  refresh_token?: unknown
  id_token?: unknown
  expires_in?: unknown
}

interface TokenCallOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** A POST to the token endpoint. NEVER retried: a retry can spend a one-time code or a rotating token. */
async function tokenPost(
  url: string,
  body: URLSearchParams,
  options: TokenCallOptions,
): Promise<{ status: number; json: unknown; text: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TOKEN_HTTP_TIMEOUT_MS)
  try {
    const res = await (options.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      signal: controller.signal,
    })
    const text = await res.text().catch(() => '')
    let json: unknown = null
    try {
      json = text === '' ? null : JSON.parse(text)
    } catch {
      json = null
    }
    return { status: res.status, json, text }
  } finally {
    clearTimeout(timer)
  }
}

/** The error code an auth server put in its body, in either OAuth or OpenAI shape. */
function errorCodeOf(json: unknown): string | undefined {
  const record = asRecord(json)
  if (record === undefined) return undefined
  const error = record['error']
  if (typeof error === 'string') return error
  const nested = asRecord(error)
  return nonEmpty(nested?.['code']) ?? nonEmpty(nested?.['type'])
}

function errorMessageOf(json: unknown, fallback: string): string {
  const record = asRecord(json)
  const nested = asRecord(record?.['error'])
  return nonEmpty(record?.['error_description']) ?? nonEmpty(nested?.['message']) ?? fallback
}

function credentialFrom(tokens: TokenResponse, now: number, previous?: ChatGPTCredential): ChatGPTCredential {
  const accessToken = nonEmpty(tokens.access_token)
  if (accessToken === undefined) throw new ChatGPTAuthError('exchange-failed', 'ChatGPT answered without an access token. Try signing in again.')
  const refreshToken = nonEmpty(tokens.refresh_token) ?? previous?.refreshToken
  if (refreshToken === undefined) throw new ChatGPTAuthError('exchange-failed', 'ChatGPT answered without a refresh token. Try signing in again.')
  const idToken = nonEmpty(tokens.id_token)
  const claims = accountClaims(idToken, accessToken)
  const accountId = claims.accountId ?? previous?.accountId
  if (accountId === undefined) {
    throw new ChatGPTAuthError(
      'exchange-failed',
      'Signed in, but the ChatGPT account id was missing from the sign-in. Try again, or pick a different workspace on the sign-in page.',
    )
  }
  const expiresIn = typeof tokens.expires_in === 'number' && tokens.expires_in > 0 ? tokens.expires_in * 1000 : undefined
  const cred: ChatGPTCredential = {
    version: 1,
    accessToken,
    refreshToken,
    accountId,
    expiresAt: claims.expiresAt ?? (expiresIn !== undefined ? now + expiresIn : now + DEFAULT_ACCESS_LIFETIME_MS),
    createdAt: previous?.createdAt ?? now,
    refreshedAt: now,
  }
  const email = claims.email ?? previous?.email
  const plan = claims.plan ?? previous?.plan
  const residency = claims.residency ?? previous?.residency
  if (email !== undefined) cred.email = email
  if (plan !== undefined) cred.plan = plan
  if (residency !== undefined) cred.residency = residency
  return cred
}

/** Exchange a one-time authorization code for tokens. */
export async function exchangeChatGPTCode(
  params: { code: string; verifier: string; redirectUri: string; endpoints?: ChatGPTEndpoints; now?: () => number } & TokenCallOptions,
): Promise<ChatGPTCredential> {
  const endpoints = params.endpoints ?? chatgptEndpoints()
  const secrets = [params.code, params.verifier]
  let answer: { status: number; json: unknown; text: string }
  try {
    answer = await tokenPost(
      `${endpoints.issuer}/oauth/token`,
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CHATGPT_CLIENT_ID,
        code: params.code,
        redirect_uri: params.redirectUri,
        code_verifier: params.verifier,
      }),
      params,
    )
  } catch (err) {
    throw new ChatGPTAuthError(
      'exchange-failed',
      redact(`Could not reach auth.openai.com to finish signing in (${err instanceof Error ? err.message : String(err)}).`, secrets),
    )
  }
  if (answer.status < 200 || answer.status >= 300) {
    throw new ChatGPTAuthError(
      'exchange-failed',
      redact(`ChatGPT did not accept the sign-in (HTTP ${answer.status}: ${errorMessageOf(answer.json, 'no detail')}). Start again.`, secrets),
    )
  }
  return credentialFrom((asRecord(answer.json) ?? {}) as TokenResponse, (params.now ?? Date.now)())
}

const PERMANENT_REFRESH_CODES = new Set([
  'invalid_grant',
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
])

/** Trade the refresh token for new tokens. Throws `reauth` for a permanent refusal. */
async function refreshCredential(
  cred: ChatGPTCredential,
  endpoints: ChatGPTEndpoints,
  now: number,
  options: TokenCallOptions,
): Promise<ChatGPTCredential> {
  const secrets = [cred.refreshToken, cred.accessToken]
  let answer: { status: number; json: unknown; text: string }
  try {
    answer = await tokenPost(
      `${endpoints.issuer}/oauth/token`,
      new URLSearchParams({ grant_type: 'refresh_token', client_id: CHATGPT_CLIENT_ID, refresh_token: cred.refreshToken }),
      options,
    )
  } catch (err) {
    throw new ChatGPTAuthError(
      'transient',
      redact(`Could not reach auth.openai.com to renew the ChatGPT sign-in (${err instanceof Error ? err.message : String(err)}). Check your connection.`, secrets),
    )
  }
  if (answer.status >= 200 && answer.status < 300) {
    return credentialFrom((asRecord(answer.json) ?? {}) as TokenResponse, now, cred)
  }
  const code = errorCodeOf(answer.json)?.toLowerCase()
  const permanent = answer.status === 401 || (code !== undefined && PERMANENT_REFRESH_CODES.has(code))
  if (permanent) {
    const why =
      code === 'refresh_token_reused'
        ? 'it was already used by another sign-in'
        : code === 'refresh_token_expired'
          ? 'it has expired'
          : code === 'refresh_token_invalidated'
            ? 'it was revoked'
            : 'it is no longer valid'
    throw new ChatGPTAuthError('reauth', `Your ChatGPT sign-in could not be renewed because ${why}. ${SIGN_IN_HINT}`)
  }
  throw new ChatGPTAuthError(
    'transient',
    redact(`ChatGPT could not renew the sign-in right now (HTTP ${answer.status}). Try again in a moment.`, secrets),
  )
}

// ── a valid access token, one refresh at a time ──────────────────────────────

export interface ChatGPTAccess {
  accessToken: string
  accountId: string
  residency?: string
  plan?: string
}

export interface ChatGPTAccessOptions extends ChatGPTStoreOptions, TokenCallOptions {
  env?: NodeJS.ProcessEnv
  now?: () => number
  /** Refresh even if the token looks fresh — the backend just said 401. */
  forceRefresh?: boolean
  /**
   * The access token that was just refused. When the store already holds a
   * DIFFERENT one, another caller refreshed in the meantime and that one is used,
   * instead of spending the rotating refresh token a second time.
   */
  staleAccessToken?: string
}

/**
 * One holder at a time per credential file. A plain "share the refresh in flight"
 * is not enough: callers that resume together after it would each read the file
 * and could each start a refresh. The fast path inside the lock is one small file
 * read, so serializing it costs nothing measurable.
 */
const locks = new Map<string, Promise<void>>()

/** One key per file, however the path was spelled (Windows paths are case-insensitive). */
function lockKey(path: string): string {
  const full = resolve(path)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = lockKey(path)
  const previous = locks.get(key) ?? Promise.resolve()
  let release: () => void = () => {}
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const chained = previous.then(() => current)
  locks.set(key, chained)
  await previous
  try {
    return await fn()
  } finally {
    release()
    if (locks.get(key) === chained) locks.delete(key)
  }
}

/** Longer than anything done while holding the lock file: one token call and one write. */
const LOCK_STALE_MS = TOKEN_HTTP_TIMEOUT_MS + 15_000

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists, it is just not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** An abandoned lock: its engine has exited, or it is older than any holder could need. */
async function lockAbandoned(lockPath: string): Promise<boolean> {
  let modified: number
  try {
    modified = (await stat(lockPath)).mtimeMs
  } catch {
    return false // already gone: the next attempt takes it
  }
  if (Date.now() - modified > LOCK_STALE_MS) return true
  const text = await readFile(lockPath, 'utf8').catch(() => '')
  const pid = Number.parseInt(text.split(' ')[0] ?? '', 10)
  // This engine holds no lock file while it waits for one (its own callers queue in
  // withFileLock first), so one naming it is a leftover whose removal failed — an
  // antivirus scanner holding the file open for a moment, say.
  if (pid === process.pid) return true
  // An empty file is a lock being written this instant, not an abandoned one.
  return Number.isInteger(pid) && pid > 0 && !processAlive(pid)
}

/**
 * Hold `<credential>.lock` while `fn` runs. Each Sketch window runs its own engine,
 * and two engines renewing at once would spend the same rotating refresh token —
 * ending the sign-in for both — while a renewal that finished after a sign-out in
 * another window would sign the person back in. {@link withFileLock} orders the
 * callers inside one engine; this orders the engines.
 *
 * A lock whose engine has exited, or that has outlived anything a holder does, is
 * taken over instead of waited on. Where no lock file can be made at all (a
 * read-only home), the work goes ahead as it would have without one.
 */
async function withLockFile<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`
  const mine = `${process.pid} ${randomBytes(8).toString('hex')}`
  let held = false
  try {
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
    const deadline = Date.now() + LOCK_STALE_MS + 5_000
    while (!held && Date.now() < deadline) {
      try {
        await writeFile(lockPath, mine, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        held = true
        break
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        // EPERM/EBUSY: Windows, while another engine's lock is being deleted.
        if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EBUSY') break
      }
      if (await lockAbandoned(lockPath)) {
        await rm(lockPath, { force: true }).catch(() => {})
        await sleepFor(5)
      } else {
        await sleepFor(25 + Math.floor(Math.random() * 50))
      }
    }
  } catch {
    // The folder could not be made: carry on unlocked.
  }
  try {
    return await fn()
  } finally {
    if (held) {
      // Remove it only while it is still ours; a takeover may have replaced it.
      // Windows can refuse the delete for a moment while a scanner has it open.
      for (let attempt = 0; attempt < 5; attempt++) {
        const current = await readFile(lockPath, 'utf8').catch(() => '')
        if (current !== mine) break
        try {
          await rm(lockPath, { force: true })
          break
        } catch {
          await sleepFor(20 * (attempt + 1))
        }
      }
    }
  }
}

/** Changes to the store — a renewal, a new sign-in, a sign-out — happen one at a time, everywhere. */
function exclusive<T>(path: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(path, () => withLockFile(path, fn))
}

/** Store a new sign-in, after any renewal in flight (which would otherwise overwrite it). */
async function storeCredential(cred: ChatGPTCredential, options: ChatGPTStoreOptions): Promise<void> {
  const path = chatgptAuthPath(options)
  await exclusive(path, () => writeChatGPTCredential(cred, { path }))
}

function toAccess(cred: ChatGPTCredential): ChatGPTAccess {
  return {
    accessToken: cred.accessToken,
    accountId: cred.accountId,
    ...(cred.residency !== undefined ? { residency: cred.residency } : {}),
    ...(cred.plan !== undefined ? { plan: cred.plan } : {}),
  }
}

/** Hand out what the store holds, or say that it needs renewing first. */
function assess(
  cred: ChatGPTCredential | null,
  options: ChatGPTAccessOptions,
  now: number,
  refusedToken: string | undefined,
): { access: ChatGPTAccess } | { renew: ChatGPTCredential } {
  if (cred === null) throw new ChatGPTAuthError('signed-out', `Not signed in to ChatGPT. ${SIGN_IN_HINT}`)
  if (cred.reauthRequired === true) {
    throw new ChatGPTAuthError('reauth', `Your ChatGPT sign-in has ended. ${SIGN_IN_HINT}`)
  }
  if (options.forceRefresh === true) {
    // The backend refused `refusedToken`. A different one in the store means someone
    // renewed in the meantime, and spending the refresh token again would be wasted.
    return refusedToken !== undefined && refusedToken !== cred.accessToken ? { access: toAccess(cred) } : { renew: cred }
  }
  return cred.expiresAt - now > REFRESH_WINDOW_MS ? { access: toAccess(cred) } : { renew: cred }
}

/**
 * A usable access token for the signed-in account, refreshing it first when it is
 * within {@link REFRESH_WINDOW_MS} of expiry. Concurrent callers — in this engine
 * or in another window's — share a single refresh: two refreshes with one rotating
 * token would log the user out.
 */
export async function getChatGPTAccess(options: ChatGPTAccessOptions = {}): Promise<ChatGPTAccess> {
  const path = chatgptAuthPath(options)
  const clock = options.now ?? Date.now
  return withFileLock(path, async () => {
    const seen = await readChatGPTCredential({ path })
    const first = assess(seen, options, clock(), options.staleAccessToken)
    if ('access' in first) return first.access
    // Renewing spends the rotating refresh token, so it happens under the lock the
    // other engines take as well, and from what the file says once that lock is
    // held: one of them may have renewed while this one waited.
    return withLockFile(path, async () => {
      const now = clock()
      const again = assess(await readChatGPTCredential({ path }), options, now, options.staleAccessToken ?? seen?.accessToken)
      if ('access' in again) return again.access
      return renew(again.renew, path, options, now)
    })
  })
}

async function renew(cred: ChatGPTCredential, path: string, options: ChatGPTAccessOptions, now: number): Promise<ChatGPTAccess> {
  try {
    const fresh = await refreshCredential(cred, chatgptEndpoints(options.env), now, options)
    await writeChatGPTCredential(fresh, { path })
    return toAccess(fresh)
  } catch (err) {
    if (err instanceof ChatGPTAuthError && err.code === 'reauth') {
      // "Already used" can also mean an engine outside the lock renewed first (one
      // whose lock was judged abandoned). If the store now holds a different refresh
      // token, that sign-in is alive: use it rather than ending it.
      const latest = await readChatGPTCredential({ path })
      if (latest !== null && latest.refreshToken !== cred.refreshToken) {
        if (latest.reauthRequired !== true) return toAccess(latest)
      } else if (latest !== null) {
        await writeChatGPTCredential({ ...latest, reauthRequired: true }, { path }).catch(() => {})
      }
    }
    // A transient failure with a token that has not actually expired yet is not
    // worth failing a run over: use it, and let the next call try again.
    if (err instanceof ChatGPTAuthError && err.code === 'transient' && cred.expiresAt - now > 30_000) {
      return toAccess(cred)
    }
    throw err
  }
}

// ── status and sign-out ──────────────────────────────────────────────────────

export interface ChatGPTStatus {
  signedIn: boolean
  /** Signed in once, but the sign-in has ended and must be repeated. */
  needsSignIn: boolean
  email?: string
  plan?: string
  /** Where the credential file lives, for the "where is my login stored" question. */
  path: string
}

/** What the window may know: whether, as whom, on which plan. Never a token. */
export async function chatgptStatus(options: ChatGPTStoreOptions = {}): Promise<ChatGPTStatus> {
  const path = chatgptAuthPath(options)
  const cred = await readChatGPTCredential({ path })
  if (cred === null) return { signedIn: false, needsSignIn: false, path }
  return {
    signedIn: cred.reauthRequired !== true,
    needsSignIn: cred.reauthRequired === true,
    ...(cred.email !== undefined ? { email: cred.email } : {}),
    ...(cred.plan !== undefined ? { plan: cred.plan } : {}),
    path,
  }
}

/**
 * Sign out: revoke the refresh token at OpenAI (best effort, like Codex), then
 * delete the local file whatever the revoke said. Under the same locks as a
 * renewal: one that finished after this would write a fresh token back, and the
 * person would still be signed in.
 */
export async function chatgptLogout(
  options: ChatGPTStoreOptions & TokenCallOptions & { env?: NodeJS.ProcessEnv } = {},
): Promise<{ signedOut: boolean; revoked: boolean }> {
  const path = chatgptAuthPath(options)
  if ((await readChatGPTCredential({ path })) === null) {
    // Nothing to revoke, and no lock worth creating a folder for.
    return { signedOut: await deleteChatGPTCredential({ path }), revoked: false }
  }
  return exclusive(path, async () => {
    const cred = await readChatGPTCredential({ path })
    let revoked = false
    if (cred !== null) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REVOKE_HTTP_TIMEOUT_MS)
      try {
        const res = await (options.fetchImpl ?? fetch)(`${chatgptEndpoints(options.env).issuer}/oauth/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: cred.refreshToken, token_type_hint: 'refresh_token', client_id: CHATGPT_CLIENT_ID }),
          signal: controller.signal,
        })
        await res.text().catch(() => '')
        revoked = res.ok
      } catch {
        revoked = false
      } finally {
        clearTimeout(timer)
      }
    }
    const signedOut = await deleteChatGPTCredential({ path })
    return { signedOut, revoked }
  })
}

// ── PKCE ─────────────────────────────────────────────────────────────────────

export interface Pkce {
  verifier: string
  challenge: string
}

/** 64 random bytes, base64url (86 characters), S256 — exactly as Codex generates it. */
export function generatePkce(): Pkce {
  const verifier = randomBytes(64).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function chatgptAuthorizeUrl(params: {
  redirectUri: string
  challenge: string
  state: string
  endpoints?: ChatGPTEndpoints
}): string {
  const endpoints = params.endpoints ?? chatgptEndpoints()
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CHATGPT_CLIENT_ID,
    redirect_uri: params.redirectUri,
    scope: SCOPE,
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state: params.state,
    originator: CHATGPT_ORIGINATOR,
  })
  return `${endpoints.issuer}/oauth/authorize?${query.toString()}`
}

// ── sign-in sessions ─────────────────────────────────────────────────────────

export interface ChatGPTAccountSummary {
  email?: string
  plan?: string
}

export type ChatGPTLoginOutcome =
  | { ok: true; account: ChatGPTAccountSummary }
  | { ok: false; code: ChatGPTAuthCode; error: string }

interface LoginSession {
  id: string
  settled: Promise<ChatGPTLoginOutcome>
  settle: (outcome: ChatGPTLoginOutcome) => void
  close: () => void
}

const sessions = new Map<string, LoginSession>()
const finished = new Map<string, Promise<ChatGPTLoginOutcome>>()

function newSession(): { session: LoginSession; isDone: () => boolean } {
  const id = randomBytes(12).toString('hex')
  let done = false
  let settle: (outcome: ChatGPTLoginOutcome) => void = () => {}
  const settled = new Promise<ChatGPTLoginOutcome>((resolve) => {
    settle = (outcome) => {
      if (done) return
      done = true
      resolve(outcome)
    }
  })
  const session: LoginSession = { id, settled, settle: (o) => settle(o), close: () => {} }
  return { session, isDone: () => done }
}

function retire(session: LoginSession): void {
  session.close()
  sessions.delete(session.id)
  finished.set(session.id, session.settled)
  const expiry = setTimeout(() => finished.delete(session.id), FINISHED_RETENTION_MS)
  expiry.unref?.()
}

/** Only one sign-in at a time: a new one supersedes whatever was waiting. */
function supersedeAll(): void {
  for (const session of [...sessions.values()]) {
    session.settle({ ok: false, code: 'cancelled', error: 'superseded by a newer sign-in' })
    retire(session)
  }
}

function summaryOf(cred: ChatGPTCredential): ChatGPTAccountSummary {
  return {
    ...(cred.email !== undefined ? { email: cred.email } : {}),
    ...(cred.plan !== undefined ? { plan: cred.plan } : {}),
  }
}

function failure(err: unknown, fallback: ChatGPTAuthCode = 'exchange-failed'): ChatGPTLoginOutcome {
  if (err instanceof ChatGPTAuthError) return { ok: false, code: err.code, error: err.message }
  return { ok: false, code: fallback, error: err instanceof Error ? err.message : String(err) }
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

function closeServer(server: Server): void {
  server.closeAllConnections?.()
  server.close()
}

export interface ChatGPTLoginOptions extends ChatGPTStoreOptions, TokenCallOptions {
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  /** Ports to try, for tests. Defaults to the registered {@link CHATGPT_CALLBACK_PORTS}. */
  ports?: readonly number[]
  now?: () => number
}

export interface ChatGPTBrowserLogin {
  id: string
  /** Open this in the user's own browser. */
  authUrl: string
  redirectUri: string
  port: number
  expiresAt: number
}

/**
 * Start a browser sign-in: bind the callback, build the authorize URL. The caller
 * opens the URL; {@link waitChatGPTLogin} reports the outcome.
 */
export async function startChatGPTBrowserLogin(options: ChatGPTLoginOptions = {}): Promise<ChatGPTBrowserLogin> {
  supersedeAll()
  const endpoints = chatgptEndpoints(options.env)
  const now = options.now ?? Date.now
  const pkce = generatePkce()
  const state = randomBytes(32).toString('base64url')
  const { session, isDone } = newSession()

  let redirectUri = ''
  let handled = false
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method !== 'GET' || url.pathname !== CHATGPT_CALLBACK_PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end('Not found')
      return
    }
    const page = (status: number, title: string, body: string) => {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        'Referrer-Policy': 'no-referrer',
      })
      res.end(renderCallbackPage(title, body))
    }
    if (handled || isDone()) {
      page(409, 'Already handled', 'This sign-in has already finished. You can close this tab.')
      return
    }
    // State FIRST: a code or an error from a request we did not start is not ours.
    if (url.searchParams.get('state') !== state) {
      page(400, 'Sign-in did not complete', 'The sign-in response did not match the request Sketch made. Start again from Sketch.')
      return
    }
    handled = true
    const error = url.searchParams.get('error')
    if (error !== null) {
      const description = url.searchParams.get('error_description') ?? error
      page(400, 'Sign-in did not complete', escapeHtml(description))
      session.settle({ ok: false, code: 'denied', error: `ChatGPT sign-in was not completed: ${description}` })
      setTimeout(() => retire(session), 250).unref?.()
      return
    }
    const code = url.searchParams.get('code')
    if (code === null || code.trim() === '') {
      page(400, 'Sign-in did not complete', 'ChatGPT did not return a sign-in code.')
      session.settle({ ok: false, code: 'exchange-failed', error: 'ChatGPT did not return a sign-in code.' })
      setTimeout(() => retire(session), 250).unref?.()
      return
    }
    // Exchange BEFORE answering, so the tab shows the real result.
    exchangeChatGPTCode({ code: code.trim(), verifier: pkce.verifier, redirectUri, endpoints, now, ...pick(options) })
      .then(async (cred) => {
        await storeCredential(cred, options)
        const who = cred.email !== undefined ? ` as ${escapeHtml(cred.email)}` : ''
        page(200, 'Signed in to ChatGPT', `Sketch is connected${who}. You can close this tab and return to Sketch.`)
        session.settle({ ok: true, account: summaryOf(cred) })
      })
      .catch((err: unknown) => {
        const outcome = failure(err)
        page(400, 'Sign-in did not complete', escapeHtml(outcome.ok ? '' : outcome.error))
        session.settle(outcome)
      })
      .finally(() => {
        setTimeout(() => retire(session), 250).unref?.()
      })
  }

  // The registered redirect names `localhost`, which a browser may resolve to
  // either loopback address — answer on both, never on a LAN interface.
  const servers: Server[] = []
  let port = 0
  for (const candidate of options.ports ?? CHATGPT_CALLBACK_PORTS) {
    const primary = createServer(handler)
    try {
      port = await listen(primary, '127.0.0.1', candidate)
    } catch {
      closeServer(primary)
      continue
    }
    servers.push(primary)
    const secondary = createServer(handler)
    try {
      await listen(secondary, '::1', port)
      servers.push(secondary)
    } catch {
      closeServer(secondary)
    }
    break
  }
  if (servers.length === 0) {
    throw new ChatGPTAuthError(
      'port-busy',
      `Another program is using the sign-in ports (${(options.ports ?? CHATGPT_CALLBACK_PORTS).join(', ')}) — often another Codex or Cline sign-in. Close it and try again, or sign in with a code instead.`,
    )
  }
  redirectUri = `http://localhost:${port}${CHATGPT_CALLBACK_PATH}`

  const timeoutMs = Math.max(5_000, options.timeoutMs ?? BROWSER_LOGIN_TIMEOUT_MS)
  const timer = setTimeout(() => {
    session.settle({ ok: false, code: 'timeout', error: 'The ChatGPT sign-in was not completed in time. Start again.' })
    retire(session)
  }, timeoutMs)
  timer.unref?.()
  session.close = () => {
    clearTimeout(timer)
    for (const server of servers) closeServer(server)
  }
  sessions.set(session.id, session)

  return {
    id: session.id,
    authUrl: chatgptAuthorizeUrl({ redirectUri, challenge: pkce.challenge, state, endpoints }),
    redirectUri,
    port,
    expiresAt: now() + timeoutMs,
  }
}

export interface ChatGPTDeviceLogin {
  id: string
  /** The page where the user types the code. */
  verificationUrl: string
  /** The one-time code to type. Short-lived and useless without the user's own sign-in. */
  userCode: string
  expiresAt: number
}

/**
 * Start a device-code sign-in: no local port at all. The user opens
 * auth.openai.com/codex/device in any browser and types the code shown.
 */
export async function startChatGPTDeviceLogin(
  options: ChatGPTLoginOptions & { sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {},
): Promise<ChatGPTDeviceLogin> {
  supersedeAll()
  const endpoints = chatgptEndpoints(options.env)
  const now = options.now ?? Date.now
  const doFetch = options.fetchImpl ?? fetch
  const api = `${endpoints.issuer}/api/accounts`

  let res: Response
  try {
    res = await fetchBounded(
      doFetch,
      `${api}/deviceauth/usercode`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ client_id: CHATGPT_CLIENT_ID }),
      },
      TOKEN_HTTP_TIMEOUT_MS,
    )
  } catch (err) {
    throw new ChatGPTAuthError(
      'transient',
      `Could not reach auth.openai.com to start a code sign-in (${err instanceof Error ? err.message : String(err)}).`,
    )
  }
  const text = await res.text().catch(() => '')
  if (res.status === 404) {
    throw new ChatGPTAuthError(
      'device-disabled',
      'Code sign-in is not available for this account. Use “Sign in with ChatGPT” in the browser instead.',
    )
  }
  if (!res.ok) {
    throw new ChatGPTAuthError('transient', `ChatGPT could not start a code sign-in (HTTP ${res.status}). Try again.`)
  }
  let body: Record<string, unknown> | undefined
  try {
    body = asRecord(JSON.parse(text))
  } catch {
    body = undefined
  }
  const deviceAuthId = nonEmpty(body?.['device_auth_id'])
  const userCode = nonEmpty(body?.['user_code']) ?? nonEmpty(body?.['usercode'])
  if (deviceAuthId === undefined || userCode === undefined) {
    throw new ChatGPTAuthError('transient', 'ChatGPT answered the code sign-in without a code. Try again.')
  }
  const intervalSeconds = Number.parseInt(String(body?.['interval'] ?? '5'), 10)
  const intervalMs = Math.max(1, Number.isFinite(intervalSeconds) ? intervalSeconds : 5) * 1000

  const { session } = newSession()
  const controller = new AbortController()
  const timeoutMs = Math.max(5_000, options.timeoutMs ?? DEVICE_LOGIN_TIMEOUT_MS)
  const deadline = now() + timeoutMs
  const sleep = options.sleep ?? sleepFor
  session.close = () => controller.abort()
  sessions.set(session.id, session)

  // Poll until the user approves, the code expires, or someone cancels.
  void (async () => {
    try {
      while (!controller.signal.aborted) {
        if (now() >= deadline) {
          session.settle({ ok: false, code: 'timeout', error: 'The sign-in code expired before it was used. Start again.' })
          return
        }
        await sleep(intervalMs, controller.signal)
        let poll: Response
        try {
          poll = await fetchBounded(
            doFetch,
            `${api}/deviceauth/token`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
            },
            TOKEN_HTTP_TIMEOUT_MS,
            controller.signal,
          )
        } catch (err) {
          if (controller.signal.aborted) throw err
          continue // a dropped poll is not a refusal; ask again on the next tick
        }
        const pollText = await poll.text().catch(() => '')
        if (poll.status === 403 || poll.status === 404) continue // not approved yet
        if (!poll.ok) {
          session.settle({ ok: false, code: 'exchange-failed', error: `ChatGPT refused the code sign-in (HTTP ${poll.status}).` })
          return
        }
        let granted: Record<string, unknown> | undefined
        try {
          granted = asRecord(JSON.parse(pollText))
        } catch {
          granted = undefined
        }
        const code = nonEmpty(granted?.['authorization_code'])
        const verifier = nonEmpty(granted?.['code_verifier'])
        if (code === undefined || verifier === undefined) {
          session.settle({ ok: false, code: 'exchange-failed', error: 'ChatGPT approved the code but sent no sign-in. Try again.' })
          return
        }
        const cred = await exchangeChatGPTCode({
          code,
          verifier,
          redirectUri: `${endpoints.issuer}/deviceauth/callback`,
          endpoints,
          now,
          ...pick(options),
        })
        await storeCredential(cred, options)
        session.settle({ ok: true, account: summaryOf(cred) })
        return
      }
    } catch (err) {
      if (controller.signal.aborted) {
        session.settle({ ok: false, code: 'cancelled', error: 'cancelled' })
      } else {
        session.settle(failure(err, 'transient'))
      }
    } finally {
      if (sessions.get(session.id) === session) retire(session)
    }
  })()

  return {
    id: session.id,
    verificationUrl: `${endpoints.issuer}/codex/device`,
    userCode,
    expiresAt: deadline,
  }
}

/** Wait for a sign-in to finish. Resolves once; a finished session reports why. */
export async function waitChatGPTLogin(id: string): Promise<ChatGPTLoginOutcome> {
  const session = sessions.get(id)
  if (session !== undefined) return session.settled
  const done = finished.get(id)
  if (done !== undefined) return done
  return { ok: false, code: 'unknown-session', error: 'No ChatGPT sign-in is waiting under that id.' }
}

/** Abandon a sign-in. Idempotent. */
export function cancelChatGPTLogin(id: string): boolean {
  const session = sessions.get(id)
  if (session === undefined) return false
  session.settle({ ok: false, code: 'cancelled', error: 'cancelled' })
  retire(session)
  return true
}

/** Sign-ins currently waiting. For tests and diagnostics. */
export function openChatGPTLoginCount(): number {
  return sessions.size
}

/**
 * The token-call options a sign-in passes on. ONLY the fetch: a sign-in's own
 * `timeoutMs` is how long the person has to finish, not how long one HTTP call may take.
 */
function pick(options: { fetchImpl?: typeof fetch }): TokenCallOptions {
  return options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}
}

/** One request with its own ceiling that also ends when `outer` aborts. */
async function fetchBounded(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  outer?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (outer?.aborted) controller.abort()
  outer?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await doFetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', onAbort)
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
  )
}
