// The bridge: the original `ProjectMemory` surface, backed by the versioned store.
//
// ── WHY A BRIDGE AND NOT A REWRITE ─────────────────────────────────────────
//
// `src/orchestrator/orchestrator.ts` is a live caller of `ProjectMemory`. It uses exactly
// four members — `digest()`, `addTestRecord()`, `addConversation()`, and the type name —
// and it is documented as not yet wired into the new agent loop. Changing its dependency
// to fit Phase 9's store would be a breaking edit to working code that gains that code
// nothing, so the old interface is preserved and this adapter satisfies it.
//
// The gain is real, not cosmetic: an orchestrator run through this bridge gets validity
// windows, supersede-with-a-reason and the lint pass underneath it, without learning that
// any of those exist.
//
// ── WHERE THE TWO MODELS DO NOT LINE UP, AND WHAT HAPPENS ──────────────────
//
// * `setStandard(key, value)` was an UPSERT over a `Map`. Here it supersedes the live
//   entry for that key with a recorded reason, which is the versioned equivalent and is
//   strictly more informative — the old value survives with the window in which it held.
// * `Decision.id`, `BugRecord.id` and friends were caller-supplied. The store mints its
//   own ids, so the caller's id is kept in `data.legacyId` rather than discarded: an
//   orchestrator that wrote `t1-lint` should still be able to find it.
// * `listTestRecords(limit)` returned newest-first. Preserved.
// * `digest()` delegates to `memoryDigest`, so the bridge cannot drift from the real one.
//
// The lossy direction is stated plainly: `TestRecord.output` is truncated by the caller
// already, and nothing here re-expands it.

import { memoryDigest } from './retrieve.js'
import { remember } from './hygiene.js'
import type { MemoryEventSink } from './hygiene.js'
import type { MemoryEntry } from './entries.js'
import type { MemoryStore } from './store.js'
import type {
  BugRecord,
  ConversationRecord,
  Decision,
  ProjectMemory,
  Standard,
  TestRecord,
} from './types.js'

export interface LegacyBridgeOptions {
  store: MemoryStore
  events?: MemoryEventSink
  runId?: string
  now?: () => number
}

/**
 * A `ProjectMemory` backed by a versioned `MemoryStore`.
 *
 * Hand this to the legacy orchestrator to give it versioned memory without touching it.
 */
