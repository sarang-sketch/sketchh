// Live environment feedback: start the application, watch it, and report honestly.
//
// ── WHY THIS STAGE EXISTS ───────────────────────────────────────────────────
//
// "It compiles" is not "it runs", and green unit tests routinely mask an app that
// crashes on boot. This is the stage that notices (Requirement 23.1). It is also the
// hardest stage to keep honest, because everything it touches is a long-lived child
// process on someone else's machine.
//
// ── THE THREE VERDICTS, AND WHY THEY ARE DIFFERENT ──────────────────────────
//
//   * FAILED TO START — the process exited before it was ready, or never became
//     ready inside its timeout. Reported as a verification failure WITH THE CAPTURED
//     OUTPUT (Requirement 23.3), because the last twenty lines before a crash are
//     the whole diagnosis and a verdict without them is unactionable.
//   * RUNTIME ERROR — it started, and then said something that means it is broken.
//     The task is NOT done (Requirement 23.2).
//   * PASSED — it started, answered its probe, and survived the settle window.
//
// A fourth outcome, `skipped`, is not a failure: most projects have no runnable app
// and must not be penalised for it (Requirement 23.4).
//
// ── CAPTURE BEFORE KILL, ALWAYS ─────────────────────────────────────────────
//
// Output is accumulated as it arrives, never read after termination. A pipe read
// after the process is gone returns nothing, and "the app failed and we have no idea
// why" is the failure mode this ordering exists to prevent.
//
// ── KILL THE GROUP, NOT THE PARENT ──────────────────────────────────────────
//
// `npm run dev` is a shell-less spawn of npm, which spawns node, which spawns the
// bundler. Killing npm leaves the bundler holding the port, and the next run then
// fails with a port collision caused by the previous run. So the child is spawned
// `detached` and the whole group is killed: `process.kill(-pid)` on POSIX,
// `taskkill /T /F` on Windows.
//
// ── THE PORT TRAP ──────────────────────────────────────────────────────────
//
// If something is ALREADY listening on the port, a readiness probe succeeds
// instantly — answered by a stranger's server, not by the app under test — and the
// stage passes without ever testing anything. That is the most dangerous failure
// available here, because it is silent and green. So the port is checked BEFORE the
// app is started, and an occupied port is a failure that says so.
//
// ── PATTERN MATCHING IS A HEURISTIC AND SAYS SO ─────────────────────────────
//
// Scanning logs for `Error:` is guesswork: plenty of healthy apps log the word. The
// load-bearing signals are structural — the process exited, or the probe failed —
// and a pattern match is reported with `heuristic: true` so a caller can tell "the
// app died" from "we saw a scary line". The default pattern list is deliberately
// short and each entry is a string that essentially only appears when something is
// actually wrong.
//
// Validates: Requirements 23.1, 23.2, 23.3, 23.4

import { spawn } from 'node:child_process'
// A named type import, not an inline `import('node:child_process').ChildProcess`.
// The inline form is erased at compile time and still trips the sidecar hazard guard,
// which reads source text and cannot know a `import(` is type-only — and it is right
// to be that literal, because a real dynamic import breaks the bundled sidecar.
import type { ChildProcess } from 'node:child_process'
import { createConnection, createServer } from 'node:net'

import type { VerifyResult } from '../types.js'

/** Readiness signals. All that are given must be satisfied. */
export interface LiveReadiness {
  /**
   * A regular expression (as a string) matched against combined stdout+stderr.
   * The most reliable signal for a dev server, which prints its own URL.
   */
  output?: string
  /** A TCP port on loopback that must accept a connection. */
  port?: number
  /** A URL that must answer. Loopback only — see `assertLoopback`. */
  url?: string
}

