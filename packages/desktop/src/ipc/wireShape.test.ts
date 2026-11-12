// The IPC wire shape: what Rust SERIALIZES must be what TypeScript DECLARES.
//
// ── THE BUG THIS TEST EXISTS FOR ────────────────────────────────────────────
//
// `read_dir` returned `struct FsEntry { name, path, is_dir }` with serde's default
// naming, so the field crossed the boundary as `is_dir`. `bridge.ts` declares
// `isDir`. In the shipped application every entry therefore read as `undefined`,
// which is falsy, so EVERY directory rendered as a file and the Explorer's
// folder/file distinction was broken — while the test suite stayed green, because
// the doubles for the file seam build entries in the intended shape (`isDir`)
// rather than the shape the backend actually emits. `CommandOutput.exit_code` had
// the identical defect one struct below it.
//
// A double that cannot reproduce a bug is not a safe double, and the fix is not
// "write a better double": the doubles sit at the TypeScript seam, above the IPC
// boundary, and nothing they do can prove what serde emits. So the boundary itself
// is asserted here, statically, in the only place both sides are visible at once —
// the Rust source and the TypeScript declarations. Tauri converts ARGUMENTS from
// camelCase to snake_case; it does nothing whatsoever to a RETURN value.
//
// This is a source-level test on purpose. `cargo test` cannot link in this
// environment, and even where it can, a Rust test proving serde emits `isDir` still
// would not prove `bridge.ts` reads `isDir`. Only a test that reads both files can.
//
// Validates: Requirements 13.8, 27.5

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const mainRs = fs.readFileSync(
  path.resolve(__dirname, '../../src-tauri/src/main.rs'),
  'utf8',
)
const bridgeTs = fs.readFileSync(path.resolve(__dirname, './bridge.ts'), 'utf8')

const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

/** `is_dir` → `isDir`, exactly as serde's `rename_all = "camelCase"` does it. */
function toCamelCase(field: string): string {
  const [head, ...rest] = field.split('_')
  return [head, ...rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1))].join('')
}

interface RustStruct {
  name: string
  /** Field names as they appear ON THE WIRE, rename applied. */
  wireFields: string[]
  renamed: boolean
}

/** Every `#[derive(… Serialize …)] struct` in main.rs, with its serialized names. */
function rustStructs(): RustStruct[] {
  const source = mainRs.replace(/\/\/\/.*$/gm, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const pattern = /((?:#\[[^\]]*\]\s*)+)struct\s+(\w+)\s*\{([^}]*)\}/g
  const found: RustStruct[] = []

  for (const match of source.matchAll(pattern)) {
    const [, attributes, name, body] = match as unknown as [string, string, string, string]
    if (!/derive\([^)]*\bSerialize\b/.test(attributes)) continue
    const renamed = /rename_all\s*=\s*"camelCase"/.test(attributes)

    const fields: string[] = []
    for (const line of body.split('\n')) {
      const field = /^\s*(?:pub\s+)?([a-z_][a-z0-9_]*)\s*:/i.exec(line)
      if (field) fields.push(renamed ? toCamelCase(field[1]!) : field[1]!)
    }
    found.push({ name, wireFields: fields, renamed })
  }
  return found
}

/** Every `export interface` in bridge.ts, with its declared property names. */
function tsInterfaces(): Map<string, string[]> {
  const source = withoutComments(bridgeTs)
  const pattern = /export interface (\w+)\s*\{([\s\S]*?)\n\}/g
  const found = new Map<string, string[]>()

  for (const match of source.matchAll(pattern)) {
    const [, name, body] = match as unknown as [string, string, string]
    const fields: string[] = []
    for (const line of body.split('\n')) {
      const field = /^\s*(?:readonly\s+)?(['"]?)([\w$-]+)\1\??\s*:/.exec(line)
      if (field) fields.push(field[2]!)
    }
    found.set(name, fields)
  }
  return found
}

const structs = rustStructs()
const interfaces = tsInterfaces()

/**
 * Structs a command hands back to the webview — the ones whose names must line up.
 *
 * `GitStatus` was here until B-010 removed the native git_status/git_diff commands:
 * git is an engine capability now (packages/core/src/tools/git.ts), with no struct
 * crossing this bridge, so it is no longer part of the wire shape.
 */
const RETURNED_TO_WEBVIEW = ['FsEntry', 'CommandOutput', 'ProviderKeyPresence']

describe('the Rust wire shape matches what bridge.ts declares', () => {
  it('finds both sides to compare', () => {
    // A guard that parses nothing passes vacuously. Both parsers must have found
    // every struct/interface pair the IPC boundary actually carries.
    expect(structs.map((s) => s.name).sort()).toEqual([...RETURNED_TO_WEBVIEW].sort())
    for (const name of RETURNED_TO_WEBVIEW) {
      expect(interfaces.get(name), `bridge.ts declares no ${name}`).toBeDefined()
      expect(interfaces.get(name)!.length).toBeGreaterThan(0)
    }
  })

  it.each(RETURNED_TO_WEBVIEW)('serializes %s under the names TypeScript reads', (name) => {
    const rust = structs.find((s) => s.name === name)!
    const declared = interfaces.get(name)!

    expect(
      [...rust.wireFields].sort(),
      `Rust serializes ${name} as {${rust.wireFields.join(', ')}} but bridge.ts reads ` +
        `{${declared.join(', ')}}. A mismatched field arrives as undefined — it does not ` +
        `throw, it does not warn, and no double above this boundary can catch it. ` +
        `Add #[serde(rename_all = "camelCase")] to the struct, or fix the interface.`,
    ).toEqual([...declared].sort())
  })

  it('renames every multi-word field rather than relying on there being none', () => {
    // A struct whose fields happen to be single words is correct today and one field
    // away from the is_dir bug tomorrow. The attribute is the invariant, not the
    // current field list.
    const unrenamed = structs.filter((s) => !s.renamed).map((s) => s.name)
    expect(
      unrenamed,
      'Every struct serialized to the webview carries #[serde(rename_all = "camelCase")], ' +
        'so adding a snake_case field cannot silently break the frontend.',
    ).toEqual([])
  })

  it('keeps the is_dir regression itself covered', () => {
    // Named explicitly, because this is the field that shipped broken.
    const fsEntry = structs.find((s) => s.name === 'FsEntry')!
    expect(fsEntry.wireFields).toContain('isDir')
    expect(fsEntry.wireFields).not.toContain('is_dir')
    const output = structs.find((s) => s.name === 'CommandOutput')!
    expect(output.wireFields).toContain('exitCode')
    expect(output.wireFields).not.toContain('exit_code')
  })
})
