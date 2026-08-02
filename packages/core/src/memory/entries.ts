// What project memory remembers, and the validity window every row carries.
//
// ── WHY EVERY ROW IS VERSIONED ──────────────────────────────────────────────
//
// Requirement 21.2: every row carries `validFrom` and `validTo`. That is not
// bookkeeping, it is the difference between memory that compounds and memory that rots.
// A project's decisions change — "we use REST" becomes "we use GraphQL" — and a store
// that overwrites loses the fact that the older decision was ever true, which is exactly
// the fact a developer asking "why is this file like this?" needs.
//
// So superseding APPENDS a new row and CLOSES the old one's window. It never edits in
// place. The same discipline as the event log, for the same reason: a history you can
// rewrite is a history you cannot trust.
//
// ── THE NINE KINDS ARE THE CONTRACT'S NINE ──────────────────────────────────
//
// Requirement 21.1 names them: decisions, architecture, summarised conversations,
// standards, preferences, style, bugs, performance history, test history. All nine are
// here and the union is closed, so a caller cannot invent a tenth by typo — the same
// fail-closed choice the capability vocabulary makes.
//
// ── WHY `text` IS THE PAYLOAD, NOT A PER-KIND SHAPE ─────────────────────────
//
// Nine kinds with nine record shapes would need nine retrievers, nine renderers and nine
// migration paths. Retrieval works on prose, the panel shows prose, and the model reads
// prose. So each entry is `text` plus structured metadata that retrieval and hygiene
// actually use — `kind`, `key`, `tags`, `subject`. Anything genuinely structured (a test
// run's pass/fail) lives in `data`, which nothing indexes and nothing is required to
// understand.
//
// Validates: Requirements 21.1, 21.2, 21.7

/**
 * The nine kinds Requirement 21.1 names. Closed on purpose: an unrecognised kind is a
 * typo, and accepting it would put a row in the store that no retriever looks for.
 */
export const MEMORY_KINDS = [
  /** A choice made and why. The highest-value kind, and what 21.6 is about. */
  'decision',
  /** How the system is put together. Longer-lived than a decision. */
  'architecture',
  /** A summarised conversation, so a session's reasoning survives its transcript. */
  'conversation',
  /** A rule the project follows, e.g. "tests live beside the code they test". */
  'standard',
  /** What the user wants, as opposed to what the project requires. */
  'preference',
  /** Formatting and naming, kept apart from `standard` so a linter can own it. */
  'style',
  /** A bug and its fix, so the same mistake is not made twice. */
  'bug',
  /** A measurement over time. Never a single number without its date. */
  'performance',
  /** A verification outcome. The raw history behind "the tests were passing". */
  'test',
] as const

export type MemoryKind = (typeof MEMORY_KINDS)[number]

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value)
}

/** Plain-language descriptions, for a panel and for a lint message. */
export const MEMORY_KIND_DESCRIPTIONS: Readonly<Record<MemoryKind, string>> = Object.freeze({
  decision: 'A choice this project made, and why',
  architecture: 'How the system is put together',
  conversation: 'A summarised conversation',
  standard: 'A rule this project follows',
  preference: 'Something the user prefers',
  style: 'Formatting and naming',
  bug: 'A bug and how it was fixed',
  performance: 'A performance measurement',
  test: 'A verification outcome',
})

/** Sentinel for "still true". A number would need a magic far-future date. */
export const STILL_VALID = null

/**
 * One remembered thing, with the window in which it was true.
 *
 * `validTo === null` means still valid. A row is never mutated after it is written; a
 * later fact appends a new row and a supersede appends a CLOSING record (see
 * `store.ts`), so the file remains append-only and the history remains auditable.
 */
export interface MemoryEntry {
  id: string
  kind: MemoryKind
  /**
   * The thing remembered, in prose. What retrieval searches and the panel shows.
   *
   * Prose rather than a per-kind shape on purpose — see the header. A model reads this,
   * so it should read like a sentence a person wrote.
   */
  text: string
  /**
   * Optional identity WITHIN a kind, e.g. `test-location` for a standard.
   *
   * This is what makes automatic superseding possible: writing a second `standard` with
   * the same key is an update, not a contradiction to be flagged. Without it, hygiene
   * would have to guess from the text, and guessing is how a memory store starts
   * deleting things it should have kept.
   */
  key?: string
  /**
   * What this is about — a file path, a module, a subsystem. Free-form.
   *
   * Used by retrieval as a matchable field and by the panel for grouping. NOT a
   * foreign key: memory must survive a rename without becoming unreadable.
   */
  subject?: string
  tags?: string[]
  /** When this became true. Epoch ms. */
  validFrom: number
  /** When it stopped being true, or null while it still is. */
  validTo: number | null
  /**
   * The entry that replaced this one, when one did.
   *
   * Set on the CLOSING record, so following the chain forwards is a lookup rather than
   * a scan.
   */
  supersededBy?: string
  /** The entry this one replaced, when it replaced one. */
  supersedes?: string
  /**
   * WHY it was superseded or expired. Requirement 21.3 asks for a recorded reason.
   *
   * Required by the API rather than optional, because "superseded" with no reason is
   * indistinguishable from a bug, and the reason is the only thing that tells a user
   * later whether the change was deliberate.
   */
  reason?: string
  /** The run that recorded this, when a run did. Null for a user's own entry. */
  runId?: string
  /** Where it came from. `user` entries are never auto-expired. */
  source: MemorySource
  /**
   * Structured extras. Nothing indexes this and nothing must understand it.
   *
   * The escape hatch that stops the nine kinds needing nine record shapes: a `test`
   * entry can carry `{ passed: false, stage: 'unit' }` here without every reader
   * learning about test runs.
   */
  data?: Record<string, unknown>
}

