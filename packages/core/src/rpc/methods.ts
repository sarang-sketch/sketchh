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

import { spawn as spawnProcess } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep as pathSep } from 'node:path'

import { ToolDispatcher, capabilitiesForSkill, readOnlyGrant } from '../capabilities/index.js'
import { describeLedger, ledgerFor, ledgerForRun, recordUsage, summarizeUsage } from '../cost/index.js'
import type { RunBudget, UsageCause } from '../cost/index.js'
import { latestBenchArtifactPath, loadLatestBenchArtifact } from '../bench/index.js'
import * as memory from '../memory/index.js'
import type { Capability, CapabilitySet } from '../capabilities/index.js'
import { MCP_CATALOG, McpHost, McpServer, catalogIds, findCatalogEntry, missingEnv } from '../mcp/index.js'
import { McpCatalogRegistry } from '../mcp/catalog.js'
import {
  catalogEntryFor,
  readUserServers,
  removeUserServer,
  saveUserServer,
  setServerTrust,
  specFor,
  type UserMcpServer,
} from '../mcp/userServers.js'
import {
  assembleContext,
  buildRepoGraph,
  generateArchitecture,
  graphPath,
  loadRepoGraph,
  projectSearch,
} from '../context/index.js'
import { JsonlEventStore, MemoryEventStore, newRunId, secretsFromEnv } from '../events/index.js'
import type { EventStore } from '../events/index.js'
import {
  runEvalSet,
  meanScore,
  captureRunAsEval,
  evalsFilePath,
  loadEvalCases as readEvalCases,
} from '../evals/index.js'
import type { EvalDeps } from '../evals/index.js'
import {
  installSkill,
  installedSkillsDir,
  isManagedInstalledSkill,
  loadManifest,
  promoteInstalledSkill,
  readInstalledSkillGrant,
  trainingArtifactPath,
  uninstallSkill,
} from '../registry/index.js'
import type { RegistryManifest } from '../registry/index.js'
import { materializeEmbeddedRegistry } from '../registry/materialize.js'
import { runTask } from '../loop/index.js'
import { DiskFileWriter, SnapshottingFileWriter, restoreSnapshot } from '../orchestrator/file-writer.js'
import { PlanWriter } from '../plan/index.js'
import {
  ChatGPTCodexAdapter,
  describeProvider,
  fakeProviderEnabled,
  listChatGPTModels,
  resolveAdapter,
} from '../providers/index.js'
import {
  CHATGPT_CODEX_BASE_URL,
  CHATGPT_PROVIDER_ID,
  ChatGPTAuthError,
  apiKeyFromEnv,
  cancelChatGPTLogin,
  cancelLoopback,
  chatgptLogout,
  chatgptStatus,
  envKeyPresence,
  listProviderModels,
  loadProviderSettings,
  providerMatrix,
  providersFilePath,
  saveProviderSettings,
  startChatGPTBrowserLogin,
  startChatGPTDeviceLogin,
  startLoopback,
  testProviderConnection,
  waitChatGPTLogin,
  waitLoopback,
} from '../settings/index.js'
import type { ProviderModelsTarget, ProviderTestTarget } from '../settings/index.js'
import {
  loadProjectContext,
  loadSkillFile,
  loadSkillFolder,
  loadSkills,
  providerProposeEdit,
  providerProposeEdits,
  trainSkill,
} from '../skills/index.js'
import type { ProviderProposeEditOptions } from '../skills/index.js'
import {
  DEFAULT_STRATEGY,
  ROLE_DEFINITIONS,
  ROLES,
  STRATEGIES,
  STRATEGY_DESCRIPTIONS,
  SWARM_ORDER,
  describeSignal,
  dispatch,
  emptyReport,
  executeRegisteredAgent,
  isStrategy,
  shouldDefaultToSwarm,
  type Strategy,
} from '../strategy/index.js'
import { GitTool, gitToolDescriptors, projectToolDescriptors } from '../tools/index.js'
import { backgroundToolDescriptors, commandToolDescriptor, type CommandApprover, type CommandMode } from '../tools/command.js'
import { skillToolDescriptor } from '../tools/skills.js'
import { TerminalHost, TerminalRefusal } from '../tools/terminal.js'
import { WatcherRegistry } from '../tools/watcher.js'
import { BackgroundProcesses } from '../tools/background.js'
import { OsOpenRefusal, openExternalTerminal, revealInFileManager } from '../tools/desktopOpen.js'
import { FsRefusal, TrashUnavailable, createFile, createFolder, deleteEntry, renameEntry } from '../tools/fsops.js'
import { FindQueryError, findInFiles, replaceInFiles, type FindFilters, type FindQuery } from '../tools/findReplace.js'
import {
  CompletionRateLimiter,
  INLINE_EDIT_MAX_INSTRUCTION,
  INLINE_EDIT_MAX_SELECTION,
  buildCompletionMessages,
  buildInlineEditMessages,
  cleanCompletion,
  cleanInlineEdit,
  loadSlashCommands,
} from '../assist/index.js'
import type { ChatCallOptions } from '../providers/wire.js'
import type { ToolDescriptor } from '../capabilities/guard.js'
import { walkProjectDetailed } from '../context/walker.js'
import {
  VERIFY_STAGES,
  parsePolicyJson,
  resolveVerifyPolicy,
  runVerifyPolicy,
} from '../verify/index.js'
import type { VerifyPolicy } from '../verify/index.js'
import { resolveForSpawn } from '../verify/spawnTarget.js'
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
import type { ExtensionBundle } from '../extensions/index.js'
import { StreamingEventStore } from './streaming-store.js'
import { ENGINE_NAME, ENGINE_VERSION, PROTOCOL_VERSION } from './version.js'
import {
  cancelPull,
  deleteLocalModel,
  isModelName,
  listLocalModels,
  loadLocalModel,
  ollamaBase,
  ollamaServer,
  pullStatus,
  startPull,
  unloadLocalModel,
  type LocalModel,
} from '../local/ollama.js'
import { findOllama, readHardware, recommend } from '../local/hardware.js'
import {
  assertReachable,
  networkGuardInstalled,
  offlineState,
  OfflineModeError,
  recentActivity,
  saveOfflineSetting,
  type OfflineState,
} from '../privacy/offline.js'

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
  /** One immutable, host-owned production extension bundle. */
  extensions?: ExtensionBundle
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

/**
 * `params.budget`, or `undefined` for an unbounded run.
 *
 * ABSENT STAYS UNBOUNDED. The Phase 8 guard has no default ceiling on purpose — a limit
 * invented inside the engine would stop somebody's long legitimate task with an error it
 * never chose. A caller that wants a ceiling states one, and a SURFACE that spends a
 * user's money by default is where that decision belongs (see the desktop's
 * `DESKTOP_RUN_DEFAULTS`).
 *
 * `onBreach` is REQUIRED whenever a budget is present, mirroring `RunBudget`. A ceiling
 * with no declared consequence is the failure mode Requirement 20.4 exists to prevent:
 * the guard would compute a breach and then have nothing to do about it. Every ceiling is
 * a positive finite number, and at least one must be given, so `budget: {}` is refused
 * rather than silently meaning "no limit" under a parameter named budget.
 */
function readBudget(params: Record<string, unknown>): RunBudget | undefined {
  const value = params['budget']
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidParamsError('params.budget must be an object when present')
  }
  const source = value as Record<string, unknown>
  const onBreach = source['onBreach']
  if (onBreach !== 'stop' && onBreach !== 'downgrade') {
    throw new InvalidParamsError("params.budget.onBreach must be 'stop' or 'downgrade'")
  }
  const ceilings: Partial<Record<'maxTokens' | 'maxUsd' | 'maxCalls', number>> = {}
  for (const key of ['maxTokens', 'maxUsd', 'maxCalls'] as const) {
    const ceiling = optionalNumber(source, key, `params.budget.${key}`)
    if (ceiling === undefined) continue
    if (ceiling <= 0) {
      throw new InvalidParamsError(`params.budget.${key} must be greater than zero`)
    }
    ceilings[key] = ceiling
  }
  if (Object.keys(ceilings).length === 0) {
    throw new InvalidParamsError(
      'params.budget must set at least one of maxTokens, maxUsd, or maxCalls',
    )
  }
  return { ...ceilings, onBreach }
}

/**
 * `params.strategy`, or `undefined` for the pre-Phase-10 behaviour.
 *
 * A closed vocabulary, and an unrecognised value is REFUSED rather than falling back to the
 * default. Falling back would let `strategy: "swam"` run one agent while the caller believed
 * it had asked for thirteen, and the bill would be the only evidence either way.
 */
