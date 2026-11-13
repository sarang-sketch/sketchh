// The client seam.
//
// Every call the UI makes into the engine goes through `SketchClient`. Three
// implementations live behind it — mock (this phase), stdio sidecar (task 2.1),
// http dev bridge (task 2.2) — and exactly one factory chooses between them
// (./factory.ts). No React component may import a concrete implementation.
//
// Validates: Requirements 13.1, 13.3

import type {
  ArchitectureDiagrams,
  BenchmarkReport,
  EvalCase,
  EvalResult,
  GitStatusResult,
  ProjectSearchResult,
  ProviderDescriptor,
  ProviderSettingsEntry,
  ProviderSettingsFile,
  ProviderTestResult,
  RunResult,
  SketchEvent,
  Task,
} from './contracts'

/** Which transport is live. Reported by `ping` so the UI can name it honestly. */
export type TransportKind = 'mock' | 'stdio' | 'http'

export interface PingResult {
  ok: boolean
  /** Engine version string as reported by the engine itself. */
  version: string
  transport: TransportKind
}

export type EventHandler = (event: SketchEvent) => void

/** Calling the returned function detaches the handler. Idempotent. */
export type Unsubscribe = () => void

/** What `providerCatalog` answers: the matrix, the saved file, and where it lives. */
export interface ProviderCatalogResult {
  catalog: ProviderDescriptor[]
  settings: ProviderSettingsFile
  /** Absolute path of `providers.json`, so the surface can name it. */
  path: string
  /** Set when the file could not be read, or carried something it should not. */
  diagnostic?: string
  /**
   * Providers whose key is already in the engine's environment, by variable NAME
   * (`{ openai: 'OPENAI_API_KEY' }`). Never a value.
   */
  envKeys?: Record<string, string>
}

/** One model a provider serves, with what it published about it. */
export interface ProviderModel {
  id: string
  name?: string
  contextLength?: number
  free?: boolean
  inputPerMillion?: number
  outputPerMillion?: number
}

export interface ProviderModelsResult {
  ok: boolean
  code: 'ok' | 'invalid-endpoint' | 'unreachable' | 'unauthorized' | 'endpoint-error' | 'timeout' | 'cancelled' | 'unlisted'
  message: string
  url: string
  models: ProviderModel[]
  status?: number
}

export interface OAuthStartResult {
  id: string
  /** The exact callback URL to hand the provider. */
  callbackUrl: string
  port: number
  expiresAt: number
}

export type OAuthWaitResult = { ok: true; code: string } | { ok: false; error: string }

// ── "Sign in with ChatGPT" ─────────────────────────────────────────────────
// The engine completes this sign-in and keeps the tokens; none of these shapes can
// carry one. The window learns whether it worked, as whom, and on which plan.

export interface ChatGPTStatus {
  signedIn: boolean
  /** Signed in before, but the sign-in has ended and must be repeated. */
  needsSignIn: boolean
  email?: string
  plan?: string
  /** Where the engine keeps the sign-in on this computer. */
  path: string
}

export type ChatGPTLoginStart =
  | { ok: true; mode: 'browser'; id: string; authUrl: string; port: number; expiresAt: number }
  | { ok: true; mode: 'device'; id: string; verificationUrl: string; userCode: string; expiresAt: number }
  | { ok: false; code: string; error: string }

export type ChatGPTLoginOutcome =
  | { ok: true; account: { email?: string; plan?: string } }
  | { ok: false; code: string; error: string }

export interface ChatGPTModelInfo {
  id: string
  name: string
  description?: string
  contextLength?: number
}

export interface ChatGPTModelsResult {
  ok: boolean
  /** `live` — asked of the account; `fallback` — the built-in verified list. */
  source: 'live' | 'fallback' | 'none'
  models: ChatGPTModelInfo[]
  defaultModel: string
  message: string
  code?: string
}

export interface UndoRunResult {
  runId: string
  found: boolean
  restored: string[]
  removed: string[]
  skipped: Array<{ path: string; reason: string }>
}

/** What the Search panel's Find in Files asks for (engine: `find-in-files`). */
export interface FindInFilesParams {
  root: string
  query: string
  isRegex?: boolean
  matchCase?: boolean
  wholeWord?: boolean
  /** Comma-separated globs, e.g. `src, *.ts`. Empty: every file. */
  include?: string
  exclude?: string
  /** With a replacement, each match carries what Replace would put there. */
  replacement?: string
  maxHits?: number
  /** A newer search with the same id stops the older one. */
  requestId?: string
}

export interface FindInFilesSpan {
  start: number
  length: number
  replacement?: string
}

export interface FindInFilesHit {
  /** 1-based. */
  line: number
  text: string
  /** Where `text` starts in the full line: the column is `textStart + start + 1`. */
  textStart: number
  spans: FindInFilesSpan[]
}

export interface FindInFilesResult {
  root: string
  query: string
  groups: Array<{ path: string; hits: FindInFilesHit[]; matches: number }>
  matchCount: number
  fileCount: number
  filesSearched: number
  truncated: boolean
  cancelled?: boolean
  skipped: { tooLarge: number; binary: number }
  durationMs: number
}

export interface ReplaceInFilesParams extends Omit<FindInFilesParams, 'replacement' | 'maxHits' | 'requestId'> {
  /** May be empty: the matches are deleted. */
  replacement: string
  /** Only these project-relative files. */
  paths?: string[]
  /** Only this one line, refused if it no longer reads as it did when found. */
  only?: { path: string; line: number; text: string; textStart: number }
}

export interface ReplaceInFilesResult {
  root: string
  files: Array<{ path: string; replaced: number }>
  replaced: number
  skipped: Array<{ path: string; reason: string }>
  /** Pass to `undoRun` to put every rewritten file back. Null when nothing changed. */
  snapshotId: string | null
}

/**
 * One connection test. `apiKey` is optional, present for this request only, and is
 * NOT part of anything that gets saved.
 */
export interface ProviderTestRequest {
  provider: {
    id: string
    kind: ProviderSettingsFile['providers'][number]['kind']
    baseUrl: string
    model: string
    apiKey?: string
  }
  timeoutMs?: number
}

/** What `architecture` answers: the seven views, plus where the graph was read from. */
export interface ArchitectureResult {
  /** The project the views were derived from, as the engine resolved it. */
  root: string
  /** `<root>/.sketch/index/graph.json`, so a surface with no graph can name it. */
  graphPath: string
  /** False when nothing readable was at `graphPath`; every view is then unavailable. */
  graphPresent: boolean
  /** Present only when this call was asked to index. Counts the work it did. */
  indexed?: {
    walked: number
    indexed: number
    added: number
    changed: number
    reused: number
    removed: number
    chunks: number
    truncated: boolean
  }
  diagrams: ArchitectureDiagrams
}

/** One pinned skill, as the catalog reports it. */
export interface SkillsCatalogEntry {
  name: string
  version: string
  pack: string
  summary: string
  /** `sha256:<hex>` over the skill directory. Shown before the user consents. */
  digest: string
  /** The GRANT the registry made. Enforced at execution time, not decorative. */
  capabilities: string[]
  source: string
  license: string
  /** How many files the digest covers. */
  files: number
  /** Read from disk, not from anything the UI remembers. */
  installed: boolean
}

/** One installed skill, as the loader read it back off disk. */
export interface InstalledSkill {
  name: string
  description: string
  source: string
  capabilities: string[]
}

