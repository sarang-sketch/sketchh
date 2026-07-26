// The agent loop — `runTask`.
//
// This is the engine: one function that turns a Task into a RunResult by talking
// to a ChatAdapter in the action protocol, and every collaborator is injected
// (Requirement 5.1). There is no module-global state in this file, no `new`
// anything a caller cannot substitute, and no `process.env` read.
//
// WHY THE GATE LIVES HERE (Requirement 6.5). `edit` asks `plan.hasPlan(runId)`
// before it touches disk, in the ENGINE, not in the UI and not in the CLI. A
// CLI-driven or eval-driven run goes through this same function, so there is no
// second path that could skip the check. The answer comes from the filesystem
// rather than from an in-memory flag set earlier in this loop, which is what makes
// the gate survive a resumed or externally-driven run.
//
// EVENT-BEFORE-ACTION (Requirement 3.3). Every action emits its event before it
// executes. Two of the seven delegate that duty rather than duplicating it:
//   * `plan` — `PlanWriter.write` emits `plan_written` itself, after the bytes
//     land, because the payload carries the file list it just wrote. Emitting a
//     second "about to plan" event here would put two events on the log for one
//     action and break the one-event-per-action reading of the timeline.
//   * `verify` — `runCommands` emits `verify_started` before each spawn and
//     `verify_result` after, through the sink it is handed. The EventStore is
//     passed as that sink; this file does not re-emit either kind.
// Everything else (`edit_proposed` before writing, `tool_denied` before
// continuing, `think`) is emitted here, before the effect.
//
// EXACTLY ONE TERMINAL EVENT (Requirement 3.4). `#finish` is the single exit and
// it is latched: `run_completed` when the result is ok, `run_failed` otherwise, so
// the terminal event kind always agrees with `RunResult.ok`. Every failure mode —
// adapter throw, abort, iteration exhaustion, an unexpected internal error —
// funnels through it. A provider error never escapes as an unhandled rejection and
// its message is redacted with the shared provider redactor before it reaches the
// log.
//
// Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 3.3, 3.4, 6.4, 6.5, 6.6

import type { EventStore } from '../events/store.js'
import { newRunId } from '../events/ids.js'
import { redact } from '../providers/redact.js'
import { runCommands } from '../verify/runner.js'
import type { VerifyEventSink } from '../verify/runner.js'
import type { FileWriter } from '../orchestrator/file-writer.js'
import type {
  ChatAdapter,
  Message,
  ProjectContext,
  RunResult,
  Skill,
  Task,
  Usage,
  VerifyCommand,
  VerifyResult,
} from '../types.js'
import { parseAction } from './actions.js'
import type { Action, EditSpec } from './actions.js'
import { applyEdit, type EditOutcome, type TextReader } from './edits.js'

/**
 * Default iteration cap: 12 model turns.
 *
 * The scripted happy path is three (plan → verify → done). Twelve leaves room for
 * a plan, several edit/verify cycles, and a couple of degraded turns, while
 * bounding the worst case a paid provider can bill for. Override per run.
 */
export const DEFAULT_MAX_ITERATIONS = 12

/** The plan artifact seam: exactly the two methods the loop needs. */
export interface PlanGate {
  write(
    runId: string,
    artifacts: Record<string, unknown>,
  ): Promise<{ dir: string; files: string[]; ignored: string[] }>
  hasPlan(runId: string): Promise<boolean>
}

/** The verify seam. `runCommands` from `verify/runner.js` satisfies it. */
export type VerifyRunner = (
  commands: VerifyCommand[],
  options: { sink?: VerifyEventSink; runId?: string; signal?: AbortSignal },
) => Promise<VerifyResult[]>

