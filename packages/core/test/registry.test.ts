// Registry tests: the content hash, the pinned manifest, and the refusal.
//
// Uses REAL: temp directories with real files, real `node:crypto`, the real
// skills loader reading the installed result back. Nothing is mocked.
//
// THE TEST THAT CARRIES REQUIREMENT 11.2 is `refuses an install when one byte of
// one script changed`: it installs successfully, flips a single byte in a Python
// file the manifest never mentions by name, and asserts the second install is
// REFUSED and the diagnostic names that file. Hash only `SKILL.md` instead of the
// directory and it passes — which is why the fixture's tampered byte is in a
// script rather than in the prose.
//
// Validates: Requirements 11.1, 11.2, 11.4

import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  DIGEST_PREFIX,
  IGNORED_ENTRIES,
  diffDigests,
  hashSkillDirectory,
  installSkill,
  installedSkillGrantPath,
  installedSkillsDir,
  uninstallSkill,
  loadManifest,
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  ManifestError,
  parseManifest,
  reviewRefusalFor,
  serializeManifest,
  skillFiles,
  verifySkill,
  type ManifestEntry,
  type RegistryManifest,
} from '../src/registry/index.js'
import { loadSkills } from '../src/skills/loader.js'
import { MemoryEventStore } from '../src/events/index.js'

const tmpDirs: string[] = []

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

async function write(root: string, relative: string, content: string): Promise<void> {
  const full = join(root, relative)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, content, 'utf8')
}

// ── the fixture skill ───────────────────────────────────────────────────────
//
// Prose plus a script, because a skill is both and only one of them is protected
// if the hash covers the markdown alone.

const SKILL_MD = `---
name: commit-context
description: Explain why a file looks the way it does, from local git history.
capabilities: git:read, fs:read:project
---

# Commit context

Reconstruct intent from history. Read the log, the co-changed files, and the
commit messages. Never guess at intent that the history does not support.
`

const SCRIPT = `#!/usr/bin/env python3
"""Summarise a file's history. Reads git only."""
import subprocess
import sys


def history(path: str) -> str:
    return subprocess.run(
        ["git", "log", "--follow", "--format=%h %s", "--", path],
        capture_output=True,
        text=True,
        check=False,
    ).stdout


if __name__ == "__main__":
    print(history(sys.argv[1]))
`

/**
 * One byte of the SCRIPT, changed. `check=False` → `check=True` is a single
 * character and a real behaviour change, which is the shape of tampering that
 * matters: nothing about the prose moves.
 *
 * Written as a function with an assertion rather than an inline `.replace` because
 * the first version of this test replaced `'git log'`, which is not a substring of
 * the script (it is `"git", "log"`), so the "tampered" file was byte-identical and
 * three tests passed while proving nothing.
 */
function tamper(script: string): string {
  const tampered = script.replace('check=False', 'check=True')
  if (tampered === script) throw new Error('tamper() changed nothing; fix the fixture')
  return tampered
}

async function seedSkill(registryDir: string, name = 'commit-context'): Promise<string> {
  const dir = join(registryDir, 'skills', name)
  await write(dir, 'SKILL.md', SKILL_MD)
  await write(dir, join('tools', 'history.py'), SCRIPT)
  await write(dir, join('examples', 'usage.md'), '# Usage\n\nAsk about a file.\n')
  return dir
}

/** Pin a seeded skill: hash it, and write a manifest that matches. */
async function seedRegistry(options: { capabilities?: string[] } = {}): Promise<{
  registryDir: string
  manifest: RegistryManifest
  entry: ManifestEntry
  skillDir: string
  files: Awaited<ReturnType<typeof hashSkillDirectory>>['files']
}> {
  const registryDir = await makeDir('sketch-registry-')
  const skillDir = await seedSkill(registryDir)
  const hashed = await hashSkillDirectory(skillDir)

  const entry: ManifestEntry = {
    name: 'commit-context',
    version: '1.0.0',
    pack: 'engineering',
    summary: 'Explain why a file looks the way it does.',
    path: 'skills/commit-context',
    digest: hashed.digest,
    capabilities: options.capabilities ?? ['git:read', 'fs:read:project'],
    source: 'sketch',
    license: 'Apache-2.0',
  }
  const manifest: RegistryManifest = {
    version: MANIFEST_VERSION,
    registry: 'sketch-curated',
    distribution: 'curated',
    entries: [entry],
  }
  await writeFile(join(registryDir, MANIFEST_FILENAME), serializeManifest(manifest), 'utf8')
  return { registryDir, manifest, entry, skillDir, files: hashed.files }
}