export interface LiveCheck {
  /** Name for the result row. Defaults to `live`. */
  name?: string
  /** The program to start. Shell-less, like every spawn in this package. */
  cmd: string
  args?: string[]
  cwd?: string
  /**
   * Extra environment for the child, merged over the parent's.
   *
   * NOT a place for credentials: this value reaches the event log through the
   * policy's result payload, and the log is sanitised but not omniscient.
   */
  env?: Record<string, string>
  readyWhen?: LiveReadiness
  /** How long to wait for readiness. Default {@link DEFAULT_READY_TIMEOUT_MS}. */
  readyTimeoutMs?: number
  /**
   * How long to keep watching after readiness, for a crash that happens on the
   * first request or a few hundred milliseconds in. Default
   * {@link DEFAULT_SETTLE_MS}.
   */
  settleMs?: number
  /** An HTTP probe run once the app is ready. Loopback only. */
  probe?: { url: string; expectStatus?: number }
  /** Extra runtime-error patterns, as regular-expression strings. */
  errorPatterns?: string[]
  /** Skip this check without failing the project (Requirement 23.4). */
  skip?: boolean
}

/** Long enough for a cold bundler on a slow machine, short enough to not hang a run. */
export const DEFAULT_READY_TIMEOUT_MS = 60_000

/** Watched-after-ready window. A boot crash usually lands well inside this. */
export const DEFAULT_SETTLE_MS = 1_500

/** Hard ceiling on captured output, so a chatty server cannot exhaust memory. */
export const MAX_LIVE_OUTPUT_BYTES = 256 * 1024

/**
 * Default runtime-error patterns.
 *
 * Each is a string that essentially only appears when something is genuinely wrong,
 * chosen over the tempting broad ones (`/error/i`, `/Error:/`) that healthy servers
 * emit constantly. A false failure here trains people to ignore the stage, which is
 * worse than the stage not existing.
 */
export const DEFAULT_ERROR_PATTERNS: readonly string[] = [
  'Unhandled(?:Promise)?Rejection',
  'UnhandledPromiseRejectionWarning',
  'Uncaught (?:Exception|TypeError|ReferenceError|RangeError|SyntaxError)',
  'FATAL(?: ERROR)?:',
  'Segmentation fault',
  'panicked at',
  'Traceback \\(most recent call last\\)',
  'EADDRINUSE',
  'MODULE_NOT_FOUND',
  'Cannot find module',
]

export type LiveStatus = 'passed' | 'failed-to-start' | 'runtime-error' | 'probe-failed' | 'skipped'

export interface LiveResult {
  name: string
  status: LiveStatus
  ok: boolean
  /** Why, in words a user can act on. */
  reason: string
  /** Everything the process said, in arrival order, capped. Never read after kill. */
  output: string
  /** True when the verdict came from matching a log line rather than from a fact. */
  heuristic: boolean
  /** The pattern that matched, when one did. */
  matched?: string
  /** Exit code, when the process exited on its own. */
  exitCode?: number
  /** Milliseconds from spawn to ready. Absent when it never became ready. */
  readyMs?: number
  durationMs: number
}

/** Loopback-only guard for probe and readiness URLs. */
function assertLoopback(url: string): URL {
  const parsed = new URL(url)
  const host = parsed.hostname
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && host !== '[::1]') {
    // A verification stage that can reach the internet is a verification stage that
    // can exfiltrate, and PRIVACY.md says nothing leaves the machine unasked.
    throw new Error(
      `live check may only probe loopback, got ${host}. A verification stage that can reach ` +
        `an arbitrary host is an egress path, and this one runs automatically`,
    )
  }
  return parsed
}

/** Is something already listening there? */
export async function isPortListening(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host })
    const settle = (answer: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(answer)
    }
    socket.setTimeout(1_000)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

