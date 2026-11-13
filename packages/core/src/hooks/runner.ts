// Running hooks: spawn, feed stdin, enforce a deadline, read a decision.
//
// A hook is a child process, so the failure modes are the process ones: it
// does not exist, it hangs, it prints garbage, it exits non-zero. Every one of
// those is an outcome, never a throw — the runner's contract with the loop is
// that `preToolUse` always resolves, and a hook that fails resolves to "proceed".
// The one exception is an explicit PreToolUse denial: a hook that runs, answers
// in time, and says `{ "allow": false }` blocks the tool call, with its reason.
//
// Spawn rules, shared with MCP and verify: `shell: false`, argv only, resolved
// through `resolveForSpawn` so a Node `.cmd` shim on Windows still runs without
// a shell. A hook killed on timeout is killed as a group, so a hook that
// spawned its own children does not outlive the run.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { EventInput } from '../events/store.js'
import type { EventKind } from '../types.js'
import { resolveForSpawn } from '../verify/spawnTarget.js'
import { isBlocking, timeoutFor, type HooksFile } from './config.js'
import {
  MAX_HOOK_OUTPUT_BYTES,
  type HookConfig,
  type HookDecision,
  type HookEvent,
  type HookOutcome,
  type HookPayload,
  type HookRunnerLike,
} from './types.js'

/** The event kind hook outcomes are logged under. */
export const HOOK_EVENT_KIND = 'hook_run'

export interface HookRunnerOptions {
  /** Project root: the hook's working directory. */
  root: string
  /** Where outcomes are logged. Absent: outcomes go only to `log`. */
  events?: { emit(event: EventInput): Promise<void> | void }
  /** Run id stamped on every emitted outcome. */
  runId?: string
  /** Diagnostics sink. Stderr on the wire; never the event log. */
  log?: (message: string) => void
}

/**
 * Match a tool name against a hook's glob. `*` matches any run of characters
 * (including `.`), `?` matches one character, everything else is literal.
 * A missing matcher matches every tool.
 */