function readStrategy(params: Record<string, unknown>): Strategy | undefined {
  const value = params['strategy']
  if (value === undefined || value === null) return undefined
  if (!isStrategy(value)) {
    throw new InvalidParamsError(
      `params.strategy must be one of ${STRATEGIES.join(', ')} when present`,
    )
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

/**
 * A task whose verify commands run inside `root`: an absent `cwd` becomes `root`, a
 * relative one is resolved against it, an absolute one is kept as given.
 */
function anchorVerifyCommands(task: Task, root: string): Task {
  if (task.verify.length === 0) return task
  return {
    ...task,
    verify: task.verify.map((command) => ({
      ...command,
      cwd: command.cwd === undefined ? root : resolve(root, command.cwd),
    })),
  }
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

/**
 * `params.history`: earlier conversation turns, bounded so a long chat cannot turn
 * every new message into an unbounded bill. The NEWEST turns are kept; each turn is
 * clipped; only `user` and `assistant` roles are accepted, so a caller cannot smuggle
 * a system instruction in through a chat transcript.
 */
const MAX_HISTORY_TURNS = 12
const MAX_HISTORY_TURN_CHARS = 6_000

function readHistory(params: Record<string, unknown>): { role: 'user' | 'assistant'; content: string }[] | undefined {
  const raw = params['history']
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new InvalidParamsError('params.history must be an array')
  const turns: { role: 'user' | 'assistant'; content: string }[] = []
  for (const [index, entry] of raw.entries()) {
    const turn = asObject(entry, `params.history[${index}]`)
    const role = turn['role']
    const content = turn['content']
    if (role !== 'user' && role !== 'assistant') {
      throw new InvalidParamsError(`params.history[${index}].role must be "user" or "assistant"`)
    }
    if (typeof content !== 'string') throw new InvalidParamsError(`params.history[${index}].content must be a string`)
    if (content.trim() === '') continue
    turns.push({
      role,
      content: content.length > MAX_HISTORY_TURN_CHARS ? `${content.slice(0, MAX_HISTORY_TURN_CHARS)}…` : content,
    })
  }
  return turns.slice(-MAX_HISTORY_TURNS)
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
  } else {
    // No key supplied: fall back to the provider's conventional environment variable
    // (`OPENAI_API_KEY`, `GROQ_API_KEY`, …). Environment credentials are already
    // scrubbed from every frame; registering it as well costs nothing.
    const fromEnv = apiKeyFromEnv(config.id, ctx.env)
    if (fromEnv !== null) {
      ctx.rememberSecret(fromEnv.value)
      config.apiKey = fromEnv.value
    }
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

/** Offline Mode as this call sees it. `params.home` isolates a test or preview instance. */
function offlineFor(params: Record<string, unknown>, ctx: MethodContext): OfflineState {
  const home = optionalString(params, 'home', 'params.home')
  return offlineState({ env: ctx.env, ...(home !== undefined ? { home: resolve(home) } : {}) })
}

/** The address a provider call will go to: the configured base URL, else the catalog default. */
function providerTarget(config: ProviderConfig): string {
  if (config.id === CHATGPT_PROVIDER_ID) return CHATGPT_CODEX_BASE_URL
  return config.baseUrl || (describeProvider(config.id)?.defaultBaseUrl ?? '')
}

/**
 * Refuse, before any work starts, a provider call that Offline Mode forbids. The
 * network guard would stop the request anyway; this says so up front, by name.
 */
function assertProviderAllowed(config: ProviderConfig, params: Record<string, unknown>, ctx: MethodContext): void {
  if (fakeProviderEnabled(ctx.env)) return
  const target = providerTarget(config)
  if (target === '') return
  assertReachable(target, offlineFor(params, ctx), describeProvider(config.id)?.name ?? config.id)
}

/** Refuse an operation whose only job is the network (a git push, a sign-in) while Offline Mode is on. */
function assertOnlineAction(params: Record<string, unknown>, ctx: MethodContext, target: string, what: string): void {
  if (offlineFor(params, ctx).offline) throw new OfflineModeError(target, what)
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
    return ctx.extensions?.providers.resolve(OFFLINE_CONFIG, ctx.env) ?? resolveAdapter(OFFLINE_CONFIG, ctx.env)
  }
  const config = readProviderConfig(provider, ctx)
  assertProviderAllowed(config, params, ctx)
  // A ChatGPT account is resolved here, not by an extension registry: its tokens
  // go to OpenAI and nowhere else. `params.home` lets an isolated caller (a test,
  // a preview instance) use its own sign-in instead of the user's.
  if (config.id === CHATGPT_PROVIDER_ID && !fakeProviderEnabled(ctx.env)) {
    return new ChatGPTCodexAdapter(config, { env: ctx.env, ...chatgptStore(params) })
  }
  return ctx.extensions?.providers.resolve(config, ctx.env) ?? resolveAdapter(config, ctx.env)
}

/** The engine home a non-run usage line is written under (`params.home` or the OS home). */
function usageHome(params: Record<string, unknown>): string {
  return resolve(optionalString(params, 'home', 'params.home') ?? homedir())
}

/**
 * Record one non-run model call in the per-cause usage log (`~/.sketch/usage/…`), so a
 * cost surface can show completions, inline edits, commit messages, connection tests and
 * model listing by cause. Never writes a key, a prompt, or a reply. Best-effort: a write
 * failure never fails the call it describes.
 */
function noteUsage(
  params: Record<string, unknown>,
  cause: UsageCause,
  facts: {
    provider?: string | null
    requestedModel?: string | null
    answeredModel?: string | null
    usage?: { in: number; out: number } | null
    usageEstimated?: boolean
    ok?: boolean
    attempts?: number
    root?: string | null
  },
): void {
  void recordUsage({ cause, ...facts }, usageHome(params))
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
/**
 * Runs that can still be cancelled, by run id.
 *
 * ── WHY A REGISTRY AND NOT A PARAMETER ──────────────────────────────────────
 *
 * `runTask` has always accepted an `AbortSignal`, and nothing on the wire could ever
 * produce one. A method call is request/response: the caller that wants to stop a run is
 * making a SECOND call while the first is still open, so the two have to meet somewhere,
 * and this is that place.
 *
 * Keyed by run id, and the caller may supply it (`params.runId`) precisely so a Stop
 * control is possible from the first moment: without that, a client has to wait for
 * `run_started` to learn the id, and the window before it arrives is exactly when a
 * misfired run most wants cancelling.
 *
 * Entries are removed in the run's `finally`, so a completed run cannot be cancelled and
 * this cannot grow without bound. Nothing here holds a task, a provider, or a key — one
 * `AbortController` per in-flight run and nothing else.
 */
const inFlightRuns = new Map<string, AbortController>()

/**
 * `params.runId`, or `undefined` to let the engine mint one.
 *
 * A caller-supplied id is a correlation handle, not a licence to collide: a second run
 * under an id already in flight is REFUSED, because accepting it would leave `cancel`
 * unable to say which run it stopped, and would silently make one of the two runs
 * uncancellable. Refusing also turns an accidental double-submit into an error rather
 * than two bills.
 */
function readRunId(params: Record<string, unknown>): string | undefined {
  const runId = optionalString(params, 'runId', 'params.runId')
  if (runId === undefined) return undefined
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(runId)) {
    throw new InvalidParamsError(
      'params.runId must be 1-128 characters from A-Z a-z 0-9 . _ - when present',
    )
  }
  if (inFlightRuns.has(runId)) {
    throw new InvalidParamsError(`params.runId ${JSON.stringify(runId)} is already running`)
  }
  return runId
}

/**
 * How long an interactive run waits for a human before giving up.
 *
 * Bounded on purpose. An unbounded wait holds the run, its event stream, its sidecar and
 * any MCP servers open forever if the surface that asked the question goes away — a closed
 * window or a reloaded webview would leak an engine per abandoned question. Ten minutes is
 * long enough for somebody to read a question and type an answer, and short enough that an
 * abandoned run is reclaimed the same session.
 */
const ASK_REPLY_TIMEOUT_MS = 600_000

/** Questions waiting on a human, by run id. At most one per run: the loop asks serially. */
const pendingQuestions = new Map<string, { question: string; settle: (answer: string | null) => void }>()

/**
 * Answer a question an interactive run is waiting on.
 *
 * `answered: false` when that run is not waiting for anything, which covers a stale reply,
 * a wrong id, and a run that already timed out. A caller cannot distinguish those and
 * should not: the actionable fact is whether the answer was used.
 *
 * An empty or whitespace-only answer is REFUSED rather than delivered. Delivering it would
 * end the run through the decline path while looking to the user like they answered.
 */
async function reply(params: Record<string, unknown>, _ctx: MethodContext): Promise<unknown> {
  const runId = optionalString(params, 'runId', 'params.runId')
  if (runId === undefined) throw new InvalidParamsError('params.runId is required')
  const answer = optionalString(params, 'answer', 'params.answer')
  if (answer === undefined || answer.trim() === '') {
    throw new InvalidParamsError('params.answer must be a non-empty string')
  }
  const waiting = pendingQuestions.get(runId)
  if (waiting === undefined) {
    return { runId, answered: false, detail: 'that run is not waiting for an answer' }
  }
  pendingQuestions.delete(runId)
  waiting.settle(answer)
  return { runId, answered: true, question: waiting.question }
}

/**
 * The answer channel handed to an interactive run.
 *
 * Registers the question, waits for `reply`, and gives up on a bounded timeout or an
 * abort. Always deregisters, so a timed-out question cannot be answered later by a reply
 * that arrives after the loop moved on.
 */
function askChannel(runId: string, timeoutMs: number = ASK_REPLY_TIMEOUT_MS) {
  return (question: string, options: { signal?: AbortSignal }): Promise<string | null> =>
    new Promise<string | null>((resolve) => {
      let done = false
      const settle = (answer: string | null) => {
        if (done) return
        done = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        pendingQuestions.delete(runId)
        resolve(answer)
      }
      const onAbort = () => settle(null)
      const timer = setTimeout(() => settle(null), timeoutMs)
      // Node keeps the process alive for a pending timer; a run waiting on a human must
      // not be the reason a CLI invocation refuses to exit.
      timer.unref?.()
      if (options.signal?.aborted) return settle(null)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      pendingQuestions.set(runId, { question, settle })
    })
}

/**
 * What an Auto-mode run is told when its model asks the user something.
 *
 * Auto mode means the human chose not to be interrupted. Ending the run on a question
 * would make "auto" stop at the first ambiguity; waiting would make it hang. So the
 * question is answered — by this standing instruction, recorded as `ask_answered` like
 * any other answer, so the transcript shows exactly what the model was told.
 */
export const AUTONOMOUS_ANSWER =
  'The user is not available to answer (Auto mode). Use your best judgement: choose the most ' +
  'conventional option for this project, state that assumption in your final summary, and continue.'

/** How long an Auto-mode run waits on a human for a command it classified as destructive. */
const AUTO_APPROVAL_TIMEOUT_MS = 120_000

/** "always" / "yes" / anything else, as a decision. Anything unclear is a refusal. */
export function parseApproval(answer: string | null): 'allow' | 'allow-always' | 'deny' {
  const text = (answer ?? '').trim().toLowerCase()
  if (/^(always|allow always|yes,? always|allow for this run)/.test(text)) return 'allow-always'
  if (/^(y|yes|allow|allow once|ok|okay|approve|approved|run it|sure|go)\b/.test(text)) return 'allow'
  return 'deny'
}

/**
 * Put a command to the human over the SAME question channel `ask` uses, so the
 * surface answers it with the same `reply` call.
 *
 * The `ask` event carries an `approval` object, which is how a surface knows to render
 * Allow / Deny rather than a free-text box. Reusing the kind with a payload
 * discriminator follows the project rule for a variant of an existing fact: it IS a
 * question to the human, and `ask_answered` records the decision.
 */
function commandApprover(runId: string, events: EventStore, timeoutMs: number): CommandApprover {
  return async (request, signal) => {
    const question =
      `Allow this command to run?\n${request.display}` +
      (request.cwd !== '.' ? `\n(in ${request.cwd})` : '') +
      (request.risk !== null ? `\nWhy you are asked: ${request.risk}.` : '')
    const approval = { kind: 'command', command: request.display, cwd: request.cwd, risk: request.risk }
    await events.emit({
      runId,
      kind: 'ask',
      payload: { question, text: question, approval, reason: 'the run needs your approval to run a command' },
    })
    const answer = await askChannel(runId, timeoutMs)(question, signal !== undefined ? { signal } : {})
    const decision = parseApproval(answer)
    await events.emit({
      runId,
      kind: 'ask_answered',
      payload: {
        question,
        answer: answer === null ? 'deny (no answer)' : answer,
        approval: { ...approval, decision, ...(answer === null ? { timedOut: true } : {}) },
      },
    })
    return decision
  }
}

/** `params.commands`: absent (no command tool), `ask`, or `auto`. */
function readCommandMode(params: Record<string, unknown>): CommandMode | undefined {
  const raw = params['commands']
  if (raw === undefined || raw === null || raw === false) return undefined
  if (raw === 'ask' || raw === 'auto') return raw
  throw new InvalidParamsError('params.commands must be "ask" or "auto" when present')
}

/**
 * Stop an in-flight run.
 *
 * Idempotent and honest: `{ cancelled: false }` when no run is in flight under that id,
 * which is the same answer for "already finished", "never started", and "wrong id". A
 * caller cannot distinguish those and should not try to — the only thing it can act on is
 * whether a run is still going.
 *
 * This does not fabricate a terminal event. The run itself observes the abort and emits
 * `run_failed{reason:"aborted"}` through its own log, so the record of a cancelled run is
 * written by the run, exactly like every other way it can end.
 */
async function cancel(params: Record<string, unknown>, _ctx: MethodContext): Promise<unknown> {
  const runId = optionalString(params, 'runId', 'params.runId')
  if (runId === undefined) throw new InvalidParamsError('params.runId is required')
  const controller = inFlightRuns.get(runId)
  if (controller === undefined) {
    return { runId, cancelled: false, detail: 'no run with that id is in flight' }
  }
  controller.abort()
  return { runId, cancelled: true, detail: 'abort requested; the run emits its own terminal event' }
}

async function run(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const root = resolve(optionalString(params, 'root', 'params.root') ?? ctx.cwd())
  // A verify command runs in the PROJECT, not wherever the engine process happens to
  // have been started (the packaged app's sidecar starts in the install folder). No
  // `cwd` means the run's root; a relative one is taken relative to it.
  const task = anchorVerifyCommands(readTask(params['task'], 'params.task'), root)
  const strategy = readStrategy(params)
  const workflowId = optionalString(params, 'workflow', 'params.workflow')
  if (strategy !== undefined && workflowId !== undefined) {
    throw new InvalidParamsError('params.workflow and params.strategy are mutually exclusive')
  }
  const workflow = workflowId === undefined ? undefined : ctx.extensions?.workflows.get(workflowId)
  if (workflowId !== undefined && workflow === undefined) {
    throw new InvalidParamsError(`unknown params.workflow ${JSON.stringify(workflowId)}`)
  }
  const adapter = adapterFor(params, ctx)
  const maxIterations = optionalNumber(params, 'maxIterations', 'params.maxIterations')
  const reviewEdits = optionalBoolean(params, 'reviewEdits', 'params.reviewEdits')
  const escalate = optionalBoolean(params, 'escalate', 'params.escalate')
  const contextBudgetTokens = optionalNumber(
    params,
    'contextBudgetTokens',
    'params.contextBudgetTokens',
  )
  const budget = readBudget(params)
  const history = readHistory(params)
  // Cancellation. The id is the caller's when it supplied one, so a Stop control works
  // before `run_started` arrives; otherwise it is the same id `runTask` would have minted.
  const runId = readRunId(params) ?? newRunId()
  const controller = new AbortController()
  inFlightRuns.set(runId, controller)
  // OPT-IN. Without it an `ask` ends the run exactly as it always has, which is what
  // every headless caller and the eval harness need.
  const interactive = optionalBoolean(params, 'interactive', 'params.interactive') ?? false
  // ── PERMISSION MODE (the composer's Ask / Agent / Auto) ─────────────────────
  // `readOnly` is enforced in the loop; `commands` opens `run_command`; `autonomous`
  // answers the model's questions with a standing instruction instead of a human.
  // All three are absent for every caller that predates them.
  const readOnly = optionalBoolean(params, 'readOnly', 'params.readOnly') ?? false
  const commandMode = readOnly ? undefined : readCommandMode(params)
  const autonomous = optionalBoolean(params, 'autonomous', 'params.autonomous') ?? false
  const autoSkills = optionalBoolean(params, 'autoSkills', 'params.autoSkills') ?? false

  const events = new StreamingEventStore(
    new JsonlEventStore({ baseDir: root, secrets: () => ctx.secrets() }),
    (event) => ctx.emitEvent(event),
  )

  const skills = await loadRequestedSkills(root, params, task, ctx)
  const granted = await grantForRun(root, skills, ctx)
  // Project memory travels with retrieval, because it IS context and belongs inside the
  // same token budget. On by default whenever retrieval is on — a caller that asked to be
  // shown the project should not have to ask separately to be shown what the project
  // already decided — and `recallMemory: false` opts out. A project with an empty store
  // is unaffected either way.
  const recallMemory = optionalBoolean(params, 'recallMemory', 'params.recallMemory') ?? true
  // OPT-IN INDEXING. Retrieval reads the persisted graph and, without one, quietly
  // retrieves nothing — so a freshly opened project reached the model with no code at
  // all. `autoIndex: true` builds the graph when it is missing and refreshes it
  // otherwise. The build is incremental (an unchanged file's hash is the proof it need
  // not be re-read), local, and never touches the network; a failure is logged and
  // the run continues without retrieval, exactly as before.
  const autoIndex = optionalBoolean(params, 'autoIndex', 'params.autoIndex') ?? false
  if (autoIndex && contextBudgetTokens !== undefined && contextBudgetTokens > 0) {
    try {
      const built = await buildRepoGraph({ root, events })
      ctx.log(
        `indexed ${built.stats.indexed} file(s) for retrieval ` +
          `(${built.stats.added} new, ${built.stats.changed} changed, ${built.stats.reused} unchanged)`,
      )
    } catch (err) {
      ctx.log(`indexing skipped, continuing without it: ${messageOf(err)}`)
    }
  }
  const retrievedContext = await retrieveContextFor(
    root,
    task,
    skills,
    contextBudgetTokens,
    events,
    ctx,
    recallMemory ? () => memoryStore(root, params, ctx) : undefined,
  )

  // THE VERIFICATION CONTRACT (Requirement 4.5). Resolved from `verify.yaml` when the
  // project has one, from per-stack detection otherwise, and only when the caller
  // asked — a task that named its own `verify` commands means them, and a caller
  // scoring an eval case must not have the project's nine stages silently appended to
  // its assertions.
  const verifyPolicy = await resolveVerifyPolicyFor(root, params, ctx)

  // THE TOOL LAYER (Requirement 22). Opt-in, scoped to the grant the loaded skills
  // actually hold, and torn down in `finally` whatever the run does.
  //
  // TWO ADDITIONS, BOTH CHOSEN BY THE HUMAN FOR THIS RUN:
  //   * `run_command` costs `proc:spawn`, which no skill default holds. The grant the
  //     DISPATCHER checks gains it only because the person at the keyboard enabled
  //     commands for this run (and, in `ask`, approves every one). It is not a skill
  //     grant: MCP launches below are still decided by the skills' own grant, so this
  //     cannot start a server a skill was never allowed.
  //   * `use_skill` exposes the project's installed skills by name and description.
  const extraTools: ToolDescriptor[] = []
  // ── ASK MODE IS READ-ONLY THROUGH EVERY TOOL PATH (W5 invariant 2) ──────────
  // readOnly refuses the `edit` action in the loop, but the tool layer is a
  // second write path: a loaded skill granted fs:write:project or git:write could
  // otherwise launch a write-capable MCP server and call its write tool, which the
  // capability guard would allow because the guard only checks the grant. So in
  // Ask mode BOTH the MCP launch grant and the dispatcher grant are narrowed to an
  // allowlist of READ capabilities (capabilities/vocabulary.ts). A server that
  // needs a write capability is then not even started, and any write tool the
  // model calls is refused by the one guard and the refusal is fed back. Agent and
  // Auto are unchanged: they use the skills' full grant exactly as before.
  const launchGrant: CapabilitySet = readOnly ? readOnlyGrant(granted) : granted
  let dispatcherGrant: CapabilitySet = launchGrant
  // Dev servers and watchers the agent starts with `background: true`; all stopped
  // in this run's `finally`.
  let background: BackgroundProcesses | undefined
  if (commandMode !== undefined) {
    background = new BackgroundProcesses()
    extraTools.push(
      commandToolDescriptor({
        mode: commandMode,
        ...(interactive
          ? { approve: commandApprover(runId, events, autonomous ? AUTO_APPROVAL_TIMEOUT_MS : ASK_REPLY_TIMEOUT_MS) }
          : {}),
        env: ctx.env as NodeJS.ProcessEnv,
        background,
      }),
      ...backgroundToolDescriptors(background),
    )
    // Not reachable in Ask mode (commandMode is undefined when readOnly is set), so
    // `launchGrant` here is the skills' full grant; commands add proc:spawn on top.
    dispatcherGrant = Object.freeze([...new Set<Capability>([...launchGrant, 'proc:spawn'])].sort())
    ctx.log(`commands enabled for this run by the user (${commandMode} mode)`)
  }
  if (autoSkills) {
    const installed = await loadSkills(installedSkillsDir(root))
    const tool = skillToolDescriptor(installed.skills)
    if (tool !== null) extraTools.push(tool)
  }
  const toolLayer = await openToolLayerFor(root, params, task, skills, launchGrant, events, ctx, {
    extraTools,
    dispatcherGrant,
    ...(readOnly ? { readOnly: true } : {}),
  })

  const loopDeps = {
    adapter,
    events,
    // The gate, unmodified and un-bypassable from here.
    plan: new PlanWriter({ baseDir: root, events }),
    // Every auto-applied write is journalled first, so `undo-run` can put the
    // project back without Git. Review-mode runs write nothing and journal nothing.
    files: new SnapshottingFileWriter(new DiskFileWriter(), { runId }),
    root,
    skills,
    capabilityGrant: dispatcherGrant,
    projectContext: await loadProjectContext(root),
    ...(retrievedContext !== undefined ? { retrievedContext } : {}),
    ...(verifyPolicy !== undefined ? { verifyPolicy } : {}),
    ...(toolLayer !== undefined ? { tools: toolLayer.dispatcher } : {}),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    ...(reviewEdits !== undefined ? { reviewEdits } : {}),
    ...(history !== undefined && history.length > 0 ? { history } : {}),
    ...(readOnly ? { readOnly: true } : {}),
    ...(autonomous ? { autonomous: true } : {}),
    // The guard runs before every call on both the `runTask` and dispatcher paths,
    // because both are handed exactly this object.
    ...(budget !== undefined ? { budget } : {}),
    // The run uses the id `cancel` is registered under, so the two cannot disagree about
    // which run a Stop request means.
    ids: () => runId,
    signal: controller.signal,
    // Auto mode answers the model itself (see AUTONOMOUS_ANSWER); otherwise an
    // interactive run waits for a human, and a headless one ends on a question.
    ...(autonomous
      ? { answer: async () => AUTONOMOUS_ANSWER }
      : interactive
        ? { answer: askChannel(runId) }
        : {}),
  }

  try {
    if (workflow !== undefined) {
      return await workflow.execute({
        task,
        runAgent: async (id, options) => {
          const agent = ctx.extensions?.agents.get(id)
          if (agent === undefined) throw new InvalidParamsError(`unknown registered agent ${JSON.stringify(id)}`)
          // `launchGrant` is the skills' full grant for Agent/Auto and the
          // read-only allowlist for Ask, so a workflow sub-run cannot regain a
          // write capability Ask mode removed.
          return executeRegisteredAgent(agent, task, loopDeps, launchGrant, options)
        },
      })
    }

    // ── THE STRATEGY FORK (Requirement 24.1) ────────────────────────────────
    //
    // ABSENT means `runTask`, byte for byte what this method did before Phase 10: one run,
    // one slice, no dispatcher event. A caller that never heard of strategies pays nothing
    // for their existence, and the log a desktop or CLI run leaves is unchanged.
    //
    // Naming a strategy — INCLUDING `single` — opts into the dispatcher, and the difference
    // is the record: a `strategy_selected` ladder under a dispatch id saying which strategy
    // was tried and which succeeded. That is what `escalate` needs and what the AI Team
    // panel renders.
    if (strategy === undefined) {
      return await ingestAfter(root, params, ctx, await runTask(task, loopDeps))
    }

    // NO INGESTION ON THE DISPATCHER PATH. A `DispatchResult` has a `dispatchId`, not a
    // run id, and its `events` are the dispatcher's own slice rather than any sub-run's —
    // so ingesting here would file a plan and a verify outcome it cannot see under an id
    // that is not a run. Getting that right needs a decision about which attempt's facts
    // are the project's, which is a spec question, not something to guess at here.
    return await dispatch(task, {
      ...loopDeps,
      strategy,
      ...(escalate !== undefined ? { escalate } : {}),
      // Roles can only narrow the same grant the tool layer received, and in Ask
      // mode that grant is already the read-only allowlist (`launchGrant`). There
      // is no wire parameter that can widen it.
      grant: launchGrant,
    })
  } finally {
    // A finished run is not cancellable, and the registry must not grow with every
    // completed run. Both are this one line.
    inFlightRuns.delete(runId)
    // A question outlives its run only as a leak: nothing can ever answer it.
    pendingQuestions.get(runId)?.settle(null)
    pendingQuestions.delete(runId)
    // A server left running holds a pipe, a port, and often a lock. `close()` never
    // throws, but it is in `finally` so a failed run cannot leak one either.
    await toolLayer?.host.close()
    // The same for dev servers the agent started with `background: true`.
    await background?.stopAll().catch(() => {})
  }
}

/**
 * The grant in force for a run.
 *
 * Skills installed through the registry use the persisted, digest-bound grant the
 * user approved. A missing, malformed, or stale record denies every capability.
 * Explicit custom skill directories retain declaration-derived grants because no
 * registry installation claimed authority over those local files.
 */
async function grantForRun(
  root: string,
  skills: readonly Skill[],
  ctx: MethodContext,
): Promise<CapabilitySet> {
  const union = new Set<Capability>()
  if (skills.length === 0) {
    for (const capability of capabilitiesForSkill(undefined).capabilities) union.add(capability)
  }
  for (const skill of skills) {
    if (isManagedInstalledSkill(root, skill)) {
      const persisted = await readInstalledSkillGrant(root, skill)
      if (!persisted.ok || persisted.grant === null) {
        ctx.log(`skill grant denied: ${persisted.reason}`)
        continue
      }
      for (const capability of persisted.grant.capabilities) union.add(capability)
      continue
    }
    const declared = capabilitiesForSkill(skill.capabilities)
    if (!declared.ok) {
      ctx.log(`skill grant denied for ${skill.name}: ${declared.errors.join('; ')}`)
      continue
    }
    for (const capability of declared.capabilities) union.add(capability)
  }
  return Object.freeze([...union].sort())
}

/**
 * Open the MCP servers a run asked for, and hand back a dispatcher over their tools.
 *
 * OPT-IN, via `params.mcpServers` — an array of curated catalog ids. Absent means no
 * tool layer at all, which is what every caller before Phase 7 depended on: `tool`
 * actions are refused with `TOOL_UNAVAILABLE_REASON` and the run proceeds on edits and
 * verification alone.
 *
 * ── A SERVER THE GRANT CANNOT REACH IS NOT STARTED ─────────────────────────
 *
 * Refusing the calls would be enough for correctness. Not spawning it is stronger: a
 * process that never launched cannot read a token from the environment, cannot open a
 * socket, and cannot install a browser. The refusal is logged by id and capability so
 * a user can see why a server they expected is absent.
 *
 * ── EVERY FAILURE HERE IS A DIAGNOSTIC, NEVER A FAILED RUN ─────────────────
 *
 * An unknown id, a missing token, a server that will not handshake: all logged, all
 * survivable. Requirement 22.3 is explicit that the run continues, and a run that dies
 * because Docker is not installed is a worse product than one that says so and works
 * on the code.
 */
async function openToolLayerFor(
  root: string,
  params: Record<string, unknown>,
  task: Task,
  skills: readonly Skill[],
  granted: CapabilitySet,
  events: EventStore,
  ctx: MethodContext,
  extra: { extraTools?: readonly ToolDescriptor[]; dispatcherGrant?: CapabilitySet; readOnly?: boolean } = {},
): Promise<{ host: McpHost; dispatcher: ToolDispatcher } | undefined> {
  const requested = optionalStringArray(params['mcpServers'], 'params.mcpServers') ?? []
  // The user's own servers, by name (`~/.sketch/mcp.json`, `<project>/.sketch/mcp.json`).
  // Naming one for a run IS the user's grant for it; a project server must also have
  // been approved for this exact launch. See mcp/userServers.ts.
  const userNames = optionalStringArray(params['userMcpServers'], 'params.userMcpServers') ?? []
  // `projectTools: true` opens the layer with the read-only project tools even when no
  // MCP server was asked for. Opt-in, so a CLI or eval caller that never heard of it
  // gets byte-for-byte the behaviour it had: no layer, every `tool` action refused.
  const projectTools = optionalBoolean(params, 'projectTools', 'params.projectTools') ?? false
  const extraTools = extra.extraTools ?? []
  if (requested.length === 0 && userNames.length === 0 && !projectTools && extraTools.length === 0) return undefined

  const userServers = await userServersForRun(root, params, ctx, userNames)
  const requestTimeoutMs = optionalNumber(params, 'mcpRequestTimeoutMs', 'params.mcpRequestTimeoutMs')
  const catalog =
    userServers.length > 0
      ? (ctx.extensions?.mcp ?? new McpCatalogRegistry()).withUserServers(userServers.map(catalogEntryFor))
      : ctx.extensions?.mcp
  const host = new McpHost({
    root,
    events,
    runId: task.id,
    log: (line) => ctx.log(line),
    env: ctx.env,
    allowedLaunches: new Set([
      ...requested.filter((id) => {
        const entry = catalog?.find(id) ?? findCatalogEntry(id)
        return entry !== null && granted.includes(entry.requires)
      }),
      ...userServers.map((server) => server.id),
    ]),
    ...(catalog !== undefined ? { catalog } : {}),
    ...(userServers.length > 0
      ? {
          launchOverrides: Object.fromEntries(
            userServers.map((server) => [server.id, specFor(server, root, requestTimeoutMs !== undefined ? { requestTimeoutMs } : {})]),
          ),
        }
      : {}),
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
  })
  for (const server of userServers) {
    // A user server runs a program (`proc:spawn`), which a read-only (Ask mode) run
    // must not do — so it is not started at all. Not merely refused: a process that
    // never launched cannot write a file or open a socket. (W5 invariant 2.)
    if (extra.readOnly === true) {
      ctx.log(`mcp: not starting ${server.name} — this run is read-only (Ask mode) and a user server runs a program`)
      continue
    }
    const opened = await host.open(server.id)
    ctx.log(opened.ok ? `mcp: ${opened.detail}` : `mcp: ${server.name} unavailable for this run — ${opened.detail}`)
  }

  const offline = offlineFor(params, ctx).offline
  for (const id of requested) {
    const entry = catalog?.find(id) ?? findCatalogEntry(id)
    if (entry === null) {
      const ids = catalog?.ids() ?? catalogIds()
      ctx.log(`mcp: no server named "${id}" in the curated catalog (have: ${ids.join(', ')})`)
      continue
    }
    if (offline && entry.requires.startsWith('net:')) {
      // A server is its own process, so the engine's network guard cannot hold it to
      // this machine. One whose job is the network is not started at all.
      ctx.log(`mcp: not starting ${entry.title} — Offline Mode is on and it needs the network (${entry.requires})`)
      continue
    }
    if (!granted.includes(entry.requires)) {
      // Not opened, not merely refused. See the header.
      ctx.log(
        `mcp: not starting ${entry.title} — it costs ${entry.requires} and this run holds ` +
          `${granted.length === 0 ? 'nothing' : granted.join(', ')}`,
      )
      continue
    }
    const opened = await host.open(id)
    ctx.log(
      opened.ok
        ? `mcp: ${opened.detail}`
        : `mcp: ${id} unavailable for this run — ${opened.detail}`,
    )
  }

  // The user's servers cost `proc:spawn`. Naming them for this run granted exactly that,
  // and only their descriptors carry it unless commands were enabled as well.
  //
  // EXCEPT in a read-only (Ask mode) run: `proc:spawn` is a write-shaped capability that
  // Ask mode must not hold, so it is NOT re-added here. A user MCP server's tools then
  // stay unauthorised and any call to one is refused by the guard — Ask mode writes no
  // file through the MCP path either (W5 invariant 2). Agent/Auto are unchanged.
  const baseGrant = extra.dispatcherGrant ?? granted
  const dispatcherGrant =
    userServers.length > 0 && extra.readOnly !== true
      ? (Object.freeze([...new Set<Capability>([...baseGrant, 'proc:spawn'])].sort()) as CapabilitySet)
      : baseGrant
  const dispatcher = new ToolDispatcher({
    // The engine's own git tools sit alongside the MCP servers', behind the same
    // one authorisation point. They cost `git:read` and `git:write`, so a run whose
    // skills declared neither still sees zero of them — which is why adding them
    // here changes nothing for a caller that never asked for git.
    tools: [
      ...(projectTools ? projectToolDescriptors() : []),
      ...gitToolDescriptors({ events, runId: task.id }),
      ...extraTools,
      ...host.descriptors(),
    ],
    granted: dispatcherGrant,
    root,
    events,
    runId: task.id,
    ...(skills.length === 1 ? { skill: skills[0]!.name } : {}),
  })
  const effective = dispatcherGrant
  ctx.log(
    `mcp: ${host.openIds.length} server(s) open, ${dispatcher.availableTools.length} tool(s) ` +
      `reachable with ${effective.length === 0 ? 'no capabilities' : effective.join(', ')}`,
  )
  return { host, dispatcher }
}

// ── memory ───────────────────────────────────────────────────────────────────
//
// Same seam reasoning as git, skills and cost: versioned rows, supersede-with-a-reason,
// the lint pass and the retriever all live in `packages/core/src/memory/` and reach the
// panel over the client seam, so there is one implementation and it works under the dev
// bridge as well as in the app.
//
// READING IS FREE; WRITING AND SUPERSEDING ARE EXPLICIT. `memory-list` and `memory-search`
// are reads. `memory-remember` and `memory-supersede` are user actions, and the second
// requires a reason on the wire — there is no way to close an entry silently, because
// "superseded, no reason given" is indistinguishable from a bug months later.

/**
 * Write what a finished run established into project memory, when the caller asked.
 *
 * OPT-IN through `params.rememberRun`. Off by default because writing to a user's project
 * memory is a side effect on their repository, and the eval harness scores thousands of
 * runs whose plans and verify outcomes are fixture noise, not project knowledge.
 *
 * NEVER FAILS THE RUN. The run already happened and its result is already correct; losing
 * a memory write is a smaller problem than turning a successful run into an error, so a
 * failure is logged and the result passes through untouched.
 */
async function ingestAfter<T extends { runId: string; events: SketchEvent[] }>(
  root: string,
  params: Record<string, unknown>,
  ctx: MethodContext,
  result: T,
): Promise<T> {
  if ((optionalBoolean(params, 'rememberRun', 'params.rememberRun') ?? false) !== true) return result
  try {
    const task = readTask(params['task'], 'params.task')
    // The plan's PROSE is on disk, not in `plan_written` (which carries the directory and
    // the document ids). Read it from the same writer the run wrote it with, so ingestion
    // files what the run actually committed to rather than a shape guessed from an event.
    const planDocuments = await new PlanWriter({ baseDir: root }).readPlan(result.runId)
    const outcome = await memory.ingestRunMemory({
      store: memoryStore(root, params, ctx),
      runId: result.runId,
      events: result.events,
      task: task.prompt,
      ...(planDocuments.prd !== undefined ? { plan: planDocuments.prd } : {}),
    })
    if (outcome.reason !== null) ctx.log(`memory not written for ${result.runId}: ${outcome.reason}`)
    else ctx.log(`memory written for ${result.runId}: ${outcome.written.length} entry/entries`)
  } catch (error) {
    ctx.log(
      `memory ingestion failed for ${result.runId}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return result
}

/** The store selected for this call. No selector preserves the Jsonl default. */
function memoryStore(root: string, params: Record<string, unknown>, ctx: MethodContext): memory.MemoryStore {
  const id = optionalString(params, 'memoryStore', 'params.memoryStore')
  if (id === undefined) return new memory.JsonlMemoryStore({ baseDir: root })
  const registry = ctx.extensions?.memoryStores
  if (registry === undefined || !registry.has(id)) {
    throw new InvalidParamsError(`unknown params.memoryStore ${JSON.stringify(id)}`)
  }
  return registry.create(id, root)
}

/**
 * Every entry, newest first, with its validity window and what superseded it.
 *
 * Returns SUPERSEDED entries too, unlike retrieval. The panel's whole job is letting a
 * user see and correct what the project remembers, and a history you cannot see is a
 * history you cannot correct — so the closed rows are here, flagged `current: false`,
 * rather than filtered out.
 */
async function memoryList(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const root = resolve(optionalString(params, 'root', 'params.root') ?? ctx.cwd())
  const kind = optionalString(params, 'kind', 'params.kind')
  if (kind !== undefined && !memory.isMemoryKind(kind)) {
    throw new InvalidParamsError(
      `params.kind must be one of ${memory.MEMORY_KINDS.join(', ')}, got ${kind}`,
    )
  }

  const store = memoryStore(root, params, ctx)
  const detailed = store instanceof memory.JsonlMemoryStore
    ? await store.readAllDetailed()
    : { entries: await store.all(), skipped: 0 }
  const { entries, skipped } = detailed
  if (skipped > 0) {
    ctx.log(`memory: ${skipped} unreadable line(s) were skipped and are not shown`)
  }

  const now = Date.now()
  const filtered = kind === undefined ? entries : entries.filter((entry) => entry.kind === kind)
  const rows = filtered
    .map((entry) => ({
      ...entry,
      current: memory.isCurrent(entry, now),
      window: memory.describeWindow(entry, now),
    }))
    // Newest first. A panel opens on what the project believes now.
    .sort((a, b) => b.validFrom - a.validFrom)

  const findings = await memory.lintMemory({ store, now })

  return {
    root,
    /** Lines that could not be parsed. Reported, never absorbed. */
    skipped,
    kinds: memory.MEMORY_KINDS.map((value) => ({
      kind: value,
      description: memory.MEMORY_KIND_DESCRIPTIONS[value],
      total: entries.filter((entry) => entry.kind === value).length,
      current: entries.filter((entry) => entry.kind === value && memory.isCurrent(entry, now)).length,
    })),
    total: entries.length,
    current: entries.filter((entry) => memory.isCurrent(entry, now)).length,
    entries: rows,
    /** Suspected problems. Reported only — the lint pass supersedes nothing. */
    findings: findings.map((finding) => ({
      kind: finding.kind,
      confidence: finding.confidence,
      detail: finding.detail,
      suggestion: finding.suggestion,
      ids: finding.entries.map((entry) => entry.id),
    })),
  }
}

/** Retrieve for a query, with the recency prior. Emits `memory_retrieved`. */
async function memorySearch(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const root = resolve(optionalString(params, 'root', 'params.root') ?? ctx.cwd())
  const query = readString(params, 'query', 'params.query')
  const topK = optionalNumber(params, 'topK', 'params.topK')
  const includeSuperseded =
    optionalBoolean(params, 'includeSuperseded', 'params.includeSuperseded') ?? false

  const events = new StreamingEventStore(
    new JsonlEventStore({ baseDir: root, secrets: () => ctx.secrets() }),
    (event) => ctx.emitEvent(event),
  )

  const result = await memory.retrieveMemory({
    store: memoryStore(root, params, ctx),
    query,
    includeSuperseded,
    events,
    ...(topK !== undefined ? { topK: Math.floor(topK) } : {}),
  })

  return {
    root,
    query,
    terms: result.terms,
    candidates: result.candidates,
    supersededExcluded: result.supersededExcluded,
    channels: result.channels,
    hits: result.hits.map((hit) => ({
      entry: hit.entry,
      score: hit.score,
      relevance: hit.relevance,
      recency: hit.recency,
      termsMatched: hit.termsMatched,
      channels: hit.channels,
      current: hit.current,
      window: memory.describeWindow(hit.entry),
    })),
  }
}

/**
 * Record something. Supersedes a same-key predecessor and emits `memory_superseded`.
 *
 * `source` defaults to `user`, not `run`: this method exists for the panel, and an entry
 * a person typed must never be auto-expired later by a heuristic.
 */
async function memoryRemember(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const root = resolve(optionalString(params, 'root', 'params.root') ?? ctx.cwd())
  const kind = readString(params, 'kind', 'params.kind')
  if (!memory.isMemoryKind(kind)) {
    throw new InvalidParamsError(
      `params.kind must be one of ${memory.MEMORY_KINDS.join(', ')}, got ${kind}`,
    )
  }
  const text = readString(params, 'text', 'params.text')
  const source = optionalString(params, 'source', 'params.source') ?? 'user'
  if (!memory.isMemorySource(source)) {
    throw new InvalidParamsError(`params.source must be user, run, or imported, got ${source}`)
  }

  const events = new StreamingEventStore(
    new JsonlEventStore({ baseDir: root, secrets: () => ctx.secrets() }),
    (event) => ctx.emitEvent(event),
  )

  const result = await memory.remember({
    store: memoryStore(root, params, ctx),
    events,
    entry: {
      kind,
      text,
      source,
      ...(optionalString(params, 'key', 'params.key') !== undefined
        ? { key: optionalString(params, 'key', 'params.key')! }
        : {}),
      ...(optionalString(params, 'subject', 'params.subject') !== undefined
        ? { subject: optionalString(params, 'subject', 'params.subject')! }
        : {}),
      ...(optionalStringArray(params['tags'], 'params.tags') !== undefined
        ? { tags: optionalStringArray(params['tags'], 'params.tags')! }
        : {}),
    },
    ...(optionalString(params, 'reason', 'params.reason') !== undefined
      ? { reason: optionalString(params, 'reason', 'params.reason')! }
      : {}),
  })

  return {
    root,
    entry: result.entry,
    superseded: result.superseded,
  }
}

/**
 * Close an entry's window.
 *
 * `reason` is REQUIRED on the wire, not optional. Requirement 21.3 asks for a recorded
 * reason and this is the method a user reaches it through; an optional reason would mean
 * the panel could close an entry silently, which is the state the requirement exists to
 * prevent.
 *
 * Note what this is NOT: a delete. The row stays, its window closes, and the history
 * remains readable — which is the difference between a memory a user can correct and one
 * they can only destroy.
 */
async function memorySupersede(
  params: Record<string, unknown>,
  ctx: MethodContext,
): Promise<unknown> {
  const root = resolve(optionalString(params, 'root', 'params.root') ?? ctx.cwd())
  const id = readString(params, 'id', 'params.id')
  const reason = readString(params, 'reason', 'params.reason')

  const events = new StreamingEventStore(
    new JsonlEventStore({ baseDir: root, secrets: () => ctx.secrets() }),
    (event) => ctx.emitEvent(event),
  )

  const replacementText = optionalString(params, 'replacementText', 'params.replacementText')
  const replacementKind = optionalString(params, 'replacementKind', 'params.replacementKind')
  if (replacementKind !== undefined && !memory.isMemoryKind(replacementKind)) {
    throw new InvalidParamsError(`params.replacementKind is not a memory kind: ${replacementKind}`)
  }

  const store = memoryStore(root, params, ctx)
  const existing = await store.get(id)
  const result = await memory.supersedeEntry({
    store,
    events,
    id,
    reason,
    ...(replacementText !== undefined
      ? {
          replacement: {
            // The replacement inherits the closed entry's kind and key unless told
            // otherwise, because a replacement for a different key is not a replacement.
            kind: (replacementKind ?? existing?.kind ?? 'decision') as memory.MemoryKind,
            text: replacementText,
            source: 'user' as const,
            ...(existing?.key !== undefined ? { key: existing.key } : {}),
            ...(existing?.subject !== undefined ? { subject: existing.subject } : {}),
          },
        }
      : {}),
  })

  return {
    root,
    ok: result.ok,
    closed: result.closed,
    replacement: result.replacement,
    reason: result.reason,
  }
}

/**
 * What this project's runs have cost, derived from the durable event log.
 *
 * ── THERE IS NO SECOND SOURCE, AND THAT IS THE WHOLE DESIGN ────────────────
 *
 * Requirement 20.2 says the session total equals the sum over events with no independent
 * source, and this method is what makes that literal: it reads the JSONL log and calls
 * `ledgerFor`. It keeps no running total, caches nothing, and has no state between calls.
 * So the Cost Dashboard's number and the log are the same computation over the same
 * bytes, which is why 8.5's reconciliation is an equality rather than a tolerance.
 *
 * A corrupt log line is SKIPPED and COUNTED (`readAllDetailed`), not fatal and not
 * silent: a cost report that quietly dropped lines would understate spend, which is the
 * direction that costs the user money.
 */
async function cost(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const root = resolve(optionalString(params, 'root', 'params.root') ?? ctx.cwd())
  const runId = optionalString(params, 'runId', 'params.runId')

  const store = new JsonlEventStore({ baseDir: root, secrets: () => ctx.secrets() })
  const { events, skipped } = await store.readAllDetailed()
  if (skipped > 0) {
    ctx.log(`cost: ${skipped} unreadable log line(s) were skipped and are not counted`)
  }

  const scoped = runId === undefined ? events : events.filter((event) => event.runId === runId)
  const ledger = ledgerFor(scoped)

  // Per-run subtotals, so a dashboard can show where the money went rather than one
  // number. Ordered by first activity, which is the order a user experienced them in.
  const runIds: string[] = []
  for (const event of scoped) {
    if (!runIds.includes(event.runId)) runIds.push(event.runId)
  }
  const runs = runIds.map((id) => {
    const perRun = ledgerForRun(scoped, id)
    return {
      runId: id,
      usd: perRun.usd,
      tokensIn: perRun.tokensIn,
      tokensOut: perRun.tokensOut,
      calls: perRun.calls,
      unpriced: perRun.unpriced,
      usageUnknown: perRun.usageUnknown,
      usageEstimatedCalls: perRun.usageEstimatedCalls,
      cacheHits: perRun.cacheHits,
      allLocal: perRun.allLocal,
      startedAt: perRun.entries[0]?.ts ?? null,
    }
  })

  return {
    root,
    ...(runId !== undefined ? { runId } : {}),
    /** Log lines that could not be parsed. Reported, never absorbed. */
    skipped,
    total: {
      usd: ledger.usd,
      tokensIn: ledger.tokensIn,
      tokensOut: ledger.tokensOut,
      calls: ledger.calls,
      unpriced: ledger.unpriced,
      usageUnknown: ledger.usageUnknown,
      usageEstimatedCalls: ledger.usageEstimatedCalls,
      cacheHits: ledger.cacheHits,
      savedUsd: ledger.savedUsd,
      allLocal: ledger.allLocal,
    },
    /** The pricing table's date. A surface must never show money without it. */
    pricedAt: ledger.pricedAt,
    stale: ledger.stale,
    /** The one-line summary, so the engine owns the wording of the unknowns. */
    summary: describeLedger(ledger),
    runs,
    /** Every priced call, newest last, so a total can be audited row by row. */
    entries: ledger.entries,
  }
}

/**
 * Model calls NOT tied to a message — completions, inline edits, commit messages,
 * connection tests, model listing — rolled up by cause from `~/.sketch/usage/*.jsonl`.
 * These never go in a project's event log (one line per keystroke pause would bury the
 * runs), so the Cost dashboard reads them from here to show them by cause. Unknown tokens
 * are shown as unknown, never zero. No key, prompt, or reply is ever in this log.
 */
async function costUsage(params: Record<string, unknown>): Promise<unknown> {
  return summarizeUsage(usageHome(params))
}

/**
 * The project's verification contract: the nine stages, where they came from, and —
 * only when asked — what happens when they run.
 *
 * ── RESOLVE IS THE DEFAULT; RUNNING IS OPT-IN (`params.run`) ───────────────
 *
 * A Test Results panel mounts when a user clicks a button in a sidebar. Executing nine
 * stages because a panel mounted would run the project's whole build and test suite as
 * a side effect of navigation — minutes of CPU, and for a policy with a `live` check, a
 * server bound to a port. So the default reports the CONTRACT: every stage in order,
 * the commands each would run, whether it is configured, and whether the policy came
 * from a file or from detection. `run: true` is a deliberate act.
 *
 * ── THE NINE ARE ALWAYS ALL NINE ───────────────────────────────────────────
 *
 * `stages` is `VERIFY_STAGES` in contract order whether the project configures them or
 * not, because "lint is not configured here" is information a user needs and a panel
 * that only lists what exists cannot convey it. `skipped` and `not-run` stay distinct
 * words all the way to the surface (see `policy.ts`): nothing ran either way, but one
 * means "you configured nothing" and the other means "an earlier stage failed and we
 * stopped", and a panel showing one grey badge for both hides which.
 */
async function verify(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const root = resolve(optionalString(params, 'root', 'params.root') ?? ctx.cwd())
  const shouldRun = optionalBoolean(params, 'run', 'params.run') ?? false

  const resolved = await resolveVerifyPolicy(root)
  for (const diagnostic of resolved.diagnostics) ctx.log(`verify policy: ${diagnostic}`)

  // Contract order, every stage, configured or not.
  const contract = VERIFY_STAGES.map((stage) => {
    const commands = resolved.policy[stage] ?? []
    return {
      stage,
      configured: commands.length > 0,
      commands: commands.map((command) => [command.cmd, ...(command.args ?? [])].join(' ')),
    }
  })

  const base = {
    root,
    source: resolved.source,
    ...(resolved.path !== undefined ? { path: resolved.path } : {}),
    ...(resolved.language !== undefined ? { language: resolved.language } : {}),
    diagnostics: resolved.diagnostics,
    contract,
    /** Whether a live application check is part of the `integration` stage. */
    live: resolved.policy.live !== undefined,
  }

  // A FULL REPORT, so `continueOnFailure` defaults to TRUE here and only here.
  //
  // The loop is fail-fast on purpose: the first failure in an ordered gauntlet is
  // usually the explanation for the rest, and a model does not need eight more. A
  // panel is the opposite case — a user looking at a report wants to know that lint
  // failed AND the tests fail, not to fix lint and discover the tests separately. The
  // cost is real (every stage runs), so the flag is reported back and a caller can
  // ask for fail-fast with `continueOnFailure: false`.
  const continueOnFailure =
    optionalBoolean(params, 'continueOnFailure', 'params.continueOnFailure') ?? true

  if (!shouldRun) return { ...base, ran: false, continueOnFailure, result: null }

  // Events go where the run log lives, so a verification the user triggered from the
  // panel is in the same durable timeline as one a run triggered.
  const events = new StreamingEventStore(
    new JsonlEventStore({ baseDir: root, secrets: () => ctx.secrets() }),
    (event) => ctx.emitEvent(event),
  )
  const result = await runVerifyPolicy(resolved.policy, {
    sink: events,
    runId: optionalString(params, 'runId', 'params.runId') ?? 'verify',
    // `root` is not optional in practice: without it a `live` check skips itself and
    // reports ok, which is exactly the bug task 7.2 found in the loop.
    root,
    continueOnFailure,
  })
  return { ...base, ran: true, continueOnFailure, result }
}

/**
 * What the curated catalog offers, and what each entry is still missing.
 *
 * This is what a surface needs to show an MCP status badge HONESTLY. It reports
 * `configured` — the entry's required environment is present, so it could start — and
 * never `connected`, because nothing is connected outside a run: the host is per-run by
 * construction (the unavailability latch means "for the remainder of the run"). A badge
 * claiming five live connections while no run is in flight would be a fixture with
 * extra steps.
 */
async function mcpCatalog(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const env = ctx.env
  const catalog = ctx.extensions?.mcp
  const entries = catalog?.list() ?? MCP_CATALOG
  const servers = entries.map((entry) => {
    const missing = missingEnv(entry, env)
    return {
      id: entry.id,
      title: entry.title,
      summary: entry.summary,
      requires: entry.requires,
      // Keep the argv structured as well as rendering the legacy command string. Joining
      // is display-only and cannot preserve arguments containing spaces.
      launch: { command: entry.launch.command, args: [...entry.launch.args] },
      command: [entry.launch.command, ...entry.launch.args].join(' '),
      requiresEnv: entry.requiresEnv ?? [],
      missingEnv: missing,
      configured: missing.length === 0,
      ...(entry.caveat !== undefined ? { caveat: entry.caveat } : {}),
    }
  })
  void params
  return {
    servers,
    total: servers.length,
    configured: servers.filter((server) => server.configured).length,
    // Stated on the wire so a surface does not have to infer it.
    note:
      'Servers are started per run, only when a run asks for them and only when the ' +
      'run\u2019s grant covers the capability they cost. Nothing is connected between runs.',
  }
}

/**
 * The strategies, the thirteen roles, and which of them THIS project can actually check.
 *
 * This is what the AI Team panel needs to render an honest team. Three things it reports and
 * one it deliberately refuses:
 *
 *   * `strategies` — the three, with what each costs, and which is the default.
 *   * `roles` — all thirteen with the signal that grades each one, and `available` resolved
 *     against the stages this project configures. A role the project cannot check is shown
 *     as skipped WITH ITS REASON, not hidden and not shown as idle.
 *   * `swarmDefault` — the Requirement 24.8 verdict. With no measurement on disk it is
 *     `enable: false` and the reason says the measurement has not been run. That is the
 *     honest state of this repository.
 *
 * What it refuses: any notion of a role being "working" or "done" right now. Roles exist
 * only inside a dispatch, the same way MCP servers exist only inside a run, so a panel that
 * wants live status reads `strategy_selected` events from the timeline. A status field here
 * would be a fixture with extra steps — which is exactly what the four `AgentTeamPanel`
 * fixtures and the twelve `state.agentTeam` entries were.
 */
async function strategyCatalog(
  params: Record<string, unknown>,
  ctx: MethodContext,
): Promise<unknown> {
  const root = resolve(optionalString(params, 'root', 'params.root') ?? ctx.cwd())
  const resolved = await resolveVerifyPolicy(root)
  const stages = VERIFY_STAGES.filter((stage) => (resolved.policy[stage] ?? []).length > 0)

  const roles = ROLES.map((role) => {
    const definition = ROLE_DEFINITIONS[role]
    const signal = definition.signal
    const available = signal.kind !== 'verify-stage' || stages.includes(signal.stage)
    return {
      role,
      title: definition.title,
      instruction: definition.instruction,
      signal: describeSignal(signal),
      signalKind: signal.kind,
      ...(signal.kind === 'verify-stage' ? { stage: signal.stage } : {}),
      capabilities: definition.capabilities,
      edits: definition.edits,
      blocking: definition.blocking,
      available,
      reason: available
        ? null
        : `this project configures no "${(signal as { stage: string }).stage}" stage, so the ` +
          `${definition.title} role is skipped rather than run unverified`,
    }
  })

  const customAgents = (ctx.extensions?.agents.list() ?? []).map((definition) => {
    const signal = definition.signal
    const available = signal.kind !== 'verify-stage' || stages.includes(signal.stage)
    return {
      id: definition.id,
      version: definition.version,
      title: definition.title,
      instruction: definition.instruction,
      signal: describeSignal(signal),
      signalKind: signal.kind,
      ...(signal.kind === 'verify-stage' ? { stage: signal.stage } : {}),
      capabilities: definition.capabilities,
      edits: definition.edits,
      blocking: definition.blocking,
      available,
      reason: available ? null : `this project configures no "${signal.kind === 'verify-stage' ? signal.stage : ''}" stage`,
    }
  })
  const workflows = (ctx.extensions?.workflows.list() ?? []).map(({ descriptor }) => descriptor)

  // No measurement exists on disk yet, and pretending otherwise is the thing Requirement
  // 24.8 was written to prevent. Two empty reports compare as "nothing to compare", which
  // under a strict `>` can never enable a swarm.
  const verdict = shouldDefaultToSwarm(emptyReport(1), emptyReport(1))

  return {
    root,
    strategies: STRATEGIES.map((strategy) => ({
      strategy,
      description: STRATEGY_DESCRIPTIONS[strategy],
      default: strategy === DEFAULT_STRATEGY,
    })),
    defaultStrategy: DEFAULT_STRATEGY,
    swarmOrder: SWARM_ORDER,
    roles,
    customAgents,
    workflows,
    configuredStages: stages,
    policySource: resolved.source,
    verifiableRoles: roles.filter((role) => role.available).length,
    swarmDefault: {
      enable: verdict.enable,
      reason:
        'no pass@k measurement has been run in this project, so swarm stays off. ' +
        'Requirement 24.8: it may only become a default for a task class after measured ' +
        `pass@k lift over ${DEFAULT_STRATEGY} on the internal suite`,
    },
    // NOTE ON THE WORDING: the zero-dependency guard in `test/deps.test.ts` scans source
    // text for `from '<specifier>'` literally, so a sentence ending "comes from" immediately
    // before a quote reads to it as a bare import. Fourth time this has happened in this
    // repository. The rule is to move the DATA, never the guard.
    note:
      'Roles exist only inside a dispatch. Live per-role status is derived out of the ' +
      'strategy_selected events in the timeline, not out of this method.',
  }
}

/**
 * The nine-stage contract for this run, or `undefined` to leave `task.verify` in
 * charge.
 *
 * OPT-IN, via `params.verifyPolicy`. Three settings, and the reason each exists:
 *   * absent / `false` — unchanged behaviour. `task.verify` decides, which is what
 *     every existing caller (the eval harness above all) already depends on.
 *   * `true` — resolve `verify.yaml`, or detect per stack. This is what a desktop
 *     run wants: "done" should mean the project's own gauntlet passed.
 *   * an object — an explicit policy on the wire, for a caller that already knows
 *     the stages (the bench harness in Phase 11).
 *
 * Not on by default because it changes what `ok` MEANS for every existing caller,
 * and because auto-detection can name a command the machine does not have — which
 * would turn "the model finished" into "the model finished and `ruff` is not
 * installed". A caller asks for the contract deliberately.
 */
async function resolveVerifyPolicyFor(
  root: string,
  params: Record<string, unknown>,
  ctx: MethodContext,
): Promise<VerifyPolicy | undefined> {
  const requested = params['verifyPolicy']
  if (requested === undefined || requested === null || requested === false) return undefined

  if (requested === true) {
    const resolved = await resolveVerifyPolicy(root)
    for (const diagnostic of resolved.diagnostics) ctx.log(`verify policy: ${diagnostic}`)
    ctx.log(
      resolved.source === 'file'
        ? `verify policy read from ${resolved.path}`
        : resolved.source === 'detected'
          ? `verify policy detected for a ${resolved.language} project: ${Object.keys(resolved.policy).join(', ')}`
          : 'no verify policy: no policy file, and no stage detected for this project',
    )
    return resolved.policy
  }

  if (typeof requested === 'object' && !Array.isArray(requested)) {
    // An explicit policy still goes through the JSON reader, so a caller on the wire
    // cannot hand the runner a shape the file format would have rejected.
    const { policy, diagnostics } = parsePolicyJson(JSON.stringify(requested))
    for (const diagnostic of diagnostics) ctx.log(`verify policy: ${diagnostic}`)
    return policy
  }

  throw new InvalidParamsError(
    'params.verifyPolicy must be true, false, or an object of stage → commands',
  )
}

/**
 * Assemble retrieved context for a run, or return `undefined` and say why.
 *
 * Retrieval failing must not fail the run: a task with no context is a worse run,
 * not a dead one, and a corrupt index is a live possibility (`loadRepoGraph`
 * already treats one as "no graph"). The reason is logged through `ctx.log`, which
 * is stderr on the wire, so it never contaminates the event stream on stdout.
 *
 * ── MEMORY IS PART OF THE CONTEXT, NOT A SECOND CHANNEL ─────────────────────
 *
 * `assembleContext` has had a `memory` input since Phase 5 and nothing ever filled it, so
 * the store was write-only: a project accumulated decisions, standards and past bugs that
 * no run ever saw. Filling the existing seam is deliberate — a separate prompt section
 * would put memory outside the token budget that is supposed to bound the whole prompt,
 * and memory is the FIRST thing assembly degrades, which is the right priority when a
 * budget is tight: the code being changed matters more than the project's history of it.
 *
 * A digest read failure is logged and the run continues with code context alone, for the
 * same reason retrieval failure does not fail the run.
 */
async function retrieveContextFor(
  root: string,
  task: Task,
  skills: readonly Skill[],
  budgetTokens: number | undefined,
  events: EventStore,
  ctx: MethodContext,
  // A THUNK, not a store. Resolving it eagerly would build a store for a run that never
  // retrieves, and would turn a bad `memoryStore` id into a failure BEFORE the run instead
  // of a logged reason — which is the opposite of "reading memory must not fail the run".
  memoryStoreForRun?: () => memory.MemoryStore,
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

  let digest = ''
  if (memoryStoreForRun !== undefined) {
    try {
      digest = await memory.memoryDigest({ store: memoryStoreForRun() })
    } catch (err) {
      ctx.log(`project memory not included, continuing without it: ${messageOf(err)}`)
    }
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
      // Empty stays empty: assembly adds no memory section for a project that has none,
      // rather than a heading with nothing under it.
      ...(digest.trim() === '' ? {} : { memory: digest }),
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

/**
 * One file as it is in HEAD (`ref: 'HEAD'`, the default) or in the index
 * (`ref: 'index'`), for the editor's change markers and the diff view. Read-only;
 * `content` is null when that version has no such file (new, untracked, no commit
 * yet, no repository).
 */
async function gitShow(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const path = optionalString(params, 'path', 'params.path')
  if (path === undefined || path.trim() === '') throw new InvalidParamsError('params.path is required')
  const ref = optionalString(params, 'ref', 'params.ref') ?? 'HEAD'
  if (ref !== 'HEAD' && ref !== 'index') throw new InvalidParamsError("params.ref must be 'HEAD' or 'index' when present")
  const tool = gitTool(gitRoot(params), ctx, false)
  const content = ref === 'index' ? await tool.showIndex(path) : await tool.showHead(path)
  return { content }
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

async function gitDiscard(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const tool = gitTool(gitRoot(params), ctx, true)
  await tool.discard(gitPaths(params))
  return tool.status()
}

async function gitBranches(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  return gitTool(gitRoot(params), ctx, false).branches()
}

async function gitSwitch(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const tool = gitTool(gitRoot(params), ctx, true)
  const name = readString(params, 'branch', 'params.branch')
  const create = optionalBoolean(params, 'create', 'params.create') === true
  await tool.switchBranch(name, { create })
  return tool.status()
}

// Push, pull and fetch exist to reach a remote, so Offline Mode refuses them before
// `git` starts: the network guard covers this process's requests, not a child's.
const GIT_REMOTE_LABEL = 'git://remote'

async function gitPush(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  assertOnlineAction(params, ctx, GIT_REMOTE_LABEL, 'git push')
  const tool = gitTool(gitRoot(params), ctx, true)
  const { output } = await tool.push()
  return { output, status: await tool.status() }
}

async function gitPull(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  assertOnlineAction(params, ctx, GIT_REMOTE_LABEL, 'git pull')
  const tool = gitTool(gitRoot(params), ctx, true)
  const { output } = await tool.pull()
  return { output, status: await tool.status() }
}

async function gitFetch(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  assertOnlineAction(params, ctx, GIT_REMOTE_LABEL, 'git fetch')
  const tool = gitTool(gitRoot(params), ctx, true)
  await tool.fetch()
  return tool.status()
}

async function gitLog(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const limit = optionalNumber(params, 'limit', 'params.limit') ?? 30
  return { commits: await gitTool(gitRoot(params), ctx, false).log(limit) }
}

/** Diff characters quoted to the model for a commit message. */
const COMMIT_DIFF_CHARS = 14_000

/**
 * A commit message for what is staged (or, with nothing staged, for the working-tree
 * changes), written by the connected model from the diff and the repository's recent
 * subjects. One model call, nothing written: the message lands in the commit box for
 * the user to read and edit before committing.
 */
async function gitCommitMessage(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const tool = gitTool(gitRoot(params), ctx, false)
  let diff = await tool.diff({ staged: true })
  let source: 'staged' | 'unstaged' = 'staged'
  if (diff.trim() === '') {
    diff = await tool.diff()
    source = 'unstaged'
  }
  if (diff.trim() === '') throw new InvalidParamsError('there are no changes to describe')
  const recent = await tool.log(8).catch(() => [])
  const quoted = diff.length > COMMIT_DIFF_CHARS ? `${diff.slice(0, COMMIT_DIFF_CHARS)}\n… (diff truncated)` : diff
  const style =
    recent.length > 0
      ? `Recent commit subjects in this repository, for style:\n${recent.map((c) => `- ${c.subject}`).join('\n')}\n\n`
      : ''
  const adapter = adapterFor(params, ctx)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  timer.unref?.()
  try {
    const options: ChatCallOptions = { signal: controller.signal, maxTokens: 300, temperature: 0.2 }
    const response = await adapter.chat(
      [
        {
          role: 'system',
          content:
            'You write git commit messages. Reply with the message only: a subject line of at most 72 characters in the ' +
            "imperative mood (\"Fix …\", \"Add …\"), following the repository's style when one is shown; then, only if the " +
            'change needs it, a blank line and a short body explaining why. No code fences, no quotes, no preamble.',
        },
        { role: 'user', content: `${style}The ${source} diff:\n\n${quoted}` },
      ],
      options as { signal?: AbortSignal },
    )
    const message = response.text
      .replace(/^```[a-z]*\n?|```\s*$/gim, '')
      .replace(/^["'`]+|["'`]+$/g, '')
      .trim()
    if (message === '') throw new Error('the model returned an empty message')
    const answeredModel = typeof response.model === 'string' && response.model.trim() !== '' ? response.model.trim() : null
    noteUsage(params, 'commit-message', {
      provider: adapter.id,
      requestedModel: adapter.model ?? null,
      answeredModel: answeredModel !== null && answeredModel !== adapter.model ? answeredModel : null,
      usage: response.usage ?? null,
      usageEstimated: adapter.model === 'fake',
      ok: true,
      attempts: response.attempts,
      root: optionalString(params, 'root', 'params.root') ?? null,
    })
    return {
      message,
      source,
      ...(adapter.model !== undefined ? { model: adapter.model } : {}),
      ...(answeredModel !== null && answeredModel !== adapter.model ? { responseModel: answeredModel } : {}),
    }
  } finally {
    clearTimeout(timer)
  }
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
async function providerCatalog(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const path = settingsPath(params)
  const loaded = await loadProviderSettings(path)
  const catalog = ctx.extensions?.providers.catalog() ?? providerMatrix()
  const ids = [...new Set([...catalog.map((entry) => entry.id), ...loaded.settings.providers.map((entry) => entry.id)])]
  return {
    catalog,
    settings: loaded.settings,
    path: loaded.path,
    // Which providers already have a key in the environment, by variable NAME only,
    // so a surface can say "using OPENAI_API_KEY" instead of asking for it again.
    envKeys: envKeyPresence(ids, ctx.env),
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
  assertProviderAllowed(config, params, ctx)
  const timeoutMs = optionalNumber(params, 'timeoutMs', 'params.timeoutMs')
  if (config.id === CHATGPT_PROVIDER_ID) {
    const result = await chatgptConnectionTest(config, params, ctx, timeoutMs)
    noteUsage(params, 'connection-test', { provider: config.id, requestedModel: config.model, usage: null, ok: (result as { ok?: boolean }).ok === true })
    return result
  }
  const target: ProviderTestTarget = {
    id: config.id,
    kind: config.kind,
    // An empty baseUrl falls back to the catalog default, exactly as a run does.
    baseUrl: config.baseUrl || (describeProvider(config.id)?.defaultBaseUrl ?? ''),
    model: config.model,
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
  }
  const result = await testProviderConnection(target, {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  })
  // A connection test is a GET /models, so it spends a request but no tokens.
  noteUsage(params, 'connection-test', { provider: config.id, requestedModel: config.model, usage: null, ok: result.ok })
  return result
}

/**
 * The models a provider serves, asked of the provider. A real network call made
 * only because a surface asked (the model picker); the key is for this one call.
 * `params.provider.model` is not required here — choosing one is the point.
 */
async function providerModels(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const source = asObject(params['provider'], 'params.provider')
  const config = readProviderConfig({ model: '-', ...source }, ctx)
  assertProviderAllowed(config, params, ctx)
  const timeoutMs = optionalNumber(params, 'timeoutMs', 'params.timeoutMs')
  if (config.id === CHATGPT_PROVIDER_ID) {
    const url = `${CHATGPT_CODEX_BASE_URL}/models`
    try {
      const listed = await listChatGPTModels({
        ...chatgptStore(params),
        env: ctx.env,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      })
      noteUsage(params, 'model-list', { provider: config.id, usage: null, ok: true })
      return {
        ok: true,
        code: 'ok',
        message: listed.message,
        url,
        models: listed.models.map((m) => ({
          id: m.id,
          name: m.name,
          ...(m.contextLength !== undefined ? { contextLength: m.contextLength } : {}),
        })),
      }
    } catch (err) {
      noteUsage(params, 'model-list', { provider: config.id, usage: null, ok: false })
      return { ok: false, code: 'unauthorized', message: messageOf(err), url, models: [] }
    }
  }
  const target: ProviderModelsTarget = {
    id: config.id,
    kind: config.kind,
    baseUrl: config.baseUrl || (describeProvider(config.id)?.defaultBaseUrl ?? ''),
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
  }
  const result = await listProviderModels(target, { ...(timeoutMs !== undefined ? { timeoutMs } : {}) })
  noteUsage(params, 'model-list', { provider: config.id, usage: null, ok: result.ok })
  return result
}

// ── account sign-in (loopback OAuth) ────────────────────────────────────────
//
// The engine's part of "Connect your account" is ONLY the listener: it opens a port
// on loopback and reports the one-time `code` the provider redirects back with. The
// PKCE verifier lives in the surface that started the flow, the exchange happens
// there, and the resulting key goes straight to the OS credential store — no
// credential is ever held or returned here. `oauth-wait` is a long poll, which is
// only possible because the protocol server no longer queues it behind a run.

async function oauthStart(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  // The listener is local, but its only purpose is a sign-in the window then completes
  // over the internet (the OpenRouter key exchange). Offline Mode stops it here.
  assertOnlineAction(params, ctx, 'https://openrouter.ai', 'account sign-in')
  const timeoutMs = optionalNumber(params, 'timeoutMs', 'params.timeoutMs')
  return startLoopback({ ...(timeoutMs !== undefined ? { timeoutMs } : {}) })
}

async function oauthWait(params: Record<string, unknown>): Promise<unknown> {
  const id = optionalString(params, 'id', 'params.id')
  if (id === undefined) throw new InvalidParamsError('params.id is required')
  return waitLoopback(id)
}

async function oauthCancel(params: Record<string, unknown>): Promise<unknown> {
  const id = optionalString(params, 'id', 'params.id')
  if (id === undefined) throw new InvalidParamsError('params.id is required')
  return { id, cancelled: cancelLoopback(id) }
}

// ── "Sign in with ChatGPT" ──────────────────────────────────────────────────
//
// Unlike the OpenRouter flow above, the ENGINE completes this one: it holds the
// PKCE verifier, exchanges the code, and keeps the tokens (settings/chatgptAuth.ts
// says why — OpenAI rotates refresh tokens on every use). The window learns only
// whether it worked, and as whom. No method here returns a token.

function chatgptStore(params: Record<string, unknown>): { home?: string } {
  const home = optionalString(params, 'home', 'params.home')
  return home === undefined ? {} : { home: resolve(home) }
}

async function chatgptStatusMethod(params: Record<string, unknown>): Promise<unknown> {
  return chatgptStatus(chatgptStore(params))
}

async function chatgptLoginStart(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const mode = optionalString(params, 'mode', 'params.mode') ?? 'browser'
  if (mode !== 'browser' && mode !== 'device') {
    throw new InvalidParamsError("params.mode must be 'browser' or 'device'")
  }
  assertOnlineAction(params, ctx, CHATGPT_CODEX_BASE_URL, 'Sign in with ChatGPT')
  const timeoutMs = optionalNumber(params, 'timeoutMs', 'params.timeoutMs')
  const options = { ...chatgptStore(params), env: ctx.env, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }
  try {
    if (mode === 'device') {
      const device = await startChatGPTDeviceLogin(options)
      return { ok: true, mode, ...device }
    }
    const browser = await startChatGPTBrowserLogin(options)
    return { ok: true, mode, id: browser.id, authUrl: browser.authUrl, port: browser.port, expiresAt: browser.expiresAt }
  } catch (err) {
    if (err instanceof ChatGPTAuthError) return { ok: false, code: err.code, error: err.message }
    throw err
  }
}

async function chatgptLoginWait(params: Record<string, unknown>): Promise<unknown> {
  const id = optionalString(params, 'id', 'params.id')
  if (id === undefined) throw new InvalidParamsError('params.id is required')
  return waitChatGPTLogin(id)
}

async function chatgptLoginCancel(params: Record<string, unknown>): Promise<unknown> {
  const id = optionalString(params, 'id', 'params.id')
  if (id === undefined) throw new InvalidParamsError('params.id is required')
  return { id, cancelled: cancelChatGPTLogin(id) }
}

async function chatgptLogoutMethod(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  return chatgptLogout({ ...chatgptStore(params), env: ctx.env })
}

async function chatgptModels(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const timeoutMs = optionalNumber(params, 'timeoutMs', 'params.timeoutMs')
  try {
    return await listChatGPTModels({ ...chatgptStore(params), env: ctx.env, ...(timeoutMs !== undefined ? { timeoutMs } : {}) })
  } catch (err) {
    return {
      ok: false,
      source: 'none',
      models: [],
      defaultModel: '',
      code: err instanceof ChatGPTAuthError ? err.code : 'transient',
      message: messageOf(err),
    }
  }
}

/**
 * The connection test for a ChatGPT account is one tiny real request, because the
 * only question that matters — "will a run work?" — is answered by nothing less.
 */
async function chatgptConnectionTest(
  config: ProviderConfig,
  params: Record<string, unknown>,
  ctx: MethodContext,
  timeoutMs?: number,
): Promise<unknown> {
  const url = `${CHATGPT_CODEX_BASE_URL}/responses`
  const started = Date.now()
  const store = chatgptStore(params)
  const status = await chatgptStatus(store)
  if (!status.signedIn) {
    return {
      ok: false,
      code: 'unauthorized',
      message: status.needsSignIn
        ? 'Your ChatGPT sign-in has ended. Sign in with ChatGPT again.'
        : 'Not signed in to ChatGPT yet. Choose “Sign in with ChatGPT”.',
      url,
      durationMs: Date.now() - started,
    }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(5_000, timeoutMs ?? 45_000))
  try {
    const adapter = new ChatGPTCodexAdapter(config, { env: ctx.env, ...store })
    const reply = await adapter.chat(
      [
        { role: 'system', content: 'You are a connection check. Reply with exactly: OK' },
        { role: 'user', content: 'ping' },
      ],
      { signal: controller.signal, maxTokens: 16 },
    )
    const who = status.email !== undefined ? ` as ${status.email}` : ''
    const plan = status.plan !== undefined ? ` (${status.plan} plan)` : ''
    return {
      ok: true,
      code: 'ok',
      message: `ChatGPT answered${who}${plan} with ${config.model}${reply.text.trim() === '' ? '' : `: “${reply.text.trim().slice(0, 40)}”`}.`,
      url,
      durationMs: Date.now() - started,
    }
  } catch (err) {
    const message = messageOf(err)
    const code = controller.signal.aborted
      ? 'timeout'
      : /not available to your ChatGPT account|not supported/i.test(message)
        ? 'model-not-found'
        : /sign in|sign-in|signed in/i.test(message)
          ? 'unauthorized'
          : /Could not reach/i.test(message)
            ? 'unreachable'
            : 'endpoint-error'
    return {
      ok: false,
      code,
      message: code === 'timeout' ? 'ChatGPT did not answer in time. Try again.' : message,
      url,
      durationMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Put back every file an auto-applied run changed, from the snapshot it journalled.
 * A file edited by someone after the run wrote it is skipped and reported, never
 * overwritten.
 */
async function undoRun(params: Record<string, unknown>): Promise<unknown> {
  const root = resolve(readString(params, 'root', 'params.root'))
  const runId = optionalString(params, 'runId', 'params.runId')
  if (runId === undefined || !/^[A-Za-z0-9._-]{1,128}$/.test(runId)) {
    throw new InvalidParamsError('params.runId must be 1-128 characters from A-Z a-z 0-9 . _ -')
  }
  return restoreSnapshot(root, runId)
}

/**
 * Clone a repository into a NEW folder under `params.parent`, for the "Clone
 * Repository" button. One spawn, no shell, a URL that must look like a repository
 * address, and a target folder that must not exist yet — so it can never be
 * pointed at the user's existing files.
 */
async function gitClone(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const url = readString(params, 'url', 'params.url').trim()
  const parent = resolve(readString(params, 'parent', 'params.parent'))
  if (!/^(https:\/\/|git@|ssh:\/\/)[^\s]+$/.test(url) || url.startsWith('-')) {
    throw new InvalidParamsError('params.url must be an https://, ssh:// or git@ repository address')
  }
  assertOnlineAction(params, ctx, url.startsWith('https://') ? url : GIT_REMOTE_LABEL, 'git clone')
  const derived = url.replace(/[/\\]+$/, '').split(/[/:\\]/).pop()?.replace(/\.git$/i, '') ?? ''
  const name = (optionalString(params, 'name', 'params.name') ?? derived).trim()
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === '.' || name === '..') {
    throw new InvalidParamsError('the folder name may contain only letters, digits, . _ and -')
  }
  let parentInfo
  try {
    parentInfo = await stat(parent)
  } catch {
    throw new InvalidParamsError(`params.parent does not exist: ${parent}`)
  }
  if (!parentInfo.isDirectory()) throw new InvalidParamsError(`params.parent is not a folder: ${parent}`)
  const target = join(parent, name)
  const exists = await stat(target).then(
    () => true,
    () => false,
  )
  if (exists) throw new InvalidParamsError(`a folder named ${name} already exists in ${parent}`)

  const output = await new Promise<{ code: number | null; stderr: string }>((resolveClone, rejectClone) => {
    const launch = resolveForSpawn('git', ['clone', '--', url, target], ctx.env)
    const child = spawnProcess(launch.cmd, launch.args, {
      cwd: parent,
      shell: false,
      windowsHide: true,
      // Never block on a credential prompt: a private repository fails with a message.
      env: { ...ctx.env, GIT_TERMINAL_PROMPT: '0' },
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000)
    })
    const timer = setTimeout(() => child.kill(), 10 * 60_000)
    child.on('error', (err) => {
      clearTimeout(timer)
      rejectClone(new Error(`git could not be started: ${err.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveClone({ code, stderr })
    })
  })
  if (output.code !== 0) {
    throw new Error(`git clone failed: ${output.stderr.trim().split('\n').slice(-3).join(' ') || `exit ${output.code}`}`)
  }
  return { path: target, name }
}

// ── terminal ─────────────────────────────────────────────────────────────────
//
// The Code surface's terminal. One host per engine process, so every window tab and
// both transports see the same running commands. See tools/terminal.ts for why this
// lives in the engine rather than behind the old blocking Tauri command.

let terminalHost: TerminalHost | null = null

function terminal(ctx: MethodContext): TerminalHost {
  if (terminalHost === null) {
    terminalHost = new TerminalHost({ env: ctx.env })
    const host = terminalHost
    // A dev server must not outlive the engine that started it.
    process.once('exit', () => host.disposeAll())
  }
  return terminalHost
}

/** A refusal is a sentence for the user; anything else keeps its own message. */
function asTerminalError(err: unknown): never {
  if (err instanceof TerminalRefusal) throw new InvalidParamsError(err.message)
  throw err
}

function readTerminalId(params: Record<string, unknown>): string {
  const id = readString(params, 'id', 'params.id')
  if (!/^term-[a-z0-9]+-\d+$/.test(id)) throw new InvalidParamsError('params.id is not a terminal command id')
  return id
}

async function termStart(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const root = readString(params, 'root', 'params.root')
  const line = params['line']
  if (typeof line !== 'string') throw new InvalidParamsError('params.line must be a string')
  if (line.length > 8000) throw new InvalidParamsError('params.line is too long for one command')
  const cwd = optionalString(params, 'cwd', 'params.cwd')
  const confirmed = optionalBoolean(params, 'confirmed', 'params.confirmed') === true
  try {
    const host = terminal(ctx)
    return { ...host.start({ root, line, confirmed, ...(cwd !== undefined ? { cwd } : {}) }) }
  } catch (err) {
    return asTerminalError(err)
  }
}

async function termRead(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const id = readTerminalId(params)
  const since = optionalNumber(params, 'since', 'params.since') ?? 0
  try {
    return terminal(ctx).read(id, since)
  } catch (err) {
    return asTerminalError(err)
  }
}

async function termWrite(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const id = readTerminalId(params)
  const data = params['data']
  const end = optionalBoolean(params, 'end', 'params.end') === true
  if (data !== undefined && typeof data !== 'string') throw new InvalidParamsError('params.data must be a string')
  try {
    const host = terminal(ctx)
    if (typeof data === 'string' && data !== '') host.write(id, data)
    if (end) host.endInput(id)
    return { ok: true }
  } catch (err) {
    return asTerminalError(err)
  }
}

async function termKill(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const id = readTerminalId(params)
  try {
    return terminal(ctx).kill(id)
  } catch (err) {
    return asTerminalError(err)
  }
}

// ── the project watcher ─────────────────────────────────────────────────────
//
// What changed on disk, by long poll: see tools/watcher.ts. One watcher per open
// folder, shared by every window polling it, closed when none has polled for a while.

let watcherRegistry: WatcherRegistry | null = null

function watchers(): WatcherRegistry {
  if (watcherRegistry === null) {
    watcherRegistry = new WatcherRegistry()
    const registry = watcherRegistry
    process.once('exit', () => registry.closeAll())
  }
  return watcherRegistry
}

async function fsWatch(params: Record<string, unknown>): Promise<unknown> {
  const root = readString(params, 'root', 'params.root')
  if (!/^(?:[A-Za-z]:[\\/]|[\\/])/.test(root)) throw new InvalidParamsError('params.root must be an absolute path')
  const since = optionalNumber(params, 'since', 'params.since')
  const timeoutMs = optionalNumber(params, 'timeoutMs', 'params.timeoutMs') ?? 25_000
  if (timeoutMs < 0) throw new InvalidParamsError('params.timeoutMs must not be negative')
  return watchers().for(root).poll(since === undefined ? undefined : Math.floor(since), timeoutMs)
}

// ── handing a path to the operating system ──────────────────────────────────
//
// "Reveal in File Explorer / Finder" and "Open in External Terminal". Contained to the
// project by real path; spawned shell-less and detached. See tools/desktopOpen.ts.

function asOsError(err: unknown): never {
  if (err instanceof OsOpenRefusal) throw new InvalidParamsError(err.message)
  throw err
}

async function osReveal(params: Record<string, unknown>): Promise<unknown> {
  const root = readString(params, 'root', 'params.root')
  const path = readString(params, 'path', 'params.path')
  try {
    return await revealInFileManager(root, path)
  } catch (err) {
    return asOsError(err)
  }
}

async function osOpenTerminal(params: Record<string, unknown>): Promise<unknown> {
  const root = readString(params, 'root', 'params.root')
  const path = optionalString(params, 'path', 'params.path') ?? root
  try {
    return await openExternalTerminal(root, path)
  } catch (err) {
    return asOsError(err)
  }
}

// ── explorer file operations ────────────────────────────────────────────────

async function fsGuard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof FsRefusal) throw new InvalidParamsError(err.message)
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code === 'EPERM' || code === 'EACCES') throw new Error('The operating system refused: permission denied.')
    if (code === 'EBUSY') throw new Error('The file is in use by another program. Close it there and try again.')
    if (code === 'ENOTEMPTY') throw new Error('The folder is not empty.')
    throw err
  }
}

async function fsCreateFile(params: Record<string, unknown>): Promise<unknown> {
  const root = readString(params, 'root', 'params.root')
  const path = readString(params, 'path', 'params.path')
  const content = params['content']
  if (content !== undefined && typeof content !== 'string') throw new InvalidParamsError('params.content must be a string')
  return fsGuard(() => createFile(root, path, content ?? ''))
}

async function fsCreateFolder(params: Record<string, unknown>): Promise<unknown> {
  const root = readString(params, 'root', 'params.root')
  const path = readString(params, 'path', 'params.path')
  return fsGuard(() => createFolder(root, path))
}

async function fsRename(params: Record<string, unknown>): Promise<unknown> {
  const root = readString(params, 'root', 'params.root')
  const source = readString(params, 'source', 'params.source')
  const target = readString(params, 'target', 'params.target')
  return fsGuard(() => renameEntry(root, source, target))
}

/**
 * Delete. `trash` defaults to TRUE: a delete is recoverable unless the user explicitly
 * chose otherwise. When the trash cannot be used nothing is deleted, and the answer
 * says so (`trashUnavailable`) so the window can offer a permanent delete instead.
 */
async function fsDelete(params: Record<string, unknown>): Promise<unknown> {
  const root = readString(params, 'root', 'params.root')
  const path = readString(params, 'path', 'params.path')
  const trash = optionalBoolean(params, 'trash', 'params.trash') ?? true
  return fsGuard(async () => {
    try {
      return { deleted: true, ...(await deleteEntry(root, path, { trash })) }
    } catch (err) {
      if (err instanceof TrashUnavailable) return { deleted: false, trashUnavailable: true, message: err.message }
      throw err
    }
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

// ── project text search ──────────────────────────────────────────────────────
//
// The Search panel is a UI over this ONE method. It used to have its own retriever
// in the desktop package — `git grep` through the Tauri command policy, a folder
// walk behind it, and a matcher built on JavaScript regular expressions — while the
// retrieval stack used this package's lexical channel. Two engines with two match
// dialects: the same query over the same file could highlight one thing in the panel
// and score another in retrieval. That implementation is deleted and this is what
// the panel calls instead, for the same reasons the Git panel calls `git-*`:
//
//   * the dialect. `matchSpans` in context/hybrid-search.ts decides what a match is,
//     once, for the ranking AND for the highlight. There is no second answer to
//     reconcile.
//   * the seam. Engine capability, one implementation, reachable from the browser
//     dev bridge as well as the app (Requirement 13.3).
//   * the allowlist. The engine spawns ripgrep through verify/runner.ts, so `rg`
//     never had to be added to `command_policy::ALLOWED_PROGRAMS` in Rust. The panel
//     got faster search without widening a security boundary.
//
// READ-ONLY AND EVENTLESS. Nothing is emitted (a keystroke is not run history) and
// nothing is written — with no persisted graph the file list is walked in memory.

async function projectSearchMethod(params: Record<string, unknown>): Promise<unknown> {
  // Required and explicit, like `gitRoot`: falling back to the server's cwd would
  // search whatever directory the sidecar happens to have been started in.
  const root = resolve(readString(params, 'root', 'params.root'))
  const query = readString(params, 'query', 'params.query')
  const matchCase = optionalBoolean(params, 'matchCase', 'params.matchCase')
  const wholeWord = optionalBoolean(params, 'wholeWord', 'params.wholeWord')
  const maxHits = optionalNumber(params, 'maxHits', 'params.maxHits')

  return projectSearch({
    root,
    query,
    ...(matchCase === true ? { matchCase: true } : {}),
    ...(wholeWord === true ? { wholeWord: true } : {}),
    ...(maxHits !== undefined ? { maxHits: Math.max(1, Math.floor(maxHits)) } : {}),
  })
}

// ── Find in Files / Replace in Files ─────────────────────────────────────────
//
// The Search panel's editor-style search (tools/findReplace.ts): literal by default,
// optionally a regular expression, case and whole-word toggles, include/exclude globs,
// and Replace that rewrites exactly the matches the panel showed. `find-in-files` is a
// read and emits nothing; a newer search with the same `requestId` stops the older one.
// `replace-in-files` writes through the contained, snapshotting writer and returns the
// snapshot id `undo-run` takes, so a Replace All can be undone.

/** A search text may be a single space; only "nothing at all" is refused. */
function readSearchText(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value === '') throw new InvalidParamsError(`params.${key} must be a non-empty string`)
  if (value.length > 4000) throw new InvalidParamsError(`params.${key} is longer than 4000 characters`)
  return value
}

/** Optional text that may legitimately be empty (a replacement, a glob box). */
function readOptionalText(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new InvalidParamsError(`params.${key} must be a string when present`)
  if (value.length > 4000) throw new InvalidParamsError(`params.${key} is longer than 4000 characters`)
  return value
}

function readFindQuery(params: Record<string, unknown>): FindQuery & FindFilters {
  const isRegex = optionalBoolean(params, 'isRegex', 'params.isRegex')
  const matchCase = optionalBoolean(params, 'matchCase', 'params.matchCase')
  const wholeWord = optionalBoolean(params, 'wholeWord', 'params.wholeWord')
  const include = readOptionalText(params, 'include')
  const exclude = readOptionalText(params, 'exclude')
  return {
    query: readSearchText(params, 'query'),
    ...(isRegex === true ? { isRegex: true } : {}),
    ...(matchCase === true ? { matchCase: true } : {}),
    ...(wholeWord === true ? { wholeWord: true } : {}),
    ...(include !== undefined ? { include } : {}),
    ...(exclude !== undefined ? { exclude } : {}),
  }
}

async function assertFolder(root: string): Promise<void> {
  let info
  try {
    info = await stat(root)
  } catch (err) {
    throw new InvalidParamsError(`cannot search ${root}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!info.isDirectory()) throw new InvalidParamsError(`cannot search ${root}: not a folder`)
}

async function findInFilesMethod(params: Record<string, unknown>): Promise<unknown> {
  const root = resolve(readString(params, 'root', 'params.root'))
  const query = readFindQuery(params)
  const replacement = readOptionalText(params, 'replacement')
  const maxHits = optionalNumber(params, 'maxHits', 'params.maxHits')
  const requestId = optionalString(params, 'requestId', 'params.requestId')
  if (requestId !== undefined && !/^[A-Za-z0-9._-]{1,128}$/.test(requestId)) {
    throw new InvalidParamsError('params.requestId must be 1-128 characters from A-Z a-z 0-9 . _ -')
  }
  await assertFolder(root)
  const controller = new AbortController()
  if (requestId !== undefined) {
    inFlightRuns.get(requestId)?.abort()
    inFlightRuns.set(requestId, controller)
  }
  try {
    const result = await findInFiles({
      root,
      ...query,
      ...(replacement !== undefined ? { replacement } : {}),
      ...(maxHits !== undefined ? { maxHits: Math.max(1, Math.min(20_000, Math.floor(maxHits))) } : {}),
      signal: controller.signal,
    })
    return { ...result, cancelled: controller.signal.aborted }
  } catch (err) {
    if (err instanceof FindQueryError) throw new InvalidParamsError(err.message)
    throw err
  } finally {
    if (requestId !== undefined && inFlightRuns.get(requestId) === controller) inFlightRuns.delete(requestId)
  }
}

function readReplaceOnly(value: unknown): { path: string; line: number; text: string; textStart: number } | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new InvalidParamsError('params.only must be an object')
  const only = value as Record<string, unknown>
  const path = only['path']
  const line = only['line']
  const text = only['text']
  const textStart = only['textStart']
  if (typeof path !== 'string' || path.trim() === '') throw new InvalidParamsError('params.only.path must be a non-empty string')
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) throw new InvalidParamsError('params.only.line must be a positive integer')
  if (typeof text !== 'string') throw new InvalidParamsError('params.only.text must be a string')
  if (typeof textStart !== 'number' || !Number.isInteger(textStart) || textStart < 0) {
    throw new InvalidParamsError('params.only.textStart must be a non-negative integer')
  }
  return { path, line, text, textStart }
}

async function replaceInFilesMethod(params: Record<string, unknown>): Promise<unknown> {
  const root = resolve(readString(params, 'root', 'params.root'))
  const query = readFindQuery(params)
  const replacement = readOptionalText(params, 'replacement')
  if (replacement === undefined) throw new InvalidParamsError('params.replacement must be a string (it may be empty)')
  const paths = optionalStringArray(params['paths'], 'params.paths')
  const only = readReplaceOnly(params['only'])
  await assertFolder(root)
  const snapshotId = `replace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  try {
    return await replaceInFiles({
      root,
      ...query,
      replacement,
      ...(paths !== undefined ? { paths } : {}),
      ...(only !== undefined ? { only } : {}),
      snapshotId,
    })
  } catch (err) {
    if (err instanceof FindQueryError) throw new InvalidParamsError(err.message)
    throw err
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
 * The registry to use: an explicit one when configured, otherwise the curated registry
 * EMBEDDED in this engine, materialized under `~/.sketch/registry/`. The shipped app is a
 * single bundled file with no `registry/` beside it, so without the embedded copy every
 * installed app reported "no skill registry is configured" and no skill could be added.
 * The same installer verification applies to it as to any other registry folder.
 */
async function registryDirFor(params: Record<string, unknown>, ctx: MethodContext): Promise<string | null> {
  const configured = configuredRegistryDir(params, ctx)
  if (configured !== null) return configured
  const home = optionalString(params, 'home', 'params.home') ?? homedir()
  try {
    return await materializeEmbeddedRegistry(join(resolve(home), '.sketch', 'registry'))
  } catch (err) {
    ctx.log(`embedded skill registry unavailable: ${messageOf(err)}`)
    return null
  }
}

/**
 * The catalog: every pinned skill, plus what is installed in this project.
 *
 * `installed` is read from disk rather than from a list the UI keeps, so a skill
 * removed by hand shows as removed and the panel cannot disagree with the
 * filesystem — the same discipline as one authoritative file cache in the editor.
 */
async function skillsCatalog(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const root = resolve(optionalString(params, 'root', 'params.root') ?? ctx.cwd())
  const registryDir = await registryDirFor(params, ctx)

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
  const registryDir = await registryDirFor(params, ctx)
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
  // 'edits' is Microsoft SkillOpt's update rule: a few anchored edits per epoch and
  // a buffer of rejected edits. 'rewrite' (the default) proposes a whole new body.
  const mode = optionalString(params, 'mode', 'params.mode') ?? 'rewrite'
  if (mode !== 'rewrite' && mode !== 'edits') {
    throw new InvalidParamsError(`params.mode must be "rewrite" or "edits", not ${JSON.stringify(mode)}`)
  }
  const maxEdits = optionalNumber(params, 'maxEdits', 'params.maxEdits')
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

  const rejectedEdits: string[] = []
  const proposerOptions: ProviderProposeEditOptions = {
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
  }
  const editProposer =
    mode === 'edits'
      ? providerProposeEdits({ ...proposerOptions, rejected: rejectedEdits, ...(maxEdits !== undefined ? { maxEdits } : {}) })
      : null

  const result = await trainSkill({
    seed,
    cases,
    events,
    adapter,
    ...(epochs !== undefined ? { epochs } : {}),
    proposeEdit: editProposer ?? providerProposeEdit(proposerOptions),
    // Writing the artifact is opt-in: a training run the user has not looked at
    // should not silently replace the skill they installed.
    ...(write === true
      ? { artifactPath: trainingArtifactPath(root, name) }
      : {}),
  })
  // The last round's edits learn their fate only now, from the skill the gate kept;
  // with the default single epoch, that is every round.
  editProposer?.settle(result.skill)

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
    mode,
    ...(mode === 'edits' ? { rejectedEdits } : {}),
    ...(result.artifactPath !== undefined ? { artifactPath: result.artifactPath } : {}),
    // The winning body, so a surface can show a diff before the user writes it.
    body: result.skill.body,
  }
}

/** Activate the measured candidate only after an explicit post-training decision. */
async function skillPromote(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const root = resolve(optionalString(params, 'root', 'params.root') ?? ctx.cwd())
  const name = readString(params, 'name', 'params.name')
  const result = await promoteInstalledSkill(root, name)
  if (result.ok) {
    const events = new StreamingEventStore(
      new JsonlEventStore({ baseDir: root, secrets: () => ctx.secrets() }),
      (event) => ctx.emitEvent(event),
    )
    await events.emit({
      runId: `promote-${name}`,
      kind: 'tool_called',
      payload: {
        component: 'registry',
        name: 'skill-promote',
        skill: name,
        digest: result.digest,
        capabilities: result.granted,
      },
    })
  }
  return result
}

/**
 * Remove an installed skill: its directory and its persisted capability grant.
 *
 * The removal is confined to this project's `.sketch/skills` and refuses an unsafe
 * name before it builds a path (see `uninstallSkill` in `registry/grants.ts`); there
 * is no path parameter and no `force`. It is idempotent — removing something already
 * gone is `ok: true` with nothing removed — and the result says exactly what it took
 * away, so a surface can tell "removed it" from "it was already gone". Afterwards the
 * next `skills-catalog` reads the directory off disk and reports the skill as not
 * installed, and a run can no longer load it because the loader finds nothing there.
 */
async function skillUninstall(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const root = resolve(optionalString(params, 'root', 'params.root') ?? ctx.cwd())
  const name = readString(params, 'name', 'params.name')
  const result = await uninstallSkill(root, name)
  if (result.ok && (result.removedDir || result.removedGrant)) {
    const events = new StreamingEventStore(
      new JsonlEventStore({ baseDir: root, secrets: () => ctx.secrets() }),
      (event) => ctx.emitEvent(event),
    )
    await events.emit({
      runId: `uninstall-${name}`,
      kind: 'tool_called',
      payload: {
        component: 'registry',
        name: 'skill-uninstall',
        skill: name,
        dir: result.dir,
        removedDir: result.removedDir,
        removedGrant: result.removedGrant,
      },
    })
  }
  return result
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

async function benchmarkReport(
  params: Record<string, unknown>,
  ctx: MethodContext,
): Promise<unknown> {
  const root = resolve(optionalString(params, 'root', 'params.root') ?? ctx.cwd())
  const path = await latestBenchArtifactPath(root)
  const report = await loadLatestBenchArtifact(root)
  return {
    root,
    path,
    report,
    note:
      report === null
        ? 'No benchmark artifact exists. Run the bench script explicitly; reading this method never starts a model call, build, or test.'
        : `${report.model} + ${report.harness.id === 'sketch' ? 'Sketch' : 'naive'} under a fixed pass@${report.budget.k} budget. This is an input report, not a claim that Sketch beats a model.`,
  }
}

// ── editor and composer assistance ──────────────────────────────────────────

/** One process-wide ceiling on inline completions; see `CompletionRateLimiter`. */
const completionLimiter = new CompletionRateLimiter()
/** A completion slower than this is useless to someone typing. */
const COMPLETION_TIMEOUT_MS = 15_000

/**
 * Inline completion at the cursor ("ghost text").
 *
 * Cancellable through `cancel` with the `requestId` the editor chose, because the
 * editor abandons a request the moment the user types again. A cancelled or
 * timed-out request answers `{ text: '' }` rather than failing: no suggestion is the
 * honest result of a request nobody is waiting for. A PROVIDER error still fails, so
 * the editor can say once that completion is not working instead of failing silently
 * forever.
 *
 * Nothing is written to the project's event log: a completion is not a run, and one
 * line per pause in typing would bury every run that matters. The usage the provider
 * reported is returned to the caller instead.
 */
async function complete(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const prefix = params['prefix'] ?? ''
  const suffix = params['suffix'] ?? ''
  if (typeof prefix !== 'string') throw new InvalidParamsError('params.prefix must be a string')
  if (typeof suffix !== 'string') throw new InvalidParamsError('params.suffix must be a string')
  const path = optionalString(params, 'path', 'params.path') ?? 'untitled'
  const language = optionalString(params, 'language', 'params.language')
  const requestId = optionalString(params, 'requestId', 'params.requestId')
  if (requestId !== undefined && !/^[A-Za-z0-9._-]{1,128}$/.test(requestId)) {
    throw new InvalidParamsError('params.requestId must be 1-128 characters from A-Z a-z 0-9 . _ -')
  }
  const maxTokens = Math.max(16, Math.min(512, optionalNumber(params, 'maxTokens', 'params.maxTokens') ?? 160))

  if (prefix.trim() === '' && suffix.trim() === '') return { text: '', skipped: 'empty file' }
  if (!completionLimiter.tryAcquire()) {
    return { text: '', throttled: true, detail: 'too many completion requests this minute; pausing suggestions briefly' }
  }

  const adapter = adapterFor(params, ctx)
  const controller = new AbortController()
  if (requestId !== undefined) {
    inFlightRuns.get(requestId)?.abort()
    inFlightRuns.set(requestId, controller)
  }
  const timer = setTimeout(() => controller.abort(), COMPLETION_TIMEOUT_MS)
  timer.unref?.()
  const started = Date.now()
  try {
    const options: ChatCallOptions = { signal: controller.signal, maxTokens, temperature: 0.1 }
    const response = await adapter.chat(
      buildCompletionMessages({ path, prefix, suffix, ...(language !== undefined ? { language } : {}) }),
      // Wider than the contract's `{ signal }` on purpose; see `ChatCallOptions`.
      options as { signal?: AbortSignal },
    )
    const answeredModel = typeof response.model === 'string' && response.model.trim() !== '' ? response.model.trim() : null
    noteUsage(params, 'completion', {
      provider: adapter.id,
      requestedModel: adapter.model ?? null,
      answeredModel: answeredModel !== null && answeredModel !== adapter.model ? answeredModel : null,
      usage: response.usage ?? null,
      usageEstimated: adapter.model === 'fake',
      ok: true,
      attempts: response.attempts,
      root: optionalString(params, 'root', 'params.root') ?? null,
    })
    return {
      text: cleanCompletion(response.text, { prefix, suffix }),
      latencyMs: Date.now() - started,
      ...(response.usage !== undefined ? { usage: response.usage } : {}),
      // The requested model, and the one the provider named as having answered when it
      // differs (a router alias). So even an editor call attributes the real model.
      ...(adapter.model !== undefined ? { model: adapter.model } : {}),
      ...(answeredModel !== null && answeredModel !== adapter.model ? { responseModel: answeredModel } : {}),
    }
  } catch (err) {
    if (controller.signal.aborted) return { text: '', cancelled: true, latencyMs: Date.now() - started }
    throw err
  } finally {
    clearTimeout(timer)
    if (requestId !== undefined && inFlightRuns.get(requestId) === controller) inFlightRuns.delete(requestId)
  }
}

/** A rewrite slower than this has lost the person waiting for it. Long, but slow free models exist. */
const INLINE_EDIT_TIMEOUT_MS = 120_000

/**
 * Inline edit ("Ctrl+K"): the selection rewritten as the instruction asks.
 *
 * The editor shows the answer as a diff the user accepts or rejects; nothing is
 * written here, and nothing is logged — like `complete`, this is an editor action,
 * not a run. Cancellable through `cancel` with the editor's `requestId`; a cancelled
 * or timed-out request answers `{ text: '', cancelled: true }`, while a provider
 * error fails so the editor can show it.
 */
async function inlineEdit(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const before = params['before'] ?? ''
  const selection = params['selection'] ?? ''
  const after = params['after'] ?? ''
  const instructionParam = params['instruction']
  if (typeof before !== 'string') throw new InvalidParamsError('params.before must be a string')
  if (typeof selection !== 'string') throw new InvalidParamsError('params.selection must be a string')
  if (typeof after !== 'string') throw new InvalidParamsError('params.after must be a string')
  if (typeof instructionParam !== 'string' || instructionParam.trim() === '') {
    throw new InvalidParamsError('params.instruction is required: say what should change')
  }
  const instruction = instructionParam.trim()
  if (instruction.length > INLINE_EDIT_MAX_INSTRUCTION) {
    throw new InvalidParamsError(`params.instruction is longer than ${INLINE_EDIT_MAX_INSTRUCTION} characters`)
  }
  if (selection.length > INLINE_EDIT_MAX_SELECTION) {
    throw new InvalidParamsError(
      `the selection is ${selection.length} characters; inline edit takes up to ${INLINE_EDIT_MAX_SELECTION}. Ask the agent for a change this large.`,
    )
  }
  const path = optionalString(params, 'path', 'params.path') ?? 'untitled'
  const language = optionalString(params, 'language', 'params.language')
  const requestId = optionalString(params, 'requestId', 'params.requestId')
  if (requestId !== undefined && !/^[A-Za-z0-9._-]{1,128}$/.test(requestId)) {
    throw new InvalidParamsError('params.requestId must be 1-128 characters from A-Z a-z 0-9 . _ -')
  }
  const maxTokens = Math.max(64, Math.min(16_384, optionalNumber(params, 'maxTokens', 'params.maxTokens') ?? 4_096))

  const adapter = adapterFor(params, ctx)
  const controller = new AbortController()
  if (requestId !== undefined) {
    inFlightRuns.get(requestId)?.abort()
    inFlightRuns.set(requestId, controller)
  }
  const timer = setTimeout(() => controller.abort(), INLINE_EDIT_TIMEOUT_MS)
  timer.unref?.()
  const started = Date.now()
  try {
    const options: ChatCallOptions = { signal: controller.signal, maxTokens, temperature: 0.2 }
    const response = await adapter.chat(
      buildInlineEditMessages({ path, before, selection, after, instruction, ...(language !== undefined ? { language } : {}) }),
      // Wider than the contract's `{ signal }` on purpose; see `ChatCallOptions`.
      options as { signal?: AbortSignal },
    )
    const answeredModel = typeof response.model === 'string' && response.model.trim() !== '' ? response.model.trim() : null
    noteUsage(params, 'inline-edit', {
      provider: adapter.id,
      requestedModel: adapter.model ?? null,
      answeredModel: answeredModel !== null && answeredModel !== adapter.model ? answeredModel : null,
      usage: response.usage ?? null,
      usageEstimated: adapter.model === 'fake',
      ok: true,
      attempts: response.attempts,
      root: optionalString(params, 'root', 'params.root') ?? null,
    })
    return {
      text: cleanInlineEdit(response.text, { selection }),
      latencyMs: Date.now() - started,
      ...(response.usage !== undefined ? { usage: response.usage } : {}),
      ...(adapter.model !== undefined ? { model: adapter.model } : {}),
      ...(answeredModel !== null && answeredModel !== adapter.model ? { responseModel: answeredModel } : {}),
    }
  } catch (err) {
    if (controller.signal.aborted) return { text: '', cancelled: true, latencyMs: Date.now() - started }
    throw err
  } finally {
    clearTimeout(timer)
    if (requestId !== undefined && inFlightRuns.get(requestId) === controller) inFlightRuns.delete(requestId)
  }
}

/** Above this the file list is cut; a quick-open over more than this is a search problem. */
const PROJECT_FILES_MAX = 20_000

/**
 * Every indexable file in a project, project-relative with `/` separators.
 *
 * Powers Quick Open and the composer's `@` file mention. It uses the walker every
 * other engine path uses, so `.gitignore`, dependency folders and binary files are
 * excluded exactly as retrieval excludes them. Paths only; no content is read.
 */
async function projectFiles(params: Record<string, unknown>, _ctx: MethodContext): Promise<unknown> {
  const rootParam = optionalString(params, 'root', 'params.root')
  if (rootParam === undefined) throw new InvalidParamsError('params.root is required')
  const root = resolve(rootParam)
  const walk = await walkProjectDetailed(root, { maxFiles: PROJECT_FILES_MAX })
  const files = walk.files.map((file) => file.relativePath.split(pathSep).join('/')).sort((a, b) => a.localeCompare(b))
  return { root, files, truncated: walk.truncated, maxFiles: walk.maxFiles }
}

/**
 * The custom slash commands for a project: `<root>/.sketch/commands/*.md`, then
 * `~/.sketch/commands/*.md`. Read-only; the surface expands and sends them.
 */
async function commandsList(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const rootParam = optionalString(params, 'root', 'params.root')
  const home = optionalString(params, 'home', 'params.home') ?? homedir()
  const sources = [
    ...(rootParam !== undefined ? [{ dir: join(resolve(rootParam), '.sketch', 'commands'), scope: 'project' as const }] : []),
    { dir: join(resolve(home), '.sketch', 'commands'), scope: 'user' as const },
  ]
  const { commands, diagnostics } = await loadSlashCommands(sources)
  for (const diagnostic of diagnostics) ctx.log(`command diagnostic: ${diagnostic}`)
  return {
    commands: commands.map((command) => ({
      name: command.name,
      description: command.description,
      ...(command.argumentHint !== undefined ? { argumentHint: command.argumentHint } : {}),
      body: command.body,
      scope: command.scope,
      path: command.path,
    })),
    directories: sources.map((source) => source.dir),
    diagnostics,
  }
}

/**
 * The method table.
 *
 * The first five are Requirement 12.2, and none of them may leave. The `git-*`
 * group is task 3.3's Git panel: a UI capability that runs on the machine, so it
 * belongs to the engine and reaches the panel through `SketchClient` on both
 * transports rather than through a Tauri-only command.
 */
// ── the user's own MCP servers ──────────────────────────────────────────────
//
// Listing is free. Saving, removing and approving are user actions on the user's own
// files (`~/.sketch/mcp.json`, `<project>/.sketch/mcp.json`, `~/.sketch/mcp-trust.json`).
// `mcp-server-test` starts the server once to list its tools, then stops it. Runs start
// a server only when the window names it in `params.userMcpServers`.

function userServerOptions(params: Record<string, unknown>): { home?: string; root?: string } {
  const home = optionalString(params, 'home', 'params.home')
  const root = optionalString(params, 'root', 'params.root')
  return { ...(home !== undefined ? { home: resolve(home) } : {}), ...(root !== undefined ? { root: resolve(root) } : {}) }
}

/** The named servers a run may start: configured, startable, approved. Every refusal is logged. */
async function userServersForRun(root: string, params: Record<string, unknown>, ctx: MethodContext, names: readonly string[]): Promise<UserMcpServer[]> {
  if (names.length === 0) return []
  if (offlineFor(params, ctx).offline) {
    ctx.log(`mcp: not starting your servers (${names.join(', ')}) — Offline Mode is on, and Sketch cannot tell whether a program uses the network`)
    return []
  }
  const { servers } = await readUserServers({ ...userServerOptions(params), root })
  const out: UserMcpServer[] = []
  for (const name of names) {
    const server = servers.find((s) => s.name === name)
    if (server === undefined) ctx.log(`mcp: no server named "${name}" in your MCP settings`)
    else if (server.problems.length > 0) ctx.log(`mcp: not starting ${name} — ${server.problems.join('; ')}`)
    else if (!server.trusted) ctx.log(`mcp: not starting ${name} — this project's server has not been approved (MCP panel)`)
    else out.push(server)
  }
  return out
}

async function mcpServers(params: Record<string, unknown>): Promise<unknown> {
  return readUserServers(userServerOptions(params))
}

function serverScope(params: Record<string, unknown>): 'global' | 'project' {
  const scope = optionalString(params, 'scope', 'params.scope') ?? 'global'
  if (scope !== 'global' && scope !== 'project') throw new InvalidParamsError("params.scope must be 'global' or 'project'")
  if (scope === 'project' && optionalString(params, 'root', 'params.root') === undefined) {
    throw new InvalidParamsError('a project server needs params.root')
  }
  return scope
}

async function mcpServerSave(params: Record<string, unknown>): Promise<unknown> {
  const envValue = params['env']
  const env = envValue === undefined ? {} : asObject(envValue, 'params.env')
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') throw new InvalidParamsError(`params.env.${key} must be a string`)
  }
  try {
    const saved = await saveUserServer(userServerOptions(params), {
      scope: serverScope(params),
      name: readString(params, 'name', 'params.name').trim(),
      command: readString(params, 'command', 'params.command').trim(),
      args: optionalStringArray(params['args'], 'params.args') ?? [],
      env: env as Record<string, string>,
    })
    return { saved: saved.name, ...(await readUserServers(userServerOptions(params))) }
  } catch (err) {
    if (err instanceof InvalidParamsError) throw err
    throw new InvalidParamsError(messageOf(err))
  }
}

async function mcpServerRemove(params: Record<string, unknown>): Promise<unknown> {
  const removed = await removeUserServer(userServerOptions(params), serverScope(params), readString(params, 'name', 'params.name'))
  return { removed, ...(await readUserServers(userServerOptions(params))) }
}

async function findUserServer(params: Record<string, unknown>): Promise<UserMcpServer> {
  const name = readString(params, 'name', 'params.name')
  const { servers } = await readUserServers(userServerOptions(params))
  const server = servers.find((s) => s.name === name)
  if (server === undefined) throw new InvalidParamsError(`no MCP server named "${name}" in your settings`)
  return server
}

async function mcpServerTrust(params: Record<string, unknown>): Promise<unknown> {
  const server = await findUserServer(params)
  if (server.scope !== 'project') throw new InvalidParamsError(`"${server.name}" is in your own settings; only project servers need approval`)
  await setServerTrust(userServerOptions(params), server, params['trusted'] !== false)
  return readUserServers(userServerOptions(params))
}

async function mcpServerTest(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const server = await findUserServer(params)
  if (server.problems.length > 0) return { ok: false, name: server.name, detail: server.problems.join('; '), tools: [] }
  if (!server.trusted) return { ok: false, name: server.name, detail: 'Approve this project server before starting it.', tools: [] }
  assertOnlineAction(params, ctx, `stdio://${server.name}`, `starting the MCP server "${server.name}"`)
  const root = optionalString(params, 'root', 'params.root') ?? ctx.cwd()
  const timeoutMs = optionalNumber(params, 'timeoutMs', 'params.timeoutMs') ?? 60_000
  const instance = new McpServer(specFor(server, resolve(root), { handshakeTimeoutMs: timeoutMs, requestTimeoutMs: timeoutMs }), {
    log: (line) => ctx.log(line),
  })
  try {
    const started = await instance.start()
    return {
      ok: started.ok,
      name: server.name,
      detail: started.detail,
      tools: instance.tools.map((tool) => ({ name: tool.name, description: tool.description })),
    }
  } finally {
    await instance.close()
  }
}

// ── local models (Ollama) ───────────────────────────────────────────────────
//
// The model manager. Reading is free and touches only the Ollama server the user
// configured (this computer by default). Downloading and removing are user actions
// and need `confirmed: true` on the wire, the way `term-start` does: the window asks
// first and shows the size. Nothing here is used by runs, which reach models only
// through provider adapters.

function localBase(params: Record<string, unknown>, ctx: MethodContext): string {
  const base = ollamaBase(optionalString(params, 'baseUrl', 'params.baseUrl'))
  if (!/^https?:\/\/[^\s/]+/.test(base)) throw new InvalidParamsError('params.baseUrl must be an http:// or https:// address')
  assertReachable(base, offlineFor(params, ctx), 'Ollama')
  return base
}

function modelParam(params: Record<string, unknown>): string {
  const model = readString(params, 'model', 'params.model').trim()
  if (!isModelName(model)) throw new InvalidParamsError('params.model must be an Ollama model name such as qwen2.5-coder:7b')
  return model
}

function requireConfirmed(params: Record<string, unknown>, what: string): void {
  if (params['confirmed'] !== true) {
    throw new InvalidParamsError(`${what} needs confirmed: true — the user must agree first`)
  }
}

async function localModels(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const base = localBase(params, ctx)
  const [server, install, hardware] = await Promise.all([ollamaServer(base), findOllama(ctx.env), readHardware()])
  let models: LocalModel[] = []
  let error: string | undefined
  if (server.reachable) {
    try {
      models = await listLocalModels(base)
    } catch (err) {
      error = messageOf(err)
    }
  }
  return {
    server,
    install,
    models,
    ...(error !== undefined ? { error } : {}),
    hardware,
    recommendations: recommend(hardware, models.map((m) => m.name)),
  }
}

async function localModelPull(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const base = localBase(params, ctx)
  const model = modelParam(params)
  requireConfirmed(params, 'Downloading a model')
  // Ollama fetches the model from the internet itself, where this process's guard
  // cannot see it. Offline Mode therefore refuses the download outright.
  assertOnlineAction(params, ctx, 'https://registry.ollama.ai', `downloading ${model}`)
  return startPull(base, model)
}

async function localModelPullStatus(params: Record<string, unknown>): Promise<unknown> {
  const id = readString(params, 'id', 'params.id')
  const state = pullStatus(id)
  if (state === null) throw new InvalidParamsError(`no download with id ${JSON.stringify(id)}`)
  return state
}

async function localModelPullCancel(params: Record<string, unknown>): Promise<unknown> {
  const id = readString(params, 'id', 'params.id')
  return { id, cancelled: cancelPull(id) }
}

async function localModelDelete(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const base = localBase(params, ctx)
  const model = modelParam(params)
  requireConfirmed(params, 'Removing a model')
  await deleteLocalModel(base, model)
  return { ok: true, model }
}

async function localModelLoad(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const base = localBase(params, ctx)
  const model = modelParam(params)
  if (params['unload'] === true) await unloadLocalModel(base, model)
  else await loadLocalModel(base, model)
  return { ok: true, model, loaded: params['unload'] !== true }
}

// ── Offline Mode and the privacy view ───────────────────────────────────────
//
// `privacy-status` is read-only: the switch, where it is saved, whether this process's
// network guard is in place, and the requests this engine process made (origin and
// outcome only). `privacy-set` is the switch itself, a user action.

async function privacyStatus(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const state = offlineFor(params, ctx)
  const limit = optionalNumber(params, 'limit', 'params.limit') ?? 50
  const home = optionalString(params, 'home', 'params.home')
  const root = optionalString(params, 'root', 'params.root')
  return {
    offline: state.offline,
    source: state.source,
    file: state.file,
    ...(state.error !== undefined ? { error: state.error } : {}),
    guard: networkGuardInstalled(),
    activity: recentActivity(Math.min(200, Math.max(0, Math.floor(limit)))),
    storage: {
      user: join(resolve(home ?? homedir()), '.sketch'),
      ...(root !== undefined ? { project: join(resolve(root), '.sketch') } : {}),
    },
  }
}

async function privacySet(params: Record<string, unknown>, ctx: MethodContext): Promise<unknown> {
  const offline = params['offline']
  if (typeof offline !== 'boolean') throw new InvalidParamsError('params.offline must be true or false')
  const home = optionalString(params, 'home', 'params.home')
  await saveOfflineSetting(offline, { env: ctx.env, ...(home !== undefined ? { home: resolve(home) } : {}) })
  return privacyStatus(params, ctx)
}

export const METHODS: Readonly<Record<string, MethodHandler>> = {
  ping,
  run,
  // Offline Mode: the switch, and what this engine process sent where.
  'privacy-status': privacyStatus,
  'privacy-set': privacySet,
  // The user's own MCP servers: list, add, remove, approve (project files), test.
  'mcp-servers': mcpServers,
  'mcp-server-save': mcpServerSave,
  'mcp-server-remove': mcpServerRemove,
  'mcp-server-trust': mcpServerTrust,
  'mcp-server-test': mcpServerTest,
  // The local model manager (Ollama): list, download, remove, load and unload.
  'local-models': localModels,
  'local-model-pull': localModelPull,
  'local-model-pull-status': localModelPullStatus,
  'local-model-pull-cancel': localModelPullCancel,
  'local-model-delete': localModelDelete,
  'local-model-load': localModelLoad,
  // Stopping a run. `runTask` accepted an `AbortSignal` from the beginning and no wire
  // could produce one, so a runaway run could only be ended by killing the process.
  cancel,
  // Answering an `ask` mid-run. Only an interactive run waits; every other caller keeps
  // the original behaviour where a question ends the run.
  reply,
  eval: evalCases,
  'parse-skill': parseSkill,
  'capture-eval': captureEval,
  'git-status': gitStatus,
  'git-diff': gitDiff,
  'git-stage': gitStage,
  'git-unstage': gitUnstage,
  'git-commit': gitCommit,
  // Source control beyond stage/commit: discard, branches, sync, history, and an AI
  // commit message drafted from the staged diff (one model call, nothing committed).
  'git-discard': gitDiscard,
  'git-branches': gitBranches,
  'git-switch': gitSwitch,
  'git-push': gitPush,
  'git-pull': gitPull,
  'git-fetch': gitFetch,
  'git-log': gitLog,
  // The editor's change markers: a file as it is in HEAD. Read-only.
  'git-show': gitShow,
  'git-commit-message': gitCommitMessage,
  // Task 4.1's Provider Settings surface. Same reasoning as the git group: engine
  // capability, one implementation, reachable from both transports.
  'provider-catalog': providerCatalog,
  'provider-config-save': providerConfigSave,
  'provider-test': providerTest,
  // The setup wizard's model picker: what this provider actually serves.
  'provider-models': providerModels,
  // "Connect your account": the loopback listener of a desktop OAuth sign-in. It
  // reports a one-time code; it never sees or returns a credential.
  'oauth-start': oauthStart,
  'oauth-wait': oauthWait,
  'oauth-cancel': oauthCancel,
  // "Sign in with ChatGPT": the engine completes this sign-in and keeps the tokens;
  // the window learns only whether it worked and as whom.
  'chatgpt-status': chatgptStatusMethod,
  'chatgpt-login-start': chatgptLoginStart,
  'chatgpt-login-wait': chatgptLoginWait,
  'chatgpt-login-cancel': chatgptLoginCancel,
  'chatgpt-logout': chatgptLogoutMethod,
  'chatgpt-models': chatgptModels,
  // Undo an auto-applied run from its file-level snapshot. No Git required.
  'undo-run': undoRun,
  // The welcome screen's Clone Repository: one shell-less `git clone` into a new folder.
  'git-clone': gitClone,
  // The Code surface's terminal: the user's shell, streamed by polling, stoppable.
  // `term-start` refuses without `confirmed: true`, as the Tauri command did.
  'term-start': termStart,
  'term-read': termRead,
  'term-write': termWrite,
  'term-kill': termKill,
  // What changed on disk, by long poll: the window re-reads exactly those files and
  // folders, in real time, whoever changed them (another editor, git, a build).
  'fs-watch': fsWatch,
  // The Explorer's "Reveal in File Explorer / Finder" and "Open in External Terminal".
  'os-reveal': osReveal,
  'os-open-terminal': osOpenTerminal,
  // The Explorer's New File / New Folder / Rename / Delete. Contained by real path;
  // never overwrites; delete goes to the OS trash unless the user chose otherwise.
  'fs-create-file': fsCreateFile,
  'fs-create-folder': fsCreateFolder,
  'fs-rename': fsRename,
  'fs-delete': fsDelete,
  // Editor ghost text. Cancellable by `requestId` through `cancel`; logs nothing.
  complete,
  // Editor inline edit (Ctrl+K): the selection rewritten; the editor shows the diff.
  'inline-edit': inlineEdit,
  // Quick Open and `@` mentions: the walker's file list, paths only.
  'project-files': projectFiles,
  // Custom slash commands from `.sketch/commands/` and `~/.sketch/commands/`.
  'commands-list': commandsList,
  // Task 5.5's Live Architecture panel: the seven views derived from the persisted
  // graph, plus the optional rebuild that makes "index this project" actionable.
  architecture,
  // The Search panel, over the SAME lexical channel the retrieval stack uses. The
  // panel's own `git grep` + folder-walk implementation is deleted; one dialect now
  // serves both callers. Read-only, emits nothing, writes nothing.
  'project-search': projectSearchMethod,
  // The Search panel's editor-style Find in Files (literal or regex, globs) and
  // Replace, which writes through the snapshotting writer so `undo-run` reverses it.
  'find-in-files': findInFilesMethod,
  'replace-in-files': replaceInFilesMethod,
  // Task 6.4's Skills surface. `skill-install` verifies before it writes and has no
  // force parameter; `skill-train` is the only method here that can reach a provider
  // and is invoked by explicit user action only (Requirement 9.6).
  'skills-catalog': skillsCatalog,
  'skill-install': skillInstall,
  'skill-uninstall': skillUninstall,
  'skill-train': skillTrain,
  'skill-promote': skillPromote,
  // Task 7.3's curated MCP layer. READ-ONLY: this reports what the catalog offers and
  // what each entry is missing. Nothing here starts a server — that happens inside a
  // run, from `params.mcpServers`, and only for a capability the run's grant covers.
  'mcp-catalog': mcpCatalog,
  // Task 7.4's Test Results panel. Resolving the contract is free and is the default;
  // `run: true` executes the gauntlet and is a deliberate act, never a mount.
  verify,
  // Task 8.4's Cost Dashboard. Reads the log and sums it. No running total anywhere,
  // because two sources of a money number agree right up until they do not.
  cost,
  // Non-run model calls (completions, inline edits, commit messages, connection tests,
  // model listing) rolled up by cause from ~/.sketch/usage — visible where cost is shown.
  'cost-usage': costUsage,
  // Task 9.4's Memory panel. Reading is free; remembering and superseding are user
  // actions, and `memory-supersede` requires a reason on the wire — an entry cannot be
  // closed silently (Requirement 21.3).
  'memory-list': memoryList,
  'memory-search': memorySearch,
  'memory-remember': memoryRemember,
  'memory-supersede': memorySupersede,

  // Task 10.4's AI Team panel. READ-ONLY and it reports no live per-role status, because
  // roles exist only inside a dispatch — the same reason `mcp-catalog` reports `configured`
  // and never `connected`. A role's live state comes from `strategy_selected` events.
  'strategy-catalog': strategyCatalog,
  // Phase 11 Benchmarks panel. READ-ONLY: validates and returns the latest artifact;
  // it never runs a model, build, or test because a panel mounted.
  'benchmark-report': benchmarkReport,
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
