// The repo-wide no-egress guard, tested against real sockets.
//
// Two claims are structural here, not conventional:
//
//   1. NO core test can reach a non-loopback host. The tripwire in
//      `test/setup/noEgress.ts` runs for every core test file (wired in
//      `vitest.config.ts`, and that wiring is asserted below so it cannot be
//      quietly dropped). Loopback stays open, because the suite genuinely needs
//      it — real servers on ephemeral ports, the Ollama-shaped stub on 11434, the
//      dev bridge.
//   2. Every `.sketch/bench` artifact on this machine names a SYNTHETIC provider
//      identity. The docs say no benchmark has ever run against a real provider;
//      the day someone runs one, this fails instead of the claim going stale.
//
// The servers here are real `node:http` servers on 127.0.0.1 and the refusals are
// real refusals — nothing in this file is mocked, and no assertion depends on a
// remote host being reachable or unreachable.
//
// Validates: Requirements 2.7, 1.6, 20.4

import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  NO_EGRESS_PREFIX,
  fetchDestination,
  isEgress,
  isLoopbackHost,
  isSyntheticProviderIdentity,
} from './setup/noEgress.js'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..', '..')

const servers: Server[] = []
const tmpDirs: string[] = []

afterEach(() => {
  while (servers.length) servers.pop()!.close()
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

/** A real HTTP server on loopback. Returns its origin. */
async function loopbackServer(body = 'ok'): Promise<{ origin: string; port: number }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(body)
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { origin: `http://127.0.0.1:${address.port}`, port: address.port }
}

// ── 1. the tripwire refuses egress ──────────────────────────────────────────

describe('the core suite cannot reach a non-loopback host', () => {
  it('refuses a fetch to a real provider endpoint, naming the URL and the test', () => {
    // The exact call a future test would write if it decided to "just try it once"
    // with a key. It never leaves the process.
    let thrown: unknown
    try {
      void fetch('https://api.openai.com/v1/chat/completions', { method: 'POST' })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message).toContain(NO_EGRESS_PREFIX)
    // Actionable: which destination, and which test. The second assertion is this
    // test's own title, which is how the refusal names the caller.
    expect(message).toContain('https://api.openai.com/v1/chat/completions')
    expect(message).toContain('refuses a fetch to a real provider endpoint')
  })

  it('refuses http, https and a bare IP alike', () => {
    for (const url of [
      'http://example.com/',
      'https://example.com/',
      'https://93.184.216.34/',
      'http://api.anthropic.com:8080/v1/messages',
    ]) {
      expect(() => void fetch(url), url).toThrow(NO_EGRESS_PREFIX)
    }
  })

  it('refuses a raw socket to a remote host, so a non-fetch client cannot slip past', () => {
    expect(() => connect({ host: 'example.com', port: 443 })).toThrow(NO_EGRESS_PREFIX)
    expect(() => connect(443, 'api.openai.com')).toThrow(NO_EGRESS_PREFIX)
  })
})

// ── 2. loopback stays open ──────────────────────────────────────────────────

describe('loopback is untouched', () => {
  it('fetches a real loopback server and reads its body', async () => {
    const { origin } = await loopbackServer('offline stub')

    const response = await fetch(`${origin}/v1/models`)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('offline stub')
  })

  it('opens a real socket to a loopback listener', async () => {
    const { port } = await loopbackServer()

    const socket = connect({ host: '127.0.0.1', port })
    await new Promise<void>((done, fail) => {
      socket.once('connect', () => done())
      socket.once('error', fail)
    })
    socket.destroy()

    expect(socket.destroyed).toBe(true)
  })

  it('classifies every loopback spelling the suite actually uses as loopback', () => {
    for (const host of [
      '127.0.0.1',
      '127.0.0.53',
      'localhost',
      'LOCALHOST',
      'sketch.localhost',
      '::1',
      '[::1]',
      '::ffff:127.0.0.1',
    ]) {
      expect(isLoopbackHost(host), host).toBe(true)
    }
  })

  it('does not mistake a lookalike host for loopback', () => {
    for (const host of [
      'localhost.example.com',
      '127.0.0.1.example.com',
      'notlocalhost',
      '0.0.0.0',
      '10.0.0.1',
      '::2',
      'example.com',
    ]) {
      expect(isLoopbackHost(host), host).toBe(false)
    }
  })

  it('leaves non-socket schemes alone, because they are not egress', () => {
    expect(isEgress(new URL('data:text/plain,hello'))).toBe(false)
    expect(isEgress(new URL('file:///etc/hosts'))).toBe(false)
    expect(isEgress(new URL('ws://example.com/'))).toBe(true)
  })

  it('reads the destination out of every shape fetch accepts', () => {
    expect(fetchDestination('https://example.com/x')?.href).toBe('https://example.com/x')
    expect(fetchDestination(new URL('http://127.0.0.1:1/'))?.href).toBe('http://127.0.0.1:1/')
    expect(fetchDestination({ url: 'https://example.com/req' })?.href).toBe(
      'https://example.com/req',
    )
    // Unparseable: the real implementation's problem, not a guess to make here.
    expect(fetchDestination('/relative')).toBeNull()
    expect(fetchDestination(42)).toBeNull()
  })
})

// ── 3. the guard is wired for the whole suite ───────────────────────────────

describe('the tripwire is installed suite-wide', () => {
  it('is named as a setup file in vitest.config.ts', () => {
    const config = readFileSync(join(packageRoot, 'vitest.config.ts'), 'utf8')
    // A guard that covers one file is the situation this replaced.
    expect(config).toContain('setupFiles')
    expect(config).toContain('./test/setup/noEgress.ts')
  })
})

// ── 4. every bench artifact is honestly synthetic ────────────────────────────

/** Every `.sketch/bench` directory this repository can produce. */
function benchDirs(): string[] {
  const candidates = [join(repoRoot, '.sketch', 'bench')]
  const packagesRoot = join(repoRoot, 'packages')
  if (existsSync(packagesRoot)) {
    for (const entry of readdirSync(packagesRoot)) {
      candidates.push(join(packagesRoot, entry, '.sketch', 'bench'))
    }
  }
  return candidates.filter((dir) => existsSync(dir))
}

function artifactsIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(dir, name))
}

