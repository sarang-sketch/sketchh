// Memory hygiene: superseding with a reason, expiry, and a lint pass for contradictions.
//
// ── WHY HYGIENE IS NOT OPTIONAL ─────────────────────────────────────────────
//
// Without it a memory store becomes a pile of stale contradictions, and that is WORSE
// than having no memory at all — because the model trusts it. "We use REST" and "we use
// GraphQL" both retrieved, both presented as project fact, produces confidently wrong
// work and the user has no way to see why. So Requirement 21.3 asks that newer entries
// supersede older ones with a recorded reason, and 21.4 asks for expiry and a lint pass.
//
// ── WHAT THIS FILE WILL AND WILL NOT DECIDE BY ITSELF ──────────────────────
//
// It will supersede automatically when the entries share a `kind` AND a `key`. That is
// an explicit statement of identity by whoever wrote them — a second `standard` keyed
// `test-location` is an UPDATE, and treating it as a contradiction would be pedantry.
//
// It will NOT decide that two entries contradict each other from their prose. `lintMemory`
// REPORTS suspected contradictions and supersedes nothing: deciding by keyword overlap
// which of two decisions is wrong would eventually delete the right one, and a memory
// store that silently discards true things is unfixable from the outside. A finding is a
// question for the user, and `MemoryLintFinding.confidence` says how strong the signal is
// rather than pretending it is a verdict.
//
// ── USER ENTRIES ARE NEVER TOUCHED AUTOMATICALLY ───────────────────────────
//
// `source: 'user'` is exempt from expiry and from automatic superseding. A person wrote
// it down deliberately; a heuristic in this file does not get to overrule them. It can
// still be superseded explicitly, by another user action.
//
// Validates: Requirements 21.3, 21.4

import type { EventInput } from '../events/store.js'
import {
  MEMORY_KINDS,
  type MemoryEntry,
  type MemoryEntryInput,
  type MemoryKind,
} from './entries.js'
import type { MemoryStore, SupersedeResult } from './store.js'

/** Emitter seam. The `EventStore` satisfies it; a test can pass a recorder. */
export interface MemoryEventSink {
  emit(event: EventInput): Promise<void> | void
}

export interface RememberOptions {
  store: MemoryStore
  entry: MemoryEntryInput
  events?: MemoryEventSink
  /** Correlates the `memory_superseded` event with the run that caused it. */
  runId?: string
  /**
   * Reason recorded when this write supersedes a same-key predecessor.
   *
   * Defaults to a sentence naming the replacement, because Requirement 21.3 wants a
   * reason and an empty string is not one.
   */
  reason?: string
  /**
   * Supersede a same-key predecessor. Default true — that is the whole point of `key`.
   *
   * `false` keeps both open, which is what an append-only history like `test` or
   * `performance` wants: a run's outcome does not invalidate the previous run's outcome,
   * it follows it.
   */
  supersedeSameKey?: boolean
}

export interface RememberResult {
  entry: MemoryEntry
  /** The predecessor that was closed, when one was. */
  superseded: MemoryEntry | null
}

/**
 * Write an entry, superseding a same-key predecessor.
 *
 * THE ONE WRITE PATH callers should use, so a `memory_superseded` event cannot be
 * forgotten by a caller who went straight to `store.add`. `MemoryStore.add` stays public
 * because the store is also the migration and import surface, but everything in the
 * product writes through here.
 */
