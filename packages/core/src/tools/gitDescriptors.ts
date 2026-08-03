// git, as tools an AGENT may call — which means git, behind the capability gate.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//
// `GitTool` is a class with methods. A class with methods cannot be authorised:
// `ToolDispatcher` only knows how to check a {@link ToolDescriptor}'s `requires`
// before reaching its `run`. So for as long as the only real tool in `tools/` was
// a class, the adversarial denial suite proved its six escalations against
// descriptors defined inside the tests, and the only one that left evidence on
// disk was a filesystem write. The gate was correct and singular with almost
// nothing real behind it.
//
// These descriptors are that missing population. They wrap the SAME `GitTool` —
// there is no second parser, no second spawn path, no second refusal — and they
// carry the capability each operation costs:
//
//   git-status, git-diff, git-branch   git:read
//   git-stage, git-unstage, git-commit git:write
//
// A run that does not hold `git:write` cannot commit, and `capabilities.test.ts`
// proves that against a real repository by counting commits before and after,
// not by trusting that an event fired.
//
// ── THE DIRECT API IS UNTOUCHED ─────────────────────────────────────────────
//
// The Source Control panel is a human clicking Stage, and the `git-*` RPC methods
// serve that human. A capability grant describes what a SKILL was permitted to do
// autonomously; interposing one between a user and the button they just pressed
// would be theatre, and it would break the panel. So `GitTool`'s methods stay
// public and ungated, and this file is the agent-facing door. Two doors, one
// implementation, and only the agent's door has a lock — because only the agent's
// side has an untrusted caller.
//
// ── ONE GRANT CONSULTATION, STILL ───────────────────────────────────────────
//
// Nothing here reads `context.granted`. A tool that checks its own permission is
// a second answer to the question the dispatcher already answered, and two
// answers is how they drift. `run` is only ever reached after `#authorised`
// passed.
//
// ── A GIT FAILURE IS `ok: false`, NOT A THROW ───────────────────────────────
//
// `GitError` is caught and returned as an outcome. The dispatcher would catch a
// throw too, but it would record it as `tool_error` — "the tool is broken" —
// when "nothing to commit" or "pathspec did not match" is an ordinary answer the
// model should read and act on.
//
// Validates: Requirements 11.4, 11.5, 14.6, 27.1

import type { ToolContext, ToolDescriptor, ToolOutcome } from '../capabilities/guard.js'
import type { EventStore } from '../events/index.js'
import { GitError, GitTool, type GitExec, type GitStatusResult } from './git.js'

/** The agent-facing git tools, in the order a prompt should list them. */
export const GIT_TOOL_NAMES = [
  'git-branch',
  'git-commit',
  'git-diff',
  'git-stage',
  'git-status',
  'git-unstage',
] as const

export type GitToolName = (typeof GIT_TOOL_NAMES)[number]

export interface GitToolDescriptorOptions {
  /** Where mutations are recorded, exactly as {@link GitTool} records them. */
  events?: EventStore
  /** runId stamped on the tool's own mutation events. */
  runId?: string
  timeoutMs?: number
  /** Injected in tests. */
  exec?: GitExec
  /**
   * How the tool for a run's root is built. Overridden only by tests that need to
   * see which repository was touched; the default is the real thing.
   */
  create?: (root: string) => GitTool
}

// ── argument reading ────────────────────────────────────────────────────────
//
// Arguments arrive from a model, so every one of them is untrusted. A bad shape is
// an `ok: false` outcome naming what was expected — the model can correct itself
// from that, where a thrown TypeError just looks like a broken tool.

function readOptionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new GitError('args', `${key} must be a string`)
  return value
}

function readPaths(args: Record<string, unknown>): string[] {
  const value = args['paths'] ?? args['path']
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value) || value.length === 0) {
    throw new GitError('args', 'paths must be a non-empty array of repository-relative paths')
  }
  const paths: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') throw new GitError('args', 'every path must be a string')
    paths.push(entry)
  }
  return paths
}

// ── rendering ───────────────────────────────────────────────────────────────

