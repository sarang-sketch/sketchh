// The verification contract: nine ordered stages, `verify.yaml`, and auto-detection.
//
// ── WHY THE ORDER IS FIXED ──────────────────────────────────────────────────
//
// `format → lint → typecheck → build → unit → integration → security →
//  performance → dependency-audit` (Requirement 4.3), cheapest and most
// localising first. A lint error should not wait behind a six-minute test suite,
// and a type error usually explains the test failures that would have followed it.
// The order is data (`VERIFY_STAGES`), and the runner iterates it — there is no way
// for a policy file to reorder the gauntlet, because "run my tests before my
// typecheck" is a preference that costs everyone else the fast feedback.
//
// ── FAIL FAST, BUT RECORD EVERYTHING THAT RAN ───────────────────────────────
//
// The first failing stage stops the sequence. The stages after it are reported as
// `not-run`, which is deliberately NOT the same word as `skipped`: skipped means
// "this project has no such stage", and not-run means "we stopped before reaching
// it". Collapsing those two would let a run with a broken build claim its tests
// were skipped, which reads as "there are no tests".
//
// ── THE RULE THAT LOOKS CONTRADICTORY AND IS NOT ────────────────────────────
//
// Requirement 4.4: an unconfigured stage is skipped and does not fail the run.
// Requirement 4.7: a task is ok only if every non-skipped stage passed, OR no
// stages were configured at all.
//
// Together: a project with nothing configured verifies ok. That is intentional —
// the verify contract cannot invent checks a project does not have. What stops it
// becoming a free pass is elsewhere, in the eval harness: the `verify-pass` CHECK
// fails when nothing was verified (see `evals/runner.ts`, decision 1). One rule is
// about whether a run is broken; the other is about whether a claim is evidenced.
// `PolicyResult.verifiedAnything` is what lets a caller tell the two apart.
//
// ── NO SECOND SPAWN PATH ────────────────────────────────────────────────────
//
// Every command goes through `runCommands` from `./runner.js` — `shell: false`,
// per-command timeout, SIGKILL, `verify_started` / `verify_result` per command
// (Requirement 4.6). This file decides WHAT runs and in what order; it never
// spawns. There is exactly one spawn in this package and it stays that way.
//
// Validates: Requirements 4.3, 4.4, 4.5, 4.6, 4.7, 4.8

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { parseFrontmatter } from '../skills/frontmatter.js'
import type { VerifyCommand, VerifyResult } from '../types.js'
import { liveResultToVerifyResult, runLiveCheck, type LiveCheck, type LiveResult } from './live.js'
import { runCommands, type VerifyEventSink } from './runner.js'

/**
 * The nine stages, in contract order (Requirement 4.3).
 *
 * `unit` and `integration` are separate because they fail for different reasons and
 * cost different amounts: a unit failure is usually the change, an integration
 * failure is often the environment, and conflating them makes both harder to read.
 */
export const VERIFY_STAGES = [
  'format',
  'lint',
  'typecheck',
  'build',
  'unit',
  'integration',
  'security',
  'performance',
  'dependency-audit',
] as const

export type VerifyStage = (typeof VERIFY_STAGES)[number]

export function isVerifyStage(value: unknown): value is VerifyStage {
  return typeof value === 'string' && (VERIFY_STAGES as readonly string[]).includes(value)
}

/** Filenames read from the project root, in precedence order. */
export const POLICY_FILENAMES = ['verify.yaml', 'verify.yml', 'verify.json'] as const

/**
 * A stage's outcome.
 *
 * `skipped` — not configured for this project. Does not fail the run (4.4).
 * `not-run`  — a previous stage failed and the sequence stopped. Not the same thing.
 */
export type StageStatus = 'passed' | 'failed' | 'skipped' | 'not-run'

export interface StageResult {
  stage: VerifyStage
  status: StageStatus
  /** Per-command results, in order. Empty for `skipped` and `not-run`. */
  results: VerifyResult[]
  /** Total wall time of the commands that ran. */
  durationMs: number
  /** Why it is skipped or not-run, in words. Null when it ran. */
  reason: string | null
}

