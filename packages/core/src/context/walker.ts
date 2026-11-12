// File walker — lists every indexable file in a project, respecting `.gitignore`.
//
// This is the foundation of the whole context phase: everything downstream
// (chunking, the dependency graph, retrieval) sees exactly the files this walk
// returns. Three properties matter more than speed, and each one is a product
// bug when it is absent:
//
// 1. IT MUST NOT WALK `node_modules`. An indexer that descends into dependency
//    trees is not slow, it is broken — it will exhaust memory, index code the
//    user did not write, and drown real results in vendored noise. Two
//    independent guards cover it: the `SKIP_DIRS` name list below, and the
//    project's own `.gitignore`.
// 2. IT MUST NOT LEAVE THE PROJECT. A symlink whose target resolves outside the
//    project root is skipped outright, and a symlink that points back at an
//    ancestor cannot loop the walk: every directory is recorded by its resolved
//    real path before descent, so re-entering one is a no-op.
// 3. IT MUST BE DETERMINISTIC. Directory entries are sorted and subdirectories
//    are descended in that order, so the returned sequence is a pure function of
//    the tree. That is what lets `graph.json` be byte-identical across rebuilds
//    and what makes the `maxFiles` cap cut at the same place every time. Files
//    within one directory are still hashed in parallel; only the *order they are
//    appended* is fixed.
//
// Validates: Requirements 18.1

import { readdir, realpath, stat, readFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, relative, extname, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  'coverage', '.cache', '__pycache__', '.venv', 'venv', 'target',
])

const INDEXABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.go', '.java', '.kt', '.swift', '.c', '.cpp', '.h',
  '.css', '.scss', '.html', '.vue', '.svelte',
  '.json', '.yaml', '.yml', '.toml', '.env.example',
  '.md', '.mdx', '.txt',
  '.sh', '.bash', '.zsh',
  '.sql', '.graphql', '.prisma',
])

const MAX_FILE_SIZE = 1024 * 1024 // 1 MB

/**
 * Hard ceiling on indexed files. A 100k-file repository must degrade to a
 * stated, reported limit rather than exhaust memory — `WalkResult.truncated`
 * says whether it did, so a caller can tell the user instead of quietly
 * indexing a fraction of their code.
 */
export const DEFAULT_MAX_FILES = 20_000

export interface WalkedFile {
  path: string      // absolute
  relativePath: string
  size: number
  hash: string
  extension: string
}

export interface WalkOptions {
  /** Cap on files returned. Defaults to `DEFAULT_MAX_FILES`. */
  maxFiles?: number
}

export interface WalkResult {
  files: WalkedFile[]
  /** True when the cap stopped the walk before the tree was exhausted. */
  truncated: boolean
  /** The cap that was in force, so a caller can state it. */
  maxFiles: number
}

/** The files an index should cover. Order is deterministic for a fixed tree. */
export async function walkProject(root: string, options: WalkOptions = {}): Promise<WalkedFile[]> {
  return (await walkProjectDetailed(root, options)).files
}

/** `walkProject` plus whether the cap truncated the result. */
export async function walkProjectDetailed(
  root: string,
  options: WalkOptions = {}
): Promise<WalkResult> {
  return walkWith(root, options, describeFile)
}

/** One file a hash-free walk found: what Find in Files searches. */
export interface PlainFile {
  path: string
  relativePath: string
  size: number
}

export interface PlainWalkResult {
  files: PlainFile[]
  truncated: boolean
  maxFiles: number
  /** Files skipped for being larger than `maxFileBytes`. */
  tooLarge: number
}

/**
 * Every regular file the index walk would enter — same project boundary, same skip
 * list, same `.gitignore` — but with NO extension allowlist and NO hashing. A text
 * search must find a match in a `.rb`, `.cs` or `Dockerfile` the index does not
 * chunk, and has no use for a content hash it would compute only to throw away.
 */
