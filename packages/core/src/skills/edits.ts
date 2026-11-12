// Bounded edits to a skill body: the update rule of Microsoft's SkillOpt
// (github.com/microsoft/SkillOpt, MIT; arXiv 2605.23904), re-implemented here.
//
// SkillOpt does not let the optimizer rewrite a skill wholesale. It proposes a few
// ADD / DELETE / REPLACE edits, and at most `maxEdits` of them are applied in one
// step, a "textual learning rate". Small steps are what make the held-out gate in
// `trainer.ts` meaningful: a whole-body rewrite changes so much at once that a
// score difference cannot say which part helped.
//
// Edits are anchored on exact text, never on line numbers, so a stale edit fails
// to apply instead of landing in the wrong place.

/** One edit. `find` must occur exactly once in the body. */
export type SkillEdit =
  | { op: 'add'; text: string; after?: string }
  | { op: 'delete'; find: string }
  | { op: 'replace'; find: string; text: string }

/** Edits applied in one step when the caller does not say. SkillOpt-Sleep's default is 4. */
export const DEFAULT_MAX_EDITS = 4

/** Fence the optimizer is asked to put its edits in. */
export const EDITS_FENCE = 'edits'

export interface ApplyResult {
  body: string
  applied: SkillEdit[]
  /** Edits that could not be applied, with the reason. */
  skipped: Array<{ edit: SkillEdit; reason: string }>
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

function toEdit(raw: unknown): SkillEdit | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  switch (record['op']) {
    case 'add':
      if (!isText(record['text'])) return null
      return isText(record['after'])
        ? { op: 'add', text: record['text'], after: record['after'] }
        : { op: 'add', text: record['text'] }
    case 'delete':
      return isText(record['find']) ? { op: 'delete', find: record['find'] } : null
    case 'replace':
      return isText(record['find']) && typeof record['text'] === 'string'
        ? { op: 'replace', find: record['find'], text: record['text'] }
        : null
    default:
      return null
  }
}

/**
 * Read the edits from a reply: a JSON array inside one ```edits fenced block.
 * Malformed entries are dropped; no block, or invalid JSON, means no edits.
 */
export function parseEdits(reply: string): SkillEdit[] {
  const match = new RegExp(`\`\`\`${EDITS_FENCE}\\s*\\n([\\s\\S]*?)\`\`\``).exec(reply)
  if (match === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(match[1] ?? '')
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.map(toEdit).filter((edit): edit is SkillEdit => edit !== null)
}

function occurrences(haystack: string, needle: string): number {
  let count = 0
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++
  return count
}

/** Collapse the run of line breaks around `at` to one blank line, when it is longer. */
function tidyAt(text: string, at: number): string {
  let start = at
  while (start > 0 && text[start - 1] === '\n') start--
  let end = at
  while (end < text.length && text[end] === '\n') end++
  return end - start > 2 ? `${text.slice(0, start)}\n\n${text.slice(end)}` : text
}

/**
 * Put `insert` in place of `length` characters at `at`, by position. Not
 * `String.replace`: it reads `$&`, `$$`, `$'` and `` $` `` in the replacement as
 * patterns, which would silently change a skill that documents shell or regex.
 * Only the two seams are tidied, so text the edit did not touch keeps its spacing
 * (a Python sample's two blank lines, say).
 */
function splice(body: string, at: number, length: number, insert: string): string {
  const joined = body.slice(0, at) + insert + body.slice(at + length)
  return tidyAt(tidyAt(joined, at + insert.length), at)
}

/** Apply at most `maxEdits` edits, in order. Each later edit sees the body the earlier ones produced. */
export function applyEdits(body: string, edits: readonly SkillEdit[], maxEdits = DEFAULT_MAX_EDITS): ApplyResult {
  let current = body
  const applied: SkillEdit[] = []
  const skipped: ApplyResult['skipped'] = []
  for (const edit of edits) {
    if (applied.length >= maxEdits) {
      skipped.push({ edit, reason: `over the limit of ${maxEdits} edit(s) per step` })
      continue
    }
    const anchor = edit.op === 'add' ? edit.after : edit.find
    if (anchor !== undefined) {
      const count = occurrences(current, anchor)
      if (count !== 1) {
        skipped.push({ edit, reason: count === 0 ? 'its anchor text is not in the skill' : 'its anchor text appears more than once' })
        continue
      }
    }
    if (edit.op === 'add') {
      if (edit.after === undefined) {
        current = `${current.trimEnd()}\n\n${edit.text.trim()}\n`
      } else {
        const end = current.indexOf(edit.after) + edit.after.length
        current = splice(current, end, 0, `\n${edit.text.trim()}`)
      }
    } else {
      const at = current.indexOf(edit.find)
      current = splice(current, at, edit.find.length, edit.op === 'delete' ? '' : edit.text)
    }
    applied.push(edit)
  }
  return { body: current, applied, skipped }
}

/** One line per edit, for the rejected-edit buffer and the audit trail. */
export function describeEdit(edit: SkillEdit): string {
  const clip = (text: string) => (text.length > 120 ? `${text.slice(0, 117)}...` : text).replace(/\s+/g, ' ')
  if (edit.op === 'add') return `add "${clip(edit.text)}"${edit.after !== undefined ? ` after "${clip(edit.after)}"` : ''}`
  if (edit.op === 'delete') return `delete "${clip(edit.find)}"`
  return `replace "${clip(edit.find)}" with "${clip(edit.text)}"`
}
