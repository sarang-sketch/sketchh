// stdio JSON-line CLI tests.
//
// Uses REAL: a REAL CHILD PROCESS running the built `dist/cli.js` over real
// pipes, the real filesystem (temp dirs via mkdtemp), the real JSONL event store,
// the real plan gate, real verify SUBPROCESSES, and — for the two scenarios the
// offline fake cannot express — a real `node:http` server on loopback speaking the
// OpenAI-compatible wire format as a scripted model. No mocks, no stubbed
// filesystem, no monkey-patched stdout.
//
// WHY A CHILD PROCESS AND NOT AN IN-PROCESS SERVER. The thing under test is the
// FRAMING: what a consumer reading a pipe line by line actually sees, in order.
// Task 2.1 (`StdioSketchClient`) and task 2.2 (the SSE bridge) both parse exactly
// this byte stream. An in-process `ProtocolServer` with a captured `writeOut`
// cannot catch a stray `console.log` from any module the run touches, cannot catch
// a verify subprocess inheriting stdout, and cannot prove the process exits
// cleanly when stdin closes. So the protocol cases below all spawn
// `process.execPath dist/cli.js`.
//
// The dispatch LOGIC that does not need a pipe — frame decoding, error codes, the
// sequential queue — is additionally exercised as pure functions and against an
// in-process `ProtocolServer`, where a failure points at one function instead of
// at "the child said something odd".
//
// `dist/cli.js` is a build artifact: these tests skip with a clear message when it
// is absent (`npm run build -w @sketch/core` produces it). The audit and pure
// dispatch tests run either way.
//
// Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 6.5

import { describe, it, expect, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createServer,
  encodeFrame,
  isEventFrame,
  isResponseFrame,
  parseRequest,
  ENGINE_NAME,
  ENGINE_VERSION,
  METHOD_NAMES,
  REQUIRED_METHOD_NAMES,
  PROTOCOL_VERSION,
} from '../src/rpc/index.js'
import type { EventFrame, MethodHandler, ResponseFrame } from '../src/rpc/index.js'
import { PLAN_GATE_REASON } from '../src/loop/index.js'
import type { EvalResult, RunResult, Skill } from '../src/types.js'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI_PATH = join(packageRoot, 'dist', 'cli.js')
const CLI_BUILT = existsSync(CLI_PATH)

/** Requires `dist/cli.js`; skipped with this reason in its title when absent. */
const describeCli = CLI_BUILT
  ? describe
  : describe.skip

const CLI_SKIP_NOTE = CLI_BUILT ? '' : ' [SKIPPED: dist/cli.js is missing — run `npm run build -w @sketch/core`]'

const tmpDirs: string[] = []

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-cli-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// ── the child-process harness ────────────────────────────────────────────────

interface Transcript {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** Every non-blank stdout line, in order. */
  lines: string[]
  /** Every line parsed as JSON, in order. Parsing is asserted, not assumed. */
  parsed: unknown[]
  responses: ResponseFrame[]
  events: EventFrame[]
}

interface SessionOptions {
  /** Force the offline provider. Default true; the scripted-model tests clear it. */
  fakeProvider?: boolean
  cwd?: string
}

/**
 * Drive the real CLI: spawn it, write every line to stdin, close stdin, and read
 * the whole transcript back off stdout.
 *
 * Lines are written up front and in one tick, so requests genuinely OVERLAP from
 * the caller's point of view — the second is on the wire before the first has
 * responded. What comes back is therefore the server's real ordering, not an
 * artifact of the test waiting politely between calls.
 */
async function session(lines: readonly string[], options: SessionOptions = {}): Promise<Transcript> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (options.fakeProvider === false) delete env['SKETCH_FAKE_PROVIDER']
  else env['SKETCH_FAKE_PROVIDER'] = '1'
  // Keep a stray key in the developer's environment out of the picture entirely.
  delete env['OPENAI_API_KEY']
  delete env['ANTHROPIC_API_KEY']

  const child = spawn(process.execPath, [CLI_PATH], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(options.cwd ? { cwd: options.cwd } : {}),
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  for (const line of lines) child.stdin.write(`${line}\n`)
  child.stdin.end()

  const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
    (resolveClose) => {
      child.on('close', (code, sig) => resolveClose([code, sig]))
    },
  )

  const outLines = stdout.split('\n').filter((line) => line.trim() !== '')
  const parsed: unknown[] = []
  const responses: ResponseFrame[] = []
  const events: EventFrame[] = []
  for (const line of outLines) {
    // A line that does not parse is a protocol violation (Requirement 12.5), so
    // it must surface as a failed assertion naming the line, not a thrown
    // SyntaxError from the harness.
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch (err) {
      expect.fail(
        `stdout carried a line that is not a JSON frame: ${JSON.stringify(line.slice(0, 300))} (${
          err instanceof Error ? err.message : String(err)
        })`,
      )
    }
    parsed.push(frame)
    if (isResponseFrame(frame)) responses.push(frame)
    else if (isEventFrame(frame)) events.push(frame)
  }

  return { exitCode, signal, stdout, stderr, lines: outLines, parsed, responses, events }
}

const request = (id: unknown, method: string, params: Record<string, unknown> = {}): string =>
  JSON.stringify({ id, method, params })

const responseFor = (t: Transcript, id: unknown): ResponseFrame => {
  const found = t.responses.find((frame) => frame.id === id)
  if (found === undefined) {
    expect.fail(`no response frame for id ${JSON.stringify(id)}; got ${JSON.stringify(t.responses.map((r) => r.id))}`)
  }
  return found
}

const okResult = <T>(t: Transcript, id: unknown): T => {
  const frame = responseFor(t, id)
  if (frame.ok !== true) expect.fail(`request ${JSON.stringify(id)} failed: ${frame.error}`)
  return frame.result as T
}

/** A verify command that really passes and really prints to its own stdout. */
const NOISY_PASS = {
  name: 'unit',
  cmd: process.execPath,
  args: ['-e', 'process.stdout.write("NOISE-ON-CHILD-STDOUT"); console.error("diag")'],
}

// ── a scripted model over loopback HTTP ──────────────────────────────────────
//
// The offline fake always returns the same three-call script (plan → verify →
// done) and `resolveAdapter` gives no way to inject another one, so two scenarios
// below cannot be expressed with it: a model that tries to EDIT BEFORE PLANNING,
// and a provider that answers 401 with the key echoed in the body. Both are real
// HTTP against 127.0.0.1 — offline, no API key, no third-party code.

