// Verify runner — spawns verification commands without a shell.
//
// This is the hardened replacement for the legacy `src/verifier/command-runner.ts`
// path (which still uses `shell: true` for the old `Verifier`). Here `shell` is
// always `false`: command names and arguments are handed to the OS as an argv
// vector, so a model- or config-supplied string like `&& rm -rf /` is a literal
// argument and never an injection vector.
//
// Guarantees:
//   - the returned promise ALWAYS settles: timeout, spawn failure, and abort all
//     resolve a failing VerifyResult rather than rejecting or hanging
//   - exit code, stdout, stderr, and wall-clock duration are always captured
//   - captured output is capped so a runaway process cannot exhaust memory
//   - `verify_started` is emitted BEFORE the process is spawned and
//     `verify_result` after it settles, per the "announce before acting" rule
//
// Validates: Requirements 4.1, 4.2, 4.6

import { spawn, type ChildProcess } from 'node:child_process'
import type { VerifyCommand, VerifyResult } from '../types.js'

/**
 * Minimal event-emitting collaborator. Deliberately structural and local so the
 * runner does not depend on the concrete `EventStore` implementation; the real
 * store satisfies this shape and can be injected directly.
 */
export interface VerifyEventSink {
  emit(e: {
    runId: string
    kind: 'verify_started' | 'verify_result'
    payload: Record<string, unknown>
  }): void | Promise<void>
}

export interface RunCommandOptions {
  /** Optional event sink. When absent the runner is silent. */
  sink?: VerifyEventSink
  /** Run identifier stamped on emitted events. */
  runId?: string
  /** Timeout applied when a command does not declare its own `timeoutMs`. */
  defaultTimeoutMs?: number
  /** Per-stream cap on captured output, in bytes. */
  maxOutputBytes?: number
  /** Cancels the remaining work; an in-flight process is killed. */
  signal?: AbortSignal
  /** Environment for the child. Defaults to the parent environment. */
  env?: NodeJS.ProcessEnv
}

/** Default per-command timeout: 120s, matching the legacy runner's budget. */
export const DEFAULT_TIMEOUT_MS = 120_000

/**
 * Default per-stream capture cap: 1 MiB. Enough for a full test-suite failure
 * report, small enough that a process printing in a loop cannot grow the heap
 * without bound. Override with `maxOutputBytes`.
 */
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576

/** Conventional exit code for "killed after exceeding its time limit". */
export const EXIT_TIMEOUT = 124
/** Conventional exit code for "command could not be executed". */
export const EXIT_SPAWN_FAILED = 127
/** Exit code reported when the caller aborted the run. */
export const EXIT_ABORTED = 130
/** Exit code reported when the child died from a signal without a status. */
export const EXIT_SIGNALLED = 137

/** A byte-capped accumulator for one output stream. */
class CappedBuffer {
  private parts: string[] = []
  private bytes = 0
  private truncated = false

  constructor(private readonly cap: number) {}

  push(chunk: string): void {
    if (this.truncated) return
    const size = Buffer.byteLength(chunk, 'utf8')
    if (this.bytes + size <= this.cap) {
      this.parts.push(chunk)
      this.bytes += size
      return
    }
    // Keep the prefix that still fits, then stop accumulating for good.
    const room = this.cap - this.bytes
    if (room > 0) this.parts.push(chunk.slice(0, room))
    this.bytes = this.cap
    this.truncated = true
  }

  toString(): string {
    const text = this.parts.join('')
    return this.truncated
      ? `${text}\n[output truncated at ${this.cap} bytes]`
      : text
  }
}

/**
 * Best-effort hard kill.
 *
 * POSIX: `SIGKILL` to the child. Windows: Node maps every signal to
 * `TerminateProcess`, which ends the child but leaves any grandchildren behind,
 * so we ask `taskkill /T /F` to take down the tree first and fall back to
 * `child.kill('SIGKILL')` shortly after in case `taskkill` is unavailable.
 *
 * Residual limitation: a child that spawns its own detached grandchildren can
 * still orphan them on POSIX (we do not create a process group, because doing so
 * would change stdio and signal semantics for every command). Callers that need
 * group semantics should wrap the command themselves.
 */
function hardKill(child: ChildProcess): void {
  const pid = child.pid
  if (child.exitCode !== null || child.signalCode !== null) return

  if (process.platform === 'win32' && pid !== undefined) {
    try {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.on('error', () => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      })
      killer.unref()
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    // Fallback if taskkill did not finish the job. Unref'd so it never keeps the
    // event loop alive on its own.
    const fallback = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, 250)
    fallback.unref?.()
    return
  }

  try {
    child.kill('SIGKILL')
  } catch {
    /* already gone */
  }
}