/** Find a port nothing is using. Exported for tests that need a free one. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** Kill the whole process group. See the header for why the parent is not enough. */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    // No shell: taskkill is spawned directly with argv.
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }).unref()
    } catch {
      // Nothing more to try; the timeout below is the backstop.
    }
    return
  }
  try {
    // Negative pid: the group, which is why the child was spawned detached.
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** First matching error pattern in `text`, or null. */
export function findRuntimeError(
  text: string,
  extra: readonly string[] = [],
): { pattern: string; line: string } | null {
  const patterns = [...DEFAULT_ERROR_PATTERNS, ...extra]
  for (const pattern of patterns) {
    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch {
      // A caller's bad pattern must not break the stage; it is reported by the
      // caller-facing diagnostic instead of throwing here.
      continue
    }
    const match = regex.exec(text)
    if (match === null) continue
    // The whole line, because the pattern alone is not a diagnosis.
    const start = text.lastIndexOf('\n', match.index) + 1
    const end = text.indexOf('\n', match.index)
    return { pattern, line: text.slice(start, end === -1 ? undefined : end).trim() }
  }
  return null
}

export interface RunLiveOptions {
  /** Project root. The child's cwd unless the check names its own. */
  root: string
  signal?: AbortSignal
}

/**
 * Start the application, decide whether it works, and always clean up.
 *
 * Never throws. Every failure path — a bad pattern, an occupied port, a spawn that
 * fails, a probe that refuses — comes back as a `LiveResult` with a reason, because
 * this runs inside a verification gauntlet and an exception there is a run that dies
 * without a verdict.
 */
export async function runLiveCheck(
  check: LiveCheck,
  options: RunLiveOptions,
): Promise<LiveResult> {
  const name = check.name ?? 'live'
  const started = Date.now()

  if (check.skip === true) {
    return {
      name,
      status: 'skipped',
      ok: true,
      reason: 'the live check is switched off for this project',
      output: '',
      heuristic: false,
      durationMs: 0,
    }
  }

  // Validate everything that can be validated before spawning anything.
  let probeUrl: URL | null = null
  let readyUrl: URL | null = null
  try {
    if (check.probe !== undefined) probeUrl = assertLoopback(check.probe.url)
    if (check.readyWhen?.url !== undefined) readyUrl = assertLoopback(check.readyWhen.url)
  } catch (err) {
    return {
      name,
      status: 'failed-to-start',
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      output: '',
      heuristic: false,
      durationMs: Date.now() - started,
    }
  }

  // THE PORT TRAP, closed before the app starts. See the header.
  const port = check.readyWhen?.port
  if (port !== undefined && (await isPortListening(port))) {
    return {
      name,
      status: 'failed-to-start',
      ok: false,
      reason:
        `port ${port} is already in use, so the readiness probe would be answered by whatever ` +
        `is already listening rather than by the app under test. Stop the other process (a dev ` +
        `server left running, or a previous verify that did not clean up) and retry`,
      output: '',
      heuristic: false,
      durationMs: Date.now() - started,
    }
  }

  let output = ''
  let truncated = false
  const append = (chunk: string): void => {
    if (truncated) return
    output += chunk
    if (output.length > MAX_LIVE_OUTPUT_BYTES) {
      output = `${output.slice(0, MAX_LIVE_OUTPUT_BYTES)}\n[output truncated at ${MAX_LIVE_OUTPUT_BYTES} bytes]`
      truncated = true
    }
  }

  let child: ChildProcess
  try {
    child = spawn(check.cmd, check.args ?? [], {
      cwd: check.cwd ?? options.root,
      // No shell, like every other spawn in this package.
      shell: false,
      // Detached so the whole group can be killed. See the header.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: check.env === undefined ? process.env : { ...process.env, ...check.env },
    })
  } catch (err) {
    return {
      name,
      status: 'failed-to-start',
      ok: false,
      reason: `could not start ${check.cmd}: ${err instanceof Error ? err.message : String(err)}`,
      output: '',
      heuristic: false,
      durationMs: Date.now() - started,
    }
  }

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)

  /** Set when the process ends on its own, which before readiness means failure. */
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null
  child.once('exit', (code, signal) => {
    exited = { code, signal }
  })
  let spawnError: string | null = null
  child.once('error', (err) => {
    spawnError = err.message
  })

  const pid = child.pid
  const finish = (result: Omit<LiveResult, 'durationMs' | 'output'>): LiveResult => {
    // CAPTURE BEFORE KILL: `output` is already accumulated, and it is snapshotted
    // here before the process goes away.
    const snapshot = output
    if (pid !== undefined && exited === null) killTree(pid)
    return { ...result, output: snapshot, durationMs: Date.now() - started }
  }

  // Read through a function, not a narrowed expression: `AbortSignal.aborted` is a
  // getter whose value changes over time, and TypeScript keeps the narrowing from the
  // first check for the rest of the function � which would make the later reads
  // provably-false and stop compiling.
  const aborted = (): boolean => options.signal?.aborted === true

  const readyTimeoutMs = check.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  const outputPattern = check.readyWhen?.output
  let outputRegex: RegExp | null = null
  if (outputPattern !== undefined) {
    try {
      outputRegex = new RegExp(outputPattern)
    } catch (err) {
      return finish({
        name,
        status: 'failed-to-start',
        ok: false,
        reason: `readyWhen.output is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`,
        heuristic: false,
      })
    }
  }

  /** Nothing configured means "ready as soon as it has not died". */
  const hasReadiness = outputRegex !== null || port !== undefined || readyUrl !== null

  const readyAt = async (): Promise<boolean> => {
    if (outputRegex !== null && !outputRegex.test(output)) return false
    if (port !== undefined && !(await isPortListening(port))) return false
    if (readyUrl !== null && !(await probeOnce(readyUrl))) return false
    return true
  }

  const deadline = started + readyTimeoutMs
  let readyMs: number | undefined
  for (;;) {
    if (aborted()) {
      return finish({
        name,
        status: 'failed-to-start',
        ok: false,
        reason: 'the run was cancelled while waiting for the application to become ready',
        heuristic: false,
      })
    }
    if (spawnError !== null) {
      return finish({
        name,
        status: 'failed-to-start',
        ok: false,
        reason: `could not start ${check.cmd}: ${spawnError}`,
        heuristic: false,
      })
    }

    const ended = exited as { code: number | null; signal: NodeJS.Signals | null } | null
    if (ended !== null) {
      // Requirement 23.3: a failure to start is a verification failure WITH output.
      const detail = ended.signal !== null ? `killed by ${ended.signal}` : `exit code ${ended.code}`
      return finish({
        name,
        status: 'failed-to-start',
        ok: false,
        reason: `the application exited before it was ready (${detail})`,
        heuristic: false,
        ...(ended.code !== null ? { exitCode: ended.code } : {}),
      })
    }

    if (!hasReadiness) {
      // Give an unconfigured app a moment to fall over, then LOOP AGAIN rather than
      // declaring it ready: `spawn` reports a missing binary asynchronously, and an
      // earlier version broke out of this loop before that error had arrived — so a
      // command that does not exist reported `passed`. The next iteration sees either
      // the error, the exit, or a process that is genuinely still running.
      await sleep(Math.min(250, readyTimeoutMs))
      if (spawnError === null && exited === null) {
        readyMs = Date.now() - started
        break
      }
      continue
    }
    if (await readyAt()) {
      readyMs = Date.now() - started
      break
    }
    if (Date.now() >= deadline) {
      return finish({
        name,
        status: 'failed-to-start',
        ok: false,
        reason:
          `the application did not become ready within ${readyTimeoutMs}ms. ` +
          describeReadiness(check.readyWhen),
        heuristic: false,
      })
    }
    await sleep(100)
  }

  // Ready. Now the probe, which is a fact rather than a guess.
  if (probeUrl !== null) {
    const status = await probeStatus(probeUrl)
    const expected = check.probe?.expectStatus
    const acceptable = expected === undefined ? status !== null && status < 500 : status === expected
    if (!acceptable) {
      return finish({
        name,
        status: 'probe-failed',
        ok: false,
        reason:
          status === null
            ? `the application was ready but ${probeUrl.href} could not be reached`
            : `${probeUrl.href} answered ${status}${expected === undefined ? ' (expected below 500)' : `, expected ${expected}`}`,
        heuristic: false,
        ...(readyMs !== undefined ? { readyMs } : {}),
      })
    }
  }

  // The settle window: a crash on first request lands here.
  const settleMs = check.settleMs ?? DEFAULT_SETTLE_MS
  const settleUntil = Date.now() + settleMs
  while (Date.now() < settleUntil) {
    if (aborted()) break
    // A spawn error can still surface here — and did, for a missing binary with no
    // readiness signal configured, which is why this check is in both loops.
    if (spawnError !== null) {
      return finish({
        name,
        status: 'failed-to-start',
        ok: false,
        reason: `could not start ${check.cmd}: ${spawnError}`,
        heuristic: false,
      })
    }
    const ended = exited as { code: number | null; signal: NodeJS.Signals | null } | null
    if (ended !== null) {
      // It started, answered, and then died. That is a runtime error, not a
      // failure to start, and the distinction matters to whoever reads the report.
      return finish({
        name,
        status: 'runtime-error',
        ok: false,
        reason: `the application exited ${settleMs}ms after becoming ready (exit code ${ended.code})`,
        heuristic: false,
        ...(ended.code !== null ? { exitCode: ended.code } : {}),
        ...(readyMs !== undefined ? { readyMs } : {}),
      })
    }
    await sleep(100)
  }

  // Last: the heuristic. Reported as one (Requirement 23.2).
  const error = findRuntimeError(output, check.errorPatterns ?? [])
  if (error !== null) {
    return finish({
      name,
      status: 'runtime-error',
      ok: false,
      reason: `the application logged a runtime error: ${error.line}`,
      heuristic: true,
      matched: error.pattern,
      ...(readyMs !== undefined ? { readyMs } : {}),
    })
  }

  return finish({
    name,
    status: 'passed',
    ok: true,
    reason: `the application started${readyMs === undefined ? '' : ` in ${readyMs}ms`} and stayed up for ${settleMs}ms with no runtime error`,
    heuristic: false,
    ...(readyMs !== undefined ? { readyMs } : {}),
  })
}

