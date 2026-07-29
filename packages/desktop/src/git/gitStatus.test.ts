// The panel's view logic, against statuses the ENGINE produced.
//
// The inputs here are not hand-written objects: `parseStatus` from the engine turns
// real porcelain into the `GitStatusResult` these helpers consume, so a change to
// the parser cannot silently drift from what the panel renders. Porcelain strings
// are the one thing that stays literal — they are the wire format.
//
// Validates: Requirements 14.6, 27.3

import { describe, expect, it } from 'vitest'
import { tools } from '@sketch/core'

import {
  branchLabel,
  changedRows,
  commitGate,
  conflictedRows,
  emptyReason,
  stagedRows,
  trackingLabel,
  untrackedRows,
} from './gitStatus'

const parse = tools.parseStatus

describe('branch and tracking labels', () => {
  it('names the branch, and the divergence when there is any', () => {
    const status = parse('## main...origin/main [ahead 2, behind 3]\n')
    expect(branchLabel(status)).toBe('main')
    expect(trackingLabel(status)).toBe('2 ahead, 3 behind')
  })

  it('says detached HEAD instead of inventing a branch name', () => {
    const status = parse('## HEAD (no branch)\n M src/app.ts\n')
    expect(branchLabel(status)).toBe('detached HEAD')
  })

  it('reports a missing upstream, a gone upstream, and a fresh repository', () => {
    expect(trackingLabel(parse('## solo\n'))).toBe('no upstream')
    expect(trackingLabel(parse('## t...origin/t [gone]\n'))).toBe('upstream gone')
    expect(trackingLabel(parse('## No commits yet on main\n'))).toBe('no commits yet')
  })

  it('has no label at all for an unknown status or a non-repository', () => {
    expect(branchLabel(null)).toBeNull()
    expect(trackingLabel(null)).toBeNull()
    expect(branchLabel(tools.notARepository())).toBeNull()
  })
})

describe('rows', () => {
  it('splits a path into name and directory without rebuilding it', () => {
    const rows = changedRows(parse('## main\n M src/panels/GitPanel.tsx\n'))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('GitPanel.tsx')
    expect(rows[0]!.dir).toBe('src/panels')
    // The pathspec sent back to git is what git gave us.
    expect(rows[0]!.path).toBe('src/panels/GitPanel.tsx')
  })

  it('letters staged rows from the index and changed rows from the work tree', () => {
    const status = parse('## main\nRM old.ts -> new.ts\n')
    expect(stagedRows(status)[0]).toMatchObject({ letter: 'R', path: 'new.ts', origPath: 'old.ts' })
    expect(changedRows(status)[0]).toMatchObject({ letter: 'M', path: 'new.ts' })
  })

  it('keeps unmerged paths in their own section', () => {
    const status = parse('## main\nUU both.ts\n?? new.ts\n')
    expect(conflictedRows(status).map((r) => r.path)).toEqual(['both.ts'])
    expect(stagedRows(status)).toEqual([])
    expect(changedRows(status)).toEqual([])
    expect(untrackedRows(status).map((r) => r.letter)).toEqual(['U'])
  })
})

describe('empty states', () => {
  it('distinguishes no project, not a repository, and clean', () => {
    expect(emptyReason(null, null)).toBe('no-project')
    expect(emptyReason(tools.notARepository(), '/project')).toBe('not-a-repo')
    expect(emptyReason(parse('## main...origin/main\n'), '/project')).toBe('clean')
  })

  it('is not an empty state when there is anything to list', () => {
    expect(emptyReason(parse('## main\n?? new.ts\n'), '/project')).toBeNull()
    // Status not yet known is not "clean": nothing is claimed until it arrives.
    expect(emptyReason(null, '/project')).toBeNull()
  })
})

describe('the commit gate', () => {
  const staged = parse('## main\nA  a.ts\n')

  it('refuses a blank or whitespace-only message', () => {
    for (const message of ['', '   ', '\n\t']) {
      expect(commitGate(staged, message)).toEqual({
        ok: false,
        reason: 'a commit message is required',
      })
    }
  })

  it('refuses when nothing is staged, however good the message is', () => {
    expect(commitGate(parse('## main\n M a.ts\n'), 'a fine message').ok).toBe(false)
    expect(commitGate(parse('## main\n M a.ts\n'), 'a fine message').reason).toBe(
      'stage a change first',
    )
  })

  it('refuses while a path is unmerged', () => {
    expect(commitGate(parse('## main\nA  a.ts\nUU b.ts\n'), 'msg').reason).toBe(
      'resolve the conflicted paths first',
    )
  })

  it('refuses outside a repository and before any status is known', () => {
    expect(commitGate(tools.notARepository(), 'msg').ok).toBe(false)
    expect(commitGate(null, 'msg').ok).toBe(false)
  })

  it('allows a staged change with a real message', () => {
    expect(commitGate(staged, 'add a')).toEqual({ ok: true, reason: '' })
  })
})
