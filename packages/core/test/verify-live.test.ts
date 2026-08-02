// Live environment feedback, against REAL long-lived processes.
//
// Every app under test here is a real `node -e` server or script: a real listener on
// a real ephemeral port, a real crash, a real hang. Nothing is simulated, because the
// failures this stage exists to catch — a process that dies after it looked healthy, a
// port already held by someone else, a bundler that outlives its parent — only happen
// to real processes.
//
// THE TEST THAT MATTERS MOST is `refuses when the port is already in use`. A readiness
// probe against an occupied port succeeds instantly, answered by a stranger's server,
// and the stage passes while testing nothing. That is the only failure here that is
// both silent and green.
//
// Validates: Requirements 23.1, 23.2, 23.3, 23.4

import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_ERROR_PATTERNS,
  EXIT_LIVE_FAILED,
  findRuntimeError,
  freePort,
  isPortListening,
  liveResultToVerifyResult,
  runLiveCheck,
  type LiveCheck,
} from '../src/verify/index.js'

const tmpDirs: string[] = []
const closers: Array<() => void> = []

afterEach(async () => {
  while (closers.length) {
    try {
      closers.pop()!()
    } catch {
      // Already closed.
    }
  }
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-live-'))
  tmpDirs.push(dir)
  return dir
}

/** A real HTTP server on `port`, as the app under test. */
function serverScript(port: number, body = 'ok', status = 200): string {
  return [
    "const http = require('node:http')",
    `http.createServer((req, res) => { res.writeHead(${status}); res.end(${JSON.stringify(body)}) })`,
    `  .listen(${port}, '127.0.0.1', () => console.log('listening on http://127.0.0.1:${port}'))`,
  ].join('\n')
}

function check(partial: Partial<LiveCheck> & Pick<LiveCheck, 'cmd'>): LiveCheck {
  return { settleMs: 200, readyTimeoutMs: 8_000, ...partial }
}

// ── 1. the happy path ───────────────────────────────────────────────────────

describe('a working application', () => {
  it('starts, answers its probe, survives the settle window, and is killed', async () => {
    const port = await freePort()
    const result = await runLiveCheck(
      check({
        cmd: process.execPath,
        args: ['-e', serverScript(port)],
        readyWhen: { port, output: 'listening on' },
        probe: { url: `http://127.0.0.1:${port}/`, expectStatus: 200 },
      }),
      { root: await makeRoot() },
    )

    expect(result.reason).toContain('stayed up')
    expect(result.status).toBe('passed')
    expect(result.ok).toBe(true)
    expect(result.heuristic).toBe(false)
    expect(result.readyMs).toBeGreaterThanOrEqual(0)
    // Output was captured, not read after the kill.
    expect(result.output).toContain('listening on')

    // And the process is gone: the port is free again. Windows can retain the
    // listener briefly under full-suite process pressure; the assertion stays exact.
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(await isPortListening(port)).toBe(false)
  })

  it('is ready on output alone when that is all it was given', async () => {
    const result = await runLiveCheck(
      check({
        cmd: process.execPath,
        args: ['-e', "console.log('server ready'); setInterval(() => {}, 1000)"],
        readyWhen: { output: 'server ready' },
      }),
      { root: await makeRoot() },
    )
    expect(result.status).toBe('passed')
  })
})

// ── 2. failure to start (Requirement 23.3) ──────────────────────────────────

describe('an application that fails to start', () => {
  it('is a verification failure WITH the captured output', async () => {
    const result = await runLiveCheck(
      check({
        cmd: process.execPath,
        args: ['-e', "console.error('config missing: DATABASE_URL'); process.exit(1)"],
        readyWhen: { output: 'never appears' },
      }),
      { root: await makeRoot() },
    )

    expect(result.status).toBe('failed-to-start')
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    // THE POINT of 23.3: the last lines before the crash are the whole diagnosis.
    expect(result.output).toContain('config missing: DATABASE_URL')
    expect(result.reason).toContain('exited before it was ready')
  })

  it('times out rather than hanging, and says what it was waiting for', async () => {
    const port = await freePort()
    const result = await runLiveCheck(
      check({
        cmd: process.execPath,
        // Alive, but never listens and never says the magic word.
        args: ['-e', "console.log('booting'); setInterval(() => {}, 1000)"],
        readyWhen: { port, output: 'listening' },
        readyTimeoutMs: 700,
      }),
      { root: await makeRoot() },
    )

    expect(result.status).toBe('failed-to-start')
    expect(result.reason).toContain('did not become ready within 700ms')
    // Actionable: which signal never arrived.
    expect(result.reason).toContain(`port ${port}`)
    expect(result.reason).toContain('listening')
    expect(result.output).toContain('booting')
  })

  it('reports a missing binary as a failure, not an exception', async () => {
    const result = await runLiveCheck(
      check({ cmd: 'sketch-no-such-app-binary', args: [], readyTimeoutMs: 2_000 }),
      { root: await makeRoot() },
    )
    expect(result.ok).toBe(false)
    expect(result.status).toBe('failed-to-start')
    expect(result.reason).toContain('sketch-no-such-app-binary')
  })

  it('REFUSES when the port is already in use', async () => {
    // The silent-and-green failure: a readiness probe against an occupied port is
    // answered by whatever is already there, and the stage passes having tested
    // nothing at all.
    const port = await freePort()
    const squatter = createServer(() => {})
    await new Promise<void>((resolve) => squatter.listen(port, '127.0.0.1', () => resolve()))
    closers.push(() => squatter.close())

    const result = await runLiveCheck(
      check({
        cmd: process.execPath,
        // A "server" that does nothing at all: if the check passed, it passed on the
        // squatter's listener.
        args: ['-e', 'setInterval(() => {}, 1000)'],
        readyWhen: { port },
      }),
      { root: await makeRoot() },
    )

    expect(result.ok).toBe(false)
    expect(result.status).toBe('failed-to-start')
    expect(result.reason).toContain(`port ${port} is already in use`)
    expect(result.reason).toContain('answered by whatever is already listening')
  })
})

// ── 3. runtime errors (Requirement 23.2) ────────────────────────────────────

describe('an application that breaks after it starts', () => {
  it('is a runtime error, not a failure to start, when it dies after becoming ready', async () => {
    const port = await freePort()
    const result = await runLiveCheck(
      check({
        cmd: process.execPath,
        args: [
          '-e',
          [
            "const http = require('node:http')",
            `const s = http.createServer((q, r) => r.end('x')).listen(${port}, '127.0.0.1', () => console.log('listening'))`,
            // Dies 150ms after it looked healthy.
            'setTimeout(() => process.exit(7), 150)',
          ].join('\n'),
        ],
        readyWhen: { port },
        settleMs: 1_200,
      }),
      { root: await makeRoot() },
    )

    // The distinction matters to whoever reads the report: this app booted fine.
    expect(result.status).toBe('runtime-error')
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(7)
    expect(result.heuristic).toBe(false)
    expect(result.reason).toContain('after becoming ready')
  })

  it('flags a logged runtime error, and marks the verdict a heuristic', async () => {
    const result = await runLiveCheck(
      check({
        cmd: process.execPath,
        args: [
          '-e',
          [
            "console.log('ready')",
            "console.error('UnhandledPromiseRejection: TypeError: cannot read property x of undefined')",
            'setInterval(() => {}, 1000)',
          ].join('\n'),
        ],
        readyWhen: { output: 'ready' },
        settleMs: 300,
      }),
      { root: await makeRoot() },
    )

    expect(result.status).toBe('runtime-error')
    expect(result.ok).toBe(false)
    // Said out loud: this verdict came from matching a log line, not from a fact.
    expect(result.heuristic).toBe(true)
    expect(result.matched).toBeDefined()
    expect(result.reason).toContain('cannot read property x')
  })

  it('does not flag an app that merely uses the word error', async () => {
    // A false failure here trains people to ignore the stage, which is worse than
    // the stage not existing.
    const result = await runLiveCheck(
      check({
        cmd: process.execPath,
        args: [
          '-e',
          [
            "console.log('ready')",
            "console.log('GET /api/error-codes 200')",
            "console.log('error rate: 0%')",
            "console.error('warning: deprecated flag --foo')",
            'setInterval(() => {}, 1000)',
          ].join('\n'),
        ],
        readyWhen: { output: 'ready' },
        settleMs: 300,
      }),
      { root: await makeRoot() },
    )
    expect(result.status).toBe('passed')
  })

  it('accepts extra patterns from the project', async () => {
    const result = await runLiveCheck(
      check({
        cmd: process.execPath,
        args: [
          '-e',
          ["console.log('ready')", "console.log('HYDRATION MISMATCH')", 'setInterval(() => {}, 1000)'].join(
            '\n',
          ),
        ],
        readyWhen: { output: 'ready' },
        errorPatterns: ['HYDRATION MISMATCH'],
        settleMs: 300,
      }),
      { root: await makeRoot() },
    )
    expect(result.status).toBe('runtime-error')
    expect(result.matched).toBe('HYDRATION MISMATCH')
  })
})

// ── 4. the probe ────────────────────────────────────────────────────────────

describe('the probe', () => {
  it('fails when the app answers the wrong status', async () => {
    const port = await freePort()
    const result = await runLiveCheck(
      check({
        cmd: process.execPath,
        args: ['-e', serverScript(port, 'boom', 500)],
        readyWhen: { port },
        probe: { url: `http://127.0.0.1:${port}/`, expectStatus: 200 },
      }),
      { root: await makeRoot() },
    )

    expect(result.status).toBe('probe-failed')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('answered 500')
    expect(result.reason).toContain('expected 200')
  })

  it('treats any 5xx as a failure when no status was named', async () => {
    const port = await freePort()
    const result = await runLiveCheck(
      check({
        cmd: process.execPath,
        args: ['-e', serverScript(port, 'boom', 503)],
        readyWhen: { port },
        probe: { url: `http://127.0.0.1:${port}/` },
      }),
      { root: await makeRoot() },
    )
    expect(result.status).toBe('probe-failed')
    expect(result.reason).toContain('expected below 500')
  })

  it('refuses to probe anything but loopback', async () => {
    // A verification stage that can reach an arbitrary host is an egress path, and
    // this one runs automatically.
    const result = await runLiveCheck(
      check({ cmd: process.execPath, args: ['-e', ''], probe: { url: 'https://example.com/' } }),
      { root: await makeRoot() },
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('only probe loopback')
    expect(result.reason).toContain('egress')
  })
})

// ── 5. skipping, and the small pieces ───────────────────────────────────────

describe('skipping (Requirement 23.4)', () => {
  it('skips without failing, and starts nothing', async () => {
    const result = await runLiveCheck(
      check({ cmd: 'sketch-would-not-exist', skip: true }),
      { root: await makeRoot() },
    )
    expect(result.status).toBe('skipped')
    expect(result.ok).toBe(true)
    expect(result.output).toBe('')
    expect(result.durationMs).toBe(0)
  })
})

describe('the error patterns', () => {
  it('are narrow enough not to fire on healthy logs', () => {
    const healthy = [
      'GET /health 200 1ms',
      'compiled successfully',
      'error rate: 0%',
      'warning: deprecated option',
      'Listening on http://localhost:3000',
      'no errors found',
    ].join('\n')
    expect(findRuntimeError(healthy)).toBeNull()
  })

  it('fire on the things that mean something is genuinely wrong', () => {
    for (const line of [
      'UnhandledPromiseRejection: boom',
      'Uncaught TypeError: x is not a function',
      'FATAL: could not connect',
      'Error: listen EADDRINUSE: address already in use :::3000',
      'panicked at src/main.rs:12',
      'Traceback (most recent call last):',
      "Cannot find module './missing.js'",
    ]) {
      expect(findRuntimeError(line), line).not.toBeNull()
    }
  })

  it('reports the whole line, not just the matched fragment', () => {
    const found = findRuntimeError('ok\nUncaught ReferenceError: foo is not defined\nmore')!
    expect(found.line).toBe('Uncaught ReferenceError: foo is not defined')
  })

  it('survives a caller pattern that is not a valid regular expression', () => {
    // A bad pattern must not break the stage.
    expect(findRuntimeError('all fine', ['('])).toBeNull()
    expect(DEFAULT_ERROR_PATTERNS.length).toBeGreaterThan(5)
  })
})

describe('as a VerifyResult row', () => {
  it('puts a failure\u2019s output on stderr with its status', () => {
    const row = liveResultToVerifyResult({
      name: 'live',
      status: 'runtime-error',
      ok: false,
      reason: 'it died',
      output: 'the log',
      heuristic: false,
      durationMs: 12,
    })
    expect(row.ok).toBe(false)
    expect(row.exitCode).toBe(EXIT_LIVE_FAILED)
    expect(row.stderr).toContain('runtime-error: it died')
    expect(row.stderr).toContain('the log')
    expect(row.stdout).toBe('')
  })

  it('puts a pass on stdout', () => {
    const row = liveResultToVerifyResult({
      name: 'live',
      status: 'passed',
      ok: true,
      reason: 'fine',
      output: 'the log',
      heuristic: false,
      durationMs: 12,
    })
    expect(row.ok).toBe(true)
    expect(row.exitCode).toBe(0)
    expect(row.stdout).toContain('fine')
    expect(row.stderr).toBe('')
  })
})

// ── 6. inside the gauntlet ──────────────────────────────────────────────────
//
// The live check is not a tenth stage: it is how `integration` is performed for a
// project with a runnable app, so its verdict has to count exactly like a command's.

describe('the live check inside the verification contract', () => {
  it('fails the integration stage, and therefore the policy', async () => {
    const { runVerifyPolicy } = await import('../src/verify/index.js')
    const root = await makeRoot()

    const result = await runVerifyPolicy(
      {
        live: check({
          cmd: process.execPath,
          args: ['-e', "console.error('boot failed'); process.exit(1)"],
          readyWhen: { output: 'never' },
          readyTimeoutMs: 2_000,
        }),
      },
      { root },
    )

    expect(result.ok).toBe(false)
    expect(result.failedStage).toBe('integration')
    expect(result.live?.status).toBe('failed-to-start')
    // The captured output reached the row a reader will actually look at.
    expect(result.results[0]!.stderr).toContain('boot failed')
    // And it counted as verification: this is not a vacuous pass.
    expect(result.verifiedAnything).toBe(true)
  })

  it('passes the integration stage when the app works', async () => {
    const { runVerifyPolicy } = await import('../src/verify/index.js')
    const port = await freePort()

    const result = await runVerifyPolicy(
      {
        live: check({
          cmd: process.execPath,
          args: ['-e', serverScript(port)],
          readyWhen: { port },
          probe: { url: `http://127.0.0.1:${port}/`, expectStatus: 200 },
        }),
      },
      { root: await makeRoot() },
    )

    expect(result.ok).toBe(true)
    expect(result.ranStages).toEqual(['integration'])
    expect(result.live?.status).toBe('passed')
  })

  it('runs after the integration commands, and not at all when they failed', async () => {
    const { runVerifyPolicy } = await import('../src/verify/index.js')
    const root = await makeRoot()

    const result = await runVerifyPolicy(
      {
        integration: [
          {
            name: 'integration',
            cmd: process.execPath,
            args: ['-e', 'console.error("suite failed"); process.exit(1)'],
          },
        ],
        // Would pass if it ran — and it must not: starting an app takes seconds a
        // failing suite has already made pointless.
        live: check({ cmd: process.execPath, args: ['-e', "console.log('ready')"] }),
      },
      { root },
    )

    expect(result.ok).toBe(false)
    expect(result.live).toBeUndefined()
    expect(result.results).toHaveLength(1)
  })

  it('emits the verify pair for a live verdict, flagged as live', async () => {
    const { runVerifyPolicy } = await import('../src/verify/index.js')
    const { MemoryEventStore } = await import('../src/events/index.js')
    const events = new MemoryEventStore({ secrets: [] })
    const port = await freePort()

    await runVerifyPolicy(
      {
        live: check({
          cmd: process.execPath,
          args: ['-e', serverScript(port)],
          readyWhen: { port },
        }),
      },
      { root: await makeRoot(), sink: events, runId: 'live-run' },
    )

    const emitted = await events.readAll()
    expect(emitted.map((event) => event.kind)).toEqual(['verify_started', 'verify_result'])
    expect(emitted[0]!.payload.live).toBe(true)
    expect(emitted[1]!.payload.live).toEqual({ status: 'passed', heuristic: false })
    expect(emitted[1]!.runId).toBe('live-run')
  })

  it('skips rather than guessing a directory when no root was supplied', async () => {
    const { runVerifyPolicy } = await import('../src/verify/index.js')

    const result = await runVerifyPolicy({
      live: check({ cmd: process.execPath, args: ['-e', "console.log('ready')"] }),
    })

    // Skipped, not failed: guessing a root would start the app in whatever directory
    // this process happens to be in.
    expect(result.ok).toBe(true)
    expect(result.live?.status).toBe('skipped')
    expect(result.stages.find((stage) => stage.stage === 'integration')!.status).toBe('skipped')
    expect(result.verifiedAnything).toBe(false)
  })

  it('is configured from verify.json, which is the only format with nested objects', async () => {
    const { parsePolicyJson } = await import('../src/verify/index.js')
    const { policy, diagnostics } = parsePolicyJson(
      JSON.stringify({
        unit: ['npm test'],
        live: {
          cmd: 'npm',
          args: ['run', 'dev'],
          readyWhen: { port: 5173, output: 'ready in' },
          probe: { url: 'http://localhost:5173/', expectStatus: 200 },
          settleMs: 2000,
          errorPatterns: ['HYDRATION'],
        },
      }),
    )

    expect(diagnostics).toEqual([])
    expect(policy.live).toEqual({
      cmd: 'npm',
      args: ['run', 'dev'],
      readyWhen: { output: 'ready in', port: 5173 },
      probe: { url: 'http://localhost:5173/', expectStatus: 200 },
      settleMs: 2000,
      errorPatterns: ['HYDRATION'],
    })
    expect(policy.unit).toHaveLength(1)
  })

  it('reports a malformed live block instead of ignoring it', async () => {
    const { parsePolicyJson } = await import('../src/verify/index.js')
    expect(parsePolicyJson(JSON.stringify({ live: {} })).diagnostics[0]).toContain(
      'live.cmd must be',
    )
    expect(parsePolicyJson(JSON.stringify({ live: { cmd: 'x', probe: {} } })).diagnostics[0]).toContain(
      'live.probe.url',
    )
    expect(
      parsePolicyJson(JSON.stringify({ live: { cmd: 'x', readyWhen: 3 } })).diagnostics[0],
    ).toContain('live.readyWhen must be an object')
  })
})

// ── 7. and through a real run ───────────────────────────────────────────────

describe('the loop under live feedback (Requirement 23.2)', () => {
  it('is NOT done when the running application breaks', async () => {
    const { runTask } = await import('../src/loop/index.js')
    const { MemoryEventStore } = await import('../src/events/index.js')
    const { PlanWriter } = await import('../src/plan/index.js')
    const { DiskFileWriter } = await import('../src/orchestrator/file-writer.js')
    const { FakeChatAdapter } = await import('../src/providers/fake.js')

    const root = await makeRoot()
    const events = new MemoryEventStore({ secrets: [] })
    const adapter = new FakeChatAdapter({
      script: ['{"action":"verify"}', JSON.stringify({ action: 'done', text: 'shipped it' })],
    })

    const result = await runTask(
      { id: 'live-task', prompt: 'change the app', verify: [] },
      {
        adapter,
        events,
        plan: new PlanWriter({ baseDir: root, events }),
        files: new DiskFileWriter(),
        root,
        maxIterations: 4,
        verifyPolicy: {
          live: check({
            cmd: process.execPath,
            args: ['-e', "console.error('Uncaught TypeError: undefined is not a function')\nconsole.log('ready')\nsetInterval(() => {}, 1000)"],
            readyWhen: { output: 'ready' },
            settleMs: 300,
          }),
        },
      },
    )

    // Green unit tests cannot mask a broken app, because there is nothing else here
    // to be green: the app's own runtime error is the verdict.
    expect(result.ok).toBe(false)
    const terminal = result.events.find((event) => event.kind === 'run_failed')!
    expect(terminal.payload.reason).toBe('verify_failed')
    const policy = terminal.payload.policy as { failedStage: string }
    expect(policy.failedStage).toBe('integration')
    // The model was told what happened, in words it can act on.
    const seen = (adapter.lastMessages ?? []).map((message) => message.content).join('\n')
    expect(seen).toContain('VERIFY FAIL at integration')
  })
})