interface ModelServer {
  baseUrl: string
  readonly calls: number
  close(): Promise<void>
}

async function scriptedModel(
  script: readonly string[],
  options: { status?: number; body?: (auth: string) => string } = {},
): Promise<ModelServer> {
  let calls = 0
  const server = createHttpServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      calls++
      const auth = String(req.headers['authorization'] ?? '')
      if (options.status !== undefined && options.status >= 400) {
        res.writeHead(options.status, { 'content-type': 'application/json' })
        res.end(options.body ? options.body(auth) : JSON.stringify({ error: 'nope' }))
        return
      }
      const text = script[Math.min(calls - 1, script.length - 1)] ?? ''
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { content: text } }],
          usage: { prompt_tokens: 11, completion_tokens: 13 },
        }),
      )
    })
  })

  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()))
  const port = (server.address() as AddressInfo).port

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    get calls() {
      return calls
    },
    close: () =>
      new Promise<void>((closed) => {
        server.close(() => closed())
      }),
  }
}

const EDIT_BEFORE_PLAN = JSON.stringify({
  action: 'edit',
  edits: [{ path: 'src/sneaky.ts', search: '', replace: 'export const pwned = 1\n' }],
})
const DONE = JSON.stringify({ action: 'done', text: 'stopped' })

// ── 1. ping ──────────────────────────────────────────────────────────────────

describeCli(`ping over the real pipe (Requirements 12.1, 12.2)${CLI_SKIP_NOTE}`, () => {
  it('answers ok with a version string and nothing else on stdout', async () => {
    const t = await session([request(1, 'ping')])

    expect(t.exitCode).toBe(0)
    expect(t.lines).toHaveLength(1)
    expect(t.stderr).toBe('')

    const frame = responseFor(t, 1)
    expect(frame).toEqual({
      id: 1,
      ok: true,
      result: {
        ok: true,
        engine: ENGINE_NAME,
        version: ENGINE_VERSION,
        protocol: PROTOCOL_VERSION,
        node: process.version,
        pid: expect.any(Number),
        fakeProvider: true,
      },
    })
    const result = okResult<{ version: string }>(t, 1)
    expect(result.version).toMatch(/^\d+\.\d+\.\d+/)
  }, 30_000)
}) 

// ── 2, 3, 11. a full run: shape, streaming order, stdout purity ──────────────

describeCli(`run (Requirements 12.1, 12.2, 12.5, 12.6)${CLI_SKIP_NOTE}`, () => {
  it('completes offline and returns a RunResult shape', async () => {
    const root = await makeTmp()
    const t = await session([
      request('run-1', 'run', { root, task: { id: 't1', prompt: 'build it', verify: [NOISY_PASS] } }),
    ])

    expect(t.exitCode).toBe(0)
    const result = okResult<RunResult>(t, 'run-1')
    expect(result.ok).toBe(true)
    expect(typeof result.runId).toBe('string')
    expect(result.runId).not.toBe('')
    expect(result.iterations).toBe(3)
    expect(result.finalText).toBe('Offline fixture run complete.')
    expect(result.verify.map((v) => [v.name, v.ok])).toEqual([['unit', true]])
    expect(Array.isArray(result.events)).toBe(true)
    expect(result.events.map((e) => e.kind)).toContain('run_completed')

    // The run really happened on disk: the JSONL log and the plan are both there.
    expect(await exists(join(root, '.sketch'))).toBe(true)
  }, 30_000)

  it('streams event frames DURING the run, before the response, on the response runId', async () => {
    // REQUIREMENT 12.6, and the frame ordering tasks 2.1 and 2.2 are built on.
    const root = await makeTmp()
    const t = await session([
      request(7, 'run', { root, task: { id: 't1', prompt: 'build it', verify: [NOISY_PASS] } }),
    ])

    const result = okResult<RunResult>(t, 7)
    expect(t.events.length).toBeGreaterThan(5)

    // Every event frame precedes the response frame, in the raw line order a pipe
    // consumer sees.
    const responseIndex = t.parsed.findIndex((frame) => isResponseFrame(frame))
    const lastEventIndex = t.parsed.reduce(
      (last, frame, index) => (isEventFrame(frame) ? index : last),
      -1,
    )
    expect(lastEventIndex).toBeGreaterThan(-1)
    expect(lastEventIndex).toBeLessThan(responseIndex)
    expect(responseIndex).toBe(t.parsed.length - 1)

    // Correlation: every event frame carries the run's runId, at both levels.
    for (const frame of t.events) {
      expect(frame.kind).toBe('event')
      expect(frame.runId).toBe(result.runId)
      expect(frame.event.runId).toBe(result.runId)
      expect(frame.requestId).toBe(7)
      expect(typeof frame.event.id).toBe('string')
      expect(typeof frame.event.ts).toBe('number')
      expect(typeof frame.event.kind).toBe('string')
      expect(frame.event.payload).toBeTypeOf('object')
      // An event frame is distinguishable from a response by `ok`/`id` alone.
      expect((frame as unknown as Record<string, unknown>)['ok']).toBeUndefined()
      expect((frame as unknown as Record<string, unknown>)['id']).toBeUndefined()
    }

    // The streamed sequence is the run's own sequence, in order, ids and all.
    expect(t.events.map((f) => f.event.kind)).toEqual(result.events.map((e) => e.kind))
    expect(t.events.map((f) => f.event.id)).toEqual(result.events.map((e) => e.id))
    expect(t.events[0]!.event.kind).toBe('run_started')
    expect(t.events[t.events.length - 1]!.event.kind).toBe('run_completed')
  }, 30_000)

  it('keeps stdout protocol-only across a whole mixed session (Requirement 12.5)', async () => {
    // A verify command that really writes to its own stdout and stderr runs inside
    // this session. If the runner ever inherited the parent's stdio, its bytes
    // would land between two frames and this assertion is what catches it.
    const root = await makeTmp()
    const skillDir = await makeTmp()
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: broken\n', // unterminated frontmatter: the loader throws
      'utf8',
    )

    const t = await session([
      request('a', 'ping'),
      '{ this is not json',
      request('b', 'nope-not-a-method'),
      request('c', 'capture-eval'),
      request('d', 'parse-skill', { path: join(skillDir, 'SKILL.md') }),
      request('e', 'run', { root, task: { id: 't1', prompt: 'go', verify: [NOISY_PASS] } }),
      '',
      '   ',
      request('f', 'ping'),
    ])

    expect(t.exitCode).toBe(0)
    expect(t.lines.length).toBeGreaterThan(10)

    // EVERY line is a frame, and every frame is one of the two shapes.
    for (const [index, line] of t.lines.entries()) {
      const frame: unknown = JSON.parse(line)
      expect(
        isResponseFrame(frame) || isEventFrame(frame),
        `stdout line ${index} is neither a response nor an event frame: ${line.slice(0, 200)}`,
      ).toBe(true)
      // No banner, no progress text, no partial line: a frame is a JSON object.
      expect(typeof frame).toBe('object')
      expect(line.startsWith('{')).toBe(true)
      expect(line.endsWith('}')).toBe(true)
    }
    expect(t.parsed).toHaveLength(t.lines.length)
    expect(t.responses.length + t.events.length).toBe(t.lines.length)

    // The verify child's stdout really was captured rather than inherited: the
    // bytes appear ONLY inside a frame's payload, never as a line of their own.
    expect(t.stdout).toContain('NOISE-ON-CHILD-STDOUT')
    expect(t.lines.some((line) => line.trim() === 'NOISE-ON-CHILD-STDOUT')).toBe(false)
    const noisyFrames = t.parsed.filter((frame) => JSON.stringify(frame).includes('NOISE-ON-CHILD-STDOUT'))
    expect(noisyFrames.length).toBeGreaterThan(0)

    // Diagnostics went to stderr, and stderr alone.
    expect(t.stderr).not.toContain('{"id"')
  }, 45_000)
})