export interface SkillsCatalogResult {
  root: string
  /** Where the pinned registry was read from, or null when none is configured. */
  registryDir: string | null
  /** `<root>/.sketch/skills`. */
  installedDir: string
  registry?: string
  /** `curated` until the open marketplace ships with a review queue (Req 11.6). */
  distribution?: 'curated' | 'open'
  entries: SkillsCatalogEntry[]
  installed: InstalledSkill[]
  /** Why the registry could not be read, when it could not. */
  diagnostic?: string
  /** One per skill on disk that failed to load. */
  diagnostics: string[]
}

/**
 * The Goldfish context for an EGM review, as built by the engine. `ok: false`
 * carries `error` instead: a missing target or a target outside the project
 * is not an empty context.
 */
export interface EgmGoldfishContextResult {
  ok: boolean
  /** Why the context could not be built, when it could not. */
  error?: string
  /** The document under review: project-relative path and content. */
  target?: { path: string; content: string }
  /** The linked files inside the project, target excluded, sorted by path. */
  files?: { path: string; content: string }[]
  /** Links left out, with the reason each was left out. */
  excluded?: { link: string; reason: 'anchor-only' | 'url' | 'outside-project' | 'missing' }[]
  /** Always 0: this context never carries chat history. */
  priorChatTurns?: 0
  /** What the reviewers were told they are: fresh eyes, no prior conversation. */
  note?: string
}

export interface SkillInstallResult {
  ok: boolean
  name: string
  dir?: string
  digest?: string
  granted?: string[]
  skill?: { name: string; description: string }
  /** Non-fatal findings the user should see. A grant mismatch shows up here. */
  warnings: string[]
  /** The refusal, naming the file that differs. Null on success. */
  reason: string | null
  files: number
}

/** One epoch of a training run, as the trainer recorded it. */
export interface SkillTrainEpoch {
  epoch: number
  verdict: 'accepted' | 'rejected' | 'no_proposal' | 'error'
  trainScore: number
  incumbentScore: number
  candidateScore: number | null
  bestScore: number
  reason: string
  candidateName?: string
  error?: string
}

export interface SkillTrainResult {
  ok: boolean
  name: string
  reason?: string
  /** True only when a candidate beat the incumbent on the held-out split. */
  improved?: boolean
  accepted?: number
  baselineValScore?: number
  valScore?: number
  cases?: number
  split?: { train: number; val: number }
  epochs?: SkillTrainEpoch[]
  /** What the run actually spent. `refusal` is set when the budget stopped it. */
  budget?: { calls: number; tokens: number; refusal: string | null }
  artifactPath?: string
  /** The winning body, so a surface can show it before writing anything. */
  body?: string
  /** How candidates were proposed: a whole new body, or SkillOpt's bounded edits. */
  mode?: 'rewrite' | 'edits'
  /** Edits mode only: edits the held-out gate rejected, one line each. */
  rejectedEdits?: string[]
}

/**
 * Result of removing an installed skill. Idempotent: `ok` is true even when there
 * was nothing to remove, and `removedDir`/`removedGrant` say what actually went.
 */
export interface SkillUninstallResult {
  ok: boolean
  name: string
  removedDir: boolean
  removedGrant: boolean
  /** The `.sketch/skills/<name>` directory the removal targeted. */
  dir: string
  /** Why it refused (an unsafe name only), or null. */
  reason: string | null
}

/** Result of explicitly activating a reviewed training candidate. */
export interface SkillPromoteResult {
  ok: boolean
  name: string
  path?: string
  digest?: string
  /** The persisted registry grant retained after promotion. */
  granted?: string[]
  reason: string | null
}

// ── the verification contract, as a surface sees it ─────────────────────────

/** The nine stages, fixed in contract order by Requirement 4.3. */
export type VerifyStageName =
  | 'format'
  | 'lint'
  | 'typecheck'
  | 'build'
  | 'unit'
  | 'integration'
  | 'security'
  | 'performance'
  | 'dependency-audit'

/**
 * `skipped` and `not-run` are DIFFERENT WORDS and stay different all the way here.
 *
 * Nothing ran in either case, but `skipped` means the project configures no command for
 * this stage and `not-run` means an earlier stage failed and the sequence stopped. One
 * grey badge for both hides which, and the two call for opposite responses: configure
 * something, or go fix the failure above.
 */
export type VerifyStageStatus = 'passed' | 'failed' | 'skipped' | 'not-run'

