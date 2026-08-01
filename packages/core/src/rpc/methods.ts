// The five protocol methods (Requirement 12.2): ping, run, eval, parse-skill,
// capture-eval.
//
// Every handler is a plain async function of `(params, ctx)`. Nothing here reads
// `process.stdin`, writes `process.stdout`, or knows what a frame looks like —
// that is `server.ts`. The split is what makes dispatch unit-testable without a
// child process.
//
// PARAMS ARRIVE FROM A PIPE, SO THEY ARE VALIDATED, NOT TRUSTED. Anything an
// unvalidated field reaches is a path (`root`, `parse-skill.path`), a spawned
// process (`task.verify[].cmd`), or a network call (`provider.baseUrl`). Each
// reader below fails with an `InvalidParamsError` naming the exact field, which
// the server turns into `{ ok: false, code: "invalid_params" }`.
//
// THE PLAN GATE IS NOT RE-IMPLEMENTED HERE. `run` builds a `PlanWriter` rooted at
// the project and hands it to `runTask`; the gate lives in the loop and asks the
// filesystem (Requirement 6.5). There is deliberately no parameter that disables
// it, skips it, or pre-seeds a plan — a CLI-driven run gets exactly the same
// refusal an in-process one does.
//
// Validates: Requirements 12.2, 12.5, 6.5

import { stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import {
  assembleContext,
  buildRepoGraph,
  generateArchitecture,
  graphPath,
  loadRepoGraph,
} from '../context/index.js'
import { JsonlEventStore, MemoryEventStore, secretsFromEnv } from '../events/index.js'
import type { EventStore } from '../events/index.js'
import {
  runEvalSet,
  meanScore,
  captureRunAsEval,
  evalsFilePath,
  loadEvalCases as readEvalCases,
} from '../evals/index.js'
import type { EvalDeps } from '../evals/index.js'
import { installSkill, installedSkillsDir, loadManifest } from '../registry/index.js'
import type { RegistryManifest } from '../registry/index.js'
import { runTask } from '../loop/index.js'
import { DiskFileWriter } from '../orchestrator/file-writer.js'
import { PlanWriter } from '../plan/index.js'
import { describeProvider, fakeProviderEnabled, resolveAdapter } from '../providers/index.js'
import {
  loadProviderSettings,
  providerMatrix,
  providersFilePath,
  saveProviderSettings,
  testProviderConnection,
} from '../settings/index.js'
import type { ProviderTestTarget } from '../settings/index.js'
import {
  BEST_SKILL_FILENAME,
  loadProjectContext,
  loadSkillFile,
  loadSkillFolder,
  loadSkills,
  providerProposeEdit,
  trainSkill,
} from '../skills/index.js'
import { GitTool } from '../tools/index.js'
import type {
  ChatAdapter,
  Check,
  EvalCase,
  ProviderConfig,
  ProviderKind,
  RunResult,
  Skill,
  SketchEvent,
  Task,
  VerifyCommand,
} from '../types.js'
import { StreamingEventStore } from './streaming-store.js'
import { ENGINE_NAME, ENGINE_VERSION, PROTOCOL_VERSION } from './version.js'

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** `params` did not satisfy the method. Becomes `code: "invalid_params"`. */
export class InvalidParamsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidParamsError'
  }
}

/** A declared method whose body lands in a later task. `code: "not_implemented"`. */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotImplementedError'
  }
}

/** What a handler is given besides its params. */
export interface MethodContext {
  /** Stream one persisted event to the caller as an event frame. */
  emitEvent(event: SketchEvent): void
  /** Diagnostics. Goes to stderr — never stdout (Requirement 12.5). */
  log(message: string): void
  /**
   * Register a credential VALUE seen in params so every subsequent outgoing frame
   * redacts it, whatever path it would otherwise have taken to stdout.
   */
  rememberSecret(value: string): void
  /** Known secret values: the environment's, plus everything remembered. */
  secrets(): readonly string[]
  env: NodeJS.ProcessEnv
  cwd(): string
}

export type MethodHandler = (
  params: Record<string, unknown>,
  ctx: MethodContext,
) => Promise<unknown>

// ── param readers ────────────────────────────────────────────────────────────

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidParamsError(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function readString(source: Record<string, unknown>, key: string, field: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidParamsError(`${field} must be a non-empty string`)
  }
  return value
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
  field: string,
): string | undefined {
  const value = source[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidParamsError(`${field} must be a non-empty string when present`)
  }
  return value
}

function optionalNumber(
  source: Record<string, unknown>,
  key: string,
  field: string,
): number | undefined {
  const value = source[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidParamsError(`${field} must be a finite number when present`)
  }
  return value
}

function optionalBoolean(
  source: Record<string, unknown>,
  key: string,
  field: string,
): boolean | undefined {
  const value = source[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') {
    throw new InvalidParamsError(`${field} must be a boolean when present`)
  }
  return value
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new InvalidParamsError(`${field} must be an array of strings`)
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new InvalidParamsError(`${field}[${index}] must be a string`)
    }
    return entry
  })
}