/**
 * Where an entry came from. Determines whether hygiene may touch it.
 *
 * The third value is spelled `imported`, not `import`, and that is not a style choice.
 * The zero-dependency guard (`test/deps.test.ts`) scans this package for
 * `import <quote>` literally, so the bare literal `'import'` reads to it as the `import`
 * KEYWORD followed by a quote — and it failed exactly that way when this file was first
 * written. Same shape as the retrieval stopword list, which had to stop containing the
 * quoted word `from`. The guard is right to be that literal: it is the thing standing
 * between this package and a silent dependency, so the DATA moves, never the guard.
 */
export type MemorySource =
  /** The user wrote it. Never auto-expired, never auto-superseded. */
  | 'user'
  /** A run recorded it. */
  | 'run'
  /** Brought in from `AGENTS.md`, a config file, or a migration. */
  | 'imported'

export function isMemorySource(value: unknown): value is MemorySource {
  return value === 'user' || value === 'run' || value === 'imported'
}

/** What a caller supplies. The store owns `id`, `validFrom`, and `validTo`. */
export interface MemoryEntryInput {
  kind: MemoryKind
  text: string
  key?: string
  subject?: string
  tags?: string[]
  runId?: string
  /** Defaults to `run`. A panel writing an entry passes `user`. */
  source?: MemorySource
  data?: Record<string, unknown>
  /**
   * Override the validity start, for importing history.
   *
   * Not for ordinary writes: a caller choosing its own clock is how two entries end up
   * claiming to be the newest.
   */
  validFrom?: number
}

/** True when the entry is valid at `at`. Half-open: `[validFrom, validTo)`. */
export function isValidAt(entry: MemoryEntry, at: number): boolean {
  if (at < entry.validFrom) return false
  return entry.validTo === null || at < entry.validTo
}

/** True when the entry is still valid now. */
export function isCurrent(entry: MemoryEntry, now: number = Date.now()): boolean {
  return isValidAt(entry, now)
}

/**
 * Structural validation of a parsed line.
 *
 * A line that is JSON but not an entry — a stray `{}`, a half-migrated record, another
 * tool's log — is treated exactly like a malformed line: skipped and counted. Same rule
 * as the event store, and for the same reason: one bad byte must not cost a project its
 * whole memory.
 */
export function asMemoryEntry(value: unknown): MemoryEntry | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>

  if (typeof record['id'] !== 'string' || record['id'] === '') return null
  if (!isMemoryKind(record['kind'])) return null
  if (typeof record['text'] !== 'string') return null
  if (typeof record['validFrom'] !== 'number' || !Number.isFinite(record['validFrom'])) return null

  const validTo = record['validTo']
  if (validTo !== null && (typeof validTo !== 'number' || !Number.isFinite(validTo))) return null
  if (!isMemorySource(record['source'])) return null

  const tags = record['tags']
  if (tags !== undefined && !(Array.isArray(tags) && tags.every((t) => typeof t === 'string'))) {
    return null
  }

  const entry: MemoryEntry = {
    id: record['id'],
    kind: record['kind'],
    text: record['text'],
    validFrom: record['validFrom'],
    validTo: validTo as number | null,
    source: record['source'],
  }
  if (typeof record['key'] === 'string') entry.key = record['key']
  if (typeof record['subject'] === 'string') entry.subject = record['subject']
  if (tags !== undefined) entry.tags = tags as string[]
  if (typeof record['supersededBy'] === 'string') entry.supersededBy = record['supersededBy']
  if (typeof record['supersedes'] === 'string') entry.supersedes = record['supersedes']
  if (typeof record['reason'] === 'string') entry.reason = record['reason']
  if (typeof record['runId'] === 'string') entry.runId = record['runId']
  const data = record['data']
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    entry.data = data as Record<string, unknown>
  }
  return entry
}

/** One line of a validity window, for a panel or a log message. */
export function describeWindow(entry: MemoryEntry, now: number = Date.now()): string {
  const from = new Date(entry.validFrom).toISOString().slice(0, 10)
  if (entry.validTo === null) {
    return `valid since ${from}`
  }
  const to = new Date(entry.validTo).toISOString().slice(0, 10)
  const closed = entry.validTo <= now ? 'superseded' : 'closes'
  return `valid ${from} to ${to} (${closed}${entry.reason === undefined ? '' : `: ${entry.reason}`})`
}
