// Turning a `GitStatusResult` into the things the Git panel puts on screen.
//
// Pure, and separate from the component, for the same reason the porcelain parser
// is separate from the RPC method: the interesting cases are the ones a repository
// is awkward to get into. A detached HEAD, a rename, an unmerged path, a branch
// with no upstream and a repository with no commits are all decided here and tested
// without a DOM.
//
// NOTHING IS INVENTED. Every string below is derived from the status the engine
// parsed; there is no placeholder branch, no sample row, and no default file list.
// When there is nothing to show, that is an EMPTY STATE with a stated reason
// (Requirements 14.6, 27.3).
//
// PATHS ARE REPO-RELATIVE, forward-slashed, exactly as the engine handed them over
// — the same spelling git accepts back as a pathspec, so a row can be staged with
// the string it was rendered from and no path is rebuilt on the way out.
//
// Validates: Requirements 14.6, 27.1, 27.3, 27.5

import type { GitFileChange, GitStatusResult } from '../lib/contracts'

/** Which list a row came from. Decides what the row's button does. */
export type GitSection = 'staged' | 'changes' | 'untracked' | 'conflicted'

/** One rendered row. */
export interface GitRow {
  /** Repo-relative path. The key, and the pathspec sent back to the engine. */
  path: string
  /** Last segment, for the prominent label. */
  name: string
  /** Everything before the last segment. Empty at the repository root. */
  dir: string
  /** The single letter shown in the gutter. */
  letter: string
  /** Where this row came from. */
  section: GitSection
  /** Present for a rename or a copy: the path this file used to have. */
  origPath?: string
}

/** Why the panel has nothing to list. Each case gets its own sentence in the UI. */
export type GitEmptyReason = 'no-project' | 'not-a-repo' | 'clean'

function splitPath(path: string): { name: string; dir: string } {
  const at = path.lastIndexOf('/')
  if (at === -1) return { name: path, dir: '' }
  return { name: path.slice(at + 1), dir: path.slice(0, at) }
}

function toRow(change: GitFileChange, section: GitSection, letter: string): GitRow {
  const { name, dir } = splitPath(change.path)
  return {
    path: change.path,
    name,
    dir,
    letter,
    section,
    ...(change.origPath !== undefined ? { origPath: change.origPath } : {}),
  }
}

/**
 * The staged rows. The letter is the INDEX column, so a rename staged and then
 * modified again shows `R` here and `M` under Changes — which is what git means,
 * and what the old two-array fixture could not express.
 */
export function stagedRows(status: GitStatusResult): GitRow[] {
  return status.staged.map((change) => toRow(change, 'staged', change.index.trim() || 'M'))
}

/** The unstaged rows, lettered from the WORK TREE column. */
export function changedRows(status: GitStatusResult): GitRow[] {
  return status.unstaged.map((change) => toRow(change, 'changes', change.worktree.trim() || 'M'))
}

export function untrackedRows(status: GitStatusResult): GitRow[] {
  return status.untracked.map((change) => toRow(change, 'untracked', 'U'))
}

/**
 * Unmerged rows. Their own section on purpose: staging a conflict without
 * resolving it marks it resolved, so it must not sit in a list whose `+` button
 * means "add this to the next commit" alongside ordinary edits.
 */
export function conflictedRows(status: GitStatusResult): GitRow[] {
  return status.conflicted.map((change) =>
    toRow(change, 'conflicted', `${change.index}${change.worktree}`.trim() || '!'),
  )
}

/**
 * What the branch chip says.
 *
 * Null when nothing is known yet, so a caller can render nothing rather than a
 * guess. `detached HEAD` and `no branch` are stated rather than smoothed into a
 * plausible-looking name — the Rust command's offset parser used to report the
 * branch as the literal string `HEAD (no branch)`.
 */
export function branchLabel(status: GitStatusResult | null): string | null {
  if (status === null) return null
  if (!status.isRepo) return null
  if (status.detached) return 'detached HEAD'
  if (status.branch === null || status.branch === '') return 'no branch'
  return status.branch
}

/**
 * The tracking suffix: divergence, a deleted upstream, or the pre-first-commit
 * state. Null when there is nothing to add.
 */
export function trackingLabel(status: GitStatusResult | null): string | null {
  if (status === null || !status.isRepo) return null
  if (status.initialCommit) return 'no commits yet'
  if (status.upstreamGone) return 'upstream gone'
  const parts: string[] = []
  if (status.ahead > 0) parts.push(`${status.ahead} ahead`)
  if (status.behind > 0) parts.push(`${status.behind} behind`)
  if (parts.length > 0) return parts.join(', ')
  if (status.upstream === null) return 'no upstream'
  return null
}

/**
 * Why there is nothing to list, or null when there is.
 *
 * The two honest empty states Requirement 27.3 asks for are DIFFERENT ANSWERS and
 * are kept distinct here: a clean repository has a branch and a history, and the
 * next commit will work; a directory that is not a repository has neither, and
 * every button in the panel is meaningless in it. Collapsing them into one "no
 * changes" message is what makes a missing repository look like success.
 */
export function emptyReason(
  status: GitStatusResult | null,
  projectRoot: string | null,
): GitEmptyReason | null {
  if (projectRoot === null) return 'no-project'
  if (status === null) return null
  if (!status.isRepo) return 'not-a-repo'
  return status.clean ? 'clean' : null
}

export interface CommitGate {
  ok: boolean
  /** Why not, in words a tooltip can carry. Empty when `ok`. */
  reason: string
}

/**
 * Whether Commit may be pressed.
 *
 * An empty message is refused HERE, in the UI, as well as in the engine — the
 * engine's refusal is the one that cannot be bypassed (`GitTool.commit` throws
 * before anything is spawned and records `tool_denied`), and this one is the one
 * that explains itself before the user presses a button. Both exist deliberately:
 * removing the engine check would make the guard a UI convention, and removing
 * this one would make a whitespace-only message look like a failure of git.
 */
export function commitGate(status: GitStatusResult | null, message: string): CommitGate {
  if (status === null) return { ok: false, reason: 'no repository status yet' }
  if (!status.isRepo) return { ok: false, reason: 'this folder is not a git repository' }
  if (status.conflicted.length > 0) {
    return { ok: false, reason: 'resolve the conflicted paths first' }
  }
  if (status.staged.length === 0) return { ok: false, reason: 'stage a change first' }
  if (message.trim() === '') return { ok: false, reason: 'a commit message is required' }
  return { ok: true, reason: '' }
}