function readVerifyCommands(value: unknown, field: string): VerifyCommand[] {
  // Absent means "no verification configured", which the loop already has a
  // defined meaning for (Requirement 5.8). It is not an error.
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new InvalidParamsError(`${field} must be an array`)

  return value.map((entry, index) => {
    const item = asObject(entry, `${field}[${index}]`)
    const command: VerifyCommand = {
      name: readString(item, 'name', `${field}[${index}].name`),
      // `cmd` is spawned with shell: false by the verify runner, so it is an
      // executable name and never a shell line.
      cmd: readString(item, 'cmd', `${field}[${index}].cmd`),
    }
    const args = optionalStringArray(item['args'], `${field}[${index}].args`)
    if (args) command.args = args
    const cwd = optionalString(item, 'cwd', `${field}[${index}].cwd`)
    if (cwd) command.cwd = cwd
    const timeoutMs = optionalNumber(item, 'timeoutMs', `${field}[${index}].timeoutMs`)
    if (timeoutMs !== undefined) command.timeoutMs = timeoutMs
    return command
  })
}

function readTask(value: unknown, field: string): Task {
  const source = asObject(value, field)
  const task: Task = {
    id: readString(source, 'id', `${field}.id`),
    prompt: readString(source, 'prompt', `${field}.prompt`),
    verify: readVerifyCommands(source['verify'], `${field}.verify`),
  }
  const skillNames = optionalStringArray(source['skillNames'], `${field}.skillNames`)
  if (skillNames) task.skillNames = skillNames
  return task
}

function readCheck(value: unknown, field: string): Check {
  const source = asObject(value, field)
  const kind = readString(source, 'kind', `${field}.kind`)
  switch (kind) {
    case 'verify-pass':
      return { kind: 'verify-pass' }
    case 'contains':
      return { kind: 'contains', text: readString(source, 'text', `${field}.text`) }
    case 'not-contains':
      return { kind: 'not-contains', text: readString(source, 'text', `${field}.text`) }
    default:
      throw new InvalidParamsError(
        `${field}.kind must be one of verify-pass, contains, not-contains`,
      )
  }
}

function readCases(value: unknown, field: string): EvalCase[] {
  if (!Array.isArray(value)) {
    throw new InvalidParamsError(`${field} must be an array of eval cases`)
  }
  return value.map((entry, index) => {
    const source = asObject(entry, `${field}[${index}]`)
    const checks = source['checks']
    if (checks !== undefined && checks !== null && !Array.isArray(checks)) {
      throw new InvalidParamsError(`${field}[${index}].checks must be an array`)
    }
    return {
      id: readString(source, 'id', `${field}[${index}].id`),
      task: readTask(source['task'], `${field}[${index}].task`),
      checks: ((checks ?? []) as unknown[]).map((check, at) =>
        readCheck(check, `${field}[${index}].checks[${at}]`),
      ),
    }
  })
}

const PROVIDER_KINDS: readonly ProviderKind[] = ['openai-compatible', 'anthropic-messages']

/**
 * The offline config used when no provider was supplied and
 * `SKETCH_FAKE_PROVIDER=1` is set. `resolveAdapter` ignores every field of it in
 * that mode and hands back the fake; it exists only to satisfy the signature.
 */
const OFFLINE_CONFIG: ProviderConfig = {
  id: 'fake',
  kind: 'openai-compatible',
  baseUrl: '',
  model: 'fake',
}

function readProviderConfig(value: unknown, ctx: MethodContext): ProviderConfig {
  const source = asObject(value, 'params.provider')
  const kind = readString(source, 'kind', 'params.provider.kind')
  if (!PROVIDER_KINDS.includes(kind as ProviderKind)) {
    throw new InvalidParamsError(
      `params.provider.kind must be one of ${PROVIDER_KINDS.join(', ')}`,
    )
  }

  const config: ProviderConfig = {
    id: readString(source, 'id', 'params.provider.id'),
    kind: kind as ProviderKind,
    // Empty is legal: `resolveAdapter` fills it from the catalog default.
    baseUrl: typeof source['baseUrl'] === 'string' ? source['baseUrl'] : '',
    model: readString(source, 'model', 'params.provider.model'),
  }

  const apiKey = optionalString(source, 'apiKey', 'params.provider.apiKey')
  if (apiKey !== undefined) {
    // THE KEY STOPS HERE. Registering it means every outgoing frame — response,
    // error, and event alike — has this value scrubbed out of it before it
    // reaches stdout.
    ctx.rememberSecret(apiKey)
    config.apiKey = apiKey
  }

  const headers = source['headers']
  if (headers !== undefined && headers !== null) {
    const record = asObject(headers, 'params.provider.headers')
    const out: Record<string, string> = {}
    for (const [name, headerValue] of Object.entries(record)) {
      if (typeof headerValue !== 'string') {
        throw new InvalidParamsError(`params.provider.headers.${name} must be a string`)
      }
      // A header value is credential material as often as `apiKey` is.
      ctx.rememberSecret(headerValue)
      out[name] = headerValue
    }
    config.headers = out
  }

  return config
}

