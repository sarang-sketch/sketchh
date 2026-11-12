// Inline edit ("Ctrl+K") — the pure half.
//
// The user selects code in the editor, says what should change, and gets back the
// rewritten selection to accept or reject in place. Like inline completion, most free
// and local models only speak chat, so this is one chat turn: the file with the
// selection marked, the instruction, and a strict request for the replacement code
// only. Models do not always comply, so their reply goes through `cleanInlineEdit`:
// reasoning and fences removed, echoed markers dropped, a dropped indentation put
// back, and the line ending made to match the selection it replaces.
//
// No IO here. The `inline-edit` RPC method makes the call; this file decides what is
// sent and what is kept, and is therefore what the tests pin.

import type { Message } from '../types.js'

/** Characters of code before the selection sent with a request. The nearest matters most. */
export const INLINE_EDIT_BEFORE_CHARS = 8_000
/** Characters after it. */
export const INLINE_EDIT_AFTER_CHARS = 3_000
/** The largest selection one request may rewrite. Beyond this, the agent is the right tool. */
export const INLINE_EDIT_MAX_SELECTION = 60_000
/** The longest instruction accepted. */
export const INLINE_EDIT_MAX_INSTRUCTION = 2_000

export const SELECTION_OPEN = '<selection>'
export const SELECTION_CLOSE = '</selection>'

export interface InlineEditRequest {
  path: string
  language?: string
  /** The file before the selection. Clipped from the start. */
  before: string
  /** The code to rewrite. Empty means "insert at the caret". */
  selection: string
  /** The file after the selection. Clipped from the end. */
  after: string
  /** What the user wants changed. */
  instruction: string
}

const SYSTEM = [
  "You are the inline code editor inside an IDE, like Cursor's Ctrl+K.",
  `You are shown a file with the region to rewrite between ${SELECTION_OPEN} and ${SELECTION_CLOSE}, and an instruction.`,
  'Reply with ONLY the code that replaces that region:',
  '- no explanation, no markdown, no code fences, no selection markers;',
  '- never repeat code that appears before or after the region;',
  "- keep the file's language, indentation and style, and keep the region's leading indentation;",
  '- change what the instruction asks for, and keep everything else in the region as it was.',
  'If the region is empty, reply with the code to insert at that point.',
].join('\n')

/** The text before the selection, clipped from the START so the nearest code survives. */
export function clipBefore(before: string, max = INLINE_EDIT_BEFORE_CHARS): string {
  if (before.length <= max) return before
  const cut = before.slice(before.length - max)
  const newline = cut.indexOf('\n')
  return newline >= 0 && newline < 400 ? cut.slice(newline + 1) : cut
}

/** The text after the selection, clipped from the END. */
export function clipAfter(after: string, max = INLINE_EDIT_AFTER_CHARS): string {
  if (after.length <= max) return after
  const cut = after.slice(0, max)
  const newline = cut.lastIndexOf('\n')
  return newline > max - 400 ? cut.slice(0, newline) : cut
}

/** The chat turn for one inline edit. */
export function buildInlineEditMessages(request: InlineEditRequest): Message[] {
  const language = request.language !== undefined && request.language.trim() !== '' ? ` (${request.language.trim()})` : ''
  const region = request.selection === '' ? 'the empty region' : 'the region'
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        `File: ${request.path}${language}`,
        '<file>',
        `${clipBefore(request.before)}${SELECTION_OPEN}${request.selection}${SELECTION_CLOSE}${clipAfter(request.after)}`,
        '</file>',
        `Instruction: ${request.instruction.trim()}`,
        `Code that replaces ${region}:`,
      ].join('\n'),
    },
  ]
}

/** Leading whitespace of a line. */
function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)![0]
}

/** The indentation every non-blank line shares, or '' when one has none. */
function commonIndent(lines: string[]): string {
  let shared: string | null = null
  for (const line of lines) {
    if (line.trim() === '') continue
    const indent = indentOf(line)
    if (shared === null) {
      shared = indent
      continue
    }
    let n = 0
    while (n < shared.length && n < indent.length && shared[n] === indent[n]) n++
    shared = shared.slice(0, n)
    if (shared === '') return ''
  }
  return shared ?? ''
}

/**
 * Turn whatever a chat model returned into the code that replaces the selection.
 *
 * Returns '' when nothing usable remains; the editor says so rather than replacing
 * the selection with nothing. (A request to delete code still works: the model is
 * asked for the code that remains, and a deletion of everything is a deletion the
 * user can make faster with the Delete key.)
 */
export function cleanInlineEdit(raw: string, context: { selection: string }): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/\r\n?/g, '\n')
  const selection = context.selection.replace(/\r\n?/g, '\n')

  // A reply wrapped in a fence: the code is inside it. A fence elsewhere in the reply,
  // with prose around it, is the code too — unless the selection itself has fences
  // (Markdown), where a fence is content.
  const trimmed = text.replace(/^\s*\n/, '').replace(/\s+$/, '')
  const wrapped = /^```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(trimmed)
  if (wrapped !== null) {
    text = wrapped[1]!
  } else if (!selection.includes('```')) {
    const fenced = /```[^\n]*\n([\s\S]*?)(?:\n```|$)/.exec(text)
    if (fenced !== null) text = fenced[1]!
  }

  // Markers the model echoed back.
  text = text.split(SELECTION_OPEN).join('').split(SELECTION_CLOSE).join('')
  text = text.replace(/^<file>\n?/, '').replace(/\n?<\/file>\s*$/, '')

  // Blank lines at the edges are formatting, not code; leading spaces are code.
  text = text.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '')
  if (text.trim() === '') return ''

  // Models often drop the indentation of the code they were shown. When the whole
  // reply sits at column 0 but the selection was indented, put the indentation back.
  const replyLines = text.split('\n')
  const selectionIndent = commonIndent(selection.split('\n'))
  const firstLine = replyLines.find((line) => line.trim() !== '') ?? ''
  if (selectionIndent !== '' && commonIndent(replyLines) === '' && indentOf(firstLine) === '') {
    text = replyLines.map((line) => (line.trim() === '' ? line : `${selectionIndent}${line}`)).join('\n')
  }

  // The replacement ends the way the selection did: a selection of whole lines that
  // ended with a newline is replaced by lines that end with one, and vice versa.
  if (selection.endsWith('\n')) text = `${text}\n`
  return text
}