/**
 * Stage → the commands that constitute it. A stage with no commands is skipped.
 *
 * `live` is not a tenth stage. Requirement 4.3 fixes the nine, and live feedback is
 * HOW the `integration` stage is performed for a project that has a runnable app: it
 * runs after that stage's commands and its verdict counts exactly like theirs. A
 * tenth stage would have meant either editing the contract or hiding a check outside
 * the `ok` rule, and both are worse.
 */
export type VerifyPolicy = {
  [S in VerifyStage]?: VerifyCommand[]
} & {
  live?: LiveCheck
}

/** The stage a live check belongs to. Fixed; see the note on `VerifyPolicy.live`. */
export const LIVE_STAGE: VerifyStage = 'integration'

/** Where a policy came from. Reported so a surface never has to guess. */
export type PolicySource = 'file' | 'detected' | 'none'

export interface ResolvedPolicy {
  policy: VerifyPolicy
  source: PolicySource
  /** The file it was read from, when it was. */
  path?: string
  /** The detected stack, when auto-detection ran. */
  language?: DetectedLanguage
  /** Problems found while reading a policy file. A malformed file is NOT silent. */
  diagnostics: string[]
}

export interface PolicyResult {
  ok: boolean
  /** Every stage, in contract order, including the skipped ones. */
  stages: StageResult[]
  /** The stage that failed, when one did. */
  failedStage: VerifyStage | null
  /** Stages that ran at least one command. */
  ranStages: VerifyStage[]
  /**
   * True when at least one command actually ran.
   *
   * The eval harness's `verify-pass` check needs this: `ok` is true for a project
   * with nothing configured, and that must not read as evidence of verification.
   */
  verifiedAnything: boolean
  /** Flattened per-command results, for `RunResult.verify`. */
  results: VerifyResult[]
  totalDurationMs: number
  /**
   * The live check's full verdict, when one was configured.
   *
   * Its row is already in `results`; this carries what a row cannot — the status
   * (`failed-to-start` reads differently from `runtime-error`), whether the verdict
   * was a heuristic, and the captured output.
   */
  live?: LiveResult
}

// ── argv, without a shell ───────────────────────────────────────────────────

/**
 * Split a command line into argv.
 *
 * A policy file is written by humans, who write `npm run lint`, not
 * `{"cmd":"npm","args":["run","lint"]}`. But the runner spawns with `shell: false`,
 * so something has to turn one into the other, and that something must NOT be a
 * shell.
 *
 * WHAT THIS DOES: splits on whitespace, and treats single or double quotes as
 * grouping so `node -e "console.log(1)"` is three arguments.
 *
 * WHAT IT DELIBERATELY DOES NOT DO, because a shell would and we are not one:
 * no variable expansion, no globbing, no pipes, no redirection, no `&&`, no
 * backslash escapes, no command substitution. A policy line containing `|` or `>`
 * gets those characters as literal argv text, which will fail loudly rather than
 * doing something surprising. `verify.json` is the escape hatch for exact argv.
 */