/**
 * Resolve the model seam. With no `params.provider` this requires the offline
 * switch, so a caller can never accidentally get a silently degraded run: either
 * it named a provider, or it asked for the fake.
 */
function adapterFor(params: Record<string, unknown>, ctx: MethodContext): ChatAdapter {
  const provider = params['provider']
  if (provider === undefined || provider === null) {
    if (!fakeProviderEnabled(ctx.env)) {
      throw new InvalidParamsError(
        'params.provider is required; set SKETCH_FAKE_PROVIDER=1 to run against the offline provider instead',
      )
    }
    return resolveAdapter(OFFLINE_CONFIG, ctx.env)
  }
  return resolveAdapter(readProviderConfig(provider, ctx), ctx.env)
}

/**
 * Skills for a run. Selection is EXPLICIT: with no `skillNames` on the task or
 * the params, nothing is loaded and the skills directory is not even read. A CLI
 * caller that wants a skill in the prompt says so — silently injecting every
 * skill found on disk would change a run's cost and behavior invisibly.
 */
async function loadRequestedSkills(
  root: string,
  params: Record<string, unknown>,
  task: Task,
  ctx: MethodContext,
): Promise<Skill[]> {
  const names =
    task.skillNames ?? optionalStringArray(params['skillNames'], 'params.skillNames')
  if (names === undefined || names.length === 0) return []

  const dir = optionalString(params, 'skillsDir', 'params.skillsDir') ?? join(root, '.sketch', 'skills')
  const { skills, diagnostics } = await loadSkills(dir)
  for (const diagnostic of diagnostics) ctx.log(`skill diagnostic: ${diagnostic}`)

  const selected: Skill[] = []
  for (const name of names) {
    const found = skills.find((skill) => skill.name === name)
    if (found) selected.push(found)
    // A missing skill is a diagnostic, not a failed run: the task still has its
    // prompt, and killing the run over a renamed skill file is worse.
    else ctx.log(`skill not found in ${dir}: ${name}`)
  }
  return selected
}

// ── methods ──────────────────────────────────────────────────────────────────

/**
 * Liveness plus identity. No filesystem, no network, no credentials — this is the
 * startup call for both transports and it must succeed offline (Requirement 13.6).
 */
async function ping(_params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  return {
    ok: true,
    engine: ENGINE_NAME,
    version: ENGINE_VERSION,
    protocol: PROTOCOL_VERSION,
    node: process.version,
    pid: process.pid,
    /** True when every provider resolution in this process returns the fake. */
    fakeProvider: fakeProviderEnabled(ctx.env),
  }
}

/**
 * Run one task to completion, streaming events as they are persisted.
 *
 * The event store is the JSONL one rooted at the project, so a CLI run leaves the
 * same durable log a desktop run does, and the tee streams exactly what it wrote.
 *
 * ── RETRIEVED CONTEXT IS OPT-IN (`contextBudgetTokens`) ────────────────────────
 * With the parameter absent, this method behaves exactly as it did before Phase 5:
 * no index is read, no retrieval runs, and the prompt is the task plus skills plus
 * `AGENTS.md`. That default is deliberate. Retrieval adds tokens to every request,
 * tokens are money on a paid provider, and the budget guard that would bound the
 * spend is Phase 8. Turning it on for every caller before that guard exists would
 * be spending the user's money on a default they never chose.
 *
 * With a positive budget, `assembleContext` runs against the PERSISTED graph and
 * the loop is handed the text (see `RunTaskDeps.retrievedContext`). Assembly emits
 * `context_assembled` with the paths and the estimate, so what the model was shown
 * is on the log either way.
 *
 * No graph on disk means no retrieval: `assembleContext` would otherwise walk the
 * user's whole tree because a run started. The refusal is logged, not silent.
 */
async function run(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const task = readTask(params['task'], 'params.task')
  const root = resolve(optionalString(params, 'root', 'params.root') ?? ctx.cwd())
  const adapter = adapterFor(params, ctx)
  const maxIterations = optionalNumber(params, 'maxIterations', 'params.maxIterations')
  const reviewEdits = optionalBoolean(params, 'reviewEdits', 'params.reviewEdits')
  const contextBudgetTokens = optionalNumber(
    params,
    'contextBudgetTokens',
    'params.contextBudgetTokens',
  )

  const events = new StreamingEventStore(
    new JsonlEventStore({ baseDir: root, secrets: () => ctx.secrets() }),
    (event) => ctx.emitEvent(event),
  )

  const skills = await loadRequestedSkills(root, params, task, ctx)
  const retrievedContext = await retrieveContextFor(
    root,
    task,
    skills,
    contextBudgetTokens,
    events,
    ctx,
  )

  return runTask(task, {
    adapter,
    events,
    // The gate, unmodified and un-bypassable from here.
    plan: new PlanWriter({ baseDir: root, events }),
    files: new DiskFileWriter(),
    root,
    skills,
    projectContext: await loadProjectContext(root),
    ...(retrievedContext !== undefined ? { retrievedContext } : {}),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    ...(reviewEdits !== undefined ? { reviewEdits } : {}),
  })
}

