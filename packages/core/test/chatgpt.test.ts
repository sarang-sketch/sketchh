// "Sign in with ChatGPT": the account sign-in, token renewal, the Codex-backend
// adapter, the model catalog and the RPC methods over them.
//
// Every network call goes to ONE fake server on 127.0.0.1 that plays both
// auth.openai.com and chatgpt.com/backend-api/codex — the no-egress tripwire fails
// anything else. The fake checks what the real servers require (S256 verifier,
// exact redirect_uri, form encoding, store:false, stream:true, the account header),
// so a test passing here means the request shape is the verified one.

import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CHATGPT_CLIENT_ID,
  accountClaims,
  cancelChatGPTLogin,
  chatgptAuthPath,
  chatgptAuthorizeUrl,
  chatgptEndpoints,
  chatgptLogout,
  chatgptStatus,
  generatePkce,
  getChatGPTAccess,
  readChatGPTCredential,
  startChatGPTBrowserLogin,
  startChatGPTDeviceLogin,
  waitChatGPTLogin,
  writeChatGPTCredential,
  type ChatGPTCredential,
} from '../src/settings/index.js'
import {
  CHATGPT_FALLBACK_MODELS,
  ChatGPTCodexAdapter,
  collectResponses,
  listChatGPTModels,
  readSse,
  resolveAdapter,
  toResponsesRequest,
} from '../src/providers/index.js'
import { METHODS, createMethodContext } from '../src/rpc/index.js'
import type { MethodContext } from '../src/rpc/index.js'

// ── fixtures ─────────────────────────────────────────────────────────────────

function jwt(payload: Record<string, unknown>): string {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${enc({ alg: 'none', typ: 'JWT' })}.${enc(payload)}.c2lnbmF0dXJl`
}

const ACCOUNT = 'acct_0123456789'
const nowSeconds = () => Math.floor(Date.now() / 1000)

function accessToken(tag: string, lifetimeSeconds = 3600): string {
  return jwt({ exp: nowSeconds() + lifetimeSeconds, tag, 'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT } })
}

function idToken(): string {
  return jwt({
    email: 'person@example.com',
    'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT, chatgpt_plan_type: 'plus' },
  })
}

interface Recorded {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: string
}

type Reply = { status: number; headers?: Record<string, string>; body: string }

interface Fake {
  base: string
  env: NodeJS.ProcessEnv
  calls: Recorded[]
  /** Override one route; return undefined to fall through to the default. */
  on: (fn: (req: Recorded) => Reply | undefined) => void
  /** The challenge the next authorization-code exchange must satisfy. */
  expect: { challenge?: string; redirectUri?: string }
  refreshToken: string
}

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()!
    server.closeAllConnections?.()
    await new Promise<void>((r) => server.close(() => r()))
  }
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-chatgpt-'))
  dirs.push(dir)
  return dir
}

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `event: ${String(e['type'])}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

function answer(text: string, usage = { input_tokens: 11, output_tokens: 3 }): string {
  return sse([
    { type: 'response.created', response: { id: 'resp_1' } },
    { type: 'response.output_text.delta', delta: text },
    { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } },
    { type: 'response.completed', response: { id: 'resp_1', usage } },
  ])
}

