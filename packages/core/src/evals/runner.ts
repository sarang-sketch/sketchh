// The eval harness — `runEval`, `runEvalSet`, `meanScore`.
//
// Built FIRST, before the things it judges, because every later claim about lift,
// reliability, and compounding is measured through this file. It is also the
// substrate the SkillOpt validation gate stands on: the trainer's whole loop is
//
//   let bestVal = meanScore(await runEvalSet(val, depsFor(best)))
//   …
//   const candVal = meanScore(await runEvalSet(val, depsFor(cand)))
//   if (candVal > bestVal) { best = cand; bestVal = candVal }   // STRICT
//
// so the shapes chosen here decide whether that gate is implementable and whether
// it can be fooled. Each judgement call below is recorded with its reason.
//
// ---------------------------------------------------------------------------
// 1. `verify-pass` WITH NO VERIFY COMMANDS → FAIL
// ---------------------------------------------------------------------------
// The loop's `RunResult.ok` is deliberately true when no verify commands were
// configured (Requirement 5.8: "all stages passed, or none were configured"),
// because a task with nothing to check has not failed. A CHECK named
// `verify-pass` is a different question: it asserts that verification happened
// and passed. If it inherited the loop's reading, an eval case whose task carries
// an empty `verify: []` would score 1.0 while verifying nothing — and since the
// trainer accepts a candidate on a strictly greater validation mean, a split full
// of such cases would hand every candidate a perfect score and turn the gate into
// a coin flip. So: `verify-pass` requires at least one verify result AND every
// result ok. Nothing verified is a failed check, with that stated in `detail`.
//
// ---------------------------------------------------------------------------
// 2. `contains` / `not-contains` SEARCH ALL ASSISTANT OUTPUT
// ---------------------------------------------------------------------------
// The searched text is `runOutputText(run)`: the run's `finalText` followed by the
// raw text of every `llm_response` event, joined by newlines. Not `finalText`
// alone. Two reasons.
//   * Sensitivity. `finalText` is one sentence from the `done` action. A skill
//     that teaches the model to reach for the right API shows up in the plan and
//     edit turns long before it shows up in the sign-off line, and the trainer can
//     only select on signal it can see.
//   * Honesty for the negative. A forbidden token (a hardcoded secret name, a
//     banned dependency, `TODO`) matters wherever the model said it, not only in
//     the last line. `not-contains` scanning every turn is the strict reading, and
//     for a safety-shaped check strict is the right default.
// Matching is a case-sensitive substring test — no normalization, no regex — so a
// captured case means exactly what its bytes say.
// One consequence needs stating here because it looks like a redaction bug from a
// distance: the searched events are already sanitized, so a check whose TARGET
// text is credential-shaped can never be answered. Both kinds fail with an
// explicit diagnostic rather than searching a log the target was scrubbed out of.
// See the block comment above `isCredentialShapedText` below.
//
// ---------------------------------------------------------------------------
// 3. A CASE WITH ZERO CHECKS SCORES 0
// ---------------------------------------------------------------------------
// `passedChecks / totalChecks` is 0/0 for an empty check list. Reading that as 1.0
// ("nothing failed") would mean an empty eval always passes, and eval cases arrive
// from `.sketch/evals/evals.jsonl` — a hand-edited or truncated line is a live
// possibility, not a theoretical one. A file of check-free cases would then score
// a perfect validation mean for every candidate, exactly the way to fool the gate.
// Throwing was the alternative; it was rejected because Requirement 7.6 makes
// resilience the harness's job, and a set must not die on one malformed case.
// So a zero-check case scores 0, `passed` is false, and `detail` says why. The
// task is NOT run: there is nothing to assert, so spending model calls and disk on
// it would be waste (and real money once the adapter is not the fake).
//
// ---------------------------------------------------------------------------
// 4. `meanScore([])` RETURNS 0
// ---------------------------------------------------------------------------
// Never NaN: the trainer calls this on a possibly-empty validation split, and NaN
// propagates through the gate's `candVal > bestVal` as `false` — which is
// accidentally safe today and silently wrong the moment anyone compares the other
// way. 0 is explicit, and under strict `>` an empty split can never accept a
// candidate (0 > 0 is false), so the incumbent is retained. That is the safe
// direction for an anti-rot gate.
//
// ---------------------------------------------------------------------------
// 5. `eval_scored` CARRIES THE TASK RUN'S runId
// ---------------------------------------------------------------------------
// A score is only meaningful next to the run that produced it. The event therefore
// uses the runId minted inside `runTask`, so `forRun(runId)` returns the whole
// story — `run_started`, the llm turns, the verify results, the terminal event,
// and the score — as one correlated slice of the log. The eval has no separate
// identity in the log; `caseId` lives in the payload. The only exception is a case
// that never produced a `RunResult` (zero checks, or a throw before the run
// returned): there is no run to correlate with, so the event carries a freshly
// minted runId and the payload flags `ran: false`.
//
// ---------------------------------------------------------------------------
// 6. ISOLATION: A FRESH WORKSPACE PER CASE, BY DEFAULT
// ---------------------------------------------------------------------------
// Cases in one set must not interfere. Run ids already separate plan directories,
// but a case that writes files would otherwise land in a shared root and case B
// could pass on bytes case A wrote. Default behavior: when `deps.root` is absent
// the harness creates its own temp directory per case (`mkdtemp`), roots a
// per-case `PlanWriter` there, and removes the whole tree afterwards. Supplying
// `root` opts out — that is how you score against a real repository — and then
// isolation is the caller's problem, which is stated rather than pretended.
// Cases run sequentially: a shared `EventStore` should read as one ordered log,
// and parallel subprocess verification makes timing-dependent flakes.
//
// ---------------------------------------------------------------------------
// 7. A FAILED RUN'S REASON IS APPENDED TO `detail`
// ---------------------------------------------------------------------------
// Requirement 7.6 asks for "the error detail" on a case that goes wrong, and the
// obvious reading — the `catch` below — only covers a throw that escapes
// `runTask`. It almost never does: the loop catches an adapter error itself and
// returns a not-ok `RunResult` whose `finalText` is `Provider error: …`. Scoring
// that run against, say, `verify-pass` produces a truthful but useless
// `detail` ("no verify command ran") that says nothing about the provider blowing
// up, so a red eval is undiagnosable and 7.6 is satisfied in letter only. When
// `RunResult.ok` is false the terminal `run_failed` reason and the run's
// `finalText` are therefore appended to `detail`. Scores and `passed` are
// untouched — a not-ok run can still satisfy every check it was given, and it is
// not this file's place to overrule the checks.
//
// Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 7.6

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { newRunId } from '../events/index.js'
import type { EventStore } from '../events/index.js'
import { runTask } from '../loop/index.js'
import type { RunTaskDeps } from '../loop/index.js'
import { DiskFileWriter } from '../orchestrator/file-writer.js'
import { PlanWriter } from '../plan/index.js'
import { redactKeyShapes } from '../secrets/index.js'
import type { Check, EvalCase, EvalResult, RunResult } from '../types.js'

