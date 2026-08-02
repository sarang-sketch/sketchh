import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isVerifyStage } from '../verify/index.js'
import { calculateBenchMetrics } from './metrics.js'
import { canonicalJson } from './suite.js'
import {
  BENCH_REPORT_VERSION,
  type BenchAttempt,
  type BenchAttemptStatus,
  type BenchBudget,
  type BenchCall,
  type BenchReport,
  type BenchStageResult,
  type HarnessIdentity,
} from './types.js'

const REPORT_KEYS = [
  'version', 'createdAt', 'suiteId', 'suiteDigest', 'orderedCaseIds', 'provider',
  'model', 'harness', 'budget', 'attempts', 'metrics',
] as const
const ATTEMPT_STATUSES = new Set<BenchAttemptStatus>([
  'completed', 'error', 'timed-out', 'exhausted', 'skipped',
])
const STAGE_STATUSES = new Set(['passed', 'failed', 'skipped', 'not-run'])
const FORBIDDEN_KEYS = new Set([
  'apikey', 'headers', 'baseurl', 'providerconfig', 'password', 'secret', 'authorization',
])

function row(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has an invalid shape`)
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be non-empty`)
  return value
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isInteger(value) || (value as number) < minimum) throw new Error(`${label} must be an integer >= ${minimum}`)
  return value as number
}

function number(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) throw new Error(`${label} must be finite and >= ${minimum}`)
  return value
}
function rejectSensitive(value: unknown, path = 'report'): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectSensitive(entry, `${path}[${index}]`))
    return
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replaceAll('-', '').replaceAll('_', '')
    if (FORBIDDEN_KEYS.has(normalized)) throw new Error(`${path}.${key} must not be stored in benchmark artifacts`)
    rejectSensitive(entry, `${path}.${key}`)
  }
}

function parseBudget(value: unknown): BenchBudget {
  const data = row(value, 'report.budget')
  exact(data, ['k', 'maxCalls', 'maxTokens', 'attemptTimeoutMs', 'suiteTimeoutMs'], 'report.budget')
  const budget: BenchBudget = {
    k: integer(data.k, 'report.budget.k', 1),
    maxCalls: integer(data.maxCalls, 'report.budget.maxCalls', 1),
    maxTokens: integer(data.maxTokens, 'report.budget.maxTokens', 1),
    attemptTimeoutMs: integer(data.attemptTimeoutMs, 'report.budget.attemptTimeoutMs', 1),
    suiteTimeoutMs: integer(data.suiteTimeoutMs, 'report.budget.suiteTimeoutMs', 1),
  }
  if (budget.suiteTimeoutMs < budget.attemptTimeoutMs) throw new Error('suite timeout must cover an attempt timeout')
  return budget
}

function parseHarness(value: unknown): HarnessIdentity {
  const data = row(value, 'report.harness')
  exact(data, ['id', 'version'], 'report.harness')
  const id = string(data.id, 'report.harness.id')
  if (id !== 'naive' && id !== 'sketch') throw new Error('report.harness.id is invalid')
  return { id, version: string(data.version, 'report.harness.version') }
}

function parseCall(value: unknown, label: string): BenchCall {
  const data = row(value, label)
  exact(data, ['tokensIn', 'tokensOut', 'costUsd'], label)
  return {
    tokensIn: integer(data.tokensIn, `${label}.tokensIn`),
    tokensOut: integer(data.tokensOut, `${label}.tokensOut`),
    costUsd: data.costUsd === null ? null : number(data.costUsd, `${label}.costUsd`),
  }
}

function parseStage(value: unknown, label: string): BenchStageResult {
  const data = row(value, label)
  exact(data, ['stage', 'status'], label)
  if (!isVerifyStage(data.stage)) throw new Error(`${label}.stage is invalid`)
  if (!STAGE_STATUSES.has(String(data.status))) throw new Error(`${label}.status is invalid`)
  return { stage: data.stage, status: data.status as BenchStageResult['status'] }
}
function parseEvalResult(value: unknown, label: string): BenchAttempt['evalResult'] {
  if (value === null) return null
  const data = row(value, label)
  exact(data, ['caseId', 'score', 'passed', 'passedChecks', 'totalChecks', 'detail'], label)
  if (typeof data.passed !== 'boolean') throw new Error(`${label}.passed must be boolean`)
  return {
    caseId: string(data.caseId, `${label}.caseId`),
    score: number(data.score, `${label}.score`),
    passed: data.passed,
    passedChecks: integer(data.passedChecks, `${label}.passedChecks`),
    totalChecks: integer(data.totalChecks, `${label}.totalChecks`),
    detail: typeof data.detail === 'string' ? data.detail : (() => { throw new Error(`${label}.detail must be a string`) })(),
  }
}

