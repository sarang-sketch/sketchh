import type {
  BenchAttempt,
  BenchMetrics,
  PassDistributionBucket,
} from './types.js'

const BUILD_STAGE = 'build' as const
const TEST_STAGES = new Set(['unit', 'integration'])

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

function passed(attempt: BenchAttempt | undefined): boolean {
  // Deliberately do not derive completion from score, status, or verification.
  return attempt?.evalResult?.passed === true
}

function stageRate(attempts: readonly BenchAttempt[], kind: 'build' | 'test'): number | null {
  let measured = 0
  let successes = 0
  for (const attempt of attempts) {
    const stages = attempt.verifyStages.filter((row) =>
      kind === 'build' ? row.stage === BUILD_STAGE : TEST_STAGES.has(row.stage),
    )
    const ran = stages.filter((row) => row.status === 'passed' || row.status === 'failed')
    if (ran.length === 0) continue
    measured++
    if (ran.every((row) => row.status === 'passed')) successes++
  }
  return rate(successes, measured)
}

export function passMetrics(
  attempts: readonly BenchAttempt[],
  orderedCaseIds: readonly string[],
  k: number,
): Pick<BenchMetrics, 'passAt1' | 'passAtK' | 'passDistribution'> {
  if (!Number.isInteger(k) || k < 1) throw new Error('k must be a positive integer')
  const histogram = Array.from({ length: k + 1 }, () => 0)
  let first = 0
  let any = 0
  for (const caseId of orderedCaseIds) {
    const rows = attempts
      .filter((attempt) => attempt.caseId === caseId)
      .sort((a, b) => a.attempt - b.attempt)
    const passes = rows.slice(0, k).filter(passed).length
    histogram[passes] = (histogram[passes] ?? 0) + 1
    if (passed(rows.find((row) => row.attempt === 1))) first++
    if (passes > 0) any++
  }
  const count = orderedCaseIds.length
  const passDistribution: PassDistributionBucket[] = histogram.map((cases, passes) => ({
    passes,
    cases,
    rate: count === 0 ? 0 : cases / count,
  }))
  return {
    passAt1: count === 0 ? 0 : first / count,
    passAtK: count === 0 ? 0 : any / count,
    passDistribution,
  }
}
export function calculateBenchMetrics(
  attempts: readonly BenchAttempt[],
  orderedCaseIds: readonly string[],
  k: number,
): BenchMetrics {
  const pass = passMetrics(attempts, orderedCaseIds, k)
  const completed = attempts.filter((attempt) => passed(attempt)).length
  const measuredEdits = attempts.filter(
    (attempt) => attempt.status !== 'skipped' && attempt.status !== 'exhausted',
  )
  const editsKnown = measuredEdits.length > 0 && measuredEdits.every((attempt) => attempt.manualEdits !== null)
  const totalManualEdits = editsKnown
    ? measuredEdits.reduce((sum, attempt) => sum + attempt.manualEdits!, 0)
    : null
  const calls = attempts.flatMap((attempt) => attempt.calls)
  const totalTokens = calls.reduce((sum, call) => sum + call.tokensIn + call.tokensOut, 0)
  const costKnown = calls.every((call) => call.costUsd !== null)
  const totalCostUsd = costKnown
    ? calls.reduce((sum, call) => sum + call.costUsd!, 0)
    : null
  const completionTimes = attempts.filter(passed).map((attempt) => attempt.durationMs)

  return {
    taskCompletionRate: attempts.length === 0 ? 0 : completed / attempts.length,
    buildSuccessRate: stageRate(attempts, 'build'),
    testPassRate: stageRate(attempts, 'test'),
    totalManualEdits,
    meanManualEdits: totalManualEdits === null ? null : totalManualEdits / measuredEdits.length,
    timeToCompletionMs: completionTimes.length === 0
      ? null
      : completionTimes.reduce((sum, duration) => sum + duration, 0) / completionTimes.length,
    totalDurationMs: attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0),
    totalCostUsd,
    totalCalls: calls.length,
    totalTokens,
    ...pass,
  }
}