// ── 4. eval ──────────────────────────────────────────────────────────────────

describeCli(`eval (Requirement 12.2)${CLI_SKIP_NOTE}`, () => {
  it('scores a case set and returns EvalResult[] with the set mean', async () => {
    const t = await session([
      request('ev', 'eval', {
        cases: [
          {
            id: 'case-pass',
            task: { id: 'et1', prompt: 'do it', verify: [NOISY_PASS] },
            checks: [{ kind: 'verify-pass' }, { kind: 'contains', text: 'Offline fixture' }],
          },
          {
            id: 'case-fail',
            task: { id: 'et2', prompt: 'do it', verify: [NOISY_PASS] },
            checks: [{ kind: 'contains', text: 'THIS-TEXT-IS-NEVER-EMITTED' }],
          },
        ],
      }),
    ])

    expect(t.exitCode).toBe(0)
    const { results, mean } = okResult<{ results: EvalResult[]; mean: number }>(t, 'ev')

    expect(Array.isArray(results)).toBe(true)
    expect(results.map((r) => [r.caseId, r.score, r.passed])).toEqual([
      ['case-pass', 1, true],
      ['case-fail', 0, false],
    ])
    expect(results[0]!.passedChecks).toBe(2)
    expect(results[0]!.totalChecks).toBe(2)
    expect(typeof results[1]!.detail).toBe('string')
    expect(mean).toBeCloseTo(0.5, 12)

    // Scoring streams too, so a UI can watch a set being scored.
    expect(t.events.map((f) => f.event.kind)).toContain('eval_scored')
  }, 45_000)
})

// ── 5. parse-skill ───────────────────────────────────────────────────────────

describeCli(`parse-skill (Requirement 12.2)${CLI_SKIP_NOTE}`, () => {
  it('returns a normalized Skill for a real SKILL.md', async () => {
    const dir = await makeTmp()
    const path = join(dir, 'SKILL.md')
    await writeFile(
      path,
      [
        '---',
        'name: context-packing',
        'description: Pack only what the task needs',
        'capabilities: [read, write]',
        '---',
        '',
        '# Context packing',
        '',
        'Rank by dependency distance, then by recency.',
        '',
      ].join('\n'),
      'utf8',
    )

    const t = await session([request('sk', 'parse-skill', { path })])

    expect(t.exitCode).toBe(0)
    const skill = okResult<Skill>(t, 'sk')
    expect(skill.name).toBe('context-packing')
    expect(skill.description).toBe('Pack only what the task needs')
    expect(skill.capabilities).toEqual(['read', 'write'])
    expect(skill.source).toBe(path)
    expect(skill.body.startsWith('# Context packing')).toBe(true)
    expect(skill.body).toContain('dependency distance')
    // Multi-line bodies stay on ONE stdout line: that is what makes the protocol
    // line-delimited at all.
    expect(skill.body).toContain('\n')
    expect(t.lines).toHaveLength(1)
  }, 30_000)

  it('reports a nonexistent path as invalid_params rather than crashing', async () => {
    const t = await session([request('sk2', 'parse-skill', { path: join(await makeTmp(), 'nope', 'SKILL.md') })])
    const frame = responseFor(t, 'sk2')
    expect(frame.ok).toBe(false)
    if (frame.ok === false) {
      expect(frame.code).toBe('invalid_params')
      expect(frame.error).toContain('does not exist')
    }
    expect(t.exitCode).toBe(0)
  }, 30_000)
})

// ── 6. capture-eval ──────────────────────────────────────────────────────────