/**
 * Assemble retrieved context for a run, or return `undefined` and say why.
 *
 * Retrieval failing must not fail the run: a task with no context is a worse run,
 * not a dead one, and a corrupt index is a live possibility (`loadRepoGraph`
 * already treats one as "no graph"). The reason is logged through `ctx.log`, which
 * is stderr on the wire, so it never contaminates the event stream on stdout.
 */
async function retrieveContextFor(
  root: string,
  task: Task,
  skills: readonly Skill[],
  budgetTokens: number | undefined,
  events: EventStore,
  ctx: MethodContext,
): Promise<string | undefined> {
  if (budgetTokens === undefined) return undefined
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) {
    ctx.log(`context retrieval skipped: contextBudgetTokens must be positive, got ${budgetTokens}`)
    return undefined
  }

  const graph = await loadRepoGraph(root)
  if (graph === null) {
    ctx.log(
      `context retrieval skipped: no repository graph at ${graphPath(root)} ` +
        `(build one with the architecture method's index flag)`,
    )
    return undefined
  }

  try {
    const assembled = await assembleContext({
      root,
      baseDir: root,
      query: task.prompt,
      budgetTokens: Math.floor(budgetTokens),
      graph,
      skills,
      events,
      runId: task.id,
    })
    if (assembled.text === '') {
      ctx.log('context retrieval produced nothing: no chunk matched the task prompt')
      return undefined
    }
    return assembled.text
  } catch (err) {
    ctx.log(`context retrieval failed, continuing without it: ${messageOf(err)}`)
    return undefined
  }
}

/**
 * Score a set of eval cases.
 *
 * With no `root` the harness makes an isolated temp workspace per case and the
 * events go to an in-memory store — the right default for scoring, since a scored
 * run should not litter the user's project. Supplying `root` opts into the real
 * project and the durable log.
 */
async function evalCases(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const cases = readCases(params['cases'], 'params.cases')
  const adapter = adapterFor(params, ctx)
  const maxIterations = optionalNumber(params, 'maxIterations', 'params.maxIterations')
  const root = optionalString(params, 'root', 'params.root')

  const inner: EventStore =
    root === undefined
      ? new MemoryEventStore({ secrets: () => ctx.secrets() })
      : new JsonlEventStore({ baseDir: resolve(root), secrets: () => ctx.secrets() })
  const events = new StreamingEventStore(inner, (event) => ctx.emitEvent(event))

  const deps: EvalDeps = {
    adapter,
    events,
    ...(root !== undefined
      ? { root: resolve(root), plan: new PlanWriter({ baseDir: resolve(root), events }) }
      : {}),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
  }

  const results = await runEvalSet(cases, deps)
  return { results, mean: meanScore(results) }
}

// ── git ──────────────────────────────────────────────────────────────────────
//
// The Git panel is a UI over these five methods, NOT over the Tauri `git_status`
// command. Two reasons, both structural:
//
//   * the parser. `tools/git.ts` understands renames, quoted and non-ASCII paths,
//     a detached HEAD, and "this is not a repository"; the Rust command's offset
//     split does not. One parser, in the engine, reached the same way by both
//     transports.
//   * the seam. Engine capabilities belong on `SketchClient` (the note at the top
//     of packages/desktop/src/ipc/bridge.ts says exactly this), so the panel works
//     in the browser dev bridge as well as in the app.
//
// EVENTS. Mutations are recorded through the same JSONL store a run uses, so a
// stage or a commit shows up on the Timeline. Reads are not: the panel polls
// `git-status` on every refresh and an append-only log is the wrong home for that.

/**
 * The project a git call applies to. Required and explicit — falling back to the
 * server's cwd for a mutation would let a caller commit in the wrong repository by
 * omitting a field.
 */
function gitRoot(params: Record<string, unknown>): string {
  return resolve(readString(params, 'root', 'params.root'))
}

function gitPaths(params: Record<string, unknown>): string[] {
  const paths = optionalStringArray(params['paths'], 'params.paths')
  if (paths === undefined || paths.length === 0) {
    throw new InvalidParamsError('params.paths must be a non-empty array of paths')
  }
  return paths
}

/** A tool that records mutations where the run log lives. */
function gitTool(root: string, ctx: MethodContext, record: boolean): GitTool {
  if (!record) return new GitTool({ root })
  const events = new StreamingEventStore(
    new JsonlEventStore({ baseDir: root, secrets: () => ctx.secrets() }),
    (event) => ctx.emitEvent(event),
  )
  return new GitTool({ root, events })
}

async function gitStatus(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  return gitTool(gitRoot(params), ctx, false).status()
}

