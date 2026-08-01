// Verify, then install. Never the other way round.
//
// ── THE ORDER IS THE SECURITY PROPERTY ──────────────────────────────────────
//
// `verifySkill` recomputes the directory digest and compares it to the pinned
// one BEFORE a single byte is written to the user's project. An installer that
// copied first and verified afterwards would already have put a stranger's
// Python inside `.sketch/skills/`, where the next run would load it. So the copy
// is unreachable until the digest matches, and there is deliberately no
// `force`, no `--skip-verify`, and no `allowUnverified` option: an escape hatch
// on this check is the same thing as not having the check.
//
// A refusal names THE FILE that differs (see `diffDigests`). "Hash mismatch" is
// unactionable; "`tools/collect.py`: content differs" tells the user what to
// look at and tells a publisher what they forgot to re-pin.
//
// ── WHAT ELSE IS CHECKED, AND WHY IT IS NOT FATAL ────────────────────────────
//
// The registry grants capabilities; the skill's own frontmatter declares what it
// wants. Those are two different claims and they can disagree. A skill wanting
// MORE than it was granted is reported as a warning and installed with the
// registry's set — the grant is what the enforcement point will consult
// (`capabilities/`), so the extra request cannot take effect, and refusing the
// install outright would mean a publisher's typo bricks a skill whose blast
// radius is already bounded. The discrepancy is surfaced, not swallowed: it is
// exactly what a reviewer should look at, and `InstallResult.warnings` is what
// the desktop shows before the user confirms.
//
// Validates: Requirements 11.1, 11.2, 11.4

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { EventInput } from '../events/store.js'
import { loadSkills } from '../skills/loader.js'
import type { Skill } from '../types.js'
import { parseCapabilities, type CapabilitySet } from '../capabilities/index.js'
import {
  describeDifference,
  diffDigests,
  hashSkillDirectory,
  type DigestDifference,
  type FileDigest,
} from './hash.js'
import type { ManifestEntry, RegistryManifest } from './manifest.js'

/** Where skills are installed inside a project. */
export function installedSkillsDir(projectRoot: string): string {
  return join(projectRoot, '.sketch', 'skills')
}

/** Verification outcome for one skill directory against its pinned entry. */
export interface VerifyResult {
  ok: boolean
  entry: ManifestEntry
  /** Digest computed from the bytes on disk. */
  computed: string
  /** Digest the manifest pins. */
  expected: string
  /** Per-file digests, in canonical order. */
  files: FileDigest[]
  /**
   * Which files differ. Empty when `ok`. Populated only when the manifest also
   * pins a per-file list — a top-level digest alone can prove tampering but
   * cannot localise it, and this says so rather than guessing.
   */
  differences: DigestDifference[]
  /** Human-readable refusal, or null when it verified. */
  reason: string | null
}

/**
 * Recompute a skill directory's digest and compare it to the manifest.
 *
 * `pinnedFiles` is optional. Without it the verdict is still correct — the
 * top-level digest covers every byte — but a failure cannot name the file. With
 * it, the diagnostic is specific. The seeded registry stores both.
 */
