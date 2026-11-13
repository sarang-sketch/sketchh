// Hooks: user-defined commands that run at fixed points of a run.
//
// A hook is a program Sketch spawns as the user, at a moment the engine chooses
// (run start/end, before/after a tool call). The shape is deliberately the same
// discipline as MCP servers and verify commands: an argv array, never a command
// string, spawned with `shell: false`, stdin carrying a JSON payload, stdout
// read as an optional JSON decision.
//
// Only PreToolUse can refuse anything, and only by returning
// `{ "allow": false, "reason": "..." }` on stdout. Every other outcome — a hook
// that crashes, times out, or prints garbage — is logged and the run proceeds.
// A hook that could wedge a run by failing would be a veto the user never asked
// for, and a hook that could silently rewrite a tool call would be a second
// authorisation point. There is exactly one of those, and it is not here.

/** The moments a hook can attach to. */
export type HookEvent = 'SessionStart' | 'PreToolUse' | 'PostToolUse' | 'Stop'

export const HOOK_EVENTS: readonly HookEvent[] = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']

export function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === 'string' && (HOOK_EVENTS as readonly string[]).includes(value)
}

/**
 * One hook, as written in `.sketch/hooks.json`.
 *
 * `matcher` is a glob over the tool name (`*` and `?`, `*` matches any run of
 * characters including `.`), and only applies to PreToolUse / PostToolUse. A
 * missing matcher matches every tool. SessionStart / Stop hooks ignore it.
 *
 * `command` is an argv array: element 0 is the program, the rest are arguments.
 * There is no shell string anywhere in this file — a `command` that arrives as a
 * string is rejected by validation, not split.
 *
 * `blocking` defaults to true for PreToolUse (its decision is what the loop
 * waits on) and false otherwise. A non-blocking PreToolUse hook still runs, but
 * its decision is ignored: it is an observer, not a gate.
 */
export interface HookConfig {
  /** Stable name for logs and RPC. Defaults to `<event>-<index>`. */
  name?: string
  event: HookEvent
  matcher?: string
  command: string[]
  /** Per-hook deadline. Defaults to {@link DEFAULT_HOOK_TIMEOUT_MS}. */
  timeoutMs?: number
  blocking?: boolean
}

/** Default per-hook deadline. A hook that cannot answer by now is presumed hung. */
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000

/** Longest a single hook may be allowed to run. */
export const MAX_HOOK_TIMEOUT_MS = 120_000

/** Most hooks one file may declare. */
export const MAX_HOOKS = 32

/** Largest `.sketch/hooks.json` that is read at all. */
export const MAX_HOOKS_FILE_BYTES = 64 * 1024

/** Stdout/stderr kept per hook run, each. Capped so a chatty hook cannot grow. */
export const MAX_HOOK_OUTPUT_BYTES = 16 * 1024

/** What a hook is told about the moment it runs. Written to its stdin as JSON. */
export interface HookPayload {
  event: HookEvent
  /** Tool name for Pre/PostToolUse; absent for SessionStart / Stop. */
  tool?: string
  /** The tool call's arguments for PreToolUse, its result for PostToolUse. */
  input?: unknown
  /** The tool call's result text, for PostToolUse. */
  output?: string
  /** The run this hook belongs to, when one exists. */
  runId?: string
}

/** What one hook execution produced. Never throws out of the runner. */
export interface HookOutcome {
  /** The hook that ran, by config name. */
  hook: string
  event: HookEvent
  /** False only when the hook itself could not run or timed out. */
  ok: boolean
  /** The hook's decision. Only PreToolUse reads it; anything else ignores it. */
  allowed: boolean
  /** The hook's reason for denying, or why it failed. */
  reason?: string
  /** Stdout, capped. */
  stdout: string
  /** Stderr, capped. */
  stderr: string
  durationMs: number
  timedOut: boolean
  /** Process exit code, when it exited on its own. */
  exitCode?: number | null
}

/** The PreToolUse verdict the loop acts on. */
export interface HookDecision {
  allowed: boolean
  reason?: string
}

/**
 * The seam the agent loop depends on. Structural, like `ToolDispatch`: the loop
 * states the smallest surface it needs and any runner satisfying it will do.
 * Every method resolves rather than throwing — a hook failure is a logged
 * proceed, never an exception into the loop.
 */
export interface HookRunnerLike {
  runSessionStart(input?: { runId?: string }): Promise<HookOutcome[]>
  runSessionStop(input?: { runId?: string }): Promise<HookOutcome[]>
  preToolUse(
    tool: string,
    input: Record<string, unknown>,
    options?: { runId?: string },
  ): Promise<HookDecision>
  postToolUse(
    tool: string,
    input: Record<string, unknown>,
    output?: string,
    options?: { runId?: string },
  ): Promise<void>
}