export interface VerifyCommandResult {
  name: string
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

export interface VerifyStageResult {
  stage: VerifyStageName
  status: VerifyStageStatus
  results: VerifyCommandResult[]
  durationMs: number
  /** Why it is skipped or not-run, in words. Null when it ran. */
  reason: string | null
}

/** One stage of the contract, whether or not this project configures it. */
export interface VerifyContractStage {
  stage: VerifyStageName
  configured: boolean
  /** The command lines this stage would run, as written. */
  commands: string[]
}

export interface VerifyPolicyResult {
  ok: boolean
  stages: VerifyStageResult[]
  failedStage: VerifyStageName | null
  ranStages: VerifyStageName[]
  /**
   * True when at least one command actually ran.
   *
   * `ok` is true for a project that configures nothing, and that must never read as
   * evidence that anything was verified.
   */
  verifiedAnything: boolean
  totalDurationMs: number
  /** The live application check's verdict, when the policy configured one. */
  live?: {
    verdict: 'passed' | 'failed-to-start' | 'runtime-error' | 'probe-failed' | 'skipped'
    detail: string
    heuristic?: boolean
    stdout?: string
    stderr?: string
  }
}

export interface VerifyContractResult {
  root: string
  /** `file` when a policy file was read, `detected` per stack, `none` when neither. */
  source: 'file' | 'detected' | 'none'
  /** The policy file, when one was read. */
  path?: string
  /** The detected stack, when detection ran. */
  language?: 'node' | 'python' | 'rust' | 'go' | 'unknown'
  /** Problems found reading a policy file. A malformed file is NOT silent. */
  diagnostics: string[]
  contract: VerifyContractStage[]
  /** Whether a live application check is folded into the `integration` stage. */
  live: boolean
  continueOnFailure: boolean
  ran: boolean
  result: VerifyPolicyResult | null
}

// ── the curated MCP catalog, as a surface sees it ───────────────────────────

export interface McpCatalogEntryStatus {
  id: string
  title: string
  summary: string
  /** The one capability every tool on this server costs. */
  requires: string
  /** The pinned argv, so a user can see exactly what would run. Never `@latest`. */
  command: string
  requiresEnv: string[]
  /** Of `requiresEnv`, what this environment does not have. */
  missingEnv: string[]
  /** Could start. NOT "is running": nothing runs between runs. */
  configured: boolean
  /** Why this server is riskier than its capability alone suggests. */
  caveat?: string
}

/** One MCP server from the user's own settings (`~/.sketch/mcp.json` or the project's). */
export interface UserMcpServerInfo {
  name: string
  /** `user-<slug>`: its tools are named `<id>.<tool>`. */
  id: string
  scope: 'global' | 'project'
  file: string
  command: string | null
  args: string[]
  env: Record<string, string>
  url: string | null
  /** Why it cannot start; empty when it can. */
  problems: string[]
  /** Global servers always; a project server once the user approved this exact launch. */
  trusted: boolean
  fingerprint: string
}

export interface UserMcpServersResult {
  servers: UserMcpServerInfo[]
  files: { global: string; project?: string; trust: string }
  diagnostics: string[]
}

export interface UserMcpTestResult {
  ok: boolean
  name: string
  detail: string
  tools: Array<{ name: string; description: string }>
}

// ── hooks (`.sketch/hooks.json`) ─────────────────────────────────────────────
// Same vocabulary as the engine (`packages/core/src/hooks/`): SessionStart runs
// when a run starts, PreToolUse can deny a tool call, PostToolUse runs after
// one, Stop runs when a run ends. Hooks run locally as argv, never a shell
// string, and a run loads them only when it opted in (`hooksEnabled`).

export type HookEventName = 'SessionStart' | 'PreToolUse' | 'PostToolUse' | 'Stop'

export interface HookListItem {
  name: string
  event: HookEventName
  matcher?: string
  command: string[]
  timeoutMs?: number
  blocking?: boolean
}

export interface HooksListResult {
  ok: boolean
  file: string
  present: boolean
  hooks: HookListItem[]
  problems: string[]
}

export interface HooksSaveResult {
  ok: boolean
  file: string
  hooks: Array<{ name: string; event: HookEventName; command: string[] }>
  problems: string[]
}

export interface HookTestOutcome {
  hook: string
  ok: boolean
  allowed: boolean
  reason?: string
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

export interface HooksTestResult {
  ok: true
  event: HookEventName
  tool?: string
  outcomes: HookTestOutcome[]
  matched: string[]
  problems: string[]
}

/** One installed Ollama model, as `local-models` reports it. */
export interface LocalModelInfo {
  name: string
  /** Bytes on disk. */
  size: number
  modifiedAt?: string
  family?: string
  parameterSize?: string
  quantization?: string
  /** What Ollama says it can do (`completion`, `tools`, `vision`, `embedding`...); null when it did not say. */
  capabilities: string[] | null
  contextLength: number | null
  loaded: boolean
  vram?: number
  expiresAt?: string
}

export interface LocalModelSuggestion {
  name: string
  size: number
  contextTokens: number
  purpose: 'coding' | 'embedding'
  note: string
  fit: 'fits' | 'tight' | 'too-big'
  memoryNeeded: number
  installed: boolean
  best: boolean
}

/** `local-models`: the Ollama server, the program, the machine, and what fits it. */
export interface LocalModelsResult {
  server: { baseUrl: string; reachable: boolean; version?: string; error?: string }
  install: { found: boolean; version?: string; path?: string }
  models: LocalModelInfo[]
  error?: string
  hardware: {
    totalMemory: number
    freeMemory: number
    cpuCount: number
    platform: string
    gpus: Array<{ name: string; memoryTotal: number; memoryUsed: number }>
  }
  recommendations: LocalModelSuggestion[]
}

/** A model download, polled with `local-model-pull-status`. */
export interface LocalModelPull {
  id: string
  model: string
  state: 'running' | 'done' | 'failed' | 'cancelled'
  status: string
  completed: number
  total: number
  error?: string
  startedAt: number
  endedAt?: number
}

/** One request the engine process made: origin and outcome only, never a path or query. */
export interface NetworkActivityEntry {
  at: number
  method: string
  origin: string
  local: boolean
  outcome: 'sent' | 'blocked' | 'failed'
  status?: number
}

/** `privacy-status` / `privacy-set`. */
export interface PrivacyStatus {
  offline: boolean
  /** What decided it: SKETCH_OFFLINE in the engine's environment, the saved setting, or the default. */
  source: 'environment' | 'setting' | 'default'
  /** The settings file. */
  file: string
  /** The file exists but could not be read; Offline Mode is then on. */
  error?: string
  /** Whether the engine's request guard is in place in this process. */
  guard: boolean
  /** Newest first. */
  activity: NetworkActivityEntry[]
  /** Where Sketch keeps its own data. */
  storage: { user: string; project?: string }
}

export interface McpCatalogResult {
  servers: McpCatalogEntryStatus[]
  total: number
  configured: number
  note: string
}

// ── the strategies and the thirteen roles, as a surface sees it ─────────────

export interface StrategyOption {
  strategy: string
  description: string
  default: boolean
}

/**
 * One role, and whether THIS project can check it.
 *
 * There is deliberately no `status` field. Roles exist only inside a dispatch, so between
 * dispatches there is no such thing as a working role — the same reason `McpCatalogResult`
 * reports `configured` and never `connected`. Live per-role state is read out of the
 * `strategy_selected` events on the timeline.
 */
export interface RoleStatus {
  role: string
  title: string
  instruction: string
  /** What grades this role's work, in words. */
  signal: string
  signalKind: 'verify-stage' | 'plan-artifact' | 'citations'
  /** The stage, when the signal is one. */
  stage?: string
  capabilities: string[]
  /** True when this role proposes file edits. */
  edits: boolean
  /** True when this role's findings can stop a swarm. Security and Reviewer only. */
  blocking: boolean
  /** False when this project configures no stage that could grade it. */
  available: boolean
  /** Why it would be skipped. Null when it can run. */
  reason: string | null
}

export interface StrategyCatalogResult {
  root: string
  strategies: StrategyOption[]
  defaultStrategy: string
  /** The order roles run in a swarm; blocking roles last. */
  swarmOrder: string[]
  roles: RoleStatus[]
  configuredStages: string[]
  policySource: string
  verifiableRoles: number
  /** Requirement 24.8: off until measured pass@k lift says otherwise. */
  swarmDefault: { enable: boolean; reason: string }
  note: string
}

// ── cost, as a surface sees it ──────────────────────────────────────────────

/** One priced model call. Carries `eventId` so a total can be audited row by row. */
export interface CostEntry {
  runId: string
  eventId: string
  ts: number
  iteration: number | null
  model: string | null
  provider: string | null
  usage: { in: number; out: number }
  /** USD, or NULL when this model is not in the price table. Never 0 for unknown. */
  usd: number | null
  matched: string | null
  local: boolean
}

export interface CostTotals {
  /** USD over the calls that could be priced. Excludes unpriced calls entirely. */
  usd: number
  tokensIn: number
  tokensOut: number
  calls: number
  /** Calls whose model is not in the price table. `usd` is a lower bound while > 0. */
  unpriced: number
  cacheHits: number
  /** What the cache avoided. Reported separately: a saving is not a negative expense. */
  savedUsd: number
  /** True when every priced call was a local model, so the zero is real. */
  allLocal: boolean
}

export interface CostRunSummary {
  runId: string
  usd: number
  tokensIn: number
  tokensOut: number
  calls: number
  unpriced: number
  cacheHits: number
  allLocal: boolean
  startedAt: number | null
}

export interface CostReport {
  root: string
  runId?: string
  /** Log lines that could not be parsed. Shown, never absorbed. */
  skipped: number
  total: CostTotals
  /** The pricing table's date. A surface must never show money without it. */
  pricedAt: string
  stale: boolean
  /** The engine's own wording, so the UI does not invent a second way to say unknown. */
  summary: string
  runs: CostRunSummary[]
  entries: CostEntry[]
}

/** One cause's rollup of model calls NOT tied to a message. */
export interface UsageCauseSummary {
  cause: 'completion' | 'inline-edit' | 'commit-message' | 'connection-test' | 'model-list'
  calls: number
  tokensIn: number
  tokensOut: number
  /** Calls whose tokens the provider did not report — shown as unknown, never 0. */
  usageUnknown: number
  usageEstimated: number
  failed: number
}

/** Model calls not tied to a message, rolled up by cause (from ~/.sketch/usage). */
export interface UsageSummary {
  total: { calls: number; tokensIn: number; tokensOut: number; usageUnknown: number; usageEstimated: number; failed: number }
  byCause: UsageCauseSummary[]
  skipped: number
}

export interface BenchmarkReportResult {
  root: string
  /** The validated artifact path, or null when no report exists yet. */
  path: string | null
  report: BenchmarkReport | null
  note: string
}

// ── memory, as a surface sees it ────────────────────────────────────────────

/** The nine kinds Requirement 21.1 names. */
export type MemoryKindName =
  | 'decision'
  | 'architecture'
  | 'conversation'
  | 'standard'
  | 'preference'
  | 'style'
  | 'bug'
  | 'performance'
  | 'test'

/** One remembered row, with the window in which it was true. */
export interface MemoryEntryRow {
  id: string
  kind: MemoryKindName
  text: string
  key?: string
  subject?: string
  tags?: string[]
  /** Epoch ms. When this became true. */
  validFrom: number
  /** When it stopped being true, or null while it still is. */
  validTo: number | null
  supersededBy?: string
  supersedes?: string
  /** Why it was closed. Always present on a closed row (Requirement 21.3). */
  reason?: string
  runId?: string
  source: 'user' | 'run' | 'imported'
  data?: Record<string, unknown>
  /** Whether the window is still open. Computed by the engine, not the panel. */
  current: boolean
  /** The window in words, so the panel does not format dates a second way. */
  window: string
}

/** A suspected problem. REPORTED ONLY — the lint pass supersedes nothing. */
export interface MemoryFinding {
  kind: 'contradiction' | 'duplicate' | 'orphan' | 'unreasoned'
  /** How strong the signal is. Never a verdict. */
  confidence: 'certain' | 'likely' | 'possible'
  detail: string
  suggestion: string
  ids: string[]
}

export interface MemoryKindSummary {
  kind: MemoryKindName
  description: string
  total: number
  current: number
}

export interface MemoryListResult {
  root: string
  /** Lines that could not be parsed. Shown, never absorbed. */
  skipped: number
  kinds: MemoryKindSummary[]
  total: number
  current: number
  /** Newest first, INCLUDING closed rows — a history you cannot see you cannot correct. */
  entries: MemoryEntryRow[]
  findings: MemoryFinding[]
}

export interface MemorySearchHit {
  entry: MemoryEntryRow
  score: number
  relevance: number
  /** The recency multiplier applied. A bounded prior, not a sort. */
  recency: number
  termsMatched: number
  channels: Array<'text' | 'metadata'>
  current: boolean
  window: string
}

export interface MemorySearchResult {
  root: string
  query: string
  /** What the query was reduced to, so a surface can explain a miss. */
  terms: string[]
  candidates: number
  /** Retracted entries left out. Excluded by default (Requirement 21.6). */
  supersededExcluded: number
  channels: Array<{ channel: 'text' | 'metadata'; ran: boolean; hits: number; reason: string | null }>
  hits: MemorySearchHit[]
}

export interface MemoryRememberResult {
  root: string
  entry: MemoryEntryRow
  /** The predecessor that was closed, when one was. */
  superseded: MemoryEntryRow | null
}

export interface MemorySupersedeResult {
  root: string
  ok: boolean
  closed: MemoryEntryRow | null
  replacement: MemoryEntryRow | null
  /** Why it refused, when it did. */
  reason: string | null
}

/** What the engine did with an answer to a mid-run question. */
export interface ReplyResult {
  runId: string
  /** True only when a run was waiting and this answer was delivered to it. */
  answered: boolean
  detail?: string
  /** The question the answer was matched to, when there was one. */
  question?: string
}

/** What the engine did about a stop request. */
export interface CancelResult {
  runId: string
  /** True only when a run was in flight and has been asked to abort. */
  cancelled: boolean
  /** Plain words, safe to show. */
  detail: string
}

export interface RunOptions {
  /**
   * Exact key-free provider entry selected from persisted settings for this run.
   * Omitted means no provider was selected; the engine refuses unless its explicit
   * offline fake switch is enabled. This type cannot carry an API key.
   */
  provider?: ProviderSettingsEntry
  /**
   * The provider credential for THIS CALL ONLY, resolved from the OS credential store
   * at invocation time (Requirement 17.4).
   *
   * Deliberately a separate field rather than a key on `provider`: that entry is the
   * persisted, key-free settings row and must stay incapable of carrying a secret. The
   * transports merge this onto the outgoing provider object and nowhere else, and the
   * engine registers it with its redactor the moment it parses it, so it cannot reach an
   * event log. Never read this back out of state — see `lib/secrets.ts`.
   */
  apiKey?: string
  /**
   * The id this run will be logged and cancelled under.
   *
   * Supplying it is what makes a Stop control possible from the first moment: a caller
   * that waits for `run_started` to learn the id cannot cancel during the window in which
   * a misfired run most wants stopping. The engine refuses an id already in flight, so
   * generate a fresh one per run.
   */
  runId?: string
  /** Project root for this run. Required by the desktop to match the open folder. */
  root?: string
  /** Leave emitted patches open for human hunk review instead of auto-applying. */
  reviewEdits?: boolean
  /**
   * Let a question pause this run instead of ending it.
   *
   * OMITTED means the original behaviour: an `ask` ends the run with the question as its
   * final text. A surface that sets this MUST be able to show the question and call
   * `reply`, otherwise the run just waits until it times out.
   */
  interactive?: boolean
  /**
   * Write what this run established into the project's memory when it finishes.
   *
   * OMITTED means nothing is written, which is the engine's default: a run must not have a
   * side effect on somebody's repository unless the caller asked for it. The desktop asks,
   * because a project that only remembers what a human typed into a panel does not
   * compound.
   */
  rememberRun?: boolean
  /**
   * Which strategy to run under. OMITTED is the single-agent path, unchanged.
   *
   * Naming one — including `single` — opts into the dispatcher and its ladder record.
   * `swarm` is as many runs as there are verifiable roles, so as many bills; it is never
   * chosen for the user (Requirement 24.1).
   */
  strategy?: 'single' | 'plan-then-code' | 'swarm'
  /**
   * Allow escalation to a heavier strategy when the lighter one fails WITHIN its budget.
   *
   * A budget breach, an abort, or a provider error never escalates: the attempt never got
   * its budget, and escalating would turn one ceiling into several bills.
   */
  escalate?: boolean
  /**
   * Tokens of retrieved repository context to assemble for this run.
   *
   * OMITTED means no retrieval: the engine keeps its opt-in default, and the model is
   * sent the prompt with no repository evidence. The desktop supplies a value from
   * `DESKTOP_RUN_DEFAULTS` so that a normal run is not blind to the open project.
   */
  contextBudgetTokens?: number
  /**
   * The spend ceiling enforced before every model call in this run.
   *
   * OMITTED means unbounded, which is the engine's deliberate default. `onBreach` is
   * required with any ceiling: the guard has to know what to do when it fires.
   */
  budget?: {
    maxTokens?: number
    maxUsd?: number
    maxCalls?: number
    onBreach: 'stop' | 'downgrade'
  }
  /**
   * Give the run the read-only project tools (`read_file`, `list_dir`, `find_files`,
   * `search_code`). Each costs `fs:read:project`, which the default grant holds.
   */
  projectTools?: boolean
  /** Build or refresh the repository index before retrieval, so a new project is not blind. */
  autoIndex?: boolean
  /** Model turns allowed for this run. */
  maxIterations?: number
  /**
   * Resolve the project's own verification contract (`verify.yaml`, or detected from
   * package.json / pyproject / Cargo / go.mod) so "done" means the project's checks
   * passed. This RUNS the project's scripts, so it is a user preference.
   */
  verifyPolicy?: boolean
  /** Earlier turns of this conversation, oldest first. The engine keeps the newest few. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  /** Ask mode: the engine refuses every edit, and no command tool is offered. */
  readOnly?: boolean
  /**
   * Give the run `run_command`. `ask` puts every command to the user (the run must be
   * `interactive`); `auto` runs ordinary commands and asks only for destructive ones.
   */
  commands?: 'ask' | 'auto'
  /** Auto mode: the model's questions are answered with "use your judgement". */
  autonomous?: boolean
  /** List the project's installed skills to the model and let it load one on demand. */
  autoSkills?: boolean
  /** The user's own MCP servers this run may start, by name (MCP panel → "Use in chats"). */
  userMcpServers?: string[]
  /**
   * Load `.sketch/hooks.json` for this run. Off unless the user enabled hooks
   * through the Hooks panel — a hooks file names programs the engine runs as
   * the user, so a run never loads it unasked.
   */
  hooksEnabled?: boolean
}

/** One inline completion. `text` is empty when there is nothing to suggest. */
export interface CompletionResult {
  text: string
  latencyMs?: number
  usage?: { in: number; out: number }
  model?: string
  /** Set when the engine's per-minute ceiling paused suggestions. */
  throttled?: boolean
  cancelled?: boolean
}

/** One inline edit (Ctrl+K): the code that replaces the selection. Empty when the model gave nothing usable. */
export interface InlineEditResult {
  text: string
  latencyMs?: number
  usage?: { in: number; out: number }
  model?: string
  cancelled?: boolean
}

export interface ProjectFilesResult {
  root: string
  /** Project-relative, `/`-separated, sorted. `.gitignore` applied. */
  files: string[]
  truncated: boolean
  maxFiles: number
}

/** A custom slash command from `.sketch/commands/` or `~/.sketch/commands/`. */
export interface SlashCommandEntry {
  name: string
  description: string
  argumentHint?: string
  body: string
  scope: 'project' | 'user'
  path: string
}

export interface CommandsListResult {
  commands: SlashCommandEntry[]
  directories: string[]
  diagnostics: string[]
}

/** A fresh id for one completion request, so it can be cancelled by name. */
/** What `term-start` did: started a process, or moved the terminal with `cd`. */
export type TerminalStartResult =
  | { kind: 'run'; id: string; cwd: string; shellName: string }
  | { kind: 'cd'; cwd: string }

export interface TerminalChunk {
  seq: number
  stream: 'stdout' | 'stderr'
  text: string
}

export interface TerminalReadResult {
  id: string
  chunks: TerminalChunk[]
  next: number
  running: boolean
  exitCode: number | null
  signal: string | null
  error: string | null
  truncated: boolean
  durationMs: number
}

export interface GitBranchesResult {
  current: string | null
  branches: Array<{ name: string; current: boolean; upstream: string | null }>
}

/** One answer from the project watcher (`fs-watch`). See core tools/watcher.ts. */
export interface FsWatchBatch {
  /** Pass as `since` next time. */
  cursor: number
  /** Absolute paths that changed. */
  paths: string[]
  /** Too many (or unnamed) changes to list: re-read everything. */
  overflow: boolean
  /** HEAD, the index or a branch changed. */
  git: boolean
  /** False: this folder cannot be watched; fall back to focus and command triggers. */
  watching: boolean
  degraded: boolean
  error: string | null
}

export interface GitCommitSummary {
  hash: string
  author: string
  /** Relative, as git says it: "3 hours ago". */
  when: string
  subject: string
}

/** `deleted: false` with `trashUnavailable` means NOTHING was deleted. */
export interface FsDeleteResult {
  deleted: boolean
  path?: string
  trashed?: boolean
  trashUnavailable?: boolean
  message?: string
}

export function completionRequestId(): string {
  const webcrypto = globalThis.crypto as { randomUUID?: () => string } | undefined
  const unique =
    typeof webcrypto?.randomUUID === 'function'
      ? webcrypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `complete-${unique}`
}

export interface SketchClient {
  /** Which implementation this is. Surfaced in the UI; never branched on by panels. */
  readonly transport: TransportKind

