// The event store — the spine of the system.
//
// The Timeline, replay, cost accounting, eval capture, and benchmark reporting
// are all projections of this one append-only stream. Nothing else gets a
// private log. Consequences that shaped this file:
//
// * `emit` takes a PARTIAL event (`{ runId, kind, payload }`) and the store
//   stamps `id` and `ts`. A call site cannot forget the id, cannot invent its own
//   clock, and cannot backdate an event. The clock and the id generator are
//   injected, so tests are fully deterministic.
// * Sanitation happens here, on the write path, so no call site can leak a key
//   into the log by forgetting to redact (Requirement 3.7).
// * The JSONL implementation only ever calls `appendFile` and `mkdir`. There is
//   no `writeFile`, no `truncate`, and no read-modify-write anywhere in this
//   file. That is what makes the log append-only by construction rather than by
//   convention (Requirement 3.5).
//
// EMISSION ORDER (Requirement 3.8)
// `ts` alone cannot order events: two events routinely share a millisecond, and
// a coarse or non-monotonic system clock can even move backwards. Order is
// therefore carried by position, not by time:
//   - within a file, physical line order IS append order, because the file is
//     only ever appended to;
//   - across files, the `<YYYY-MM-DD>.jsonl` name sorts lexicographically into
//     chronological order.
// `readAll` preserves both and deliberately does NOT sort by `ts`. Each record
// additionally persists a monotonic per-store `seq`, which lets a consumer
// detect interleaving from a second writer and provides a stable tiebreak when
// merging logs; `seq` is a storage-level field and is stripped before a
// `SketchEvent` is handed back, so the public shape stays exactly the contract
// in types.ts.
//
// Validates: Requirements 3.2, 3.5, 3.6, 3.7, 3.8

import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EventKind, SketchEvent } from "../types.js";
import { ensureStateDir } from "../workspace/state-dir.js";
import { newEventId } from "./ids.js";
import { sanitizePayload, secretsFromEnv } from "./redact.js";

/**
 * What a call site supplies. `id` and `ts` are the store's job.
 */
export interface EventInput {
  runId: string;
  kind: EventKind;
  payload?: Record<string, unknown>;
}

/**
 * The seam. `emit` may be synchronous (memory) or asynchronous (file), so it is
 * typed as either; callers that care about durability `await` it.
 */
export interface EventStore {
  emit(e: EventInput): Promise<void> | void;
  readAll(): Promise<SketchEvent[]>;
  forRun(runId: string): Promise<SketchEvent[]>;
}

/** Injectable seams shared by every implementation. */
export interface EventStoreOptions {
  /** Epoch-millisecond clock. Injected for deterministic tests. */
  clock?: () => number;
  /** Event id generator. Injected for deterministic tests. */
  ids?: () => string;
  /**
   * Known secret VALUES to strip from payloads. A function is re-read on every
   * emit, so a key resolved mid-run is still covered. Defaults to
   * credential-shaped values in `process.env`.
   */
  secrets?: readonly string[] | (() => readonly string[]);
}

/** `readAll` with the malformed-line count surfaced. */
export interface ReadResult {
  events: SketchEvent[];
  /** Lines that could not be parsed or did not match the event shape. */
  skipped: number;
}

/** On-disk record: a `SketchEvent` plus the storage-level sequence number. */
interface StoredRecord extends SketchEvent {
  seq: number;
}

function resolveSecrets(
  secrets: EventStoreOptions["secrets"],
): readonly string[] {
  return typeof secrets === "function" ? secrets() : secrets ?? [];
}

/**
 * Structural validation of a parsed line. A line that parses as JSON but is not
 * an event (a stray `{}`, a log line from another tool, a half-migrated record)
 * is treated exactly like a malformed line: skipped.
 */
function asEvent(value: unknown): SketchEvent | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") return null;
  if (typeof record.ts !== "number" || !Number.isFinite(record.ts)) return null;
  if (typeof record.runId !== "string") return null;
  if (typeof record.kind !== "string") return null;
  const payload = record.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  // `seq` is intentionally dropped: the public contract is types.ts, exactly.
  return {
    id: record.id,
    ts: record.ts,
    runId: record.runId,
    kind: record.kind as EventKind,
    payload: payload as Record<string, unknown>,
  };
}

/**
 * In-memory store for tests and for the eval harness, which does not want a
 * temp directory per case. Sanitizes on emit exactly as the file store does, so
 * a test that passes against this one is a real test of the redaction contract.
 */
export class MemoryEventStore implements EventStore {
  readonly #clock: () => number;
  readonly #ids: () => string;
  readonly #secrets: EventStoreOptions["secrets"];
  readonly #events: SketchEvent[] = [];

  constructor(options: EventStoreOptions = {}) {
    this.#clock = options.clock ?? (() => Date.now());
    this.#ids = options.ids ?? newEventId;
    this.#secrets = options.secrets ?? secretsFromEnv();
  }