describeCli(`capture-eval implementation (Requirement 12.2, Task 2.3)${CLI_SKIP_NOTE}`, () => {
  it('executes capture-eval method successfully over stdio', async () => {
    // `task` is part of the params because verify commands exist nowhere else:
    // a RunResult records VerifyResult, which carries no `cmd`.
    const root = await makeTmp()
    const evalsPath = join(root, 'evals.jsonl')
    const task = { id: 'task_cli_capture', prompt: 'go', verify: [NOISY_PASS] }
    const run = {
      runId: 'run_cli_capture',
      ok: true,
      finalText: 'CLI capture test',
      iterations: 1,
      verify: [{ name: NOISY_PASS.name, ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1 }],
      events: [],
    }
    const t = await session([
      request('cap', 'capture-eval', {
        run,
        task,
        evalsPath,
        want: { checks: [{ kind: 'verify-pass' }] },
      }),
    ])

    const frame = responseFor(t, 'cap')
    expect(frame.ok).toBe(true)
    if (frame.ok === true) {
      const result = frame.result as { id: string; checks: unknown[]; task: { verify: unknown[] } }
      expect(result.id).toMatch(/^eval_/)
      expect(result.checks).toEqual([{ kind: 'verify-pass' }])
      // The stored command is the real executable, never the result's name.
      expect(result.task.verify).toEqual([NOISY_PASS])
    }
    expect(readFileSync(evalsPath, 'utf8').trim().split('\n')).toHaveLength(1)
    expect(t.exitCode).toBe(0)
  }, 30_000)

  it('refuses to capture a verify-pass case it cannot replay, instead of inventing commands', async () => {
    const root = await makeTmp()
    const evalsPath = join(root, 'evals.jsonl')
    const run = {
      runId: 'run_cli_capture_no_task',
      ok: true,
      finalText: 'CLI capture test',
      iterations: 1,
      verify: [{ name: 'unit', ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1 }],
      events: [],
    }
    const t = await session([
      request('cap-bad', 'capture-eval', {
        run,
        evalsPath,
        want: { checks: [{ kind: 'verify-pass' }] },
      }),
      request('after', 'ping'),
    ])

    const frame = responseFor(t, 'cap-bad')
    expect(frame.ok).toBe(false)
    if (frame.ok === false) {
      expect(frame.error).toContain('no verify commands are available to replay')
    }
    expect(existsSync(evalsPath)).toBe(false)
    // ...and the process stays available.
    expect(responseFor(t, 'after').ok).toBe(true)
    expect(t.exitCode).toBe(0)
  }, 30_000)

  it('is a known method, so all five of Requirement 12.2 are present', () => {
    // A SUPERSET check, not an equality one. Requirement 12.2 names the five
    // methods the CLI must answer; it does not cap the table, and task 3.3 added
    // the `git-*` group the Git panel drives through this same protocol. What must
    // never happen is one of the five going missing, which is what this asserts.
    for (const required of REQUIRED_METHOD_NAMES) {
      expect(METHOD_NAMES, `Requirement 12.2 requires '${required}'`).toContain(required)
    }
    expect([...REQUIRED_METHOD_NAMES].sort()).toEqual(
      ['capture-eval', 'eval', 'parse-skill', 'ping', 'run'].sort(),
    )
  })
})

// ── 7, 8, 9, 10. resilience is CONTINUITY, not just an error frame ───────────

describeCli(`resilience (Requirements 12.3, 12.4)${CLI_SKIP_NOTE}`, () => {
  it('answers an unknown method with ok: false and still serves the next request', async () => {
    const t = await session([
      request('u1', 'teleport'),
      request('u2', 'ping'),
    ])

    const bad = responseFor(t, 'u1')
    expect(bad.ok).toBe(false)
    if (bad.ok === false) {
      expect(bad.code).toBe('unknown_method')
      expect(bad.error).toContain('teleport')
      // The message names what IS available, which is the whole point of a
      // human-readable error next to a machine-readable code.
      expect(bad.error).toContain('ping')
    }

    // CONTINUITY: the same process, the same session, served afterwards.
    expect(okResult<{ ok: boolean }>(t, 'u2').ok).toBe(true)
    expect(t.exitCode).toBe(0)
    expect(t.responses.map((r) => r.id)).toEqual(['u1', 'u2'])
  }, 30_000)

  it('answers malformed JSON with an error and still serves the next request', async () => {
    const t = await session([
      '{"id":"m1","method":"ping"',
      'not json at all',
      '[1,2,3]',
      'null',
      request('m2', 'ping'),
    ])

    // Four bad lines, four error frames, then a good one.
    expect(t.responses).toHaveLength(5)
    for (const frame of t.responses.slice(0, 4)) {
      expect(frame.ok).toBe(false)
      if (frame.ok === false) {
        expect(['malformed_json', 'invalid_request']).toContain(frame.code)
        expect(typeof frame.error).toBe('string')
        expect(frame.error).not.toBe('')
      }
      // Nothing to echo: an unidentifiable request gets a null id, never an
      // invented one.
      expect(frame.id).toBeNull()
    }

    expect(okResult<{ ok: boolean }>(t, 'm2').ok).toBe(true)
    expect(t.exitCode).toBe(0)
    expect(t.signal).toBeNull()
  }, 30_000)

  it('answers a throwing handler with ok: false and keeps the process alive', async () => {
    // A REAL throw from real code: `loadSkillFile` rejects on malformed
    // frontmatter, which is neither an InvalidParamsError nor a NotImplementedError.
    const dir = await makeTmp()
    const path = join(dir, 'SKILL.md')
    await writeFile(path, '---\nname: broken\ndescription: no closing fence\n', 'utf8')

    const t = await session([
      request('t1', 'parse-skill', { path }),
      request('t2', 'ping'),
      request('t3', 'parse-skill', { path }),
    ])

    const thrown = responseFor(t, 't1')
    expect(thrown.ok).toBe(false)
    if (thrown.ok === false) {
      expect(thrown.code).toBe('handler_error')
      expect(thrown.error).toContain('SKILL.md')
    }
    expect(okResult<{ ok: boolean }>(t, 't2').ok).toBe(true)
    expect(responseFor(t, 't3').ok).toBe(false)
    expect(t.exitCode).toBe(0)
    expect(t.signal).toBeNull()
  }, 30_000)

  it('echoes the request id on every response, including every error class', async () => {
    const t = await session([
      request(0, 'ping'), // zero is an id, not a missing one
      request('str-id', 'ping'),
      request(-42.5, 'unknown-method'),
      request('bad-params', 'run', {}),
      request('not-impl', 'capture-eval'),
      JSON.stringify({ id: 'no-method' }),
      JSON.stringify({ id: 'no-params-key', method: 'ping' }),
    ])

    expect(t.responses.map((r) => r.id)).toEqual([
      0,
      'str-id',
      -42.5,
      'bad-params',
      'not-impl',
      'no-method',
      'no-params-key',
    ])
    expect(responseFor(t, 0).ok).toBe(true)
    expect(responseFor(t, 'no-params-key').ok).toBe(true) // absent params means {}
    const invalid = responseFor(t, 'bad-params')
    expect(invalid.ok).toBe(false)
    if (invalid.ok === false) expect(invalid.code).toBe('invalid_params')
    const noMethod = responseFor(t, 'no-method')
    expect(noMethod.ok).toBe(false)
    if (noMethod.ok === false) expect(noMethod.code).toBe('invalid_request')
  }, 30_000)

  it('reads CRLF-terminated lines as one request each', async () => {
    // The dev machine and the Tauri client are both Windows: a client writing
    // \r\n must not produce a blank-line error frame per request.
    const t = await session([`${request('crlf', 'ping')}\r`])
    expect(t.responses.map((r) => r.id)).toEqual(['crlf'])
    expect(responseFor(t, 'crlf').ok).toBe(true)
  }, 30_000)
})