export function splitArgv(line: string): string[] {
  const argv: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false

  for (const char of line) {
    if (quote !== null) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      // An empty quoted string is a real argument: `cmd ""` passes one empty arg.
      started = true
      continue
    }
    if (char === ' ' || char === '\t') {
      if (started) {
        argv.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (started) argv.push(current)
  return argv
}

/** One command from a policy-file string. Returns null when the line is empty. */
function commandFromLine(stage: VerifyStage, line: string, index: number): VerifyCommand | null {
  const argv = splitArgv(line)
  if (argv.length === 0) return null
  const [cmd, ...args] = argv
  return {
    name: index === 0 ? stage : `${stage}[${index}]`,
    cmd: cmd!,
    ...(args.length > 0 ? { args } : {}),
  }
}

// ── reading a policy file ───────────────────────────────────────────────────

/**
 * Parse `verify.yaml`.
 *
 * The grammar is the frontmatter parser's YAML subset, reused rather than
 * reimplemented (`skills/frontmatter.ts`): `stage: command line`, or a block/inline
 * sequence of command lines. Nested maps are REPORTED as an error there rather than
 * mis-parsed, which is why this file can be strict without writing a YAML parser.
 *
 * ```yaml
 * lint: npm run lint
 * typecheck: npm run typecheck
 * unit:
 *   - npm test
 *   - node --test test/extra.js
 * ```
 *
 * An unknown key is a diagnostic, not a silent no-op: `tests:` instead of `unit:`
 * would otherwise configure nothing and report every stage skipped, and the author
 * would believe their tests were running.
 */
export function parsePolicyYaml(text: string): { policy: VerifyPolicy; diagnostics: string[] } {
  const diagnostics: string[] = []
  // The parser wants a fenced block; a standalone document is the block.
  const parsed = parseFrontmatter(`---\n${text.replace(/\r\n/g, '\n')}\n---\n`)
  if (!parsed.ok) {
    return { policy: {}, diagnostics: [`verify policy is not parseable: ${parsed.error}`] }
  }

  const policy: VerifyPolicy = {}
  for (const [key, value] of Object.entries(parsed.data)) {
    if (!isVerifyStage(key)) {
      diagnostics.push(
        `unknown stage ${JSON.stringify(key)}; the nine stages are ${VERIFY_STAGES.join(', ')}`,
      )
      continue
    }
    const lines = Array.isArray(value) ? value : [value]
    const commands = lines
      .map((line, index) => commandFromLine(key, line, index))
      .filter((command): command is VerifyCommand => command !== null)
    // An explicitly empty value means "this project has no such stage", which is
    // exactly `skipped`, so it is recorded as an empty list rather than dropped.
    policy[key] = commands
  }

  return { policy, diagnostics }
}

/**
 * Parse the `live` block of a JSON policy (Requirement 23.1).
 *
 * JSON only, deliberately: a live check is a nested object (start command, readiness
 * signals, a probe) and the YAML subset this project reads on purpose does not do
 * nested maps. Inventing a flat spelling for it — `live.cmd:`, `live.port:` — would
 * be a second grammar nobody asked for, and the dotted keys would parse as opaque
 * strings in every other YAML tool. So `verify.yaml` configures the nine stages and
 * `verify.json` is where a live check goes, and that is stated rather than discovered.
 */
export function parseLiveCheck(value: unknown): { check: LiveCheck | null; diagnostics: string[] } {
  const diagnostics: string[] = []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { check: null, diagnostics: ['live must be an object with a cmd'] }
  }
  const record = value as Record<string, unknown>

  const cmd = record['cmd']
  if (typeof cmd !== 'string' || cmd.trim() === '') {
    return { check: null, diagnostics: ['live.cmd must be a non-empty string'] }
  }

  const strings = (key: string): string[] | undefined => {
    const raw = record[key]
    if (raw === undefined) return undefined
    if (!Array.isArray(raw)) {
      diagnostics.push(`live.${key} must be an array of strings`)
      return undefined
    }
    return raw.map((entry) => String(entry))
  }

  /**
   * `key` is the property to read; `label` is what a diagnostic calls it.
   *
   * They are separate parameters because an earlier version passed the dotted label
   * as the key and looked up `probe['probe.expectStatus']`, which is always
   * undefined — so `expectStatus` was silently dropped and every probe accepted any
   * status below 500. A test caught it; the two roles are now distinct.
   */
  const number = (
    key: string,
    label = key,
    source: Record<string, unknown> = record,
  ): number | undefined => {
    const raw = source[key]
    if (raw === undefined) return undefined
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      diagnostics.push(`live.${label} must be a number`)
      return undefined
    }
    return raw
  }

  const check: LiveCheck = { cmd }
  const args = strings('args')
  if (args !== undefined) check.args = args
  if (typeof record['name'] === 'string') check.name = record['name']
  if (typeof record['cwd'] === 'string') check.cwd = record['cwd']
  if (record['skip'] === true) check.skip = true

  const env = record['env']
  if (env !== undefined) {
    if (env === null || typeof env !== 'object' || Array.isArray(env)) {
      diagnostics.push('live.env must be an object of string values')
    } else {
      check.env = Object.fromEntries(
        Object.entries(env as Record<string, unknown>).map(([key, entry]) => [key, String(entry)]),
      )
    }
  }

  const readyWhen = record['readyWhen']
  if (readyWhen !== undefined) {
    if (readyWhen === null || typeof readyWhen !== 'object' || Array.isArray(readyWhen)) {
      diagnostics.push('live.readyWhen must be an object')
    } else {
      const readiness = readyWhen as Record<string, unknown>
      const ready: LiveReadinessInput = {}
      if (typeof readiness['output'] === 'string') ready.output = readiness['output']
      if (typeof readiness['url'] === 'string') ready.url = readiness['url']
      const port = number('port', 'readyWhen.port', readiness)
      if (port !== undefined) ready.port = port
      if (Object.keys(ready).length > 0) check.readyWhen = ready
    }
  }

  const probe = record['probe']
  if (probe !== undefined) {
    if (probe === null || typeof probe !== 'object' || Array.isArray(probe)) {
      diagnostics.push('live.probe must be an object with a url')
    } else {
      const source = probe as Record<string, unknown>
      const url = source['url']
      if (typeof url !== 'string' || url.trim() === '') {
        diagnostics.push('live.probe.url must be a non-empty string')
      } else {
        const expectStatus = number('expectStatus', 'probe.expectStatus', source)
        check.probe = { url, ...(expectStatus !== undefined ? { expectStatus } : {}) }
      }
    }
  }

  const readyTimeoutMs = number('readyTimeoutMs')
  if (readyTimeoutMs !== undefined) check.readyTimeoutMs = readyTimeoutMs
  const settleMs = number('settleMs')
  if (settleMs !== undefined) check.settleMs = settleMs
  const errorPatterns = strings('errorPatterns')
  if (errorPatterns !== undefined) check.errorPatterns = errorPatterns

  return { check, diagnostics }
}

