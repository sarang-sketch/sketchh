// File walker — lists all indexable files in a project, respecting .gitignore

import { readdir, stat, readFile } from 'node:fs/promises'
import { join, relative, extname } from 'node:path'
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

export interface WalkedFile {
  path: string      // absolute
  relativePath: string
  size: number
  hash: string
  extension: string
}

export async function walkProject(root: string): Promise<WalkedFile[]> {
  const gitignorePatterns = await loadGitignore(root)
  const results: WalkedFile[] = []
  await walk(root, root, gitignorePatterns, results)
  return results
}

async function walk(
  root: string,
  dir: string,
  ignorePatterns: RegExp[],
  results: WalkedFile[]
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }

  await Promise.all(entries.map(async entry => {
    const fullPath = join(dir, entry)
    const relPath = relative(root, fullPath).replace(/\\/g, '/')

    if (shouldSkip(entry, relPath, ignorePatterns)) return

    let info
    try { info = await stat(fullPath) } catch { return }

    if (info.isDirectory()) {
      await walk(root, fullPath, ignorePatterns, results)
    } else if (info.isFile()) {
      const ext = extname(entry).toLowerCase()
      if (!INDEXABLE_EXTENSIONS.has(ext)) return
      if (info.size > MAX_FILE_SIZE) return

      let content: Buffer
      try { content = await readFile(fullPath) } catch { return }

      results.push({
        path: fullPath,
        relativePath: relPath,
        size: info.size,
        hash: createHash('sha256').update(content).digest('hex').slice(0, 16),
        extension: ext,
      })
    }
  }))
}

function shouldSkip(name: string, relPath: string, patterns: RegExp[]): boolean {
  if (SKIP_DIRS.has(name)) return true
  if (name.startsWith('.') && name !== '.env.example') return true
  return patterns.some(p => p.test(relPath))
}

async function loadGitignore(root: string): Promise<RegExp[]> {
  try {
    const content = await readFile(join(root, '.gitignore'), 'utf8')
    return content
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(gitignoreToRegex)
      .filter((r): r is RegExp => r !== null)
  } catch {
    return []
  }
}

function gitignoreToRegex(pattern: string): RegExp | null {
  try {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
    return new RegExp(`(^|/)${escaped}(/|$)`)
  } catch {
    return null
  }
}