// ── 14, 15. lifecycle and correlation ────────────────────────────────────────

describeCli(`lifecycle and correlation (Requirement 12.1)${CLI_SKIP_NOTE}`, () => {
  it('exits 0 when stdin closes with nothing sent', async () => {
    const t = await session([])
    expect(t.exitCode).toBe(0)
    expect(t.signal).toBeNull()
    expect(t.lines).toEqual([])
    expect(t.stderr).toBe('')
  }, 30_000)

  it('exits 0 after stdin closes mid-run, having written the in-flight response', async () => {
    // The run is still going when stdin ends: a forced exit here is exactly how a
    // client loses the last frame.
    const root = await makeTmp()
    const t = await session([request('inflight', 'run', { root, task: { id: 'x', prompt: 'go', verify: [] } })])
    expect(t.exitCode).toBe(0)
    expect(okResult<RunResult>(t, 'inflight').ok).toBe(true)
    expect(t.parsed[t.parsed.length - 1]).toMatchObject({ id: 'inflight', ok: true })
  }, 30_000)

  it('correlates two overlapping requests unambiguously, and serves them in order', async () => {
    // Both requests are on the wire before the first responds. The server is
    // SEQUENTIAL: request order is response order, and every event frame between
    // a request and its response belongs to that request.
    const rootA = await makeTmp()
    const rootB = await makeTmp()
    const t = await session([
      request('A', 'run', { root: rootA, task: { id: 'a', prompt: 'first', verify: [] } }),
      request('B', 'run', { root: rootB, task: { id: 'b', prompt: 'second', verify: [] } }),
    ])

    expect(t.exitCode).toBe(0)
    expect(t.responses.map((r) => r.id)).toEqual(['A', 'B'])

    const a = okResult<RunResult>(t, 'A')
    const b = okResult<RunResult>(t, 'B')
    expect(a.runId).not.toBe(b.runId)

    // No interleaving: every frame up to A's response belongs to A, and every
    // frame after it belongs to B.
    const aIndex = t.parsed.findIndex((f) => isResponseFrame(f) && f.id === 'A')
    const bIndex = t.parsed.findIndex((f) => isResponseFrame(f) && f.id === 'B')
    expect(aIndex).toBeLessThan(bIndex)
    for (const [index, frame] of t.parsed.entries()) {
      if (!isEventFrame(frame)) continue
      const owner = index < aIndex ? 'A' : 'B'
      expect(frame.requestId).toBe(owner)
      expect(frame.runId).toBe(owner === 'A' ? a.runId : b.runId)
    }

    // Both runs really ran, in their own roots.
    expect(await exists(join(rootA, '.sketch'))).toBe(true)
    expect(await exists(join(rootB, '.sketch'))).toBe(true)
  }, 45_000)
})

// ── 12. a credential in params never reaches stdout ──────────────────────────

const CLI_TEST_KEY = 'sk-CLITEST0123456789'

describeCli(`credentials never reach stdout (Requirements 12.5, 3.7)${CLI_SKIP_NOTE}`, () => {
  it('never echoes an apiKey passed in run params, anywhere in the transcript', async () => {
    const root = await makeTmp()
    const t = await session([
      request('k1', 'run', {
        root,
        task: { id: 'k', prompt: 'go', verify: [] },
        provider: {
          id: 'custom',
          kind: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:9/v1',
          model: 'm',
          apiKey: CLI_TEST_KEY,
          headers: { 'X-Api-Key': CLI_TEST_KEY },
        },
      }),
      request('k2', 'ping'),
    ])

    expect(okResult<RunResult>(t, 'k1')).toBeTruthy()
    expect(t.stdout).not.toContain(CLI_TEST_KEY)
    expect(t.stdout).not.toContain('CLITEST')
    expect(t.stderr).not.toContain(CLI_TEST_KEY)
    // The session stayed healthy with the key registered.
    expect(okResult<{ ok: boolean }>(t, 'k2').ok).toBe(true)
  }, 30_000)

  it('redacts a credential-shaped value that an ERROR frame would otherwise quote', async () => {
    // The one leak path the event store cannot cover: an error message that quotes
    // a param back at the caller. `params.path` lands in the "does not exist"
    // diagnostic and the method name lands in the unknown-method diagnostic, so
    // the frame-level scrubber is the only thing standing between a
    // credential-shaped value there and stdout.
    const dir = await makeTmp()
    const t = await session([
      request('p', 'parse-skill', { path: join(dir, CLI_TEST_KEY, 'SKILL.md') }),
      request('m', `run-${CLI_TEST_KEY}`),
    ])

    for (const id of ['p', 'm']) {
      const frame = responseFor(t, id)
      expect(frame.ok).toBe(false)
    }
    expect(t.stdout).not.toContain(CLI_TEST_KEY)
    expect(t.stdout).not.toContain('CLITEST')
    expect(t.stdout).toContain('redacted')
  }, 30_000)

  it('never echoes the key even when the provider hands it back in an error body', async () => {
    // The realistic leak: an upstream 401 whose body quotes the Authorization
    // header, which then travels through a run_failed payload and the response's
    // finalText. Real HTTP, real 401, real key on the wire.
    const model = await scriptedModel([], {
      status: 401,
      body: (auth) => JSON.stringify({ error: { message: `invalid credentials: ${auth}` } }),
    })
    try {
      const root = await makeTmp()
      const t = await session(
        [
          request('leak', 'run', {
            root,
            task: { id: 'k', prompt: 'go', verify: [] },
            provider: {
              id: 'custom',
              kind: 'openai-compatible',
              baseUrl: model.baseUrl,
              model: 'scripted',
              apiKey: CLI_TEST_KEY,
            },
            maxIterations: 2,
          }),
        ],
        { fakeProvider: false },
      )

      expect(model.calls).toBeGreaterThan(0) // the key really went over the wire
      const result = okResult<RunResult>(t, 'leak')
      expect(result.ok).toBe(false)
      expect(result.finalText).toContain('401')
      expect(result.events.map((e) => e.kind)).toContain('run_failed')

      // The whole transcript, frames and diagnostics alike, is clean.
      expect(t.stdout).not.toContain(CLI_TEST_KEY)
      expect(t.stdout).not.toContain('CLITEST')
      expect(t.stderr).not.toContain(CLI_TEST_KEY)
      expect(t.stdout).toContain('redacted')
    } finally {
      await model.close()
    }
  }, 45_000)
})

