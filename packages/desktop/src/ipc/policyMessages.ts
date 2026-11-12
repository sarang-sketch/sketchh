// The phrases the Rust command policy uses when it REFUSES a path or a command, in
// one place, so every TypeScript layer that has to recognise a refusal reads the same
// list instead of each carrying its own copy.
//
// ── WHY THIS MODULE EXISTS (a cross-item regression) ────────────────────────
//
// `src-tauri/src/command_policy.rs` is the authoritative refusal; the webview never
// decides containment. But several UI layers key off the WORDS of that refusal — to
// turn it into a sentence about a file (editor/fileIo.ts `describeFileFailure`), and
// to tell a policy DENIAL apart from a machine FAILURE (terminal/commandLine.ts
// `classifyRunFailure`). When W2 rewrote the containment message from
//   "<x> is outside the open project root <root>"
// to the actionable, verbatim-prefix-stripped
//   "This <x> is outside the folder you have open in Sketch … open the folder …"
// those layers were left matching the OLD wording. A refused out-of-project path then
// fell through to the generic branch (the editor appended the whole multi-line Rust
// string after "Cannot open …"), and a refused terminal command read as a breakage
// rather than a denial. Neither is a security hole — the Rust side still refuses — but
// both are the "hide an error behind a vaguer one" failure the overhaul is fixing.
//
// The fix is one list, matched case-insensitively, that carries BOTH the current
// wording and the legacy wording. The current phrases are additionally asserted to
// still appear in command_policy.rs by a contract test (lib/policyMessages.test.ts),
// so a future Rust rewrite that moves the wording again fails loudly here instead of
// silently regressing the UI. `command_policy.rs` itself is never changed from here.

/**
 * Phrases the CURRENT `command_policy.rs` emits on a refusal. A contract test asserts
 * each of these substrings is present in the Rust source, so this list cannot drift
 * away from the backend without a test turning red.
 *
 * Grouped by the refusal they identify so each consumer can ask the precise question.
 */
export const CURRENT_POLICY_PHRASES = {
  /** A path above / outside the open folder (command_policy.rs `outside`). */
  outsideProject: 'outside the folder you have open in sketch',
  /** A `..` climb refused before the disk is touched (command_policy.rs `absolutize`). */
  parentEscape: 'escapes the open folder',
  /** No folder open, so no path/command may be used (command_policy.rs `resolve_root`). */
  noProjectRoot: 'no project root is open',
  /** The terminal tool ran without the required explicit confirmation. */
  notConfirmed: 'command not confirmed',
  /** A program that is not on the terminal allowlist. */
  notAllowlisted: 'not on the terminal allowlist',
  /** A path handed where a program name was expected (`program '…' is refused`). */
  programIsPath: 'is refused',
  /** A NUL byte in a path or an argument. */
  nulByte: 'nul byte',
  /** A directory where a file was expected, or vice versa. */
  notADirectory: 'not a directory',
  notAFile: 'not a file',
  cannotWriteDirectory: 'cannot write to a directory',
} as const

/**
 * Phrases OLDER builds emitted for the same refusals, kept so a message produced by a
 * not-yet-rebuilt engine (or a recorded fixture) is still recognised. They are NOT
 * asserted against the current Rust source — they are deliberately historical.
 */
export const LEGACY_POLICY_PHRASES = {
  /** Pre-W2 containment wording. */
  outsideProject: 'outside the open project root',
  /** Pre-W2 parent-escape wording. */
  parentEscape: 'escapes the project root',
} as const

/** Lower-cased, so callers can `includes()` without re-lowercasing the haystack each time. */
const asLower = (value: string): string => value.toLowerCase()

/** A path refused for being outside the open folder — current OR legacy wording. */
export function isOutsideProjectRefusal(message: string): boolean {
  const lower = asLower(message)
  return (
    lower.includes(CURRENT_POLICY_PHRASES.outsideProject) ||
    lower.includes(CURRENT_POLICY_PHRASES.parentEscape) ||
    lower.includes(LEGACY_POLICY_PHRASES.outsideProject) ||
    lower.includes(LEGACY_POLICY_PHRASES.parentEscape)
  )
}

/** No folder is open, so there is nothing to resolve a path against. */
export function isNoProjectRootRefusal(message: string): boolean {
  return asLower(message).includes(CURRENT_POLICY_PHRASES.noProjectRoot)
}

/**
 * Every phrase that marks a DENIAL (the policy did its job) as opposed to a breakage
 * (the machine could not). Current and legacy, so `classifyRunFailure` stays correct
 * across an engine rebuild.
 */
export const DENIAL_PHRASES: readonly string[] = [
  CURRENT_POLICY_PHRASES.notAllowlisted,
  CURRENT_POLICY_PHRASES.programIsPath,
  CURRENT_POLICY_PHRASES.notConfirmed,
  CURRENT_POLICY_PHRASES.outsideProject,
  CURRENT_POLICY_PHRASES.parentEscape,
  CURRENT_POLICY_PHRASES.noProjectRoot,
  CURRENT_POLICY_PHRASES.nulByte,
  CURRENT_POLICY_PHRASES.notADirectory,
  LEGACY_POLICY_PHRASES.outsideProject,
  LEGACY_POLICY_PHRASES.parentEscape,
]

/** True when a `run_command` rejection is a policy denial rather than a machine failure. */
export function isDenialMessage(message: string): boolean {
  const lower = asLower(message)
  return DENIAL_PHRASES.some((phrase) => lower.includes(phrase))
}
