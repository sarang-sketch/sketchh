// The versioned memory store: append-only JSONL, with superseding that closes a window
// rather than editing a row.
//
// ── APPEND-ONLY, BY CONSTRUCTION AND NOT BY CONVENTION ─────────────────────
//
// The only writes this file performs are `mkdir` and `appendFile`. There is no
// `writeFile`, no `truncate`, and no read-modify-write anywhere in it — the same
// guarantee `events/store.ts` makes, enforced the same way, and asserted by a test that
// reads this source.
//
// That forces a design decision on superseding. Closing an entry's `validTo` cannot mean
// rewriting its line, so it appends a CLOSE record instead:
//
//   { op: 'add',   entry: {...} }              the entry, open
//   { op: 'close', id, validTo, reason, by }   the window shutting
//
// `readAll` replays the ops in file order and folds them into current entries. Order is
// positional — line order within a file, lexicographic date order across files — exactly
// as the event log does it, and for the same reason: `ts` alone cannot order two records
// written in the same millisecond.
//
// ── WHY NOT ONE ROW PER VERSION WITH NO CLOSE OP ───────────────────────────
//
// Because `validTo` on the OLD row is what makes "what did we believe in March" a lookup
// rather than an inference. Writing only the new row would mean deriving the old row's
// end from the next row's start, which breaks the moment two entries with the same key
// are added out of order, or one is expired without a replacement.
//
// ── THE SAME INTERFACE FOR BOTH IMPLEMENTATIONS ────────────────────────────
//
// Requirement 21.7 asks that the existing in-memory implementation stay usable as the
// test double. `MemoryStore` is that interface; `JsonlMemoryStore` persists and
// `InMemoryStore` does not, and a test passing against the second is a real test of the
// contract because superseding, expiry and validity are implemented ONCE over a shared
// fold (`applyOps`) that both use.
//
// Validates: Requirements 21.1, 21.2, 21.3, 21.7

import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ensureStateDir } from '../workspace/state-dir.js'
import { newEventId } from '../events/ids.js'
import {
  asMemoryEntry,
  isCurrent,
  type MemoryEntry,
  type MemoryEntryInput,
  type MemoryKind,
} from './entries.js'

/** `<baseDir>/.sketch/memory`. */
export function memoryDir(baseDir: string): string {
  return join(baseDir, '.sketch', 'memory')
}

/** An `add`: a new entry, open at the moment it was written. */
export interface AddOp {
  op: 'add'
  seq: number
  entry: MemoryEntry
}

/** A `close`: one entry's window shutting, with the reason it shut. */
export interface CloseOp {
  op: 'close'
  seq: number
  id: string
  validTo: number
  /** Required. See the note on `MemoryEntry.reason`. */
  reason: string
  /** The entry that replaced it, when a replacement is what closed it. */
  by?: string
}

export type MemoryOp = AddOp | CloseOp

/** Structural validation of one line. A bad line is skipped and counted, never fatal. */
export function asMemoryOp(value: unknown): MemoryOp | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const seq = typeof record['seq'] === 'number' ? record['seq'] : 0

  if (record['op'] === 'add') {
    const entry = asMemoryEntry(record['entry'])
    return entry === null ? null : { op: 'add', seq, entry }
  }
  if (record['op'] === 'close') {
    if (typeof record['id'] !== 'string' || record['id'] === '') return null
    if (typeof record['validTo'] !== 'number' || !Number.isFinite(record['validTo'])) return null
    if (typeof record['reason'] !== 'string') return null
    const close: CloseOp = {
      op: 'close',
      seq,
      id: record['id'],
      validTo: record['validTo'],
      reason: record['reason'],
    }
    if (typeof record['by'] === 'string') close.by = record['by']
    return close
  }
  return null
}

/**
 * Fold ops into entries, in op order.
 *
 * THE ONE PLACE the semantics of add-then-close live, so the persistent and in-memory
 * stores cannot drift. A `close` for an unknown id is ignored rather than throwing: a
 * partially copied log is a real situation, and half a memory is better than none.
 */
export function applyOps(ops: readonly MemoryOp[]): MemoryEntry[] {
  const byId = new Map<string, MemoryEntry>()
  const order: string[] = []

  for (const op of ops) {
    if (op.op === 'add') {
      if (!byId.has(op.entry.id)) order.push(op.entry.id)
      // A re-added id replaces the earlier record. Not expected, but the later line
      // wins for the same reason the later line wins everywhere else in this codebase.
      byId.set(op.entry.id, { ...op.entry })
      continue
    }
    const existing = byId.get(op.id)
    if (existing === undefined) continue
    existing.validTo = op.validTo
    existing.reason = op.reason
    if (op.by !== undefined) existing.supersededBy = op.by
  }

  return order.map((id) => byId.get(id)!).filter((entry): entry is MemoryEntry => entry !== undefined)
}

