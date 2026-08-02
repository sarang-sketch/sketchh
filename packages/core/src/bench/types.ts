import type { EvalCase, EvalResult } from '../types.js'
import type { StageStatus, VerifyStage } from '../verify/index.js'

export const BENCH_SUITE_VERSION = 1 as const
export const BENCH_REPORT_VERSION = 1 as const
export const NAIVE_HARNESS = { id: 'naive', version: '1' } as const
export const SKETCH_HARNESS = { id: 'sketch', version: '1' } as const

export interface BenchCase {
  id: string
  title: string
  fixture: string
  fixtureDigest: string
  eval: EvalCase
}

export interface BenchSuite {
  version: typeof BENCH_SUITE_VERSION
  id: string
  cases: BenchCase[]
}

export interface LoadedBenchSuite {
  suite: BenchSuite
  digest: string
  suitePath: string
  fixtureRoot: string
  orderedCaseIds: string[]
}

export interface BenchBudget {
  k: number
  maxCalls: number
  maxTokens: number
  attemptTimeoutMs: number
  suiteTimeoutMs: number
}

export interface HarnessIdentity {
  id: 'naive' | 'sketch'
  version: string
}
export interface BenchCall {
  tokensIn: number
  tokensOut: number
  /** Null means unpriced, never free. */
  costUsd: number | null
}

export interface BenchStageResult {
  stage: VerifyStage
  status: StageStatus
}

export type BenchAttemptStatus =
  | 'completed'
  | 'error'
  | 'timed-out'
  | 'exhausted'
  | 'skipped'

export interface BenchAttempt {
  caseId: string
  attempt: number
  seed: string
  status: BenchAttemptStatus
  evalResult: EvalResult | null
  verifyStages: BenchStageResult[]
  /** Explicit measurement. Null means the executor cannot measure it. */
  manualEdits: number | null
  calls: BenchCall[]
  durationMs: number
  detail: string
}

export interface PassDistributionBucket {
  passes: number
  cases: number
  rate: number
}

export interface BenchMetrics {
  taskCompletionRate: number
  buildSuccessRate: number | null
  testPassRate: number | null
  totalManualEdits: number | null
  meanManualEdits: number | null
  timeToCompletionMs: number | null
  totalDurationMs: number
  totalCostUsd: number | null
  totalCalls: number
  totalTokens: number
  passAt1: number
  passAtK: number
  passDistribution: PassDistributionBucket[]
}
export interface BenchReport {
  version: typeof BENCH_REPORT_VERSION
  createdAt: string
  suiteId: string
  suiteDigest: string
  orderedCaseIds: string[]
  provider: string
  model: string
  harness: HarnessIdentity
  budget: BenchBudget
  attempts: BenchAttempt[]
  metrics: BenchMetrics
}

export interface BenchAttemptExecution {
  evalResult: EvalResult
  verifyStages: BenchStageResult[]
  /** Required even when unknown; it is never inferred from edits or events. */
  manualEdits: number | null
}

export interface BenchAttemptContext {
  benchCase: BenchCase
  workspace: string
  seed: string
  attempt: number
  signal: AbortSignal
  budget: Readonly<BenchBudget>
  remaining: Readonly<{ calls: number; tokens: number; suiteMs: number }>
  recordCall(call: BenchCall): void
}

/** Offline seam: core never chooses or contacts a provider. */
export interface BenchExecutor {
  execute(context: BenchAttemptContext): Promise<BenchAttemptExecution>
}

export interface RunBenchOptions {
  suite: LoadedBenchSuite
  provider: string
  model: string
  harness: HarnessIdentity
  budget: BenchBudget
  executor: BenchExecutor
  tempRoot?: string
  keepWorkspaces?: boolean
  now?: () => number
}

export interface BenchComparison {
  baseline: BenchReport
  candidate: BenchReport
  passAt1Lift: number
  passAtKLift: number
  completionLift: number
  /** Strict: a tie is not an improvement. */
  improved: boolean
}
