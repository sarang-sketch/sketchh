// Deterministic merge, and consensus.
//
// ── THE ONE RULE ────────────────────────────────────────────────────────────
//
// Requirement 24.7: the union of verified non-conflicting edits, and A CONFLICT CREATES A
// NEW TASK AND IS NEVER GUESSED. Guessing is the whole failure mode of multi-agent
// editing: two roles rewrite the same file, something picks one or interleaves them, and
// the result compiles while meaning something neither role proposed. So this file has no
// heuristic, no "prefer the later role", and no three-way merge. Two proposals for one
// path is a conflict, full stop, and the conflict comes out as a task a human or a later
// run can pick up.
//
// ── WHY FILE GRANULARITY IS THE FINEST HONEST GRANULARITY HERE ──────────────
//
// The action protocol's edit is exact search/replace, and `loop/edits.ts` turns it into a
// unified diff whose single hunk replaces the whole file — deliberately, so a reviewer can
// never accept a grouping the model never proposed. So the log carries whole-file
// proposals, and two whole-file proposals for one path computed from the same base cannot
// be combined without inventing which lines belonged to whom. Splitting them into
// finer hunks by heuristic would be exactly the guess Requirement 24.7 forbids. File-level
// is therefore not a shortcut, it is the finest granularity the input actually supports,
// and it is stated here rather than discovered by someone reading the loop later.
//
// ── STALENESS IS FREE, AND IT COMES FROM THE HUNK PARSER ────────────────────
//
// A proposal is applied by running its diff through `applyHunks` against the file as it is
// NOW. If another role's merged edit already changed it, the context no longer matches and
// `applyHunks` returns `context-mismatch` — a stale proposal is refused with a diagnostic
// instead of overwriting whatever landed first. That check is not reimplemented here; the
// diff module already had it, and one implementation of "does this patch still apply" is
// the point.
//
// ── CONSENSUS RUNS ONLY INSIDE `swarm` ──────────────────────────────────────
//
// Requirement 24.9. {@link consensus} returns `null` for `single` and `plan-then-code`
// rather than a permissive verdict, so a caller cannot accidentally read agreement into a
// strategy that has nobody to agree with. The rule lives in the function, not at the call
// site, so there is one place to check it and one place to test it.
//
// Validates: Requirements 24.7, 24.9

import { resolve } from 'node:path'

import { allHunkIndexes, applyHunks, parseUnifiedDiff, type DiffErrorCode } from '../diff/index.js'
import { diskTextReader, type TextReader } from '../loop/edits.js'
import type { FileWriter } from '../orchestrator/file-writer.js'
import type { RunResult, SketchEvent } from '../types.js'
import type { RoleGrade } from './grade.js'
import { ROLE_DEFINITIONS, type Role } from './roles.js'
import type { Strategy } from './strategies.js'

/** One file change a role proposed but did not write. */
export interface EditProposal {
  role: Role
  /** The sub-run that proposed it, so the log can be read back. */
  runId: string
  path: string
  /** The unified diff the loop computed against the file as the role saw it. */
  diff: string
  /** True when the proposal replaces the whole file (`search: ""`). */
  wholeFile: boolean
}

/**
 * Read a role sub-run's proposals out of its own event slice.
 *
 * The log is the source, not a return value smuggled out of the loop: a merge that reads
 * the log can be replayed, tested against a fixture, and audited after the fact. Entries
 * without a `diff` are the ones `prepareEdit` refused (path outside the root, search string
 * absent) — those never became proposals and are not merge input.
 */
export function collectProposals(role: Role, run: RunResult): EditProposal[] {
  const out: EditProposal[] = []
  for (const event of run.events) {
    if (event.kind !== 'edit_proposed') continue
    const edits = event.payload['edits']
    if (!Array.isArray(edits)) continue
    for (const entry of edits) {
      if (entry === null || typeof entry !== 'object') continue
      const record = entry as Record<string, unknown>
      const path = record['path']
      const diff = record['diff']
      if (typeof path !== 'string' || typeof diff !== 'string' || diff === '') continue
      out.push({
        role,
        runId: run.runId,
        path,
        diff,
        wholeFile: record['wholeFile'] === true,
      })
    }
  }
  return out
}

/** Why a follow-up task exists. Never "something went wrong". */
export type FollowUpOrigin = 'merge-conflict' | 'blocked-review' | 'unverifiable-role'

/**
 * Work the swarm found and deliberately did not do.
 *
 * A conflict, a blocking review finding, and a role that could not be checked all produce
 * one of these instead of a silent decision. `id` is derived from the parent task and an
 * index — no clock, no randomness — so the same swarm produces the same follow-ups and a
 * test can assert them.
 */
export interface FollowUpTask {
  id: string
  prompt: string
  reason: string
  paths: string[]
  origin: FollowUpOrigin
  /** Sub-runs whose logs hold the evidence. */
  runIds: string[]
}

export interface MergeConflict {
  path: string
  /** Every role that proposed this path. */
  roles: Role[]
  /** `multiple-proposers`, or the hunk parser's own diagnostic code. */
  code: DiffErrorCode | 'multiple-proposers'
  reason: string
  runIds: string[]
}