  /** Liveness check against the engine. Must succeed offline with no API key. */
  ping(): Promise<PingResult>

  /**
   * Run a task to completion.
   *
   * `run` is long-lived: it resolves only when the run finishes. Progress is not
   * carried by the promise — it arrives on `subscribe` as the run proceeds, which
   * is what lets the Timeline fill in live instead of blinking into existence at
   * completion. The resolved `RunResult.events` is the same sequence, replayed,
   * so a caller that never subscribed still gets the whole log.
   */
  run(task: Task, options?: RunOptions): Promise<RunResult>

  /**
   * Answer a question an interactive run is waiting on.
   *
   * `answered: false` means that run is not waiting for anything — a stale reply, a wrong
   * id, or a question that already timed out. Only runs started with `interactive: true`
   * ever wait; for every other run an `ask` still ends it.
   */
  reply(runId: string, answer: string): Promise<ReplyResult>

  /**
   * Ask the engine to stop an in-flight run.
   *
   * `cancelled: false` means no run is in flight under that id — already finished, never
   * started, and unknown id are deliberately the same answer, because the only thing a
   * surface can act on is whether a run is still going.
   *
   * This does not resolve the `run` promise: the run observes the abort and ends itself
   * with `run_failed{reason:"aborted"}`, so the terminal event has one author.
   */
  cancel(runId: string): Promise<CancelResult>

