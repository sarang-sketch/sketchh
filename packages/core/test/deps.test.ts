// Guard tests for the zero-dependency rule and NodeNext import discipline.
//
// These are structural tests: they read the package manifest and walk src/ with
// nothing but node:fs and node:path. No glob library, no dev-dependency beyond
// the test runner itself — the guard must not violate the rule it enforces.
//
// Validates: Requirements 1.3, 1.4, 1.5, 1.7, 1.8

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcRoot = join(packageRoot, 'src')

const SKIP_DIRS = new Set(['node_modules', 'dist'])

// Recursively collect every .ts file under `dir`, skipping build and dep output.
function collectTsFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      found.push(...collectTsFiles(full))
    } else if (entry.endsWith('.ts')) {
      found.push(full)
    }
  }
  return found
}

interface Specifier {
  file: string
  specifier: string
}

// Extract every module specifier a file references:
//   import ... from 'y'      import 'y'
//   export ... from 'y'      import('y')
// Comment bodies are stripped first so documentation examples do not register
// as real imports.
function extractSpecifiers(file: string): Specifier[] {
  const source = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')

  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]

  const out: Specifier[] = []
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      out.push({ file: file.slice(packageRoot.length + 1), specifier: match[1]! })
    }
  }
  return out
}

const sourceFiles = collectTsFiles(srcRoot)
const specifiers = sourceFiles.flatMap(extractSpecifiers)

describe('zero-dependency constraint', () => {
  it('finds source files to inspect', () => {
    // A guard that inspects nothing is not a guard.
    expect(sourceFiles.length).toBeGreaterThan(0)
    expect(specifiers.length).toBeGreaterThan(0)
  })

  it('declares no runtime dependencies in package.json', () => {
    const manifest = JSON.parse(
      readFileSync(join(packageRoot, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }

    const declared = Object.keys(manifest.dependencies ?? {})
    expect(
      declared,
      `@sketch/core is dependency-free by constraint: it must bundle to a single ` +
        `sidecar file and a local-first install must never fail on a native module. ` +
        `Found runtime dependencies: ${declared.join(', ')}. Move it to ` +
        `devDependencies, or hand-roll it behind a seam in src/.`,
    ).toEqual([])
  })

  it('imports only relative paths or node: builtins', () => {
    const offenders = specifiers.filter(
      ({ specifier }) =>
        !specifier.startsWith('.') && !specifier.startsWith('node:'),
    )

    expect(
      offenders.map((o) => `${o.file} -> '${o.specifier}'`),
      `Every non-relative import under src/ must be prefixed 'node:'. A bare ` +
        `specifier means a third-party package crept into the dependency-free core.`,
    ).toEqual([])
  })

  it('gives every relative import an explicit .js extension', () => {
    const offenders = specifiers.filter(
      ({ specifier }) => specifier.startsWith('.') && !specifier.endsWith('.js'),
    )

    expect(
      offenders.map((o) => `${o.file} -> '${o.specifier}'`),
      `Under module/moduleResolution NodeNext, relative imports resolve at ` +
        `runtime and must carry the emitted '.js' extension. Extensionless and ` +
        `directory imports will compile but fail when Node loads dist/.`,
    ).toEqual([])
  })
})