/** True when the URL answers anything at all. */
async function probeOnce(url: URL): Promise<boolean> {
  return (await probeStatus(url)) !== null
}

/** The HTTP status, or null when the request could not be made. */
async function probeStatus(url: URL): Promise<number | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5_000)
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'manual' })
      return response.status
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null
  }
}

/** What was being waited for, for a timeout message that is actionable. */
function describeReadiness(readiness: LiveReadiness | undefined): string {
  if (readiness === undefined) return 'No readiness signal was configured.'
  const parts: string[] = []
  if (readiness.output !== undefined) parts.push(`output matching /${readiness.output}/`)
  if (readiness.port !== undefined) parts.push(`a listener on port ${readiness.port}`)
  if (readiness.url !== undefined) parts.push(`${readiness.url} answering`)
  return parts.length === 0
    ? 'No readiness signal was configured.'
    : `Waiting for: ${parts.join(', ')}.`
}

/**
 * A live result as a `VerifyResult`, so it can sit in a stage beside ordinary
 * commands and be counted by the same `ok` rule.
 *
 * The captured output goes to `stderr` on a failure and `stdout` on a pass, matching
 * where a reader looks for each.
 */
export function liveResultToVerifyResult(result: LiveResult): VerifyResult {
  return {
    name: result.name,
    ok: result.ok,
    // A distinct code so a reader can tell a live verdict from a command's exit.
    exitCode: result.ok ? 0 : result.exitCode !== undefined ? result.exitCode : EXIT_LIVE_FAILED,
    stdout: result.ok ? `${result.reason}\n${result.output}` : '',
    stderr: result.ok ? '' : `${result.status}: ${result.reason}\n${result.output}`,
    durationMs: result.durationMs,
  }
}

/** Exit code reported for a live failure that produced no exit code of its own. */
export const EXIT_LIVE_FAILED = 90
