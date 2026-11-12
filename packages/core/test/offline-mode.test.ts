// Offline Mode: the saved switch, what it lets through, the fetch guard, and the
// engine methods that must refuse an internet call before it is made.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertReachable,
  clearActivity,
  installNetworkGuard,
  isOfflineModeError,
  offlineState,
  OfflineModeError,
  privacyFile,
  recentActivity,
  saveOfflineSetting,
} from '../src/privacy/offline.js'
import { METHODS } from '../src/rpc/methods.js'
import { createMethodContext } from '../src/rpc/server.js'

// Names the variable without forcing it, so the saved setting decides. (The suite's
// config pins SKETCH_OFFLINE=0 for the process, which an injected env overrides.)
const OPEN: NodeJS.ProcessEnv = { SKETCH_OFFLINE: '' }

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sketch-offline-'))
  clearActivity()
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function ctx(env: NodeJS.ProcessEnv = OPEN) {
  return createMethodContext('offline-test', {
    writeFrame: () => {},
    writeErr: () => {},
    env,
    cwd: () => process.cwd(),
    secrets: new Set(),
  })
}

/** Swap the global fetch for a recorder while `body` runs. */
async function withFetch(body: (seen: string[]) => Promise<void>): Promise<void> {
  const original = globalThis.fetch
  const seen: string[] = []
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    seen.push(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url)
    return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    await body(seen)
  } finally {
    globalThis.fetch = original
  }
}

describe('the Offline Mode switch', () => {
  it('is off until saved, and the saved value is what the next read sees', async () => {
    expect(offlineState({ env: OPEN, home })).toMatchObject({ offline: false, source: 'default' })
    await saveOfflineSetting(true, { env: OPEN, home })
    expect(offlineState({ env: OPEN, home })).toMatchObject({ offline: true, source: 'setting', file: privacyFile(home) })
    expect(JSON.parse(await readFile(privacyFile(home), 'utf8'))).toMatchObject({ offline: true })
    await saveOfflineSetting(false, { env: OPEN, home })
    expect(offlineState({ env: OPEN, home }).offline).toBe(false)
  })

  it('counts a damaged settings file as ON', async () => {
    await mkdir(join(home, '.sketch'), { recursive: true })
    await writeFile(privacyFile(home), '{ not json', 'utf8')
    const state = offlineState({ env: OPEN, home })
    expect(state.offline).toBe(true)
    expect(state.error).toBeDefined()
  })

  it('lets SKETCH_OFFLINE force it either way', async () => {
    await saveOfflineSetting(true, { env: OPEN, home })
    expect(offlineState({ env: { SKETCH_OFFLINE: '0' }, home })).toMatchObject({ offline: false, source: 'environment' })
    await saveOfflineSetting(false, { env: OPEN, home })
    expect(offlineState({ env: { SKETCH_OFFLINE: '1' }, home })).toMatchObject({ offline: true, source: 'environment' })
  })
})

describe('what Offline Mode lets through', () => {
  const on = { offline: true, source: 'setting', file: 'x' } as const

  it('allows this machine and refuses everything else, naming only the origin', () => {
    for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:8080/v1']) {
      expect(() => assertReachable(url, on)).not.toThrow()
    }
    let caught: unknown
    try {
      assertReachable('https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSECRETSECRET', on, 'Google Gemini')
    } catch (err) {
      caught = err
    }
    expect(isOfflineModeError(caught)).toBe(true)
    const message = (caught as Error).message
    expect(message).toContain('https://generativelanguage.googleapis.com')
    expect(message).toContain('Google Gemini')
    expect(message).not.toContain('SECRET')
  })

  it('allows everything when off', () => {
    expect(() => assertReachable('https://api.openai.com/v1', { ...on, offline: false })).not.toThrow()
  })
})

describe('the network guard', () => {
  it('refuses non-local requests while on, passes local ones, and records origins only', async () => {
    await withFetch(async (seen) => {
      const remove = installNetworkGuard({ env: OPEN, home })
      try {
        await saveOfflineSetting(true, { env: OPEN, home })
        await expect(fetch('https://api.openai.com/v1/chat/completions?key=abc')).rejects.toBeInstanceOf(OfflineModeError)
        expect((await fetch('http://localhost:11434/api/tags')).status).toBe(200)
        expect(seen).toEqual(['http://localhost:11434/api/tags'])

        const recent = recentActivity(10)
        expect(recent[0]).toMatchObject({ origin: 'http://localhost:11434', outcome: 'sent', status: 200, local: true })
        expect(recent[1]).toMatchObject({ origin: 'https://api.openai.com', outcome: 'blocked', local: false })
        expect(JSON.stringify(recent)).not.toContain('key=abc')

        await saveOfflineSetting(false, { env: OPEN, home })
        await fetch('https://api.openai.com/v1/models')
        expect(seen).toContain('https://api.openai.com/v1/models')
      } finally {
        remove()
      }
    })
  })
})

describe('engine methods under Offline Mode', () => {
  const openai = { id: 'openai', kind: 'openai-compatible', baseUrl: '', model: 'gpt-4o-mini', apiKey: 'sk-test-00000000000000' }

  it('privacy-set saves the switch and privacy-status reports it', async () => {
    const saved = (await METHODS['privacy-set']!({ offline: true, home }, ctx())) as {
      offline: boolean
      source: string
      storage: { user: string }
    }
    expect(saved).toMatchObject({ offline: true, source: 'setting' })
    expect(saved.storage.user).toBe(join(home, '.sketch'))
    expect(await METHODS['privacy-status']!({ home }, ctx())).toMatchObject({ offline: true })
    await expect(METHODS['privacy-set']!({ offline: 'yes', home }, ctx())).rejects.toThrow(/true or false/)
  })

  it('refuses runs, tests, sign-ins and git sync before anything reaches the network', async () => {
    await saveOfflineSetting(true, { env: OPEN, home })
    await withFetch(async (seen) => {
      const run = METHODS.run!(
        { root: home, home, provider: openai, task: { id: 't', prompt: 'hello', verify: [] } },
        ctx(),
      )
      await expect(run).rejects.toThrow(/Offline Mode is on.*https:\/\/api\.openai\.com/)
      await expect(METHODS['provider-test']!({ home, provider: openai }, ctx())).rejects.toThrow(/Offline Mode is on/)
      await expect(METHODS['chatgpt-login-start']!({ home }, ctx())).rejects.toThrow(/Offline Mode is on/)
      await expect(METHODS['oauth-start']!({ home }, ctx())).rejects.toThrow(/Offline Mode is on/)
      await expect(METHODS['git-push']!({ home, root: home }, ctx())).rejects.toThrow(/Offline Mode is on.*git push/)
      expect(seen).toEqual([])
    })
  })

  it('still lets a model server on this computer through', async () => {
    await saveOfflineSetting(true, { env: OPEN, home })
    await withFetch(async (seen) => {
      const local = { id: 'ollama', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1' }
      await METHODS['provider-models']!({ home, provider: local }, ctx())
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every((url) => url.startsWith('http://127.0.0.1:11434/'))).toBe(true)
    })
  })

  it('changes nothing while it is off', async () => {
    await withFetch(async (seen) => {
      await METHODS['provider-models']!({ home, provider: { id: 'openai', kind: 'openai-compatible', baseUrl: '', apiKey: openai.apiKey } }, ctx())
      expect(seen.some((url) => url.startsWith('https://api.openai.com/'))).toBe(true)
    })
  })
})
