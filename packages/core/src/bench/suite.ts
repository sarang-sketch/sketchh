import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { hashBytes } from '../registry/hash.js'
import type { Check, EvalCase, Task, VerifyCommand } from '../types.js'
import {
  BENCH_SUITE_VERSION,
  type BenchCase,
  type BenchSuite,
  type LoadedBenchSuite,
} from './types.js'

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    throw new Error(`${label} must contain exactly: ${keys.join(', ')}`)
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be non-empty`)
  return value
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be finite`)
  return value
}
function parseCommand(value: unknown, label: string): VerifyCommand {
  const row = object(value, label)
  const allowed = ['name', 'cmd', 'args', 'cwd', 'timeoutMs']
  for (const key of Object.keys(row)) if (!allowed.includes(key)) throw new Error(`${label}.${key} is not allowed`)
  const command: VerifyCommand = { name: text(row.name, `${label}.name`), cmd: text(row.cmd, `${label}.cmd`) }
  if (row.args !== undefined) {
    if (!Array.isArray(row.args) || row.args.some((arg) => typeof arg !== 'string')) throw new Error(`${label}.args must be strings`)
    command.args = row.args as string[]
  }
  if (row.cwd !== undefined) command.cwd = text(row.cwd, `${label}.cwd`)
  if (row.timeoutMs !== undefined) command.timeoutMs = finite(row.timeoutMs, `${label}.timeoutMs`)
  return command
}

function parseTask(value: unknown, label: string): Task {
  const row = object(value, label)
  const allowed = ['id', 'prompt', 'verify', 'skillNames']
  for (const key of Object.keys(row)) if (!allowed.includes(key)) throw new Error(`${label}.${key} is not allowed`)
  if (!Array.isArray(row.verify) || row.verify.length === 0) throw new Error(`${label}.verify must be non-empty`)
  const task: Task = {
    id: text(row.id, `${label}.id`),
    prompt: text(row.prompt, `${label}.prompt`),
    verify: row.verify.map((entry, i) => parseCommand(entry, `${label}.verify[${i}]`)),
  }
  if (row.skillNames !== undefined) {
    if (!Array.isArray(row.skillNames) || row.skillNames.some((name) => typeof name !== 'string' || name.trim() === '')) throw new Error(`${label}.skillNames must be non-empty strings`)
    task.skillNames = row.skillNames as string[]
  }
  return task
}

function parseCheck(value: unknown, label: string): Check {
  const row = object(value, label)
  const kind = text(row.kind, `${label}.kind`)
  if (kind === 'verify-pass') {
    exact(row, ['kind'], label)
    return { kind }
  }
  if (kind === 'contains' || kind === 'not-contains') {
    exact(row, ['kind', 'text'], label)
    return { kind, text: text(row.text, `${label}.text`) }
  }
  throw new Error(`${label}.kind is unsupported`)
}
function parseEval(value: unknown, label: string): EvalCase {
  const row = object(value, label)
  exact(row, ['id', 'task', 'checks'], label)
  if (!Array.isArray(row.checks) || row.checks.length === 0) throw new Error(`${label}.checks must be non-empty`)
  const checks = row.checks.map((entry, i) => parseCheck(entry, `${label}.checks[${i}]`))
  if (!checks.some((check) => check.kind === 'verify-pass')) {
    throw new Error(`${label} is unverifiable: a verify-pass check is required`)
  }
  return { id: text(row.id, `${label}.id`), task: parseTask(row.task, `${label}.task`), checks }
}

function safeFixture(value: unknown, label: string): string {
  const fixture = text(value, label).replaceAll('\\', '/')
  if (isAbsolute(fixture) || fixture.split('/').some((part) => part === '..' || part === '')) {
    throw new Error(`${label} must be a safe relative path`)
  }
  return fixture
}