// ── 13. the plan gate holds over the CLI ─────────────────────────────────────

describeCli(`the plan gate cannot be bypassed from outside the process (Requirement 6.5)${CLI_SKIP_NOTE}`, () => {
  it('rejects an edit that arrives before any plan and writes no file', async () => {
    // The offline fake always plans first, so this scenario needs a model that
    // does not: a loopback HTTP endpoint speaking the OpenAI-compatible shape,
    // scripted to edit on its first turn. Nothing about the CLI's params can turn
    // the gate off — that is the property under test.
    const model = await scriptedModel([EDIT_BEFORE_PLAN, DONE])
    try {
      const root = await makeTmp()
      const t = await session(
        [
          request('gate', 'run', {
            root,
            task: { id: 'gate', prompt: 'sneak an edit in', verify: [] },
            provider: {
              id: 'custom',
              kind: 'openai-compatible',
              baseUrl: model.baseUrl,
              model: 'scripted',
              apiKey: CLI_TEST_KEY,
            },
            maxIterations: 4,
          }),
        ],
        { fakeProvider: false },
      )

      expect(t.exitCode).toBe(0)
      const result = okResult<RunResult>(t, 'gate')
      const kinds = result.events.map((e) => e.kind)

      const rejected = result.events.filter((e) => e.kind === 'edit_rejected')
      expect(rejected).toHaveLength(1)
      expect(String(rejected[0]!.payload['reason'])).toBe(PLAN_GATE_REASON)
      expect(rejected[0]!.payload['paths']).toEqual(['src/sneaky.ts'])

      // NOTHING was written, and no accept event ever fired.
      expect(await exists(join(root, 'src', 'sneaky.ts'))).toBe(false)
      expect(kinds).not.toContain('edit_accepted')
      expect(kinds).not.toContain('plan_written')

      // The refusal was streamed as an event frame too, so a UI sees it live.
      expect(t.events.map((f) => f.event.kind)).toContain('edit_rejected')

      // And the run continued rather than dying on the refusal.
      expect(result.ok).toBe(true)
      expect(result.finalText).toBe('stopped')
      expect(model.calls).toBe(2)
    } finally {
      await model.close()
    }
  }, 45_000)
})

// ── dispatch as a function: no pipe, no process ──────────────────────────────

describe('the frame codec (Requirement 12.1)', () => {
  it('decodes a well-formed request, defaulting absent params to an object', () => {
    expect(parseRequest('{"id":1,"method":"ping","params":{"a":1}}')).toEqual({
      ok: true,
      request: { id: 1, method: 'ping', params: { a: 1 } },
    })
    expect(parseRequest('{"id":"x","method":"ping"}')).toEqual({
      ok: true,
      request: { id: 'x', method: 'ping', params: {} },
    })
    expect(parseRequest('{"id":"x","method":"ping","params":null}')).toMatchObject({
      ok: true,
      request: { params: {} },
    })
  })

  it('refuses everything that is not a request, without throwing', () => {
    expect(parseRequest('{')).toMatchObject({ ok: false, id: null, code: 'malformed_json' })
    expect(parseRequest('[]')).toMatchObject({ ok: false, code: 'invalid_request' })
    expect(parseRequest('null')).toMatchObject({ ok: false, code: 'invalid_request' })
    expect(parseRequest('"a string"')).toMatchObject({ ok: false, code: 'invalid_request' })
    expect(parseRequest('{"id":1}')).toMatchObject({ ok: false, id: 1, code: 'invalid_request' })
    expect(parseRequest('{"id":1,"method":"  "}')).toMatchObject({ ok: false, code: 'invalid_request' })
    expect(parseRequest('{"id":1,"method":"ping","params":[]}')).toMatchObject({
      ok: false,
      code: 'invalid_request',
    })
    // Unusable ids become null rather than being invented or echoed as garbage.
    expect(parseRequest('{"id":{"a":1},"method":"ping"}')).toMatchObject({ ok: true })
    expect(parseRequest('{"id":true,"method":"nope-no-such"}')).toMatchObject({ ok: true })
    expect(parseRequest('{"id":{"a":1},"method":"x"}')).toEqual({
      ok: true,
      request: { id: null, method: 'x', params: {} },
    })
  })

  it('keeps a frame on exactly one line whatever a payload contains', () => {
    const line = encodeFrame({
      id: 1,
      ok: true,
      result: { text: 'first\nsecond\r\nthird', tab: '\t', quote: '"}' },
    })
    expect(line).not.toContain('\n')
    expect(line.split('\n')).toHaveLength(1)
    expect(JSON.parse(line)).toMatchObject({ result: { text: 'first\nsecond\r\nthird' } })
  })

  it('discriminates the two frame shapes both ways', () => {
    const response = { id: 1, ok: true, result: 2 }
    const event = {
      kind: 'event' as const,
      runId: 'r1',
      requestId: 1,
      event: { id: 'e1', ts: 1, runId: 'r1', kind: 'run_started' as const, payload: {} },
    }
    expect(isResponseFrame(response)).toBe(true)
    expect(isEventFrame(response)).toBe(false)
    expect(isEventFrame(event)).toBe(true)
    expect(isResponseFrame(event)).toBe(false)
    expect(isResponseFrame(null)).toBe(false)
    expect(isEventFrame('event')).toBe(false)
  })
})