// ── the hash ────────────────────────────────────────────────────────────────

describe('the directory content hash (Requirement 11.1)', () => {
  it('covers every file, not just SKILL.md', async () => {
    const dir = await makeDir('sketch-hash-')
    const skillDir = await seedSkill(dir)

    const hashed = await hashSkillDirectory(skillDir)
    expect(hashed.digest.startsWith(DIGEST_PREFIX)).toBe(true)
    expect(hashed.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'examples/usage.md',
      'tools/history.py',
    ])

    // Change the SCRIPT only. The digest must move.
    const before = hashed.digest
    await write(skillDir, join('tools', 'history.py'), `${SCRIPT}# one more comment\n`)
    expect((await hashSkillDirectory(skillDir)).digest).not.toBe(before)
  })

  it('is a pure function of the bytes: same tree, same digest', async () => {
    const first = await makeDir('sketch-hash-a-')
    const second = await makeDir('sketch-hash-b-')
    const a = await seedSkill(first)
    const b = await seedSkill(second)
    expect((await hashSkillDirectory(b)).digest).toBe((await hashSkillDirectory(a)).digest)
  })

  it('changes when a file is renamed but its content is not', async () => {
    // The path is hashed with the bytes, so moving a script into place under a
    // name the manifest trusts is not free.
    const dir = await makeDir('sketch-hash-move-')
    const skillDir = await seedSkill(dir)
    const before = (await hashSkillDirectory(skillDir)).digest

    await rm(join(skillDir, 'tools', 'history.py'))
    await write(skillDir, join('tools', 'run.py'), SCRIPT)
    expect((await hashSkillDirectory(skillDir)).digest).not.toBe(before)
  })

  it('reads bytes, so a CRLF file is a different artifact from an LF one', async () => {
    // Deliberate: the bytes ARE the artifact. A publisher who wants this to not
    // happen ships `.gitattributes`; a loader that normalised silently could be
    // fed a tampered file that still matched.
    const dir = await makeDir('sketch-hash-eol-')
    const lf = join(dir, 'lf')
    const crlf = join(dir, 'crlf')
    await write(lf, 'SKILL.md', 'a\nb\n')
    await write(crlf, 'SKILL.md', 'a\r\nb\r\n')
    expect((await hashSkillDirectory(crlf)).digest).not.toBe(
      (await hashSkillDirectory(lf)).digest,
    )
  })

  it('reproduces the documented algorithm exactly', async () => {
    // A third party must be able to compute this from the header's prose alone.
    // Recomputed here by hand, from `node:crypto`, without calling the module's
    // helpers: if the two ever disagree, the documentation is a lie.
    const dir = await makeDir('sketch-hash-spec-')
    await write(dir, 'b.txt', 'second\n')
    await write(dir, 'a.txt', 'first\n')
    await write(dir, join('nested', 'c.txt'), 'third\n')

    const paths = ['a.txt', 'b.txt', 'nested/c.txt']
    let manifest = ''
    for (const path of paths) {
      const bytes = await readFile(join(dir, ...path.split('/')))
      manifest += `${path}\u0000sha256:${createHash('sha256').update(bytes).digest('hex')}\n`
    }
    const expected = `sha256:${createHash('sha256').update(manifest).digest('hex')}`

    const hashed = await hashSkillDirectory(dir)
    expect(hashed.files.map((file) => file.path)).toEqual(paths)
    expect(hashed.manifest).toBe(manifest)
    expect(hashed.digest).toBe(expected)
  })

  it('ignores only checkout and cache noise', async () => {
    const dir = await makeDir('sketch-hash-ignore-')
    await write(dir, 'SKILL.md', 'body\n')
    const baseline = (await hashSkillDirectory(dir)).digest

    for (const ignored of IGNORED_ENTRIES) {
      await write(dir, join(ignored, 'junk'), 'noise\n')
    }
    expect((await hashSkillDirectory(dir)).digest).toBe(baseline)

    // A dotfile the publisher shipped is NOT noise: it is signed.
    await write(dir, '.env.example', 'TOKEN=\n')
    expect((await hashSkillDirectory(dir)).digest).not.toBe(baseline)
    expect(await skillFiles(dir)).toContain('.env.example')
  })

  it('names the file that differs', async () => {
    const dir = await makeDir('sketch-hash-diff-')
    const skillDir = await seedSkill(dir)
    const before = await hashSkillDirectory(skillDir)

    await write(skillDir, join('tools', 'history.py'), tamper(SCRIPT))
    await write(skillDir, 'NOTICE.md', 'new file\n')
    await rm(join(skillDir, 'examples', 'usage.md'))

    const differences = diffDigests(before.files, (await hashSkillDirectory(skillDir)).files)
    expect(differences.map((difference) => [difference.path, difference.kind])).toEqual([
      ['NOTICE.md', 'added'],
      ['examples/usage.md', 'removed'],
      ['tools/history.py', 'changed'],
    ])
  })
})