/** Local alias so the readiness shape can be built up field by field. */
type LiveReadinessInput = NonNullable<LiveCheck['readyWhen']>

/**
 * Parse `verify.json`: the exact `VerifyCommand` shape, for argv a command line
 * cannot express (an argument containing a quote, a newline, or a literal `|`).
 */
export function parsePolicyJson(text: string): { policy: VerifyPolicy; diagnostics: string[] } {
  const diagnostics: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return {
      policy: {},
      diagnostics: [`verify policy is not valid JSON: ${err instanceof Error ? err.message : String(err)}`],
    }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { policy: {}, diagnostics: ['verify policy must be a JSON object of stage → commands'] }
  }

  const policy: VerifyPolicy = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === 'live') {
      const parsed = parseLiveCheck(value)
      if (parsed.check !== null) policy.live = parsed.check
      diagnostics.push(...parsed.diagnostics)
      continue
    }
    if (!isVerifyStage(key)) {
      diagnostics.push(
        `unknown stage ${JSON.stringify(key)}; the nine stages are ${VERIFY_STAGES.join(', ')}`,
      )
      continue
    }
    if (!Array.isArray(value)) {
      diagnostics.push(`stage ${key} must be an array of commands`)
      continue
    }

    const commands: VerifyCommand[] = []
    value.forEach((entry, index) => {
      if (typeof entry === 'string') {
        const command = commandFromLine(key, entry, index)
        if (command !== null) commands.push(command)
        return
      }
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        diagnostics.push(`${key}[${index}] must be a string or a { cmd, args } object`)
        return
      }
      const record = entry as Record<string, unknown>
      const cmd = record['cmd']
      if (typeof cmd !== 'string' || cmd.trim() === '') {
        diagnostics.push(`${key}[${index}].cmd must be a non-empty string`)
        return
      }
      const args = record['args']
      if (args !== undefined && !Array.isArray(args)) {
        diagnostics.push(`${key}[${index}].args must be an array of strings when present`)
        return
      }
      const argv = (args ?? []).map((arg) => String(arg))
      const timeoutMs = record['timeoutMs']
      const cwd = record['cwd']
      commands.push({
        name: typeof record['name'] === 'string' ? (record['name'] as string) : index === 0 ? key : `${key}[${index}]`,
        cmd,
        ...(argv.length > 0 ? { args: argv } : {}),
        ...(typeof cwd === 'string' ? { cwd } : {}),
        ...(typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
      })
    })
    policy[key] = commands
  }

  return { policy, diagnostics }
}

