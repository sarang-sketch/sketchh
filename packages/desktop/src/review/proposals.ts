// What the event log says about proposed edits, and nothing else.
//
// The review surface is a projection of the event stream, exactly like the Timeline:
// an `edit_proposed` event opens a proposal, and a later `edit_accepted` or
// `edit_rejected` closes it. Nothing in this module holds state, reads a file, or
// renders — so "which proposal is still open", "which hunks does it contain" and
// "what does a verdict event look like" are all testable without React.
//
// ── THE PAYLOAD IS READ DEFENSIVELY, AND ITS GAPS ARE REPORTED ───────────────
//
// `edit_proposed` is emitted by the loop before any write (packages/core/src/loop/
// agent.ts). Current engine events carry the real unified patch plus a byte summary
// per file. The summary-only shape is still accepted for legacy or malformed event
// logs and is reported AS a summary with no diff; drawing an empty diff would read
// as "no changes" when the truth is "this event never said what changed"
// (Requirement 27.5's rule, applied here).
//
// Every field is read with a type check. These payloads are `Record<string, unknown>`
// on the wire and reach here from a subprocess.
//
// Validates: Requirements 16.1, 16.2, 16.3

import { toAbsolutePath } from '../editor/paths'
import type { SketchEvent } from '../lib/contracts'
import { parseUnifiedDiff, type DiffDiagnostic, type Hunk } from './diffEngine'

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** The byte summary the loop emits per edit. Present without a patch, today. */
export interface EditSummary {
  /** True when the edit replaces the whole file rather than a search hit. */
  wholeFile: boolean | null
  searchBytes: number | null
  replaceBytes: number | null
}

/** One file a proposal touches. */
export interface ProposedFile {
  /** The path exactly as the event stated it — usually project-relative. */
  statedPath: string
  /** That path resolved against the open project root. The key into `files`. */
  path: string
  /** The patch text the event carried, or null when it carried none. */
  diff: string | null
  /** Parsed hunks. Empty when there was no patch, or when the patch would not parse. */
  hunks: Hunk[]
  /** Why the patch would not parse. Never swallowed. */
  parseError: DiffDiagnostic | null
  summary: EditSummary | null
}

export type ProposalOutcome =
  | { state: 'open' }
  | { state: 'accepted'; at: number; hunks: number[] | null; path: string | null }
  | { state: 'rejected'; at: number; reason: string; path: string | null }

/** One `edit_proposed` event, plus whatever the log later said about it. */
export interface Proposal {
  /** The `edit_proposed` event's own id. This is the proposal's identity. */
  id: string
  runId: string
  ts: number
  iteration: number | null
  files: ProposedFile[]
  outcome: ProposalOutcome
}

/** Stated when a verdict event carried no reason of its own. Never invented detail. */
export const REASON_MISSING = 'no reason was recorded on the event'

/** Used when the reviewer rejects without typing one. A reason is still required. */
export const DEFAULT_REJECT_REASON = 'rejected in review; no reason given'

// ---------------------------------------------------------------------------
// Payload readers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readString(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBoolean(source: Record<string, unknown>, key: string): boolean | null {
  const value = source[key]
  return typeof value === 'boolean' ? value : null
}

/** Hunk indexes off a verdict payload. Null when the event named none. */
export function readHunkIndexes(payload: Record<string, unknown>): number[] | null {
  const value = payload['hunks'] ?? payload['hunkIndexes']
  if (!Array.isArray(value)) return null
  const out: number[] = []
  for (const entry of value) {
    if (typeof entry === 'number' && Number.isInteger(entry) && entry >= 0) out.push(entry)
  }
  return out
}

function summaryOf(source: Record<string, unknown>): EditSummary | null {
  const wholeFile = readBoolean(source, 'wholeFile')
  const searchBytes = readNumber(source, 'searchBytes')
  const replaceBytes = readNumber(source, 'replaceBytes')
  if (wholeFile === null && searchBytes === null && replaceBytes === null) return null
  return { wholeFile, searchBytes, replaceBytes }
}