// ── the manifest ────────────────────────────────────────────────────────────

describe('the pinned manifest', () => {
  it('round-trips through serialize and parse, canonically', async () => {
    const { registryDir, manifest } = await seedRegistry()
    const loaded = await loadManifest(registryDir)

    // Serialization is CANONICAL, not a mirror: entries sort by name and
    // capabilities sort within an entry, so the bytes are a pure function of the
    // content rather than of the order someone happened to write it in. The
    // seeded entry declares `git:read, fs:read:project`; what lands on disk is
    // sorted, and re-serializing what was parsed reproduces it byte for byte.
    expect(serializeManifest(loaded.manifest)).toBe(serializeManifest(manifest))
    expect(serializeManifest(loaded.manifest)).toBe(
      await readFile(join(registryDir, MANIFEST_FILENAME), 'utf8'),
    )

    expect(loaded.manifest.registry).toBe('sketch-curated')
    expect(loaded.manifest.distribution).toBe('curated')
    expect(loaded.manifest.entries).toHaveLength(1)
    const entry = loaded.manifest.entries[0]!
    expect(entry.name).toBe('commit-context')
    expect(entry.digest).toBe(manifest.entries[0]!.digest)
    expect(entry.capabilities).toEqual(['fs:read:project', 'git:read'])
  })

  it('refuses a manifest it cannot fully validate rather than loading half of it', () => {
    const base = {
      version: MANIFEST_VERSION,
      registry: 'r',
      distribution: 'curated',
      entries: [] as unknown[],
    }
    const entry = {
      name: 'a',
      version: '1',
      pack: 'engineering',
      summary: 's',
      path: 'skills/a',
      digest: 'sha256:abc',
      capabilities: [],
      source: 'sketch',
      license: 'Apache-2.0',
    }

    expect(() => parseManifest('{')).toThrow(ManifestError)
    expect(() => parseManifest(JSON.stringify({ ...base, version: 99 }))).toThrow(/version must be 1/)
    expect(() => parseManifest(JSON.stringify({ ...base, distribution: 'whatever' }))).toThrow(
      /distribution/,
    )
    expect(() =>
      parseManifest(JSON.stringify({ ...base, entries: [{ ...entry, pack: 'nonsense' }] })),
    ).toThrow(/pack must be one of/)
    expect(() =>
      parseManifest(JSON.stringify({ ...base, entries: [{ ...entry, digest: 'md5:abc' }] })),
    ).toThrow(/must start with "sha256:"/)
    for (const unsafeName of ['../escape', 'nested/skill', 'nested\\skill', '.', '..', ' padded']) {
      expect(() =>
        parseManifest(JSON.stringify({ ...base, entries: [{ ...entry, name: unsafeName }] })),
      ).toThrow(/one safe directory segment/)
    }
    // Two entries with one name would make install order-dependent.
    expect(() =>
      parseManifest(JSON.stringify({ ...base, entries: [entry, { ...entry, version: '2' }] })),
    ).toThrow(/duplicates an earlier entry/)
  })

  it('refuses an entry path that escapes the registry directory', () => {
    const manifest = {
      version: MANIFEST_VERSION,
      registry: 'r',
      distribution: 'curated',
      entries: [
        {
          name: 'a',
          version: '1',
          pack: 'engineering',
          summary: 's',
          path: '../../etc',
          digest: 'sha256:abc',
          capabilities: [],
          source: 'sketch',
          license: 'Apache-2.0',
        },
      ],
    }
    expect(() => parseManifest(JSON.stringify(manifest))).toThrow(/relative POSIX path/)
  })
})

