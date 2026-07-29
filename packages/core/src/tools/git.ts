// git, as a tool the engine owns.
//
// ── WHY THIS IS THE ONLY GIT PARSER THAT COUNTS ─────────────────────────────
//
// `packages/desktop/src-tauri/src/main.rs` also shells out to `git status
// --porcelain -b`, and its parser splits on fixed offsets. That is wrong in four
// ways that show up in ordinary repositories:
//
//   * renames. Porcelain prints `R  old -> new`; taking the whole tail as a path
//     produces a "file" called `old -> new` that no later command can act on.
//   * quoting. With the default `core.quotepath`, git wraps a path containing a
//     space, a quote, a control character, or any non-ASCII byte in double quotes
//     and C-escapes it — `"caf\303\251.txt"`. An offset split hands that back
//     verbatim, escapes and all.
//   * the `##` line. `branch = line[3..].split("...")` yields `HEAD (no branch)`
//     for a detached HEAD, and silently loses the ahead/behind counts.
//   * "not a repository" is indistinguishable from "clean", because the parser
//     never looks at the exit code.
//
// So parsing lives here, once, and the Git panel reads THIS through the client
// seam. The Rust command is left in place for the native bridge wrapper that names
// it, deliberately without a second parser to keep in step.
//
// ── PATHS ARE REPO-RELATIVE, WITH FORWARD SLASHES ───────────────────────────
//
// Every path in a `GitStatusResult` is exactly what porcelain reported: relative
// to the repository root, `/`-separated on every platform. That is also the only
// spelling git accepts back as a pathspec, so a caller can pass what it was given
// to `stage`, `unstage`, or `diff` without translating. A caller that wants an
// absolute path joins `root` itself; a caller that HAS an absolute path may pass
// it, and it is converted here after being checked for containment.
//
// ── NO SHELL, EVER ──────────────────────────────────────────────────────────
//
// Commands go through `verify/runner.ts` — `spawn` with `shell: false`, a per-call
// timeout that kills rather than hangs, and a byte cap on captured output. A path
// or a commit message therefore reaches git as one argv element and is never
// re-parsed. On top of that, every caller-supplied pathspec is checked for `..`
// escapes and for a leading `-` (git reads `--output=<path>` as a WRITE, not a
// path), and every pathspec list is preceded by `--`.
//
// Validates: Requirements 14.6, 27.1, 27.3, 27.5, 13.8

import { isAbsolute, relative, resolve, sep } from 'node:path'

import type { EventStore } from '../events/index.js'
import { EXIT_SPAWN_FAILED, runCommand } from '../verify/runner.js'

/** One changed path, as porcelain describes it. */
export interface GitFileChange {
  /** Repo-relative, `/`-separated. */
  path: string
  /** Index (staged) status letter. A space means unchanged in the index. */
  index: string
  /** Work-tree status letter. A space means unchanged on disk. */
  worktree: string
  /** The previous path, for a rename or a copy. Absent otherwise. */
  origPath?: string
}

/** A parsed `git status --porcelain -b`. */
export interface GitStatusResult {
  /** False when the directory is not inside a git work tree. */
  isRepo: boolean
  /** Current branch, or null on a detached HEAD. */
  branch: string | null
  /** True when HEAD points at a commit rather than a branch. */
  detached: boolean
  /** True before the first commit ("No commits yet on main"). */
  initialCommit: boolean
  /** Upstream ref, or null when the branch has none. */
  upstream: string | null
  /** True when the branch has an upstream that no longer exists (`[gone]`). */
  upstreamGone: boolean
  ahead: number
  behind: number
  staged: GitFileChange[]
  unstaged: GitFileChange[]
  untracked: GitFileChange[]
  /** Unmerged paths. Never also listed as staged or unstaged. */
  conflicted: GitFileChange[]
  /** True when nothing is staged, modified, untracked, or conflicted. */
  clean: boolean
}

/** A git invocation that failed, or a request refused before it was made. */
export class GitError extends Error {
  /** The git subcommand this concerns: `status`, `commit`, … */
  readonly action: string
  /** Process exit code, or null when nothing was spawned. */
  readonly exitCode: number | null

  constructor(action: string, message: string, exitCode: number | null = null) {
    super(message)
    this.name = 'GitError'
    this.action = action
    this.exitCode = exitCode
  }
}

export interface GitExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * How git actually runs. The default goes through the verify runner; a test may
 * substitute its own to exercise parsing against canned output.
 */
