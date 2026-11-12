// Applying an `edit` action to disk.
//
// ---------------------------------------------------------------------------
// RECONCILING THE PROTOCOL'S search/replace WITH THE WHOLE-FILE FileWriter
// ---------------------------------------------------------------------------
// The protocol's edit is `{ path, search, replace }`. The existing
// `FileWriter.apply(root, edits)` takes whole-file `{ path, content }` and already
// carries the `isWithin` project-root guard that Rule 8 depends on. Rather than
// fork the writer (it is live under the legacy orchestrator and off-limits), the
// search/replace SEMANTICS live here and the WRITE still goes through the
// FileWriter seam:
//
//     read current content → substitute → hand the whole file to files.apply()
//
// So there is exactly one code path that touches disk and exactly one root guard,
// and the loop can still be handed a fake writer in a test.
//
// Three deliberate semantics:
//   * `search: ""` means "write the whole file", creating it if absent. That is
//     the only way a model can create a new file, since there is nothing to
//     search in a file that does not exist yet.
//   * A non-empty `search` that does not occur in the file is a REPORTED FAILURE
//     (`edit_rejected` + feedback to the model), never a silent no-op. A silently
//     skipped edit is the worst outcome available: the model believes the change
//     landed and verify passes against unchanged code.
//   * Only the FIRST occurrence is replaced. Replacing every occurrence turns an
//     under-specified `search` into a scattergun rewrite; a model that means "all
//     of them" can send several edits or a wider search window.
//
// The root guard is applied HERE as well as inside `DiskFileWriter`, because the
// loop must be able to REPORT a refusal rather than catch an exception, and
// because an injected writer is not obliged to guard anything.
//
// Validates: Requirements 5.5, 6.4

import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { assertRealContainment, isWithin } from '../orchestrator/file-writer.js'
import { writeRefusal } from '../tools/protectedPaths.js'
import type { FileWriter } from '../orchestrator/file-writer.js'
import type { EditSpec } from './actions.js'

/** Reads a file as UTF-8, or resolves null when it cannot be read. Injectable. */
export type TextReader = (absolutePath: string) => Promise<string | null>

/** The default reader: the real filesystem. A missing file reads as null. */
export const diskTextReader: TextReader = async (absolutePath) => {
  try {
    return await readFile(absolutePath, 'utf8')
  } catch {
    return null
  }
}

/** Outcome of one edit. `ok: false` is always accompanied by a reason. */
export interface EditOutcome {
  path: string
  ok: boolean
  /** Why the edit was refused. Fed back to the model verbatim. */
  reason?: string
  /** True when the file did not exist before this edit. */
  created?: boolean
  /** Byte length of the file after the edit. */
  bytes?: number
}

export interface ApplyEditOptions {
  root: string
  files: FileWriter
  readText?: TextReader
}

/** A validated edit with its real before/after bytes and reviewable patch. */
export interface PreparedEdit {
  edit: EditSpec
  target: string
  original: string
  content: string
  created: boolean
  diff: string
}

export type PrepareEditResult =
  | { ok: true; prepared: PreparedEdit }
  | { ok: false; outcome: EditOutcome }

interface PatchText {
  lines: string[]
  trailingNewline: boolean
}

function patchText(text: string): PatchText {
  if (text === '') return { lines: [], trailingNewline: false }
  const trailingNewline = /(?:\r\n|\n)$/.test(text)
  const lines = text.split(/\r?\n/)
  if (trailingNewline) lines.pop()
  return { lines, trailingNewline }
}

/**
 * Build a dependency-free unified patch that the shared hunk parser can apply.
 *
 * The whole changed file is one hunk. That is intentionally conservative: the
 * model protocol describes exact search/replace operations, not line edit scripts,
 * and inventing several hunks by heuristic could let a reviewer accept a grouping
 * the model never proposed. Multiple edit actions still produce multiple review
 * decisions. Patch text always uses LF as unified-diff syntax while the body omits
 * CR; applyHunks restores the original file's line endings.
 */
