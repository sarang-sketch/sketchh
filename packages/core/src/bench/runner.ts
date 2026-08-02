import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { hashBytes } from '../registry/hash.js'
import { calculateBenchMetrics } from './metrics.js'
import {
  BENCH_REPORT_VERSION,
  type BenchAttempt,
  type BenchAttemptExecution,
  type BenchBudget,
  type BenchCall,
  type BenchReport,
  type RunBenchOptions,
} from './types.js'

export class BenchBudgetExhaustedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BenchBudgetExhaustedError'
  }
}

function validateBudget(budget: BenchBudget): void {
  for (const [key, value] of Object.entries(budget)) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`budget.${key} must be a positive integer`)
  }
  if (budget.suiteTimeoutMs < budget.attemptTimeoutMs) {
    throw new Error('budget.suiteTimeoutMs must be at least budget.attemptTimeoutMs')
  }
}

function validateCall(call: BenchCall): void {
  if (!Number.isInteger(call.tokensIn) || call.tokensIn < 0) throw new Error('call.tokensIn must be a non-negative integer')
  if (!Number.isInteger(call.tokensOut) || call.tokensOut < 0) throw new Error('call.tokensOut must be a non-negative integer')
  if (call.costUsd !== null && (!Number.isFinite(call.costUsd) || call.costUsd < 0)) {
    throw new Error('call.costUsd must be finite, non-negative, or null')
  }
}

function validateExecution(value: BenchAttemptExecution, caseId: string): void {
  if (value === null || typeof value !== 'object') throw new Error('executor returned no result')
  if (!Object.prototype.hasOwnProperty.call(value, 'manualEdits')) throw new Error('executor must explicitly report manualEdits')
  if (value.manualEdits !== null && (!Number.isInteger(value.manualEdits) || value.manualEdits < 0)) {
    throw new Error('manualEdits must be a non-negative integer or null')
  }
  if (value.evalResult?.caseId !== caseId) throw new Error('executor returned an EvalResult for another case')
  if (!Array.isArray(value.verifyStages)) throw new Error('executor must return verifyStages')
}
async function seedWorkspace(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`fixture contains a symbolic link: ${entry.name}`)
    if (entry.isDirectory()) await seedWorkspace(from, to)
    else if (entry.isFile()) await writeFile(to, await readFile(from))
  }
}

function seedFor(suiteDigest: string, caseId: string, attempt: number): string {
  return hashBytes(Buffer.from(`${suiteDigest}\0${caseId}\0${attempt}`, 'utf8'))
}

function timeout<T>(promise: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort()
      reject(new Error('benchmark attempt timed out'))
    }, ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) },
    )
  })
}