export type GitExec = (
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<GitExecResult>

export interface GitToolOptions {
  /** The repository (or any directory inside it). */
  root: string
  /**
   * Where git actions are recorded. MUTATIONS ONLY — see `#record`. Status and
   * diff are reads the panel repeats on every refresh; logging those would bury
   * the run they belong to.
   */
  events?: EventStore
  /** runId stamped on emitted events. See `DEFAULT_GIT_RUN_ID`. */
  runId?: string
  /** Per-command timeout. */
  timeoutMs?: number
  /** Injected in tests. */
  exec?: GitExec
}

/**
 * The runId git actions are recorded under.
 *
 * SPEC GAP, recorded rather than papered over: `EventKind` has no git member, and
 * every event needs a `runId`, but a panel-driven `git commit` belongs to no agent
 * run. Rather than invent a kind (the contract in types.ts may not be extended
 * locally), git actions are emitted as `tool_called` / `tool_denied` with
 * `payload.tool === 'git'` and a `payload.action` discriminator — the same shape
 * the loop uses when it needs a distinction the enum does not carry. They group
 * under this one synthetic run so the Timeline can show them without pretending
 * they were part of somebody else's run.
 */
export const DEFAULT_GIT_RUN_ID = 'git'

/** 30s. A `git status` on a cold, large repository can take seconds; nothing here should take thirty. */
export const DEFAULT_GIT_TIMEOUT_MS = 30_000

// ── path quoting ────────────────────────────────────────────────────────────

const SIMPLE_ESCAPES: Record<string, string> = {
  a: '\u0007',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '"': '"',
  '\\': '\\',
}

function isOctalDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '7'
}

/**
 * Undo the C-style quoting git applies to a path it considers unusual.
 *
 * A path is quoted when it contains a space, a `"`, a `\`, a control character, or
 * — under the default `core.quotepath=true` — any byte above 0x7f. Non-ASCII
 * therefore arrives as a RUN of octal byte escapes: `caf\303\251` is two bytes of
 * one UTF-8 character, so the run has to be decoded together. Decoding each escape
 * on its own would produce mojibake, which is why the octal digits accumulate into
 * a byte array before anything is turned back into text.
 *
 * An unquoted value is returned unchanged: git only quotes when it must, and a
 * path that merely looks quoted (`"literally quoted"` on disk, with the quotes in
 * the filename) is itself quoted-and-escaped by git, so this is unambiguous.
 */
export function unquotePath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw
  const inner = raw.slice(1, -1)

  const out: string[] = []
  let bytes: number[] = []

  const flush = (): void => {
    if (bytes.length === 0) return
    out.push(Buffer.from(bytes).toString('utf8'))
    bytes = []
  }

  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!
    if (ch !== '\\') {
      // Not an escape. Any non-ASCII here is already text (quotepath=false), so it
      // is appended as text — after flushing whatever byte run preceded it.
      flush()
      out.push(ch)
      continue
    }

    const next = inner[i + 1]
    if (next === undefined) {
      // A trailing lone backslash is not something git emits; keep it rather than
      // silently dropping a byte of the caller's path.
      flush()
      out.push('\\')
      break
    }

    if (isOctalDigit(next)) {
      let digits = ''
      while (digits.length < 3 && isOctalDigit(inner[i + 1])) {
        digits += inner[i + 1]
        i += 1
      }
      bytes.push(parseInt(digits, 8) & 0xff)
      continue
    }

    flush()
    out.push(SIMPLE_ESCAPES[next] ?? next)
    i += 1
  }

  flush()
  return out.join('')
}

// ── status parsing ──────────────────────────────────────────────────────────

/** The unmerged combinations. Porcelain gives conflicts their own XY pairs. */
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

const RENAME_SEPARATOR = ' -> '

/**
 * Split a rename/copy entry into its original and current path.
 *
 * Either side may be quoted, so a quoted original is consumed by scanning to its
 * closing quote (honouring `\"`) instead of searching for the separator — a
 * filename may legitimately contain ` -> `, and inside quotes there is no
 * ambiguity at all. Outside quotes there IS ambiguity, and git has it too; the
 * first separator wins, which matches how git's own output is read.
 */
