// Turning a typed line into `{ program, args }` — a SPLITTER, not a shell.
//
// ── THE ONE THING THIS IS NOT ───────────────────────────────────────────────
//
// There is no shell anywhere in the terminal path (see src-tauri/src/command_policy.rs).
// `run_command` takes a program name and an argument VECTOR and hands them to the OS
// unparsed. So this module splits a line on whitespace, honours quotes, and stops.
// It does not expand `~`, `$VAR` or `*`; it does not understand `|`, `>`, `&&` or `;`.
//
// That is a feature, and it must be VISIBLE. Passing `|` through as a literal
// argument would make `git log | head` fail with an incomprehensible message from
// git about a pathspec, so a line containing shell syntax is refused here with a
// sentence that says there is no shell. A confusing success is worse than a clear
// refusal (Requirement 27.5).
//
// ── THE ALLOWLIST MIRROR ────────────────────────────────────────────────────
//
// `programGate` explains a refusal before the user presses Run. It is a MIRROR of
// the Rust allowlist, not a copy of it: the list is fetched from the backend's
// `allowed_programs` command, so there is no second hardcoded array to drift. The
// authoritative check is `command_policy::resolve_program`, which refuses regardless
// of what this function said (Requirement 22.6).
//
// ── WHAT THE ALLOWLIST IS NOT ───────────────────────────────────────────────
//
// It is not a sandbox. `node`, `python`, `npm` and `cargo` all run arbitrary code by
// design — `node -e '...'` is a complete escape hatch and always was. The allowlist
// stops a TYPO and an unintended program name; it does not stop intentional
// execution, and nothing at this layer could. The panel says so on screen rather
// than implying a guarantee it cannot provide (NEED-TO-DO §4.3).
//
// Pure string work: no React, no I/O.
//
// Validates: Requirements 22.6, 27.1, 27.4, 27.5

import { isDenialMessage } from '../ipc/policyMessages'

/** A parsed line, ready for `run_command`. */
export interface ParsedCommand {
  program: string
  args: string[]
}

export type ParseOutcome =
  | { ok: true; command: ParsedCommand }
  /** Empty input. Not an error: pressing Enter on a blank line does nothing. */
  | { ok: false; empty: true }
  | { ok: false; empty?: false; message: string }

/** Shell syntax we refuse to silently reinterpret as literal arguments. */
const SHELL_SYNTAX: Array<{ token: string; explanation: string }> = [
  { token: '|', explanation: 'pipe output between commands' },
  { token: '>', explanation: 'redirect output to a file' },
  { token: '<', explanation: 'redirect input from a file' },
  { token: '&', explanation: 'chain or background commands' },
  { token: ';', explanation: 'run several commands in sequence' },
  { token: '$(', explanation: 'substitute a command' },
  { token: '`', explanation: 'substitute a command' },
]

/**
 * Split on unquoted whitespace, honouring `"` and `'`. Quotes group; they are not
 * part of the argument. A backslash is LEFT ALONE — on Windows it is a path
 * separator far more often than an escape, and reinterpreting it would corrupt
 * every `src\main.ts` a user types.
 */
function split(line: string): { ok: true; parts: string[] } | { ok: false; message: string } {
  const parts: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | null = null

  for (const ch of line) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null
        continue
      }
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started) {
        parts.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }

  if (quote !== null) {
    return { ok: false, message: `Unclosed ${quote === '"' ? 'double' : 'single'} quote.` }
  }
  if (started) parts.push(current)
  return { ok: true, parts }
}

export function parseCommandLine(line: string): ParseOutcome {
  if (line.trim() === '') return { ok: false, empty: true }

  if (line.includes('\0')) {
    // The backend rejects this too; saying it here names the character.
    return { ok: false, message: 'That line contains a NUL byte, which cannot be passed to a program.' }
  }

  for (const { token, explanation } of SHELL_SYNTAX) {
    if (!line.includes(token)) continue
    return {
      ok: false,
      message:
        `There is no shell here, so '${token}' cannot ${explanation}. ` +
        'Each command runs as a program with an argument list — run the parts separately.',
    }
  }

  const parts = split(line)
  if (!parts.ok) return { ok: false, message: parts.message }
  if (parts.parts.length === 0) return { ok: false, empty: true }

  const [program, ...args] = parts.parts
  return { ok: true, command: { program, args } }
}

export interface ProgramGate {
  ok: boolean
  /** Why not, ready to render. Empty when `ok`. */
  reason: string
}

/**
 * Whether the panel will offer to run `program`.
 *
 * `allowed` comes from the backend. When it is empty the list is not known yet
 * (the fetch is in flight, or failed), and this gate says so instead of guessing —
 * a gate that passes everything when it knows nothing would put the first honest
 * refusal after the confirmation dialog.
 */
export function programGate(program: string, allowed: readonly string[]): ProgramGate {
  if (program === '') return { ok: false, reason: 'No program named.' }

  if (program.includes('/') || program.includes('\\')) {
    return {
      ok: false,
      reason: `'${program}' is a path. Name an allowlisted program instead: ${[...allowed].join(', ')}.`,
    }
  }

  if (allowed.length === 0) {
    return {
      ok: false,
      reason: 'The list of runnable programs has not been read from the backend yet.',
    }
  }

  // The backend strips a trailing `.exe`/`.cmd` before matching, so the mirror does
  // too — otherwise `npm.cmd` would be refused here and accepted there.
  const bare = program.replace(/\.(exe|cmd)$/i, '')
  if (bare === 'cd') {
    return {
      ok: false,
      reason:
        'cd is a shell builtin, not a program. Every command runs in the project root; there is no working directory to change.',
    }
  }
  if (!allowed.includes(bare)) {
    return {
      ok: false,
      reason: `'${program}' is not on the terminal allowlist. Allowed: ${[...allowed].join(', ')}.`,
    }
  }
  return { ok: true, reason: '' }
}

/** How a `run_command` rejection is classified for display. */
export type RunFailureKind = 'denied' | 'failed'

/**
 * A refusal and a breakage read differently and must not be conflated: a denied
 * command means the policy did its job, a failed one means the machine could not
 * do it. Collapsing them would make a missing `python` look like a security event
 * and a blocked program look like a bug.
 *
 * The phrases that mark a denial live in ipc/policyMessages.ts, so this classifier
 * and the editor's file-error messages read the same list — and so a W2-style reword
 * of the Rust policy wording cannot leave this keyed on a phrase the backend no
 * longer emits (which would have mis-read an out-of-project refusal as a breakage).
 */
export function classifyRunFailure(message: string): RunFailureKind {
  return isDenialMessage(message) ? 'denied' : 'failed'
}

/** The line as it would be re-typed. Quoted only where a space forces it. */
export function formatCommand(command: ParsedCommand): string {
  const show = (value: string) => (/\s/.test(value) ? `"${value}"` : value)
  return [command.program, ...command.args].map(show).join(' ')
}