export interface RunTaskDeps {
  /** The model. The only network-touching collaborator, and it is a seam. */
  adapter: ChatAdapter
  /** The append-only log. Also used as the verify runner's event sink. */
  events: EventStore
  /** The plan artifact writer and gate. */
  plan: PlanGate
  /** Whole-file writer; search/replace semantics live in `loop/edits.ts`. */
  files: FileWriter
  /** Project root. Edits outside it are refused. */
  root: string
  /** Defaults to the shell-less `runCommands`. */
  verify?: VerifyRunner
  /** Epoch-millisecond clock, injected for deterministic run ids. */
  clock?: () => number
  /** Run id generator. Defaults to `newRunId(clock())`. */
  ids?: () => string
  /** Model turns allowed. Defaults to {@link DEFAULT_MAX_ITERATIONS}. */
  maxIterations?: number
  /** Cancels the run. Forwarded to the adapter and the verify runner. */
  signal?: AbortSignal
  /** Skills to put in front of the model. Loading is the caller's job. */
  skills?: readonly Skill[]
  /** `AGENTS.md` / `CLAUDE.md` content. */
  projectContext?: ProjectContext
  /** File reader used to resolve search/replace edits. Injectable for tests. */
  readText?: TextReader
}

/** Prefix of the refusal fed back when the plan gate is shut. */
export const PLAN_GATE_REASON =
  'no plan artifact exists for this run; write a plan before editing files'

/** Prefix of the denial fed back for any `tool` action in Phase 1. */
export const TOOL_UNAVAILABLE_REASON =
  'tools are not yet available: the scoped tool layer does not exist in this build'

/** Fed back, and used as `finalText`, when the model asks a question. */
export const ASK_UNSUPPORTED_REASON =
  'this run has no interactive channel, so a question cannot be answered mid-run'

function isBlank(text: string): boolean {
  return text.trim() === ''
}

/** Skill and project-context material, as system messages. */
function contextMessages(deps: RunTaskDeps): Message[] {
  const out: Message[] = []

  for (const skill of deps.skills ?? []) {
    out.push({
      role: 'system',
      content: `# Skill: ${skill.name}\n${skill.description}\n\n${skill.body}`.trimEnd(),
    })
  }

  const context = deps.projectContext
  if (context && (!isBlank(context.agents) || !isBlank(context.claude))) {
    const parts: string[] = []
    if (!isBlank(context.agents)) parts.push(`# AGENTS.md\n${context.agents}`)
    if (!isBlank(context.claude)) parts.push(`# CLAUDE.md\n${context.claude}`)
    out.push({ role: 'system', content: parts.join('\n\n') })
  }

  return out
}

/** The protocol contract, stated to the model. */
export function systemPrompt(task: Task, maxIterations: number): string {
  const stages =
    task.verify.length === 0
      ? 'none are configured for this task'
      : task.verify.map((v) => v.name).join(', ')

  return [
    'You are Sketch, an autonomous engineering agent.',
    '',
    'Reply with ONE JSON object per turn and nothing else. Fenced JSON is accepted.',
    'The seven actions are:',
    '  { "action": "plan",   "artifacts": { "prd": "...", "arch": "...", "schema": "...", "tests": "..." } }',
    '  { "action": "verify" }',
    '  { "action": "edit",   "edits": [ { "path": "...", "search": "...", "replace": "..." } ] }',
    '  { "action": "tool",   "name": "<tool>", "args": {} }',
    '  { "action": "think",  "text": "..." }',
    '  { "action": "ask",    "question": "..." }',
    '  { "action": "done",   "text": "..." }',
    '',
    'Rules:',
    '1. Your FIRST turn must be "plan". No edit is applied until a plan artifact exists.',
    '2. An "edit" uses exact search/replace. An empty "search" writes the whole file,',
    '   creating it if needed. Paths are relative to the project root; a path outside',
    '   the project root is refused.',
    '3. "verify" runs the configured commands and their PASS/FAIL output is fed back.',
    `   Configured verify stages: ${stages}.`,
    '4. "done" is only successful when every verify stage passed, or none were configured.',
    `5. You have at most ${maxIterations} turns. Unparseable output is treated as "think".`,
  ].join('\n')
}

