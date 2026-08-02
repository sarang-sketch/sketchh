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
  EvalCase,
  EvalResult,
  GitStatusResult,
  ProviderDescriptor,
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

export interface RunOptions {
  /** Project root for this run. Required by the desktop to match the open folder. */
  root?: string
  /** Leave emitted patches open for human hunk review instead of auto-applying. */
  reviewEdits?: boolean
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
