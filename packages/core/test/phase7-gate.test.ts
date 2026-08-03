// Phase 7 gate — verification means something, a broken app means something, and a
// hanging tool cannot wedge a run.
//
// THE THREE CLAIMS, from tasks.md 7.5:
//   1. Broken tests mean NOT DONE (Requirement 4.7).
//   2. A broken RUNNING APP means NOT DONE (Requirement 23.2).
//   3. A hanging tool cannot hang a run (Requirement 22.3).
//
// All three offline, with no API key, against real child processes.
//
// ── WHY THESE THREE TOGETHER ────────────────────────────────────────────────
//
// They are the three ways this product can lie about having finished, and each lies
// differently:
//
//   * Claim 1 is the model asserting success. A loop that takes "done" at its word is
//     a loop that reports green while the test suite is red.
//   * Claim 2 is the SUITE asserting success. Nine passing stages describe a program
//     that compiles and satisfies its unit tests, and a program can do both and crash
//     on boot. This is the gap the whole of task 7.2 exists to close.
//   * Claim 3 is the run never finishing at all. A run that hangs never reports
//     anything, which is not a wrong answer but is a worse product than either.
//
// ── ONE CHAIN FOR THE FIRST TWO, BECAUSE THE JOIN IS WHERE IT BREAKS ────────
//
// Section 1 runs a single task whose policy has BOTH a failing unit stage and a live
// check, so the sequence proves the model's "done" loses to the suite, and then that the
// suite's own green loses to a crashing application. Testing them apart would miss the
// case that actually shipped in 7.2: the loop not passing `root` to the policy runner,
// which made a live-only policy skip itself and report ok — green from a check that
// never ran.
//
// ── WHAT IS REAL HERE ───────────────────────────────────────────────────────
//
// The verify commands are real `node` processes with real exit codes. The application
// is a real HTTP server on a real port. The MCP server is a real child process speaking
// real JSON-RPC over real pipes that deliberately never answers. `runTask` is the real
// loop. The only substituted collaborator is the model, which is what lets this run with
// the network cable out and cost nothing.
//
// ── WHAT THIS GATE DOES NOT CLAIM ───────────────────────────────────────────
//
// * NOT that Sketch has ever run against a real provider. Nothing in this repository
//   has. Every model turn here is scripted.
// * NOT that the curated MCP servers work. They are launch descriptions for third-party
//   packages this project has not audited (see `mcp/catalog.ts`). What is proved is that
//   a server which hangs cannot hurt a run, using a server written here to hang.
// * NOT that the nine stages are correctly configured for any real project. Detection is
//   a heuristic and a project that configures nothing passes trivially — which is why
//   `verifiedAnything` exists and is asserted below.
//
// Validates: Requirements 4.7, 22.3, 23.2

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryEventStore } from '../src/events/index.js'
import { DiskFileWriter } from '../src/orchestrator/file-writer.js'
import { PlanWriter } from '../src/plan/index.js'
import { runTask } from '../src/loop/index.js'
import { FakeChatAdapter } from '../src/providers/fake.js'
import { ToolDispatcher } from '../src/capabilities/index.js'
import { McpHost } from '../src/mcp/index.js'
import { runVerifyPolicy, type VerifyPolicy } from '../src/verify/index.js'
import type { SketchEvent } from '../src/types.js'

const tmpDirs: string[] = []
const hosts: McpHost[] = []

afterAll(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {})
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-phase7-'))
  tmpDirs.push(dir)
  return dir
}

/** A port nothing is listening on, found by binding and releasing it. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

const PLAN = JSON.stringify({
  action: 'plan',
  artifacts: { prd: 'Ship the endpoint.', arch: 'One file.', schema: 'none', tests: 'one' },
})
const DONE = JSON.stringify({ action: 'done', text: 'All finished, everything passes.' })

const kinds = (events: readonly SketchEvent[]) => events.map((event) => event.kind)

/**
 * Bound anything that awaits a hanging MCP server, so a BROKEN DEADLINE FAILS BY NAME.
 *
 * Claim 3 rests entirely on `mcp/client.ts` rejecting on its own request timeout. If that
 * deadline stops firing, the awaited work never settles and the only thing left holding
 * the run is vitest's `testTimeout` — which reports "Test timed out in 30000ms" and says
 * nothing about MCP, the timeout, or the write-off latch. The budget is far above the
 * configured `requestTimeoutMs`, so a working timeout always wins the race, and far below
 * the per-test timeout, so the named message is what a reader sees.
 */
