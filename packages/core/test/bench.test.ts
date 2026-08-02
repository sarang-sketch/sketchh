import { afterEach, describe, expect, it } from 'vitest'
import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  NAIVE_HARNESS,
  SKETCH_HARNESS,
  calculateBenchMetrics,
  compareBenchReports,
  createOfflineBenchExecutor,
  latestBenchArtifactPath,
  loadBenchArtifact,
  loadBenchSuite,
  parseBenchReport,
  parseBenchSuite,
  runBench,
  writeBenchArtifact,
  type BenchBudget,
  type BenchReport,
} from '../src/bench/index.js'

const suitePath = fileURLToPath(new URL('../bench/suite.json', import.meta.url))
const roots: string[] = []
const budget: BenchBudget = {
  k: 2,
  maxCalls: 20,
  maxTokens: 20_000,
  attemptTimeoutMs: 1_000,
  suiteTimeoutMs: 10_000,
}

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true })
})

async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sketch-bench-test-'))
  roots.push(root)
  return root
}
describe('versioned benchmark suites', () => {
  it('loads the committed suite and verifies every pinned fixture digest', async () => {
    const loaded = await loadBenchSuite(suitePath)
    expect(loaded.suite.version).toBe(1)
    expect(loaded.orderedCaseIds).toEqual(['repair-addition', 'repair-greeting'])
    expect(loaded.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('rejects empty and unverifiable cases instead of awarding a vacuous pass', () => {
    const base = {
      version: 1,
      id: 'bad',
      cases: [{
        id: 'case', title: 'Case', fixture: 'fixture',
        fixtureDigest: `sha256:${'0'.repeat(64)}`,
        eval: {
          id: 'case',
          task: { id: 'case', prompt: 'Do it', verify: [{ name: 'unit', cmd: 'node' }] },
          checks: [],
        },
      }],
    }
    expect(() => parseBenchSuite(base)).toThrow(/checks must be non-empty/)
    base.cases[0]!.eval.checks = [{ kind: 'contains', text: 'anything' }] as never[]
    expect(() => parseBenchSuite(base)).toThrow(/verify-pass check is required/)
  })

  it('rejects fixture drift', async () => {
    const root = await temp()
    const loaded = await loadBenchSuite(suitePath)
    await cp(loaded.fixtureRoot, join(root, 'fixtures'), { recursive: true })
    const suite = JSON.parse(await readFile(suitePath, 'utf8')) as Record<string, unknown>
    const cases = suite.cases as Array<Record<string, unknown>>
    cases[0]!.fixtureDigest = `sha256:${'0'.repeat(64)}`
    await writeFile(join(root, 'suite.json'), JSON.stringify(suite))
    await expect(loadBenchSuite(join(root, 'suite.json'))).rejects.toThrow(/fixture digest mismatch/)
  })
})
async function measuredReport(): Promise<BenchReport> {
  const suite = await loadBenchSuite(suitePath)
  const root = await temp()
  let tick = 1_700_000_000_000
  return runBench({
    suite,
    provider: 'fake',
    model: 'offline-v1',
    harness: SKETCH_HARNESS,
    budget,
    tempRoot: root,
    now: () => tick++,
    executor: {
      async execute(context) {
        await expect(access(join(context.workspace, '.attempt-marker'))).rejects.toThrow()
        await writeFile(join(context.workspace, '.attempt-marker'), context.seed)
        const source = context.benchCase.fixture === 'math-fix'
          ? join(context.workspace, 'src', 'math.mjs')
          : join(context.workspace, 'src', 'greet.mjs')
        expect(await readFile(source, 'utf8')).not.toContain('.attempt-marker')
        context.recordCall({
          tokensIn: 10,
          tokensOut: 5,
          costUsd: context.attempt === 1 ? null : 0,
        })
        return {
          evalResult: {
            caseId: context.benchCase.id,
            score: context.attempt === 1 ? 1 : 0,
            passed: context.attempt === 2,
            passedChecks: context.attempt === 2 ? 1 : 0,
            totalChecks: 1,
            detail: context.attempt === 2 ? 'passed' : 'failed',
          },
          verifyStages: [
            { stage: 'build', status: 'passed' },
            { stage: 'unit', status: context.attempt === 2 ? 'passed' : 'failed' },
          ],
          manualEdits: context.attempt,
        }
      },
    },
  })
}

describe('offline benchmark runner and metrics', () => {
  it('uses fresh seeded workspaces and completion only from EvalResult.passed', async () => {
    const report = await measuredReport()
    expect(report.attempts).toHaveLength(4)
    expect(new Set(report.attempts.map((attempt) => attempt.seed)).size).toBe(4)
    expect(report.metrics.passAt1).toBe(0)
    expect(report.metrics.passAtK).toBe(1)
    expect(report.metrics.taskCompletionRate).toBe(0.5)
    expect(report.metrics.buildSuccessRate).toBe(1)
    expect(report.metrics.testPassRate).toBe(0.5)
    expect(report.metrics.totalManualEdits).toBe(6)
    expect(report.metrics.totalCostUsd).toBeNull()
    expect(report.metrics.passDistribution).toEqual([
      { passes: 0, cases: 0, rate: 0 },
      { passes: 1, cases: 2, rate: 1 },
      { passes: 2, cases: 0, rate: 0 },
    ])
  })
  it('records aggregate budget exhaustion rather than dropping attempts', async () => {
    const suite = await loadBenchSuite(suitePath)
    const root = await temp()
    const report = await runBench({
      suite,
      provider: 'fake',
      model: 'offline-v1',
      harness: SKETCH_HARNESS,
      budget: { ...budget, k: 2, maxCalls: 1 },
      tempRoot: root,
      executor: {
        async execute(context) {
          context.recordCall({ tokensIn: 1, tokensOut: 1, costUsd: 0 })
          return {
            evalResult: {
              caseId: context.benchCase.id, score: 0, passed: false,
              passedChecks: 0, totalChecks: 1, detail: 'failed',
            },
            verifyStages: [],
            manualEdits: null,
          }
        },
      },
    })
    expect(report.attempts.map((attempt) => attempt.status)).toEqual([
      'completed', 'exhausted', 'exhausted', 'exhausted',
    ])
  })

  it('keeps manual edits null and reads only canonical verify stage names', () => {
    const attempts = [{
      caseId: 'case', attempt: 1, seed: 'seed', status: 'completed' as const,
      evalResult: { caseId: 'case', score: 1, passed: true, passedChecks: 1, totalChecks: 1, detail: 'ok' },
      verifyStages: [{ stage: 'lint' as const, status: 'passed' as const }],
      manualEdits: null, calls: [], durationMs: 2, detail: 'ok',
    }]
    const metrics = calculateBenchMetrics(attempts, ['case'], 1)
    expect(metrics.totalManualEdits).toBeNull()
    expect(metrics.buildSuccessRate).toBeNull()
    expect(metrics.testPassRate).toBeNull()
  })
})
describe('strict lift comparisons', () => {
  it('compares current naive and Sketch harnesses with strict positive lift', async () => {
    const candidate = await measuredReport()
    const baseline = structuredClone(candidate)
    baseline.harness = { ...NAIVE_HARNESS }
    for (const attempt of baseline.attempts) {
      if (attempt.evalResult !== null) attempt.evalResult.passed = false
    }
    baseline.metrics = calculateBenchMetrics(
      baseline.attempts,
      baseline.orderedCaseIds,
      baseline.budget.k,
    )
    const comparison = compareBenchReports(baseline, candidate)
    expect(comparison.passAtKLift).toBe(1)
    expect(comparison.improved).toBe(true)

    const tied = structuredClone(candidate)
    tied.harness = { ...NAIVE_HARNESS }
    expect(compareBenchReports(tied, candidate).improved).toBe(false)
  })

  it('refuses any identity, order, budget, digest, or harness-version mismatch', async () => {
    const candidate = await measuredReport()
    const baseline = structuredClone(candidate)
    baseline.harness = { ...NAIVE_HARNESS }
    const changed = structuredClone(candidate)
    changed.budget.maxTokens++
    expect(() => compareBenchReports(baseline, changed)).toThrow(/budget mismatch/)
    changed.budget = { ...candidate.budget }
    changed.orderedCaseIds.reverse()
    expect(() => compareBenchReports(baseline, changed)).toThrow(/ordered case ids mismatch/)
    changed.orderedCaseIds.reverse()
    changed.harness.version = 'future'
    expect(() => compareBenchReports(baseline, changed)).toThrow(/current versioned sketch harness/)
  })
})

describe('validated atomic artifacts', () => {
  it('round-trips under .sketch/bench and finds the latest report', async () => {
    const report = await measuredReport()
    const root = await temp()
    const path = await writeBenchArtifact(root, report)
    expect(path).toContain(join('.sketch', 'bench'))
    expect(await latestBenchArtifactPath(root)).toBe(path)
    expect(await loadBenchArtifact(path)).toEqual(report)
  })

  it('rejects secrets, provider configuration, and derived metric tampering', async () => {
    const report = await measuredReport()
    expect(() => parseBenchReport({ ...report, headers: { authorization: 'secret' } })).toThrow(/must not be stored/)
    const tampered = structuredClone(report)
    tampered.metrics.passAtK = 0
    expect(() => parseBenchReport(tampered)).toThrow(/metrics do not match/)
  })
})


describe('internal eval and verification integration', () => {
  it('scores fresh fixtures through runEvalDetailed and the nine-stage policy', async () => {
    const suite = await loadBenchSuite(suitePath)
    const root = await temp()
    const report = await runBench({
      suite,
      provider: 'synthetic-offline',
      model: 'offline-scripted-v1',
      harness: SKETCH_HARNESS,
      budget: { ...budget, k: 1 },
      tempRoot: root,
      executor: createOfflineBenchExecutor(SKETCH_HARNESS),
    })
    expect(report.metrics.taskCompletionRate).toBe(1)
    expect(report.metrics.buildSuccessRate).toBe(1)
    expect(report.metrics.testPassRate).toBe(1)
    expect(report.metrics.totalManualEdits).toBeNull()
    expect(report.metrics.totalCostUsd).toBeNull()
    expect(report.attempts.every(attempt => attempt.evalResult?.passed)).toBe(true)
    expect(report.attempts.every(attempt => attempt.verifyStages.some(stage => stage.stage === 'build' && stage.status === 'passed'))).toBe(true)
  }, 30_000)
})