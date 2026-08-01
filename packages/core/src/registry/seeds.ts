// The seeded curated registry: six packs, six skills, all local-only.
//
// ── WHY THESE ARE WRITTEN HERE AND NOT VENDORED ─────────────────────────────
//
// The plan considered vendoring two skills from a community repository
// (`awesome-llm-apps`). They are not vendored, deliberately, and the reasoning is
// recorded rather than left implicit:
//
//   * Vendoring means copying third-party code into this repository, which needs
//     a network fetch, a license review, and a recorded commit SHA — and it means
//     shipping scripts that will eventually run with the user's permissions. None
//     of that is work to do implicitly while seeding a registry.
//   * Every seed here is PROSE. No seeded skill ships an executable, which is why
//     the whole seed set is installable before the tool layer exists (7.3) without
//     anyone running a stranger's Python.
//   * The registry format is what makes community skills installable, and it is
//     format-compatible on purpose: any `SKILL.md` directory can be pinned by
//     `pinRegistry` and installed by `installSkill` with no change to either.
//
// So Requirement 11.3's six packs are satisfied by skills written for this
// project, and adapting community skills is a later, deliberate act with its own
// license and review step.
//
// ── THE GRANT IS THE REGISTRY'S DECISION ────────────────────────────────────
//
// `capabilities` below is what the skill IS GRANTED. Each skill's own frontmatter
// separately declares what it WANTS, and `installSkill` compares the two and warns
// on a difference. A publisher that could grant itself capabilities by editing its
// own frontmatter is not a registry, so these two lists are maintained apart on
// purpose — and the fact that they agree today is asserted by a test, not assumed.
//
// Every grant here is the minimum the skill's own instructions require. Four of the
// six get nothing but project reads.
//
// Validates: Requirements 11.3, 11.4

import type { SeedMetadata } from './pin.js'

/** Registry name, as it appears in the manifest and in the UI. */
export const SEED_REGISTRY_NAME = 'sketch-curated'

/**
 * Where the seeded skills live, relative to `packages/core`.
 *
 * Outside `src/` on purpose: these are data, not code, and nothing imports them.
 * `packages/core/registry/` is shipped alongside `dist` (see `files` in
 * package.json), so an installed engine can seed a project without a network
 * fetch — which is what makes the $0, offline promise hold for skills too.
 */
export const SEED_REGISTRY_DIR = 'registry'

/**
 * The six packs Requirement 11.3 names, one skill each.
 *
 * `version` is `1.0.0` across the board because they are published together for
 * the first time; they version independently from here.
 */
export const SEED_SKILLS: readonly SeedMetadata[] = [
  {
    name: 'context-packing',
    version: '1.0.0',
    pack: 'context-packing',
    summary: 'Choose what code the model sees under a fixed token budget, and degrade detail before coverage.',
    path: 'skills/context-packing',
    // Reads the project to decide what to include. Nothing else.
    capabilities: ['fs:read:project'],
    source: 'sketch',
    license: 'Apache-2.0',
  },
  {
    name: 'commit-context',
    version: '1.0.0',
    pack: 'engineering',
    summary: 'Reconstruct why code exists from local git history, separating what the history says from what you infer.',
    path: 'skills/commit-context',
    // Local git only: no network, and it cannot write to the repository.
    capabilities: ['git:read', 'fs:read:project'],
    source: 'sketch',
    license: 'Apache-2.0',
  },
  {
    name: 'scope-discipline',
    version: '1.0.0',
    pack: 'engineering',
    summary: 'Check a diff against its stated intent and report what it touches that it did not need to.',
    path: 'skills/scope-discipline',
    capabilities: ['git:read', 'fs:read:project'],
    source: 'sketch',
    license: 'Apache-2.0',
  },
  {
    name: 'web-data',
    version: '1.0.0',
    pack: 'web-data',
    summary: 'Fetch and extract data with the request budget, the failure modes and the provenance all stated.',
    path: 'skills/web-data',
    // THE ONLY SEED WITH NETWORK ACCESS, and the only one whose grant a user has
    // a real decision to make about. It gets `net:http` and nothing else — no
    // project write, no process spawn, no credential read.
    capabilities: ['net:http'],
    source: 'sketch',
    license: 'Apache-2.0',
  },
  {
    name: 'frontend-design',
    version: '1.0.0',
    pack: 'frontend-design',
    summary: 'Interface code that is accessible, honest about every state, and uses the project\u2019s own design language.',
    path: 'skills/frontend-design',
    capabilities: ['fs:read:project'],
    source: 'sketch',
    license: 'Apache-2.0',
  },
  {
    name: 'research-stage',
    version: '1.0.0',
    pack: 'research',
    summary: 'Investigate before implementing, and keep what was verified separate from what was assumed.',
    path: 'skills/research-stage',
    capabilities: ['fs:read:project'],
    source: 'sketch',
    license: 'Apache-2.0',
  },
  {
    name: 'finance-quant',
    version: '1.0.0',
    pack: 'finance-quant',
    summary: 'Financial and numerical code with exact money arithmetic, stated units, and no advice.',
    path: 'skills/finance-quant',
    capabilities: ['fs:read:project'],
    source: 'sketch',
    license: 'Apache-2.0',
  },
]