async function boundedByMcpDeadline<T>(
  work: Promise<T>,
  what: string,
  requestTimeoutMs: number,
  budgetMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `MCP HANG GUARD BROKEN (Requirement 22.3): ${what} was still outstanding after ` +
            `${budgetMs}ms, against a server configured with requestTimeoutMs=${requestTimeoutMs}. ` +
            'The MCP request timeout never fired, so the server was never written off and ' +
            'the run would NOT have continued.',
        ),
      )
    }, budgetMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([work, bound])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * An application that starts, answers once, and then dies.
 *
 * This is the shape Requirement 23.2 is about: it is NOT a failure to start. It binds,
 * it responds, a probe would pass — and then the process exits non-zero, which is what a
 * missing environment variable or an unhandled rejection actually looks like in
 * production.
 */
function appThatDiesAfterStarting(port: number): string {
  return `
const http = require('node:http')
let served = 0
const server = http.createServer((req, res) => {
  served += 1
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('ok')
  // Die AFTER answering, so a naive readiness probe has already succeeded.
  setTimeout(() => {
    console.error('TypeError: Cannot read properties of undefined (reading "user")')
    process.exit(1)
  }, 120)
})
server.listen(${port}, '127.0.0.1', () => console.log('listening on ${port}'))
`
}

/** An application that binds, answers, and keeps working. The control case. */
function appThatWorks(port: number): string {
  return `
const http = require('node:http')
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('ok')
})
server.listen(${port}, '127.0.0.1', () => console.log('listening on ${port}'))
setInterval(() => {}, 1000)
`
}

/** Handshakes, advertises a tool, and then never answers a call. */
const HANGING_MCP_SERVER = `
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const at = buffer.indexOf('\\n')
    if (at === -1) break
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (line.trim() === '') continue
    const request = JSON.parse(line)
    if (request.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05' } }) + '\\n')
    } else if (request.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'read_file', description: 'Never answers' }] } }) + '\\n')
    }
    // tools/call: deliberate silence, forever.
  }
})
setInterval(() => {}, 1000)
`

const node = (source: string) => ({ cmd: process.execPath, args: ['-e', source] })

// ── 1. broken tests, then a broken running app ──────────────────────────────

