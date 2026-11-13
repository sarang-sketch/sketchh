// The seeded registry, checked against itself.
//
// TWO JOBS.
//
// 1. **The pin cannot go stale.** `registry.json` carries a content hash per
//    skill, and a stale hash fails every install of that skill — which is
//    indistinguishable from tampering. The first test recomputes the manifest from
//    the committed skills and asserts the committed bytes match, so editing a
//    seed without re-pinning fails HERE, with an instruction, instead of failing
//    for a user as a tamper refusal.
//
// 2. **The shipped registry really installs.** Not "the format parses" — the real
//    installer, into a real temp project, verified against the real committed
//    digests, read back by the real loader.
//
// Requirement 11.3 asks for six specific packs (a seventh, `egm`, was added
// later for Google's Elephant-Goldfish Model). The last test asserts every
// pack is represented, so "we shipped a registry" cannot mean "we shipped
// one skill".
//
// Validates: Requirements 11.1, 11.2, 11.3, 11.4

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MANIFEST_FILENAME,
  SEED_REGISTRY_DIR,
  SEED_REGISTRY_NAME,
  SEED_SKILLS,
  SKILL_PACKS,
  installSkill,
  installedSkillsDir,
  loadManifest,
  pinRegistry,
  serializeManifest,
} from '../src/registry/index.js'
import { SENSITIVE_CAPABILITIES, parseCapabilities } from '../src/capabilities/index.js'
import { loadSkillFile } from '../src/skills/index.js'

/** `packages/core/registry`, from this test file. */
const REGISTRY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', SEED_REGISTRY_DIR)

const tmpDirs: string[] = []

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-seed-'))
  tmpDirs.push(dir)
  return dir
}

describe('the committed manifest is current', () => {
  it('matches what pinRegistry computes for the committed skills', async () => {
    const recomputed = await pinRegistry({
      dir: REGISTRY_DIR,
      registry: SEED_REGISTRY_NAME,
      distribution: 'curated',
      seeds: SEED_SKILLS,
    })
    const committed = await readFile(join(REGISTRY_DIR, MANIFEST_FILENAME), 'utf8')

    expect(
      serializeManifest(recomputed),
      'registry.json is stale: a seeded skill changed since it was pinned. ' +
        'Run `npm run build && npm run pin:registry -w @sketch/core` and commit the result.',
    ).toBe(committed)
  })

  it('pins a digest and a per-file list for every seed', async () => {
    const { manifest } = await loadManifest(REGISTRY_DIR)
    expect(manifest.entries).toHaveLength(SEED_SKILLS.length)
    for (const entry of manifest.entries) {
      expect(entry.digest.startsWith('sha256:'), entry.name).toBe(true)
      // Without the per-file list a refusal cannot name the file that differs.
      expect(entry.files?.length ?? 0, entry.name).toBeGreaterThan(0)
    }
  })

  it('is curated, not open (Requirement 11.6)', async () => {
    const { manifest } = await loadManifest(REGISTRY_DIR)
    expect(manifest.registry).toBe(SEED_REGISTRY_NAME)
    // The open marketplace does not ship until signing and scoping are tested AND
    // a review queue exists. Flipping this string is not how that happens.
    expect(manifest.distribution).toBe('curated')
  })
})