  /** Score eval cases through the harness. */
  eval(cases: EvalCase[]): Promise<EvalResult[]>

  /** Capture run as eval case. */
  captureEval?(params: { run: Partial<RunResult>; want?: { checks?: unknown[] }; evalsPath?: string }): Promise<EvalCase>

  // ── git ───────────────────────────────────────────────────────────────────
  //
  // Source control is an ENGINE capability on this seam, not a Tauri command, for
  // two reasons: the porcelain parser that understands renames, quoted paths, a
  // detached HEAD and "not a repository" lives in packages/core/src/tools/git.ts
  // and is not duplicated; and a capability on the seam works under the browser
  // dev bridge as well as in the app (Requirement 13.3).
  //
  // Every call names its repository. There is no implicit "current project" on the
  // wire — the engine refuses a git call with no root rather than falling back to
  // the server's cwd, which would let a mutation land in the wrong repository.
  // Each mutation resolves to a FRESH status, so a caller cannot render a stale
  // list after a successful stage or commit.

  gitStatus(params: { root: string }): Promise<GitStatusResult>
  /** A unified diff. `staged` compares the index against HEAD. */
  gitDiff(params: { root: string; path?: string; staged?: boolean }): Promise<string>
  gitStage(params: { root: string; paths: string[] }): Promise<GitStatusResult>
  gitUnstage(params: { root: string; paths: string[] }): Promise<GitStatusResult>
  gitCommit(params: {
    root: string
    message: string
  }): Promise<{ output: string; status: GitStatusResult }>

