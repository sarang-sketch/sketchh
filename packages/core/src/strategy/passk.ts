// pass@k, and the gate that decides whether `swarm` may become a default.
//
// ── WHY THIS IS NOT A FLAG IN `runEvalSet` ──────────────────────────────────
//
// `runEvalSet` takes ONE `deps` for the whole set and runs sequentially by design, so it
// cannot express "k attempts, and the attempts may differ". Bending it would mean either a
// `k` parameter every existing caller has to ignore or a mutable deps factory smuggled
// through it. So pass@k is a sibling function that calls `runEval` k times. Nothing about
// the existing harness changes, and the two can be compared because they score identically.
//
// ── pass@k IS TWO NUMBERS AND REPORTING ONE OF THEM IS THE LIE ──────────────
//
// Requirement 25.3: report the DISTRIBUTION, not only the best case. `passAtK` — did any of
// k attempts pass — is the flattering number, and on its own it is a purchase rather than a
// result: k=10 makes almost anything look capable if you are willing to pay ten times.
// `passAt1` (mean passes per attempt) is what a user actually experiences, and
// `distribution` is the per-case pass count so a reader can see whether a 0.5 came from half
// the cases passing every time or from every case passing half the time. All three are
// always populated; there is no option to emit only the first.
//
// ── THE GATE COPIES THE TRAINER'S DISCIPLINE EXACTLY ────────────────────────
//
// Requirement 24.8: `swarm` becomes a default for a task class only after MEASURED pass@k
// lift over `single`. The comparison is strict `>` and an empty report scores 0, which are
// the same two rules the SkillOpt validation gate stands on (`evals/runner.ts`, decisions 4
// and the trainer's `candVal > bestVal`). Under those rules no data can never enable
// anything: 0 > 0 is false. That is the state this repository is actually in, and
// `shouldDefaultToSwarm` says so in words rather than defaulting to a swarm nobody measured.
//
// Validates: Requirements 24.8, 25.3

import { runEval, type EvalDeps } from '../evals/runner.js'
import type { EvalCase, EvalResult } from '../types.js'

/** One case, attempted k times. */
export interface PassAtKCase {
  caseId: string
  k: number
  /** How many of the k attempts passed every check. */
  passes: number
  /** 1 when at least one attempt passed, else 0. The flattering number. */
  passAtK: number
  /** Every attempt's score, in attempt order. */
  scores: number[]
  results: EvalResult[]
}

export interface PassAtKReport {
  k: number
  cases: PassAtKCase[]
  /** Mean over cases of `passAtK`: "at least one of k attempts passed". */
  passAtK: number
  /**
   * Mean over cases of `passes / k`: the rate a user gets from ONE attempt.
   *
   * The honest headline. A system with `passAtK` 1.0 and `passAt1` 0.1 works one time in ten
   * and costs ten times as much to look like it works.
   */
  passAt1: number
  /** Mean of every attempt's score, over every case. */
  meanScore: number
  /** Per-case pass count, in case order (Requirement 25.3). */
  distribution: number[]
  /** Total model-driven attempts this report cost. */
  attempts: number
}

/** A report over nothing. Scores 0 so it can never win a strict comparison. */
export function emptyReport(k: number): PassAtKReport {
  return { k, cases: [], passAtK: 0, passAt1: 0, meanScore: 0, distribution: [], attempts: 0 }
}

export interface PassAtKOptions {
  k: number
  /**
   * Collaborators for attempt `n` (1-based).
   *
   * A function rather than a value so a caller can vary the strategy, the adapter, or the
   * temperature per attempt — which is the whole point of k attempts. A caller that wants
   * them identical returns the same object.
   */
  deps: (attempt: number) => EvalDeps
}

/**
 * Attempt one case k times and score every attempt.
 *
 * Sequential, like `runEvalSet`, and for the same reason: a shared `EventStore` should read
 * as one ordered log, and parallel subprocess verification makes timing-dependent flakes. k
 * attempts of a case that writes files each get their own workspace, because `runEval`
 * creates one per call unless `root` was supplied.
 *
 * `k < 1` is clamped to 1: zero attempts is not a measurement, and returning a 0 for it
 * would put an unmeasured case into a distribution as though it had failed.
 */
export async function passAtK(
  evalCase: EvalCase,
  options: PassAtKOptions,
): Promise<PassAtKCase> {
  const k = Math.max(1, Math.floor(options.k))
  const results: EvalResult[] = []
  for (let attempt = 1; attempt <= k; attempt++) {
    results.push(await runEval(evalCase, options.deps(attempt)))
  }
  const passes = results.filter((result) => result.passed).length
  return {
    caseId: evalCase.id,
    k,
    passes,
    passAtK: passes > 0 ? 1 : 0,
    scores: results.map((result) => result.score),
    results,
  }
}

