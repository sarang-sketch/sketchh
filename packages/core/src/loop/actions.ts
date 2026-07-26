// The model action protocol — parsing and validation.
//
// The model speaks JSON, fenced or bare. `extractJson()` from the legacy
// orchestrator already recovers JSON from fenced blocks, prose, and nested
// braces, so it is reused verbatim rather than re-implemented; this module only
// adds SHAPE validation on top of it.
//
// THE DEGRADE RULE (Requirement 5.3). Nothing in here throws and nothing returns
// null. Any text that is not a well-formed known action — unparseable prose, a
// JSON array, `{"action":"delete_everything"}`, an `edit` whose `edits` is a
// string — becomes `{ action: 'think', text: <raw model output>, degraded: true }`.
// A malformed turn therefore costs an iteration and the model gets to try again,
// which is strictly better than failing a run over a stray backtick. The
// `degraded` flag is carried so the `think` event can record WHY the loop is
// thinking, which is the difference between a deliberate thought and a parse
// miss when reading the timeline back.
//
// Validates: Requirements 5.2, 5.3

import { extractJson } from '../orchestrator/json.js'

/** The seven actions from the design's protocol table. */
export const ACTION_NAMES = ['plan', 'verify', 'edit', 'tool', 'think', 'ask', 'done'] as const

export type ActionName = (typeof ACTION_NAMES)[number]

/**
 * One search/replace edit.
 *
 * `search: ""` is the documented whole-file form: the file is written with
 * `replace` as its entire content, creating it if absent. That is how the
 * protocol's search/replace shape reaches the whole-file `FileEdit` the existing
 * `FileWriter` applies — see `loop/edits.ts`.
 */
export interface EditSpec {
  path: string
  search: string
  replace: string
}

export type Action =
  | { action: 'plan'; artifacts: Record<string, unknown> }
  | { action: 'verify' }
  | { action: 'edit'; edits: EditSpec[] }
  | { action: 'tool'; name: string; args: Record<string, unknown> }
  | { action: 'think'; text: string; degraded: boolean }
  | { action: 'ask'; question: string }
  | { action: 'done'; text: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** A `think` carrying the raw model turn. The universal fallback. */
function degraded(text: string): Action {
  return { action: 'think', text, degraded: true }
}

/**
 * Validate one entry of an `edit` action's `edits` array.
 *
 * `path` must be a non-empty string. `search` and `replace` must both be
 * strings; `search` may be empty (whole-file write) but `replace` may not be
 * absent, because "replace with nothing" is spelled `""` and "no replacement
 * supplied" is a malformed action.
 */
function toEdit(value: unknown): EditSpec | null {
  if (!isRecord(value)) return null
  const path = asString(value.path)
  const search = asString(value.search)
  const replace = asString(value.replace)
  if (path === null || path.trim() === '') return null
  if (search === null || replace === null) return null
  return { path, search, replace }
}

/**
 * Parse a model turn into an action. Never throws, never fails a run.
 */
export function parseAction(text: string): Action {
  const raw = typeof text === 'string' ? text : String(text ?? '')
  const parsed = extractJson<unknown>(raw)
  if (!isRecord(parsed)) return degraded(raw)

  const action = asString(parsed.action)
  if (action === null) return degraded(raw)
  const name = action.trim().toLowerCase()

  switch (name) {
    case 'plan': {
      // The artifacts map is validated only as "an object": the plan writer owns
      // key resolution and reports unknown keys as `ignored`, so duplicating its
      // alias table here would give two places to keep in sync.
      if (!isRecord(parsed.artifacts)) return degraded(raw)
      return { action: 'plan', artifacts: parsed.artifacts }
    }

    case 'verify':
      return { action: 'verify' }

    case 'edit': {
      if (!Array.isArray(parsed.edits) || parsed.edits.length === 0) return degraded(raw)
      const edits: EditSpec[] = []
      for (const entry of parsed.edits) {
        const edit = toEdit(entry)
        // All-or-nothing: a half-valid batch is a malformed action, not a
        // licence to apply the half we understood.
        if (edit === null) return degraded(raw)
        edits.push(edit)
      }
      return { action: 'edit', edits }
    }

    case 'tool': {
      const toolName = asString(parsed.name)
      if (toolName === null || toolName.trim() === '') return degraded(raw)
      return {
        action: 'tool',
        name: toolName,
        args: isRecord(parsed.args) ? parsed.args : {},
      }
    }

    case 'think': {
      // A `think` with a non-string `text` still means "the model thought", so it
      // degrades to the raw turn rather than being dropped.
      const thought = asString(parsed.text)
      return thought === null ? degraded(raw) : { action: 'think', text: thought, degraded: false }
    }

    case 'ask': {
      const question = asString(parsed.question)
      if (question === null || question.trim() === '') return degraded(raw)
      return { action: 'ask', question }
    }

    case 'done': {
      // `done` with no text is legitimate: the loop's terminal decision comes
      // from the verify results, not from the prose.
      return { action: 'done', text: asString(parsed.text) ?? '' }
    }

    default:
      return degraded(raw)
  }
}

/** True when `name` is one of the seven protocol actions. */
export function isActionName(name: string): name is ActionName {
  return (ACTION_NAMES as readonly string[]).includes(name)
}