async function gitDiff(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const path = optionalString(params, 'path', 'params.path')
  const staged = params['staged']
  if (staged !== undefined && staged !== null && typeof staged !== 'boolean') {
    throw new InvalidParamsError('params.staged must be a boolean when present')
  }
  const diff = await gitTool(gitRoot(params), ctx, false).diff({
    ...(path !== undefined ? { path } : {}),
    ...(staged === true ? { staged: true } : {}),
  })
  return { diff }
}

async function gitStage(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const root = gitRoot(params)
  const tool = gitTool(root, ctx, true)
  await tool.stage(gitPaths(params))
  // The fresh status is returned so the panel cannot render a stale list after a
  // successful mutation.
  return tool.status()
}

async function gitUnstage(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const root = gitRoot(params)
  const tool = gitTool(root, ctx, true)
  await tool.unstage(gitPaths(params))
  return tool.status()
}

async function gitCommit(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const root = gitRoot(params)
  const tool = gitTool(root, ctx, true)
  // An empty message is refused by the tool before anything is spawned, and the
  // refusal is recorded as `tool_denied`.
  const message = typeof params['message'] === 'string' ? params['message'] : ''
  const result = await tool.commit(message)
  return { output: result.output, status: await tool.status() }
}

// ── provider settings ────────────────────────────────────────────────────────
//
// The Provider Settings surface is a UI over these three methods, for the same two
// reasons the Git panel is a UI over `git-*`: the provider catalog and the key-free
// serializer live in the engine and are not duplicated, and a capability on this
// seam works under the browser dev bridge as well as in the app.
//
// NO METHOD HERE ACCEPTS A KEY TO STORE. `provider-test` takes one for the duration
// of one request (registered as a secret, so it cannot ride an outgoing frame), and
// `provider-config-save` runs its payload through the whitelist + byte-level guard
// that make `providers.json` key-free (Requirements 17.2, 17.4).

/**
 * Which `providers.json` a call is about. `home` (not a full path) so the filename
 * cannot be redirected: a caller may point at a different home directory, never at
 * an arbitrary file.
 */
function settingsPath(params: Record<string, unknown>): string | undefined {
  const home = optionalString(params, 'home', 'params.home')
  return home === undefined ? undefined : providersFilePath(resolve(home))
}

/** The full matrix from the registry, plus whatever is configured on disk. */
async function providerCatalog(params: Record<string, unknown>): Promise<unknown> {
  const path = settingsPath(params)
  const loaded = await loadProviderSettings(path)
  return {
    catalog: providerMatrix(),
    settings: loaded.settings,
    path: loaded.path,
    ...(loaded.diagnostic !== undefined ? { diagnostic: loaded.diagnostic } : {}),
  }
}

/** Persist key-free configuration. Returns what was actually written. */
async function providerConfigSave(params: Record<string, unknown>): Promise<unknown> {
  const settings = params['settings']
  if (settings === undefined || settings === null) {
    throw new InvalidParamsError('params.settings must be an object')
  }
  asObject(settings, 'params.settings')
  const saved = await saveProviderSettings(settings, settingsPath(params))
  return { settings: saved.settings, path: saved.path }
}

/**
 * Run one connection test. A real network call, so it happens only because a user
 * asked: nothing in the engine calls this on startup.
 */
async function providerTest(
  params: Record<string, unknown>,
  ctx: MethodContext,
): Promise<unknown> {
  // Reuses the run path's reader, which is what registers the key as a secret.
  const config = readProviderConfig(params['provider'], ctx)
  const timeoutMs = optionalNumber(params, 'timeoutMs', 'params.timeoutMs')
  const target: ProviderTestTarget = {
    id: config.id,
    kind: config.kind,
    // An empty baseUrl falls back to the catalog default, exactly as a run does.
    baseUrl: config.baseUrl || (describeProvider(config.id)?.defaultBaseUrl ?? ''),
    model: config.model,
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
  }
  return testProviderConnection(target, {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  })
}

// ── architecture ─────────────────────────────────────────────────────────────
//
// The Live Architecture panel is a UI over this ONE method, for the same reason the
// Git panel is a UI over `git-*`: the generator reads the persisted graph and the
// bytes of the files it lists, which is machine work, so it belongs to the engine
// and reaches the panel through `SketchClient` on both transports.
//
// WHY `index` IS A PARAMETER RATHER THAN A SECOND METHOD. With no graph on disk
// every view comes back unavailable, and the only useful thing a surface can offer
// is "index this project". That offer has to be actionable, and building the graph
// then deriving from it is a single round trip with one honest answer — a separate
// `repo-index` method would let a caller index and never regenerate, which is how a
// panel ends up showing diagrams for a graph that has since been rebuilt.
//
// NO NETWORK, EVER (Requirement 19.5): the walk, the graph and all seven views are
// pure derivations over local text. `diagram_updated` is recorded through the same
// JSONL store a run uses (Requirement 19.2), so a regeneration shows up on the
// Timeline; the generator emits exactly one per call.