/**
 * Collaborators for an eval run: a thin extension of {@link RunTaskDeps}.
 *
 * `root`, `plan`, and `files` become optional because the harness can supply a
 * per-case workspace itself (decision 6 above). Everything else is passed through
 * to `runTask` untouched, which is what makes the trainer's call site a one-liner:
 *
 * ```ts
 * const depsFor = (skill: Skill): EvalDeps => ({ adapter, events, skills: [skill] })
 * const val = meanScore(await runEvalSet(validationCases, depsFor(candidate)))
 * ```
 *
 * Only `skills` varies between candidates; nothing else has to be rebuilt.
 */
export type EvalDeps = Omit<RunTaskDeps, 'root' | 'plan' | 'files'> &
  Partial<Pick<RunTaskDeps, 'root' | 'plan' | 'files'>> & {
    /**
     * Keep the harness-created temp workspace on disk instead of deleting it.
     * Debugging aid; ignored when `root` was supplied by the caller.
     */
    keepWorkspace?: boolean
  }

/** `detail` for a case that defines no checks. */
export const EMPTY_CHECKS_DETAIL =
  'case defines no checks: an eval that asserts nothing cannot pass, so it scores 0'

/** One check's verdict, with a reason specific enough to debug from. */
export interface CheckOutcome {
  ok: boolean
  /** Human-readable identity of the check, e.g. `contains "hello"`. */
  label: string
  /** Why it passed or failed. */
  reason: string
}

