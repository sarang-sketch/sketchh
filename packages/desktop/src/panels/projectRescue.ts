// Project Rescue — pure analyzer.
//
// Takes a file tree the caller already holds (paths, sizes, optional contents)
// and returns findings. It reads no disk and calls no client: the client seam
// has no method that returns file sizes or contents (`projectFiles` returns
// paths only), so the coordinator must supply the tree. It never returns the
// contents of a secret file — a `.env` is named, never quoted.

export type RescueSeverity = 'info' | 'warn' | 'error'

export interface RescueFile {
  path: string
  size: number
  content?: string
}

export interface RescueFinding {
  severity: RescueSeverity
  title: string
  detail: string
  file?: string
}

export interface RescueSummary {
  error: number
  warn: number
  info: number
  total: number
}

export interface RescueAnalysis {
  findings: RescueFinding[]
  summary: RescueSummary
}

/** Files larger than this are flagged. */
export const LARGE_FILE_BYTES = 1_000_000

/** Extensions treated as binary content (never scanned for TODOs). */
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'svg',
  'pdf', 'zip', 'gz', 'tar', 'exe', 'dll', 'so', 'dylib',
  'wasm', 'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'wav', 'mov', 'db', 'sqlite',
])

const SEVERITY_RANK: Record<RescueSeverity, number> = { error: 0, warn: 1, info: 2 }

function basename(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] ?? path
}

function extension(path: string): string {
  const base = basename(path)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot + 1).toLowerCase()
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? '' : path.slice(0, idx)
}

export interface AnalyzeProjectInput {
  files: RescueFile[]
  /** `git status --porcelain` output, or the engine's status text, when available. */
  gitStatus?: string
  /** Directory paths known to exist (a file list alone cannot show an empty dir). */
  dirs?: string[]
}

export function analyzeProject(input: AnalyzeProjectInput): RescueAnalysis {
  const { files } = input
  const findings: RescueFinding[] = []
  const byPath = new Map(files.map((f) => [f.path, f]))
  const has = (name: string) => byPath.has(name)

  // (a) package.json / lockfile.
  const hasPackageJson = has('package.json')
  const lockfiles = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'].filter(has)
  if (!hasPackageJson) {
    if (lockfiles.length > 0) {
      findings.push({
        severity: 'error',
        title: 'Lockfile without package.json',
        detail: `Found ${lockfiles.join(', ')} but no package.json. Dependency installs cannot be reproduced from a lockfile alone.`,
      })
    } else {
      findings.push({
        severity: 'warn',
        title: 'No package.json',
        detail:
          'No package.json at the project root. If this is not a Node project, ignore this; otherwise dependency and script metadata is missing.',
      })
    }
  } else if (lockfiles.length === 0) {
    findings.push({
      severity: 'warn',
      title: 'No lockfile',
      detail:
        'package.json exists but no lockfile (package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lockb) was found. Installs may resolve different dependency versions on different machines.',
      file: 'package.json',
    })
  }

  for (const file of files) {
    const base = basename(file.path)

    // (f) .env present — name it, never show its content.
    if (base === '.env' || base.startsWith('.env.')) {
      findings.push({
        severity: 'error',
        title: 'Secret risk: .env file present',
        detail:
          'A .env file is in the project tree. Check it is git-ignored and never committed; its contents are never shown here.',
        file: file.path,
      })
      continue
    }

    // (b) large files.
    if (file.size > LARGE_FILE_BYTES) {
      findings.push({
        severity: 'warn',
        title: 'Large file',
        detail: `File is ${(file.size / 1_000_000).toFixed(1)} MB (over the 1 MB threshold). Consider git-lfs, generated-output exclusion, or trimming it.`,
        file: file.path,
      })
    }

    // (d) no extension / binary-ish.
    const ext = extension(file.path)
    if (ext === '' && !base.startsWith('.')) {
      findings.push({
        severity: 'info',
        title: 'File with no extension',
        detail: 'This file has no extension, so editors and tools cannot infer its type. Rename it or add it to a known list if it is meant to be extensionless (e.g. Makefile, Dockerfile).',
        file: file.path,
      })
    } else if (BINARY_EXTENSIONS.has(ext)) {
      findings.push({
        severity: 'info',
        title: 'Binary file',
        detail: `Binary content (.${ext}) is stored in the project. Check it is intentional and not a build artifact that belongs in .gitignore.`,
        file: file.path,
      })
    }
    if (file.content !== undefined && file.content.includes('\0')) {
      findings.push({
        severity: 'warn',
        title: 'Binary-looking content',
        detail: 'File content contains NUL bytes, so it is probably binary despite its name. It was not scanned for TODOs.',
        file: file.path,
      })
      continue
    }

    // (c) TODO / FIXME counts (text files only, content supplied).
    if (file.content !== undefined && !BINARY_EXTENSIONS.has(ext)) {
      let todos = 0
      let fixmes = 0
      for (const line of file.content.split('\n')) {
        if (/\bTODO\b/.test(line)) todos += 1
        if (/\bFIXME\b/.test(line)) fixmes += 1
      }
      if (todos > 0 || fixmes > 0) {
        const total = todos + fixmes
        findings.push({
          severity: total >= 5 ? 'warn' : 'info',
          title: `TODO / FIXME markers (${total})`,
          detail: `${todos} TODO(s), ${fixmes} FIXME(s). Only files whose contents were supplied are scanned.`,
          file: file.path,
        })
      }
    }
  }

  // (e) empty src dirs — only knowable when the caller passes directory paths.
  const knownDirs = input.dirs ?? []
  const fileDirs = new Set(files.map((f) => dirOf(f.path)))
  for (const dir of knownDirs) {
    if (!dir.startsWith('src')) continue
    const hasFiles = [...fileDirs].some((d) => d === dir || d.startsWith(`${dir}/`))
    if (!hasFiles) {
      findings.push({
        severity: 'info',
        title: 'Empty src directory',
        detail: `Directory ${dir}/ contains no files. Remove it or add the module it was meant to hold.`,
        file: dir,
      })
    }
  }

  // git status, when supplied as text.
  const gitStatus = input.gitStatus
  if (gitStatus !== undefined) {
    if (/not a git repository/i.test(gitStatus)) {
      findings.push({
        severity: 'warn',
        title: 'Not a git repository',
        detail: 'git status reports this folder is not a git repository. Initialise one to get history and safe undo.',
      })
    } else if (/untracked files/i.test(gitStatus)) {
      findings.push({
        severity: 'info',
        title: 'Untracked files present',
        detail: 'git status lists untracked files. Review them before committing so secrets or build output are not added by accident.',
      })
    }
  }

  findings.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.title.localeCompare(b.title),
  )
  const summary: RescueSummary = {
    error: findings.filter((f) => f.severity === 'error').length,
    warn: findings.filter((f) => f.severity === 'warn').length,
    info: findings.filter((f) => f.severity === 'info').length,
    total: findings.length,
  }
  return { findings, summary }
}