async function architecture(
  params: Record<string, unknown>,
  ctx: MethodContext,
): Promise<unknown> {
  const root = resolve(readString(params, 'root', 'params.root'))
  const index = optionalBoolean(params, 'index', 'params.index')
  const maxNodes = optionalNumber(params, 'maxNodes', 'params.maxNodes')
  const maxEdges = optionalNumber(params, 'maxEdges', 'params.maxEdges')

  const events = new StreamingEventStore(
    new JsonlEventStore({ baseDir: root, secrets: () => ctx.secrets() }),
    (event) => ctx.emitEvent(event),
  )

  // Indexing is explicit. A read that silently rebuilt the graph would walk the
  // user's whole tree because a panel was opened.
  const built = index === true ? await buildRepoGraph({ root, events }) : null
  const graph = built === null ? await loadRepoGraph(root) : built.graph

  const diagrams = await generateArchitecture({
    graph,
    root,
    baseDir: root,
    events,
    ...(maxNodes !== undefined ? { maxNodes } : {}),
    ...(maxEdges !== undefined ? { maxEdges } : {}),
  })

  return {
    root,
    // Named so a surface with no graph can say WHERE it looked.
    graphPath: graphPath(root),
    graphPresent: graph !== null,
    ...(built === null ? {} : { indexed: built.stats }),
    diagrams,
  }
}

// ── skills: the registry, installing from it, and training against it ────────
//
// The Skills surface is a UI over these three methods, for the third time and the
// same reason: hashing a directory, writing into `.sketch/skills/`, and scoring an
// eval set are all machine work, so they belong to the engine and reach the panel
// through `SketchClient` on both transports.
//
// WHAT EACH ONE REFUSES TO DO:
//   * `skills-catalog` reads. It never installs, so opening a panel cannot write.
//   * `skill-install` verifies before it writes, and has no force parameter. There
//     is deliberately no way to ask it to skip the hash check (see `install.ts`).
//   * `skill-train` is EXPLICIT and off the hot path (Requirement 9.6): nothing
//     calls it during a task run, and it is the only method here that can reach a
//     provider. Its spend is bounded by the optimizer's own training budget.

/** Env var naming the registry directory, for a caller that cannot pass params. */
export const REGISTRY_DIR_ENV = 'SKETCH_REGISTRY_DIR'

/**
 * Where the pinned registry lives, or null.
 *
 * THERE IS NO PATH-RELATIVE DEFAULT, and that is not an omission. The sidecar is a
 * single esbuild-bundled file copied next to the app binary: there is no
 * `node_modules`, no package layout, and nothing at a path relative to
 * `import.meta.url`. A default computed that way resolves under vitest, resolves
 * from `dist/`, and then points at nothing in the shipped app — the exact class of
 * defect `cli.test.ts`'s sidecar-hazard guard exists to catch, and it caught this.
 *
 * So the location is supplied: `params.registryDir`, or `SKETCH_REGISTRY_DIR` for a
 * caller with no params to spare. With neither, the catalog reports that no registry
 * is configured and names the parameter — an honest nothing rather than an empty
 * list that reads as "there are no skills to install".
 *
 * The seeded registry ships in this package under `registry/` (see `files` in
 * package.json). Pointing the app at it belongs to packaging, task 12.1, which is
 * where the resource layout is decided.
 */
function configuredRegistryDir(
  params: Record<string, unknown>,
  ctx: MethodContext,
): string | null {
  const fromParams = optionalString(params, 'registryDir', 'params.registryDir')
  if (fromParams !== undefined) return resolve(fromParams)
  const fromEnv = ctx.env[REGISTRY_DIR_ENV]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv)
  return null
}

/** Said in one place, so both methods refuse identically. */
const NO_REGISTRY_REASON =
  `no skill registry is configured: pass params.registryDir, or set ${REGISTRY_DIR_ENV}. ` +
  `The curated registry ships inside @sketch/core under registry/`

/**
 * The catalog: every pinned skill, plus what is installed in this project.
 *
 * `installed` is read from disk rather than from a list the UI keeps, so a skill
 * removed by hand shows as removed and the panel cannot disagree with the
 * filesystem — the same discipline as one authoritative file cache in the editor.
 */
async function skillsCatalog(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const root = resolve(optionalString(params, 'root', 'params.root') ?? ctx.cwd())
  const registryDir = configuredRegistryDir(params, ctx)

  let manifest: RegistryManifest | null = null
  let diagnostic: string | undefined
  if (registryDir === null) {
    diagnostic = NO_REGISTRY_REASON
  } else {
    try {
      manifest = (await loadManifest(registryDir)).manifest
    } catch (err) {
      // A registry that cannot be read is a surface that must say so, not an empty
      // list that reads as "there are no skills".
      manifest = null
      diagnostic = messageOf(err)
    }
  }

  const dir = installedSkillsDir(root)
  const { skills, diagnostics } = await loadSkills(dir)
  for (const message of diagnostics) ctx.log(`skill diagnostic: ${message}`)

  return {
    root,
    registryDir,
    installedDir: dir,
    ...(manifest === null ? {} : { registry: manifest.registry, distribution: manifest.distribution }),
    entries:
      manifest === null
        ? []
        : manifest.entries.map((entry) => ({
            name: entry.name,
            version: entry.version,
            pack: entry.pack,
            summary: entry.summary,
            digest: entry.digest,
            capabilities: entry.capabilities,
            source: entry.source,
            license: entry.license,
            files: entry.files?.length ?? 0,
            // What the user needs before consenting: is it here, and is what is
            // here still what the manifest describes.
            installed: skills.some((skill) => skill.name === entry.name),
          })),
    installed: skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: skill.source,
      capabilities: skill.capabilities ?? [],
    })),
    ...(diagnostic !== undefined ? { diagnostic } : {}),
    diagnostics,
  }
}