/**
 * The text `contains` and `not-contains` search: `finalText` first, then every
 * assistant turn from the run's `llm_response` events, joined by newlines.
 *
 * Exported because capture-as-eval and the trainer need the same definition; two
 * readings of "the run's output" would let a captured case score differently than
 * it did when captured.
 */
export function runOutputText(run: RunResult): string {
  const parts: string[] = []
  if (run.finalText !== '') parts.push(run.finalText)
  for (const event of run.events) {
    if (event.kind !== 'llm_response') continue
    const text = event.payload.text
    if (typeof text === 'string' && text !== '') parts.push(text)
  }
  return parts.join('\n')
}

/** Short, quoted rendering of a check's target text. */
function quote(text: string, limit = 60): string {
  const shown = text.length <= limit ? text : `${text.slice(0, limit)}…`
  return JSON.stringify(shown)
}

/** Stable identity for a check, used in `detail`. */
export function checkLabel(check: Check): string {
  switch (check.kind) {
    case 'verify-pass':
      return 'verify-pass'
    case 'contains':
      return `contains ${quote(check.text)}`
    case 'not-contains':
      return `not-contains ${quote(check.text)}`
    default:
      return `unknown check ${JSON.stringify((check as { kind?: unknown }).kind)}`
  }
}

/**
 * `reason` for a `contains` / `not-contains` check whose own target text is
 * credential-shaped, and which therefore cannot be answered at all.
 */
export const UNEVALUABLE_CREDENTIAL_TARGET_REASON =
  'target text is itself credential-shaped, so redaction rewrites it out of the ' +
  'event log on the write path, before the harness can search for it: this ' +
  'assertion cannot be evaluated, and an eval that cannot be evaluated has not ' +
  'been satisfied (rewrite the check to target a non-credential-shaped string)'

/*
 * WHY A CREDENTIAL-SHAPED TARGET IS A FAILURE, NOT A SEARCH
 * ---------------------------------------------------------
 * `runOutputText` reconstructs assistant output from `run.events`, and every
 * event payload has already passed through `sanitizePayload` on the store's
 * write path (Requirement 3.7: no event payload may ever carry a secret). So a
 * secret-shaped string the model really did emit is `[redacted]` in the log by
 * the time this file sees it.
 *
 * The composite effect, if we just searched anyway:
 *   * `not-contains "sk-…"` would ALWAYS pass — a silent false negative on
 *     exactly the safety-shaped check a user writes to assert "the model never
 *     emitted a secret". It would also hand the trainer a free point on every
 *     candidate, since a validation split of such checks scores 1.0 for anyone.
 *   * `contains "sk-…"` would ALWAYS fail — the safe direction, but for a
 *     misleading reason ("not found in N characters") that teaches the user
 *     nothing about why.
 *
 * The fix is NOT to loosen redaction — do not "fix" this by making the write
 * path optional. It is to refuse a question the harness cannot answer: both
 * kinds fail with an explicit diagnostic naming the interaction.
 */
function isCredentialShapedText(text: string): boolean {
  return redactKeyShapes(text, '[redacted]') !== text
}