// ── auto-detection, extended to nine stages ─────────────────────────────────
//
// Requirement 4.8: the existing node/python/rust/go detector is the BASELINE and is
// extended, not replaced. `verifier/detector.ts` answers a four-name question
// (lint, typecheck, test, build) and its answers are preserved verbatim here —
// `test` maps to `unit`, and the rest map to themselves. Everything beyond those
// four is additive.
//
// THE RULE FOR ADDING A STAGE: only when the project has ALREADY declared it. A
// detector that invents `npm audit` for every Node project has invented a stage the
// author never asked for, and its first failure is a dependency advisory in a
// transitive package that has nothing to do with the change being verified. So:
// a script in `package.json`, a config file, or nothing.

export type DetectedLanguage = 'node' | 'python' | 'rust' | 'go' | 'unknown'

/** Read a file, or null. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function exists(path: string): Promise<boolean> {
  return (await readIfPresent(path)) !== null
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  const text = await readIfPresent(path)
  if (text === null) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** `npm run <script>`, named for the stage it satisfies. */
function npmScript(stage: VerifyStage, script: string): VerifyCommand {
  return script === 'test'
    ? { name: stage, cmd: 'npm', args: ['test'] }
    : { name: stage, cmd: 'npm', args: ['run', script] }
}

/**
 * Which stages a Node project has, from its own `package.json` scripts.
 *
 * Script names are matched against a small alias table per stage, because
 * `typecheck`, `types` and `tsc` are the same intent and a detector that only knows
 * one of them reports a stage skipped that the project actually has.
 */
const NODE_SCRIPT_ALIASES: Readonly<Record<VerifyStage, readonly string[]>> = Object.freeze({
  format: ['format:check', 'format-check', 'fmt:check', 'prettier:check'],
  lint: ['lint'],
  typecheck: ['typecheck', 'type-check', 'types', 'tsc'],
  build: ['build'],
  unit: ['test:unit', 'test'],
  integration: ['test:integration', 'test:e2e', 'e2e'],
  security: ['security', 'test:security'],
  performance: ['bench', 'benchmark', 'perf', 'test:perf'],
  'dependency-audit': ['audit', 'audit:ci', 'deps:audit'],
})