  emit(input: EventInput): void {
    this.#events.push({
      id: this.#ids(),
      ts: this.#clock(),
      runId: input.runId,
      kind: input.kind,
      payload: sanitizePayload(input.payload ?? {}, resolveSecrets(this.#secrets)),
    });
  }

  async readAll(): Promise<SketchEvent[]> {
    // Copy: callers must not be able to mutate or reorder the log.
    return this.#events.map((e) => ({ ...e }));
  }

  async forRun(runId: string): Promise<SketchEvent[]> {
    return this.#events.filter((e) => e.runId === runId).map((e) => ({ ...e }));
  }

  /** Number of events held. Convenience for assertions. */
  get size(): number {
    return this.#events.length;
  }
}

export interface JsonlEventStoreOptions extends EventStoreOptions {
  /**
   * Project root. Events land in `<baseDir>/.sketch/events/<YYYY-MM-DD>.jsonl`.
   */
  baseDir: string;
  /** Override the events directory outright, bypassing the `.sketch/events` convention. */
  eventsDir?: string;
}

/**
 * Append-only JSONL store: one JSON object per line, one file per UTC day.
 *
 * NO LOG BYTE IS EVER REWRITTEN. The only writes this class performs against the
 * log are `mkdir` (recursive, once) and `appendFile`.
 *
 * One further write happens once, and it is not a log write: when the store uses
 * the `<baseDir>/.sketch/events` convention it asks `ensureStateDir` to drop a
 * self-ignore marker in `.sketch/`, so the engine's own log does not surface as an
 * untracked change in the project's `git status` (and hence in the Git panel). See
 * workspace/state-dir.ts. A store given an explicit `eventsDir` is somewhere of
 * the caller's choosing and gets no marker.
 */
export class JsonlEventStore implements EventStore {
  readonly #dir: string;
  /** Project root, when the `.sketch/events` convention is in use. */
  readonly #stateBase: string | undefined;
  readonly #clock: () => number;
  readonly #ids: () => string;
  readonly #secrets: EventStoreOptions["secrets"];
  /** Monotonic per-store sequence; persisted so emission order is auditable. */
  #seq = 0;
  #dirReady = false;

  constructor(options: JsonlEventStoreOptions) {
    this.#dir = options.eventsDir ?? join(options.baseDir, ".sketch", "events");
    this.#stateBase = options.eventsDir === undefined ? options.baseDir : undefined;
    this.#clock = options.clock ?? (() => Date.now());
    this.#ids = options.ids ?? newEventId;
    this.#secrets = options.secrets ?? secretsFromEnv();
  }

  /** The directory events are written to. */
  get directory(): string {
    return this.#dir;
  }

  /** The file a given timestamp belongs to. UTC, so the name is host-independent. */
  fileFor(ts: number): string {
    const date = new Date(ts).toISOString().slice(0, 10);
    return join(this.#dir, `${date}.jsonl`);
  }

  async emit(input: EventInput): Promise<void> {
    const ts = this.#clock();
    const record: StoredRecord = {
      id: this.#ids(),
      ts,
      runId: input.runId,
      kind: input.kind,
      payload: sanitizePayload(input.payload ?? {}, resolveSecrets(this.#secrets)),
      seq: ++this.#seq,
    };

    if (!this.#dirReady) {
      // The marker first, so a project that only ever emits one event still gets it.
      if (this.#stateBase !== undefined) await ensureStateDir(this.#stateBase);
      await mkdir(this.#dir, { recursive: true });
      this.#dirReady = true;
    }

    // One append, one line. Never writeFile, never truncate.
    await appendFile(this.fileFor(ts), `${JSON.stringify(record)}\n`, "utf8");
  }

  /**
   * Every event on disk, in emission order: files in date order, lines in
   * physical (append) order. Malformed lines are skipped and counted; a bad line
   * never throws and never stops the read (Requirement 3.6).
   */
  async readAllDetailed(): Promise<ReadResult> {
    const events: SketchEvent[] = [];
    let skipped = 0;

    for (const file of await this.#listFiles()) {
      let text: string;
      try {
        text = await readFile(join(this.#dir, file), "utf8");
      } catch {
        // A file that vanished or is unreadable must not sink the whole read.
        continue;
      }
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() === "") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          skipped++; // Malformed JSON, e.g. a line truncated by a crash mid-write.
          continue;
        }
        const event = asEvent(parsed);
        if (event === null) {
          skipped++;
          continue;
        }
        events.push(event);
      }
    }

    return { events, skipped };
  }

  async readAll(): Promise<SketchEvent[]> {
    return (await this.readAllDetailed()).events;
  }

  async forRun(runId: string): Promise<SketchEvent[]> {
    // readAll is already in emission order, so filtering preserves it.
    return (await this.readAll()).filter((e) => e.runId === runId);
  }

  /** `.jsonl` files in date order. A missing directory reads as empty, not as an error. */
  async #listFiles(): Promise<string[]> {
    try {
      const entries = await readdir(this.#dir);
      return entries.filter((f) => f.endsWith(".jsonl")).sort();
    } catch {
      return [];
    }
  }
}
