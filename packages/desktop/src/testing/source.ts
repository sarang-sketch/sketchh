// Reading shipped source in a guard test, without tripping over its own comments.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// Several tests assert that a deleted fixture is not part of what ships:
// `mcpToolsStatus`, `$1.4025`, `MOCK_SKILLS`, `14.2k tokens`. The obvious
// implementation — search the file for the string — fails on the comments that record
// what was deleted and why. That happened twice while writing tasks 7.4 and 8.4, and it
// is the same false positive `deps.test.ts` hit when a `['from', 'into']` stopword array
// read as an import: the DATA tripped the guard, not the behaviour.
//
// The honest rule was never "this string appears nowhere in the file", it is "this fixture
// is not part of what ships". A comment ships no behaviour, and forbidding the words would
// mean the codebase could not explain its own history — which is worse, because the next
// person to find `connected: 5` in a git log needs to discover it was removed on purpose.
//
// So: comments are stripped and the CODE is searched. This lives in one place rather than
// being copied per test file, because a second copy of a guard's mechanism drifts from the
// first, and the drift is silent — a stripper that removed too much would make every
// assertion built on it pass for no reason. `source.test.ts` is the self-test that keeps
// it honest.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `packages/desktop/src`. */
export const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Read a file under `src/`, verbatim. */
export function readSource(relative: string): string {
  return readFileSync(join(SRC_DIR, relative), 'utf8')
}

/** Read a file under `src/` with its comments removed. What a fixture guard wants. */
export function readCode(relative: string): string {
  return stripComments(readSource(relative))
}

/**
 * Remove `//` and block comments, leaving string and template literals intact.
 *
 * A `//` inside a string is not a comment — URLs are the common case — so the scanner
 * tracks quoting rather than running a regular expression over the text.
 *
 * NOT a parser, and it does not need to be: it handles the three comment forms TypeScript
 * and JSX actually use and the three quote characters, and anything it gets wrong makes a
 * guard STRICTER (a retained comment) rather than weaker, except for the one case the
 * self-test pins — a regex literal containing a quote. That case does not occur in the
 * files these guards read, and if it starts to, the self-test is where to say so.
 */
export function stripComments(source: string): string {
  let out = ''
  let index = 0
  let quote: string | null = null

  while (index < source.length) {
    const char = source[index]!
    const next = source[index + 1]

    if (quote !== null) {
      out += char
      if (char === '\\') {
        out += source[index + 1] ?? ''
        index += 2
        continue
      }
      if (char === quote) quote = null
      index += 1
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char
      out += char
      index += 1
      continue
    }

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }

    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1
      }
      index += 2
      continue
    }

    out += char
    index += 1
  }
  return out
}