function describeStatus(status: GitStatusResult): string {
  if (!status.isRepo) return 'not a git repository'
  const where = status.detached
    ? 'detached HEAD'
    : `on ${status.branch ?? 'an unnamed branch'}${status.initialCommit ? ' (no commits yet)' : ''}`
  if (status.clean) return `${where}, working tree clean`
  const parts = [
    `staged: ${status.staged.map((change) => change.path).join(', ') || 'none'}`,
    `modified: ${status.unstaged.map((change) => change.path).join(', ') || 'none'}`,
    `untracked: ${status.untracked.map((change) => change.path).join(', ') || 'none'}`,
  ]
  if (status.conflicted.length > 0) {
    parts.push(`conflicted: ${status.conflicted.map((change) => change.path).join(', ')}`)
  }
  return `${where}. ${parts.join('; ')}`
}

function statusDetail(status: GitStatusResult): Record<string, unknown> {
  return {
    isRepo: status.isRepo,
    branch: status.branch,
    detached: status.detached,
    clean: status.clean,
    staged: status.staged.length,
    unstaged: status.unstaged.length,
    untracked: status.untracked.length,
    conflicted: status.conflicted.length,
  }
}

/**
 * Turn a {@link GitError} into an outcome. Anything else is a real defect and is
 * left to the dispatcher, which records it as `tool_error`.
 */
async function attempt(work: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof GitError) return { ok: false, output: err.message, detail: { action: err.action } }
    throw err
  }
}

// ── the descriptors ─────────────────────────────────────────────────────────

/**
 * The git tools, bound to nothing but these options.
 *
 * The repository comes from {@link ToolContext.root} at call time, not from
 * construction: a dispatcher is built per run and the run owns the root, so a
 * descriptor that captured a path would be able to act on a repository other than
 * the one the run was pointed at.
 */
export function gitToolDescriptors(options: GitToolDescriptorOptions = {}): ToolDescriptor[] {
  const toolFor = (context: ToolContext): GitTool =>
    options.create?.(context.root) ??
    new GitTool({
      root: context.root,
      ...(options.events !== undefined ? { events: options.events } : {}),
      ...(options.runId !== undefined ? { runId: options.runId } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.exec !== undefined ? { exec: options.exec } : {}),
    })

  const descriptors: ToolDescriptor[] = [
    {
      name: 'git-status',
      description: 'The working-tree status of this repository: branch, staged, modified, untracked',
      requires: 'git:read',
      run: (_args, context) =>
        attempt(async () => {
          const status = await toolFor(context).status()
          return { ok: true, output: describeStatus(status), detail: statusDetail(status) }
        }),
    },
    {
      name: 'git-branch',
      description: 'The branch this repository is on, or nothing when HEAD is detached',
      requires: 'git:read',
      run: (_args, context) =>
        attempt(async () => {
          const branch = await toolFor(context).branch()
          return {
            ok: true,
            output: branch ?? 'detached HEAD (no branch)',
            detail: { branch },
          }
        }),
    },
    {
      name: 'git-diff',
      description: 'A unified diff. `staged: true` compares the index against HEAD; `path` narrows it',
      requires: 'git:read',
      run: (args, context) =>
        attempt(async () => {
          const path = readOptionalString(args, 'path')
          const staged = args['staged'] === true
          const diff = await toolFor(context).diff({
            ...(path !== undefined ? { path } : {}),
            ...(staged ? { staged: true } : {}),
          })
          return {
            ok: true,
            output: diff === '' ? 'no differences' : diff,
            detail: { staged, bytes: diff.length },
          }
        }),
    },
    {
      name: 'git-stage',
      description: 'Stage repository-relative paths for commit',
      requires: 'git:write',
      run: (args, context) =>
        attempt(async () => {
          const paths = readPaths(args)
          await toolFor(context).stage(paths)
          return { ok: true, output: `staged ${paths.length} path(s)`, detail: { count: paths.length } }
        }),
    },
    {
      name: 'git-unstage',
      description: 'Remove repository-relative paths from the index, leaving the files alone',
      requires: 'git:write',
      run: (args, context) =>
        attempt(async () => {
          const paths = readPaths(args)
          await toolFor(context).unstage(paths)
          return { ok: true, output: `unstaged ${paths.length} path(s)`, detail: { count: paths.length } }
        }),
    },
    {
      name: 'git-commit',
      description: 'Commit what is staged, with a message',
      requires: 'git:write',
      run: (args, context) =>
        attempt(async () => {
          const message = readOptionalString(args, 'message') ?? ''
          const result = await toolFor(context).commit(message)
          return { ok: true, output: result.output.trim() || 'committed', detail: { committed: true } }
        }),
    },
  ]

  return descriptors.sort((a, b) => (a.name < b.name ? -1 : 1))
}
