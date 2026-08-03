// Phase 11 gate: honest fixed-budget benchmark artifacts and lift-regression protection.
//
// The last describe block in this file EXECUTES the CI lift gate as a child process
// and asserts on its EXIT CODE. That is a different claim from the string-level
// workflow assertions above it, and it exists because the string assertions alone
// could not catch a gate that had stopped failing: inverting the `<` in
// `scripts/bench.mjs` — which turns a measured regression into a pass — used to leave
// the entire core suite green. A gate nothing ever runs is decoration.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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

// ── the CI lift gate, executed ───────────────────────────────────────────────
//
// Uses REAL: a real child process (`process.execPath scripts/bench.mjs --check`,
// spawned with an argv vector and `shell: false`, never a command string), the real
// offline executor, the real committed baseline, and real exit codes. Nothing is
// mocked, because the thing under test IS the process outcome CI reads.
//
// The script imports from `../dist/`, so it needs a built core; when `dist` is
// absent these cases skip with the missing artifact named, in the title and on
// stdout — a silent skip here would look exactly like a passing gate.
//
// Validates: Requirements 25.5, 25.6

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BENCH_SCRIPT = join(coreRoot, 'scripts', 'bench.mjs')
const BENCH_DIST = join(coreRoot, 'dist', 'bench', 'index.js')
const BENCH_BUILT = existsSync(BENCH_DIST)
const describeGate = BENCH_BUILT ? describe : describe.skip
const GATE_SKIP_NOTE = BENCH_BUILT
  ? ''
  : ' [SKIPPED: dist/bench/index.js is missing — run `npm run build -w @sketch/core`]'
if (!BENCH_BUILT) {
  console.log(
    `SKIPPED: the executed lift-gate cases need ${BENCH_DIST}, which is missing. ` +
      'Run `npm run build -w @sketch/core` (the root `npm test` builds first).',
  )
}

/** The repo-root artifact directory `bench.mjs` writes into on every run. */
const artifactDir = join(coreRoot, '..', '..', '.sketch', 'bench')

async function artifactNames(): Promise<Set<string>> {
  try {
    return new Set(await readdir(artifactDir))
  } catch {
    return new Set()
  }
}

interface GateRun { code: number | null; stdout: string; stderr: string }

/**
 * Run the gate to completion and hand back its exit code and streams.
 *
 * stdout and stderr are read as separate pipes: a single merged stream is mangled by
 * PowerShell when a child writes to both, and the assertions below distinguish the
 * two. Every artifact the run leaves behind is removed, so the committed fixture set
 * is byte-identical afterwards whether or not an assertion later fails.
 */
async function runGate(baselinePath?: string): Promise<GateRun> {
  const before = await artifactNames()
  try {
    return await new Promise<GateRun>((settle, fail) => {
      const child = spawn(process.execPath, [BENCH_SCRIPT, '--check'], {
        cwd: coreRoot,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: baselinePath === undefined
          ? process.env
          : { ...process.env, SKETCH_BENCH_BASELINE: baselinePath },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { stdout += chunk })
      child.stderr.on('data', (chunk: string) => { stderr += chunk })
      const timer = setTimeout(() => {
        child.kill()
        fail(new Error(`bench.mjs --check did not exit within 45s; stdout so far: ${stdout}`))
      }, 45_000)
      child.on('error', fail)
      child.on('close', (code) => { clearTimeout(timer); settle({ code, stdout, stderr }) })
    })
  } finally {
    for (const name of await artifactNames()) {
      if (!before.has(name)) await rm(join(artifactDir, name), { force: true }).catch(() => {})
    }
  }
}

describeGate(`Phase 11 CI lift gate, executed${GATE_SKIP_NOTE}`, () => {
  let unreachableBaseline = ''

  beforeAll(async () => {
    // Same identity as the committed baseline — so the run reaches the LIFT check
    // rather than tripping the identity check — with a threshold the fixture cannot
    // meet: pass@k lift is a difference of two rates in [0,1], so it never exceeds 1.
    const committed = JSON.parse(
      await readFile(join(coreRoot, 'bench', 'internal-baseline.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(committed.minimumPassAtKLift).toBe(1)
    unreachableBaseline = join(await temp(), 'unreachable-baseline.json')
    await writeFile(
      unreachableBaseline,
      JSON.stringify({ ...committed, minimumPassAtKLift: 2 }, null, 2),
      'utf8',
    )
  })

  it('exits non-zero and names the regression when internal-suite lift regresses', async () => {
    const run = await runGate(unreachableBaseline)
    expect(run.code).not.toBe(0)
    expect(run.code).not.toBeNull()
    expect(run.stderr).toContain('internal-suite lift regressed')
    expect(run.stderr).toContain('1 < 2')
    // It failed at the gate, not before it: the measurement itself still ran.
    expect(run.stdout).toContain('pass@2 lift 1.000')
    expect(run.stdout).not.toContain('lift gate:')
  }, 60_000)

  it('exits zero against the committed baseline, and writes one artifact', async () => {
    const before = await artifactNames()
    const run = await runGate()
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('lift gate: 1 >= 1')
    expect(run.stdout).toMatch(/^artifact: .+\.json$/m)
    expect(run.stdout).toContain('not evidence about any real provider model')
    // No network: the offline executor is the only thing the child talks to.
    expect(run.stdout).toContain('offline-scripted-v1 + Sketch')
    // The fixture directory is left exactly as it was found.
    expect(await artifactNames()).toEqual(before)
  }, 60_000)
})