export interface AppliedEdit {
  path: string
  role: Role
  runId: string
  bytes: number
  created: boolean
}

export interface MergeResult {
  /** True when every proposal either applied or there were none. */
  ok: boolean
  applied: AppliedEdit[]
  conflicts: MergeConflict[]
  followUps: FollowUpTask[]
}

export interface MergeOptions {
  root: string
  files: FileWriter
  readText?: TextReader
  /** The parent task's id; follow-up ids are derived from it. */
  taskId: string
}

function conflictPrompt(conflict: MergeConflict): string {
  if (conflict.code === 'multiple-proposers') {
    return [
      `Resolve a merge conflict the swarm refused to guess at: ${conflict.path}.`,
      '',
      `The ${conflict.roles.map((role) => ROLE_DEFINITIONS[role].title).join(' and ')} role(s) ` +
        'each proposed a change to this file from the same starting bytes. The action protocol ' +
        'produces whole-file replacements, so combining them would mean inventing which lines ' +
        'belonged to which role. Nothing was written.',
      '',
      `Read the proposals in run(s) ${conflict.runIds.join(', ')}, decide what the file should ` +
        'contain, and make that one change.',
    ].join('\n')
  }
  return [
    `Reapply a stale proposal for ${conflict.path}.`,
    '',
    `The ${conflict.roles.map((role) => ROLE_DEFINITIONS[role].title).join(' and ')} role(s) ` +
      'proposed a change against bytes that are no longer there, so it was refused rather than ' +
      `overwriting what is: ${conflict.reason}`,
    '',
    `Read the current file and run(s) ${conflict.runIds.join(', ')}, then redo the change against ` +
      'what the file says now.',
  ].join('\n')
}

/**
 * Merge the proposals. Applies the non-conflicting ones and reports the rest.
 *
 * Deterministic: paths are processed in sorted order, so the same proposals in a different
 * arrival order produce the same bytes and the same conflicts. Never throws — a write
 * failure is a conflict carrying the writer's message, because the caller has to be able to
 * report it rather than catch it.
 */
export async function mergeProposals(
  proposals: readonly EditProposal[],
  options: MergeOptions,
): Promise<MergeResult> {
  const readText = options.readText ?? diskTextReader
  const byPath = new Map<string, EditProposal[]>()
  for (const proposal of proposals) {
    const list = byPath.get(proposal.path)
    if (list === undefined) byPath.set(proposal.path, [proposal])
    else list.push(proposal)
  }

  const applied: AppliedEdit[] = []
  const conflicts: MergeConflict[] = []

  for (const path of [...byPath.keys()].sort()) {
    const group = byPath.get(path)!
    const roles = [...new Set(group.map((proposal) => proposal.role))]
    const runIds = [...new Set(group.map((proposal) => proposal.runId))]

    // THE RULE. Two proposals for one path is a conflict whether they came from two roles
    // or from one role twice — in both cases the second was computed against bytes the
    // first would have replaced, and picking one is a guess.
    if (group.length > 1) {
      conflicts.push({
        path,
        roles,
        code: 'multiple-proposers',
        reason:
          `${group.length} proposals for one file, from ${roles.length} role(s); each was ` +
          'computed against the same original bytes, so combining them would be a guess',
        runIds,
      })
      continue
    }

    const proposal = group[0]!
    const parsed = parseUnifiedDiff(proposal.diff)
    if (!parsed.ok) {
      conflicts.push({
        path,
        roles,
        code: parsed.error.code,
        reason: parsed.error.message,
        runIds,
      })
      continue
    }

    // Read the file AS IT IS NOW, after any earlier merged edit. That is what makes
    // staleness detectable at all.
    // `prepareEdit` already refused anything outside the root before the proposal existed,
    // so this is a join and not a second guard.
    const current = await readText(resolve(options.root, path))
    const outcome = applyHunks(current ?? '', parsed.hunks, allHunkIndexes(parsed.hunks))
    if (!outcome.ok) {
      conflicts.push({
        path,
        roles,
        code: outcome.error.code,
        reason: outcome.error.message,
        runIds,
      })
      continue
    }

    try {
      await options.files.apply(options.root, [{ path, content: outcome.content }])
    } catch (err) {
      conflicts.push({
        path,
        roles,
        code: 'context-mismatch',
        reason: `write failed: ${err instanceof Error ? err.message : String(err)}`,
        runIds,
      })
      continue
    }

    applied.push({
      path,
      role: proposal.role,
      runId: proposal.runId,
      bytes: Buffer.byteLength(outcome.content, 'utf8'),
      created: current === null,
    })
  }

  const followUps = conflicts.map((conflict, index) => ({
    id: `${options.taskId}-conflict-${index + 1}`,
    prompt: conflictPrompt(conflict),
    reason: conflict.reason,
    paths: [conflict.path],
    origin: 'merge-conflict' as const,
    runIds: conflict.runIds,
  }))

  return { ok: conflicts.length === 0, applied, conflicts, followUps }
}

export interface Blocker {
  role: Role
  /** The anchored findings that blocked. */
  findings: string[]
}

