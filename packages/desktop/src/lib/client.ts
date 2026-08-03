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

export interface RunOptions {
  /**
   * Exact key-free provider entry selected from persisted settings for this run.
   * Omitted means no provider was selected; the engine refuses unless its explicit
   * offline fake switch is enabled. This type cannot carry an API key.
   */
  provider?: ProviderSettingsEntry
  /** Project root for this run. Required by the desktop to match the open folder. */
  root?: string
  /** Leave emitted patches open for human hunk review instead of auto-applying. */
  reviewEdits?: boolean
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

  /** Verify and install one pinned skill. Refuses on a hash mismatch. */
  skillInstall?(params: {
    root: string
    name: string
    registryDir?: string
  }): Promise<SkillInstallResult>

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