describe('Phase 7 gate — “done” has to survive the evidence', () => {
  it('refuses the model’s “done” while a unit stage is red (Requirement 4.7)', async () => {
    expect(process.env.ANTHROPIC_API_KEY ?? '').toBe('')
    expect(process.env.OPENAI_API_KEY ?? '').toBe('')

    const project = await makeProject()
    const events = new MemoryEventStore({ secrets: [] })

    // A real failing suite: two assertions, one of them wrong.
    const policy: VerifyPolicy = {
      typecheck: [{ name: 'typecheck', ...node('console.log("no errors")') }],
      unit: [
        {
          name: 'unit',
          ...node(
            'console.log("2 tests"); console.error("AssertionError: expected 4 to be 5"); process.exit(1)',
          ),
        },
      ],
    }

    const result = await runTask(
      { id: 'phase7-red', prompt: 'Make the sums add up.', verify: [] },
      {
        adapter: new FakeChatAdapter({
          // The model insists. Twice, because a single refusal could be luck.
          script: [PLAN, DONE, DONE],
        }),
        events,
        plan: new PlanWriter({ baseDir: project, events }),
        files: new DiskFileWriter(),
        root: project,
        maxIterations: 4,
        verifyPolicy: policy,
      },
    )

    // THE CLAIM. The model said everything passes; the suite says otherwise, and the
    // suite wins. `ok` is the only thing a caller reads, so this is the assertion that
    // actually protects anyone.
    expect(result.ok).toBe(false)

    // And the reason is legible, not just a false flag: the failing stage is named and
    // its real assertion text came back.
    const flat = result.verify.map((entry) => `${entry.name}:${entry.ok}`)
    expect(flat).toContain('typecheck:true')
    expect(flat).toContain('unit:false')
    const unit = result.verify.find((entry) => entry.name === 'unit')!
    expect(unit.exitCode).toBe(1)
    expect(unit.stderr).toContain('expected 4 to be 5')

    // The durable log records both halves of every stage, so a surface can show what
    // happened without re-running anything.
    expect(kinds(await events.forRun(result.runId))).toContain('verify_started')
    expect(kinds(await events.forRun(result.runId))).toContain('verify_result')
  })

  it('refuses “done” when the SUITE is green but the app crashes (Requirement 23.2)', async () => {
    const project = await makeProject()
    const port = await freePort()
    await writeFile(join(project, 'server.js'), appThatDiesAfterStarting(port), 'utf8')

    const events = new MemoryEventStore({ secrets: [] })

    // Every command passes. This is the whole point: a program can typecheck, build and
    // satisfy its unit tests and still die on boot, and a contract that stops at the
    // command exit codes calls that done.
    const policy: VerifyPolicy = {
      typecheck: [{ name: 'typecheck', ...node('console.log("no errors")') }],
      unit: [{ name: 'unit', ...node('console.log("12 passed")') }],
      live: {
        name: 'app',
        cmd: process.execPath,
        args: ['server.js'],
        readyWhen: { output: 'listening on', port },
        readyTimeoutMs: 15_000,
        // Loopback only, and the runner enforces that.
        probe: { url: `http://127.0.0.1:${port}/`, expectStatus: 200 },
        settleMs: 900,
      },
    }

    const result = await runTask(
      { id: 'phase7-crash', prompt: 'Ship the endpoint.', verify: [] },
      {
        adapter: new FakeChatAdapter({ script: [PLAN, DONE, DONE] }),
        events,
        plan: new PlanWriter({ baseDir: project, events }),
        files: new DiskFileWriter(),
        root: project,
        maxIterations: 4,
        verifyPolicy: policy,
      },
    )

    // THE CLAIM. Commands green, application dead, verdict not done.
    expect(result.ok).toBe(false)

    // Every command really did pass, so this is not a stage failure wearing a live
    // check's clothes.
    for (const entry of result.verify.filter((row) => row.name !== 'app')) {
      expect(entry.ok, `${entry.name} was expected to pass`).toBe(true)
    }

    // The live row exists, failed, and carries the real crash text — `runtime-error`,
    // not `failed-to-start`, because the two point at completely different bugs.
    const live = result.verify.find((entry) => entry.name === 'app')!
    expect(live.ok).toBe(false)
    expect(`${live.stdout}${live.stderr}`).toContain('Cannot read properties of undefined')
  }, 30_000)

  it('is the control: the same policy passes when the app actually stays up', async () => {
    // Without this, the previous test proves only that something failed — a live check
    // that never passes would satisfy it just as well.
    const project = await makeProject()
    const port = await freePort()
    await writeFile(join(project, 'server.js'), appThatWorks(port), 'utf8')

    const events = new MemoryEventStore({ secrets: [] })
    const result = await runTask(
      { id: 'phase7-green', prompt: 'Ship the endpoint.', verify: [] },
      {
        adapter: new FakeChatAdapter({ script: [PLAN, DONE] }),
        events,
        plan: new PlanWriter({ baseDir: project, events }),
        files: new DiskFileWriter(),
        root: project,
        maxIterations: 4,
        verifyPolicy: {
          unit: [{ name: 'unit', ...node('console.log("12 passed")') }],
          live: {
            name: 'app',
            cmd: process.execPath,
            args: ['server.js'],
            readyWhen: { output: 'listening on', port },
        readyTimeoutMs: 15_000,
            probe: { url: `http://127.0.0.1:${port}/`, expectStatus: 200 },
            settleMs: 700,
          },
        },
      },
    )

    expect(result.ok).toBe(true)
    expect(result.verify.find((entry) => entry.name === 'app')!.ok).toBe(true)
  }, 30_000)

  it('does not let an empty contract read as evidence of anything', async () => {
    // `ok` is true for a project that configures nothing, and that must never be
    // mistaken for verification. This is why `verifiedAnything` exists.
    const project = await makeProject()
    const empty = await runVerifyPolicy({}, { root: project })
    expect(empty.ok).toBe(true)
    expect(empty.verifiedAnything).toBe(false)
    expect(empty.ranStages).toEqual([])
    // All nine reported, every one of them `skipped` — not silently absent.
    expect(empty.stages).toHaveLength(9)
    expect(new Set(empty.stages.map((stage) => stage.status))).toEqual(new Set(['skipped']))
  })
})