async function emitSafely(
  sink: VerifyEventSink | undefined,
  runId: string,
  kind: 'verify_started' | 'verify_result',
  payload: Record<string, unknown>,
): Promise<void> {
  if (!sink) return
  try {
    await sink.emit({ runId, kind, payload })
  } catch {
    // A broken sink must never fail verification.
  }
}

function failure(
  command: VerifyCommand,
  exitCode: number,
  stdout: string,
  stderr: string,
  durationMs: number,
): VerifyResult {
  return { name: command.name, ok: false, exitCode, stdout, stderr, durationMs }
}

/**
 * Run one command to completion. Never rejects.
 */
export async function runCommand(
  command: VerifyCommand,
  opts: RunCommandOptions = {},
): Promise<VerifyResult> {
  const runId = opts.runId ?? 'unknown'
  const timeoutMs = command.timeoutMs ?? opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const cap = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const args = command.args ?? []

  await emitSafely(opts.sink, runId, 'verify_started', {
    name: command.name,
    cmd: command.cmd,
    args,
    cwd: command.cwd,
    timeoutMs,
  })

  const started = Date.now()
  const result = await new Promise<VerifyResult>(resolve => {
    if (opts.signal?.aborted) {
      resolve(
        failure(
          command,
          EXIT_ABORTED,
          '',
          `[aborted before '${command.name}' started]`,
          Date.now() - started,
        ),
      )
      return
    }

    const stdout = new CappedBuffer(cap)
    const stderr = new CappedBuffer(cap)
    let settled = false
    let child: ChildProcess

    try {
      child = spawn(command.cmd, args, {
        cwd: command.cwd,
        env: opts.env,
        // Non-negotiable: no shell means no shell metacharacter interpretation.
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve(
        failure(
          command,
          EXIT_SPAWN_FAILED,
          '',
          `[failed to spawn '${command.cmd}'] ${(err as Error).message}`,
          Date.now() - started,
        ),
      )
      return
    }

    const cleanup = (): void => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }

    // Detach from the child's plumbing so a killed-but-lingering process cannot
    // hold the event loop open after we have already reported.
    const abandon = (): void => {
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.removeAllListeners('close')
      child.removeAllListeners('exit')
      child.on('error', () => {})
      child.unref()
    }

    const settle = (r: VerifyResult, kill: boolean): void => {
      if (settled) return
      settled = true
      cleanup()
      if (kill) {
        hardKill(child)
        abandon()
      }
      resolve(r)
    }

    const timer = setTimeout(() => {
      settle(
        failure(
          command,
          EXIT_TIMEOUT,
          stdout.toString(),
          `${stderr.toString()}\n[timed out after ${timeoutMs}ms; process killed with SIGKILL]`,
          Date.now() - started,
        ),
        true,
      )
    }, timeoutMs)

    function onAbort(): void {
      settle(
        failure(
          command,
          EXIT_ABORTED,
          stdout.toString(),
          `${stderr.toString()}\n[aborted; process killed with SIGKILL]`,
          Date.now() - started,
        ),
        true,
      )
    }

    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => stdout.push(d))
    child.stderr?.on('data', (d: string) => stderr.push(d))

    child.on('error', err => {
      // Fires for ENOENT/EACCES on a missing or unexecutable binary.
      settle(
        failure(
          command,
          EXIT_SPAWN_FAILED,
          stdout.toString(),
          `${stderr.toString()}\n[failed to spawn '${command.cmd}'] ${err.message}`,
          Date.now() - started,
        ),
        false,
      )
    })

    child.on('close', (code, signal) => {
      const exitCode = code ?? (signal ? EXIT_SIGNALLED : 1)
      const tail = signal ? `\n[terminated by ${signal}]` : ''
      settle(
        {
          name: command.name,
          ok: exitCode === 0,
          exitCode,
          stdout: stdout.toString(),
          stderr: stderr.toString() + tail,
          durationMs: Date.now() - started,
        },
        false,
      )
    })
  })

  await emitSafely(opts.sink, runId, 'verify_result', { ...result })
  return result
}

/**
 * Run commands one after another, in order. Stops early when the signal aborts
 * and returns the results gathered so far.
 */
export async function runCommands(
  commands: VerifyCommand[],
  opts: RunCommandOptions = {},
): Promise<VerifyResult[]> {
  const results: VerifyResult[] = []
  for (const command of commands) {
    if (opts.signal?.aborted) break
    results.push(await runCommand(command, opts))
  }
  return results
}
