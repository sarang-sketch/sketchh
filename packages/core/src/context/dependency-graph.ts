// Builds a lightweight dependency graph by parsing import statements.
// Language-aware for JS/TS/Python; best-effort for others.

import { dirname, join, normalize } from 'node:path'

export interface DependencyGraph {
  // relativePath -> set of relativePaths it imports (only intra-project resolved)
  edges: Map<string, Set<string>>
}

// Matches: `import ... from '...'`, `export ... from '...'`, bare `import '...'`,
// and dynamic `import('...')`. Stops at newline so it won't cross statements.
const JS_IMPORT_FROM = /(?:import|export)\b[^'"\n]*?['"]([^'"]+)['"]/g
// Matches: `require('...')`
const JS_REQUIRE = /require\(\s*['"]([^'"]+)['"]\s*\)/g
const PY_IMPORT = /^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/gm

export function buildDependencyGraph(
  files: Array<{ relativePath: string; content: string }>
): DependencyGraph {
  const known = new Set(files.map(f => f.relativePath))
  const edges = new Map<string, Set<string>>()

  for (const file of files) {
    const deps = new Set<string>()
    const raw = extractImportSpecifiers(file.relativePath, file.content)
    for (const spec of raw) {
      const resolved = resolveImportSpecifier(file.relativePath, spec, known)
      if (resolved) deps.add(resolved)
    }
    edges.set(file.relativePath, deps)
  }

  return { edges }
}

/**
 * The raw, unresolved module specifiers a file references.
 *
 * Exported because parsing and resolution have different costs and different
 * invalidation rules. Parsing depends only on a file's own bytes, so an
 * incremental index caches the specifiers per file and never re-parses an
 * unchanged file (see `context/repo-graph.ts`). RESOLUTION depends on the whole
 * file set — adding `src/b.ts` changes what `./b` in an untouched `src/a.ts`
 * points at — so it is redone on every build from the cached specifiers.
 */
export function extractImportSpecifiers(path: string, content: string): string[] {
  const specs: string[] = []
  if (/\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/.test(path)) {
    for (const m of content.matchAll(JS_IMPORT_FROM)) specs.push(m[1])
    for (const m of content.matchAll(JS_REQUIRE)) specs.push(m[1])
  } else if (path.endsWith('.py')) {
    for (const m of content.matchAll(PY_IMPORT)) {
      const spec = m[1] ?? m[2]
      if (spec) {
        const converted = pythonSpecToPath(spec)
        if (converted) specs.push(converted)
      }
    }
  }
  return specs
}

// Convert a Python relative import (e.g. `.helper`, `..pkg.mod`) into a
// relative filesystem-style spec (`./helper`, `../pkg/mod`) that resolveImport
// understands. Absolute imports (no leading dot) are ignored — they are
// external packages or stdlib.
function pythonSpecToPath(spec: string): string | null {
  if (!spec.startsWith('.')) return null
  let dots = 0
  while (dots < spec.length && spec[dots] === '.') dots++
  const rest = spec.slice(dots).replace(/\./g, '/')
  // one dot = current dir (./), two dots = parent (../), etc.
  const prefix = dots === 1 ? './' : '../'.repeat(dots - 1)
  return prefix + rest
}

/** Emitted-extension → source-extension candidates, for the NodeNext rewrite. */
const JS_TO_TS_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
}

function extensionOf(path: string): string {
  const match = /\.[^./]+$/.exec(path)
  return match === null ? '' : match[0]
}

/**
 * Resolve one relative specifier against the known file set, or null for an
 * external package. Pure and cheap: no filesystem access, no parsing.
 */
export function resolveImportSpecifier(
  fromPath: string,
  spec: string,
  known: Set<string>
): string | null {
  // Only resolve relative imports; external packages are ignored
  if (!spec.startsWith('.')) return null

  const baseDir = dirname(fromPath)
  const candidate = normalize(join(baseDir, spec)).replace(/\\/g, '/')

  const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.py']
  for (const ext of extensions) {
    const withExt = candidate + ext
    if (known.has(withExt)) return withExt
  }

  // NodeNext rewrite. A TypeScript file imports its EMITTED specifier, so
  // `import './helper.js'` inside `helper.ts`'s neighbour refers to
  // `helper.ts` on disk. Without this the graph has zero edges for any
  // NodeNext codebase — including this one, where every relative import
  // carries a `.js` extension by rule.
  const rewrite = JS_TO_TS_EXTENSIONS[extensionOf(candidate)]
  if (rewrite !== undefined) {
    const stem = candidate.slice(0, candidate.length - extensionOf(candidate).length)
    for (const ext of rewrite) {
      if (known.has(stem + ext)) return stem + ext
    }
  }

  // Try index files
  for (const idx of ['/index.ts', '/index.js', '/index.tsx', '/__init__.py']) {
    const withIdx = (candidate + idx).replace(/\\/g, '/')
    if (known.has(withIdx)) return withIdx
  }
  return null
}

// Given a set of seed files, expand to include their direct dependencies.
export function expandWithDependencies(
  graph: DependencyGraph,
  seeds: string[],
  maxDepth = 1
): string[] {
  const result = new Set<string>(seeds)
  let frontier = [...seeds]

  for (let depth = 0; depth < maxDepth; depth++) {
    const next: string[] = []
    for (const path of frontier) {
      const deps = graph.edges.get(path)
      if (!deps) continue
      for (const dep of deps) {
        if (!result.has(dep)) {
          result.add(dep)
          next.push(dep)
        }
      }
    }
    frontier = next
    if (frontier.length === 0) break
  }

  return [...result]
}