async function detectNode(root: string): Promise<VerifyPolicy> {
  const pkg = await readJson(join(root, 'package.json'))
  const scripts = (pkg?.['scripts'] ?? {}) as Record<string, unknown>
  const has = (name: string): boolean => typeof scripts[name] === 'string'

  const policy: VerifyPolicy = {}
  for (const stage of VERIFY_STAGES) {
    const script = NODE_SCRIPT_ALIASES[stage].find(has)
    if (script !== undefined) policy[stage] = [npmScript(stage, script)]
  }

  // Config-file fallbacks, preserving the baseline detector's behaviour exactly:
  // it fell back to `npx eslint .` and `npx tsc --noEmit` when the scripts were
  // absent, and those two fallbacks are kept and nothing new is added.
  if (policy.lint === undefined) {
    const eslintConfigs = [
      '.eslintrc.js',
      '.eslintrc.json',
      '.eslintrc.cjs',
      'eslint.config.js',
      'eslint.config.mjs',
    ]
    for (const config of eslintConfigs) {
      if (await exists(join(root, config))) {
        policy.lint = [{ name: 'lint', cmd: 'npx', args: ['eslint', '.'] }]
        break
      }
    }
  }
  if (policy.typecheck === undefined && (await exists(join(root, 'tsconfig.json')))) {
    policy.typecheck = [{ name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'] }]
  }

  return policy
}

async function detectPython(root: string): Promise<VerifyPolicy> {
  const policy: VerifyPolicy = {}
  const pyproject = await exists(join(root, 'pyproject.toml'))

  if (pyproject || (await exists(join(root, 'ruff.toml'))) || (await exists(join(root, '.ruff.toml')))) {
    policy.lint = [{ name: 'lint', cmd: 'ruff', args: ['check', '.'] }]
    // `ruff format --check` is a check, not a rewrite. A formatter that edits files
    // during verification would change the thing being verified.
    policy.format = [{ name: 'format', cmd: 'ruff', args: ['format', '--check', '.'] }]
  }
  if ((await exists(join(root, 'mypy.ini'))) || (await exists(join(root, '.mypy.ini')))) {
    policy.typecheck = [{ name: 'typecheck', cmd: 'mypy', args: ['.'] }]
  }
  if (pyproject || (await exists(join(root, 'pytest.ini'))) || (await exists(join(root, 'tests')))) {
    policy.unit = [{ name: 'unit', cmd: 'pytest', args: [] }]
  }
  return policy
}

function detectRust(): VerifyPolicy {
  return {
    // `--check` for the same reason as Python: verification must not rewrite.
    format: [{ name: 'format', cmd: 'cargo', args: ['fmt', '--check'] }],
    lint: [{ name: 'lint', cmd: 'cargo', args: ['clippy', '--', '-D', 'warnings'] }],
    build: [{ name: 'build', cmd: 'cargo', args: ['build'] }],
    unit: [{ name: 'unit', cmd: 'cargo', args: ['test'] }],
  }
}

function detectGo(): VerifyPolicy {
  return {
    format: [{ name: 'format', cmd: 'gofmt', args: ['-l', '.'] }],
    lint: [{ name: 'lint', cmd: 'go', args: ['vet', './...'] }],
    build: [{ name: 'build', cmd: 'go', args: ['build', './...'] }],
    unit: [{ name: 'unit', cmd: 'go', args: ['test', './...'] }],
  }
}

/** Detect the stack, in the baseline detector's own precedence order. */
export async function detectLanguage(root: string): Promise<DetectedLanguage> {
  if (await exists(join(root, 'package.json'))) return 'node'
  if (
    (await exists(join(root, 'pyproject.toml'))) ||
    (await exists(join(root, 'setup.py'))) ||
    (await exists(join(root, 'requirements.txt')))
  ) {
    return 'python'
  }
  if (await exists(join(root, 'Cargo.toml'))) return 'rust'
  if (await exists(join(root, 'go.mod'))) return 'go'
  return 'unknown'
}

/** The auto-detected policy for a project, with no policy file involved. */
export async function detectVerifyPolicy(
  root: string,
): Promise<{ policy: VerifyPolicy; language: DetectedLanguage }> {
  const language = await detectLanguage(root)
  switch (language) {
    case 'node':
      return { policy: await detectNode(root), language }
    case 'python':
      return { policy: await detectPython(root), language }
    case 'rust':
      return { policy: detectRust(), language }
    case 'go':
      return { policy: detectGo(), language }
    default:
      return { policy: {}, language }
  }
}

/**
 * Resolve the policy for a project: the file if there is one, detection otherwise
 * (Requirement 4.5 — the file takes precedence).
 *
 * A MALFORMED FILE DOES NOT FALL BACK TO DETECTION. It resolves to whatever it could
 * parse, carrying diagnostics. Falling back would mean an author's typo silently
 * runs a completely different gauntlet than the one they wrote, and their build
 * passes for reasons they cannot see. The file is the intent; if it is broken, the
 * answer is to say so.
 */
export async function resolveVerifyPolicy(root: string): Promise<ResolvedPolicy> {
  for (const filename of POLICY_FILENAMES) {
    const path = join(root, filename)
    const text = await readIfPresent(path)
    if (text === null) continue

    const { policy, diagnostics } = filename.endsWith('.json')
      ? parsePolicyJson(text)
      : parsePolicyYaml(text)
    return { policy, source: 'file', path, diagnostics }
  }

  const { policy, language } = await detectVerifyPolicy(root)
  return {
    policy,
    source: Object.keys(policy).length === 0 ? 'none' : 'detected',
    language,
    diagnostics: [],
  }
}

// ── running the gauntlet ────────────────────────────────────────────────────

export interface RunPolicyOptions {
  /** Sink for `verify_started` / `verify_result`. The EventStore satisfies it. */
  sink?: VerifyEventSink
  runId?: string
  signal?: AbortSignal
  /** The verify runner. Injectable for tests; defaults to `runCommands`. */
  run?: typeof runCommands
  /**
   * Project root, needed only when the policy carries a `live` check: the app is
   * started there. Without it a live check is skipped with that as the reason,
   * rather than spawning in whatever directory the process happens to be in.
   */
  root?: string
  /** Live-check runner. Injectable for tests; defaults to `runLiveCheck`. */
  runLive?: typeof runLiveCheck
  /**
   * Keep going after a stage fails.
   *
   * Off by default: the point of an ordered gauntlet is that the first failure is
   * usually the explanation for the rest. A caller collecting a full report (the
   * Test Results panel, the bench harness) turns it on and pays for it.
   */
  continueOnFailure?: boolean
}

/**
 * Run the configured stages in contract order.
 *
 * Never throws. A stage whose commands cannot spawn is a failed stage with the
 * runner's captured reason, because "the tool is not installed" is a verification
 * failure the user needs to see, not an exception that kills the run.
 */
export async function runVerifyPolicy(
  policy: VerifyPolicy,
  options: RunPolicyOptions = {},
): Promise<PolicyResult> {
  const run = options.run ?? runCommands
  const stages: StageResult[] = []
  const results: VerifyResult[] = []
  const ranStages: VerifyStage[] = []
  let failedStage: VerifyStage | null = null
  let totalDurationMs = 0

  const liveCheck = policy.live
  /** Set when a live check ran, so the caller can read its detail, not just its row. */
  let live: LiveResult | null = null

  for (const stage of VERIFY_STAGES) {
    const commands = policy[stage] ?? []
    const runsLive = stage === LIVE_STAGE && liveCheck !== undefined

    if (commands.length === 0 && !runsLive) {
      // Requirement 4.4. Skipped is not a failure, and it says which stage.
      stages.push({
        stage,
        status: 'skipped',
        results: [],
        durationMs: 0,
        reason: `no ${stage} stage is configured for this project`,
      })
      continue
    }

    if (failedStage !== null && options.continueOnFailure !== true) {
      // NOT the same as skipped. See the header.
      stages.push({
        stage,
        status: 'not-run',
        results: [],
        durationMs: 0,
        reason: `stopped after ${failedStage} failed`,
      })
      continue
    }

    const stageResults =
      commands.length === 0
        ? []
        : await run(commands, {
            ...(options.sink !== undefined ? { sink: options.sink } : {}),
            ...(options.runId !== undefined ? { runId: options.runId } : {}),
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
          })

    // The live check runs AFTER this stage's commands: an integration suite that
    // already fails tells you more than a dev server that also fails, and starting an
    // app takes seconds that a failing suite has already made pointless.
    if (runsLive && (stageResults.every((result) => result.ok) || options.continueOnFailure === true)) {
      const runner = options.runLive ?? runLiveCheck
      live =
        options.root === undefined
          ? {
              name: liveCheck!.name ?? 'live',
              status: 'skipped',
              ok: true,
              // Honest rather than convenient: guessing a root would start the app in
              // whatever directory this process happens to be in.
              reason:
                'the live check was skipped because no project root was supplied to the verify policy',
              output: '',
              heuristic: false,
              durationMs: 0,
            }
          : await runner(liveCheck!, {
              root: options.root,
              ...(options.signal !== undefined ? { signal: options.signal } : {}),
            })

      if (live.status !== 'skipped') {
        const asResult = liveResultToVerifyResult(live)
        // Announced and recorded through the same sink as every command, so a live
        // verdict appears on the Timeline like the rest of the gauntlet (4.6). The
        // pair is emitted here rather than by `runLiveCheck`, which has no sink: the
        // check is a long-lived process, not a command, and giving it its own sink
        // would be a second place verify events come from.
        await options.sink?.emit({
          runId: options.runId ?? 'verify',
          kind: 'verify_started',
          payload: { name: asResult.name, live: true },
        })
        await options.sink?.emit({
          runId: options.runId ?? 'verify',
          kind: 'verify_result',
          payload: { ...asResult, live: { status: live.status, heuristic: live.heuristic } },
        })
        stageResults.push(asResult)
      }
    }

    if (stageResults.length === 0) {
      // A stage whose only content was a live check that skipped itself is skipped,
      // not failed. Requirement 23.4: a project the stage does not apply to must not
      // be penalised for it.
      stages.push({
        stage,
        status: 'skipped',
        results: [],
        durationMs: 0,
        reason: live?.reason ?? `no ${stage} stage is configured for this project`,
      })
      continue
    }

    const durationMs = stageResults.reduce((sum, result) => sum + result.durationMs, 0)
    const ok = stageResults.every((result) => result.ok)

    results.push(...stageResults)
    ranStages.push(stage)
    totalDurationMs += durationMs
    stages.push({
      stage,
      status: ok ? 'passed' : 'failed',
      results: stageResults,
      durationMs,
      reason: null,
    })
    if (!ok && failedStage === null) failedStage = stage
  }

  const verifiedAnything = results.length > 0
  return {
    ...(live !== null ? { live } : {}),
    // Requirement 4.7: every non-skipped stage passed, or nothing was configured.
    ok: stages.every((entry) => entry.status === 'passed' || entry.status === 'skipped'),
    stages,
    failedStage,
    ranStages,
    verifiedAnything,
    results,
    totalDurationMs,
  }
}

/** Resolve and run in one call. What a caller with just a project root wants. */
export async function verifyProject(
  root: string,
  options: RunPolicyOptions = {},
): Promise<PolicyResult & { resolved: ResolvedPolicy }> {
  const resolved = await resolveVerifyPolicy(root)
  // The root is the app's cwd for a live check, and its absence is why a live check
  // would otherwise skip itself.
  const result = await runVerifyPolicy(resolved.policy, { root, ...options })
  return { ...result, resolved }
}

/** One-line summary per stage. What the model and the panel both read. */
export function formatPolicyResult(result: PolicyResult): string {
  const head = result.ok
    ? result.verifiedAnything
      ? `VERIFY PASS (${result.ranStages.length} stage(s) ran)`
      : 'VERIFY: no stages are configured for this project, so nothing ran'
    : `VERIFY FAIL at ${result.failedStage}`

  const lines = result.stages.map((stage) => {
    if (stage.status === 'skipped' || stage.status === 'not-run') {
      return `- ${stage.stage}: ${stage.status.toUpperCase()} (${stage.reason})`
    }
    const detail = stage.results
      .map((entry) => `${entry.name} exit ${entry.exitCode}`)
      .join(', ')
    return `- ${stage.stage}: ${stage.status.toUpperCase()} in ${stage.durationMs}ms (${detail})`
  })

  return [head, ...lines].join('\n')
}