export async function remember(options: RememberOptions): Promise<RememberResult> {
  const { store, entry, events } = options
  const supersedeSameKey = options.supersedeSameKey ?? true

  // Find the live predecessor: same kind, same key, still open, and not a user entry
  // unless this write is itself from the user.
  let predecessor: MemoryEntry | null = null
  if (supersedeSameKey && entry.key !== undefined) {
    const live = await store.query({ kind: entry.kind, key: entry.key, currentOnly: true })
    const candidates = live.filter(
      (candidate) => candidate.source !== 'user' || (entry.source ?? 'run') === 'user',
    )
    // The newest, so a store containing more than one live entry for a key — which
    // should not happen, but a hand-edited log can produce — closes the current one.
    predecessor = candidates.reduce<MemoryEntry | null>(
      (best, candidate) => (best === null || candidate.validFrom > best.validFrom ? candidate : best),
      null,
    )
  }

  if (predecessor === null) {
    const written = await store.add(entry)
    return { entry: written, superseded: null }
  }

  // A default reason rather than an empty one: Requirement 21.3 wants a reason recorded,
  // and "" is not one. It names the key and the kind, which is what a user reading the
  // history months later needs in order to tell a deliberate update from a bug.
  const reason =
    options.reason ??
    `a newer ${entry.kind} was recorded for "${entry.key}", replacing this one`

  const result = await store.supersede({ id: predecessor.id, reason, replacement: entry })
  if (!result.ok || result.replacement === null) {
    // The supersede refused (a race closed the predecessor first). The new fact still
    // has to land: losing it would be the worse failure.
    const written = await store.add(entry)
    return { entry: written, superseded: null }
  }

  await emitSuperseded(events, {
    runId: options.runId,
    closed: result.closed,
    replacement: result.replacement,
    reason,
    trigger: 'same-key',
  })

  return { entry: result.replacement, superseded: result.closed }
}

export interface ExpireOptions {
  store: MemoryStore
  /** Kind → how long an entry of that kind stays valid, in ms. */
  maxAge: Partial<Record<MemoryKind, number>>
  now?: number
  events?: MemoryEventSink
  runId?: string
}

export interface ExpireResult {
  expired: MemoryEntry[]
  /** Entries old enough to expire that were left alone, and why. */
  exempt: Array<{ entry: MemoryEntry; reason: string }>
}

/**
 * Close entries older than their kind's maximum age (Requirement 21.4).
 *
 * ── WHAT DOES AND DOES NOT EXPIRE ──────────────────────────────────────────
 *
 * `maxAge` is supplied by the caller with NO DEFAULTS, deliberately. A default expiry
 * would silently delete a project's architectural decisions after some number this file
 * chose, and the right answer is completely different per kind and per project — a `test`
 * outcome is stale in a week, an `architecture` note can be true for years. So a caller
 * that wants expiry says what it wants expired.
 *
 * `source: 'user'` never expires. A person wrote it down on purpose.
 */
export async function expireMemory(options: ExpireOptions): Promise<ExpireResult> {
  const now = options.now ?? Date.now()
  const expired: MemoryEntry[] = []
  const exempt: Array<{ entry: MemoryEntry; reason: string }> = []

  const live = await options.store.query({ currentOnly: true, at: now })
  for (const entry of live) {
    const maxAge = options.maxAge[entry.kind]
    if (maxAge === undefined) continue
    const age = now - entry.validFrom
    if (age <= maxAge) continue

    if (entry.source === 'user') {
      exempt.push({
        entry,
        reason: 'the user wrote this entry, so it is never expired automatically',
      })
      continue
    }

    const days = Math.floor(age / 86_400_000)
    const reason = `expired: no longer valid after ${Math.floor(maxAge / 86_400_000)} day(s), and this entry is ${days} day(s) old`
    const result = await options.store.supersede({ id: entry.id, reason })
    if (!result.ok || result.closed === null) continue

    expired.push(result.closed)
    await emitSuperseded(options.events, {
      runId: options.runId,
      closed: result.closed,
      replacement: null,
      reason,
      trigger: 'expiry',
    })
  }

  return { expired, exempt }
}

/** How strongly a lint finding suspects a contradiction. Never a verdict. */
export type LintConfidence =
  /** Same kind and key, both live. Structural, and effectively certain. */
  | 'certain'
  /** Same kind and subject, with opposing language. Worth a human look. */
  | 'likely'
  /** Same kind and subject, overlapping topic. A hint. */
  | 'possible'

export interface MemoryLintFinding {
  kind: 'contradiction' | 'duplicate' | 'orphan' | 'unreasoned'
  confidence: LintConfidence
  /** The entries involved, newest first. */
  entries: MemoryEntry[]
  /** What a user should be told, in words they can act on. */
  detail: string
  /** What to do about it. Never done automatically for a contradiction. */
  suggestion: string
}

export interface LintMemoryOptions {
  store: MemoryStore
  now?: number
}

