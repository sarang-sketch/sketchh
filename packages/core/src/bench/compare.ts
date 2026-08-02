import { canonicalJson } from './suite.js'
import {
  NAIVE_HARNESS,
  SKETCH_HARNESS,
  type BenchComparison,
  type BenchReport,
} from './types.js'

function sameOrdered(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function assertComparableBenchReports(
  baseline: BenchReport,
  candidate: BenchReport,
): void {
  if (baseline.suiteDigest !== candidate.suiteDigest) throw new Error('benchmark suite digest mismatch')
  if (!sameOrdered(baseline.orderedCaseIds, candidate.orderedCaseIds)) {
    throw new Error('benchmark ordered case ids mismatch')
  }
  if (baseline.provider !== candidate.provider) throw new Error('benchmark provider mismatch')
  if (baseline.model !== candidate.model) throw new Error('benchmark model mismatch')
  if (baseline.budget.k !== candidate.budget.k) throw new Error('benchmark k mismatch')
  if (canonicalJson(baseline.budget) !== canonicalJson(candidate.budget)) {
    throw new Error('benchmark budget mismatch')
  }
  if (
    baseline.harness.id !== NAIVE_HARNESS.id ||
    baseline.harness.version !== NAIVE_HARNESS.version
  ) {
    throw new Error('baseline must use the current versioned naive harness')
  }
  if (
    candidate.harness.id !== SKETCH_HARNESS.id ||
    candidate.harness.version !== SKETCH_HARNESS.version
  ) {
    throw new Error('candidate must use the current versioned sketch harness')
  }
}

export function compareBenchReports(
  baseline: BenchReport,
  candidate: BenchReport,
): BenchComparison {
  assertComparableBenchReports(baseline, candidate)
  const passAtKLift = candidate.metrics.passAtK - baseline.metrics.passAtK
  return {
    baseline,
    candidate,
    passAt1Lift: candidate.metrics.passAt1 - baseline.metrics.passAt1,
    passAtKLift,
    completionLift:
      candidate.metrics.taskCompletionRate - baseline.metrics.taskCompletionRate,
    improved: passAtKLift > 0,
  }
}
