// Capture a completed run as a replayable eval case (Requirement 8.1, 8.2, 8.4).
//
// ---------------------------------------------------------------------------
// THE CONTRACT GAP THIS FILE EXISTS AROUND
// ---------------------------------------------------------------------------
// `RunResult` alone is NOT enough to capture a replayable case. Its `verify`
// field is `VerifyResult[]` — `{ name, ok, exitCode, stdout, stderr, durationMs }`
// — which records what verification SAID, not what it RAN. The executable and
// its arguments live only in `VerifyCommand` (`{ name, cmd, args?, cwd?,
// timeoutMs? }`), i.e. on the original `Task`.
//
// So a capture that reads only the run has two options: invent commands, or
// admit it has none. Inventing them (`cmd: result.name`) is the trap this file
// used to fall into: `cmd: "unit"` is not an executable, the replay's spawn
// fails, `verify-pass` fails, and Requirement 8.2 ("a captured case re-scores to
// 1.0") is met on paper only. Hence the signature: the original `Task` is a
// positional argument the caller must supply — or explicitly pass `null` to
// state it has none.
//
// ---------------------------------------------------------------------------
// WHAT A CAPTURE WILL NOT DO
// ---------------------------------------------------------------------------
// A captured case must be honest about what it can assert:
//   * With no verify commands to replay, a `verify-pass` check is unsatisfiable
//     — the harness fails it by design ("nothing was verified"). It is therefore
//     DROPPED, not carried. A case that cannot verify must not claim it can.
//   * With verify commands whose recorded results FAILED, `verify-pass` is
//     equally a lie about the observation, so it is dropped too. Capture pins
//     down behaviour that happened; it does not encode an aspiration.
//   * If dropping leaves no checks at all, the capture THROWS
//     ({@link CaptureNotReplayableError}) instead of appending a case that can
//     only ever score 0. `.sketch/evals/evals.jsonl` feeds the SkillOpt
//     validation split; a permanently-0 case there is noise every candidate
//     carries, so refusing loudly beats writing junk quietly.
//
// Secret material never reaches the file: the stored task goes through
// `sanitizePayload` with `secretsFromEnv()` (Requirement 8.4).
//
// Validates: Requirements 8.1, 8.2, 8.4

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { sanitizePayload, secretsFromEnv } from '../events/redact.js'
import type { Check, EvalCase, RunResult, Task, VerifyCommand } from '../types.js'

export interface CaptureOptions {
  /** Checks to store. Defaults to the strongest set the run actually supports. */
  checks?: Check[]
  /** Target JSONL file. Defaults to `<cwd>/.sketch/evals/evals.jsonl`. */
  evalsPath?: string
  /** Prompt to store when no `Task` was supplied. */
  fallbackPrompt?: string
}

/** Prompt stored for a capture made without the originating `Task`. */
export const FALLBACK_PROMPT = 'Captured run evaluation task'

/**
 * Thrown when nothing honest is left to assert, so no case is written.
 *
 * `reasons` lists why each requested check was refused — the message is built
 * from it and is meant to be shown to the caller verbatim.
 */
export class CaptureNotReplayableError extends Error {
  readonly reasons: readonly string[]

  constructor(reasons: readonly string[]) {
    super(
      'refusing to capture an eval case with no satisfiable checks: ' +
        reasons.join('; ') +
        '. Pass the originating Task (with its verify commands) or supply ' +
        'options.checks with an assertion this run can actually satisfy.',
    )
    this.name = 'CaptureNotReplayableError'
    this.reasons = reasons
  }
}

/**
 * Why `verify-pass` cannot be carried by this capture, or `undefined` if it can.
 */
function verifyPassObstacle(
  run: RunResult,
  commands: readonly VerifyCommand[],
): string | undefined {
  if (commands.length === 0) {
    return (
      'verify-pass was dropped because no verify commands are available to replay ' +
      '(a RunResult records VerifyResult, which carries no cmd; the commands live ' +
      'on the originating Task)'
    )
  }
  if (run.verify.length === 0) {
    return 'verify-pass was dropped because the run never executed a verify command'
  }
  const failed = run.verify.filter((result) => !result.ok)
  if (failed.length > 0) {
    return (
      'verify-pass was dropped because the run\'s verification failed: ' +
      failed.map((result) => `${result.name} (exit ${result.exitCode})`).join(', ')
    )
  }
  return undefined
}

/** Deterministic-shaped, collision-resistant case id. */
function newCaseId(): string {
  return `eval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Append an `EvalCase` derived from a completed run to `.sketch/evals/evals.jsonl`.
 *
 * @param run The completed run to capture.
 * @param task The `Task` that produced it, or `null` to state there is none.
 *             Verify commands can only come from here.
 * @param options Checks, target path, fallback prompt.
 * @throws CaptureNotReplayableError when no requested check is satisfiable.
 */
export async function captureRunAsEval(
  run: RunResult,
  task: Task | null,
  options: CaptureOptions = {},
): Promise<EvalCase> {
  const commands: VerifyCommand[] = task?.verify ?? []
  const obstacle = verifyPassObstacle(run, commands)

  const requested: Check[] =
    options.checks !== undefined && options.checks.length > 0
      ? options.checks
      : obstacle === undefined
        ? [{ kind: 'verify-pass' }]
        : []

  const reasons: string[] = []
  const checks = requested.filter((check) => {
    if (check.kind !== 'verify-pass' || obstacle === undefined) return true
    reasons.push(obstacle)
    return false
  })

  if (checks.length === 0) {
    if (reasons.length === 0 && obstacle !== undefined) reasons.push(obstacle)
    if (reasons.length === 0) reasons.push('no checks were requested')
    throw new CaptureNotReplayableError(reasons)
  }

  const baseTask: Task = {
    id: task?.id ?? run.runId,
    prompt: task?.prompt ?? options.fallbackPrompt ?? FALLBACK_PROMPT,
    verify: commands,
    ...(task?.skillNames !== undefined ? { skillNames: task.skillNames } : {}),
  }

  const sanitizedTask = sanitizePayload(
    baseTask as unknown as Record<string, unknown>,
    secretsFromEnv(),
  ) as unknown as Task

  const evalCase: EvalCase = { id: newCaseId(), task: sanitizedTask, checks }

  const targetPath =
    options.evalsPath ?? join(process.cwd(), '.sketch', 'evals', 'evals.jsonl')
  await mkdir(dirname(targetPath), { recursive: true })
  await appendFile(targetPath, `${JSON.stringify(evalCase)}\n`, 'utf8')

  return evalCase
}