/**
 * Words that flip a statement's meaning.
 *
 * Written as ONE space-separated string, not an array of quoted words. The zero-dependency
 * guard (`test/deps.test.ts`) scans this package for `from '<specifier>'` literally, so a
 * list of quoted words next to each other can read to it as a bare import — it failed
 * exactly that way for the retrieval stopword list. The data moved instead of the guard.
 */
const NEGATIONS: ReadonlySet<string> = new Set(
  'not no never dont doesnt didnt wont cant cannot avoid stop drop remove instead rather without'.split(
    ' ',
  ),
)

/**
 * Report suspected problems. SUPERSEDES NOTHING.
 *
 * Requirement 21.4 asks for a lint pass for contradictions, and a lint pass reports. The
 * alternative — deciding from prose which of two decisions is wrong — would eventually
 * discard the correct one, and a memory store that silently deletes true things cannot be
 * debugged from outside. Every finding names the entries so the user can act.
 */
export async function lintMemory(options: LintMemoryOptions): Promise<MemoryLintFinding[]> {
  const now = options.now ?? Date.now()
  const live = await options.store.query({ currentOnly: true, at: now })
  const findings: MemoryLintFinding[] = []

  // ── certain: two live entries sharing kind and key ───────────────────────
  //
  // Structural, so this one is not a guess. It means a write bypassed `remember` or the
  // log was hand-edited.
  const byKey = new Map<string, MemoryEntry[]>()
  for (const entry of live) {
    if (entry.key === undefined) continue
    const composite = `${entry.kind}\u0000${entry.key}`
    byKey.set(composite, [...(byKey.get(composite) ?? []), entry])
  }
  for (const [composite, group] of byKey) {
    if (group.length < 2) continue
    const sorted = [...group].sort((a, b) => b.validFrom - a.validFrom)
    const key = composite.split('\u0000')[1]!
    findings.push({
      kind: 'contradiction',
      confidence: 'certain',
      entries: sorted,
      detail: `${group.length} entries are all currently valid for ${sorted[0]!.kind} "${key}". Only one can be true.`,
      suggestion: `Keep the newest and supersede the rest, or give them different keys if they are genuinely about different things.`,
    })
  }

  // ── likely / possible: same kind and subject, opposing or overlapping ────
  const bySubject = new Map<string, MemoryEntry[]>()
  for (const entry of live) {
    if (entry.subject === undefined) continue
    // Entries already caught by the key rule are not reported twice.
    if (entry.key !== undefined && (byKey.get(`${entry.kind}\u0000${entry.key}`)?.length ?? 0) > 1) {
      continue
    }
    const composite = `${entry.kind}\u0000${entry.subject}`
    bySubject.set(composite, [...(bySubject.get(composite) ?? []), entry])
  }
  for (const group of bySubject.values()) {
    if (group.length < 2) continue
    const sorted = [...group].sort((a, b) => b.validFrom - a.validFrom)
    for (let i = 0; i < sorted.length - 1; i++) {
      const newer = sorted[i]!
      const older = sorted[i + 1]!
      const overlap = topicOverlap(newer.text, older.text)
      if (overlap === 0) continue
      const opposed = negationDiffers(newer.text, older.text)
      findings.push({
        kind: 'contradiction',
        confidence: opposed ? 'likely' : 'possible',
        entries: [newer, older],
        detail: opposed
          ? `Two ${newer.kind} entries about "${newer.subject}" are both valid and one negates the other.`
          : `Two ${newer.kind} entries about "${newer.subject}" are both valid and cover the same ground.`,
        suggestion:
          'Read both. If the newer replaced the older, supersede the older with a reason; if they are compatible, leave them.',
      })
    }
  }

  // ── duplicate: identical text, both live ────────────────────────────────
  const byText = new Map<string, MemoryEntry[]>()
  for (const entry of live) {
    const normalised = `${entry.kind}\u0000${entry.text.trim().toLowerCase()}`
    byText.set(normalised, [...(byText.get(normalised) ?? []), entry])
  }
  for (const group of byText.values()) {
    if (group.length < 2) continue
    findings.push({
      kind: 'duplicate',
      confidence: 'certain',
      entries: [...group].sort((a, b) => b.validFrom - a.validFrom),
      detail: `${group.length} identical ${group[0]!.kind} entries are all valid.`,
      suggestion: 'Supersede the older copies. They add cost to every retrieval and say nothing new.',
    })
  }

  // ── unreasoned: closed with no reason ───────────────────────────────────
  //
  // Should be impossible through `remember` and `expireMemory`, both of which require
  // one. A finding here means something wrote a close op directly, and "superseded, no
  // reason given" is indistinguishable from a bug months later.
  for (const entry of await options.store.all()) {
    if (entry.validTo === null) continue
    if (entry.reason !== undefined && entry.reason.trim() !== '') continue
    findings.push({
      kind: 'unreasoned',
      confidence: 'certain',
      entries: [entry],
      detail: `A ${entry.kind} entry was superseded with no reason recorded.`,
      suggestion:
        'Nothing to fix in the data, but the code that closed it should be recording a reason (Requirement 21.3).',
    })
  }

  // ── orphan: claims a replacement that is not in the store ───────────────
  const ids = new Set((await options.store.all()).map((entry) => entry.id))
  for (const entry of await options.store.all()) {
    if (entry.supersededBy === undefined || ids.has(entry.supersededBy)) continue
    findings.push({
      kind: 'orphan',
      confidence: 'certain',
      entries: [entry],
      detail: `A ${entry.kind} entry names ${entry.supersededBy} as its replacement, but no such entry exists.`,
      suggestion: 'The log is incomplete — a file may be missing from .sketch/memory.',
    })
  }

  return findings
}

