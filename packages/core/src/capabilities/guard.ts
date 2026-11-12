// The enforcement point. One function. There is no second path.
//
// ── WHY ONE FUNCTION ────────────────────────────────────────────────────────
//
// This codebase has made this bet twice already and both times it held: the plan
// gate is one `hasPlan` call inside `runTask`, and filesystem containment is one
// `resolve_within` in `command_policy.rs`, with a test asserting there is exactly
// one. The property that makes those work is not the check itself — it is that
// there is nowhere else to look. A capability system with two dispatch paths is a
// capability system with one hole.
//
// So: every tool a skill can invoke goes through {@link ToolDispatcher.call}.
// The grant is consulted there, before the tool's `run` is reached. A tool cannot
// opt out, cannot check for itself, and cannot be reached around — `run` is
// private to the descriptor and the descriptor is only ever handed to this class.
//
// ── ENFORCEMENT IS NOT IN THE PROMPT ────────────────────────────────────────
//
// "You do not have network access" in a system prompt is a request. A model that
// ignores it is not malfunctioning, it is doing what models do. The check is at
// the point of execution and the model's cooperation is not part of the
// mechanism. What the prompt is for is telling the model what it HAS, so it does
// not waste turns attempting denied calls — that is `describeGrantForPrompt`,
// and it is advisory by construction.
//
// ── A DENIAL IS A RESULT, NOT A THROW ───────────────────────────────────────
//
// `call` returns `{ ok: false, … }`. It does not throw through the caller and
// kill the run. Skills must be able to degrade: the most demanding community
// skill in existence reads ~20 network sources and is expected to still produce
// something useful when nineteen are unavailable. A denial that terminates the
// run turns "this skill did less" into "this skill broke your task", and a user
// who experiences that once turns the sandbox off.
//
// Exactly one `tool_denied` per denied call, and exactly one `tool_called` per
// permitted one — including when the tool itself then fails, because the call was
// made and the log has to say so.
//
// ── WHAT PHASE 7 ADDS ───────────────────────────────────────────────────────
//
// This file is the enforcement POINT, deliberately built before the tools exist
// (task 6.3; the tool layer is 7.3). Today the dispatcher is constructed with an
// empty tool table by default, so every call is denied as unknown — which is the
// honest state of a build with no tool layer, and it is what
// `TOOL_UNAVAILABLE_REASON` says in the loop. 7.3 registers real descriptors
// here; it does not get to add a second dispatcher.
//
// Validates: Requirements 11.4, 11.5, 22.4

import type { EventInput } from '../events/store.js'
import {
  CAPABILITY_DESCRIPTIONS,
  grants,
  type Capability,
  type CapabilitySet,
} from './vocabulary.js'

/** What a tool needs to be dispatched, plus the capability it costs. */
export interface ToolDescriptor {
  /** Name the model uses. Unique within a dispatcher. */
  name: string
  /** One line, for the prompt and for a log. */
  description: string
  /**
   * The capability a caller must hold. Exactly one, not a list: a tool needing
   * two different kinds of access is two tools, and collapsing them means a user
   * granting one gets the other.
   */
  requires: Capability
  /**
   * One short, non-secret line saying what THIS call will do — "npm test",
   * "src/app.ts" — so a live surface can show "Running npm test…" while the call is
   * in flight. Optional; a tool without one shows its name. The line lands on the
   * durable log, so a tool must not put a credential-bearing argument in it (the
   * store's write-path redaction is the backstop, not the policy).
   */
  summarize?(args: Record<string, unknown>): string | null
  /**
   * The effect. Only ever invoked by {@link ToolDispatcher.call}, after the
   * grant check has passed.
   */
  run(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome>
}

/** What a tool is told about the run it is serving. */
export interface ToolContext {
  /** The project root. A tool that touches the filesystem must contain itself to it. */
  root: string
  /** The run this call belongs to, for correlating events. */
  runId: string
  /** The capabilities in force, so a tool can vary behaviour rather than fail. */
  granted: CapabilitySet
  signal?: AbortSignal
}

/** A tool's own result. `ok: false` is a failure, not a denial. */
export interface ToolOutcome {
  ok: boolean
  /** Whatever the tool produced. Rendered into the model's feedback by the caller. */
  output: string
  /** Structured detail for the event log. Must carry no credential. */
  detail?: Record<string, unknown>
}

/** Why a call did not happen. */
export type DenialReason =
  /** No tool of that name is registered. */
  | 'unknown_tool'
  /** The caller does not hold the capability the tool requires. */
  | 'capability_denied'
  /** The tool threw. Recorded as a failure of the call, not of the gate. */
  | 'tool_error'

export interface ToolCallResult {
  ok: boolean
  name: string
  /** The tool's output, or the denial explained in words the model can act on. */
  output: string
  /** Null when the call was permitted and the tool succeeded. */
  denied: DenialReason | null
  /** The capability that was missing, when that is why. */
  missing?: Capability
}

export interface ToolDispatcherOptions {
  /** The tools this dispatcher knows. Empty until Phase 7.3 registers real ones. */
  tools?: readonly ToolDescriptor[]
  /** The grant in force for the caller. */
  granted: CapabilitySet
  /** Project root, passed to every tool. */
  root: string
  events?: { emit(event: EventInput): Promise<void> | void }
  runId?: string
  /** Name of the skill whose grant this is, for the denial record. */
  skill?: string
  signal?: AbortSignal
}

/**
 * The one place a tool call is authorised.
 *
 * Construct one per run with the grant already resolved. The grant is captured at
 * construction and is `readonly`: a dispatcher whose permissions could be widened
 * after it was built would let anything holding a reference escalate.
 */
export class ToolDispatcher {
  readonly granted: CapabilitySet
  readonly root: string
  readonly runId: string
  readonly skill: string | null

