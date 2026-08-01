// The curated skill registry: a pinned manifest, a content hash per skill, and
// an installer that refuses on mismatch.
//
// The trust model, stated plainly: this is a CONTENT PIN, not a signature. It
// proves what you install matches the manifest; it does not prove who wrote the
// manifest. See the header of `manifest.ts`.

export {
  DIGEST_PREFIX,
  IGNORED_ENTRIES,
  describeDifference,
  diffDigests,
  hashBytes,
  hashSkillDirectory,
  manifestLine,
  skillFiles,
} from './hash.js'
export type { DigestDifference, DirectoryDigest, FileDigest } from './hash.js'

export {
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  ManifestError,
  SKILL_PACKS,
  isSkillPack,
  loadManifest,
  parseManifest,
  serializeManifest,
} from './manifest.js'
export type {
  ManifestEntry,
  ManifestLoadResult,
  RegistryManifest,
  SkillPack,
} from './manifest.js'

export { installSkill, installedSkillsDir, verifySkill } from './install.js'
export type { InstallOptions, InstallResult, VerifyResult } from './install.js'

export { pinRegistry, writePinnedRegistry } from './pin.js'
export type { PinOptions, SeedMetadata } from './pin.js'

export { SEED_REGISTRY_DIR, SEED_REGISTRY_NAME, SEED_SKILLS } from './seeds.js'