  /** Start tracking the folder: `git init`. Returns the fresh status. */
  gitInit?(params: { root: string }): Promise<GitStatusResult>

  /** Throw away working-tree edits to tracked files. Staged changes are kept. */
  gitDiscard?(params: { root: string; paths: string[] }): Promise<GitStatusResult>
  gitBranches?(params: { root: string }): Promise<GitBranchesResult>
  /** Switch branch, or `create` one from HEAD and switch to it. */
  gitSwitch?(params: { root: string; branch: string; create?: boolean }): Promise<GitStatusResult>
  /** Push the current branch; a branch with no upstream is published to origin. */
  gitPush?(params: { root: string }): Promise<{ output: string; status: GitStatusResult }>
  /** Pull, fast-forward only. */
  gitPull?(params: { root: string }): Promise<{ output: string; status: GitStatusResult }>
  gitFetch?(params: { root: string }): Promise<GitStatusResult>
  gitLog?(params: { root: string; limit?: number }): Promise<{ commits: GitCommitSummary[] }>
  /**
   * A file as it is in HEAD (the default) or in the index (`ref: 'index'`), for the
   * editor's change markers and the diff view. Null: nothing to compare with.
   */
  gitShow?(params: { root: string; path: string; ref?: 'HEAD' | 'index' }): Promise<{ content: string | null }>
  /**
   * A commit message for the staged changes (or, with nothing staged, the working-tree
   * changes), drafted by the connected model. One model call; nothing is committed.
   */
  gitCommitMessage?(params: {
    root: string
    provider: ProviderSettingsEntry
    apiKey?: string
  }): Promise<{ message: string; source: 'staged' | 'unstaged'; model?: string }>

  // ── provider settings ─────────────────────────────────────────────────────
  //
  // Same reasoning as git: the provider catalog and the key-free serializer live in
  // the engine (packages/core/src/settings/) and are reached over this seam, so the
  // panel is real under the dev bridge as well as in the app.
  //
  // NO KEY IS EVER SAVED. `providerCatalog` and `saveProviderSettings` deal only in
  // the five non-secret fields of `~/.sketch/providers.json`; `testProvider` takes a
  // key for the duration of one call and the engine scrubs it from every frame
  // (Requirements 17.2, 17.4).

  /** The full provider matrix, plus whatever is configured on disk. */
  providerCatalog(): Promise<ProviderCatalogResult>

  /** Persist key-free configuration. Resolves with what was actually written. */
  saveProviderSettings(params: {
    settings: ProviderSettingsFile
  }): Promise<{ settings: ProviderSettingsFile; path: string }>