export async function verifySkill(
  dir: string,
  entry: ManifestEntry,
  pinnedFiles?: readonly FileDigest[],
): Promise<VerifyResult> {
  let computed: { digest: string; files: FileDigest[] }
  try {
    computed = await hashSkillDirectory(dir)
  } catch (err) {
    return {
      ok: false,
      entry,
      computed: '',
      expected: entry.digest,
      files: [],
      differences: [],
      reason: `cannot read skill directory ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (computed.digest === entry.digest) {
    return {
      ok: true,
      entry,
      computed: computed.digest,
      expected: entry.digest,
      files: computed.files,
      differences: [],
      reason: null,
    }
  }

  const differences =
    pinnedFiles === undefined ? [] : diffDigests(pinnedFiles, computed.files)

  const detail =
    differences.length === 0
      ? // Said out loud: the manifest pinned only the directory digest, so the
        // refusal is correct but cannot point at a file.
        'the manifest pins only the directory digest, so the differing file cannot be named'
      : differences.map(describeDifference).join('; ')

  return {
    ok: false,
    entry,
    computed: computed.digest,
    expected: entry.digest,
    files: computed.files,
    differences,
    reason:
      `refusing to install "${entry.name}": content hash does not match the pinned manifest ` +
      `(expected ${entry.digest}, computed ${computed.digest}) — ${detail}`,
  }
}

export interface InstallOptions {
  /** The manifest the entry came from, and the directory it was read from. */
  manifest: RegistryManifest
  registryDir: string
  /** Name of the entry to install. */
  name: string
  /** Project to install into. Files land under `.sketch/skills/<name>/`. */
  projectRoot: string
  /** Per-file digests for a localised tamper diagnostic. */
  pinnedFiles?: readonly FileDigest[]
  events?: { emit(event: EventInput): Promise<void> | void }
  runId?: string
  /** File writer seam, for tests that must not touch disk. Defaults to `node:fs`. */
  writeFileBytes?: (path: string, bytes: Buffer) => Promise<void>
}

export interface InstallResult {
  ok: boolean
  name: string
  /** Where it was installed, when it was. */
  dir?: string
  /** The verified digest. */
  digest?: string
  /** Capabilities the registry granted. Enforced, not decorative. */
  granted?: CapabilitySet
  /** The loaded skill, so a caller can show name/description without re-reading. */
  skill?: Skill
  /** Non-fatal findings a user should see before confirming. */
  warnings: string[]
  /** Why it was refused. Null on success. */
  reason: string | null
  /** Files written, relative and sorted. */
  written: string[]
}

async function defaultWriteFileBytes(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
}

/**
 * Install one pinned skill into a project.
 *
 * Verify → check the capability grant is parseable → copy → load it back. The
 * load-back is not ceremony: a skill that verifies but does not parse as a
 * `Skill` would install as a directory the loader silently ignores, and "it
 * installed and does nothing" is a worse outcome than a refusal.
 */
export async function installSkill(options: InstallOptions): Promise<InstallResult> {
  const warnings: string[] = []
  const entry = options.manifest.entries.find((candidate) => candidate.name === options.name)
  if (entry === undefined) {
    return {
      ok: false,
      name: options.name,
      warnings,
      reason: `no skill named "${options.name}" in registry "${options.manifest.registry}"`,
      written: [],
    }
  }

  const sourceDir = join(options.registryDir, ...entry.path.split('/'))
  const verified = await verifySkill(sourceDir, entry, options.pinnedFiles)

  const emit = async (kind: 'tool_called' | 'tool_denied', payload: Record<string, unknown>) => {
    await options.events?.emit({
      runId: options.runId ?? 'registry',
      // There is no `skill_installed` EventKind in the contract and inventing one
      // needs a spec change. An install is an action the engine took on the
      // user's machine, which is what `tool_called` / `tool_denied` already mean,
      // and `component` tells the two apart from a real tool call.
      kind,
      payload: { component: 'registry', ...payload },
    })
  }

  if (!verified.ok) {
    await emit('tool_denied', {
      name: 'skill-install',
      skill: entry.name,
      reason: verified.reason,
      expected: verified.expected,
      computed: verified.computed,
      differences: verified.differences,
    })
    return { ok: false, name: entry.name, warnings, reason: verified.reason, written: [] }
  }

  // The grant is parsed BEFORE anything is written: an unknown capability fails
  // closed (see `capabilities/vocabulary.ts`), and a skill whose grant cannot be
  // understood must not be installed with a grant nobody can enforce.
  const grant = parseCapabilities(entry.capabilities)
  if (!grant.ok) {
    const reason =
      `refusing to install "${entry.name}": its manifest grant is not a valid capability set — ` +
      grant.errors.join('; ')
    await emit('tool_denied', { name: 'skill-install', skill: entry.name, reason })
    return { ok: false, name: entry.name, warnings, reason, written: [] }
  }

  const targetDir = join(installedSkillsDir(options.projectRoot), entry.name)
  const write = options.writeFileBytes ?? defaultWriteFileBytes
  const written: string[] = []
  for (const file of verified.files) {
    const bytes = await readFile(join(sourceDir, file.path))
    await write(join(targetDir, ...file.path.split('/')), bytes)
    written.push(file.path)
  }

  const loaded = await loadSkills(dirname(targetDir))
  const skill = loaded.skills.find((candidate) => candidate.name === entry.name)
  if (skill === undefined) {
    const diagnostics = loaded.diagnostics.length > 0 ? `: ${loaded.diagnostics.join('; ')}` : ''
    return {
      ok: false,
      name: entry.name,
      dir: targetDir,
      digest: verified.computed,
      warnings,
      reason:
        `installed "${entry.name}" verified, but the loader does not recognise it as a skill` +
        `${diagnostics}. The files were written to ${targetDir}; remove them or fix the skill`,
      written,
    }
  }

  // The two claims, compared. See the header for why this warns rather than refuses.
  const wanted = parseCapabilities(skill.capabilities ?? [])
  if (!wanted.ok) {
    warnings.push(
      `the skill declares capabilities the vocabulary does not recognise (${wanted.errors.join('; ')}); ` +
        `the registry grant is what will be enforced`,
    )
  } else {
    const extra = wanted.capabilities.filter((capability) => !grant.capabilities.includes(capability))
    if (extra.length > 0) {
      warnings.push(
        `the skill asks for ${extra.join(', ')}, which the registry did not grant; ` +
          `those calls will be denied`,
      )
    }
  }

  await emit('tool_called', {
    name: 'skill-install',
    skill: entry.name,
    digest: verified.computed,
    capabilities: grant.capabilities,
    files: written.length,
    dir: targetDir,
  })

  return {
    ok: true,
    name: entry.name,
    dir: targetDir,
    digest: verified.computed,
    granted: grant.capabilities,
    skill,
    warnings,
    reason: null,
    written,
  }
}