describe('the seeded skills (Requirement 11.3)', () => {
  it('covers every pack', async () => {
    const { manifest } = await loadManifest(REGISTRY_DIR)
    const packs = new Set(manifest.entries.map((entry) => entry.pack))
    for (const pack of SKILL_PACKS) {
      expect(packs.has(pack), `no seeded skill in the "${pack}" pack`).toBe(true)
    }
  })

  it('grants each skill only what its own frontmatter asks for', async () => {
    // The registry's grant and the skill's request are maintained separately on
    // purpose (a publisher must not be able to grant itself capabilities). That
    // they agree is asserted, not assumed.
    const { manifest } = await loadManifest(REGISTRY_DIR)
    for (const entry of manifest.entries) {
      const skill = await loadSkillFile(join(REGISTRY_DIR, ...entry.path.split('/'), 'SKILL.md'))
      const declared = parseCapabilities(skill.capabilities ?? [])
      expect(declared.ok, `${entry.name} declares an unknown capability`).toBe(true)
      expect([...declared.capabilities].sort(), entry.name).toEqual([...entry.capabilities].sort())
    }
  })

  it('keeps the grants minimal: no seed holds a sensitive capability', async () => {
    // A seeded registry is what a new user installs first. None of these needs to
    // read the home directory, spawn a process, or read a credential, and the one
    // that touches the network says so in its own name.
    const { manifest } = await loadManifest(REGISTRY_DIR)
    for (const entry of manifest.entries) {
      for (const capability of entry.capabilities) {
        expect(
          SENSITIVE_CAPABILITIES.includes(capability as never),
          `${entry.name} was granted ${capability}`,
        ).toBe(false)
      }
    }
    // Exactly one seed reaches the network, so a reviewer knows where to look.
    const networked = manifest.entries.filter((entry) => entry.capabilities.includes('net:http'))
    expect(networked.map((entry) => entry.name)).toEqual(['web-data'])
  })

  it('ships prose only: no seeded skill carries an executable', async () => {
    // This is what makes the whole seed set installable before the tool layer
    // exists (7.3): installing them cannot run anyone's code.
    const { manifest } = await loadManifest(REGISTRY_DIR)
    const executable = /\.(?:py|sh|js|mjs|cjs|ts|rb|ps1|bat|exe|bin)$/i
    for (const entry of manifest.entries) {
      for (const file of entry.files ?? []) {
        expect(executable.test(file.path), `${entry.name} ships ${file.path}`).toBe(false)
      }
    }
  })

  it('records provenance and a license for every entry', async () => {
    const { manifest } = await loadManifest(REGISTRY_DIR)
    for (const entry of manifest.entries) {
      expect(entry.source, entry.name).toBeTruthy()
      expect(entry.license, entry.name).toBe('Apache-2.0')
      expect(entry.summary.length, entry.name).toBeGreaterThan(20)
      expect(entry.version, entry.name).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })

  it('loads every seed into the Skill shape with a real body', async () => {
    const { manifest } = await loadManifest(REGISTRY_DIR)
    for (const entry of manifest.entries) {
      const skill = await loadSkillFile(join(REGISTRY_DIR, ...entry.path.split('/'), 'SKILL.md'))
      expect(skill.name, entry.name).toBe(entry.name)
      expect(skill.description.length, entry.name).toBeGreaterThan(20)
      // A skill whose body is a stub is a skill that does nothing.
      expect(skill.body.length, entry.name).toBeGreaterThan(400)
    }
  })
})

describe('installing from the shipped registry', () => {
  it('installs every seed into a real project, verified against the committed digests', async () => {
    const { manifest, dir } = await loadManifest(REGISTRY_DIR)
    const project = await makeProject()

    for (const entry of manifest.entries) {
      const result = await installSkill({
        manifest,
        registryDir: dir,
        name: entry.name,
        projectRoot: project,
      })
      expect(result.reason, entry.name).toBeNull()
      expect(result.ok, entry.name).toBe(true)
      expect(result.digest, entry.name).toBe(entry.digest)
      expect(result.granted, entry.name).toEqual(entry.capabilities)
      // The registry grant and the skill's request agree, so there is nothing to warn about.
      expect(result.warnings, entry.name).toEqual([])
    }

    // And the installed directory is loadable as a skill set, in one call.
    const { loadSkills } = await import('../src/skills/index.js')
    const loaded = await loadSkills(installedSkillsDir(project))
    expect(loaded.diagnostics).toEqual([])
    expect(loaded.skills.map((skill) => skill.name)).toEqual(
      manifest.entries.map((entry) => entry.name).sort(),
    )
  })
})