describe('dispatch, with the pipe replaced by an array', () => {
  interface Captured {
    out: string[]
    err: string[]
  }

  function serverWith(methods: Record<string, MethodHandler>): {
    server: ReturnType<typeof createServer>
    captured: Captured
  } {
    const captured: Captured = { out: [], err: [] }
    const server = createServer({
      writeOut: (line) => captured.out.push(line),
      writeErr: (line) => captured.err.push(line),
      env: { SKETCH_FAKE_PROVIDER: '1' },
      cwd: () => packageRoot,
      methods,
    })
    return { server, captured }
  }

  it('handles queued lines strictly in arrival order, whatever their durations', async () => {
    const order: string[] = []
    const { server, captured } = serverWith({
      slow: async () => {
        order.push('slow:start')
        await new Promise((r) => setTimeout(r, 25))
        order.push('slow:end')
        return 'slow'
      },
      fast: async () => {
        order.push('fast')
        return 'fast'
      },
    })

    void server.handleLine(JSON.stringify({ id: 1, method: 'slow' }))
    void server.handleLine(JSON.stringify({ id: 2, method: 'fast' }))
    await server.drain()

    // The slow handler finished before the fast one started: sequential, in order.
    expect(order).toEqual(['slow:start', 'slow:end', 'fast'])
    expect(captured.out.map((line) => JSON.parse(line))).toEqual([
      { id: 1, ok: true, result: 'slow' },
      { id: 2, ok: true, result: 'fast' },
    ])
    expect(server.handled).toBe(2)
  })

  it('turns a throw into an error frame and keeps draining the queue', async () => {
    const { server, captured } = serverWith({
      boom: async () => {
        throw new Error('handler exploded')
      },
      ok: async () => 'fine',
    })

    await server.handleLine(JSON.stringify({ id: 'a', method: 'boom' }))
    await server.handleLine('{ not json')
    await server.handleLine(JSON.stringify({ id: 'c', method: 'missing' }))
    await server.handleLine(JSON.stringify({ id: 'd', method: 'ok' }))
    await server.drain()

    expect(captured.out.map((line) => JSON.parse(line))).toEqual([
      { id: 'a', ok: false, error: 'handler exploded', code: 'handler_error' },
      { id: null, ok: false, error: expect.stringContaining('malformed JSON'), code: 'malformed_json' },
      { id: 'c', ok: false, error: expect.stringContaining('unknown method'), code: 'unknown_method' },
      { id: 'd', ok: true, result: 'fine' },
    ])
    expect(captured.err).toEqual([])
  })

  it('ignores blank framing noise instead of answering it', async () => {
    const { server, captured } = serverWith({ ok: async () => 'fine' })
    await server.handleLine('')
    await server.handleLine('   \t ')
    await server.drain()
    expect(captured.out).toEqual([])
    expect(server.handled).toBe(0)
  })

  it('routes handler diagnostics to stderr, never to the protocol stream', async () => {
    const { server, captured } = serverWith({
      chatty: async (_params, ctx) => {
        ctx.log('a diagnostic')
        return 'quiet'
      },
    })
    await server.handleLine(JSON.stringify({ id: 1, method: 'chatty' }))
    await server.drain()

    expect(captured.err).toEqual(['a diagnostic'])
    expect(captured.out).toHaveLength(1)
    expect(JSON.parse(captured.out[0]!)).toEqual({ id: 1, ok: true, result: 'quiet' })
  })

  it('redacts a secret a handler registered, in the response frame itself', async () => {
    const { server, captured } = serverWith({
      echo: async (params, ctx) => {
        const key = String(params['key'])
        ctx.rememberSecret(key)
        return { echoed: `upstream said: ${key}` }
      },
    })
    await server.handleLine(JSON.stringify({ id: 1, method: 'echo', params: { key: CLI_TEST_KEY } }))
    await server.drain()

    expect(captured.out[0]).not.toContain(CLI_TEST_KEY)
    expect(captured.out[0]).toContain('redacted')
  })

  it('streams an event frame that carries the runId and the requesting id', async () => {
    const { server, captured } = serverWith({
      emitter: async (_params, ctx) => {
        ctx.emitEvent({ id: 'e1', ts: 7, runId: 'run-9', kind: 'run_started', payload: { a: 1 } })
        return 'done'
      },
    })
    await server.handleLine(JSON.stringify({ id: 'req-1', method: 'emitter' }))
    await server.drain()

    expect(captured.out).toHaveLength(2)
    expect(JSON.parse(captured.out[0]!)).toEqual({
      kind: 'event',
      runId: 'run-9',
      requestId: 'req-1',
      event: { id: 'e1', ts: 7, runId: 'run-9', kind: 'run_started', payload: { a: 1 } },
    })
    expect(JSON.parse(captured.out[1]!)).toEqual({ id: 'req-1', ok: true, result: 'done' })
  })
})

// ── 12.7. bundleable to a single file ────────────────────────────────────────
//
// esbuild is not a dependency of this package (the zero-dependency rule), so this
// suite does not invoke it. It instead audits the CLI's whole module graph for the
// THREE things that make a single-file bundle break at runtime once the file is
// copied next to a Tauri binary with no `node_modules` and no `package.json`
// beside it:
//
//   1. a dynamic `import()` — esbuild cannot statically include the target;
//   2. an `import.meta.url` path assumption — resolves relative to the BUNDLE,
//      not to `src/`, so `../package.json` points at nothing;
//   3. a `package.json` read at runtime — the file is not shipped.
//
// The audit is the durable guard. Running the bundler for real is a release-time
// check; the outcome is recorded in the task notes.

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/**
 * Blank the CONTENT of string and template literals, preserving length.
 *
 * Needed because three of the five hazards below are CODE CONSTRUCTS — `import(`,
 * `import.meta`, `require(` — and a construct cannot live inside a string literal.
 * Without this, an edge label reading `${count} import(s)` (the architecture
 * generator's system view) is reported as a dynamic import, and a guard that cries
 * wolf gets deleted.
 *
 * Template SUBSTITUTIONS are deliberately left visible: `${await import(x)}` is real
 * code in a real position, so masking it would be the weakening this avoids. The two
 * string-shaped hazards — a `package.json` reference and a `.json` import — keep
 * reading the raw source, because those ARE strings.
 */
