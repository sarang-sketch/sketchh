// The pinned registry manifest.
//
// ── WHAT A MANIFEST IS FOR ──────────────────────────────────────────────────
//
// A skill is code that runs with the user's permissions — the authors of the
// most demanding community skill say exactly that in their own README. So the
// registry pins, per skill: the digest of its directory (Requirement 11.1), the
// capabilities it declares, and where it came from. Installation recomputes the
// digest and REFUSES on any difference (Requirement 11.2). Not a warning: a
// refusal, naming the file that differs.
//
// ── WHY THE MANIFEST IS DATA, NOT CODE ──────────────────────────────────────
//
// `registry.json` is a committed JSON file with a `version` field, parsed by the
// validator below. It is not a TypeScript object literal, because a manifest has
// to be publishable, diffable, and verifiable by something that is not this
// program. The format will change; `MANIFEST_VERSION` is how a reader detects
// that rather than mis-parsing it.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
//
// This is a CONTENT PIN, not a cryptographic signature. It proves that what you
// install is byte-for-byte what the manifest describes; it does NOT prove who
// wrote the manifest. The trust root is the manifest shipping inside a signed
// release (Requirement 26.3), and nothing in this repository signs releases yet
// — that gap is recorded rather than papered over with a homemade signature
// scheme, which would be worse than an honest content pin.
//
// Validates: Requirements 11.1, 11.2

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DIGEST_PREFIX, type FileDigest } from './hash.js'

/** Bumped when the persisted shape changes. A mismatch is a load error. */
export const MANIFEST_VERSION = 1

/** Filename of the pinned manifest inside a registry directory. */
export const MANIFEST_FILENAME = 'registry.json'

/** The six packs Requirement 11.3 names. `pack` is a curation label, not a scope. */
export const SKILL_PACKS = [
  'context-packing',
  'web-data',
  'engineering',
  'frontend-design',
  'research',
  'finance-quant',
] as const

export type SkillPack = (typeof SKILL_PACKS)[number]

export function isSkillPack(value: unknown): value is SkillPack {
  return typeof value === 'string' && (SKILL_PACKS as readonly string[]).includes(value)
}

/** One pinned skill. */
export interface ManifestEntry {
  /** Skill name. Unique within a manifest, and the install directory name. */
  name: string
  /** Publisher's version string. Opaque to us; recorded and displayed. */
  version: string
  /** Curation label. */
  pack: SkillPack
  /** One line, for a list. The skill's own `description` is the long form. */
  summary: string
  /** Directory holding the skill, relative to the manifest, POSIX separators. */
  path: string
  /** `sha256:<hex>` over the skill directory. See `hash.ts` for the algorithm. */
  digest: string
  /**
   * Capabilities the skill is GRANTED if installed. The registry's copy, not
   * the skill's own frontmatter claim — `verifySkill` compares the two and
   * reports a mismatch, because a skill asking for more than the registry
   * granted is exactly the discrepancy a user needs to see.
   */
  capabilities: string[]
  /** Where it came from: a URL, a repo, or `sketch` for one we wrote. */
  source: string
  /** SPDX identifier. A vendored file with no recorded license is a liability. */
  license: string
  /**
   * Per-file digests, in canonical order.
   *
   * Optional, and purely diagnostic: the directory `digest` above is what decides
   * whether an install proceeds, and it covers every byte on its own. This list
   * exists so a refusal can name THE FILE that differs instead of saying "hash
   * mismatch" — see `describeDifference`. A manifest without it still refuses
   * correctly and says out loud that it cannot localise.
   */
  files?: FileDigest[]
}

export interface RegistryManifest {
  version: number
  /** Human name of this registry. */
  registry: string
  /**
   * Whether this registry accepts entries that have not been reviewed.
   * `curated` is the only value 11.6 permits until the open marketplace ships.
   */
  distribution: 'curated' | 'open'
  entries: ManifestEntry[]
}

export interface ManifestLoadResult {
  manifest: RegistryManifest
  /** Directory the manifest was read from. Entry paths resolve against it. */
  dir: string
  path: string
}