function splitRename(rest: string): { origPath: string; path: string } {
  if (rest.startsWith('"')) {
    let i = 1
    while (i < rest.length) {
      const ch = rest[i]!
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === '"') break
      i += 1
    }
    const quoted = rest.slice(0, i + 1)
    const after = rest.slice(i + 1)
    if (after.startsWith(RENAME_SEPARATOR)) {
      return {
        origPath: unquotePath(quoted),
        path: unquotePath(after.slice(RENAME_SEPARATOR.length)),
      }
    }
    // Malformed: no separator after the quoted name. Treat the whole tail as one
    // path rather than dropping the entry.
    return { origPath: unquotePath(rest), path: unquotePath(rest) }
  }

  const at = rest.indexOf(RENAME_SEPARATOR)
  if (at === -1) return { origPath: unquotePath(rest), path: unquotePath(rest) }
  return {
    origPath: unquotePath(rest.slice(0, at)),
    path: unquotePath(rest.slice(at + RENAME_SEPARATOR.length)),
  }
}

interface BranchLine {
  branch: string | null
  detached: boolean
  initialCommit: boolean
  upstream: string | null
  upstreamGone: boolean
  ahead: number
  behind: number
}

const DETACHED_BODY = 'HEAD (no branch)'

/**
 * Parse the `## …` header, which has four shapes worth naming:
 *
 *   `## main`                              a branch with no upstream
 *   `## main...origin/main [ahead 1, behind 2]`   with divergence
 *   `## main...origin/main [gone]`          upstream deleted
 *   `## HEAD (no branch)`                  detached HEAD
 *   `## No commits yet on main`            fresh repository, no HEAD
 *
 * A ref name cannot contain `..`, so `...` is a safe separator to split on.
 */
function parseBranchLine(line: string): BranchLine {
  const result: BranchLine = {
    branch: null,
    detached: false,
    initialCommit: false,
    upstream: null,
    upstreamGone: false,
    ahead: 0,
    behind: 0,
  }

  let body = line.slice(2).trim()
  if (body === DETACHED_BODY) {
    result.detached = true
    return result
  }

  const noCommits = /^No commits yet on (.+)$/.exec(body)
  if (noCommits) {
    result.initialCommit = true
    body = noCommits[1]!.trim()
  }

  // Divergence lives in a trailing bracket, and a ref name cannot contain a space
  // followed by `[`, so the LAST such opener is the tracking block.
  if (body.endsWith(']')) {
    const open = body.lastIndexOf(' [')
    if (open !== -1) {
      const tracking = body.slice(open + 2, -1)
      body = body.slice(0, open)
      if (tracking.trim() === 'gone') result.upstreamGone = true
      const ahead = /ahead (\d+)/.exec(tracking)
      const behind = /behind (\d+)/.exec(tracking)
      if (ahead) result.ahead = Number(ahead[1])
      if (behind) result.behind = Number(behind[1])
    }
  }

  const sepAt = body.indexOf('...')
  if (sepAt === -1) {
    result.branch = body === '' ? null : body
    return result
  }
  result.branch = body.slice(0, sepAt)
  const upstream = body.slice(sepAt + 3)
  result.upstream = upstream === '' ? null : upstream
  return result
}

/**
 * Parse the whole of `git status --porcelain -b`.
 *
 * Exported and pure: the parser is the part with all the edge cases in it, so it
 * is testable without a repository — and then tested against a real one anyway,
 * because canned strings only ever contain the cases somebody already thought of.
 */
export function parseStatus(stdout: string): GitStatusResult {
  const result: GitStatusResult = {
    isRepo: true,
    branch: null,
    detached: false,
    initialCommit: false,
    upstream: null,
    upstreamGone: false,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    clean: true,
  }

  for (const rawLine of stdout.split('\n')) {
    // Only strip the line terminator: a path may legitimately end in a space, and
    // trimming the whole line would corrupt it.
    const line = rawLine.replace(/\r$/, '')
    if (line === '') continue

    if (line.startsWith('##')) {
      Object.assign(result, parseBranchLine(line))
      continue
    }

    // `XY<space><path>`: two status letters, a separator, then at least one char.
    if (line.length < 4) continue
    const index = line[0]!
    const worktree = line[1]!
    const rest = line.slice(3)
    const code = `${index}${worktree}`

    if (code === '!!') continue // ignored; only present with --ignored

    const change: GitFileChange = { path: '', index, worktree }
    if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') {
      const { origPath, path } = splitRename(rest)
      change.path = path
      change.origPath = origPath
    } else {
      change.path = unquotePath(rest)
    }

    if (code === '??') {
      result.untracked.push(change)
      continue
    }
    if (CONFLICT_CODES.has(code)) {
      result.conflicted.push(change)
      continue
    }
    // A path can be in both lists: `MM` is staged AND modified again since.
    if (index !== ' ') result.staged.push(change)
    if (worktree !== ' ') result.unstaged.push(change)
  }

  result.clean =
    result.staged.length === 0 &&
    result.unstaged.length === 0 &&
    result.untracked.length === 0 &&
    result.conflicted.length === 0

  return result
}

