// The capability vocabulary: what a skill may be granted, and nothing else.
//
// ── FAIL CLOSED ON AN UNKNOWN CAPABILITY ────────────────────────────────────
//
// `parseCapabilities` REJECTS anything not on this list. A skill declaring
// `netwrok` is refused, loudly, naming the typo and listing the vocabulary.
//
// The alternative — ignore what you do not recognise — reads as safe and is not.
// Ignoring an unknown token silently grants nothing, so the skill still installs
// and then behaves inexplicably; the user's mental model says it has network
// access and the enforcement point says it does not. Worse, the same leniency
// applied to a FUTURE vocabulary means an old build silently drops a capability
// a newer manifest granted, and a skill audited as sandboxed on one version is
// something else on another. So an unknown token is an error, always, in both
// directions.
//
// ── THE LIST IS SHORT ON PURPOSE ────────────────────────────────────────────
//
// A user has to read this in a grant dialog and consent to it. Ten items with
// obvious names beats forty precise ones nobody reads. Where a distinction is
// missing, the coarser (more restrictive) capability is what gets granted; a
// finer split can be added later, and adding one is a spec change, not a code
// tweak, because it changes what an existing grant means.
//
// ── WHAT "DEFAULT" MEANS ────────────────────────────────────────────────────
//
// A skill with no `capabilities:` key at all gets {@link DEFAULT_CAPABILITIES}:
// read-only access to the project it was invoked in, and read-only access to
// that project's git history. Not zero — a skill that cannot read the project
// cannot do anything at all, and a vocabulary whose default is useless pushes
// every publisher into asking for everything.
//
// `git:read` is in that default BY EXPLICIT DECISION (2026-08-03), not by
// drift. A repository's history, branches and diffs are part of reading the
// project: the files on disk are one revision of the same bytes, and a skill
// that may read `a.ts` but may not ask when `a.ts` last changed is drawing a
// line users do not recognise. The default is still read-only in both halves —
// `fs:write:project` and `git:write` are both absent, and changing a repository
// remains something a publisher has to declare and a user has to grant.
//
// What that costs, stated plainly: a skill that declares nothing can now run
// `git-status`, `git-branch` and `git-diff` autonomously, so commit messages,
// author names and branch names in this repository are inside the default
// grant. That is the same trust boundary as the file contents already were.
// `git:write` is not, and `capabilities.test.ts` §6 proves the split on a real
// repository by counting commits.
//
// Validates: Requirements 11.4, 11.5, 10.6

/**
 * Every capability, in the order a grant dialog should show them: filesystem,
 * then network, then process, then credentials, then git.
 *
 * `fs:*:project` is scoped to the project root the run was started in;
 * `fs:*:home` is the user's home directory. There is deliberately no
 * `fs:read:any` — a skill that needs to read outside both is not something this
 * vocabulary can describe honestly, and it should be refused rather than
 * approximated.
 */
export const CAPABILITIES = [
  'fs:read:project',
  'fs:write:project',
  'fs:read:home',
  'fs:write:home',
  'net:http',
  'net:localhost',
  'proc:spawn',
  'secrets:read',
  'git:read',
  'git:write',
] as const

export type Capability = (typeof CAPABILITIES)[number]

/** A granted set: sorted, deduplicated, every member from {@link CAPABILITIES}. */
export type CapabilitySet = readonly Capability[]

/**
 * What a skill gets when it declares nothing: read this project, and read this
 * project's git history. Read-only on both halves. See the header for why
 * `git:read` is here and why `git:write` is not.
 */
export const DEFAULT_CAPABILITIES: CapabilitySet = Object.freeze([
  'fs:read:project' as const,
  'git:read' as const,
])

/** One line per capability, for a grant dialog. Plain about what it permits. */
export const CAPABILITY_DESCRIPTIONS: Readonly<Record<Capability, string>> = Object.freeze({
  'fs:read:project': 'Read files inside this project',
  'fs:write:project': 'Create and modify files inside this project',
  'fs:read:home': 'Read files anywhere in your home directory, including other projects',
  'fs:write:home': 'Create and modify files anywhere in your home directory',
  'net:http': 'Make network requests to any host',
  'net:localhost': 'Make network requests to services on this machine only',
  'proc:spawn': 'Start other programs, which then run with your permissions',
  'secrets:read': 'Read stored credentials and API keys',
  'git:read': 'Read this repository\u2019s history, branches and diffs',
  'git:write': 'Commit, stage, branch and otherwise modify this repository',
})

/**
 * Capabilities worth a second look in a review or a grant dialog.
 *
 * Not a security boundary — the enforcement point treats every capability the
 * same. This is a curation and UI signal: these four are the ones that let a
 * skill reach past the project it was pointed at, so a registry reviewer should
 * have to justify each one and a user should see them highlighted.
 */
export const SENSITIVE_CAPABILITIES: CapabilitySet = Object.freeze([
  'fs:read:home' as const,
  'fs:write:home' as const,
  'proc:spawn' as const,
  'secrets:read' as const,
])

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value)
}

export interface ParseCapabilitiesResult {
  ok: boolean
  /** The recognised capabilities, sorted and deduplicated. Empty when `!ok`. */
  capabilities: CapabilitySet
  /** One message per unrecognised token, naming it and the vocabulary. */
  errors: string[]
}

/** Canonical order: the vocabulary's own order, so two grants render alike. */
function canonical(values: Iterable<Capability>): CapabilitySet {
  const present = new Set(values)
  return CAPABILITIES.filter((capability) => present.has(capability))
}

/**
 * Parse a declared or granted capability list.
 *
 * An empty input is VALID and yields an empty set — that is "granted nothing",
 * which is different from "declared nothing". Applying
 * {@link DEFAULT_CAPABILITIES} is the caller's decision, made where it knows
 * whether the key was absent or explicitly empty, and
 * {@link capabilitiesForSkill} is that decision written down.
 */
export function parseCapabilities(values: readonly string[]): ParseCapabilitiesResult {
  const recognised: Capability[] = []
  const errors: string[] = []

  for (const raw of values) {
    const value = raw.trim()
    if (value === '') continue
    if (isCapability(value)) {
      recognised.push(value)
      continue
    }
    errors.push(
      `unknown capability ${JSON.stringify(value)}; the vocabulary is ${CAPABILITIES.join(', ')}`,
    )
  }

  return errors.length > 0
    ? { ok: false, capabilities: [], errors }
    : { ok: true, capabilities: canonical(recognised), errors }
}

/**
 * The set to enforce for a skill, given what it declared.
 *
 * `undefined` means the key was absent → {@link DEFAULT_CAPABILITIES}. An empty
 * ARRAY means the publisher wrote `capabilities: []` deliberately, and that is
 * honoured as "nothing": a skill that says it needs no access should not be
 * handed project reads it never asked for.
 */
export function capabilitiesForSkill(declared: readonly string[] | undefined): ParseCapabilitiesResult {
  if (declared === undefined) {
    return { ok: true, capabilities: DEFAULT_CAPABILITIES, errors: [] }
  }
  return parseCapabilities(declared)
}

/** True when `granted` contains `required`. */
export function grants(granted: CapabilitySet, required: Capability): boolean {
  return granted.includes(required)
}

/** Human-readable grant summary, for a dialog or a log line. */
export function describeCapabilities(granted: CapabilitySet): string {
  if (granted.length === 0) return 'no capabilities: this skill can only read what it is handed'
  return granted.map((capability) => `${capability} (${CAPABILITY_DESCRIPTIONS[capability]})`).join('; ')
}