export async function walkPlainFiles(
  root: string,
  options: WalkOptions & { maxFileBytes?: number } = {}
): Promise<PlainWalkResult> {
  const maxFileBytes = Math.max(1, options.maxFileBytes ?? MAX_FILE_SIZE)
  let tooLarge = 0
  const result = await walkWith(root, options, async (full, rel, name) => {
    let info
    try { info = await stat(full) } catch { return null }
    if (!info.isFile()) return null
    if (info.size > maxFileBytes) {
      tooLarge++
      return null
    }
    return { path: full, relativePath: rel, size: info.size, hash: '', extension: extname(name).toLowerCase() }
  })
  return {
    files: result.files.map(({ path, relativePath, size }) => ({ path, relativePath, size })),
    truncated: result.truncated,
    maxFiles: result.maxFiles,
    tooLarge,
  }
}

type Describe = (full: string, rel: string, name: string) => Promise<WalkedFile | null>

async function walkWith(root: string, options: WalkOptions, describe: Describe): Promise<WalkResult> {
  const absRoot = resolve(root)
  const maxFiles = Math.max(0, options.maxFiles ?? DEFAULT_MAX_FILES)

  // Compare containment against the REAL root: on macOS `/tmp` is itself a
  // symlink, so a resolved target would never look "inside" an unresolved root.
  let realRoot = absRoot
  try { realRoot = await realpath(absRoot) } catch { /* missing root: walk yields nothing */ }

  const ctx: WalkContext = {
    root: absRoot,
    realRoot,
    rules: await loadGitignore(absRoot),
    maxFiles,
    files: [],
    truncated: false,
    visited: new Set([realRoot]),
    describe,
  }

  await walk(ctx, absRoot)

  // Two different orders, both deterministic, and the distinction matters:
  // traversal order (sorted entries, files before subdirectories) decides WHICH
  // files the cap keeps; the returned list is then sorted by path so consumers
  // get one stable, locale-independent order regardless of tree shape.
  ctx.files.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0
  )
  return { files: ctx.files, truncated: ctx.truncated, maxFiles }
}

interface WalkContext {
  root: string
  realRoot: string
  rules: IgnoreRule[]
  maxFiles: number
  files: WalkedFile[]
  truncated: boolean
  /** Resolved real paths of directories already entered — the loop breaker. */
  visited: Set<string>
  /** What a walked file becomes; null drops it. */
  describe: Describe
}

async function walk(ctx: WalkContext, dir: string): Promise<void> {
  if (ctx.files.length >= ctx.maxFiles) {
    ctx.truncated = true
    return
  }

  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const dirs: string[] = []
  const files: Array<{ full: string; rel: string; name: string }> = []

  for (const entry of entries) {
    const full = join(dir, entry.name)
    const rel = toPosix(relative(ctx.root, full))
    if (skipByName(entry.name)) continue

    const kind = await classify(ctx, full, entry)
    if (kind === 'skip') continue
    if (isIgnored(ctx.rules, rel, kind === 'dir')) continue

    if (kind === 'dir') dirs.push(full)
    else files.push({ full, rel, name: entry.name })
  }

  // Hash this directory's files in parallel, then append in sorted order so the
  // sequence — and therefore where the cap cuts — does not depend on I/O timing.
  const hashed = await Promise.all(files.map(f => ctx.describe(f.full, f.rel, f.name)))
  for (const file of hashed) {
    if (file === null) continue
    if (ctx.files.length >= ctx.maxFiles) {
      ctx.truncated = true
      return
    }
    ctx.files.push(file)
  }

  for (const child of dirs) {
    await walk(ctx, child)
    if (ctx.truncated) return
  }
}

/**
 * Decide what an entry is, and refuse anything that would take the walk outside
 * the project or around in a circle. Sockets, FIFOs and devices are `skip`:
 * reading them can block forever.
 */
async function classify(
  ctx: WalkContext,
  full: string,
  entry: Dirent
): Promise<'dir' | 'file' | 'skip'> {
  if (entry.isSymbolicLink()) {
    let target: string
    try { target = await realpath(full) } catch { return 'skip' }
    // A link out of the project is not part of the project.
    if (!isWithin(ctx.realRoot, target)) return 'skip'

    let info
    try { info = await stat(full) } catch { return 'skip' }
    if (info.isDirectory()) return enterDirectory(ctx, target)
    return info.isFile() ? 'file' : 'skip'
  }

  if (entry.isDirectory()) {
    let real = full
    try { real = await realpath(full) } catch { /* fall back to the literal path */ }
    return enterDirectory(ctx, real)
  }

  return entry.isFile() ? 'file' : 'skip'
}