describe('bench artifacts name a synthetic provider', () => {
  it('holds for every artifact present on this machine', () => {
    const files = benchDirs().flatMap(artifactsIn)

    for (const file of files) {
      const artifact = JSON.parse(readFileSync(file, 'utf8')) as { provider?: unknown }
      // An artifact with no provider identity is the silent-staleness case, not an
      // exemption from it.
      expect(typeof artifact.provider, file).toBe('string')
      expect(isSyntheticProviderIdentity(artifact.provider), `${file}: ${String(artifact.provider)}`)
        .toBe(true)
    }
  })

  it('BITES: the same scan fails on an artifact naming a real provider', () => {
    // `.sketch` is gitignored working state, so the count above is machine-
    // dependent and could be zero on a fresh clone. This is what stops that from
    // being a vacuous pass: the scan is run over a fixture that contains exactly
    // the artifact the claim forbids.
    const dir = mkdtempSync(join(tmpdir(), 'sketch-bench-scan-'))
    tmpDirs.push(dir)
    writeFileSync(join(dir, 'synthetic.json'), JSON.stringify({ provider: 'synthetic-offline' }))
    writeFileSync(join(dir, 'real.json'), JSON.stringify({ provider: 'openai' }))

    const verdicts = artifactsIn(dir).map((file) => ({
      file,
      ok: isSyntheticProviderIdentity(
        (JSON.parse(readFileSync(file, 'utf8')) as { provider?: unknown }).provider,
      ),
    }))

    expect(verdicts.filter((verdict) => verdict.ok)).toHaveLength(1)
    expect(verdicts.find((verdict) => !verdict.ok)!.file).toContain('real.json')
  })

  it('accepts the identities the offline harness actually writes', () => {
    for (const identity of ['synthetic-offline', 'offline-scripted', 'fake', 'loopback-stub']) {
      expect(isSyntheticProviderIdentity(identity), identity).toBe(true)
    }
  })

  it('refuses a hosted identity even when it wears a synthetic word', () => {
    for (const identity of [
      'openai',
      'anthropic',
      'gemini',
      'groq',
      'azure-openai',
      // The evasion this test exists for: a synthetic token is not a pass on its own.
      'openai-offline',
      'fake-anthropic',
      '',
      undefined,
      null,
      7,
    ]) {
      expect(isSyntheticProviderIdentity(identity), String(identity)).toBe(false)
    }
  })
})
