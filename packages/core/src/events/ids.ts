// Identifier generation for the event log.
//
// The event log is the spine of the system: the Timeline, replay, cost
// accounting, eval capture, and benchmark reporting are all projections of one
// append-only stream. That makes identifier quality a correctness concern, not
// a cosmetic one. Two requirements fall out of it:
//
//   1. Run ids must be collision-resistant ACROSS PROCESSES. A module-global
//      counter (the `t1`, `t2` pattern) collides the moment two processes write
//      to the same log, which is exactly what happens when the CLI sidecar and
//      a second `sketch` invocation share a project directory.
//   2. Run ids should sort lexicographically in creation order, so a directory
//      listing, a `sort`, or a naive string comparison in the UI yields
//      chronological order without parsing.
//
// Deliberately no module-global mutable state lives in this file.
//
// Validates: Requirements 3.9

import { randomBytes, randomUUID } from "node:crypto";

/**
 * Radix and width of the timestamp prefix.
 *
 * Base36 keeps the prefix short while remaining in the ASCII range where
 * `0-9` sort before `a-z`, so a fixed-width base36 number sorts identically as
 * a string and as a number. Nine characters covers up to 36^9 - 1 ms
 * (≈ year 5138); past that the prefix would widen and lexicographic ordering
 * against older ids would degrade. Documented, not defended against.
 */
const TS_RADIX = 36;
const TS_WIDTH = 9;

/** 64 bits of CSPRNG suffix — enough that same-millisecond collisions are negligible. */
const RANDOM_BYTES = 8;

/**
 * A time-sortable, collision-resistant run identifier.
 *
 * Format: `r<ts><-><rand>`
 *   - `r`    — a fixed prefix so the id is never mistaken for a bare number and
 *              never starts with a character that shell tooling treats specially.
 *   - `ts`   — `Date.now()` in base36, zero-padded to 9 characters. Fixed width
 *              is what makes lexicographic order equal chronological order.
 *   - `rand` — 16 lowercase hex characters (8 CSPRNG bytes) from `node:crypto`.
 *
 * Example: `r0m4k7x2p-9f3c1d7a55be0421`
 *
 * Sortable because the only varying leading field is a fixed-width monotonic
 * clock. Collision-resistant because ids minted in the same millisecond still
 * differ in 64 bits of cryptographic randomness, independent of process, host,
 * or import order.
 *
 * @param now Injectable clock, in epoch milliseconds, for deterministic tests.
 */
export function newRunId(now: number = Date.now()): string {
  const ms = Number.isFinite(now) ? Math.max(0, Math.floor(now)) : 0;
  const ts = ms.toString(TS_RADIX).padStart(TS_WIDTH, "0");
  return `r${ts}-${randomBytes(RANDOM_BYTES).toString("hex")}`;
}

/**
 * An event identifier. Events are ordered by their position in the log, not by
 * their id, so a plain UUIDv4 is the right tool: unique, opaque, and free of
 * any ordering promise it cannot keep.
 */
export function newEventId(): string {
  return randomUUID();
}