/** The answer for a directory that is not in a work tree. Honest, not empty. */
export function notARepository(): GitStatusResult {
  return {
    isRepo: false,
    branch: null,
    detached: false,
    initialCommit: false,
    upstream: null,
    upstreamGone: false,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    clean: true,
  }
}

// ── the tool ────────────────────────────────────────────────────────────────

function defaultExec(args: string[], options: { cwd: string; timeoutMs: number }): Promise<GitExecResult> {
  return runCommand(
    {
      name: `git ${args[0] ?? ''}`.trim(),
      cmd: 'git',
      args,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
    },
    // No sink: the runner's verify_started/verify_result pair describes a
    // verification stage, and a git action is not one. `#record` emits the
    // tool_called event instead.
  ).then((result) => ({
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  }))
}

function firstLine(text: string): string {
  const line = text.split('\n').find((entry) => entry.trim() !== '')
  return (line ?? '').trim()
}

/** True when git's own complaint is "this is not a repository". */
function saysNotARepository(stderr: string): boolean {
  return /not a git repository|does not appear to be a git repository/i.test(stderr)
}

export class GitTool {
  readonly root: string
  readonly #events: EventStore | undefined
  readonly #runId: string
  readonly #timeoutMs: number
  readonly #exec: GitExec

  constructor(options: GitToolOptions) {
    if (options.root.trim() === '') {
      throw new GitError('init', 'a repository path is required')
    }
    this.root = resolve(options.root)
    this.#events = options.events
    this.#runId = options.runId ?? DEFAULT_GIT_RUN_ID
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
    this.#exec = options.exec ?? defaultExec
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /**
   * The working-tree status.
   *
   * A directory that is not a repository is a RESULT, not an error: the panel has
   * a different honest empty state for it than for a clean repo (Requirement
   * 27.3). A missing git binary IS an error, because that is a tool the surface
   * must name (Requirement 27.5).
   */
  async status(): Promise<GitStatusResult> {
    const run = await this.#run('status', ['status', '--porcelain', '-b'])
    if (run.exitCode !== 0) {
      if (saysNotARepository(run.stderr)) return notARepository()
      throw this.#failure('status', run)
    }
    return parseStatus(run.stdout)
  }

  /** The current branch, or null on a detached HEAD or outside a repository. */
  async branch(): Promise<string | null> {
    return (await this.status()).branch
  }

  /**
   * A unified diff. `staged` compares the index against HEAD; otherwise the work
   * tree against the index. `path` narrows it to one pathspec.
   */
  async diff(options: { path?: string; staged?: boolean } = {}): Promise<string> {
    const args = ['diff', '--no-color']
    if (options.staged === true) args.push('--staged')
    if (options.path !== undefined) {
      // `--` first, so a pathspec can never be read as an option however it got here.
      args.push('--', this.#pathspec('diff', options.path))
    }
    const run = await this.#run('diff', args)
    if (run.exitCode !== 0) {
      if (saysNotARepository(run.stderr)) {
        throw new GitError('diff', 'not a git repository', run.exitCode)
      }
      throw this.#failure('diff', run)
    }
    return run.stdout
  }

  // ── mutations ────────────────────────────────────────────────────────────

  /** Stage paths. `git add -- <paths>`. */
  async stage(paths: string[]): Promise<void> {
    const pathspecs = this.#pathspecs('stage', paths)
    const run = await this.#run('stage', ['add', '--', ...pathspecs], { record: true })
    if (run.exitCode !== 0) throw this.#failure('stage', run)
  }

  /**
   * Unstage paths.
   *
   * `git restore --staged` needs something to restore FROM, and before the first
   * commit there is no HEAD to read. In that state a staged file is only in the
   * index, so removing it from the index — `git rm --cached` — is the same
   * operation. HEAD is probed rather than inferred from an error string.
   */
  async unstage(paths: string[]): Promise<void> {
    const pathspecs = this.#pathspecs('unstage', paths)
    const head = await this.#run('unstage', ['rev-parse', '--quiet', '--verify', 'HEAD'])
    const args =
      head.exitCode === 0
        ? ['restore', '--staged', '--', ...pathspecs]
        : ['rm', '--cached', '--quiet', '-r', '--', ...pathspecs]

    const run = await this.#run('unstage', args, { record: true })
    if (run.exitCode !== 0) throw this.#failure('unstage', run)
  }

  /**
   * Commit what is staged.
   *
   * An empty message is refused HERE, before anything is spawned: git would fail
   * too, but a refusal that never starts a process is the one the UI can explain,
   * and it is recorded as `tool_denied` so the Timeline shows the refusal rather
   * than a mystery non-event.
   */
  async commit(message: string): Promise<{ output: string }> {
    if (message.trim() === '') {
      throw await this.#deny('commit', 'a commit message is required')
    }
    const run = await this.#run('commit', ['commit', '-m', message], { record: true })
    if (run.exitCode !== 0) throw this.#failure('commit', run)
    return { output: run.stdout }
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Validate one caller-supplied pathspec and return it repo-relative.
   *
   * Refuses, in order: nothing, a NUL byte, anything git would read as an option,
   * a `..` climb, and an absolute path outside the repository. The result is
   * `/`-separated because that is what git expects on every platform, including
   * Windows.
   */
  #pathspec(action: string, candidate: string): string {
    const raw = candidate.trim()
    if (raw === '') throw new GitError(action, 'a path is required')
    if (raw.includes('\0')) throw new GitError(action, 'a path may not contain a NUL byte')
    if (raw.startsWith('-')) {
      throw new GitError(
        action,
        `path '${candidate}' is refused: git would read it as an option, not a path`,
      )
    }

    const absolute = isAbsolute(raw) ? resolve(raw) : resolve(this.root, raw)
    const rel = relative(this.root, absolute)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new GitError(action, `path '${candidate}' is outside the repository ${this.root}`)
    }
    return rel.split(sep).join('/')
  }

  #pathspecs(action: string, paths: string[]): string[] {
    if (paths.length === 0) throw new GitError(action, 'at least one path is required')
    return paths.map((path) => this.#pathspec(action, path))
  }

  /**
   * Run one git subcommand.
   *
   * A NON-ZERO EXIT IS RETURNED, NOT THROWN: "not a repository", "nothing to
   * commit", and "pathspec did not match" are all outcomes a caller reads
   * differently, so each caller decides what a failure means. The one exception is
   * a git binary that could not be started, which is never a git outcome.
   */
  async #run(
    action: string,
    args: string[],
    options: { record?: boolean } = {},
  ): Promise<GitExecResult & { durationMs: number }> {
    const started = Date.now()
    let result: GitExecResult
    try {
      result = await this.#exec(args, { cwd: this.root, timeoutMs: this.#timeoutMs })
    } catch (err) {
      // The default exec never rejects; an injected one might.
      throw new GitError(action, `git ${action} could not run: ${(err as Error).message}`)
    }
    const durationMs = Date.now() - started

    if (options.record === true) {
      await this.#record(action, args, result)
    }

    // A missing binary is never a git outcome, whatever the caller allowed.
    if (result.exitCode === EXIT_SPAWN_FAILED) {
      throw new GitError(
        action,
        `git is not available on this machine: ${firstLine(result.stderr) || 'the git executable could not be started'}`,
        result.exitCode,
      )
    }
    return { ...result, durationMs }
  }

  #failure(action: string, result: GitExecResult): GitError {
    const detail = firstLine(result.stderr) || firstLine(result.stdout) || 'no output'
    return new GitError(action, `git ${action} failed: ${detail}`, result.exitCode)
  }

  /**
   * Record a mutation on the event stream.
   *
   * MUTATIONS ONLY. `status` and `diff` are polled by the panel on every refresh,
   * and an append-only log is a poor place for a read that happens on a timer.
   */
  async #record(action: string, args: string[], result: GitExecResult): Promise<void> {
    if (!this.#events) return
    await this.#events.emit({
      runId: this.#runId,
      kind: 'tool_called',
      payload: {
        tool: 'git',
        action,
        args,
        cwd: this.root,
        ok: result.exitCode === 0,
        exitCode: result.exitCode,
        detail: result.exitCode === 0 ? firstLine(result.stdout) : firstLine(result.stderr),
      },
    })
  }

  /** Record a refusal and return the error to throw. */
  async #deny(action: string, reason: string): Promise<GitError> {
    await this.#events?.emit({
      runId: this.#runId,
      kind: 'tool_denied',
      payload: { tool: 'git', action, reason },
    })
    return new GitError(action, reason)
  }
}