/**
 * Install one pinned skill into a project. Verifies first; refuses on mismatch.
 *
 * There is no `force`. An escape hatch on the hash check is the same thing as not
 * having the check.
 */
async function skillInstall(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const root = resolve(optionalString(params, 'root', 'params.root') ?? ctx.cwd())
  const registryDir = configuredRegistryDir(params, ctx)
  const name = readString(params, 'name', 'params.name')
  if (registryDir === null) throw new InvalidParamsError(NO_REGISTRY_REASON)

  const { manifest } = await loadManifest(registryDir)
  const events = new StreamingEventStore(
    new JsonlEventStore({ baseDir: root, secrets: () => ctx.secrets() }),
    (event) => ctx.emitEvent(event),
  )

  const result = await installSkill({
    manifest,
    registryDir,
    name,
    projectRoot: root,
    events,
    runId: `install-${name}`,
  })

  return {
    ok: result.ok,
    name: result.name,
    ...(result.dir !== undefined ? { dir: result.dir } : {}),
    ...(result.digest !== undefined ? { digest: result.digest } : {}),
    ...(result.granted !== undefined ? { granted: result.granted } : {}),
    ...(result.skill !== undefined
      ? { skill: { name: result.skill.name, description: result.skill.description } }
      : {}),
    warnings: result.warnings,
    reason: result.reason,
    files: result.written.length,
  }
}

/**
 * Train one installed skill on this project's captured evals (Requirement 9.6).
 *
 * OFF THE HOT PATH, and structurally so: nothing in `loop/` can reach this, it is
 * only invoked by an explicit user action, and the strict `>` gate inside
 * `trainSkill` is not parameterised from here — there is no way to ask this method
 * to accept a tie.
 *
 * The cases come from `.sketch/evals/evals.jsonl`, which is what capture-as-eval
 * has been writing since Phase 2: the user's own runs, scoring their own project.
 * That is the compounding loop, and this is the method that closes it.
 */
async function skillTrain(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const root = resolve(optionalString(params, 'root', 'params.root') ?? ctx.cwd())
  const name = readString(params, 'name', 'params.name')
  const epochs = optionalNumber(params, 'epochs', 'params.epochs')
  const maxCalls = optionalNumber(params, 'maxCalls', 'params.maxCalls')
  const maxTokens = optionalNumber(params, 'maxTokens', 'params.maxTokens')
  const guidance = optionalString(params, 'guidance', 'params.guidance')
  const write = optionalBoolean(params, 'write', 'params.write')
  const adapter = adapterFor(params, ctx)

  const { skills, diagnostics } = await loadSkills(installedSkillsDir(root))
  for (const message of diagnostics) ctx.log(`skill diagnostic: ${message}`)
  const seed = skills.find((skill) => skill.name === name)
  if (seed === undefined) {
    throw new InvalidParamsError(
      `no installed skill named ${JSON.stringify(name)} in ${installedSkillsDir(root)}`,
    )
  }

  const captured = await readEvalCases(root)
  for (const message of captured.diagnostics) ctx.log(`eval diagnostic: ${message}`)
  const cases = captured.cases
  if (cases.length < 2) {
    // Fewer than two cases cannot be split into a train set and a held-out set, and
    // training with no held-out set is not training — it is editing.
    return {
      ok: false,
      name,
      reason:
        `training needs at least 2 captured eval cases and found ${cases.length} in ` +
        `${evalsFilePath(root)}. Capture some runs first: a trainer with no held-out ` +
        `split cannot measure whether a change helped`,
      cases: cases.length,
    }
  }

  const events = new StreamingEventStore(
    new JsonlEventStore({ baseDir: root, secrets: () => ctx.secrets() }),
    (event) => ctx.emitEvent(event),
  )
  const ledger = { calls: 0, tokens: 0, refusal: null as string | null }

  const result = await trainSkill({
    seed,
    cases,
    events,
    adapter,
    ...(epochs !== undefined ? { epochs } : {}),
    proposeEdit: providerProposeEdit({
      adapter,
      ledger,
      ...(guidance !== undefined ? { guidance } : {}),
      ...(maxCalls !== undefined || maxTokens !== undefined
        ? {
            budget: {
              ...(maxCalls !== undefined ? { maxCalls } : {}),
              ...(maxTokens !== undefined ? { maxTokens } : {}),
            },
          }
        : {}),
    }),
    // Writing the artifact is opt-in: a training run the user has not looked at
    // should not silently replace the skill they installed.
    ...(write === true
      ? { artifactPath: join(installedSkillsDir(root), name, BEST_SKILL_FILENAME) }
      : {}),
  })

  return {
    ok: true,
    name,
    improved: result.improved,
    accepted: result.accepted,
    baselineValScore: result.baselineValScore,
    valScore: result.valScore,
    cases: cases.length,
    split: { train: result.split.train.length, val: result.split.val.length },
    epochs: result.epochs,
    budget: { calls: ledger.calls, tokens: ledger.tokens, refusal: ledger.refusal },
    ...(result.artifactPath !== undefined ? { artifactPath: result.artifactPath } : {}),
    // The winning body, so a surface can show a diff before the user writes it.
    body: result.skill.body,
  }
}

