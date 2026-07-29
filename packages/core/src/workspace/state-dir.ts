// `<project>/.sketch/` — the engine's own state directory, and why it carries a
// self-ignore marker.
//
// ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────
//
// The event log and the plan documents both live inside the project the engine is
// working on: `.sketch/events/<date>.jsonl`, `.sketch/plan/<runId>/…`. That is
// deliberate — the log belongs to the project, travels with it, and is readable
// without the app. But git sees it too, so the first event of the first run turns
// a clean repository into one with `?? .sketch/` in `git status`.
//
// That is not cosmetic. The Git panel (task 3.3) reads `git status` and offers
// what it finds for staging, so Sketch's own bookkeeping would appear as the
// user's change, and a `git add -A` would commit the engine's log. It also makes
// "clean repository" unreachable the moment the engine does anything, which is
// exactly the state the panel needs to be able to report honestly.
//
// ── WHY A MARKER INSIDE `.sketch/`, NOT THE PROJECT'S `.gitignore` ──────────
//
// `<project>/.sketch/.gitignore` containing `*` makes the directory ignore its
// whole contents, including the marker itself. Compared with the alternatives:
//
//   * appending to the project's own `.gitignore` edits a file the user owns and
//     probably tracks — a tool that rewrites tracked files to tidy up after
//     itself is worse than the mess;
//   * filtering `.sketch` out of the parser or the panel would LIE. A path that
//     is already tracked stays tracked, and this very repository tracks
//     `packages/core/.sketch/evals/evals.jsonl`. Hiding a real modification to a
//     tracked file is not something a source-control panel may do.
//
// The marker is written ONCE and never rewritten: if a user edits it (to track
// their plans, say), that edit stands. Git's rule that ignore patterns do not
// apply to already-tracked paths is what makes this safe — an existing tracked
// file under `.sketch/` keeps showing its changes.
//
// Validates: Requirements 14.6, 27.3

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The engine's state directory name, relative to a project root. */
export const STATE_DIR = '.sketch'

/**
 * What the marker says. `*` covers every entry including `.gitignore` itself, so
 * the directory disappears from `git status` entirely rather than shrinking to one
 * row.
 */
export const STATE_DIR_GITIGNORE = [
  '# Written by Sketch. This directory is the engine\'s own state:',
  '# the event log and the plan documents for this project.',
  '#',
  '# Everything in here is ignored, including this file. Delete a line to track',
  '# something deliberately; Sketch never rewrites this file once it exists.',
  '*',
  '',
].join('\n')

/**
 * Ensure `<baseDir>/.sketch` exists and does not dirty the project's git status.
 *
 * Returns the state directory. Idempotent, and safe to call on every write path:
 * the marker is written with `flag: 'wx'`, so a second caller (or a second
 * process) fails the open and leaves the existing file untouched rather than
 * clobbering it.
 *
 * A failure to write the marker is SWALLOWED on purpose. This is housekeeping on
 * the way to an append; a read-only `.sketch` or a race with another process must
 * not take down the event emit that asked for it. The directory creation itself is
 * not swallowed — without it the append cannot happen.
 */
export async function ensureStateDir(baseDir: string): Promise<string> {
  const dir = join(baseDir, STATE_DIR)
  await mkdir(dir, { recursive: true })
  try {
    await writeFile(join(dir, '.gitignore'), STATE_DIR_GITIGNORE, { encoding: 'utf8', flag: 'wx' })
  } catch {
    // Already there, or not writable. Either way the log write proceeds.
  }
  return dir
}
