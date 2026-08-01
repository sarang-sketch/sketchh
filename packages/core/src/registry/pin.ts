// Pinning: turn a directory of skills into a manifest.
//
// This is the publisher's half of the registry. It hashes each skill directory
// and writes the digests into `registry.json`, so `installSkill` has something to
// compare against.
//
// ── WHY THIS IS CODE AND NOT A ONE-OFF SCRIPT ───────────────────────────────
//
// A manifest maintained by hand goes stale the first time someone edits a skill
// and forgets to re-pin, and a stale manifest fails EVERY install — which looks
// exactly like tampering. So pinning is a function, `npm run pin:registry` calls
// it, and `registry.seed.test.ts` asserts the committed manifest is what this
// function produces for the committed skills. If someone edits a skill without
// re-pinning, the test fails with "re-run npm run pin:registry" rather than a
// user discovering it as a tamper refusal.
//
// The metadata a hash cannot derive — version, pack, summary, source, license,
// and the capability GRANT — lives in `seeds.ts` beside the skills. Capabilities
// are deliberately not read from the skill's own frontmatter here: the grant is
// the registry's decision, and a publisher that could grant itself capabilities
// by editing its own frontmatter is not a registry.
//
// Validates: Requirements 11.1, 11.3

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { parseCapabilities } from '../capabilities/index.js'
import { hashSkillDirectory } from './hash.js'
import {
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  ManifestError,
  serializeManifest,
  type ManifestEntry,
  type RegistryManifest,
  type SkillPack,
} from './manifest.js'

/** Everything about a seeded skill that hashing cannot discover. */
export interface SeedMetadata {
  name: string
  version: string
  pack: SkillPack
  summary: string
  /** Directory relative to the registry root, POSIX separators. */
  path: string
  /** The GRANT. The registry's decision, not the skill's request. */
  capabilities: string[]
  source: string
  license: string
}

export interface PinOptions {
  /** Registry root. `registry.json` is written here; `path` resolves against it. */
  dir: string
  registry: string
  /** `open` is refused until 11.6's preconditions are met — see `distribution`. */
  distribution?: 'curated' | 'open'
  seeds: readonly SeedMetadata[]
}

/**
 * Hash every seeded skill and build the manifest. Pure apart from reading the
 * skill directories; it writes nothing.
 */
export async function pinRegistry(options: PinOptions): Promise<RegistryManifest> {
  const entries: ManifestEntry[] = []

  for (const seed of options.seeds) {
    const grant = parseCapabilities(seed.capabilities)
    if (!grant.ok) {
      // A registry that pins a grant nobody can enforce is worse than no registry.
      throw new ManifestError(
        `cannot pin "${seed.name}": its grant is not a valid capability set — ${grant.errors.join('; ')}`,
      )
    }

    const dir = join(options.dir, ...seed.path.split('/'))
    let hashed: Awaited<ReturnType<typeof hashSkillDirectory>>
    try {
      hashed = await hashSkillDirectory(dir)
    } catch (err) {
      throw new ManifestError(
        `cannot pin "${seed.name}": ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (hashed.files.length === 0) {
      throw new ManifestError(`cannot pin "${seed.name}": ${dir} contains no files`)
    }

    entries.push({
      name: seed.name,
      version: seed.version,
      pack: seed.pack,
      summary: seed.summary,
      path: seed.path,
      digest: hashed.digest,
      capabilities: [...grant.capabilities],
      source: seed.source,
      license: seed.license,
      files: hashed.files,
    })
  }

  return {
    version: MANIFEST_VERSION,
    registry: options.registry,
    distribution: options.distribution ?? 'curated',
    entries,
  }
}

/** Pin and write `<dir>/registry.json`. Returns the bytes written. */
export async function writePinnedRegistry(options: PinOptions): Promise<string> {
  const manifest = await pinRegistry(options)
  const bytes = serializeManifest(manifest)
  await writeFile(join(options.dir, MANIFEST_FILENAME), bytes, 'utf8')
  return bytes
}