export interface ConsensusResult {
  reached: boolean
  /** Roles that passed their own signal. */
  agreeing: Role[]
  /** Roles that failed it. Their output is not merged. */
  dissenting: Role[]
  /** Blocking roles that reported anchored findings. */
  blockers: Blocker[]
  reason: string
}

/**
 * Consensus over the graded roles. `null` for anything but `swarm` (Requirement 24.9).
 *
 * Three ways it fails, and none of them is a vote:
 *   * a role failed its own signal — its work was not verified, so it does not count
 *     towards agreement and its presence means the swarm is not clean;
 *   * a BLOCKING role (Security, Reviewer) reported anchored findings — those stop the
 *     change and leave with a follow-up task;
 *   * nobody agreed at all — an empty grade list is not unanimity, and reading it as one is
 *     how a swarm that ran nothing reports success.
 *
 * Biased towards stopping. A false stop costs a human a minute; a false ship costs whatever
 * the security finding was about.
 */
export function consensus(
  strategy: Strategy,
  grades: readonly RoleGrade[],
): ConsensusResult | null {
  if (strategy !== 'swarm') return null

  const agreeing: Role[] = []
  const dissenting: Role[] = []
  const blockers: Blocker[] = []

  for (const grade of grades) {
    if (grade.passed) agreeing.push(grade.role)
    else dissenting.push(grade.role)

    if (
      grade.passed &&
      ROLE_DEFINITIONS[grade.role].blocking &&
      !grade.noFindings &&
      grade.citations.length > 0
    ) {
      blockers.push({
        role: grade.role,
        findings: grade.citations.map((citation) =>
          citation.line === undefined ? citation.path : `${citation.path}:${citation.line}`,
        ),
      })
    }
  }

  if (agreeing.length === 0) {
    return {
      reached: false,
      agreeing,
      dissenting,
      blockers,
      reason:
        'no role passed its own verification signal, so there is nothing to agree about; ' +
        'an empty swarm is not unanimity',
    }
  }
  if (dissenting.length > 0) {
    return {
      reached: false,
      agreeing,
      dissenting,
      blockers,
      reason: `${dissenting.length} role(s) failed their own signal: ${dissenting
        .map((role) => ROLE_DEFINITIONS[role].title)
        .join(', ')}`,
    }
  }
  if (blockers.length > 0) {
    return {
      reached: false,
      agreeing,
      dissenting,
      blockers,
      reason: `blocked by ${blockers
        .map((blocker) => `${ROLE_DEFINITIONS[blocker.role].title} (${blocker.findings.join(', ')})`)
        .join('; ')}`,
    }
  }
  return {
    reached: true,
    agreeing,
    dissenting,
    blockers,
    reason: `${agreeing.length} role(s) passed their own signal and no blocking role objected`,
  }
}

/** Follow-up tasks for the findings that blocked a swarm. */
export function blockerFollowUps(
  taskId: string,
  blockers: readonly Blocker[],
  runIds: readonly string[],
): FollowUpTask[] {
  return blockers.map((blocker, index) => ({
    id: `${taskId}-blocked-${index + 1}`,
    prompt: [
      `Address the ${ROLE_DEFINITIONS[blocker.role].title} role\u2019s findings before this change ships.`,
      '',
      'Findings are anchored at:',
      ...blocker.findings.map((finding) => `  - ${finding}`),
      '',
      `The full report is in run(s) ${runIds.join(', ')}. The merged change was not shipped.`,
    ].join('\n'),
    reason: `${ROLE_DEFINITIONS[blocker.role].title} reported ${blocker.findings.length} anchored finding(s)`,
    paths: blocker.findings.map((finding) => finding.split(':')[0]!),
    origin: 'blocked-review' as const,
    runIds: [...runIds],
  }))
}

/** Follow-up tasks for roles this project could not check. */
export function unverifiableFollowUps(
  taskId: string,
  skipped: readonly { role: Role; reason: string }[],
): FollowUpTask[] {
  if (skipped.length === 0) return []
  return [
    {
      id: `${taskId}-unverifiable-roles`,
      prompt: [
        'Configure the verification stages these roles are graded by, or accept that they ' +
          'cannot run.',
        '',
        ...skipped.map((entry) => `  - ${ROLE_DEFINITIONS[entry.role].title}: ${entry.reason}`),
        '',
        'They were skipped rather than run, because a role that cannot be checked reports ' +
          'success having proved nothing.',
      ].join('\n'),
      reason: `${skipped.length} role(s) have no verification signal in this project`,
      paths: [],
      origin: 'unverifiable-role' as const,
      runIds: [],
    },
  ]
}

/** Every `edit_proposed` path in a slice, for a panel that wants a summary. */
export function proposedPaths(events: readonly SketchEvent[]): string[] {
  const paths = new Set<string>()
  for (const event of events) {
    if (event.kind !== 'edit_proposed') continue
    const edits = event.payload['edits']
    if (!Array.isArray(edits)) continue
    for (const entry of edits) {
      const path = (entry as Record<string, unknown> | null)?.['path']
      if (typeof path === 'string') paths.add(path)
    }
  }
  return [...paths].sort()
}
