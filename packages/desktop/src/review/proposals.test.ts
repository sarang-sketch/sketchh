// The review surface's projection of the event log, tested without React.
//
// Nothing is mocked. `proposalsFrom` is the real function, the diffs below are real
// unified diffs parsed by the engine's real parser, and the events are shaped the way
// the loop shapes them (packages/core/src/loop/agent.ts emits `edits: [{ path, …}]`).
//
// Validates: Requirements 16.1, 16.2, 16.3

import { describe, expect, it } from 'vitest'

import type { SketchEvent } from '../lib/contracts'
import {
  DEFAULT_REJECT_REASON,
  REASON_MISSING,
  acceptedPayload,
  hunkLabel,
  isReviewable,
  linePrefix,
  newReviewEventId,
  newestOpen,
  proposalsFrom,
  rejectedPayload,
} from './proposals'

const ROOT = 'C:/app'

const DIFF = [
  '@@ -1,3 +1,3 @@ header',
  ' line one',
  '-line two',
  '+line two changed',
  ' line three',
  '@@ -8,3 +8,3 @@',
  ' line eight',
  '-line nine',
  '+line nine changed',
  ' line ten',
  '',
].join('\n')

let seq = 0
function event(kind: SketchEvent['kind'], payload: Record<string, unknown>, runId = 'run-1'): SketchEvent {
  seq += 1
  return { id: `evt-${seq}`, ts: 1_700_000_000_000 + seq, runId, kind, payload }
}

function proposed(payload: Record<string, unknown>, runId = 'run-1'): SketchEvent {
  return event('edit_proposed', payload, runId)
}

describe('proposalsFrom', () => {
  it('parses a patch-carrying proposal into hunks and resolves its path', () => {
    const [proposal] = proposalsFrom(
      [proposed({ iteration: 2, edits: [{ path: 'src/app.ts', diff: DIFF }] })],
      ROOT,
    )

    expect(proposal).toBeDefined()
    expect(proposal!.iteration).toBe(2)
    expect(proposal!.outcome.state).toBe('open')

    const file = proposal!.files[0]!
    expect(file.statedPath).toBe('src/app.ts')
    // The engine reports project-relative paths; the panel needs an absolute key.
    expect(file.path).toBe('C:/app/src/app.ts')
    expect(file.hunks).toHaveLength(2)
    expect(file.parseError).toBeNull()
    expect(isReviewable(file)).toBe(true)
    expect(hunkLabel(file.hunks[0]!)).toBe('@@ -1,3 +1,3 @@ header')
    expect(hunkLabel(file.hunks[1]!)).toBe('@@ -8,3 +8,3 @@')
  })

  it('keeps a byte-summary-only proposal, and says it is not reviewable', () => {
    // Exactly what the loop emits today: a summary, no patch.
    const [proposal] = proposalsFrom(
      [
        proposed({
          iteration: 1,
          edits: [{ path: 'src/app.ts', wholeFile: false, searchBytes: 12, replaceBytes: 30 }],
        }),
      ],
      ROOT,
    )

    const file = proposal!.files[0]!
    expect(file.diff).toBeNull()
    expect(file.hunks).toEqual([])
    expect(file.parseError).toBeNull()
    expect(isReviewable(file)).toBe(false)
    expect(file.summary).toEqual({ wholeFile: false, searchBytes: 12, replaceBytes: 30 })
  })

  it('reports an unreadable patch instead of an empty hunk list', () => {
    const [proposal] = proposalsFrom(
      [proposed({ edits: [{ path: 'src/app.ts', diff: 'this is not a diff at all\n' }] })],
      ROOT,
    )

    const file = proposal!.files[0]!
    expect(file.hunks).toEqual([])
    expect(file.parseError?.code).toBe('no-hunk-header')
  })

  it('settles a proposal by proposalId, carrying the hunks and the reason', () => {
    const first = proposed({ edits: [{ path: 'src/app.ts', diff: DIFF }] })
    const proposals = proposalsFrom(
      [
        first,
        event('edit_rejected', { proposalId: first.id, path: 'src/app.ts', hunks: [0, 1], reason: 'wrong approach' }),
      ],
      ROOT,
    )

    expect(proposals[0]!.outcome).toMatchObject({
      state: 'rejected',
      reason: 'wrong approach',
      path: 'src/app.ts',
    })
    expect(newestOpen(proposals)).toBeUndefined()
  })

  it("settles a proposal the engine applied itself, which carries no proposalId", () => {
    // The loop writes the file and emits `edit_accepted` with just a path. The
    // review surface must not then offer to apply the same change again.
    const proposals = proposalsFrom(
      [
        proposed({ edits: [{ path: 'src/app.ts', diff: DIFF }] }),
        event('edit_accepted', { path: 'src/app.ts', bytes: 120, created: false }),
      ],
      ROOT,
    )

    expect(proposals[0]!.outcome.state).toBe('accepted')
  })

  it('does not let one run settle another run\'s proposal', () => {
    const proposals = proposalsFrom(
      [
        proposed({ edits: [{ path: 'src/app.ts', diff: DIFF }] }, 'run-1'),
        event('edit_accepted', { path: 'src/app.ts', bytes: 1 }, 'run-2'),
      ],
      ROOT,
    )

    expect(proposals[0]!.outcome.state).toBe('open')
    expect(newestOpen(proposals)?.id).toBe(proposals[0]!.id)
  })

  it('names a missing reason rather than inventing one', () => {
    const first = proposed({ edits: [{ path: 'a.ts', diff: DIFF }] })
    const proposals = proposalsFrom([first, event('edit_rejected', { proposalId: first.id })], ROOT)

    expect(proposals[0]!.outcome).toMatchObject({ state: 'rejected', reason: REASON_MISSING })
  })

  it('keeps paths as stated when no project is open', () => {
    const [proposal] = proposalsFrom([proposed({ edits: [{ path: 'src/app.ts', diff: DIFF }] })], '')
    expect(proposal!.files[0]!.path).toBe('src/app.ts')
  })
})

describe('verdict payloads', () => {
  it('carries the hunk indexes on an acceptance', () => {
    expect(acceptedPayload({ proposalId: 'p1', path: 'src/app.ts', hunks: [0, 2] }, 42)).toEqual({
      proposalId: 'p1',
      path: 'src/app.ts',
      hunks: [0, 2],
      bytes: 42,
      source: 'review',
    })
  })

  it('always carries a reason on a rejection (Requirement 16.3)', () => {
    const typed = rejectedPayload({ proposalId: 'p1', path: 'a.ts', hunks: [1] }, '  it breaks login  ')
    expect(typed['reason']).toBe('it breaks login')

    // An empty box still produces a reason. The event never goes out without one.
    const blank = rejectedPayload({ proposalId: 'p1', path: 'a.ts', hunks: [0, 1] }, '   ')
    expect(blank['reason']).toBe(DEFAULT_REJECT_REASON)
    expect(blank['hunks']).toEqual([0, 1])
  })
})

describe('rendering helpers', () => {
  it('prefixes lines the way a patch does', () => {
    expect(linePrefix('add')).toBe('+')
    expect(linePrefix('remove')).toBe('-')
    expect(linePrefix('context')).toBe(' ')
  })

  it('mints ids that cannot collide with an engine id', () => {
    const a = newReviewEventId()
    const b = newReviewEventId()
    expect(a).not.toBe(b)
    expect(a.startsWith('review-')).toBe(true)
  })
})