/** Score one check against one run. Pure — no I/O, no clock. */
export function evaluateCheck(check: Check, run: RunResult): CheckOutcome {
  const label = checkLabel(check)

  if (
    (check.kind === 'contains' || check.kind === 'not-contains') &&
    isCredentialShapedText(check.text)
  ) {
    return { ok: false, label, reason: UNEVALUABLE_CREDENTIAL_TARGET_REASON }
  }

  switch (check.kind) {
    case 'verify-pass': {
      if (run.verify.length === 0) {
        return {
          ok: false,
          label,
          reason:
            'no verify command ran, so nothing was verified ' +
            '(the case task must configure at least one verify command)',
        }
      }
      const failed = run.verify.filter((r) => !r.ok)
      if (failed.length === 0) {
        return {
          ok: true,
          label,
          reason: `all ${run.verify.length} stage(s) passed: ${run.verify
            .map((r) => r.name)
            .join(', ')}`,
        }
      }
      return {
        ok: false,
        label,
        reason: `failed stage(s): ${failed
          .map((r) => `${r.name} (exit ${r.exitCode})`)
          .join(', ')}`,
      }
    }

    case 'contains': {
      const output = runOutputText(run)
      const at = output.indexOf(check.text)
      return at >= 0
        ? { ok: true, label, reason: `found at offset ${at} of run output` }
        : {
            ok: false,
            label,
            reason: `not found in ${output.length} characters of run output`,
          }
    }

    case 'not-contains': {
      const output = runOutputText(run)
      const at = output.indexOf(check.text)
      return at < 0
        ? { ok: true, label, reason: `absent from ${output.length} characters of run output` }
        : { ok: false, label, reason: `forbidden text found at offset ${at} of run output` }
    }

    default:
      // A case read back from evals.jsonl can carry anything. An unrecognized
      // check must not pass by default and must not crash the set.
      return { ok: false, label, reason: 'unrecognized check kind; treated as a failure' }
  }
}

/** `detail` naming every failing check individually (never just a count). */
function describeOutcomes(outcomes: readonly CheckOutcome[]): string {
  const passed = outcomes.filter((o) => o.ok).length
  const head = `${passed}/${outcomes.length} checks passed`
  const failed = outcomes
    .map((outcome, index) => ({ outcome, index }))
    .filter(({ outcome }) => !outcome.ok)
  if (failed.length === 0) return head
  return `${head}; failed: ${failed
    .map(({ outcome, index }) => `[${index + 1}] ${outcome.label} — ${outcome.reason}`)
    .join('; ')}`
}

/**
 * Reason a run did not complete ok, for appending to `detail` (decision 7).
 * `undefined` for a run that completed ok, so the happy path's detail is clean.
 */
