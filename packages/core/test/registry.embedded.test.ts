// The embedded curated registry: byte-identical to registry/, and installable with no
// registry folder configured — which is the situation of every shipped app.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EMBEDDED_REGISTRY_FILES } from '../src/registry/embedded.js'
import { materializeEmbeddedRegistry } from '../src/registry/materialize.js'
import { loadManifest } from '../src/registry/index.js'
import { METHODS } from '../src/rpc/methods.js'
import { createMethodContext } from '../src/rpc/server.js'

const registryDir = fileURLToPath(new URL('../registry/', import.meta.url))
const temps: string[] = []
afterEach(async () => {
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true })
})
async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const name of await readdir(dir)) {
    const path = join(dir, name)
    if ((await stat(path)).isDirectory()) out.push(...(await filesUnder(path)))
    else out.push(path)
  }
  return out
}

function ctxFor(root: string) {
  return createMethodContext('embedded-registry', {
    writeFrame: () => {},
    writeErr: () => {},
    env: {},
    cwd: () => root,
    secrets: new Set(),
  })
}

describe('the embedded registry', () => {
  it('carries exactly the bytes of registry/registry.json and registry/skills/', async () => {
    const expected = new Map<string, Buffer>()
    expected.set('registry.json', await readFile(join(registryDir, 'registry.json')))
    for (const file of await filesUnder(join(registryDir, 'skills'))) {
      expected.set(relative(registryDir, file).split(sep).join('/'), await readFile(file))
    }
    // If this fails, run: node packages/core/scripts/embed-registry.mjs
    expect(Object.keys(EMBEDDED_REGISTRY_FILES).sort()).toEqual([...expected.keys()].sort())
    for (const [path, bytes] of expected) {
      expect(Buffer.from(EMBEDDED_REGISTRY_FILES[path]!, 'base64').equals(bytes), path).toBe(true)
    }
  })

  it('materializes a registry the manifest loader accepts, and repairs an edited copy', async () => {
    const home = await temp('sketch-reghome-')
    const dir = await materializeEmbeddedRegistry(join(home, '.sketch', 'registry'))
    const { manifest } = await loadManifest(dir)
    expect(manifest.entries.length).toBeGreaterThan(0)

    const skill = join(dir, manifest.entries[0]!.path, 'SKILL.md')
    const original = await readFile(skill)
    await writeFile(skill, 'tampered')
    const again = await materializeEmbeddedRegistry(join(home, '.sketch', 'registry'))
    expect(again).toBe(dir)
    expect((await readFile(skill)).equals(original)).toBe(true)
  })

  it('lets skills-catalog and skill-install work with no registry configured', async () => {
    const home = await temp('sketch-reghome-')
    const root = await temp('sketch-regproj-')
    const ctx = ctxFor(root)
    const catalog = (await METHODS['skills-catalog']!({ root, home }, ctx)) as {
      entries: Array<{ name: string; installed: boolean }>
      diagnostic?: string
    }
    expect(catalog.diagnostic).toBeUndefined()
    const entry = catalog.entries.find((e) => e.name === 'commit-context')!
    expect(entry.installed).toBe(false)

    const installed = (await METHODS['skill-install']!({ root, home, name: 'commit-context' }, ctx)) as { ok: boolean }
    expect(installed.ok).toBe(true)
    const after = (await METHODS['skills-catalog']!({ root, home }, ctx)) as { entries: Array<{ name: string; installed: boolean }> }
    expect(after.entries.find((e) => e.name === 'commit-context')!.installed).toBe(true)
    expect(await readFile(join(root, '.sketch', 'skills', 'commit-context', 'SKILL.md'), 'utf8')).toContain('commit')
  })
})