export function legacyProjectMemory(options: LegacyBridgeOptions): ProjectMemory {
  const { store, events } = options
  const now = options.now ?? (() => Date.now())

  const write = async (
    entry: Parameters<typeof remember>[0]['entry'],
    supersedeSameKey: boolean,
  ): Promise<void> => {
    await remember({
      store,
      entry,
      ...(events !== undefined ? { events } : {}),
      ...(options.runId !== undefined ? { runId: options.runId } : {}),
      supersedeSameKey,
    })
  }

  const legacyId = (entry: MemoryEntry): string =>
    typeof entry.data?.['legacyId'] === 'string' ? (entry.data['legacyId'] as string) : entry.id

  return {
    async addDecision(decision: Omit<Decision, 'createdAt'>): Promise<void> {
      // No `key`: two decisions are two decisions. A decision that replaces another is a
      // deliberate supersede, not an accident of sharing an identifier.
      await write(
        {
          kind: 'decision',
          text:
            decision.rationale === '' ? decision.summary : `${decision.summary} — ${decision.rationale}`,
          data: { legacyId: decision.id, summary: decision.summary, rationale: decision.rationale },
        },
        false,
      )
    },

    async listDecisions(): Promise<Decision[]> {
      const entries = await store.query({ kind: 'decision', currentOnly: true, at: now() })
      return entries.map((entry) => ({
        id: legacyId(entry),
        summary: typeof entry.data?.['summary'] === 'string' ? (entry.data['summary'] as string) : entry.text,
        rationale: typeof entry.data?.['rationale'] === 'string' ? (entry.data['rationale'] as string) : '',
        createdAt: entry.validFrom,
      }))
    },

    async setStandard(key: string, value: string): Promise<void> {
      // The upsert becomes a supersede. The previous value survives with its window,
      // which is the whole point of the versioned store.
      await write({ kind: 'standard', key, text: value }, true)
    },

    async getStandard(key: string): Promise<string | null> {
      const entries = await store.query({ kind: 'standard', key, currentOnly: true, at: now() })
      const newest = entries.reduce<MemoryEntry | null>(
        (best, entry) => (best === null || entry.validFrom > best.validFrom ? entry : best),
        null,
      )
      return newest?.text ?? null
    },

    async listStandards(): Promise<Standard[]> {
      const entries = await store.query({ kind: 'standard', currentOnly: true, at: now() })
      return entries
        .filter((entry) => entry.key !== undefined)
        .map((entry) => ({ key: entry.key!, value: entry.text, updatedAt: entry.validFrom }))
    },

    async addBug(bug: Omit<BugRecord, 'createdAt'>): Promise<void> {
      await write(
        {
          kind: 'bug',
          text: `${bug.description} → fixed by: ${bug.fix}`,
          ...(bug.files[0] !== undefined ? { subject: bug.files[0] } : {}),
          ...(bug.files.length > 0 ? { tags: bug.files } : {}),
          data: { legacyId: bug.id, description: bug.description, fix: bug.fix, files: bug.files },
        },
        false,
      )
    },

    async listBugs(): Promise<BugRecord[]> {
      return (await store.query({ kind: 'bug', currentOnly: true, at: now() })).map(toBug)
    },

    async findBugsByFile(file: string): Promise<BugRecord[]> {
      const entries = await store.query({ kind: 'bug', currentOnly: true, at: now() })
      return entries.filter((entry) => (entry.tags ?? []).includes(file)).map(toBug)
    },

    async addTestRecord(record: Omit<TestRecord, 'createdAt'>): Promise<void> {
      // NOT keyed, so a run's outcome follows the previous run's rather than replacing it.
      // Test history is an append-only series; superseding it would destroy the history
      // that makes "the tests were passing last week" answerable.
      await write(
        {
          kind: 'test',
          text: `${record.checkName}: ${record.passed ? 'passed' : 'FAILED'}`,
          subject: record.checkName,
          data: {
            legacyId: record.id,
            checkName: record.checkName,
            passed: record.passed,
            output: record.output,
          },
        },
        false,
      )
    },

    async listTestRecords(limit?: number): Promise<TestRecord[]> {
      const entries = (await store.query({ kind: 'test' }))
        .slice()
        // Newest first, as the original did.
        .sort((a, b) => b.validFrom - a.validFrom)
        .map((entry) => ({
          id: legacyId(entry),
          checkName:
            typeof entry.data?.['checkName'] === 'string'
              ? (entry.data['checkName'] as string)
              : (entry.subject ?? ''),
          passed: entry.data?.['passed'] === true,
          output: typeof entry.data?.['output'] === 'string' ? (entry.data['output'] as string) : '',
          createdAt: entry.validFrom,
        }))
      return limit === undefined ? entries : entries.slice(0, limit)
    },

    async addConversation(conversation: Omit<ConversationRecord, 'createdAt'>): Promise<void> {
      await write(
        {
          kind: 'conversation',
          text: conversation.task,
          data: {
            legacyId: conversation.id,
            task: conversation.task,
            messages: conversation.messages,
          },
        },
        false,
      )
    },

    async listConversations(limit?: number): Promise<ConversationRecord[]> {
      const entries = (await store.query({ kind: 'conversation' }))
        .slice()
        .sort((a, b) => b.validFrom - a.validFrom)
        .map((entry) => ({
          id: legacyId(entry),
          task: typeof entry.data?.['task'] === 'string' ? (entry.data['task'] as string) : entry.text,
          messages: typeof entry.data?.['messages'] === 'string' ? (entry.data['messages'] as string) : '',
          createdAt: entry.validFrom,
        }))
      return limit === undefined ? entries : entries.slice(0, limit)
    },

    async digest(): Promise<string> {
      // Delegated, so the bridge cannot drift from the real digest.
      return memoryDigest({ store, now: now() })
    },
  }

  function toBug(entry: MemoryEntry): BugRecord {
    return {
      id: legacyId(entry),
      description:
        typeof entry.data?.['description'] === 'string'
          ? (entry.data['description'] as string)
          : entry.text,
      fix: typeof entry.data?.['fix'] === 'string' ? (entry.data['fix'] as string) : '',
      files: Array.isArray(entry.data?.['files'])
        ? (entry.data['files'] as unknown[]).filter((f): f is string => typeof f === 'string')
        : (entry.tags ?? []),
      createdAt: entry.validFrom,
    }
  }
}