function fileFrom(source: Record<string, unknown>, root: string): ProposedFile | null {
  const statedPath = readString(source, 'path', 'file')
  if (statedPath === null) return null
  const diff = readString(source, 'diff', 'patch', 'unifiedDiff')

  let hunks: Hunk[] = []
  let parseError: DiffDiagnostic | null = null
  if (diff !== null) {
    const parsed = parseUnifiedDiff(diff)
    if (parsed.ok) hunks = parsed.hunks
    else parseError = parsed.error
  }

  return {
    statedPath,
    path: root === '' ? statedPath : toAbsolutePath(root, statedPath),
    diff,
    hunks,
    parseError,
    summary: summaryOf(source),
  }
}

/**
 * The files one `edit_proposed` payload describes.
 *
 * Two shapes are accepted because two exist: the loop's `edits: [{ path, … }]`
 * array, and a single-file payload that states `path` at the top level. A payload
 * that names no path at all yields no files, and the caller renders that honestly
 * rather than as an empty diff.
 */
function filesFrom(payload: Record<string, unknown>, root: string): ProposedFile[] {
  const edits = payload['edits']
  if (Array.isArray(edits)) {
    const out: ProposedFile[] = []
    for (const entry of edits) {
      const record = asRecord(entry)
      if (record === null) continue
      // A per-edit payload may omit the patch while the event carries one for the
      // whole proposal. Reading the outer one as a fallback keeps a single-file
      // proposal reviewable whichever way it was shaped.
      const merged: Record<string, unknown> = { ...record }
      if (readString(record, 'diff', 'patch', 'unifiedDiff') === null) {
        const outer = readString(payload, 'diff', 'patch', 'unifiedDiff')
        if (outer !== null && edits.length === 1) merged['diff'] = outer
      }
      const file = fileFrom(merged, root)
      if (file !== null) out.push(file)
    }
    return out
  }

  const single = fileFrom(payload, root)
  return single === null ? [] : [single]
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Match a verdict event to the proposal it settles.
 *
 * `proposalId` is authoritative when the event carries one — the review surface
 * always sets it. The engine's own `edit_accepted` does not, so a verdict is
 * otherwise matched to the most recent OPEN proposal in the same run that mentions
 * the same path. That matters: when the loop writes a file itself, the proposal is
 * already settled and the review surface must not offer to apply it a second time.
 */
function targetOf(
  proposals: readonly Proposal[],
  event: SketchEvent,
  root: string,
): Proposal | undefined {
  const declared = readString(event.payload, 'proposalId')
  if (declared !== null) {
    const exact = proposals.find((proposal) => proposal.id === declared)
    if (exact) return exact
  }

  const statedPath = readString(event.payload, 'path')
  const absolute = statedPath === null || root === '' ? statedPath : toAbsolutePath(root, statedPath)

  let found: Proposal | undefined
  for (const proposal of proposals) {
    if (proposal.outcome.state !== 'open') continue
    if (proposal.runId !== event.runId) continue
    if (proposal.ts > event.ts) continue
    if (
      statedPath !== null &&
      !proposal.files.some((file) => file.statedPath === statedPath || file.path === absolute)
    ) {
      continue
    }
    found = proposal
  }
  return found
}

/**
 * Every proposal the log describes, oldest first.
 *
 * `root` resolves the project-relative paths the engine reports. An empty root means
 * no project is open, in which case paths are kept exactly as stated rather than
 * resolved against nothing.
 */
export function proposalsFrom(events: readonly SketchEvent[], root: string): Proposal[] {
  const proposals: Proposal[] = []

  for (const event of events) {
    if (event.kind === 'edit_proposed') {
      proposals.push({
        id: event.id,
        runId: event.runId,
        ts: event.ts,
        iteration: readNumber(event.payload, 'iteration'),
        files: filesFrom(event.payload, root),
        outcome: { state: 'open' },
      })
      continue
    }

    if (event.kind !== 'edit_accepted' && event.kind !== 'edit_rejected') continue

    const target = targetOf(proposals, event, root)
    if (target === undefined) continue

    const path = readString(event.payload, 'path')
    target.outcome =
      event.kind === 'edit_accepted'
        ? { state: 'accepted', at: event.ts, hunks: readHunkIndexes(event.payload), path }
        : {
            state: 'rejected',
            at: event.ts,
            reason: readString(event.payload, 'reason') ?? REASON_MISSING,
            path,
          }
  }

  return proposals
}

/** The newest proposal still awaiting a verdict, or undefined. */
export function newestOpen(proposals: readonly Proposal[]): Proposal | undefined {
  for (let i = proposals.length - 1; i >= 0; i--) {
    const proposal = proposals[i]!
    if (proposal.outcome.state === 'open') return proposal
  }
  return undefined
}

/**
 * True when this file can actually be reviewed hunk by hunk.
 *
 * False for a file the event named without a patch, and for a patch that would not
 * parse. Both are reported to the reviewer as themselves.
 */
export function isReviewable(file: ProposedFile): boolean {
  return file.hunks.length > 0
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** The `@@` header line for a hunk, rebuilt from the parsed numbers. */
export function hunkLabel(hunk: Hunk): string {
  const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
  return hunk.heading === '' ? header : `${header} ${hunk.heading}`
}

/** The character a diff line carries in a patch. Rendered as text, never as HTML. */
export function linePrefix(kind: Hunk['lines'][number]['kind']): string {
  return kind === 'add' ? '+' : kind === 'remove' ? '-' : ' '
}

/**
 * A refusal from the diff engine, in a sentence a reviewer can act on.
 *
 * The diagnostic already names the hunk and the line; what this adds is WHY the
 * reviewer is seeing it — the proposal was computed against a version of the file
 * that is no longer what is on disk. Nothing is written when this appears.
 */
export function describeDiagnostic(path: string, error: DiffDiagnostic): string {
  const which = error.hunkIndex === undefined ? '' : ` (hunk ${error.hunkIndex + 1})`
  const lead =
    error.code === 'context-mismatch'
      ? `This proposal no longer matches ${path} on disk${which}.`
      : `This proposal cannot be applied to ${path}${which}.`
  return `${lead} ${error.message}. Nothing was written.`
}

/** The same sentence for a patch that would not parse. */
export function describeParseError(path: string, error: DiffDiagnostic): string {
  return `The patch for ${path} could not be read (${error.code}): ${error.message}. There is nothing to review until the proposal carries a readable diff.`
}

// ---------------------------------------------------------------------------
// Verdict payloads
// ---------------------------------------------------------------------------

export interface VerdictSubject {
  proposalId: string
  /** The path as the proposal stated it, so the payload matches the proposal. */
  path: string
  /** Indexes into the file's hunk array. */
  hunks: number[]
}

/** The payload of an `edit_accepted` emitted by the review surface. */
export function acceptedPayload(
  subject: VerdictSubject,
  bytes: number,
): Record<string, unknown> {
  return {
    proposalId: subject.proposalId,
    path: subject.path,
    hunks: [...subject.hunks],
    bytes,
    source: 'review',
  }
}

/** The payload of an `edit_rejected`. A reason is not optional (Requirement 16.3). */
export function rejectedPayload(
  subject: VerdictSubject,
  reason: string,
): Record<string, unknown> {
  const stated = reason.trim()
  return {
    proposalId: subject.proposalId,
    path: subject.path,
    hunks: [...subject.hunks],
    reason: stated === '' ? DEFAULT_REJECT_REASON : stated,
    source: 'review',
  }
}

/**
 * An id for an event this window originated.
 *
 * The engine mints event ids with `node:crypto` (packages/core/src/events/ids.ts),
 * which the renderer does not have. `crypto.randomUUID` is the same guarantee where
 * the webview provides it; the fallback is only reached in an environment that has
 * no crypto at all, and it still cannot collide with an engine id because of the
 * prefix.
 */
export function newReviewEventId(): string {
  const webcrypto = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (typeof webcrypto?.randomUUID === 'function') return `review-${webcrypto.randomUUID()}`
  return `review-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}