async function fake(): Promise<Fake> {
  let override: ((req: Recorded) => Reply | undefined) | undefined
  let rotation = 0
  let devicePolls = 0
  const state: Fake = {
    base: '',
    env: {},
    calls: [],
    on: (fn) => {
      override = fn
    },
    expect: {},
    refreshToken: 'rt_initial_0123456789',
  }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const rec: Recorded = { method: req.method ?? 'GET', path: url.pathname + url.search, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }
      state.calls.push(rec)
      const send = (reply: Reply) => {
        res.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.headers ?? {}) })
        res.end(reply.body)
      }
      const custom = override?.(rec)
      if (custom !== undefined) return send(custom)

      if (url.pathname === '/oauth/token') {
        const form = new URLSearchParams(rec.body)
        if (req.headers['content-type'] !== 'application/x-www-form-urlencoded') {
          return send({ status: 415, body: JSON.stringify({ error: 'invalid_request' }) })
        }
        if (form.get('client_id') !== CHATGPT_CLIENT_ID) return send({ status: 401, body: JSON.stringify({ error: 'invalid_client' }) })
        if (form.get('grant_type') === 'authorization_code') {
          const verifier = form.get('code_verifier') ?? ''
          const challenge = createHash('sha256').update(verifier).digest('base64url')
          const deviceGrant = form.get('code') === 'device-code'
          if (!deviceGrant && (challenge !== state.expect.challenge || form.get('redirect_uri') !== state.expect.redirectUri)) {
            return send({ status: 400, body: JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE or redirect mismatch' }) })
          }
          if (deviceGrant && (verifier !== 'device-verifier' || form.get('redirect_uri') !== `${state.base}/deviceauth/callback`)) {
            return send({ status: 400, body: JSON.stringify({ error: 'invalid_grant' }) })
          }
          return send({
            status: 200,
            body: JSON.stringify({ id_token: idToken(), access_token: accessToken('initial'), refresh_token: state.refreshToken, expires_in: 3600 }),
          })
        }
        if (form.get('grant_type') === 'refresh_token') {
          if (form.get('refresh_token') !== state.refreshToken) {
            return send({ status: 400, body: JSON.stringify({ error: { code: 'refresh_token_reused', message: 'already used' } }) })
          }
          rotation += 1
          state.refreshToken = `rt_rotated_${rotation}_0123456789`
          return send({
            status: 200,
            body: JSON.stringify({ id_token: idToken(), access_token: accessToken(`rotated-${rotation}`), refresh_token: state.refreshToken, expires_in: 3600 }),
          })
        }
        return send({ status: 400, body: JSON.stringify({ error: 'unsupported_grant_type' }) })
      }
      if (url.pathname === '/oauth/revoke') return send({ status: 200, body: '{}' })
      if (url.pathname === '/api/accounts/deviceauth/usercode') {
        return send({ status: 200, body: JSON.stringify({ device_auth_id: 'dev_1', user_code: 'ABCD-EFGH', interval: '1' }) })
      }
      if (url.pathname === '/api/accounts/deviceauth/token') {
        devicePolls += 1
        if (devicePolls < 2) return send({ status: 403, body: '{}' })
        return send({ status: 200, body: JSON.stringify({ authorization_code: 'device-code', code_challenge: 'x', code_verifier: 'device-verifier' }) })
      }
      if (url.pathname === '/codex/models') {
        return send({
          status: 200,
          body: JSON.stringify({
            models: [
              { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list', priority: 4, context_window: 272000 },
              { slug: 'secret-internal', display_name: 'Hidden', visibility: 'hide', priority: 0 },
              { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', priority: 1, description: 'Workhorse' },
            ],
          }),
        })
      }
      if (url.pathname === '/codex/responses') {
        return send({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: answer('OK') })
      }
      send({ status: 404, body: '{}' })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  servers.push(server)
  state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  state.env = { SKETCH_CHATGPT_ISSUER: state.base, SKETCH_CHATGPT_BASE_URL: `${state.base}/codex` }
  return state
}

async function signedIn(home: string, overrides: Partial<ChatGPTCredential> = {}): Promise<ChatGPTCredential> {
  const cred: ChatGPTCredential = {
    version: 1,
    accessToken: accessToken('stored'),
    refreshToken: 'rt_initial_0123456789',
    expiresAt: Date.now() + 3_600_000,
    accountId: ACCOUNT,
    email: 'person@example.com',
    plan: 'plus',
    createdAt: Date.now(),
    refreshedAt: Date.now(),
    ...overrides,
  }
  await writeChatGPTCredential(cred, { home })
  return cred
}

function ctxWith(env: NodeJS.ProcessEnv): MethodContext {
  return createMethodContext('test', {
    writeFrame: () => {},
    writeErr: () => {},
    env,
    cwd: () => process.cwd(),
    secrets: new Set<string>(),
  })
}

/** The error a promise rejects with; fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (err) {
    return err as Error
  }
  throw new Error('expected a rejection')
}

// ── claims, PKCE, authorize URL ──────────────────────────────────────────────

describe('what the tokens say', () => {
  it('reads the account id, email, plan and expiry, falling back like OpenCode and Cline', () => {
    const claims = accountClaims(idToken(), accessToken('a', 600))
    expect(claims.accountId).toBe(ACCOUNT)
    expect(claims.email).toBe('person@example.com')
    expect(claims.plan).toBe('plus')
    expect(claims.expiresAt).toBeGreaterThan(Date.now() + 500_000)

    expect(accountClaims(jwt({ organizations: [{ id: 'org_first' }] }), undefined).accountId).toBe('org_first')
    expect(accountClaims(jwt({ chatgpt_account_id: 'top_level' }), undefined).accountId).toBe('top_level')
    // `no_constraint` is the absence of a residency, not a residency.
    expect(accountClaims(undefined, jwt({ 'https://api.openai.com/auth': { chatgpt_compute_residency: 'no_constraint' } })).residency).toBeUndefined()
    expect(accountClaims(undefined, jwt({ 'https://api.openai.com/auth': { chatgpt_compute_residency: 'eu' } })).residency).toBe('eu')
    expect(accountClaims('not-a-jwt', undefined)).toEqual({})
  })

  it('builds the S256 pair and the authorize URL Codex builds', () => {
    const pkce = generatePkce()
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{86}$/)
    expect(pkce.challenge).toBe(createHash('sha256').update(pkce.verifier).digest('base64url'))

    const url = new URL(
      chatgptAuthorizeUrl({ redirectUri: 'http://localhost:1455/auth/callback', challenge: pkce.challenge, state: 'st' }),
    )
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      redirect_uri: 'http://localhost:1455/auth/callback',
      scope: 'openid profile email offline_access',
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      state: 'st',
      originator: 'sketch',
    })
  })

  it('only lets the environment point the endpoints at this machine', () => {
    expect(chatgptEndpoints({ SKETCH_CHATGPT_ISSUER: 'http://127.0.0.1:9/' }).issuer).toBe('http://127.0.0.1:9')
    const hostile = chatgptEndpoints({ SKETCH_CHATGPT_ISSUER: 'https://evil.example', SKETCH_CHATGPT_BASE_URL: 'https://evil.example/codex' })
    expect(hostile).toEqual({ issuer: 'https://auth.openai.com', codexBaseUrl: 'https://chatgpt.com/backend-api/codex' })
  })
})

// ── the browser sign-in ─────────────────────────────────────────────────────

describe('browser sign-in', () => {
  it('completes the loopback PKCE flow and stores the tokens where only the engine reads them', async () => {
    const server = await fake()
    const home = await tempHome()
    const started = await startChatGPTBrowserLogin({ home, env: server.env, ports: [0] })
    const authorize = new URL(started.authUrl)
    expect(authorize.origin).toBe(server.base)
    server.expect.challenge = authorize.searchParams.get('code_challenge')!
    server.expect.redirectUri = authorize.searchParams.get('redirect_uri')!
    expect(server.expect.redirectUri).toBe(`http://localhost:${started.port}/auth/callback`)

    // A response for a request Sketch did not make is refused and changes nothing.
    const callback = server.expect.redirectUri.replace('localhost', '127.0.0.1')
    const forged = await fetch(`${callback}?code=good-code&state=forged`)
    expect(forged.status).toBe(400)

    // The real redirect.
    const state = authorize.searchParams.get('state')!
    const browser = await fetch(`${callback}?code=good-code&state=${encodeURIComponent(state)}`)
    expect(browser.status).toBe(200)
    expect(await browser.text()).toContain('Signed in to ChatGPT')

    const outcome = await waitChatGPTLogin(started.id)
    expect(outcome).toEqual({ ok: true, account: { email: 'person@example.com', plan: 'plus' } })

    const stored = await readChatGPTCredential({ home })
    expect(stored?.refreshToken).toBe('rt_initial_0123456789')
    expect(stored?.accountId).toBe(ACCOUNT)
    const status = await chatgptStatus({ home })
    expect(status).toMatchObject({ signedIn: true, needsSignIn: false, email: 'person@example.com', plan: 'plus' })
    expect(JSON.stringify(status)).not.toContain('rt_initial')
    expect(chatgptAuthPath({ home })).toBe(join(home, '.sketch', 'auth', 'chatgpt.json'))
  })

  it('reports a denial from the consent page, and a cancel', async () => {
    const server = await fake()
    const home = await tempHome()
    const started = await startChatGPTBrowserLogin({ home, env: server.env, ports: [0] })
    const authorize = new URL(started.authUrl)
    const callback = authorize.searchParams.get('redirect_uri')!.replace('localhost', '127.0.0.1')
    const res = await fetch(`${callback}?error=access_denied&error_description=User%20cancelled&state=${authorize.searchParams.get('state')}`)
    expect(res.status).toBe(400)
    const outcome = await waitChatGPTLogin(started.id)
    expect(outcome).toMatchObject({ ok: false, code: 'denied' })
    expect(await readChatGPTCredential({ home })).toBeNull()

    const second = await startChatGPTBrowserLogin({ home, env: server.env, ports: [0] })
    expect(cancelChatGPTLogin(second.id)).toBe(true)
    expect(await waitChatGPTLogin(second.id)).toMatchObject({ ok: false, code: 'cancelled' })
  })

  it('says which program to close when every registered port is taken', async () => {
    const blocker = createServer(() => {})
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()))
    servers.push(blocker)
    const port = (blocker.address() as AddressInfo).port
    await expect(startChatGPTBrowserLogin({ home: await tempHome(), ports: [port] })).rejects.toMatchObject({ code: 'port-busy' })
  })
})

// ── the device-code sign-in ─────────────────────────────────────────────────

describe('code sign-in', () => {
  it('polls until approved, then exchanges with the device callback', async () => {
    const server = await fake()
    const home = await tempHome()
    const started = await startChatGPTDeviceLogin({ home, env: server.env, sleep: async () => {} })
    expect(started.userCode).toBe('ABCD-EFGH')
    expect(started.verificationUrl).toBe(`${server.base}/codex/device`)
    const outcome = await waitChatGPTLogin(started.id)
    expect(outcome).toMatchObject({ ok: true, account: { email: 'person@example.com' } })
    const polls = server.calls.filter((c) => c.path === '/api/accounts/deviceauth/token')
    expect(polls.length).toBe(2)
    expect(JSON.parse(polls[0]!.body)).toEqual({ device_auth_id: 'dev_1', user_code: 'ABCD-EFGH' })
    expect((await readChatGPTCredential({ home }))?.accountId).toBe(ACCOUNT)
  })

  it('names a disabled code sign-in instead of failing silently', async () => {
    const server = await fake()
    server.on((req) => (req.path === '/api/accounts/deviceauth/usercode' ? { status: 404, body: '{}' } : undefined))
    await expect(startChatGPTDeviceLogin({ home: await tempHome(), env: server.env })).rejects.toMatchObject({ code: 'device-disabled' })
  })
})

// ── renewal ──────────────────────────────────────────────────────────────────

describe('token renewal', () => {
  it('uses a fresh token as is, and renews one near expiry exactly once for concurrent callers', async () => {
    const server = await fake()
    const home = await tempHome()
    const stored = await signedIn(home)
    expect((await getChatGPTAccess({ home, env: server.env })).accessToken).toBe(stored.accessToken)
    expect(server.calls.length).toBe(0)

    await signedIn(home, { expiresAt: Date.now() + 60_000 })
    const all = await Promise.all(Array.from({ length: 5 }, () => getChatGPTAccess({ home, env: server.env })))
    const refreshes = server.calls.filter((c) => c.path === '/oauth/token')
    expect(refreshes.length).toBe(1)
    expect(new URLSearchParams(refreshes[0]!.body).get('grant_type')).toBe('refresh_token')
    expect(new Set(all.map((a) => a.accessToken)).size).toBe(1)
    // Rotation: the NEW refresh token is what is kept.
    expect((await readChatGPTCredential({ home }))?.refreshToken).toBe('rt_rotated_1_0123456789')
  })

  it('marks a permanently refused renewal so the UI asks for a new sign-in', async () => {
    const server = await fake()
    const home = await tempHome()
    await signedIn(home, { expiresAt: Date.now() - 1_000, refreshToken: 'rt_dead_0123456789' })
    await expect(getChatGPTAccess({ home, env: server.env })).rejects.toMatchObject({ code: 'reauth' })
    expect(await chatgptStatus({ home })).toMatchObject({ signedIn: false, needsSignIn: true })
    // And it does not keep spending requests on a dead token.
    const before = server.calls.length
    await expect(getChatGPTAccess({ home, env: server.env })).rejects.toMatchObject({ code: 'reauth' })
    expect(server.calls.length).toBe(before)
  })

  it('rides out a transient outage while the token is still valid, and reports it once it is not', async () => {
    const server = await fake()
    server.on((req) => (req.path === '/oauth/token' ? { status: 503, body: '{}' } : undefined))
    const home = await tempHome()
    const live = await signedIn(home, { expiresAt: Date.now() + 120_000 })
    expect((await getChatGPTAccess({ home, env: server.env })).accessToken).toBe(live.accessToken)
    await signedIn(home, { expiresAt: Date.now() - 1_000 })
    await expect(getChatGPTAccess({ home, env: server.env })).rejects.toMatchObject({ code: 'transient' })
  })
})

// Each Sketch window runs its own engine, and every engine reads the same
// ~/.sketch/auth/chatgpt.json. The refresh token rotates, so two renewals with one
// token end the sign-in, and a renewal that finishes after a sign-out undoes it.
describe('one sign-in, more than one engine', () => {
  const tokenCalls = (server: Fake) => server.calls.filter((c) => c.path === '/oauth/token').length

  it('a sign-out during a renewal stays signed out, and revokes the token the renewal produced', async () => {
    const server = await fake()
    const home = await tempHome()
    await signedIn(home, { expiresAt: Date.now() + 60_000 })
    let openGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => (openGate = resolve))
    let markStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => (markStarted = resolve))
    const slowTokenCall: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/oauth/token')) {
        markStarted()
        await gate
      }
      return fetch(input, init)
    }

    const renewal = getChatGPTAccess({ home, env: server.env, fetchImpl: slowTokenCall })
    await started
    const signOut = chatgptLogout({ home, env: server.env })
    await new Promise((resolve) => setTimeout(resolve, 200))
    // The sign-out waits for the renewal rather than revoking a token that is about to be replaced.
    expect(server.calls.some((c) => c.path === '/oauth/revoke')).toBe(false)
    openGate()
    await renewal

    expect(await signOut).toMatchObject({ signedOut: true, revoked: true })
    const revoke = server.calls.find((c) => c.path === '/oauth/revoke')
    expect(JSON.parse(revoke?.body ?? '{}').token).toBe('rt_rotated_1_0123456789')
    expect(await readChatGPTCredential({ home })).toBeNull()
    expect(await chatgptStatus({ home })).toMatchObject({ signedIn: false, needsSignIn: false })
  })

  it('waits for a renewal another engine is doing and uses its result, spending nothing', async () => {
    const server = await fake()
    const home = await tempHome()
    await signedIn(home, { expiresAt: Date.now() + 60_000 })
    const lock = `${chatgptAuthPath({ home })}.lock`
    // The parent process stands in for another engine that is alive and mid-renewal.
    await writeFile(lock, `${process.ppid} another-engine`)

    const pending = getChatGPTAccess({ home, env: server.env })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(tokenCalls(server)).toBe(0)

    const theirs = await signedIn(home, {
      accessToken: accessToken('another-engine'),
      refreshToken: 'rt_another_engine_0123456789',
      expiresAt: Date.now() + 3_600_000,
    })
    await rm(lock)
    expect((await pending).accessToken).toBe(theirs.accessToken)
    expect(tokenCalls(server)).toBe(0)
    expect(existsSync(lock)).toBe(false)
  })

  it('takes over a lock whose engine has exited, or one too old to still be in use', async () => {
    const server = await fake()
    const home = await tempHome()
    const lock = `${chatgptAuthPath({ home })}.lock`

    await signedIn(home, { expiresAt: Date.now() + 60_000 })
    const exited = spawnSync(process.execPath, ['-e', ''])
    await writeFile(lock, `${exited.pid} exited-engine`)
    let began = Date.now()
    expect((await getChatGPTAccess({ home, env: server.env })).accessToken).not.toBe(accessToken('stored'))
    expect(Date.now() - began).toBeLessThan(5_000)
    expect(tokenCalls(server)).toBe(1)
    expect(existsSync(lock)).toBe(false)

    await signedIn(home, { expiresAt: Date.now() + 60_000, refreshToken: server.refreshToken })
    await writeFile(lock, `${process.ppid} hung-engine`)
    const longAgo = new Date(Date.now() - 10 * 60_000)
    await utimes(lock, longAgo, longAgo)
    began = Date.now()
    await getChatGPTAccess({ home, env: server.env })
    expect(Date.now() - began).toBeLessThan(5_000)
    expect(tokenCalls(server)).toBe(2)
    expect(existsSync(lock)).toBe(false)

    // One naming this very engine is a leftover whose removal failed, not a holder.
    await signedIn(home, { expiresAt: Date.now() + 60_000, refreshToken: server.refreshToken })
    await writeFile(lock, `${process.pid} leftover`)
    began = Date.now()
    await getChatGPTAccess({ home, env: server.env })
    expect(Date.now() - began).toBeLessThan(5_000)
    expect(tokenCalls(server)).toBe(3)
    expect(existsSync(lock)).toBe(false)
  })

  it('keeps a sign-in that another engine renewed first instead of ending it', async () => {
    const server = await fake()
    const home = await tempHome()
    const path = chatgptAuthPath({ home })
    const ours = await signedIn(home, { expiresAt: Date.now() + 60_000, refreshToken: 'rt_spent_elsewhere_0123456789' })
    const theirs: ChatGPTCredential = {
      ...ours,
      accessToken: accessToken('renewed-elsewhere'),
      refreshToken: 'rt_renewed_elsewhere_0123456789',
      expiresAt: Date.now() + 3_600_000,
    }
    server.on((req) => {
      if (req.path !== '/oauth/token') return undefined
      // Another engine got there first and stored its result, so ours was already spent.
      writeFileSync(path, JSON.stringify(theirs))
      return { status: 400, body: JSON.stringify({ error: { code: 'refresh_token_reused', message: 'already used' } }) }
    })

    expect((await getChatGPTAccess({ home, env: server.env })).accessToken).toBe(theirs.accessToken)
    expect(await chatgptStatus({ home })).toMatchObject({ signedIn: true, needsSignIn: false })
    expect((await readChatGPTCredential({ home }))?.refreshToken).toBe(theirs.refreshToken)
  })
})

// ── the adapter ──────────────────────────────────────────────────────────────

describe('the ChatGPT adapter', () => {
  it('sends the request shape the Codex backend requires and returns the final answer', async () => {
    const server = await fake()
    const home = await tempHome()
    const cred = await signedIn(home)
    server.on((req) =>
      req.path === '/codex/responses'
        ? {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
            body: sse([
              { type: 'response.created', response: { id: 'r' } },
              { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Reading the files first.' }] } },
              { type: 'response.output_item.done', item: { type: 'reasoning', summary: [] } },
              { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"action":"done"}' }] } },
              { type: 'response.completed', response: { id: 'r', usage: { input_tokens: 120, output_tokens: 7 } } },
            ]),
          }
        : undefined,
    )
    const adapter = new ChatGPTCodexAdapter({ id: 'chatgpt', model: 'gpt-6.1-sol' }, { home, env: server.env })
    const reply = await adapter.chat([
      { role: 'system', content: 'You are Sketch.' },
      { role: 'system', content: 'Answer in JSON.' },
      { role: 'user', content: 'Fix the bug' },
      { role: 'assistant', content: '{"action":"read"}' },
      { role: 'system', content: 'Observation: file contents' },
      { role: 'user', content: '' },
    ])
    expect(reply).toEqual({ text: '{"action":"done"}', usage: { in: 120, out: 7 } })

    const call = server.calls.find((c) => c.path === '/codex/responses')!
    expect(call.headers['authorization']).toBe(`Bearer ${cred.accessToken}`)
    expect(call.headers['chatgpt-account-id']).toBe(ACCOUNT)
    expect(call.headers['originator']).toBe('sketch')
    expect(call.headers['accept']).toBe('text/event-stream')
    expect(call.headers['session-id']).toMatch(/^[0-9a-f-]{36}$/)
    const body = JSON.parse(call.body) as Record<string, unknown>
    expect(body).toMatchObject({ model: 'gpt-6.1-sol', store: false, stream: true, instructions: 'You are Sketch.\n\nAnswer in JSON.' })
    expect(body['input']).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the bug' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"action":"read"}' }] },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Observation: file contents' }] },
    ])
    for (const unsupported of ['max_output_tokens', 'max_completion_tokens', 'temperature', 'stop']) {
      expect(body).not.toHaveProperty(unsupported)
    }
  })

  it('renews once on a 401 and retries with the new token', async () => {
    const server = await fake()
    const home = await tempHome()
    const cred = await signedIn(home)
    let first = true
    server.on((req) => {
      if (req.path !== '/codex/responses') return undefined
      if (first) {
        first = false
        return { status: 401, body: JSON.stringify({ error: { message: 'token expired' } }) }
      }
      return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: answer('after renewal') }
    })
    const adapter = new ChatGPTCodexAdapter({ id: 'chatgpt', model: 'gpt-6-luna' }, { home, env: server.env })
    expect((await adapter.chat([{ role: 'user', content: 'hi' }])).text).toBe('after renewal')
    const responses = server.calls.filter((c) => c.path === '/codex/responses')
    expect(responses.length).toBe(2)
    expect(responses[1]!.headers['authorization']).not.toBe(`Bearer ${cred.accessToken}`)
    expect(server.calls.filter((c) => c.path === '/oauth/token').length).toBe(1)
  })

  it('explains a usage limit with its reset time and does not retry it', async () => {
    const server = await fake()
    const home = await tempHome()
    await signedIn(home)
    server.on((req) =>
      req.path === '/codex/responses'
        ? {
            status: 429,
            body: JSON.stringify({ error: { type: 'usage_limit_reached', plan_type: 'plus', resets_at: nowSeconds() + 600 } }),
          }
        : undefined,
    )
    const adapter = new ChatGPTCodexAdapter({ id: 'chatgpt', model: 'gpt-6-luna' }, { home, env: server.env })
    const error = await rejection(adapter.chat([{ role: 'user', content: 'hi' }]))
    expect(error.message).toMatch(/usage limit \(plus plan\)/)
    expect(error.message).toMatch(/resets in about (9|10) minutes/)
    expect(server.calls.filter((c) => c.path === '/codex/responses').length).toBe(1)
  })

  it('retries an overloaded backend, then succeeds', async () => {
    const server = await fake()
    const home = await tempHome()
    await signedIn(home)
    let attempts = 0
    server.on((req) => {
      if (req.path !== '/codex/responses') return undefined
      attempts += 1
      return attempts === 1
        ? { status: 503, body: '{}' }
        : { status: 200, headers: { 'content-type': 'text/event-stream' }, body: answer('recovered') }
    })
    const adapter = new ChatGPTCodexAdapter({ id: 'chatgpt', model: 'gpt-6-luna' }, { home, env: server.env, sleep: async () => {} })
    expect((await adapter.chat([{ role: 'user', content: 'hi' }])).text).toBe('recovered')
    expect(attempts).toBe(2)
  })

  it('turns an in-stream failure into a sentence, and never echoes a token', async () => {
    const server = await fake()
    const home = await tempHome()
    const cred = await signedIn(home)
    server.on((req) =>
      req.path === '/codex/responses'
        ? {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
            body: sse([{ type: 'response.failed', response: { error: { code: 'context_length_exceeded', message: 'too long' } } }]),
          }
        : undefined,
    )
    const adapter = new ChatGPTCodexAdapter({ id: 'chatgpt', model: 'gpt-6-luna' }, { home, env: server.env })
    await expect(adapter.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/longer than this model accepts/)

    server.on((req) =>
      req.path === '/codex/responses' ? { status: 400, body: JSON.stringify({ error: { message: `bad token ${cred.accessToken}` } }) } : undefined,
    )
    const echoed = await rejection(adapter.chat([{ role: 'user', content: 'hi' }]))
    expect(echoed.message).not.toContain(cred.accessToken)
    expect(echoed.message).toContain('«redacted»')
  })

  it('tells a signed-out user how to sign in', async () => {
    const adapter = new ChatGPTCodexAdapter({ id: 'chatgpt', model: 'gpt-6-luna' }, { home: await tempHome() })
    await expect(adapter.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/Sign in with ChatGPT/)
  })

  it('is what the registry resolves for the chatgpt id, whatever endpoint a config names', () => {
    const adapter = resolveAdapter({ id: 'chatgpt', kind: 'openai-compatible', baseUrl: 'https://evil.example/v1', model: 'gpt-6-luna' }, {})
    expect(adapter).toBeInstanceOf(ChatGPTCodexAdapter)
    expect(adapter.model).toBe('gpt-6-luna')
  })

  it('asks for the fastest reasoning when a caller wants a short answer', () => {
    expect(toResponsesRequest([{ role: 'user', content: 'x' }], 'm', 's', { maxTokens: 64 }).reasoning).toEqual({ effort: 'low' })
    expect(toResponsesRequest([{ role: 'user', content: 'x' }], 'm', 's').reasoning).toBeUndefined()
    expect(toResponsesRequest([{ role: 'user', content: 'x' }], 'm', 's').instructions).toBe('You are a helpful coding assistant.')
  })
})

describe('the event stream', () => {
  it('reassembles events split across arbitrary chunks and CRLF line endings', async () => {
    const text = answer('hello world').replace(/\n/g, '\r\n')
    const bytes = new TextEncoder().encode(text)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7))
        controller.close()
      },
    })
    expect(await collectResponses(readSse(stream))).toEqual({ text: 'hello world', usage: { in: 11, out: 3 } })
  })

  it('falls back to the streamed deltas, and refuses a stream that ended with nothing', async () => {
    const deltasOnly = sse([
      { type: 'response.output_text.delta', delta: 'par' },
      { type: 'response.output_text.delta', delta: 'tial' },
      { type: 'response.completed', response: {} },
    ])
    const toStream = (s: string) =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(s))
          c.close()
        },
      })
    expect((await collectResponses(readSse(toStream(deltasOnly)))).text).toBe('partial')
    await expect(collectResponses(readSse(toStream('')))).rejects.toThrow(/closed before an answer/)
  })

  it('gives up on a stream that goes silent', async () => {
    const stream = new ReadableStream<Uint8Array>({ start() {} })
    await expect(collectResponses(readSse(stream, 50))).rejects.toThrow(/no answer within/)
  })
})

// ── models ───────────────────────────────────────────────────────────────────

describe('ChatGPT models', () => {
  it('lists what the account offers, in Codex priority order, without hidden models', async () => {
    const server = await fake()
    const home = await tempHome()
    await signedIn(home)
    const result = await listChatGPTModels({ home, env: server.env })
    expect(result.source).toBe('live')
    expect(result.models.map((m) => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6-luna'])
    expect(result.defaultModel).toBe('gpt-6.1-sol')
    const call = server.calls.find((c) => c.path.startsWith('/codex/models'))!
    expect(call.path).toBe('/codex/models?client_version=0.155.0')
    expect(call.headers['chatgpt-account-id']).toBe(ACCOUNT)
  })

  it('falls back to the verified built-in list when the live one fails', async () => {
    const server = await fake()
    server.on((req) => (req.path.startsWith('/codex/models') ? { status: 500, body: 'oops' } : undefined))
    const home = await tempHome()
    await signedIn(home)
    const result = await listChatGPTModels({ home, env: server.env })
    expect(result.source).toBe('fallback')
    expect(result.models).toEqual([...CHATGPT_FALLBACK_MODELS])
    expect(result.defaultModel).toBe('gpt-6.1-sol')
  })
})

// ── the RPC surface ──────────────────────────────────────────────────────────

describe('chatgpt-* methods', () => {
  it('signs in, lists, tests, completes and signs out — and no answer carries a token', async () => {
    const server = await fake()
    const home = await tempHome()
    const ctx = ctxWith(server.env)
    const answers: unknown[] = []
    const call = async (method: string, params: Record<string, unknown>) => {
      const result = await METHODS[method]!(params, ctx)
      answers.push(result)
      return result as Record<string, unknown>
    }

    expect(await call('chatgpt-status', { home })).toMatchObject({ signedIn: false })
    const started = await call('chatgpt-login-start', { mode: 'device', home })
    expect(started).toMatchObject({ ok: true, mode: 'device', userCode: 'ABCD-EFGH' })
    expect(await call('chatgpt-login-wait', { id: started['id'] })).toMatchObject({ ok: true })
    expect(await call('chatgpt-status', { home })).toMatchObject({ signedIn: true, email: 'person@example.com', plan: 'plus' })

    const models = await call('chatgpt-models', { home })
    expect(models).toMatchObject({ ok: true, source: 'live', defaultModel: 'gpt-6.1-sol' })
    const listed = await call('provider-models', { provider: { id: 'chatgpt', kind: 'openai-compatible', baseUrl: '' }, home })
    expect(listed).toMatchObject({ ok: true, code: 'ok' })
    expect((listed['models'] as Array<{ id: string }>).map((m) => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6-luna'])

    const tested = await call('provider-test', {
      provider: { id: 'chatgpt', kind: 'openai-compatible', baseUrl: '', model: 'gpt-6.1-sol' },
      home,
    })
    expect(tested).toMatchObject({ ok: true, code: 'ok' })
    expect(String(tested['message'])).toContain('person@example.com')

    // The run path (`adapterFor`) honours `home` too: inline completion goes through it.
    const completion = await call('complete', {
      provider: { id: 'chatgpt', kind: 'openai-compatible', baseUrl: '', model: 'gpt-6.1-sol' },
      home,
      path: 'a.ts',
      prefix: 'const x = ',
      suffix: '',
    })
    expect(completion['model']).toBe('gpt-6.1-sol')

    expect(await call('chatgpt-logout', { home })).toEqual({ signedOut: true, revoked: true })
    expect(await call('chatgpt-status', { home })).toMatchObject({ signedIn: false, needsSignIn: false })
    const revoke = server.calls.find((c) => c.path === '/oauth/revoke')!
    expect(JSON.parse(revoke.body)).toMatchObject({ token_type_hint: 'refresh_token', client_id: CHATGPT_CLIENT_ID })

    const everything = JSON.stringify(answers)
    expect(everything).not.toMatch(/rt_initial|rt_rotated/)
    expect(everything).not.toContain('eyJ') // no JWT of any kind
  })

  it('keeps the exact entry the wizard saves, and lists ChatGPT first in the catalog', async () => {
    const home = await tempHome()
    const ctx = ctxWith({})
    const entry = { id: 'chatgpt', kind: 'openai-compatible', baseUrl: 'https://chatgpt.com/backend-api/codex', model: 'gpt-6.1-sol', label: 'ChatGPT' }
    const saved = (await METHODS['provider-config-save']!({ home, settings: { version: 1, providers: [entry], selected: 'chatgpt' } }, ctx)) as {
      settings: { providers: unknown[]; selected: string | null }
    }
    // The engine's whitelist is the authority on what is savable: nothing dropped.
    expect(saved.settings).toEqual({ version: 1, providers: [entry], selected: 'chatgpt' })
    const catalog = (await METHODS['provider-catalog']!({ home }, ctx)) as { catalog: Array<{ id: string; needsKey: boolean }>; settings: unknown }
    expect(catalog.catalog[0]).toMatchObject({ id: 'chatgpt', needsKey: false })
    expect(catalog.settings).toEqual({ version: 1, providers: [entry], selected: 'chatgpt' })
  })

  it('refuses an unknown sign-in mode by naming the parameter', async () => {
    const result = await METHODS['chatgpt-login-start']!({ mode: 'nope' }, ctxWith({})).catch((e: unknown) => e as Error)
    expect((result as Error).message).toMatch(/params.mode/)
  })

  it('writes the credential as versioned JSON in the auth folder', async () => {
    const home = await tempHome()
    await signedIn(home)
    const raw = await readFile(chatgptAuthPath({ home }), 'utf8')
    expect(JSON.parse(raw)).toMatchObject({ version: 1, accountId: ACCOUNT })
  })
})
