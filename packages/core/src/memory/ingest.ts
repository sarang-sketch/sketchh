// Writing memory from a run that just finished.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// The memory store, its hygiene, its retrieval and its panel were all real, and nothing
// ever wrote to it except a person clicking a button. That makes the compounding claim
// false by construction: a project could not get smarter from being worked on, only from
// being annotated by hand.
//
// ── WHAT IT WILL AND WILL NOT WRITE ─────────────────────────────────────────
//
// Only facts the run ITSELF recorded, read back off its own event log. No model call, so
// ingestion costs nothing and cannot hallucinate; no summarising, because a summary of a
// run is a new claim and this module is not entitled to make one.
//
// That rules out the tempting entries. A `bug` entry needs to know that a failure was
// understood and fixed, and a verify stage going red then green in one run does not
// establish that. A `conversation` entry needs a summary. An `architecture` entry needs
// judgement about what is structural. All three would be this module inventing content and
// attributing it to the project, which is exactly the "no mock data in shipped panels"
// rule wearing a different hat.
//
// What is left is genuinely useful and genuinely derivable:
//
//   * `test` — the verification outcome, from `verify_result` events. The raw history
//     behind "the tests were passing", which is what that kind is for.
//   * `decision` — the plan the run committed to. The model's own words, labelled as the
//     run's plan rather than as the project's conclusion.
//
// One correction worth keeping: the plan text is NOT in the `plan_written` payload. That
// event carries `dir`, `files` and `documents` — the document ids, not their prose — so an
// earlier version of this module read `payload.artifacts.prd`, a field no emitter writes.
// Its unit tests passed because they fabricated the payload, which is the exact failure
// mode of testing against a shape instead of against the producer. The prose lives on disk
// where `PlanWriter` put it, so the CALLER reads it and passes it in; this module still
// invents nothing and still does no filesystem work.
//
// Both are `source: 'run'`, both carry `runId`, and both are keyed so the next run
// SUPERSEDES rather than accumulating. Keying matters: without it a hundred runs leave a
// hundred near-identical entries and retrieval degrades into noise, which is how an
// automatic writer destroys the store it was meant to fill. The log stays append-only, so
// the history is still there.

import type { SketchEvent } from '../types.js'
import type { MemoryEntry, MemoryEntryInput } from './entries.js'
import type { MemoryStore } from './store.js'

/** The key every run-derived verification entry shares, so each replaces the last. */
export const VERIFICATION_MEMORY_KEY = 'run-verification'

/** The key every run-derived plan entry shares. */
export const PLAN_MEMORY_KEY = 'run-plan'

/** What ingestion wrote, for a caller that wants to log or assert it. */
export interface IngestResult {
  written: MemoryEntry[]
  /** Entries closed because a newer run replaced them. */
  superseded: string[]
  /** Why nothing was written, when nothing was. */
  reason: string | null
}

function stageSummary(events: readonly SketchEvent[]): string | null {
  const stages: Array<{ name: string; passed: boolean }> = []
  for (const event of events) {
    if (event.kind !== 'verify_result') continue
    const name = event.payload['name'] ?? event.payload['stage'] ?? event.payload['command']
    if (typeof name !== 'string' || name.trim() === '') continue
    // `ok` is the loop's field. Absent means the outcome was not recorded as a boolean,
    // and guessing a pass from a missing field is exactly the wrong default.
    const ok = event.payload['ok']
    if (typeof ok !== 'boolean') continue
    stages.push({ name, passed: ok })
  }
  if (stages.length === 0) return null
  const failed = stages.filter((stage) => !stage.passed).map((stage) => stage.name)
  const passed = stages.filter((stage) => stage.passed).map((stage) => stage.name)
  if (failed.length === 0) {
    return `Verification passed: ${passed.join(', ')}.`
  }
  return `Verification failed at ${failed.join(', ')}${
    passed.length > 0 ? `; passing: ${passed.join(', ')}` : ''
  }.`
}

/** True when the run actually wrote a plan, so a supplied plan is attributable to it. */
function wrotePlan(events: readonly SketchEvent[]): boolean {
  return events.some((event) => event.kind === 'plan_written')
}

/**
 * Write what this run established into project memory.
 *
 * Never throws for a reason a caller cannot act on: a run must not be reported as failed
 * because its memory write did. The `reason` field says why nothing was written.
 *
 * @param options.task The task prompt, used only to say what the plan was FOR.
 * @param options.plan The run's plan prose, read by the caller from where the run wrote
 *   it. Ignored unless the run actually emitted `plan_written`, so a caller cannot file
 *   a plan against a run that never made one.
 */
export async function ingestRunMemory(options: {
  store: MemoryStore
  runId: string
  events: readonly SketchEvent[]
  task?: string
  plan?: string
}): Promise<IngestResult> {
  const { store, runId, events } = options
  const candidates: MemoryEntryInput[] = []

  const verification = stageSummary(events)
  if (verification !== null) {
    candidates.push({
      kind: 'test',
      key: VERIFICATION_MEMORY_KEY,
      text: verification,
      runId,
      source: 'run',
    })
  }

  const plan =
    options.plan !== undefined && options.plan.trim() !== '' && wrotePlan(events)
      ? options.plan.trim()
      : null
  if (plan !== null) {
    candidates.push({
      kind: 'decision',
      key: PLAN_MEMORY_KEY,
      // Labelled as the run's plan. Stating it as the project's decision would put the
      // model's intent on the record as the project's conclusion.
      text:
        options.task === undefined || options.task.trim() === ''
          ? `A run planned: ${plan}`
          : `For the task ${JSON.stringify(options.task.trim())}, a run planned: ${plan}`,
      runId,
      source: 'run',
    })
  }

  if (candidates.length === 0) {
    return { written: [], superseded: [], reason: 'the run recorded no plan and no verification outcome' }
  }

  const written: MemoryEntry[] = []
  const superseded: string[] = []
  try {
    const existing = await store.all()
    for (const input of candidates) {
      // Close the previous run's entry of the same kind and key, so the store holds one
      // current answer per fact with the whole history behind it.
      const previous = existing.filter(
        (entry) =>
          entry.kind === input.kind &&
          entry.key === input.key &&
          entry.source === 'run' &&
          entry.validTo === null,
      )
      let replaced = false
      for (const stale of previous) {
        const result = await store.supersede({
          id: stale.id,
          reason: `a later run (${runId}) recorded this fact`,
          ...(replaced ? {} : { replacement: input }),
        })
        if (!result.ok) continue
        superseded.push(stale.id)
        if (!replaced && result.replacement !== null && result.replacement !== undefined) {
          written.push(result.replacement)
          replaced = true
        }
      }
      if (!replaced) written.push(await store.add(input))
    }
  } catch (error) {
    // A failed memory write must not fail the run that produced it.
    return {
      written,
      superseded,
      reason: `memory ingestion stopped: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  return { written, superseded, reason: null }
}