function maskLiterals(source: string): string {
  const out = source.split('')
  /** Quote characters of the literals currently open, innermost last. */
  const stack: string[] = []
  /** Brace depth of each open `${` substitution, innermost last. */
  const substitutions: number[] = []
  let braces = 0

  for (let i = 0; i < source.length; i++) {
    const char = source[i]!
    const open = stack[stack.length - 1]

    if (open === undefined) {
      if (char === "'" || char === '"' || char === '`') {
        stack.push(char)
        continue
      }
      if (char === '{') braces++
      else if (char === '}') {
        braces--
        // The substitution closed: the enclosing template resumes.
        if (substitutions.length > 0 && substitutions[substitutions.length - 1] === braces) {
          substitutions.pop()
          stack.push('`')
        }
      }
      continue
    }

    if (char === '\\') {
      out[i] = ' '
      if (i + 1 < source.length) out[i + 1] = ' '
      i++
      continue
    }
    if (char === open) {
      stack.pop()
      continue
    }
    if (open === '`' && char === '$' && source[i + 1] === '{') {
      // Leave the substitution's code visible.
      stack.pop()
      substitutions.push(braces)
      braces++
      i++
      continue
    }
    if (char !== '\n') out[i] = ' '
  }

  return out.join('')
}

/** The five bundle hazards in one source text. Shared by the audit and its self-test. */
function bundleHazards(source: string, name = 'source'): string[] {
  const hazards: string[] = []
  const code = maskLiterals(source)
  if (/\bimport\s*\(/.test(code)) hazards.push(`${name}: dynamic import()`)
  if (/\bimport\s*\.\s*meta\b/.test(code)) hazards.push(`${name}: import.meta`)
  if (/\brequire\s*\(/.test(code)) hazards.push(`${name}: require()`)
  // String-shaped hazards: read as written.
  if (/package\.json/.test(source)) hazards.push(`${name}: package.json reference`)
  if (/\bfrom\s*['"][^'"]+\.json['"]/.test(source)) hazards.push(`${name}: JSON import`)
  return hazards
}

/** Every source file reachable from `src/cli.ts` through relative imports. */
function moduleGraph(entry: string): string[] {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const source = stripComments(readFileSync(file, 'utf8'))
    for (const pattern of [/\bfrom\s*['"](\.[^'"]+)['"]/g, /\bimport\s*['"](\.[^'"]+)['"]/g]) {
      for (const match of source.matchAll(pattern)) {
        const asTs = resolve(dirname(file), match[1]!.replace(/\.js$/, '.ts'))
        if (existsSync(asTs)) queue.push(asTs)
      }
    }
  }
  return [...seen]
}

describe('esbuild bundleability (Requirement 12.7)', () => {
  const graph = moduleGraph(join(packageRoot, 'src', 'cli.ts'))

  it('reaches the whole engine from src/cli.ts', () => {
    // A guard over an empty graph is not a guard.
    expect(graph.length).toBeGreaterThan(10)
    const relative = graph.map((file) => file.slice(packageRoot.length + 1).replace(/\\/g, '/'))
    expect(relative).toContain('src/cli.ts')
    expect(relative).toContain('src/rpc/server.ts')
    expect(relative).toContain('src/loop/agent.ts')
    expect(relative).toContain('src/evals/runner.ts')
  })

  it('contains no dynamic import, no import.meta, and no runtime package.json read', () => {
    const hazards: string[] = []
    for (const file of graph) {
      hazards.push(
        ...bundleHazards(
          stripComments(readFileSync(file, 'utf8')),
          file.slice(packageRoot.length + 1).replace(/\\/g, '/'),
        ),
      )
    }

    expect(
      hazards,
      'A Tauri sidecar is one file copied next to the app binary: no node_modules, ' +
        'no package.json, and a path relative to import.meta.url that no longer exists. ' +
        'Each hazard above compiles and bundles fine and then fails at runtime in the ' +
        'shipped app.',
    ).toEqual([])
  })

  it('catches each hazard in code position, and does not flag the same words in a label', () => {
    // Still caught: the four things that actually break a copied single-file bundle.
    expect(bundleHazards("const m = await import('./late.js')")).toEqual([
      'source: dynamic import()',
    ])
    expect(bundleHazards('const here = import.meta.url')).toEqual(['source: import.meta'])
    expect(bundleHazards("const fs = require('node:fs')")).toEqual(['source: require()'])
    expect(bundleHazards("await readFile(join(dir, 'package.json'))")).toEqual([
      'source: package.json reference',
    ])
    expect(bundleHazards("import pkg from '../package.json'")).toEqual([
      'source: package.json reference',
      'source: JSON import',
    ])
    // A template SUBSTITUTION is code, so a dynamic import hiding in one is caught.
    expect(bundleHazards('const x = `${await import("./late.js")}`')).toEqual([
      'source: dynamic import()',
    ])
    // Not flagged: the words inside a literal. The architecture generator labels an
    // edge `${count} import(s)`, which is text a diagram displays, not a construct.
    expect(bundleHazards('return { label: `${count} import(s)` }')).toEqual([])
    expect(bundleHazards("const note = 'call require() at your peril'")).toEqual([])
  })

  it('imports only relative paths and node: builtins, so the bundle needs no resolver', () => {
    const bare: string[] = []
    for (const file of graph) {
      const source = stripComments(readFileSync(file, 'utf8'))
      for (const match of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
        const specifier = match[1]!
        if (!specifier.startsWith('.') && !specifier.startsWith('node:')) {
          bare.push(`${file.slice(packageRoot.length + 1)} -> '${specifier}'`)
        }
      }
    }
    expect(bare).toEqual([])
  })

  it('reports a version from a constant that survives bundling, matching package.json', () => {
    // THE DRIFT GUARD `src/rpc/version.ts` promises. `ping` must answer offline
    // from a bundle with no package.json beside it, so the version is a constant —
    // and a release bump that forgets it fails here instead of shipping a lying
    // `ping`.
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      name: string
      version: string
      bin?: Record<string, string>
    }
    expect(ENGINE_VERSION).toBe(manifest.version)
    expect(ENGINE_NAME).toBe(manifest.name)
    expect(PROTOCOL_VERSION).toBe(1)
    // And the executable the bundle is built from is the one `bin` declares.
    expect(manifest.bin?.['sketch']).toBe('./dist/cli.js')
  })

  it('starts unconditionally: cli.ts has no entry-point guard', () => {
    // An `import.meta.url === argv[1]` guard is the usual way to make an entry
    // point importable, and it silently fails to start under a bin shim or a
    // sidecar rename. `src/cli.ts` therefore just calls main().
    const source = readFileSync(join(packageRoot, 'src', 'cli.ts'), 'utf8')
    expect(stripComments(source)).toContain('main()')
    expect(stripComments(source)).not.toContain('argv')
  })
})
