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
import { resolve } from 'node:path'
import { isWithin } from '../orchestrator/file-writer.js'
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

/**
 * Apply one edit. Never throws: a refusal is data, so the loop can emit
 * `edit_rejected` and keep going.
 */
export async function applyEdit(
  edit: EditSpec,
  options: ApplyEditOptions,
): Promise<EditOutcome> {
  const rootAbs = resolve(options.root)
  const readText = options.readText ?? diskTextReader

  let target: string
  try {
    target = resolve(rootAbs, edit.path)
  } catch {
    return { path: edit.path, ok: false, reason: 'path could not be resolved' }
  }

  if (!isWithin(rootAbs, target)) {
    return {
      path: edit.path,
      ok: false,
      reason: `path is outside the project root and was refused: ${edit.path}`,
    }
  }

  const current = await readText(target)
  let content: string

  if (edit.search === '') {
    // Whole-file write: create or overwrite.
    content = edit.replace
  } else {
    if (current === null) {
      return {
        path: edit.path,
        ok: false,
        reason: `file does not exist or could not be read: ${edit.path}`,
      }
    }
    const index = current.indexOf(edit.search)
    if (index < 0) {
      return {
        path: edit.path,
        ok: false,
        reason:
          `search string not found in ${edit.path}; the file was left unchanged. ` +
          'Read the current content and send an exact substring.',
      }
    }
    content = current.slice(0, index) + edit.replace + current.slice(index + edit.search.length)
  }

  try {
    await options.files.apply(rootAbs, [{ path: edit.path, content }])
  } catch (err) {
    return {
      path: edit.path,
      ok: false,
      reason: `write failed: ${(err as Error).message}`,
    }
  }

  return {
    path: edit.path,
    ok: true,
    created: current === null,
    bytes: Buffer.byteLength(content, 'utf8'),
  }
}