function placeholder(
  caseId: string,
  attempt: number,
  seed: string,
  status: 'exhausted' | 'skipped',
  detail: string,
): BenchAttempt {
  return {
    caseId, attempt, seed, status, evalResult: null, verifyStages: [], manualEdits: null,
    calls: [], durationMs: 0, detail,
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
export async function runBench(options: RunBenchOptions): Promise<BenchReport> {
  validateBudget(options.budget)
  if (options.provider.trim() === '' || options.model.trim() === '') throw new Error('provider and model identities are required')
  if (options.harness.version.trim() === '') throw new Error('harness version is required')
  const now = options.now ?? Date.now
  const suiteStarted = now()
  const createdAt = new Date(suiteStarted).toISOString()
  const attempts: BenchAttempt[] = []
  let spentCalls = 0
  let spentTokens = 0
  let suiteExpired = false
  let aggregateExhausted = false
  const tempParent = options.tempRoot ?? tmpdir()
  await mkdir(tempParent, { recursive: true })

  for (const benchCase of options.suite.suite.cases) {
    for (let attemptNumber = 1; attemptNumber <= options.budget.k; attemptNumber++) {
      const seed = seedFor(options.suite.digest, benchCase.id, attemptNumber)
      if (suiteExpired || now() - suiteStarted >= options.budget.suiteTimeoutMs) {
        suiteExpired = true
        attempts.push(placeholder(benchCase.id, attemptNumber, seed, 'skipped', 'suite timeout exhausted before this attempt'))
        continue
      }
      if (
        aggregateExhausted ||
        spentCalls >= options.budget.maxCalls ||
        spentTokens >= options.budget.maxTokens
      ) {
        aggregateExhausted = true
        attempts.push(placeholder(benchCase.id, attemptNumber, seed, 'exhausted', 'aggregate call or token budget exhausted before this attempt'))
        continue
      }

      const root = await mkdtemp(join(tempParent, `sketch-bench-${basename(benchCase.id)}-`))
      const workspace = join(root, 'workspace')
      const calls: BenchCall[] = []
      const attemptStarted = now()
      const controller = new AbortController()
      let active = true
      let execution: BenchAttemptExecution | null = null
      let status: BenchAttempt['status'] = 'completed'
      let detail = ''
      try {
        await seedWorkspace(join(options.suite.fixtureRoot, benchCase.fixture), workspace)
        const suiteRemaining = options.budget.suiteTimeoutMs - (now() - suiteStarted)
        const allowedMs = Math.min(options.budget.attemptTimeoutMs, suiteRemaining)
        if (allowedMs <= 0) throw new Error('benchmark attempt timed out')
        const run = options.executor.execute({
          benchCase: structuredClone(benchCase),
          workspace,
          seed,
          attempt: attemptNumber,
          signal: controller.signal,
          budget: Object.freeze({ ...options.budget }),
          remaining: Object.freeze({
            calls: options.budget.maxCalls - spentCalls,
            tokens: options.budget.maxTokens - spentTokens,
            suiteMs: suiteRemaining,
          }),
          recordCall(call): void {
            if (!active) throw new Error('attempt is no longer active')
            validateCall(call)
            const attemptTokens = calls.reduce((sum, row) => sum + row.tokensIn + row.tokensOut, 0)
            if (spentCalls + calls.length + 1 > options.budget.maxCalls) {
              throw new BenchBudgetExhaustedError('aggregate call budget exhausted')
            }
            if (spentTokens + attemptTokens + call.tokensIn + call.tokensOut > options.budget.maxTokens) {
              throw new BenchBudgetExhaustedError('aggregate token budget exhausted')
            }
            calls.push({ ...call })
          },
        })
        execution = await timeout(run, allowedMs, controller)
        validateExecution(execution, benchCase.id)
        detail = execution.evalResult.detail
      } catch (error) {
        if (error instanceof BenchBudgetExhaustedError) {
          status = 'exhausted'
          aggregateExhausted = true
        } else if (controller.signal.aborted || message(error) === 'benchmark attempt timed out') {
          status = 'timed-out'
          suiteExpired = now() - suiteStarted >= options.budget.suiteTimeoutMs
        } else {
          status = 'error'
        }
        detail = message(error)
      } finally {
        active = false
        controller.abort()
        if (!options.keepWorkspaces) await rm(root, { recursive: true, force: true }).catch(() => {})
      }
      spentCalls += calls.length
      spentTokens += calls.reduce((sum, call) => sum + call.tokensIn + call.tokensOut, 0)
      attempts.push({
        caseId: benchCase.id,
        attempt: attemptNumber,
        seed,
        status,
        evalResult: execution?.evalResult ?? null,
        verifyStages: execution?.verifyStages ?? [],
        manualEdits: execution?.manualEdits ?? null,
        calls,
        durationMs: Math.max(0, now() - attemptStarted),
        detail,
      })
    }
  }

  return {
    version: BENCH_REPORT_VERSION,
    createdAt,
    suiteId: options.suite.suite.id,
    suiteDigest: options.suite.digest,
    orderedCaseIds: [...options.suite.orderedCaseIds],
    provider: options.provider,
    model: options.model,
    harness: { ...options.harness },
    budget: { ...options.budget },
    attempts,
    metrics: calculateBenchMetrics(attempts, options.suite.orderedCaseIds, options.budget.k),
  }
}