function runFailureNote(run: RunResult): string | undefined {
  if (run.ok) return undefined
  const failed = [...run.events].reverse().find((event) => event.kind === 'run_failed')
  const reason =
    failed !== undefined && typeof failed.payload.reason === 'string'
      ? failed.payload.reason
      : 'unknown'
  // First line only, capped: `finalText` already carries the redacted provider
  // message, and `detail` is read in a table cell.
  const first = run.finalText.trim().split('\n')[0] ?? ''
  const shown = first.length <= 200 ? first : `${first.slice(0, 200)}…`
  return shown === ''
    ? `run did not complete ok (${reason})`
    : `run did not complete ok (${reason}): ${shown}`
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A runId for an eval that never produced a run. Same generator as the loop's. */
function mintRunId(deps: EvalDeps): string {
  if (deps.ids) return deps.ids()
  const clock = deps.clock ?? (() => Date.now())
  return newRunId(clock())
}

async function emitScore(
  events: EventStore,
  runId: string,
  result: EvalResult,
  ran: boolean,
): Promise<void> {
  await events.emit({
    runId,
    kind: 'eval_scored',
    payload: {
      caseId: result.caseId,
      score: result.score,
      passed: result.passed,
      passedChecks: result.passedChecks,
      totalChecks: result.totalChecks,
      detail: result.detail,
      ran,
    },
  })
}

interface Scope {
  deps: RunTaskDeps
  /** Temp directory this harness created and therefore owns. */
  temp?: string
}

/** Fill in the per-case workspace: root, plan writer, file writer. */
async function resolveScope(deps: EvalDeps): Promise<Scope> {
  const temp = deps.root === undefined ? await mkdtemp(join(tmpdir(), 'sketch-eval-')) : undefined
  const root = deps.root ?? temp!
  const { keepWorkspace: _keepWorkspace, ...rest } = deps
  return {
    temp,
    deps: {
      ...rest,
      root,
      plan: deps.plan ?? new PlanWriter({ baseDir: root, events: deps.events }),
      files: deps.files ?? new DiskFileWriter(),
    },
  }
}

/**
 * Run one eval case and score it.
 *
 * Resolves for every outcome except a failing `EventStore.emit`: a case that
 * throws is recorded as score 0 carrying the error message (Requirement 7.6).
 * Emits exactly one `eval_scored` (Requirement 7.3).
 */
export async function runEval(evalCase: EvalCase, deps: EvalDeps): Promise<EvalResult> {
  const checks = evalCase.checks ?? []

  if (checks.length === 0) {
    const result: EvalResult = {
      caseId: evalCase.id,
      score: 0,
      passed: false,
      passedChecks: 0,
      totalChecks: 0,
      detail: EMPTY_CHECKS_DETAIL,
    }
    await emitScore(deps.events, mintRunId(deps), result, false)
    return result
  }

  let result: EvalResult
  let runId: string | undefined
  let owned: string | undefined

  try {
    const scope = await resolveScope(deps)
    owned = scope.temp
    const run = await runTask(evalCase.task, scope.deps)
    runId = run.runId

    const outcomes = checks.map((check) => evaluateCheck(check, run))
    const passedChecks = outcomes.filter((o) => o.ok).length
    result = {
      caseId: evalCase.id,
      score: passedChecks / checks.length,
      // `passed` needs both conditions: an all-pass verdict over zero checks is
      // not a pass, and the zero-check branch above already refuses to get here.
      passed: passedChecks === checks.length && checks.length > 0,
      passedChecks,
      totalChecks: checks.length,
      detail: [describeOutcomes(outcomes), runFailureNote(run)]
        .filter((part): part is string => part !== undefined)
        .join('; '),
    }
  } catch (err) {
    result = {
      caseId: evalCase.id,
      score: 0,
      passed: false,
      passedChecks: 0,
      totalChecks: checks.length,
      detail: `case threw before it could be scored: ${messageOf(err)}`,
    }
  } finally {
    // Only ever remove a directory this harness created.
    if (owned !== undefined && deps.keepWorkspace !== true) {
      await rm(owned, { recursive: true, force: true }).catch(() => {})
    }
  }

  // Emitted outside the try/catch so one case can never log two scores.
  await emitScore(deps.events, runId ?? mintRunId(deps), result, runId !== undefined)
  return result
}

/**
 * Score a set, in order, one case at a time.
 *
 * A throwing case records 0 and the set continues (Requirement 7.6). The only way
 * a case reaches the fallback below is an `EventStore.emit` failure inside
 * `runEval`; no second `eval_scored` is attempted in that path, since the store is
 * exactly what just failed.
 */
export async function runEvalSet(
  cases: readonly EvalCase[],
  deps: EvalDeps,
): Promise<EvalResult[]> {
  const results: EvalResult[] = []
  for (const evalCase of cases) {
    try {
      results.push(await runEval(evalCase, deps))
    } catch (err) {
      results.push({
        caseId: evalCase.id,
        score: 0,
        passed: false,
        passedChecks: 0,
        totalChecks: evalCase.checks?.length ?? 0,
        detail: `case threw and could not be logged: ${messageOf(err)}`,
      })
    }
  }
  return results
}

/**
 * Arithmetic mean of `score`. Empty input returns 0 — never NaN (decision 4).
 */
export function meanScore(results: readonly EvalResult[]): number {
  if (results.length === 0) return 0
  return results.reduce((sum, r) => sum + r.score, 0) / results.length
}
