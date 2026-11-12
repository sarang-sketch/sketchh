// Inline completion ("ghost text") — the pure half.
//
// The editor asks for a completion at the cursor after the user pauses typing. Most
// free and local models only speak chat, not fill-in-the-middle, so the request is a
// chat turn with the code around the cursor and a strict instruction to answer with
// the inserted text only. Models do not always comply, so everything they send back
// goes through `cleanCompletion` before an editor sees it: fences stripped, echoes of
// the code before and after the cursor removed, length bounded.
//
// No IO here. The `complete` RPC method does the call; this file decides what is sent
// and what is kept, and is therefore what the tests pin.

import type { Message } from '../types.js'

/** Characters of code before the cursor sent with a request. The nearest code matters most. */
export const COMPLETION_PREFIX_CHARS = 6_000
/** Characters after the cursor. Enough to stop the model re-writing what follows. */
export const COMPLETION_SUFFIX_CHARS = 2_000
/** Lines a single suggestion may span. */
export const COMPLETION_MAX_LINES = 12
/** The marker the model is shown in place of the caret. */
export const CURSOR_MARKER = '<CURSOR>'

export interface CompletionRequest {
  path: string
  language?: string
  prefix: string
  suffix: string
}

const SYSTEM = [
  'You are a code completion engine inside a code editor, like GitHub Copilot.',
  `You are shown a file with a ${CURSOR_MARKER} marker where the user's caret is.`,
  `Reply with ONLY the exact text to insert at ${CURSOR_MARKER}:`,
  '- no explanation, no markdown, no code fences;',
  '- never repeat code that already appears before or after the cursor;',
  '- continue the current line or finish the current statement or block, in the file\'s own style;',
  `- at most ${COMPLETION_MAX_LINES} lines.`,
  'If nothing sensible should be inserted, reply with an empty message.',
].join('\n')

/** The prefix, clipped from the START so the code nearest the cursor survives. */
export function clipPrefix(prefix: string, max = COMPLETION_PREFIX_CHARS): string {
  if (prefix.length <= max) return prefix
  const cut = prefix.slice(prefix.length - max)
  // Start on a line boundary so the model is not shown half an identifier.
  const newline = cut.indexOf('\n')
  return newline >= 0 && newline < 400 ? cut.slice(newline + 1) : cut
}

/** The suffix, clipped from the END. */
export function clipSuffix(suffix: string, max = COMPLETION_SUFFIX_CHARS): string {
  if (suffix.length <= max) return suffix
  const cut = suffix.slice(0, max)
  const newline = cut.lastIndexOf('\n')
  return newline > max - 400 ? cut.slice(0, newline) : cut
}

/** The chat turn for one completion. */
export function buildCompletionMessages(request: CompletionRequest): Message[] {
  const prefix = clipPrefix(request.prefix)
  const suffix = clipSuffix(request.suffix)
  const language = request.language !== undefined && request.language.trim() !== '' ? ` (${request.language.trim()})` : ''
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        `File: ${request.path}${language}`,
        '<code>',
        `${prefix}${CURSOR_MARKER}${suffix}`,
        '</code>',
        `Text to insert at ${CURSOR_MARKER}:`,
      ].join('\n'),
    },
  ]
}

/** The longest suffix of `a` that is a prefix of `b`. */
function overlap(a: string, b: string, max = 400): number {
  const limit = Math.min(a.length, b.length, max)
  for (let n = limit; n > 0; n--) {
    if (a.endsWith(b.slice(0, n))) return n
  }
  return 0
}

/**
 * Turn whatever a chat model returned into text that can be inserted at the cursor.
 *
 * Returns '' when nothing usable remains — which the editor shows as no suggestion,
 * never as an error.
 */
export function cleanCompletion(raw: string, context: { prefix: string; suffix: string }): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')

  // A fenced block anywhere: the code is inside it.
  const fence = /```[^\n]*\n([\s\S]*?)(```|$)/.exec(text)
  if (fence !== null) text = fence[1]!
  text = text.replace(/^<code>\n?|\n?<\/code>\s*$/g, '')

  // Anything after a cursor marker the model echoed is the suffix again.
  const marker = text.indexOf(CURSOR_MARKER)
  if (marker >= 0) {
    // "...before<CURSOR>after" — the model echoed the context; keep what it inserted.
    const before = text.slice(0, marker)
    text = before.trim() === '' ? text.slice(marker + CURSOR_MARKER.length) : before
  }

  // The model often restates the current line before continuing it.
  const lineStart = context.prefix.lastIndexOf('\n') + 1
  const currentLine = context.prefix.slice(lineStart)
  const trimmedLine = currentLine.trimStart()
  if (trimmedLine !== '' && text.trimStart().startsWith(trimmedLine)) {
    text = text.trimStart().slice(trimmedLine.length)
  } else {
    // Or restates a tail of the prefix more generally.
    const echoed = overlap(context.prefix, text)
    if (echoed >= 8) text = text.slice(echoed)
  }

  // Nothing after the cursor should be written twice.
  const suffixHead = context.suffix.replace(/^\s+/, '')
  if (suffixHead !== '') {
    const tailOverlap = overlap(text, suffixHead)
    if (tailOverlap >= 3) text = text.slice(0, text.length - tailOverlap)
  }

  // A continuation of a line that already has content does not start with a newline
  // the model invented; a new statement on an empty line keeps its indentation.
  if (currentLine.trim() !== '') text = text.replace(/^\n+/, '')

  const lines = text.split('\n').slice(0, COMPLETION_MAX_LINES)
  const out = lines.join('\n').replace(/\s+$/, '')
  return out.trim() === '' ? '' : out
}

/**
 * A sliding-window rate limit on completion calls.
 *
 * Inline completion is the one feature that can call a model on every pause in
 * typing, which on a paid provider is a cost that grows with how much somebody types.
 * The editor debounces; this is the backstop that holds even if a surface does not.
 */
export class CompletionRateLimiter {
  readonly #limit: number
  readonly #windowMs: number
  readonly #clock: () => number
  #calls: number[] = []

  constructor(options: { limit?: number; windowMs?: number; clock?: () => number } = {}) {
    this.#limit = options.limit ?? 30
    this.#windowMs = options.windowMs ?? 60_000
    this.#clock = options.clock ?? (() => Date.now())
  }

  /** True, and the call is counted, when one more call fits in the window. */
  tryAcquire(): boolean {
    const now = this.#clock()
    this.#calls = this.#calls.filter((at) => now - at < this.#windowMs)
    if (this.#calls.length >= this.#limit) return false
    this.#calls.push(now)
    return true
  }
}