/** How much two texts talk about the same thing. Terms shared, ignoring negations. */
function topicOverlap(a: string, b: string): number {
  const left = contentWords(a)
  const right = contentWords(b)
  let shared = 0
  for (const word of left) if (right.has(word)) shared++
  return shared
}

/** True when exactly one of the two texts negates. The "likely" signal. */
function negationDiffers(a: string, b: string): boolean {
  return hasNegation(a) !== hasNegation(b)
}

function hasNegation(text: string): boolean {
  for (const word of words(text)) if (NEGATIONS.has(word)) return true
  return false
}

function contentWords(text: string): Set<string> {
  const out = new Set<string>()
  for (const word of words(text)) {
    if (word.length < 4) continue
    if (NEGATIONS.has(word)) continue
    out.add(word)
  }
  return out
}

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).map((w) => w.replace(/['’]/g, ''))
}

/** One `memory_superseded` event. The only place that kind is emitted. */
async function emitSuperseded(
  events: MemoryEventSink | undefined,
  info: {
    runId?: string
    closed: MemoryEntry | null
    replacement: MemoryEntry | null
    reason: string
    trigger: 'same-key' | 'expiry' | 'explicit'
  },
): Promise<void> {
  if (events === undefined || info.closed === null) return
  await events.emit({
    // A memory change is not always inside a run — a user editing the panel is not — so
    // `memory` is the fallback correlation id, the same shape the MCP host uses.
    runId: info.runId ?? 'memory',
    kind: 'memory_superseded',
    payload: {
      trigger: info.trigger,
      reason: info.reason,
      supersededId: info.closed.id,
      kind: info.closed.kind,
      ...(info.closed.key !== undefined ? { key: info.closed.key } : {}),
      ...(info.closed.subject !== undefined ? { subject: info.closed.subject } : {}),
      validFrom: info.closed.validFrom,
      validTo: info.closed.validTo,
      ...(info.replacement !== null ? { replacementId: info.replacement.id } : {}),
    },
  })
}

/** Explicitly supersede one entry, emitting the event. What the panel calls. */
export async function supersedeEntry(options: {
  store: MemoryStore
  id: string
  reason: string
  replacement?: MemoryEntryInput
  events?: MemoryEventSink
  runId?: string
}): Promise<SupersedeResult> {
  const result = await options.store.supersede({
    id: options.id,
    reason: options.reason,
    ...(options.replacement !== undefined ? { replacement: options.replacement } : {}),
  })
  if (result.ok) {
    await emitSuperseded(options.events, {
      runId: options.runId,
      closed: result.closed,
      replacement: result.replacement,
      reason: options.reason,
      trigger: 'explicit',
    })
  }
  return result
}

/** Every kind, for a surface that wants to offer them all. */
export const ALL_MEMORY_KINDS: readonly MemoryKind[] = MEMORY_KINDS