  /**
   * Test one provider. A REAL NETWORK CALL, so it is only ever made because a user
   * asked for it — never on mount. `signal` cancels the wait; see the note in
   * stdioClient about what cancellation can and cannot reach.
   */
  testProvider(
    params: ProviderTestRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ProviderTestResult>

  // ── architecture ──────────────────────────────────────────────────────────
  //
  // Same reasoning as git and provider settings: the generator reads the persisted
  // graph and the bytes of the files it lists, so it is engine work reached over
  // this seam rather than duplicated in the UI. No network is involved on either
  // side of the call (Requirement 19.5).
  //
  // OPTIONAL, like `captureEval`, because a transport is allowed not to have an
  // engine behind it. The Live Architecture panel says which transport it is talking
  // to when the method is missing instead of drawing seven empty boxes.

  /**
   * Derive the seven views. `index` rebuilds `.sketch/index/graph.json` first —
   * explicit, because it walks the project, and it is what makes the panel's
   * "index this project" offer actionable.
   */
  architecture?(params: {
    root: string
    index?: boolean
    maxNodes?: number
    maxEdges?: number
  }): Promise<ArchitectureResult>

  // ── project search ────────────────────────────────────────────────────────
  //
  // The Search panel calls THIS, and there is nothing behind it in the desktop
  // package. It used to have its own retriever — `git grep` through the Tauri
  // command policy with a folder walk behind it — and the engine had its lexical
  // channel, so the same query could highlight one thing in the panel and score
  // another in retrieval. One dialect now serves both callers
  // (packages/core/src/context/hybrid-search.ts, `matchSpans`).
  //
  // The engine spawns ripgrep through its own verify runner, which is why this did
  // not require adding `rg` to the Rust `command_policy` allowlist. `engine` says
  // which implementation answered — `ripgrep` or `scanner` — and `truncated` says a
  // cap stopped the search, because "nothing was found" and "we stopped looking" are
  // different answers (Requirement 27.5).

  /** Search a project's indexed text. Read-only: emits nothing, writes nothing. */
  projectSearch?(params: {
    root: string
    query: string
    /** Case-sensitive. Omitted keeps the engine's per-term smart case. */
    matchCase?: boolean
    /** Keep only identifier-boundary occurrences. */
    wholeWord?: boolean
    maxHits?: number
  }): Promise<ProjectSearchResult>

  /** Editor-style Find in Files: exactly what was typed, or a regular expression. Read-only. */
  findInFiles?(params: FindInFilesParams): Promise<FindInFilesResult>

  /** Replace what Find in Files shows. Contained, snapshotted: `undoRun(snapshotId)` reverses it. */
  replaceInFiles?(params: ReplaceInFilesParams): Promise<ReplaceInFilesResult>

  // ── skills ────────────────────────────────────────────────────────────────
  //
  // Hashing a directory, writing into `.sketch/skills/`, and scoring an eval set are
  // machine work, so all three live in the engine and reach the panel over this
  // seam. Optional for the same reason as the two above.
  //
  // THERE IS NO `force` ON `skillInstall`, here or on the wire. The install verifies
  // the pinned content hash first and refuses on any difference; an option to skip
  // that check is the same thing as not having it.

  /** The pinned registry, plus what is installed in this project. Reads only. */
  skillsCatalog?(params: { root: string; registryDir?: string }): Promise<SkillsCatalogResult>

  /**
   * The Goldfish context for an EGM review: the target document plus the files
   * it links to inside the project — and nothing else. Read-only. The panel
   * shows this before a review runs, so the user can see what the reviewers
   * will see and that `priorChatTurns` is 0.
   */
  egmGoldfishContext?(params: {
    root: string
    target: string
    extraContext?: string[]
  }): Promise<EgmGoldfishContextResult>

  /** Verify and install one pinned skill. Refuses on a hash mismatch. */
  skillInstall?(params: {
    root: string
    name: string
    registryDir?: string
  }): Promise<SkillInstallResult>

  /**
   * Remove one installed skill: its directory under `.sketch/skills/<name>` and its
   * persisted capability grant. Confined to the project's skills folder, idempotent,
   * and the returned `removedDir`/`removedGrant` say what was actually removed.
   */
  skillUninstall?(params: { root: string; name: string }): Promise<SkillUninstallResult>

  /**
   * Train one installed skill on this project's captured evals.
   *
   * THE ONLY CAPABILITY ON THIS SEAM THAT CAN REACH A PROVIDER, and therefore the
   * only one that can cost money. Explicit user action only, never on mount, never
   * during a task run (Requirement 9.6). `write` is opt-in: a training run the user
   * has not looked at must not silently replace the skill they installed.
   */
  skillTrain?(
    params: {
      root: string
      name: string
      epochs?: number
      guidance?: string
      write?: boolean
      maxCalls?: number
      maxTokens?: number
      /** 'edits' trains with SkillOpt's bounded edits; 'rewrite' proposes whole bodies. */
      mode?: 'rewrite' | 'edits'
      maxEdits?: number
    },
    options?: { signal?: AbortSignal },
  ): Promise<SkillTrainResult>

  /** Activate a reviewed, measured training artifact. Never called by training itself. */
  skillPromote?(params: { root: string; name: string }): Promise<SkillPromoteResult>

  // ── verification contract ─────────────────────────────────────────────────
  //
  // The nine stages, `verify.yaml` parsing, per-stack detection, and the runner all
  // live in packages/core/src/verify/. Same seam reasoning as git and skills: one
  // implementation, reachable under the dev bridge as well as in the app.
  //
  // RESOLVING IS FREE AND IS THE DEFAULT. `run: true` executes the project's whole
  // gauntlet, which for most projects means a build and a test suite, and for a policy
  // with a `live` check means binding a port. That cannot happen because a panel
  // mounted, so the Test Results panel resolves on mount and runs only when a user
  // presses the button.

  /**
   * The verification contract for a project, and optionally its results.
   *
   * `contract` is always all nine stages in contract order, including the ones this
   * project does not configure — "lint is not set up here" is information, and a panel
   * that lists only what exists cannot say it.
   */
  verify?(
    params: { root: string; run?: boolean; continueOnFailure?: boolean; runId?: string },
    options?: { signal?: AbortSignal },
  ): Promise<VerifyContractResult>

  // ── MCP ───────────────────────────────────────────────────────────────────
  //
  // READ-ONLY, and it reports `configured`, never `connected`. MCP servers are started
  // per run, by a run that asked for them, and only when the run's grant covers the
  // capability they cost — the unavailability latch is per-run by definition. So there
  // is nothing to be connected to between runs, and a badge claiming five live
  // connections would be the hardcoded fixture this replaced (Requirement 27.5).

  /** The curated catalog, with each entry's missing environment named. */
  mcpCatalog?(): Promise<McpCatalogResult>

  // ── Offline Mode and the privacy view ──────────────────────────────────────

  /** The Offline Mode switch, where it is saved, and what this engine process sent where. */
  privacyStatus?(options?: { root?: string }): Promise<PrivacyStatus>
  /** Turn Offline Mode on or off. Saved in the user's home, so every window sees it. */
  privacySet?(offline: boolean, options?: { root?: string }): Promise<PrivacyStatus>

  // ── the user's own MCP servers ─────────────────────────────────────────────

  mcpServers?(options?: { root?: string }): Promise<UserMcpServersResult>
  mcpServerSave?(params: {
    scope: 'global' | 'project'
    name: string
    command?: string
    args?: string[]
    env?: Record<string, string>
    url?: string
    headers?: Record<string, string>
    root?: string
  }): Promise<UserMcpServersResult & { saved: string }>
  mcpServerRemove?(params: { scope: 'global' | 'project'; name: string; root?: string }): Promise<UserMcpServersResult & { removed: boolean }>
  /** Approve (or withdraw) a project server's exact launch. */
  mcpServerTrust?(params: { name: string; trusted: boolean; root?: string }): Promise<UserMcpServersResult>
  /** Start the server once, list its tools, stop it. */
  mcpServerTest?(params: { name: string; root?: string }): Promise<UserMcpTestResult>

  // ── hooks ──────────────────────────────────────────────────────────────────
  // `.sketch/hooks.json` for a project. `hooks-test` really executes the
  // matching hooks once and reports what each did.

  /** The hooks on disk for a project, plus any config problems. */
  hooksList?(params: { root: string }): Promise<HooksListResult>
  /** Validate and write the whole hooks config. Writes nothing when invalid. */
  hooksSave?(params: { root: string; config: { hooks: HookListItem[] } }): Promise<HooksSaveResult>
  /** Run the hooks matching one event, for real, and report each outcome. */
  hooksTest?(params: { root: string; event: HookEventName; tool?: string }): Promise<HooksTestResult>

  // ── local models (Ollama) ──────────────────────────────────────────────────

  /** The Ollama server and program, installed and loaded models, the machine, and what fits it. */
  localModels?(options?: { baseUrl?: string }): Promise<LocalModelsResult>
  /** Start a download. `confirmed` must be true: the user agreed, having seen the size. */
  localModelPull?(params: { model: string; baseUrl?: string; confirmed: true }): Promise<LocalModelPull>
  localModelPullStatus?(id: string): Promise<LocalModelPull>
  localModelPullCancel?(id: string): Promise<{ id: string; cancelled: boolean }>
  /** Remove a model's files. `confirmed` must be true. */
  localModelDelete?(params: { model: string; baseUrl?: string; confirmed: true }): Promise<{ ok: boolean; model: string }>
  /** Load a model into memory, or (`unload: true`) free it. */
  localModelLoad?(params: { model: string; baseUrl?: string; unload?: boolean }): Promise<{ ok: boolean; model: string; loaded: boolean }>

  // ── strategies and roles ──────────────────────────────────────────────────

  /**
   * The three strategies, the thirteen roles, and which roles this project can verify.
   *
   * Read-only and free: it resolves the verification contract and answers which roles have a
   * signal it could grade them by. It reports no live status, on purpose.
   */
  strategyCatalog?(options?: { root?: string }): Promise<StrategyCatalogResult>

  // ── cost ──────────────────────────────────────────────────────────────────
  //
  // The total is a SUM OVER THE EVENT LOG and there is no second source — no running
  // counter in `AppState`, no cached subtotal on this seam, nothing the UI increments as
  // events arrive. Requirement 20.2 requires that, and it is also what makes the
  // dashboard auditable: every row links back to the log line it came from.
  //
  // `state.totalCost` was deleted for this reason. It held `12.45`.

  /** What this project's runs have cost, derived from the durable log. */
  cost?(params: { root: string; runId?: string }): Promise<CostReport>
  /**
   * Model calls NOT tied to a message — completions, inline edits, commit messages,
   * connection tests, model listing — rolled up by cause from the engine's
   * `~/.sketch/usage` log. Never carries a key, a prompt, or a reply.
   */
  costUsage?(params?: { home?: string }): Promise<UsageSummary>

  /** Latest validated benchmark artifact. Read-only: never starts work on mount. */
  benchmarkReport?(params: { root: string }): Promise<BenchmarkReportResult>

  // ── memory ────────────────────────────────────────────────────────────────
  //
  // Versioned rows, supersede-with-a-reason, the lint pass and the retriever all live in
  // the engine. Same seam reasoning as git, skills and cost.
  //
  // READING IS FREE; WRITING IS A USER ACTION. And `memorySupersede` REQUIRES a reason:
  // Requirement 21.3 asks that superseding record why, and an optional reason would mean
  // the panel could close an entry silently — which is the state the requirement exists
  // to prevent. Note it is not a delete: the row stays and its window closes, so the
  // history a user is correcting remains readable.

  /** Every entry with its validity window, plus the lint pass's findings. */
  memoryList?(params: { root: string; kind?: string }): Promise<MemoryListResult>

  /** Retrieve for a query, with the recency prior. */
  memorySearch?(params: {
    root: string
    query: string
    topK?: number
    includeSuperseded?: boolean
  }): Promise<MemorySearchResult>

  /** Record something. Supersedes a same-key predecessor. */
  memoryRemember?(params: {
    root: string
    kind: string
    text: string
    key?: string
    subject?: string
    tags?: string[]
    reason?: string
    source?: string
  }): Promise<MemoryRememberResult>

  /** Close an entry's window. `reason` is required. */
  memorySupersede?(params: {
    root: string
    id: string
    reason: string
    replacementText?: string
  }): Promise<MemorySupersedeResult>

  // ── connecting a model ────────────────────────────────────────────────────

  /**
   * The models a provider serves, asked of the provider. A real network call made
   * only because a picker asked; `apiKey` is for this one call and is never saved.
   */
  providerModels?(params: {
    provider: {
      id: string
      kind: ProviderSettingsFile['providers'][number]['kind']
      baseUrl: string
      apiKey?: string
    }
    timeoutMs?: number
  }): Promise<ProviderModelsResult>

  /**
   * Open the loopback listener for a desktop account sign-in (OpenRouter PKCE). The
   * engine reports the one-time code; the exchange and the key never pass through it.
   */
  oauthStart?(params?: { timeoutMs?: number }): Promise<OAuthStartResult>
  /** Long-poll for the callback of a started sign-in. */
  oauthWait?(params: { id: string }): Promise<OAuthWaitResult>
  /** Abandon a started sign-in. */
  oauthCancel?(params: { id: string }): Promise<{ id: string; cancelled: boolean }>

  /** Whether a ChatGPT account is signed in, as whom, on which plan. Never a token. */
  chatgptStatus?(): Promise<ChatGPTStatus>
  /**
   * Start "Sign in with ChatGPT". `browser` opens a loopback callback the user's
   * browser returns to; `device` shows a code to type at auth.openai.com/codex/device.
   */
  chatgptLoginStart?(params: { mode: 'browser' | 'device' }): Promise<ChatGPTLoginStart>
  /** Long-poll for the outcome of a started ChatGPT sign-in. */
  chatgptLoginWait?(params: { id: string }): Promise<ChatGPTLoginOutcome>
  /** Abandon a started ChatGPT sign-in. */
  chatgptLoginCancel?(params: { id: string }): Promise<{ id: string; cancelled: boolean }>
  /** Sign out: revoke at OpenAI (best effort) and forget the sign-in on this computer. */
  chatgptLogout?(): Promise<{ signedOut: boolean; revoked: boolean }>
  /** The models the signed-in ChatGPT account can use, best first. */
  chatgptModels?(): Promise<ChatGPTModelsResult>

  /** Put back every file an auto-applied run changed, from its snapshot. No Git needed. */
  undoRun?(params: { root: string; runId: string }): Promise<UndoRunResult>

  /** Clone a repository into a NEW folder under `parent`. */
  gitClone?(params: { url: string; parent: string; name?: string }): Promise<{ path: string; name: string }>

  /**
   * Inline completion at the cursor. A real model call, made only while the user has
   * Autocomplete switched on; `signal` abandons it (the engine is told to stop too).
   */
  complete?(
    params: {
      provider: ProviderSettingsEntry
      apiKey?: string
      path: string
      language?: string
      prefix: string
      suffix: string
      maxTokens?: number
    },
    options?: { signal?: AbortSignal },
  ): Promise<CompletionResult>

  /**
   * Inline edit (Ctrl+K): the selection rewritten as `instruction` says. One model call,
   * made when the user asks; nothing is written — the editor shows the diff to accept.
   * `signal` abandons it, and the engine is told to stop too.
   */
  inlineEdit?(
    params: {
      provider: ProviderSettingsEntry
      apiKey?: string
      path: string
      language?: string
      before: string
      selection: string
      after: string
      instruction: string
      maxTokens?: number
    },
    options?: { signal?: AbortSignal },
  ): Promise<InlineEditResult>

  /** Every indexable file in the project, for Quick Open and `@` mentions. Paths only. */
  projectFiles?(params: { root: string }): Promise<ProjectFilesResult>

  /** Custom slash commands for this project and this user. Reads only. */
  commandsList?(params: { root?: string }): Promise<CommandsListResult>

  // ── terminal ──────────────────────────────────────────────────────────────
  //
  // The Code surface's terminal runs in the ENGINE: the user's shell, one process per
  // line, output streamed by polling `termRead`, stoppable with `termKill`, answerable
  // on stdin with `termWrite`. It replaced the blocking Tauri `run_command`, which ran
  // on the window's main thread and froze the app until the program exited. `termStart`
  // requires `confirmed: true`; the panel asks before the first command in a folder.

  /** Run one line, or apply a `cd`. */
  termStart?(params: { root: string; cwd?: string; line: string; confirmed: true }): Promise<TerminalStartResult>
  /** Output since `since`, and whether the command is still running. */
  termRead?(params: { id: string; since?: number }): Promise<TerminalReadResult>
  /** Type into the running program; `end` closes its input (Ctrl+D). */
  termWrite?(params: { id: string; data?: string; end?: boolean }): Promise<{ ok: boolean }>
  /** Stop the command and everything it started. */
  termKill?(params: { id: string }): Promise<{ stopped: boolean }>

  /**
   * What changed in the project on disk, by long poll. Without `since`: the current
   * cursor at once. With it: as soon as something changes, or an empty batch after
   * `timeoutMs`. Aborting forgets the request (the engine's poll simply times out).
   */
  fsWatch?(params: { root: string; since?: number; timeoutMs?: number }, signal?: AbortSignal): Promise<FsWatchBatch>

  /** Show a project file or folder in the system's file manager, selected. */
  osReveal?(params: { root: string; path: string }): Promise<{ label: string }>
  /** Open the system's own terminal app (Windows Terminal, Terminal.app…) in a project folder. */
  osOpenTerminal?(params: { root: string; path?: string }): Promise<{ label: string }>

  // ── explorer file operations ──────────────────────────────────────────────
  //
  // Contained by real path in the engine; none of them overwrites. `fsDelete` moves to
  // the operating system's trash by default and answers `trashUnavailable` (deleting
  // nothing) when it cannot, so the window can offer a permanent delete instead.

  fsCreateFile?(params: { root: string; path: string; content?: string }): Promise<{ path: string }>
  fsCreateFolder?(params: { root: string; path: string }): Promise<{ path: string }>
  fsRename?(params: { root: string; from: string; to: string }): Promise<{ from: string; to: string }>
  fsDelete?(params: { root: string; path: string; trash?: boolean }): Promise<FsDeleteResult>

  /**
   * Attach a handler to the engine's event stream. Called for every event from
   * every run, in emission order. Subscribing mid-run yields only subsequent
   * events; the accumulated log is held by the client provider, not here.
   */
  subscribe(handler: EventHandler): Unsubscribe
}

/**
 * Minimal fan-out used by the client implementations. Handlers are snapshotted
 * before dispatch so a handler that unsubscribes (or subscribes) during dispatch
 * cannot corrupt the iteration, and a throwing handler cannot starve the rest.
 */
export function createEventBus() {
  const handlers = new Set<EventHandler>()

  return {
    subscribe(handler: EventHandler): Unsubscribe {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    emit(event: SketchEvent): void {
      for (const handler of [...handlers]) {
        try {
          handler(event)
        } catch (err) {
          // A broken panel must not break the engine's event stream.
          console.error('[sketch] event handler threw', err)
        }
      }
    },
    get size() {
      return handlers.size
    },
  }
}

export type EventBus = ReturnType<typeof createEventBus>
