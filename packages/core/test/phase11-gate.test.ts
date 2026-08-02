// Phase 11 gate: honest fixed-budget benchmark artifacts and lift-regression protection.
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  NAIVE_HARNESS, SKETCH_HARNESS, compareBenchReports, createOfflineBenchExecutor,
  loadBenchSuite, runBench, writeBenchArtifact, type BenchBudget, type BenchReport,
} from '../src/bench/index.js'
import { METHODS, type MethodContext } from '../src/rpc/methods.js'

const suitePath = fileURLToPath(new URL('../bench/suite.json', import.meta.url))
const roots: string[] = []
const budget: BenchBudget = { k: 2, maxCalls: 64, maxTokens: 100000, attemptTimeoutMs: 10000, suiteTimeoutMs: 120000 }
const identity = { provider: 'synthetic-offline', model: 'offline-scripted-v1' }

afterAll(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }) })
async function temp() { const root = await mkdtemp(join(tmpdir(), 'sketch-p11-')); roots.push(root); return root }
async function measure(harness: typeof NAIVE_HARNESS | typeof SKETCH_HARNESS): Promise<BenchReport> {
  return runBench({
    suite: await loadBenchSuite(suitePath), ...identity, harness, budget,
    tempRoot: await temp(), executor: createOfflineBenchExecutor(harness),
  })
}
const context: MethodContext = {
  emitEvent: () => {}, log: () => {}, rememberSecret: () => {}, secrets: () => [],
  env: {}, cwd: () => process.cwd(),
}

describe('Phase 11 gate', () => {
  it('uses a pinned verifiable internal suite, never the two vacuous captured cases', async () => {
    const suite = await loadBenchSuite(suitePath)
    expect(suite.orderedCaseIds).toEqual(['repair-addition', 'repair-greeting'])
    for (const entry of suite.suite.cases) {
      expect(entry.eval.task.verify.length).toBeGreaterThan(0)
      expect(entry.eval.checks).toContainEqual({ kind: 'verify-pass' })
    }
    const captured = await readFile(fileURLToPath(new URL('../.sketch/evals/evals.jsonl', import.meta.url)), 'utf8')
    expect(captured).toContain('"verify":[]')
    expect(JSON.stringify(suite.suite)).not.toContain('eval_178509')
  })

  it('reports every required outcome and pass@k distribution under one fixed budget', async () => {
    const report = await measure(SKETCH_HARNESS)
    expect(report.attempts).toHaveLength(report.orderedCaseIds.length * budget.k)
    expect(report.metrics.taskCompletionRate).toBe(1)
    expect(report.metrics.buildSuccessRate).toBe(1)
    expect(report.metrics.testPassRate).toBe(1)
    expect(report.metrics.totalManualEdits).toBeNull()
    expect(report.metrics.timeToCompletionMs).not.toBeNull()
    expect(report.metrics.totalCostUsd).toBeNull()
    expect(report.metrics.passAt1).toBe(1)
    expect(report.metrics.passAtK).toBe(1)
    expect(report.metrics.passDistribution).toEqual([
      { passes: 0, cases: 0, rate: 0 }, { passes: 1, cases: 0, rate: 0 },
      { passes: 2, cases: 2, rate: 1 },
    ])
  }, 60_000)


  it('frames the same synthetic model as M + Sketch versus M + naive, strictly', async () => {
    const [naive, sketch] = await Promise.all([measure(NAIVE_HARNESS), measure(SKETCH_HARNESS)])
    const lift = compareBenchReports(naive, sketch)
    expect(naive.model).toBe(sketch.model)
    expect(naive.provider).toBe(sketch.provider)
    expect(naive.budget).toEqual(sketch.budget)
    expect(lift.passAtKLift).toBe(1)
    expect(lift.improved).toBe(true)
    const tie = structuredClone(sketch)
    tie.harness = { ...NAIVE_HARNESS }
    expect(compareBenchReports(tie, sketch).improved).toBe(false)
    const largerBudget = structuredClone(sketch)
    largerBudget.budget.maxTokens++
    expect(() => compareBenchReports(naive, largerBudget)).toThrow(/budget mismatch/)
  }, 60_000)

  it('writes a validated artifact and exposes only a read-only latest-report RPC', async () => {
    const root = await temp()
    const report = await measure(SKETCH_HARNESS)
    const path = await writeBenchArtifact(root, report)
    const answer = await METHODS['benchmark-report']!({ root }, context) as {
      path: string | null; report: BenchReport | null; note: string
    }
    expect(answer.path).toBe(path)
    expect(answer.report).toEqual(report)
    expect(answer.note).toContain(`${report.model} + Sketch`)
    expect(answer.note).toContain('not a claim that Sketch beats a model')
  }, 60_000)

  it('ships artifact-producing scripts and a CI lift gate after tests', async () => {
    const corePackage = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
    expect(corePackage.scripts.bench).toBe('node scripts/bench.mjs')
    expect(corePackage.scripts['bench:check']).toContain('--check')
    const workflow = await readFile(fileURLToPath(new URL('../../../.github/workflows/ci.yml', import.meta.url)), 'utf8')
    const coreTests = workflow.indexOf('npm test -w @sketch/core')
    const desktopTests = workflow.indexOf('npm test -w @sketch/desktop')
    const check = workflow.indexOf('npm run bench:check')
    expect(coreTests).toBeGreaterThan(-1)
    expect(desktopTests).toBeGreaterThan(coreTests)
    expect(check).toBeGreaterThan(desktopTests)
    expect(workflow).toContain('.sketch/bench/*.json')
  })
})