/** A manifest that could not be read or is not well-formed. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestError'
  }
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManifestError(`${what} must be an object`)
  }
  return value as Record<string, unknown>
}

function readString(source: Record<string, unknown>, key: string, what: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ManifestError(`${what}.${key} must be a non-empty string`)
  }
  return value
}

function readStringArray(source: Record<string, unknown>, key: string, what: string): string[] {
  const value = source[key]
  if (!Array.isArray(value)) {
    throw new ManifestError(`${what}.${key} must be an array of strings`)
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ManifestError(`${what}.${key}[${index}] must be a non-empty string`)
    }
    return entry
  })
}

function readFileDigests(value: unknown, what: string): FileDigest[] {
  if (!Array.isArray(value)) {
    throw new ManifestError(`${what}.files must be an array when present`)
  }
  return value.map((raw, index) => {
    const where = `${what}.files[${index}]`
    const file = asObject(raw, where)
    const digest = readString(file, 'digest', where)
    if (!digest.startsWith(DIGEST_PREFIX)) {
      throw new ManifestError(`${where}.digest must start with "${DIGEST_PREFIX}"`)
    }
    const bytes = file['bytes']
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) {
      throw new ManifestError(`${where}.bytes must be a non-negative integer`)
    }
    return { path: readString(file, 'path', where), digest, bytes }
  })
}

/**
 * Parse and validate a manifest.
 *
 * Every field is checked, and an invalid manifest THROWS rather than degrading
 * to a partial registry. This is the opposite of `loadRepoGraph`'s "corrupt
 * index means rebuild" rule, and deliberately so: a graph is a cache that can be
 * recomputed, while a manifest is the only thing standing between the user and
 * unverified code. Silently loading half of it would mean installing skills the
 * broken half was supposed to describe.
 */
export function parseManifest(text: string): RegistryManifest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new ManifestError(
      `manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const root = asObject(raw, 'manifest')
  const version = root['version']
  if (version !== MANIFEST_VERSION) {
    throw new ManifestError(
      `manifest version must be ${MANIFEST_VERSION}, found ${JSON.stringify(version)}`,
    )
  }

  const distribution = root['distribution']
  if (distribution !== 'curated' && distribution !== 'open') {
    throw new ManifestError(`manifest.distribution must be "curated" or "open"`)
  }

  const rawEntries = root['entries']
  if (!Array.isArray(rawEntries)) {
    throw new ManifestError('manifest.entries must be an array')
  }

  const seen = new Set<string>()
  const entries: ManifestEntry[] = rawEntries.map((value, index) => {
    const what = `manifest.entries[${index}]`
    const entry = asObject(value, what)

    const name = readString(entry, 'name', what)
    if (seen.has(name)) {
      // Two entries with one name means the installer's behaviour depends on
      // array order, which is not a property anyone should have to know.
      throw new ManifestError(`${what}.name duplicates an earlier entry: ${name}`)
    }
    seen.add(name)

    const pack = entry['pack']
    if (!isSkillPack(pack)) {
      throw new ManifestError(`${what}.pack must be one of ${SKILL_PACKS.join(', ')}`)
    }

    const digest = readString(entry, 'digest', what)
    if (!digest.startsWith(DIGEST_PREFIX)) {
      throw new ManifestError(`${what}.digest must start with "${DIGEST_PREFIX}"`)
    }

    const path = readString(entry, 'path', what)
    if (path.startsWith('/') || path.includes('..') || path.includes('\\')) {
      // A manifest is data from outside; an entry path is joined onto a
      // directory. `../../` in it is a write outside the registry.
      throw new ManifestError(
        `${what}.path must be a relative POSIX path inside the registry, found ${JSON.stringify(path)}`,
      )
    }

    return {
      name,
      version: readString(entry, 'version', what),
      pack,
      summary: readString(entry, 'summary', what),
      path,
      digest,
      capabilities: readStringArray(entry, 'capabilities', what),
      source: readString(entry, 'source', what),
      license: readString(entry, 'license', what),
      ...(entry['files'] === undefined ? {} : { files: readFileDigests(entry['files'], what) }),
    }
  })

  return {
    version: MANIFEST_VERSION,
    registry: readString(root, 'registry', 'manifest'),
    distribution,
    entries,
  }
}

/** Read and validate `<dir>/registry.json`. */
export async function loadManifest(dir: string): Promise<ManifestLoadResult> {
  const path = join(dir, MANIFEST_FILENAME)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    throw new ManifestError(
      `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return { manifest: parseManifest(text), dir, path }
}

/** Serialize deterministically: entries sorted by name, two-space indent. */
export function serializeManifest(manifest: RegistryManifest): string {
  const ordered: RegistryManifest = {
    version: MANIFEST_VERSION,
    registry: manifest.registry,
    distribution: manifest.distribution,
    entries: [...manifest.entries]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((entry) => ({
        name: entry.name,
        version: entry.version,
        pack: entry.pack,
        summary: entry.summary,
        path: entry.path,
        digest: entry.digest,
        capabilities: [...entry.capabilities].sort(),
        source: entry.source,
        license: entry.license,
        // Already in canonical (path-sorted) order from `hashSkillDirectory`;
        // re-sorted here so a hand-edited manifest still serializes canonically.
        ...(entry.files === undefined
          ? {}
          : {
              files: [...entry.files]
                .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
                .map((file) => ({ path: file.path, digest: file.digest, bytes: file.bytes })),
            }),
      })),
  }
  return `${JSON.stringify(ordered, null, 2)}\n`
}