/** Attempt every case k times. Order is the input order, so two reports line up. */
export async function passAtKSet(
  cases: readonly EvalCase[],
  options: PassAtKOptions,
): Promise<PassAtKReport> {
  const k = Math.max(1, Math.floor(options.k))
  if (cases.length === 0) return emptyReport(k)

  const scored: PassAtKCase[] = []
  for (const evalCase of cases) {
    scored.push(await passAtK(evalCase, { ...options, k }))
  }

  const allScores = scored.flatMap((entry) => entry.scores)
  return {
    k,
    cases: scored,
    passAtK: scored.reduce((sum, entry) => sum + entry.passAtK, 0) / scored.length,
    passAt1: scored.reduce((sum, entry) => sum + entry.passes / entry.k, 0) / scored.length,
    meanScore:
      allScores.length === 0
        ? 0
        : allScores.reduce((sum, score) => sum + score, 0) / allScores.length,
    distribution: scored.map((entry) => entry.passes),
    attempts: allScores.length,
  }
}

export interface Lift {
  /** `candidate.passAtK - baseline.passAtK`. Negative is a regression. */
  passAtK: number
  /** The same for the single-attempt rate — usually the one that moves less. */
  passAt1: number
  meanScore: number
  /** True only on a strictly better pass@k. */
  better: boolean
  /** Why it is or is not better, including when the two are not comparable. */
  reason: string
}

/**
 * Lift of `candidate` over `baseline`.
 *
 * REFUSES TO COMPARE two reports that are not comparable: a different k, a different case
 * count, or a different set of case ids. A pass@10 report beating a pass@1 report is not
 * lift, it is a bigger budget, and quietly subtracting the two numbers is how that gets
 * shipped as a result. Requirement 25.3 is the same rule at the reporting layer: k is fixed
 * and stated.
 */
export function liftOver(baseline: PassAtKReport, candidate: PassAtKReport): Lift {
  const deltas = {
    passAtK: candidate.passAtK - baseline.passAtK,
    passAt1: candidate.passAt1 - baseline.passAt1,
    meanScore: candidate.meanScore - baseline.meanScore,
  }

  if (baseline.cases.length === 0 || candidate.cases.length === 0) {
    return {
      ...deltas,
      better: false,
      reason: 'one of the reports scored no cases, so there is nothing to compare',
    }
  }
  if (baseline.k !== candidate.k) {
    return {
      ...deltas,
      better: false,
      reason:
        `k differs (${baseline.k} versus ${candidate.k}); a larger k is a larger budget, not ` +
        'lift, so these two are not comparable',
    }
  }
  const baselineIds = baseline.cases.map((entry) => entry.caseId).join('\u0000')
  const candidateIds = candidate.cases.map((entry) => entry.caseId).join('\u0000')
  if (baselineIds !== candidateIds) {
    return {
      ...deltas,
      better: false,
      reason: 'the two reports scored different cases, so the difference is not lift',
    }
  }

  // STRICT. A tie retains the incumbent, which for Requirement 24.8 means the cheap default
  // stays. Same discipline as the SkillOpt gate's `candVal > bestVal`.
  const better = candidate.passAtK > baseline.passAtK
  return {
    ...deltas,
    better,
    reason: better
      ? `pass@${candidate.k} rose from ${baseline.passAtK.toFixed(3)} to ` +
        `${candidate.passAtK.toFixed(3)} over ${candidate.cases.length} case(s)`
      : `pass@${candidate.k} did not rise (${baseline.passAtK.toFixed(3)} to ` +
        `${candidate.passAtK.toFixed(3)}); a tie retains the cheaper default`,
  }
}

export interface SwarmDefaultVerdict {
  enable: boolean
  reason: string
  lift: Lift
}

/**
 * Requirement 24.8, as a function.
 *
 * `swarm` may become the default for a task class ONLY on measured pass@k lift over
 * `single`. Everything else — no data, an incomparable pair, a tie, a regression — leaves it
 * off, and the reason says which. There is no override parameter, because a caller who could
 * pass `force: true` would, and the requirement would become a comment.
 */
export function shouldDefaultToSwarm(
  single: PassAtKReport,
  swarm: PassAtKReport,
): SwarmDefaultVerdict {
  const lift = liftOver(single, swarm)
  if (!lift.better) {
    return {
      enable: false,
      reason: `swarm stays off: ${lift.reason}`,
      lift,
    }
  }
  return {
    enable: true,
    reason:
      `swarm may default for this task class: ${lift.reason}. Single-attempt rate moved ` +
      `${lift.passAt1 >= 0 ? '+' : ''}${lift.passAt1.toFixed(3)}, and the swarm cost ` +
      `${swarm.attempts} attempt(s) against single's ${single.attempts}`,
    lift,
  }
}