function parseCase(value: unknown, index: number): BenchCase {
  const label = `suite.cases[${index}]`
  const row = object(value, label)
  exact(row, ['id', 'title', 'fixture', 'fixtureDigest', 'eval'], label)
  const benchCase: BenchCase = {
    id: text(row.id, `${label}.id`),
    title: text(row.title, `${label}.title`),
    fixture: safeFixture(row.fixture, `${label}.fixture`),
    fixtureDigest: text(row.fixtureDigest, `${label}.fixtureDigest`),
    eval: parseEval(row.eval, `${label}.eval`),
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(benchCase.fixtureDigest)) throw new Error(`${label}.fixtureDigest is invalid`)
  if (benchCase.eval.id !== benchCase.id || benchCase.eval.task.id !== benchCase.id) {
    throw new Error(`${label} id, eval.id, and eval.task.id must match`)
  }
  return benchCase
}

export function parseBenchSuite(value: unknown): BenchSuite {
  const row = object(value, 'suite')
  exact(row, ['version', 'id', 'cases'], 'suite')
  if (row.version !== BENCH_SUITE_VERSION) throw new Error(`unsupported benchmark suite version: ${String(row.version)}`)
  if (!Array.isArray(row.cases) || row.cases.length === 0) throw new Error('suite.cases must be non-empty')
  const cases = row.cases.map(parseCase)
  const ids = new Set<string>()
  for (const benchCase of cases) {
    if (ids.has(benchCase.id)) throw new Error(`duplicate benchmark case id: ${benchCase.id}`)
    ids.add(benchCase.id)
  }
  return { version: BENCH_SUITE_VERSION, id: text(row.id, 'suite.id'), cases }
}
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const row = value as Record<string, unknown>
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`
}

async function strictFixtureDigest(root: string): Promise<{ digest: string; files: number }> {
  const paths: string[] = []
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`fixture contains a symbolic link: ${entry.name}`)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) paths.push(relative(root, full).replaceAll('\\', '/'))
      else throw new Error(`fixture contains an unsupported entry: ${entry.name}`)
    }
  }
  await walk(root)
  paths.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  let manifest = ''
  for (const path of paths) manifest += `${path}\u0000${hashBytes(await readFile(join(root, path)))}\n`
  return { digest: hashBytes(Buffer.from(manifest, 'utf8')), files: paths.length }
}

async function verifyFixture(root: string, benchCase: BenchCase): Promise<void> {
  const fixturePath = resolve(root, benchCase.fixture)
  const rel = relative(root, fixturePath)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`fixture escapes root: ${benchCase.fixture}`)
  const info = await stat(fixturePath)
  if (!info.isDirectory()) throw new Error(`fixture is not a directory: ${benchCase.fixture}`)
  const actualPath = await realpath(fixturePath)
  const actualRel = relative(await realpath(root), actualPath)
  if (actualRel.startsWith('..') || isAbsolute(actualRel)) throw new Error(`fixture resolves outside root: ${benchCase.fixture}`)
  const digest = await strictFixtureDigest(fixturePath)
  if (digest.files === 0) throw new Error(`fixture is empty: ${benchCase.fixture}`)
  if (digest.digest !== benchCase.fixtureDigest) {
    throw new Error(`fixture digest mismatch for ${benchCase.id}: expected ${benchCase.fixtureDigest}, got ${digest.digest}`)
  }
}

export async function loadBenchSuite(suitePath: string): Promise<LoadedBenchSuite> {
  const absolute = resolve(suitePath)
  const raw = await readFile(absolute, 'utf8')
  let decoded: unknown
  try { decoded = JSON.parse(raw) } catch (error) {
    throw new Error(`invalid benchmark suite JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const suite = parseBenchSuite(decoded)
  const fixtureRoot = join(dirname(absolute), 'fixtures')
  for (const benchCase of suite.cases) await verifyFixture(fixtureRoot, benchCase)
  const digest = hashBytes(Buffer.from(canonicalJson(suite), 'utf8'))
  return {
    suite,
    digest,
    suitePath: absolute,
    fixtureRoot,
    orderedCaseIds: suite.cases.map((benchCase) => benchCase.id),
  }
}