// ── verify and install ──────────────────────────────────────────────────────

describe('install (Requirement 11.2)', () => {
  it('installs a skill whose digest matches, and the loader reads it back', async () => {
    const { registryDir, manifest, files } = await seedRegistry()
    const project = await makeDir('sketch-project-')
    const events = new MemoryEventStore({ secrets: [] })

    const result = await installSkill({
      manifest,
      registryDir,
      name: 'commit-context',
      projectRoot: project,
      pinnedFiles: files,
      events,
      runId: 'install-1',
    })

    expect(result.reason).toBeNull()
    expect(result.ok).toBe(true)
    expect(result.written).toEqual(['SKILL.md', 'examples/usage.md', 'tools/history.py'])
    expect(result.dir).toBe(join(installedSkillsDir(project), 'commit-context'))
    // The whole skill landed, scripts included.
    expect(await readFile(join(result.dir!, 'tools', 'history.py'), 'utf8')).toBe(SCRIPT)
    // And it is a real skill, not just a directory of bytes.
    expect(result.skill?.name).toBe('commit-context')
    expect(result.skill?.capabilities).toEqual(['git:read', 'fs:read:project'])
    expect(result.granted).toEqual(['fs:read:project', 'git:read'])
    expect(result.warnings).toEqual([])

    const emitted = await events.readAll()
    expect(emitted.map((event) => event.kind)).toEqual(['tool_called'])
    expect(emitted[0]!.payload.component).toBe('registry')
    expect(emitted[0]!.payload.skill).toBe('commit-context')
  })

  it('refuses an install when one byte of one script changed, and names that script', async () => {
    // REQUIREMENT 11.2. Hash only SKILL.md and this test passes — which is the
    // point of tampering with the Python rather than the prose.
    const { registryDir, manifest, skillDir, files } = await seedRegistry()
    const project = await makeDir('sketch-project-')
    const events = new MemoryEventStore({ secrets: [] })

    const clean = await installSkill({
      manifest,
      registryDir,
      name: 'commit-context',
      projectRoot: project,
      pinnedFiles: files,
    })
    expect(clean.ok).toBe(true)

    // One character, in the script. The prose is untouched.
    await write(skillDir, join('tools', 'history.py'), tamper(SCRIPT))

    const tampered = await installSkill({
      manifest,
      registryDir,
      name: 'commit-context',
      projectRoot: await makeDir('sketch-project-2-'),
      pinnedFiles: files,
      events,
      runId: 'install-2',
    })

    expect(tampered.ok).toBe(false)
    expect(tampered.reason).toContain('refusing to install')
    expect(tampered.reason).toContain('tools/history.py')
    expect(tampered.reason).toContain('content differs')
    // Nothing was written.
    expect(tampered.written).toEqual([])

    const denied = (await events.readAll()).filter((event) => event.kind === 'tool_denied')
    expect(denied).toHaveLength(1)
    expect(denied[0]!.payload.skill).toBe('commit-context')
  })

  it('writes nothing at all when verification fails', async () => {
    const { registryDir, manifest, skillDir, files } = await seedRegistry()
    const project = await makeDir('sketch-project-')
    await write(skillDir, 'SKILL.md', `${SKILL_MD}\nTampered.\n`)

    const result = await installSkill({
      manifest,
      registryDir,
      name: 'commit-context',
      projectRoot: project,
      pinnedFiles: files,
    })

    expect(result.ok).toBe(false)
    // The verify-then-copy order, asserted on the filesystem: the skills
    // directory does not exist, so not one byte was written.
    await expect(readdir(installedSkillsDir(project))).rejects.toThrow()
  })

  it('refuses a manifest grant the vocabulary does not recognise', async () => {
    const { registryDir, manifest, files } = await seedRegistry({
      capabilities: ['git:read', 'netwrok'],
    })
    const project = await makeDir('sketch-project-')

    const result = await installSkill({
      manifest,
      registryDir,
      name: 'commit-context',
      projectRoot: project,
      pinnedFiles: files,
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('not a valid capability set')
    expect(result.reason).toContain('netwrok')
    await expect(readdir(installedSkillsDir(project))).rejects.toThrow()
  })

  it('warns, but installs, when the skill asks for more than it was granted', async () => {
    // The skill's frontmatter asks for git:read + fs:read:project; the registry
    // grants only fs:read:project. The grant wins and the discrepancy is visible.
    const { registryDir, manifest, files } = await seedRegistry({
      capabilities: ['fs:read:project'],
    })
    const project = await makeDir('sketch-project-')

    const result = await installSkill({
      manifest,
      registryDir,
      name: 'commit-context',
      projectRoot: project,
      pinnedFiles: files,
    })

    expect(result.ok).toBe(true)
    expect(result.granted).toEqual(['fs:read:project'])
    expect(result.warnings.join(' ')).toContain('git:read')
    expect(result.warnings.join(' ')).toContain('will be denied')
    const authority = await readFile(installedSkillGrantPath(project, 'commit-context'), 'utf8')
    expect(authority).toContain('fs:read:project')
    expect(authority).not.toContain('git:read')
  })

  it('reports a missing entry by name instead of installing something else', async () => {
    const { registryDir, manifest } = await seedRegistry()
    const result = await installSkill({
      manifest,
      registryDir,
      name: 'not-in-the-registry',
      projectRoot: await makeDir('sketch-project-'),
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('no skill named "not-in-the-registry"')
  })

  it('still refuses when the manifest pins no per-file list, and says why it cannot localise', async () => {
    const { registryDir, manifest, skillDir } = await seedRegistry()
    await write(skillDir, join('tools', 'history.py'), tamper(SCRIPT))

    const verified = await verifySkill(
      join(registryDir, 'skills', 'commit-context'),
      manifest.entries[0]!,
    )
    expect(verified.ok).toBe(false)
    expect(verified.differences).toEqual([])
    expect(verified.reason).toContain('pins only the directory digest')
  })
})

// ── the marketplace gate (Requirement 11.6) ─────────────────────────────────
//
// "The open marketplace SHALL NOT ship until signing and capability scoping are
// both in place and tested, and SHALL include a review queue when it does."
//
// What ships is CURATED — `registry.seed.test.ts` asserts that on the committed
// manifest. What is tested here is the gate that an open registry has to pass, so
// that turning `distribution` to `open` cannot silently mean "install anything".

describe('an open registry requires a review per entry', () => {
  /** The same seeded skill, offered through an `open` registry. */
  async function openRegistry(review?: ManifestEntry['review']) {
    const seeded = await seedRegistry()
    const entry: ManifestEntry = { ...seeded.entry, ...(review === undefined ? {} : { review }) }
    return {
      ...seeded,
      manifest: { ...seeded.manifest, distribution: 'open' as const, entries: [entry] },
      entry,
    }
  }

  it('refuses an entry with no review record', async () => {
    const { registryDir, manifest, files } = await openRegistry()
    const project = await makeDir('sketch-project-')

    const result = await installSkill({
      manifest,
      registryDir,
      name: 'commit-context',
      projectRoot: project,
      pinnedFiles: files,
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('carries no review record')
    expect(result.reason).toContain('review queue')
    // Refused before anything was read or written.
    expect(result.written).toEqual([])
    await expect(readdir(installedSkillsDir(project))).rejects.toThrow()
  })

  it('refuses a pending or rejected review, naming the reviewer', async () => {
    for (const decision of ['pending', 'rejected'] as const) {
      const { registryDir, manifest, files } = await openRegistry({
        by: 'reviewer-1',
        date: '2026-08-01',
        decision,
        notes: 'spawns a subprocess with no stated reason',
      })

      const result = await installSkill({
        manifest,
        registryDir,
        name: 'commit-context',
        projectRoot: await makeDir('sketch-project-'),
        pinnedFiles: files,
      })

      expect(result.ok, decision).toBe(false)
      expect(result.reason, decision).toContain(`is "${decision}", not "approved"`)
      expect(result.reason, decision).toContain('reviewer-1')
      expect(result.reason, decision).toContain('spawns a subprocess')
    }
  })

  it('installs an approved entry', async () => {
    const { registryDir, manifest, files, entry } = await openRegistry({
      by: 'reviewer-1',
      date: '2026-08-01',
      decision: 'approved',
      digest: undefined,
    })

    const result = await installSkill({
      manifest,
      registryDir,
      name: 'commit-context',
      projectRoot: await makeDir('sketch-project-'),
      pinnedFiles: files,
    })

    expect(result.reason).toBeNull()
    expect(result.ok).toBe(true)
    expect(result.digest).toBe(entry.digest)
  })

  it('invalidates a review when the content changed after it', async () => {
    // The escalation this closes: get an approval, then re-pin new bytes and inherit
    // the approval. Approving bytes is the only approval that means anything.
    const { registryDir, manifest, skillDir, files } = await openRegistry({
      by: 'reviewer-1',
      date: '2026-08-01',
      decision: 'approved',
      digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    })
    void skillDir

    const result = await installSkill({
      manifest,
      registryDir,
      name: 'commit-context',
      projectRoot: await makeDir('sketch-project-'),
      pinnedFiles: files,
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('content changed after review')
    expect(result.reason).toContain('needs reviewing again')
  })

  it('does not require a review in a curated registry', async () => {
    // Curation IS the review there, and the manifest is committed and diffable.
    const { registryDir, manifest, files } = await seedRegistry()
    expect(manifest.distribution).toBe('curated')
    expect(manifest.entries[0]!.review).toBeUndefined()

    const result = await installSkill({
      manifest,
      registryDir,
      name: 'commit-context',
      projectRoot: await makeDir('sketch-project-'),
      pinnedFiles: files,
    })
    expect(result.ok).toBe(true)
  })

  it('exposes the policy so a surface cannot invent a second one', async () => {
    const { manifest, entry } = await openRegistry()
    expect(reviewRefusalFor(manifest, entry)).toContain('no review record')
    expect(reviewRefusalFor({ ...manifest, distribution: 'curated' }, entry)).toBeNull()
  })

  it('round-trips a review record through the manifest', async () => {
    const { registryDir, manifest } = await openRegistry({
      by: 'reviewer-1',
      date: '2026-08-01',
      decision: 'approved',
      notes: 'local git only',
    })
    const bytes = serializeManifest(manifest)
    await writeFile(join(registryDir, MANIFEST_FILENAME), bytes, 'utf8')

    const loaded = await loadManifest(registryDir)
    expect(loaded.manifest.distribution).toBe('open')
    expect(loaded.manifest.entries[0]!.review).toEqual({
      by: 'reviewer-1',
      date: '2026-08-01',
      decision: 'approved',
      notes: 'local git only',
    })
  })

  it('refuses a malformed review rather than ignoring it', () => {
    const base = {
      version: MANIFEST_VERSION,
      registry: 'r',
      distribution: 'open',
      entries: [
        {
          name: 'a',
          version: '1',
          pack: 'engineering',
          summary: 's',
          path: 'skills/a',
          digest: 'sha256:abc',
          capabilities: [],
          source: 'sketch',
          license: 'Apache-2.0',
          review: { by: 'r', date: '2026-08-01', decision: 'looks-fine' },
        },
      ],
    }
    // An unrecognised decision must not read as approval, and must not be dropped
    // silently either — dropping it would leave an entry with no review at all,
    // which the gate would then refuse for the wrong stated reason.
    expect(() => parseManifest(JSON.stringify(base))).toThrow(/decision must be/)
  })
})

// ── uninstall (B-002) ───────────────────────────────────────────────────────
//
// Uses the same real fixture, real filesystem, real loader. The property that
// matters: an uninstall removes BOTH the skill directory and its persisted grant,
// is confined to the project's own `.sketch/skills`, refuses a traversing name
// before it builds a path, and is idempotent with an honest result.

describe('uninstall (B-002)', () => {
  async function install(): Promise<{ project: string }> {
    const { registryDir, manifest, files } = await seedRegistry()
    const project = await makeDir('sketch-uninstall-')
    const result = await installSkill({
      manifest,
      registryDir,
      name: 'commit-context',
      projectRoot: project,
      pinnedFiles: files,
    })
    expect(result.ok).toBe(true)
    // The grant exists after install.
    await expect(
      readFile(installedSkillGrantPath(project, 'commit-context'), 'utf8'),
    ).resolves.toContain('commit-context')
    return { project }
  }

  it('removes the skill directory AND its persisted grant, and a run can no longer load it', async () => {
    const { project } = await install()

    const result = await uninstallSkill(project, 'commit-context')
    expect(result.ok).toBe(true)
    expect(result.removedDir).toBe(true)
    expect(result.removedGrant).toBe(true)
    expect(result.reason).toBeNull()

    // The directory is gone.
    await expect(
      readFile(join(installedSkillsDir(project), 'commit-context', 'SKILL.md'), 'utf8'),
    ).rejects.toThrow()
    // The grant file is gone.
    await expect(
      readFile(installedSkillGrantPath(project, 'commit-context'), 'utf8'),
    ).rejects.toThrow()
    // A run reading the installed-skills dir no longer finds it.
    const loaded = await loadSkills(installedSkillsDir(project))
    expect(loaded.skills.some((skill) => skill.name === 'commit-context')).toBe(false)
  })

  it('is idempotent: a second uninstall is ok with nothing removed', async () => {
    const { project } = await install()

    const first = await uninstallSkill(project, 'commit-context')
    expect(first.removedDir).toBe(true)

    const second = await uninstallSkill(project, 'commit-context')
    expect(second.ok).toBe(true)
    expect(second.removedDir).toBe(false)
    expect(second.removedGrant).toBe(false)
    expect(second.reason).toBeNull()
  })

  it('refuses a traversing or otherwise unsafe name before touching the disk', async () => {
    const project = await makeDir('sketch-uninstall-safe-')
    for (const unsafe of ['../escape', 'nested/skill', 'nested\\skill', '.', '..', ' padded', '']) {
      const result = await uninstallSkill(project, unsafe)
      expect(result.ok, unsafe).toBe(false)
      expect(result.removedDir, unsafe).toBe(false)
      expect(result.removedGrant, unsafe).toBe(false)
      expect(result.reason, unsafe).toMatch(/unsafe skill name/)
    }
  })

  it('leaves a sibling skill and its grant untouched', async () => {
    // Confinement in the positive direction: removing one installed skill does not
    // remove another that happens to share the parent directory.
    const { registryDir, manifest, files } = await seedRegistry()
    const project = await makeDir('sketch-uninstall-sibling-')
    await installSkill({ manifest, registryDir, name: 'commit-context', projectRoot: project, pinnedFiles: files })

    // Hand-create a second installed skill directory + grant to stand in for a
    // sibling (seedRegistry only pins one). Its grant file is what we assert survives.
    const otherDir = join(installedSkillsDir(project), 'other-skill')
    await write(otherDir, 'SKILL.md', '---\nname: other-skill\ndescription: x\n---\nbody\n')
    const otherGrant = installedSkillGrantPath(project, 'other-skill')
    await mkdir(dirname(otherGrant), { recursive: true })
    await writeFile(otherGrant, '{"version":1,"name":"other-skill"}\n', 'utf8')

    const result = await uninstallSkill(project, 'commit-context')
    expect(result.ok).toBe(true)
    // The sibling's files and grant are still there.
    await expect(readFile(join(otherDir, 'SKILL.md'), 'utf8')).resolves.toContain('other-skill')
    await expect(readFile(otherGrant, 'utf8')).resolves.toContain('other-skill')
  })
})