export function unifiedDiff(path: string, original: string, proposed: string): string {
  const before = patchText(original)
  const after = patchText(proposed)
  const oldStart = before.lines.length === 0 ? 0 : 1
  const newStart = after.lines.length === 0 ? 0 : 1
  const out = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStart},${before.lines.length} +${newStart},${after.lines.length} @@`,
  ]

  before.lines.forEach((line, index) => {
    out.push(`-${line}`)
    if (index === before.lines.length - 1 && !before.trailingNewline) {
      out.push('\\ No newline at end of file')
    }
  })
  after.lines.forEach((line, index) => {
    out.push(`+${line}`)
    if (index === after.lines.length - 1 && !after.trailingNewline) {
      out.push('\\ No newline at end of file')
    }
  })
  return `${out.join('\n')}\n`
}

/**
 * Where `search` occurs in `current`, and what to substitute there.
 *
 * Exact first, always. Then three normalisations, each one a failure a real model
 * makes constantly and none of which changes what the model MEANT:
 *
 *   1. line-number prefixes copied from `read_file` output (`  12 | code`);
 *   2. LF in the edit against a CRLF file — every file checked out on Windows;
 *   3. trailing/leading whitespace drift per line, accepted ONLY when exactly one
 *      region of the file matches, so an ambiguous edit is still refused.
 *
 * Returns null when nothing matches unambiguously. Never guesses between two places.
 */
export function locateEdit(
  current: string,
  search: string,
  replace: string,
): { start: number; end: number; replacement: string; normalized: string | null } | null {
  const exact = current.indexOf(search)
  if (exact >= 0) return { start: exact, end: exact + search.length, replacement: replace, normalized: null }

  let s = search
  let r = replace
  const notes: string[] = []

  // 1. Line-number prefixes, only when EVERY non-blank line of the search carries one.
  const PREFIX = /^\s*\d+\s?\|\s?/
  const searchLines = s.split(/\r?\n/)
  const nonBlank = searchLines.filter((line) => line.trim() !== '')
  if (nonBlank.length > 0 && nonBlank.every((line) => PREFIX.test(line))) {
    s = searchLines.map((line) => line.replace(PREFIX, '')).join('\n')
    const replaceLines = r.split(/\r?\n/)
    const replaceNonBlank = replaceLines.filter((line) => line.trim() !== '')
    if (replaceNonBlank.length > 0 && replaceNonBlank.every((line) => PREFIX.test(line))) {
      r = replaceLines.map((line) => line.replace(PREFIX, '')).join('\n')
    }
    notes.push('line-number prefixes removed')
    const index = current.indexOf(s)
    if (index >= 0) return { start: index, end: index + s.length, replacement: r, normalized: notes.join(', ') }
  }

  // 2. Line endings. The replacement is converted too, so the file keeps one style.
  const crlf = current.includes('\r\n')
  if (crlf && !s.includes('\r')) {
    const s2 = s.replace(/\n/g, '\r\n')
    const index = current.indexOf(s2)
    if (index >= 0) {
      return {
        start: index,
        end: index + s2.length,
        replacement: r.replace(/\r?\n/g, '\r\n'),
        normalized: [...notes, 'line endings normalised'].join(', '),
      }
    }
  }

  // 3. Whitespace drift, line by line, unique match only.
  const wanted = s.split(/\r?\n/)
  while (wanted.length > 0 && wanted[0]!.trim() === '') wanted.shift()
  while (wanted.length > 0 && wanted[wanted.length - 1]!.trim() === '') wanted.pop()
  if (wanted.length === 0) return null

  // Offsets of each line in `current`, so a match maps back to exact byte positions.
  const lines: Array<{ text: string; start: number; end: number }> = []
  const lineRe = /([^\r\n]*)(\r\n|\n|$)/g
  let m: RegExpExecArray | null
  while ((m = lineRe.exec(current)) !== null) {
    lines.push({ text: m[1]!, start: m.index, end: m.index + m[1]!.length })
    if (m[2] === '') break
  }
  const matches: number[] = []
  for (let i = 0; i + wanted.length <= lines.length; i++) {
    let ok = true
    for (let j = 0; j < wanted.length; j++) {
      if (lines[i + j]!.text.trim() !== wanted[j]!.trim()) {
        ok = false
        break
      }
    }
    if (ok) {
      matches.push(i)
      if (matches.length > 1) break
    }
  }
  if (matches.length !== 1) return null
  const first = lines[matches[0]!]!
  const last = lines[matches[0]! + wanted.length - 1]!
  const eol = crlf ? '\r\n' : '\n'

  // Indentation drift: the model dropped (or added) a uniform indent. Shift the
  // replacement by the same amount so the edited block lines up with its neighbours.
  const indentOf = (text: string): string => /^[ \t]*/.exec(text)?.[0] ?? ''
  const fileIndent = indentOf(first.text)
  const searchIndent = indentOf(wanted[0]!)
  let replacementLines = r.replace(/(?:\r?\n)+$/, '').split(/\r?\n/)
  if (fileIndent !== searchIndent) {
    if (fileIndent.startsWith(searchIndent)) {
      const extra = fileIndent.slice(searchIndent.length)
      replacementLines = replacementLines.map((line) => (line.trim() === '' ? line : `${extra}${line}`))
    } else if (searchIndent.startsWith(fileIndent)) {
      const surplus = searchIndent.slice(fileIndent.length)
      replacementLines = replacementLines.map((line) =>
        line.startsWith(surplus) ? line.slice(surplus.length) : line,
      )
    }
  }
  return {
    start: first.start,
    end: last.end,
    replacement: replacementLines.join(eol),
    normalized: [...notes, 'whitespace differences ignored'].join(', '),
  }
}

/** Resolve and compute an edit without touching disk. */
export async function prepareEdit(
  edit: EditSpec,
  options: Pick<ApplyEditOptions, 'root' | 'readText'>,
): Promise<PrepareEditResult> {
  const rootAbs = resolve(options.root)
  const readText = options.readText ?? diskTextReader

  let target: string
  try {
    target = resolve(rootAbs, edit.path)
  } catch {
    return { ok: false, outcome: { path: edit.path, ok: false, reason: 'path could not be resolved' } }
  }
  if (!isWithin(rootAbs, target)) {
    return {
      ok: false,
      outcome: {
        path: edit.path,
        ok: false,
        reason: `path is outside the project root and was refused: ${edit.path}`,
      },
    }
  }
  // Inside the project, but not the agent's to write: git's own folder, Sketch's
  // records, secrets files. See tools/protectedPaths.ts.
  const refusal = writeRefusal(relative(rootAbs, target))
  if (refusal !== null) {
    return { ok: false, outcome: { path: edit.path, ok: false, reason: refusal } }
  }
  // The REAL destination, before anything is read: a link inside the project that
  // points elsewhere must not leak the outside file's bytes into the proposed diff.
  // Only checked against the real disk; an injected reader is a test's own world.
  if (options.readText === undefined) {
    try {
      await assertRealContainment(rootAbs, target, edit.path)
    } catch (err) {
      return {
        ok: false,
        outcome: { path: edit.path, ok: false, reason: (err as Error).message },
      }
    }
  }

  const current = await readText(target)
  let content: string
  if (edit.search === '') {
    content = edit.replace
  } else {
    if (current === null) {
      return {
        ok: false,
        outcome: {
          path: edit.path,
          ok: false,
          reason: `file does not exist or could not be read: ${edit.path}`,
        },
      }
    }
    const located = locateEdit(current, edit.search, edit.replace)
    if (located === null) {
      return {
        ok: false,
        outcome: {
          path: edit.path,
          ok: false,
          reason:
            `search string not found in ${edit.path}; the file was left unchanged. ` +
            'Read the current content and send an exact substring.',
        },
      }
    }
    content = current.slice(0, located.start) + located.replacement + current.slice(located.end)
  }

  const original = current ?? ''
  return {
    ok: true,
    prepared: {
      edit,
      target,
      original,
      content,
      created: current === null,
      diff: unifiedDiff(edit.path, original, content),
    },
  }
}

/** Write an already prepared edit through the one guarded FileWriter. */
export async function applyPreparedEdit(
  prepared: PreparedEdit,
  options: Pick<ApplyEditOptions, 'root' | 'files'>,
): Promise<EditOutcome> {
  try {
    await options.files.apply(resolve(options.root), [
      { path: prepared.edit.path, content: prepared.content },
    ])
  } catch (err) {
    return {
      path: prepared.edit.path,
      ok: false,
      reason: `write failed: ${(err as Error).message}`,
    }
  }
  return {
    path: prepared.edit.path,
    ok: true,
    created: prepared.created,
    bytes: Buffer.byteLength(prepared.content, 'utf8'),
  }
}

/** Apply one edit. Never throws: a refusal is data. */
export async function applyEdit(
  edit: EditSpec,
  options: ApplyEditOptions,
): Promise<EditOutcome> {
  const prepared = await prepareEdit(edit, options)
  if (!prepared.ok) return prepared.outcome
  return applyPreparedEdit(prepared.prepared, options)
}