// ── 2. a hanging tool cannot hang a run ─────────────────────────────────────

describe('Phase 7 gate — a hanging tool (Requirement 22.3)', () => {
  it('times out, latches the server off, and lets the run finish', async () => {
    const project = await makeProject()
    const script = join(project, 'hanging-mcp.js')
    await writeFile(script, HANGING_MCP_SERVER, 'utf8')

    const events = new MemoryEventStore({ secrets: [] })
    const host = new McpHost({
      root: project,
      events,
      // Short, so the test is fast. The mechanism is identical at 20 seconds.
      requestTimeoutMs: 500,
      handshakeTimeoutMs: 2_000,
      launchOverrides: {
        filesystem: { id: 'filesystem', command: process.execPath, args: [script] },
      },
    })
    hosts.push(host)

    // It handshakes fine. A server that refused to start would be a different, easier
    // failure — this one looks healthy right up until it is asked to do something.
    const opened = await host.open('filesystem')
    expect(opened.ok, opened.detail).toBe(true)
    expect(opened.tools).toEqual(['filesystem.read_file'])

    const dispatcher = new ToolDispatcher({
      tools: host.descriptors(),
      granted: ['fs:write:project'],
      root: project,
      events,
    })

    const started = Date.now()
    const result = await boundedByMcpDeadline(
      runTask(
        { id: 'phase7-hang', prompt: 'Read the config file.', verify: [] },
        {
          adapter: new FakeChatAdapter({
            script: [
              PLAN,
              // Three attempts at the dead server. The first pays the timeout; the second
              // and third must be instant, which is what the LATCH is for.
              JSON.stringify({ action: 'tool', name: 'filesystem.read_file', args: { path: 'a' } }),
              JSON.stringify({ action: 'tool', name: 'filesystem.read_file', args: { path: 'b' } }),
              JSON.stringify({ action: 'tool', name: 'filesystem.read_file', args: { path: 'c' } }),
              DONE,
            ],
          }),
          events,
          plan: new PlanWriter({ baseDir: project, events }),
          files: new DiskFileWriter(),
          root: project,
          maxIterations: 7,
          tools: dispatcher,
        },
      ),
      'the run whose only tool is a hanging MCP server',
      500,
      6_000,
    )
    const elapsed = Date.now() - started

    // THE CLAIM, all three halves of Requirement 22.3.
    //
    // (a) THE RUN CONTINUES. It reached `done` — a hang is a result, never a throw.
    expect(result.ok).toBe(true)
    expect(result.finalText).toContain('All finished')

    // (b) IT TIMED OUT rather than waiting forever.
    expect(elapsed).toBeLessThan(20_000)

    // (c) MARKED UNAVAILABLE FOR THE REST OF THE RUN. This is the half a naive timeout
    // misses, and the cost of missing it is linear in retries: three attempts against a
    // 20-second server would be a minute of a run spent waiting for something already
    // known to be broken. One timeout is paid; the rest are free.
    expect(elapsed).toBeLessThan(500 * 3)
    const status = host.status().find((entry) => entry.id === 'filesystem')!
    expect(status.ok).toBe(false)
    expect(status.unavailable).toBe('timeout')
    expect(status.reason).toContain('unavailable for the rest of this run')

    // The failure is SURFACED, not hidden (Requirement 22.5): one `tool_denied` from the
    // MCP client naming the server, and the reason is on the log.
    const logged = await events.forRun(result.runId)
    const denials = logged.filter((event) => event.kind === 'tool_denied')
    expect(denials.length).toBeGreaterThanOrEqual(1)
    expect(denials.some((event) => event.payload['component'] === 'mcp')).toBe(true)

    // And all three calls were reported back to the model as failures, so it could not
    // have believed a file was read.
    const calls = logged.filter(
      (event) => event.kind === 'tool_called' && event.payload['phase'] === 'result',
    )
    expect(calls).toHaveLength(3)
    for (const call of calls) expect(call.payload['ok']).toBe(false)
  }, 30_000)

  it('does not let one server’s hang take out a healthy one', async () => {
    // The latch has to be per-server. A run whose GitHub server hangs must still be
    // able to read a file.
    const project = await makeProject()
    const hanging = join(project, 'hanging-mcp.js')
    await writeFile(hanging, HANGING_MCP_SERVER, 'utf8')
    const working = join(project, 'working-mcp.js')
    await writeFile(
      working,
      HANGING_MCP_SERVER.replace(
        '    // tools/call: deliberate silence, forever.',
        `    if (request.method === 'tools/call') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'the real contents' }] } }) + '\\n')
    }`,
      ),
      'utf8',
    )

    const host = new McpHost({
      root: project,
      requestTimeoutMs: 500,
      handshakeTimeoutMs: 2_000,
      launchOverrides: {
        filesystem: { id: 'filesystem', command: process.execPath, args: [working] },
        github: { id: 'github', command: process.execPath, args: [hanging] },
      },
      // `github` needs a token from the catalog; supply a placeholder so the open
      // reaches the handshake instead of being refused for missing environment.
      env: { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: 'placeholder-not-a-real-token' },
    })
    hosts.push(host)
    expect((await host.open('filesystem')).ok).toBe(true)
    expect((await host.open('github')).ok).toBe(true)

    const dispatcher = new ToolDispatcher({
      tools: host.descriptors(),
      granted: ['fs:write:project', 'net:http'],
      root: project,
    })

    const dead = await boundedByMcpDeadline(
      dispatcher.call('github.read_file', { path: 'a' }),
      'the call to the hanging `github` server',
      500,
      3_000,
    )
    expect(dead.ok).toBe(false)

    const alive = await dispatcher.call('filesystem.read_file', { path: 'a' })
    expect(alive.ok).toBe(true)
    expect(alive.output).toContain('the real contents')
    // Framed as DATA even on the healthy path, every time.
    expect(alive.output).toContain('--- begin tool output ---')

    expect(host.status().find((entry) => entry.id === 'filesystem')!.ok).toBe(true)
    expect(host.status().find((entry) => entry.id === 'github')!.ok).toBe(false)
  }, 30_000)
})