  readonly #tools: Map<string, ToolDescriptor>
  readonly #events: { emit(event: EventInput): Promise<void> | void } | undefined
  readonly #signal: AbortSignal | undefined

  constructor(options: ToolDispatcherOptions) {
    this.granted = Object.freeze([...options.granted])
    this.root = options.root
    this.runId = options.runId ?? 'tools'
    this.skill = options.skill ?? null
    this.#tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]))
    this.#events = options.events
    this.#signal = options.signal
  }

  /** Registered tool names, sorted. */
  get toolNames(): string[] {
    return [...this.#tools.keys()].sort()
  }

  /**
   * The tools this grant can actually reach. What belongs in a prompt.
   *
   * Filtered through `#authorised`, the same predicate `call` uses, so the list
   * shown to the model and the list the gate permits cannot drift apart. A
   * separate `grants(...)` here would be a second answer to the same question.
   */
  get availableTools(): ToolDescriptor[] {
    return [...this.#tools.values()]
      .filter((tool) => this.#authorised(tool))
      .sort((a, b) => (a.name < b.name ? -1 : 1))
  }

  /**
   * THE AUTHORISATION. The only place a grant is consulted in this package, and
   * `capabilities.test.ts` asserts that it stays the only place — the same
   * structural guarantee as one `hasPlan` call in `runTask` and one
   * `resolve_within` in `command_policy.rs`.
   */
  #authorised(tool: ToolDescriptor): boolean {
    return grants(this.granted, tool.requires)
  }

  /**
   * Authorise and run one tool call.
   *
   * `options.runId` overrides the dispatcher's default for this call. That is how
   * the agent loop correlates: it mints its own run id internally, so a dispatcher
   * built before `runTask` was called cannot know it, and events logged under a
   * different id would be invisible to `forRun(runId)` — present in the log,
   * missing from the run. The correlation is a property of the CALL, not of the
   * dispatcher, so it is passed per call rather than by mutating anything.
   *
   * Never throws: a tool that throws is caught and reported as `tool_error`, so
   * a badly written tool cannot take the run down with it.
   */
  async call(
    name: string,
    args: Record<string, unknown> = {},
    options: { runId?: string } = {},
  ): Promise<ToolCallResult> {
    const runId = options.runId ?? this.runId
    const tool = this.#tools.get(name)

    if (tool === undefined) {
      const known = this.toolNames
      const output =
        known.length === 0
          ? `TOOL DENIED (${name}) — no tools are registered in this build, so there is nothing to call.`
          : `TOOL DENIED (${name}) — no such tool. Available: ${known.join(', ')}.`
      await this.#deny(runId, name, 'unknown_tool', output)
      return { ok: false, name, output, denied: 'unknown_tool' }
    }

    // THE CHECK. Before `run`, every time, with no way past it.
    if (!this.#authorised(tool)) {
      const output =
        `TOOL DENIED (${name}) — this skill was not granted ${tool.requires} ` +
        `(${CAPABILITY_DESCRIPTIONS[tool.requires]}). ` +
        `Granted: ${this.granted.length === 0 ? 'nothing' : this.granted.join(', ')}. ` +
        `Continue without it.`
      await this.#deny(runId, name, 'capability_denied', output, tool.requires)
      return { ok: false, name, output, denied: 'capability_denied', missing: tool.requires }
    }

    const context: ToolContext = {
      root: this.root,
      runId,
      granted: this.granted,
      ...(this.#signal !== undefined ? { signal: this.#signal } : {}),
    }

    // EVENT BEFORE ACTION (Requirement 3.3), and here it earns its keep: a tool
    // call is the most side-effecting thing in this system, so if the process dies
    // mid-call the log has to show that the call was attempted. The outcome follows
    // as a second event.
    //
    // SPEC GAP, recorded rather than patched: the `EventKind` contract has
    // `tool_called` and `tool_denied` and no `tool_result`, so the pair that
    // `verify_started` / `verify_result` gets is expressed here as two
    // `tool_called` events told apart by `phase`. Adding a kind needs a spec
    // change; inventing one here does not.
    //
    // ARGUMENT KEYS ONLY, never values. A tool argument routinely carries a path,
    // a query, or a token, and this payload is durable. The one exception is a
    // tool's own `summarize` line, which the tool vouches is display-safe.
    let summary: string | null = null
    try {
      summary = tool.summarize?.(args) ?? null
    } catch {
      summary = null
    }
    await this.#emit(runId, 'tool_called', {
      name,
      requires: tool.requires,
      phase: 'start',
      argKeys: Object.keys(args).sort(),
      ...(summary !== null && summary.trim() !== '' ? { summary: summary.slice(0, 200) } : {}),
    })

    let outcome: ToolOutcome
    try {
      outcome = await tool.run(args, context)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const output = `TOOL FAILED (${name}) — ${message}`
      // Still `tool_called`, not `tool_denied`: the gate permitted this, and
      // recording it as a denial would make a buggy tool look like a security
      // event and hide the real ones.
      await this.#emit(runId, 'tool_called', {
        name,
        requires: tool.requires,
        phase: 'result',
        ok: false,
        error: message,
      })
      return { ok: false, name, output, denied: 'tool_error' }
    }

