import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  NAIVE_HARNESS, SKETCH_HARNESS, compareBenchReports, createOfflineBenchExecutor,
  loadBenchSuite, runBench, writeBenchArtifact,
} from '../dist/bench/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const core = resolve(here, '..')
const root = resolve(core, '..', '..')
const suite = await loadBenchSuite(join(core, 'bench', 'suite.json'))
const budget = { k: 2, maxCalls: 64, maxTokens: 100000, attemptTimeoutMs: 10000, suiteTimeoutMs: 120000 }
const identity = { provider: 'synthetic-offline', model: 'offline-scripted-v1' }

async function report(harness) {
  return runBench({
    suite, ...identity, harness, budget,
    executor: createOfflineBenchExecutor(harness),
  })
}

const baseline = await report(NAIVE_HARNESS)
const candidate = await report(SKETCH_HARNESS)
const comparison = compareBenchReports(baseline, candidate)
const artifact = await writeBenchArtifact(root, candidate)
console.log(`artifact: ${artifact}`)
console.log(
  `${identity.model} + Sketch vs ${identity.model} + naive: ` +
  `pass@${budget.k} lift ${comparison.passAtKLift.toFixed(3)}; ` +
  `distribution ${JSON.stringify(candidate.metrics.passDistribution)}`,
)
console.log('synthetic offline CI measurement; not evidence about any real provider model')

if (process.argv.includes('--check')) {
  const expected = JSON.parse(await readFile(join(core, 'bench', 'internal-baseline.json'), 'utf8'))
  if (expected.synthetic !== true || expected.suiteDigest !== suite.digest ||
      expected.model !== identity.model || expected.k !== budget.k) {
    throw new Error('internal lift baseline identity does not match this fixed benchmark')
  }
  if (comparison.passAtKLift < expected.minimumPassAtKLift) {
    throw new Error(
      `internal-suite lift regressed: ${comparison.passAtKLift} < ${expected.minimumPassAtKLift}`,
    )
  }
  console.log(`lift gate: ${comparison.passAtKLift} >= ${expected.minimumPassAtKLift}`)
}