function parseAttempt(value: unknown, index: number): BenchAttempt {
  const label = `report.attempts[${index}]`
  const data = row(value, label)
  exact(data, ['caseId', 'attempt', 'seed', 'status', 'evalResult', 'verifyStages', 'manualEdits', 'calls', 'durationMs', 'detail'], label)
  if (!ATTEMPT_STATUSES.has(data.status as BenchAttemptStatus)) throw new Error(`${label}.status is invalid`)
  if (!Array.isArray(data.verifyStages) || !Array.isArray(data.calls)) throw new Error(`${label} arrays are invalid`)
  const manualEdits = data.manualEdits === null ? null : integer(data.manualEdits, `${label}.manualEdits`)
  const attempt: BenchAttempt = {
    caseId: string(data.caseId, `${label}.caseId`),
    attempt: integer(data.attempt, `${label}.attempt`, 1),
    seed: string(data.seed, `${label}.seed`),
    status: data.status as BenchAttemptStatus,
    evalResult: parseEvalResult(data.evalResult, `${label}.evalResult`),
    verifyStages: data.verifyStages.map((stage, i) => parseStage(stage, `${label}.verifyStages[${i}]`)),
    manualEdits,
    calls: data.calls.map((call, i) => parseCall(call, `${label}.calls[${i}]`)),
    durationMs: integer(data.durationMs, `${label}.durationMs`),
    detail: typeof data.detail === 'string' ? data.detail : (() => { throw new Error(`${label}.detail must be a string`) })(),
  }
  if (attempt.evalResult !== null && attempt.evalResult.caseId !== attempt.caseId) throw new Error(`${label} case ids differ`)
  return attempt
}
export function parseBenchReport(value: unknown): BenchReport {
  rejectSensitive(value)
  const data = row(value, 'report')
  exact(data, REPORT_KEYS, 'report')
  if (data.version !== BENCH_REPORT_VERSION) throw new Error(`unsupported benchmark report version: ${String(data.version)}`)
  if (!Array.isArray(data.orderedCaseIds) || data.orderedCaseIds.length === 0) throw new Error('report.orderedCaseIds must be non-empty')
  if (!Array.isArray(data.attempts)) throw new Error('report.attempts must be an array')
  const orderedCaseIds = data.orderedCaseIds.map((id, i) => string(id, `report.orderedCaseIds[${i}]`))
  if (new Set(orderedCaseIds).size !== orderedCaseIds.length) throw new Error('report.orderedCaseIds must be unique')
  const budget = parseBudget(data.budget)
  const attempts = data.attempts.map(parseAttempt)
  const keys = new Set(attempts.map((attempt) => `${attempt.caseId}:${attempt.attempt}`))
  if (attempts.length !== orderedCaseIds.length * budget.k || keys.size !== attempts.length) {
    throw new Error('report must contain exactly k attempts per case')
  }
  for (const caseId of orderedCaseIds) for (let attempt = 1; attempt <= budget.k; attempt++) {
    if (!keys.has(`${caseId}:${attempt}`)) throw new Error(`report is missing ${caseId} attempt ${attempt}`)
  }
  const createdAt = string(data.createdAt, 'report.createdAt')
  const createdAtMs = Date.parse(createdAt)
  if (!Number.isFinite(createdAtMs) || new Date(createdAtMs).toISOString() !== createdAt) {
    throw new Error('report.createdAt must be a canonical ISO timestamp')
  }
  const report: BenchReport = {
    version: BENCH_REPORT_VERSION,
    createdAt,
    suiteId: string(data.suiteId, 'report.suiteId'),
    suiteDigest: string(data.suiteDigest, 'report.suiteDigest'),
    orderedCaseIds,
    provider: string(data.provider, 'report.provider'),
    model: string(data.model, 'report.model'),
    harness: parseHarness(data.harness),
    budget,
    attempts,
    metrics: calculateBenchMetrics(attempts, orderedCaseIds, budget.k),
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(report.suiteDigest)) throw new Error('report.suiteDigest is invalid')
  if (canonicalJson(data.metrics) !== canonicalJson(report.metrics)) throw new Error('report.metrics do not match attempts')
  return report
}
export async function writeBenchArtifact(root: string, value: BenchReport): Promise<string> {
  const report = parseBenchReport(value)
  const dir = join(root, '.sketch', 'bench')
  await mkdir(dir, { recursive: true })
  const timestamp = report.createdAt.replaceAll(':', '-').replaceAll('.', '-')
  const target = join(dir, `${timestamp}.json`)
  const temporary = join(dir, `.${timestamp}.${process.pid}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  return target
}

export async function loadBenchArtifact(path: string): Promise<BenchReport> {
  const raw = await readFile(path, 'utf8')
  let value: unknown
  try { value = JSON.parse(raw) } catch (error) {
    throw new Error(`invalid benchmark artifact JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseBenchReport(value)
}

export async function latestBenchArtifactPath(root: string): Promise<string | null> {
  const dir = join(root, '.sketch', 'bench')
  let names: string[]
  try { names = await readdir(dir) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const artifacts = names.filter((name) => !name.startsWith('.') && name.endsWith('.json')).sort()
  return artifacts.length === 0 ? null : join(dir, artifacts[artifacts.length - 1]!)
}

export async function loadLatestBenchArtifact(root: string): Promise<BenchReport | null> {
  const path = await latestBenchArtifactPath(root)
  return path === null ? null : loadBenchArtifact(path)
}