const SKILL_FILE = 'SKILL.md'
const SKILL_MANIFEST = 'skill.json'

/**
 * Parse a `SKILL.md`, a `skill.json`, or a skill folder into the normalized
 * `Skill` shape. Which of the two on-disk formats it was is not observable in the
 * result, which is the loader's contract (Requirement 10.3).
 */
async function parseSkill(params: Record<string, unknown>, _ctx: MethodContext): Promise<unknown> {
  const path = resolve(readString(params, 'path', 'params.path'))

  let isDirectory: boolean
  try {
    isDirectory = (await stat(path)).isDirectory()
  } catch {
    throw new InvalidParamsError(`params.path does not exist: ${path}`)
  }

  if (!isDirectory) {
    // A manifest path names its folder; anything else is read as a SKILL.md.
    return path.endsWith(SKILL_MANIFEST) ? loadSkillFolder(dirname(path)) : loadSkillFile(path)
  }

  try {
    if ((await stat(join(path, SKILL_FILE))).isFile()) {
      return loadSkillFile(join(path, SKILL_FILE))
    }
  } catch {
    // No SKILL.md — fall through to the folder layout.
  }
  return loadSkillFolder(path)
}

/**
 * Capture a run as an eval case (Requirement 8.1).
 *
 * `task` is part of the wire shape because verify commands exist nowhere else: a
 * `RunResult` records `VerifyResult`, which has no `cmd`. A caller with no task
 * sends none and gets a case with no `verify-pass` check — or an error when that
 * leaves nothing to assert. See `evals/capture.ts` for why fabricating commands
 * is not on the table.
 */
async function captureEval(params: unknown): Promise<unknown> {
  const p = (params ?? {}) as {
    run?: RunResult
    task?: Task | null
    want?: { checks?: Check[] }
    evalsPath?: string
  }
  if (!p.run) {
    throw new Error('capture-eval requires a "run" parameter')
  }
  return captureRunAsEval(p.run, p.task ?? null, {
    checks: p.want?.checks,
    evalsPath: p.evalsPath,
  })
}

/**
 * The method table.
 *
 * The first five are Requirement 12.2, and none of them may leave. The `git-*`
 * group is task 3.3's Git panel: a UI capability that runs on the machine, so it
 * belongs to the engine and reaches the panel through `SketchClient` on both
 * transports rather than through a Tauri-only command.
 */
export const METHODS: Readonly<Record<string, MethodHandler>> = {
  ping,
  run,
  eval: evalCases,
  'parse-skill': parseSkill,
  'capture-eval': captureEval,
  'git-status': gitStatus,
  'git-diff': gitDiff,
  'git-stage': gitStage,
  'git-unstage': gitUnstage,
  'git-commit': gitCommit,
  // Task 4.1's Provider Settings surface. Same reasoning as the git group: engine
  // capability, one implementation, reachable from both transports.
  'provider-catalog': providerCatalog,
  'provider-config-save': providerConfigSave,
  'provider-test': providerTest,
  // Task 5.5's Live Architecture panel: the seven views derived from the persisted
  // graph, plus the optional rebuild that makes "index this project" actionable.
  architecture,
  // Task 6.4's Skills surface. `skill-install` verifies before it writes and has no
  // force parameter; `skill-train` is the only method here that can reach a provider
  // and is invoked by explicit user action only (Requirement 9.6).
  'skills-catalog': skillsCatalog,
  'skill-install': skillInstall,
  'skill-train': skillTrain,
}

/** The five the protocol contract names. Every build answers at least these. */
export const REQUIRED_METHOD_NAMES: readonly string[] = [
  'ping',
  'run',
  'eval',
  'parse-skill',
  'capture-eval',
]

/** Method names this build answers. */
export const METHOD_NAMES: readonly string[] = Object.keys(METHODS)

/** Environment-derived secret values, re-read per call so a late export counts. */
export function envSecrets(env: NodeJS.ProcessEnv): string[] {
  return secretsFromEnv(env)
}