    await this.#emit(runId, 'tool_called', {
      name,
      requires: tool.requires,
      phase: 'result',
      ok: outcome.ok,
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
    })
    return { ok: outcome.ok, name, output: outcome.output, denied: null }
  }

  async #deny(
    runId: string,
    name: string,
    reason: DenialReason,
    output: string,
    missing?: Capability,
  ): Promise<void> {
    await this.#emit(runId, 'tool_denied', {
      name,
      reason,
      detail: output,
      ...(missing !== undefined ? { missing } : {}),
    })
  }

  async #emit(
    runId: string,
    kind: 'tool_called' | 'tool_denied',
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.#events?.emit({
      runId,
      kind,
      payload: {
        ...(this.skill !== null ? { skill: this.skill } : {}),
        granted: [...this.granted],
        ...payload,
      },
    })
  }
}

/**
 * The advisory half: tell the model what it has, so it does not spend turns
 * attempting calls the gate will refuse.
 *
 * This text is NOT the mechanism. It is a courtesy to the model, and a model that
 * ignores it changes nothing about what actually runs.
 */
export function describeGrantForPrompt(dispatcher: ToolDispatcher): string {
  const available = dispatcher.availableTools
  const lines: string[] = []
  lines.push(
    dispatcher.granted.length === 0
      ? 'You hold no capabilities in this run.'
      : `Capabilities granted to you: ${dispatcher.granted.join(', ')}.`,
  )
  if (available.length === 0) {
    lines.push('No tool is available to you, so do not attempt a tool action.')
  } else {
    lines.push('Tools you may call:')
    for (const tool of available) {
      lines.push(`  - ${tool.name} (needs ${tool.requires}): ${tool.description}`)
    }
  }
  lines.push(
    'This list is advisory. Every call is checked at execution time, and a call ' +
      'you were not granted is refused whatever this text says.',
  )
  return lines.join('\n')
}
