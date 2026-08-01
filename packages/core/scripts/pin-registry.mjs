// Re-pin the seeded registry: `npm run pin:registry -w @sketch/core`.
//
// Run this after editing any file under `packages/core/registry/skills/`. The
// committed `registry.json` carries a content hash per skill, and a stale hash
// fails EVERY install of that skill — which looks exactly like tampering. So this
// is not optional housekeeping: `registry.seed.test.ts` fails until it is run, with
// a message saying so, rather than letting a user discover it as a tamper refusal.
//
// Imports from `dist`, so `npm run build` has to have run. That is deliberate: the
// pinning code is the same code the installer verifies with, and a script with its
// own copy of the hash algorithm would eventually disagree with it.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { registry } from '../dist/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '..', registry.SEED_REGISTRY_DIR)

const bytes = await registry.writePinnedRegistry({
  dir,
  registry: registry.SEED_REGISTRY_NAME,
  // `curated` is the only value Requirement 11.6 permits until the open
  // marketplace ships with a review queue.
  distribution: 'curated',
  seeds: registry.SEED_SKILLS,
})

const manifest = registry.parseManifest(bytes)
process.stdout.write(
  `pinned ${manifest.entries.length} skill(s) into ${join(dir, registry.MANIFEST_FILENAME)}\n`,
)
for (const entry of manifest.entries) {
  process.stdout.write(
    `  ${entry.name.padEnd(18)} ${entry.digest.slice(0, 19)}…  ${entry.files?.length ?? 0} file(s)  [${entry.capabilities.join(', ')}]\n`,
  )
}