export interface ReadMemoryResult {
  entries: MemoryEntry[]
  /** Lines that could not be parsed or did not match the shape. Reported, not absorbed. */
  skipped: number
}

export interface MemoryQuery {
  kind?: MemoryKind
  key?: string
  subject?: string
  /** Only entries valid at this instant. Omitted returns every entry, live or not. */
  at?: number
  /** Only entries still valid now. Shorthand for `at: Date.now()`. */
  currentOnly?: boolean
}

export interface SupersedeRequest {
  /** The entry being replaced. */
  id: string
  /** Why. Required — see `MemoryEntry.reason`. */
  reason: string
  /** The replacement, when there is one. Absent means simple expiry. */
  replacement?: MemoryEntryInput
}

export interface SupersedeResult {
  ok: boolean
  /** The closed entry, as it now reads. Null when the id was unknown. */
  closed: MemoryEntry | null
  /** The replacement, when one was written. */
  replacement: MemoryEntry | null
  reason: string | null
}

/**
 * The store seam. Both implementations satisfy it, and the hygiene and retrieval layers
 * are written against it so neither knows whether it is talking to disk.
 */
export interface MemoryStore {
  /** Append an entry. Returns it with the id and window the store assigned. */
  add(input: MemoryEntryInput): Promise<MemoryEntry>
  /** Every entry ever written, in write order, live or not. */
  all(): Promise<MemoryEntry[]>
  /** Entries matching a query. */
  query(query?: MemoryQuery): Promise<MemoryEntry[]>
  /** One entry by id, live or not. */
  get(id: string): Promise<MemoryEntry | null>
  /** Close an entry's window, optionally writing its replacement. */
  supersede(request: SupersedeRequest): Promise<SupersedeResult>
}

export interface MemoryStoreOptions {
  clock?: () => number
  ids?: () => string
}

/** Shared implementation of everything that is not I/O. */
abstract class BaseMemoryStore implements MemoryStore {
  protected readonly clock: () => number
  protected readonly ids: () => string

  constructor(options: MemoryStoreOptions = {}) {
    this.clock = options.clock ?? (() => Date.now())
    this.ids = options.ids ?? newEventId
  }

  protected abstract append(op: MemoryOp): Promise<void>
  protected abstract nextSeq(): number
  abstract all(): Promise<MemoryEntry[]>

  async add(input: MemoryEntryInput): Promise<MemoryEntry> {
    const entry = this.materialise(input)
    await this.append({ op: 'add', seq: this.nextSeq(), entry })
    return entry
  }

  /** Build the stored record. The store owns `id` and the window, never the caller. */
  protected materialise(input: MemoryEntryInput): MemoryEntry {
    const entry: MemoryEntry = {
      id: this.ids(),
      kind: input.kind,
      text: input.text,
      validFrom: input.validFrom ?? this.clock(),
      validTo: null,
      source: input.source ?? 'run',
    }
    if (input.key !== undefined) entry.key = input.key
    if (input.subject !== undefined) entry.subject = input.subject
    if (input.tags !== undefined && input.tags.length > 0) entry.tags = [...input.tags]
    if (input.runId !== undefined) entry.runId = input.runId
    if (input.data !== undefined) entry.data = input.data
    return entry
  }

  async get(id: string): Promise<MemoryEntry | null> {
    return (await this.all()).find((entry) => entry.id === id) ?? null
  }

  async query(query: MemoryQuery = {}): Promise<MemoryEntry[]> {
    const at = query.at ?? (query.currentOnly === true ? this.clock() : undefined)
    return (await this.all()).filter((entry) => {
      if (query.kind !== undefined && entry.kind !== query.kind) return false
      if (query.key !== undefined && entry.key !== query.key) return false
      if (query.subject !== undefined && entry.subject !== query.subject) return false
      if (at !== undefined && !isCurrent(entry, at)) return false
      return true
    })
  }