// ── 3. the tool layer cannot be reached around ──────────────────────────────

describe('Phase 7 gate — the tool layer is still behind the one gate', () => {
  it('denies an MCP tool the run’s grant does not cover, and continues', async () => {
    // 7.3 added tools to the dispatcher. It does not get to add a second dispatcher, and
    // a tool that a grant cannot reach must not be callable just because a server is up.
    const project = await makeProject()
    const working = join(project, 'working-mcp.js')
    await writeFile(
      working,
      HANGING_MCP_SERVER.replace(
        '    // tools/call: deliberate silence, forever.',
        `    if (request.method === 'tools/call') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'should never be reached' }] } }) + '\\n')
    }`,
      ),
      'utf8',
    )

    const events = new MemoryEventStore({ secrets: [] })
    const host = new McpHost({
      root: project,
      handshakeTimeoutMs: 2_000,
      launchOverrides: {
        // `filesystem` costs fs:write:project in the catalog.
        filesystem: { id: 'filesystem', command: process.execPath, args: [working] },
      },
    })
    hosts.push(host)
    expect((await host.open('filesystem')).ok).toBe(true)

    const dispatcher = new ToolDispatcher({
      tools: host.descriptors(),
      // Read only. The server is running and its tool is registered.
      granted: ['fs:read:project'],
      root: project,
      events,
    })

    // Not even offered to the model.
    expect(dispatcher.availableTools).toEqual([])

    const denied = await dispatcher.call('filesystem.read_file', { path: 'a' })
    expect(denied.ok).toBe(false)
    expect(denied.denied).toBe('capability_denied')
    expect(denied.missing).toBe('fs:write:project')
    // The server answered nobody: the check is before `run`, not inside it.
    expect(denied.output).not.toContain('should never be reached')

    // A capability refusal is `capability_denied`, and a hung server is `mcp`. Telling
    // them apart is the difference between a security event and a broken dependency.
    const denials = (await events.readAll()).filter((event) => event.kind === 'tool_denied')
    expect(denials).toHaveLength(1)
    expect(denials[0]!.payload['reason']).toBe('capability_denied')
    expect(denials[0]!.payload['component']).toBeUndefined()
  }, 30_000)
})