/**
 * Claim a directory by its real path. A second claim means a symlink pointed at
 * something already walked — an ancestor loop, or a duplicate subtree. Either
 * way, do not descend again.
 */
function enterDirectory(ctx: WalkContext, realPath: string): 'dir' | 'skip' {
  if (ctx.visited.has(realPath)) return 'skip'
  ctx.visited.add(realPath)
  return 'dir'
}

async function describeFile(full: string, rel: string, name: string): Promise<WalkedFile | null> {
  const ext = extname(name).toLowerCase()
  if (!INDEXABLE_EXTENSIONS.has(ext)) return null

  let info
  try { info = await stat(full) } catch { return null }
  if (!info.isFile()) return null
  if (info.size > MAX_FILE_SIZE) return null

  let content: Buffer
  try { content = await readFile(full) } catch { return null }

  return {
    path: full,
    relativePath: rel,
    size: info.size,
    hash: createHash('sha256').update(content).digest('hex').slice(0, 16),
    extension: ext,
  }
}

/** Cheap, name-only rejection, applied before any filesystem call. */
function skipByName(name: string): boolean {
  if (SKIP_DIRS.has(name)) return true
  return name.startsWith('.') && name !== '.env.example'
}

function isWithin(root: string, candidate: string): boolean {
  if (candidate === root) return true
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

// ── .gitignore ──────────────────────────────────────────────────────────────
//
// A deliberately small subset of the gitignore language, hand-rolled because
// core takes no runtime dependency. Supported: comments, blank lines, `!`
// negation with last-match-wins, a trailing `/` for directory-only patterns, a
// leading or embedded `/` for root-anchored patterns, `*` and `?` within one
// path segment, and `**` across segments. NOT supported: nested `.gitignore`
// files below the root, and character classes. Anything unsupported fails
// toward *indexing* the file — a missed skip costs noise, whereas a wrongly
// skipped file makes real code invisible to retrieval.

interface IgnoreRule {
  negated: boolean
  dirOnly: boolean
  regex: RegExp
}

async function loadGitignore(root: string): Promise<IgnoreRule[]> {
  let content: string
  try {
    content = await readFile(join(root, '.gitignore'), 'utf8')
  } catch {
    return []
  }
  return parseGitignore(content)
}

export function parseGitignore(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of content.split('\n')) {
    const rule = parseRule(raw)
    if (rule !== null) rules.push(rule)
  }
  return rules
}

function parseRule(raw: string): IgnoreRule | null {
  let line = raw.replace(/\r$/, '').trim()
  if (line === '' || line.startsWith('#')) return null

  let negated = false
  if (line.startsWith('!')) {
    negated = true
    line = line.slice(1)
  }

  let dirOnly = false
  if (line.endsWith('/')) {
    dirOnly = true
    line = line.slice(0, -1)
  }
  if (line === '') return null

  // A `/` anywhere but the end anchors the pattern to the repository root,
  // which is git's rule.
  const anchored = line.includes('/')
  if (line.startsWith('/')) line = line.slice(1)
  if (line === '') return null

  const body = globToRegexSource(line)
  const source = anchored ? `^${body}(?:/.*)?$` : `(?:^|/)${body}(?:/.*)?$`

  try {
    return { negated, dirOnly, regex: new RegExp(source) }
  } catch {
    return null
  }
}

function globToRegexSource(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          out += '(?:.*/)?' // `**/` spans zero or more directories
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      out += `\\${c}`
    } else {
      out += c
    }
  }
  return out
}

/**
 * Git semantics: every rule is tested and the LAST match wins, which is what
 * makes `!keep.log` after `*.log` re-include the file.
 */
export function isIgnored(rules: IgnoreRule[], relativePath: string, isDir: boolean): boolean {
  let ignored = false
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue
    if (!rule.regex.test(relativePath)) continue
    ignored = !rule.negated
  }
  return ignored
}