  async supersede(request: SupersedeRequest): Promise<SupersedeResult> {
    const existing = await this.get(request.id)
    if (existing === null) {
      return {
        ok: false,
        closed: null,
        replacement: null,
        reason: `no memory entry with id ${request.id}`,
      }
    }
    if (existing.validTo !== null) {
      // Already closed. Refused rather than re-closed, because a second close would
      // overwrite the first one's reason and lose why it actually happened.
      return {
        ok: false,
        closed: existing,
        replacement: null,
        reason: `entry ${request.id} was already superseded${existing.reason === undefined ? '' : `: ${existing.reason}`}`,
      }
    }

    const at = this.clock()

    // ORDER MATTERS: the replacement is written FIRST, so the close op can name it and a
    // reader replaying the log never sees a window closed against an entry that does not
    // exist yet.
    let replacement: MemoryEntry | null = null
    if (request.replacement !== undefined) {
      replacement = this.materialise({ ...request.replacement, validFrom: at })
      replacement.supersedes = existing.id
      await this.append({ op: 'add', seq: this.nextSeq(), entry: replacement })
    }

    await this.append({
      op: 'close',
      seq: this.nextSeq(),
      id: existing.id,
      validTo: at,
      reason: request.reason,
      ...(replacement !== null ? { by: replacement.id } : {}),
    })

    const closed: MemoryEntry = {
      ...existing,
      validTo: at,
      reason: request.reason,
      ...(replacement !== null ? { supersededBy: replacement.id } : {}),
    }
    return { ok: true, closed, replacement, reason: null }
  }
}

export interface JsonlMemoryStoreOptions extends MemoryStoreOptions {
  /** Project root. Memory lands in `<baseDir>/.sketch/memory/<YYYY-MM-DD>.jsonl`. */
  baseDir: string
  /** Override the directory outright, bypassing the `.sketch/memory` convention. */
  dir?: string
}

/**
 * Append-only JSONL memory, one file per UTC day.
 *
 * NO LINE IS EVER REWRITTEN. `mkdir` and `appendFile` are the only writes, which a
 * source-level test asserts — the same guard the event store has, because "append-only"
 * that depends on nobody adding a `writeFile` later is not a guarantee.
 */
export class JsonlMemoryStore extends BaseMemoryStore {
  readonly #dir: string
  readonly #stateBase: string | undefined
  #seq = 0
  #dirReady = false

  constructor(options: JsonlMemoryStoreOptions) {
    super(options)
    this.#dir = options.dir ?? memoryDir(options.baseDir)
    this.#stateBase = options.dir === undefined ? options.baseDir : undefined
  }

  get directory(): string {
    return this.#dir
  }

  /** The file a timestamp belongs to. UTC, so the name is host-independent. */
  fileFor(ts: number): string {
    return join(this.#dir, `${new Date(ts).toISOString().slice(0, 10)}.jsonl`)
  }

  protected nextSeq(): number {
    return ++this.#seq
  }

  protected async append(op: MemoryOp): Promise<void> {
    if (!this.#dirReady) {
      // The self-ignore marker first, so a project that writes one entry still gets it
      // and `.sketch/memory` never shows up as an untracked change.
      if (this.#stateBase !== undefined) await ensureStateDir(this.#stateBase)
      await mkdir(this.#dir, { recursive: true })
      this.#dirReady = true
    }
    const ts = op.op === 'add' ? op.entry.validFrom : op.validTo
    // One append, one line. Never writeFile, never truncate.
    await appendFile(this.fileFor(ts), `${JSON.stringify(op)}\n`, 'utf8')
  }

  /** Every op on disk, folded, with the malformed-line count surfaced. */
  async readAllDetailed(): Promise<ReadMemoryResult> {
    const ops: MemoryOp[] = []
    let skipped = 0

    for (const file of await this.#listFiles()) {
      let text: string
      try {
        text = await readFile(join(this.#dir, file), 'utf8')
      } catch {
        // A file that vanished or is unreadable must not sink the whole read.
        continue
      }
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() === '') continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          skipped++
          continue
        }
        const op = asMemoryOp(parsed)
        if (op === null) {
          skipped++
          continue
        }
        ops.push(op)
      }
    }

    return { entries: applyOps(ops), skipped }
  }

  async all(): Promise<MemoryEntry[]> {
    return (await this.readAllDetailed()).entries
  }

  /** `.jsonl` files in date order. A missing directory reads as empty, not as an error. */
  async #listFiles(): Promise<string[]> {
    try {
      return (await readdir(this.#dir)).filter((f) => f.endsWith('.jsonl')).sort()
    } catch {
      return []
    }
  }
}

/**
 * In-memory store. The test double Requirement 21.7 asks for, behind the same interface.
 *
 * It keeps the OPS, not the entries, and folds them through the same `applyOps` the disk
 * store uses. That is the point: a test against this one exercises the real supersede
 * semantics rather than a simplified copy of them.
 */
export class InMemoryStore extends BaseMemoryStore {
  readonly #ops: MemoryOp[] = []
  #seq = 0

  protected nextSeq(): number {
    return ++this.#seq
  }

  protected async append(op: MemoryOp): Promise<void> {
    this.#ops.push(op)
  }

  async all(): Promise<MemoryEntry[]> {
    return applyOps(this.#ops)
  }

  /** The raw op log, for a test that wants to assert nothing was rewritten. */
  get ops(): readonly MemoryOp[] {
    return this.#ops
  }
}