export function matchesTool(matcher: string | undefined, tool: string): boolean {
  if (matcher === undefined) return true
  let pattern = '^'
  for (const char of matcher) {
    if (char === '*') pattern += '.*'
    else if (char === '?') pattern += '.'
    else pattern += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${pattern}$`).test(tool)
}

/**
 * Read a hook's stdout as a decision. Only a JSON object with a boolean `allow`
 * counts; anything else — empty output, plain text, malformed JSON, a JSON
 * array — is ignored, not an error. A hook that prints diagnostics to stdout
 * must not accidentally become a denial, and a hook that prints nothing must
 * not accidentally become one either.
 */
export function parseHookDecision(stdout: string): { allow?: boolean; reason?: string } {
  const trimmed = stdout.trim()
  if (trimmed === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const record = parsed as Record<string, unknown>
  if (typeof record['allow'] !== 'boolean') return {}
  return {
    allow: record['allow'],
    ...(typeof record['reason'] === 'string' && record['reason'].trim() !== ''
      ? { reason: record['reason'].trim() }
      : {}),
  }
}

function clip(text: string): string {
  return text.length <= MAX_HOOK_OUTPUT_BYTES ? text : text.slice(-MAX_HOOK_OUTPUT_BYTES)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Run one hook command. Resolves an outcome for every failure mode. */
export async function runHookCommand(
  hook: HookConfig,
  payload: HookPayload,
  options: { cwd?: string; log?: (message: string) => void } = {},
): Promise<HookOutcome> {
  const started = Date.now()
  const name = hook.name ?? hook.event
  const deadline = timeoutFor(hook)
  const base: Omit<HookOutcome, 'ok' | 'allowed' | 'stdout' | 'stderr' | 'durationMs' | 'timedOut'> = {
    hook: name,
    event: payload.event,
  }

  let child: ChildProcess
  try {
    const target = resolveForSpawn(hook.command[0]!, hook.command.slice(1))
    child = spawn(target.cmd, target.args, {
      cwd: options.cwd,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })
  } catch (err) {
    return {
      ...base,
      ok: false,
      allowed: true,
      reason: `could not start hook ${name}: ${messageOf(err)}`,
      stdout: '',
      stderr: '',
      durationMs: Date.now() - started,
      timedOut: false,
    }
  }

  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdout = clip(`${stdout}${chunk}`)
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderr = clip(`${stderr}${chunk}`)
  })

  const outcome = await new Promise<HookOutcome>((resolve) => {
    let settled = false
    const finish = (partial: Omit<HookOutcome, 'hook' | 'event' | 'durationMs'>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...base, ...partial, durationMs: Date.now() - started })
    }
    const timer = setTimeout(() => {
      killHook(child)
      finish({
        ok: false,
        allowed: true,
        reason: `hook ${name} timed out after ${deadline}ms and was killed`,
        stdout,
        stderr,
        timedOut: true,
      })
    }, deadline)
    timer.unref?.()

    child.once('error', (err) => {
      finish({
        ok: false,
        allowed: true,
        reason: `hook ${name} could not start: ${err.message}`,
        stdout,
        stderr,
        timedOut: false,
      })
    })
    child.once('exit', (code) => {
      const decision = parseHookDecision(stdout)
      const denied =
        payload.event === 'PreToolUse' && isBlocking(hook) && decision.allow === false
      finish({
        ok: code === 0,
        allowed: !denied,
        ...(denied && decision.reason !== undefined ? { reason: decision.reason } : {}),
        ...(code !== 0 && code !== null
          ? { reason: `hook ${name} exited with code ${code}` }
          : {}),
        stdout,
        stderr,
        timedOut: false,
        exitCode: code,
      })
    })

    try {
      child.stdin?.end(JSON.stringify(payload))
    } catch (err) {
      options.log?.(`hook ${name}: could not write stdin: ${messageOf(err)}`)
    }
  })
  return outcome
}

function killHook(child: ChildProcess): void {
  const pid = child.pid
  try {
    child.stdin?.end()
  } catch {
    // Already gone.
  }
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }).unref()
    } catch {
      // Nothing further to try.
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

/**
 * Runs the hooks for one run, in config order.
 *
 * A hook failure never throws into the caller: `run` catches everything the
 * spawn path missed, and the PreToolUse verdict defaults to "proceed" on any
 * failure. Outcomes are emitted to the event store when one was supplied, under
 * kind `hook_run` — a runtime kind, not in the canonical `EventKind` union in
 * `types.ts` (that file changes only with a spec update), so it is cast at the
 * one emit site and named in the handoff. The store itself accepts any string
 * kind; a surface that filters on the canonical union will not see hook
 * outcomes, which is a known limit, not a silent loss — `log` still carries them.
 */
export class HookRunner implements HookRunnerLike {
  readonly #hooks: HookConfig[]
  readonly #options: HookRunnerOptions

  constructor(config: HooksFile, options: HookRunnerOptions) {
    this.#hooks = [...config.hooks]
    this.#options = options
  }

  /** Hook configs this runner was built from, in order. */
  get hooks(): readonly HookConfig[] {
    return this.#hooks
  }

  async runSessionStart(input: { runId?: string } = {}): Promise<HookOutcome[]> {
    return this.run('SessionStart', undefined, { runId: input.runId })
  }

  async runSessionStop(input: { runId?: string } = {}): Promise<HookOutcome[]> {
    return this.run('Stop', undefined, { runId: input.runId })
  }

  async preToolUse(
    tool: string,
    input: Record<string, unknown>,
    options: { runId?: string } = {},
  ): Promise<HookDecision> {
    const outcomes = await this.run('PreToolUse', tool, { input, runId: options.runId })
    const denied = outcomes.find((outcome) => !outcome.allowed)
    if (denied === undefined) return { allowed: true }
    return { allowed: false, reason: denied.reason ?? `hook ${denied.hook} denied the tool call` }
  }

  async postToolUse(
    tool: string,
    input: Record<string, unknown>,
    output?: string,
    options: { runId?: string } = {},
  ): Promise<void> {
    await this.run('PostToolUse', tool, { input, output, runId: options.runId })
  }

  /**
   * Run every hook matching `event` (and `tool`, for tool events), in config
   * order, and return each real outcome. This is the primitive the session /
   * pre / post helpers delegate to, and what `hooks-test` reports.
   */
  async run(
    event: HookEvent,
    tool: string | undefined,
    options: { input?: unknown; output?: string; runId?: string },
  ): Promise<HookOutcome[]> {
    const outcomes: HookOutcome[] = []
    const matching = this.#hooks.filter(
      (hook) => hook.event === event && (tool === undefined || matchesTool(hook.matcher, tool)),
    )
    for (const hook of matching) {
      const payload: HookPayload = {
        event,
        ...(tool !== undefined ? { tool } : {}),
        ...(options.input !== undefined ? { input: options.input } : {}),
        ...(options.output !== undefined ? { output: options.output } : {}),
        ...(options.runId ?? this.#options.runId !== undefined
          ? { runId: options.runId ?? this.#options.runId }
          : {}),
      }
      let outcome: HookOutcome
      try {
        outcome = await runHookCommand(hook, payload, {
          cwd: this.#options.root,
          log: this.#options.log,
        })
      } catch (err) {
        // The spawn path already resolves every failure it knows; this is the
        // belt under it, so a hook can never throw into the loop.
        outcome = {
          hook: hook.name ?? hook.event,
          event,
          ok: false,
          allowed: true,
          reason: `hook ${hook.name ?? hook.event} failed: ${messageOf(err)}`,
          stdout: '',
          stderr: '',
          durationMs: 0,
          timedOut: false,
        }
      }
      outcomes.push(outcome)
      await this.#emit(outcome, options.runId)
      if (!outcome.ok) {
        this.#options.log?.(
          `hook ${outcome.hook} (${event}) failed: ${outcome.reason ?? 'unknown reason'}`,
        )
      }
    }
    return outcomes
  }

  async #emit(outcome: HookOutcome, runId?: string): Promise<void> {
    const events = this.#options.events
    if (events === undefined) return
    try {
      await events.emit({
        runId: runId ?? this.#options.runId ?? 'hooks',
        // Runtime kind: see the class comment. The cast is confined to this site.
        kind: HOOK_EVENT_KIND as unknown as EventKind,
        payload: {
          component: 'hooks',
          hook: outcome.hook,
          event: outcome.event,
          ok: outcome.ok,
          allowed: outcome.allowed,
          ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
          durationMs: outcome.durationMs,
          ...(outcome.timedOut ? { timedOut: true } : {}),
          stdoutChars: outcome.stdout.length,
          stderrChars: outcome.stderr.length,
        },
      })
    } catch {
      // Logging must never fail the run it describes.
    }
  }
}
