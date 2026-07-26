// Structural guard for the client seam: components see the interface, never an
// implementation. Walks src/ with nothing but node:fs and node:path, the same way
// packages/core/test/deps.test.ts guards the zero-dependency rule.
//
// Validates: Requirements 13.3

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Modules that name a concrete transport. Only the factory may reference these. */
const CONCRETE_CLIENTS = ['mockClient', 'stdioClient', 'httpClient']

/** The one module allowed to choose an implementation. */
const FACTORY = join(srcRoot, 'lib', 'factory.ts')

function collectSourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      found.push(...collectSourceFiles(full))
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue
    if (/\.test\.(ts|tsx)$/.test(entry)) continue
    found.push(full)
  }
  return found
}

function importSpecifiers(file: string): string[] {
  const source = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')

  const specifiers: string[] = []
  for (const pattern of [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]!)
  }
  return specifiers
}

const sourceFiles = collectSourceFiles(srcRoot)

describe('client seam', () => {
  it('finds source files to inspect', () => {
    expect(sourceFiles.length).toBeGreaterThan(5)
  })

  it('lets no module except the factory import a concrete client', () => {
    const offenders = sourceFiles
      .filter((file) => file !== FACTORY)
      .flatMap((file) =>
        importSpecifiers(file)
          .filter((specifier) =>
            CONCRETE_CLIENTS.some((name) => specifier.endsWith(`/${name}`) || specifier === `./${name}`),
          )
          .map((specifier) => `${relative(srcRoot, file)} -> '${specifier}'`),
      )

    expect(
      offenders,
      `Requirement 13.3: selection happens in one factory (src/lib/factory.ts). A ` +
        `component that imports a concrete client pins the UI to one transport and ` +
        `breaks the sidecar drop-in. Import { useSketchClient } from lib/ClientProvider instead.`,
    ).toEqual([])
  })

  it('keeps the factory itself out of component code', () => {
    // Only the provider may construct the client; components read it from context.
    const allowed = new Set([join(srcRoot, 'lib', 'ClientProvider.tsx')])
    const offenders = sourceFiles
      .filter((file) => !allowed.has(file) && file !== FACTORY)
      .flatMap((file) =>
        importSpecifiers(file)
          .filter((specifier) => specifier.endsWith('/factory') || specifier === './factory')
          .map((specifier) => `${relative(srcRoot, file)} -> '${specifier}'`),
      )

    expect(offenders).toEqual([])
  })
})