/** `PASS`/`FAIL` summary plus captured output, as the model sees it. */
export function formatVerifyFeedback(results: readonly VerifyResult[]): string {
  if (results.length === 0) {
    return 'VERIFY: no verify commands are configured for this task, so nothing ran.'
  }

  const failed = results.filter((r) => !r.ok)
  const head = failed.length === 0 ? 'VERIFY PASS' : `VERIFY FAIL (${failed.length} of ${results.length})`

  const detail = results.map((r) => {
    const status = r.ok ? 'PASS' : 'FAIL'
    const lines = [`- ${r.name}: ${status} (exit ${r.exitCode}, ${r.durationMs}ms)`]
    // Only failures carry their output back: a passing stage's log is noise that
    // crowds out the failure the model has to act on.
    if (!r.ok) {
      if (!isBlank(r.stdout)) lines.push(`  stdout:\n${clip(r.stdout)}`)
      if (!isBlank(r.stderr)) lines.push(`  stderr:\n${clip(r.stderr)}`)
    }
    return lines.join('\n')
  })

  return [head, ...detail].join('\n')
}

/** Keep fed-back output bounded; the tail is where a stack trace ends up. */
function clip(text: string, limit = 4000): string {
  const trimmed = text.trimEnd()
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(trimmed.length - limit)}`
}

function describeEditOutcomes(outcomes: readonly EditOutcome[]): string {
  const applied = outcomes.filter((o) => o.ok)
  const refused = outcomes.filter((o) => !o.ok)
  const lines: string[] = []
  lines.push(
    refused.length === 0
      ? `EDIT APPLIED (${applied.length} file${applied.length === 1 ? '' : 's'})`
      : `EDIT PARTIALLY REFUSED (${applied.length} applied, ${refused.length} refused)`,
  )
  for (const o of applied) lines.push(`- ${o.path}: written${o.created ? ' (created)' : ''}`)
  for (const o of refused) lines.push(`- ${o.path}: REFUSED — ${o.reason ?? 'unknown reason'}`)
  return lines.join('\n')
}

function editSummary(edits: readonly EditSpec[]): Record<string, unknown>[] {
  return edits.map((e) => ({
    path: e.path,
    wholeFile: e.search === '',
    searchBytes: Buffer.byteLength(e.search, 'utf8'),
    replaceBytes: Buffer.byteLength(e.replace, 'utf8'),
  }))
}

/** An aborted run, whatever the abort looked like at the syscall level. */
function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  return err instanceof Error && err.name === 'AbortError'
}

/**
 * Run one task to completion.
 *
 * Always resolves: every failure path resolves a `RunResult` with `ok: false`
 * after emitting exactly one `run_failed`.
 */
export async function runTask(task: Task, deps: RunTaskDeps): Promise<RunResult> {
  const clock = deps.clock ?? (() => Date.now())
  const runId = deps.ids ? deps.ids() : newRunId(clock())
  const maxIterations = Math.max(1, Math.floor(deps.maxIterations ?? DEFAULT_MAX_ITERATIONS))
  const verifyRunner = deps.verify ?? runCommands
  const events = deps.events
  const signal = deps.signal

  let iterations = 0
  /** The MOST RECENT verify run. `RunResult.verify` reflects the last one. */
  let lastVerify: VerifyResult[] = []
  let verifyRan = false
  let terminated = false

  const emit = async (
    kind: Parameters<EventStore['emit']>[0]['kind'],
    payload: Record<string, unknown>,
  ): Promise<void> => {
    await events.emit({ runId, kind, payload })
  }

  /** The one and only exit. Latched, so a second call cannot double-emit. */
  const finish = async (
    ok: boolean,
    finalText: string,
    payload: Record<string, unknown> = {},
  ): Promise<RunResult> => {
    if (!terminated) {
      terminated = true
      await emit(ok ? 'run_completed' : 'run_failed', {
        taskId: task.id,
        ok,
        iterations,
        verify: lastVerify.map((r) => ({ name: r.name, ok: r.ok, exitCode: r.exitCode })),
        ...payload,
      })
    }
    return {
      runId,
      ok,
      finalText,
      iterations,
      verify: lastVerify,
      events: await events.forRun(runId),
    }
  }

  /** Requirement 5.8: ok only when all stages passed, or none were configured. */
  const verifyOk = (): boolean => {
    if (task.verify.length === 0) return true
    if (lastVerify.length !== task.verify.length) return false
    return lastVerify.every((r) => r.ok)
  }

  const runVerify = async (): Promise<VerifyResult[]> => {
    // `runCommands` emits verify_started before each spawn and verify_result
    // after; the store is the sink, so nothing is emitted twice here.
    const results = await verifyRunner(task.verify, { sink: events, runId, signal })
    lastVerify = results
    verifyRan = true
    return results
  }

  await emit('run_started', {
    taskId: task.id,
    prompt: task.prompt,
    adapter: deps.adapter.id,
    maxIterations,
    root: deps.root,
    verifyStages: task.verify.map((v) => v.name),
  })

  const messages: Message[] = [
    { role: 'system', content: systemPrompt(task, maxIterations) },
    ...contextMessages(deps),
    { role: 'user', content: task.prompt },
  ]

  for (const skill of deps.skills ?? []) {
    await emit('skill_loaded', { name: skill.name, source: skill.source })
  }
  await emit('context_assembled', {
    messages: messages.length,
    skills: (deps.skills ?? []).map((s) => s.name),
    hasProjectContext: deps.projectContext !== undefined,
  })

  try {
    while (iterations < maxIterations) {
      if (signal?.aborted) {
        return finish(false, 'Run aborted.', { reason: 'aborted' })
      }

      iterations++

      await emit('llm_request', {
        iteration: iterations,
        adapter: deps.adapter.id,
        messages: messages.length,
      })

      let text: string
      let usage: Usage | undefined
      try {
        const response = await deps.adapter.chat(messages, signal ? { signal } : undefined)
        text = response.text ?? ''
        usage = response.usage
      } catch (err) {
        if (isAbort(err, signal)) {
          return finish(false, 'Run aborted.', { reason: 'aborted' })
        }
        // Redacted through the shared provider redactor: a 401 body routinely
        // echoes the credential back, and this string lands in the log.
        const message = redact(err instanceof Error ? err.message : String(err))
        return finish(false, `Provider error: ${message}`, {
          reason: 'provider_error',
          adapter: deps.adapter.id,
          detail: message,
        })
      }

      // Usage is always present so Phase 8's cost accounting can sum without
      // guarding for undefined; an adapter that cannot count reports zeros.
      await emit('llm_response', {
        iteration: iterations,
        text,
        usage: { in: usage?.in ?? 0, out: usage?.out ?? 0 },
      })

      messages.push({ role: 'assistant', content: text })

      const action: Action = parseAction(text)

      switch (action.action) {
        case 'think': {
          await emit('think', { iteration: iterations, text: action.text, degraded: action.degraded })
          if (action.degraded) {
            messages.push({
              role: 'user',
              content:
                'Your last turn was not a valid action and was recorded as a thought. ' +
                'Reply with exactly one JSON action object.',
            })
          }
          break
        }

        case 'plan': {
          // `plan.write` emits plan_written itself, carrying the artifact paths.
          const result = await deps.plan.write(runId, action.artifacts)
          messages.push({
            role: 'user',
            content:
              `PLAN WRITTEN to ${result.dir} (${result.files.join(', ') || 'no documents'}).` +
              (result.ignored.length > 0
                ? ` Ignored unknown keys: ${result.ignored.join(', ')}.`
                : '') +
              ' You may now propose edits.',
          })
          break
        }

        case 'edit': {
          // THE GATE. Asked of the filesystem, before anything is written.
          if (!(await deps.plan.hasPlan(runId))) {
            await emit('edit_rejected', {
              iteration: iterations,
              reason: PLAN_GATE_REASON,
              paths: action.edits.map((e) => e.path),
            })
            messages.push({
              role: 'user',
              content:
                `EDIT REJECTED — ${PLAN_GATE_REASON}. ` +
                'Send a { "action": "plan", "artifacts": { … } } turn first, then retry the edit.',
            })
            break
          }

          await emit('edit_proposed', {
            iteration: iterations,
            edits: editSummary(action.edits),
          })

          const outcomes: EditOutcome[] = []
          for (const edit of action.edits) {
            const outcome = await applyEdit(edit, {
              root: deps.root,
              files: deps.files,
              readText: deps.readText,
            })
            outcomes.push(outcome)
            if (outcome.ok) {
              await emit('edit_accepted', {
                iteration: iterations,
                path: outcome.path,
                created: outcome.created === true,
                bytes: outcome.bytes ?? 0,
              })
            } else {
              await emit('edit_rejected', {
                iteration: iterations,
                path: outcome.path,
                reason: outcome.reason ?? 'unknown reason',
              })
            }
          }

          messages.push({ role: 'user', content: describeEditOutcomes(outcomes) })
          break
        }

        case 'verify': {
          const results = await runVerify()
          messages.push({ role: 'user', content: formatVerifyFeedback(results) })
          break
        }

        case 'tool': {
          await emit('tool_denied', {
            iteration: iterations,
            name: action.name,
            reason: TOOL_UNAVAILABLE_REASON,
          })
          messages.push({
            role: 'user',
            content:
              `TOOL DENIED (${action.name}) — ${TOOL_UNAVAILABLE_REASON}. ` +
              'Use edit and verify actions instead.',
          })
          break
        }

        case 'ask': {
          // Phase 1 has no interactive channel: the CLI protocol is one frame per
          // run and the eval harness is headless, so blocking on a human would
          // hang every automated caller. The question is surfaced as the run's
          // finalText and the run ends not-ok, which is honest — the task was not
          // completed — and leaves the caller free to re-run with the answer
          // appended to the prompt. There is no `ask` EventKind in the contract,
          // so the question is recorded as a `think` carrying the ask payload.
          await emit('think', {
            iteration: iterations,
            action: 'ask',
            text: action.question,
            reason: ASK_UNSUPPORTED_REASON,
          })
          return finish(false, action.question, {
            reason: 'awaiting_human_input',
            question: action.question,
          })
        }

        case 'done': {
          // If verify commands were configured but never run, RUN THEM rather than
          // failing the run: the model asserting completion is exactly the moment
          // the claim should be checked, and "you forgot to verify" is a worse
          // outcome than one extra verify pass. Requirement 5.8 then decides `ok`.
          if (!verifyRan && task.verify.length > 0) {
            await runVerify()
          }
          const ok = verifyOk()
          const finalText = action.text.trim() === '' ? 'Done.' : action.text
          return finish(ok, finalText, {
            reason: ok ? 'done' : 'verify_failed',
            verifiedStages: lastVerify.length,
          })
        }
      }
    }

    const reason = `reached maxIterations (${maxIterations}) without a done action`
    return finish(false, `Stopped: ${reason}.`, { reason: 'max_iterations', maxIterations })
  } catch (err) {
    // Anything unexpected — a plan writer rejecting a runId, a broken injected
    // collaborator — still produces exactly one terminal event.
    if (isAbort(err, signal)) {
      return finish(false, 'Run aborted.', { reason: 'aborted' })
    }
    const message = redact(err instanceof Error ? err.message : String(err))
    return finish(false, `Run failed: ${message}`, { reason: 'internal_error', detail: message })
  }
}
