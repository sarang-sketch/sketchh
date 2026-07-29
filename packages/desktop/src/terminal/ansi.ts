// ANSI escape sequences → plain text plus a colour token. Nothing else.
//
// ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
//
// Command output is the single most dangerous string in this application. The CSP
// still carries `script-src 'unsafe-inline'` (see NEED-TO-DO §4.4), so anything
// rendered as HTML is an execution path, and command output is attacker-influenced
// by definition: a test name, a dependency's warning, a compiler diagnostic quoting
// a source file. The rule the terminal panel follows is therefore absolute —
// **output reaches the DOM as text nodes only**. No `dangerouslySetInnerHTML`, not
// for colour, not for links, not for anything.
//
// The temptation this module removes is the shortcut: converting `\u001b[31m` into
// `<span style="color:red">` and setting it as HTML. So this parser does not emit
// markup. It emits DATA — a list of `{ text, color, bold }` — and the panel renders
// each span as a React child, which React escapes. `parseAnsi` has no `<`, no `>`
// and no tag name anywhere in it, and `ansi.test.ts` asserts that property directly
// against markup-shaped input.
//
// ── WHAT IS UNDERSTOOD, AND WHAT IS DROPPED ─────────────────────────────────
//
//   SGR (`ESC [ ... m`)      interpreted: the 8 basic colours, their bright forms,
//                            bold, and the resets. Everything else in an SGR run
//                            (blink, 256-colour indices, backgrounds) is ignored
//                            rather than approximated.
//   other CSI (`ESC [ ... X`) dropped, including cursor moves and erase-line. A
//                            terminal panel that is not a terminal emulator cannot
//                            honour them, and printing them raw is noise.
//   OSC (`ESC ] ... BEL`)    dropped. This is where a hyperlink or a window title
//                            would arrive; both are meaningless here.
//   lone ESC                 dropped.
//   `\r`                     dropped (and `\r\n` becomes `\n`), so progress output
//                            that overwrites its own line does not render as a
//                            single unreadable smear.
//   other C0 controls        dropped, except `\t` and `\n`.
//
// Pure string work: no React, no DOM, no I/O.
//
// Validates: Requirements 27.1, 27.4

/** The colours a span may carry. Deliberately a token, never a CSS string. */
export type AnsiColor =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | null

/** One run of text with one appearance. `text` is literal: never markup. */
export interface AnsiSpan {
  text: string
  color: AnsiColor
  bold: boolean
}

const COLOR_BY_CODE: Record<number, AnsiColor> = {
  30: 'black',
  31: 'red',
  32: 'green',
  33: 'yellow',
  34: 'blue',
  35: 'magenta',
  36: 'cyan',
  37: 'white',
  // Bright variants map to the same token and set bold, which is how most
  // terminals have rendered them for thirty years.
  90: 'black',
  91: 'red',
  92: 'green',
  93: 'yellow',
  94: 'blue',
  95: 'magenta',
  96: 'cyan',
  97: 'white',
}

const ESC = '\u001b'
const BEL = '\u0007'

interface Appearance {
  color: AnsiColor
  bold: boolean
}

/** Apply one SGR parameter run to the current appearance. */
function applySgr(params: string, current: Appearance): Appearance {
  // An empty parameter list (`ESC[m`) means reset, same as `ESC[0m`.
  const codes = (params === '' ? '0' : params).split(';').map((part) => Number.parseInt(part, 10))
  let next = current
  for (const code of codes) {
    if (Number.isNaN(code)) continue
    if (code === 0) {
      next = { color: null, bold: false }
      continue
    }
    if (code === 1) {
      next = { ...next, bold: true }
      continue
    }
    if (code === 22) {
      next = { ...next, bold: false }
      continue
    }
    if (code === 39) {
      next = { ...next, color: null }
      continue
    }
    const color = COLOR_BY_CODE[code]
    if (color !== undefined) {
      next = { color, bold: code >= 90 ? true : next.bold }
    }
    // Anything else — 256-colour selectors, backgrounds, italics — is ignored.
    // Guessing at an appearance we do not render is worse than not rendering it.
  }
  return next
}

/** Controls that must not reach the DOM. `\n` and `\t` are kept. */
function isDroppedControl(ch: string): boolean {
  const code = ch.charCodeAt(0)
  if (ch === '\n' || ch === '\t') return false
  return code < 0x20 || code === 0x7f
}

/**
 * Parse `text` into spans. Concatenating every `text` yields the output with all
 * escape sequences removed — never a fragment of one, and never a tag.
 */
export function parseAnsi(text: string): AnsiSpan[] {
  const spans: AnsiSpan[] = []
  let appearance: Appearance = { color: null, bold: false }
  let buffer = ''

  const flush = (): void => {
    if (buffer === '') return
    spans.push({ text: buffer, color: appearance.color, bold: appearance.bold })
    buffer = ''
  }

  let i = 0
  while (i < text.length) {
    const ch = text[i]

    if (ch !== ESC) {
      // `\r\n` → `\n`; a lone `\r` disappears.
      if (ch === '\r') {
        i += 1
        continue
      }
      if (!isDroppedControl(ch)) buffer += ch
      i += 1
      continue
    }

    const next = text[i + 1]

    // CSI: ESC [ params final-byte
    if (next === '[') {
      let j = i + 2
      while (j < text.length && /[\d;?<>!]/.test(text[j])) j += 1
      const final = text[j]
      const params = text.slice(i + 2, j)
      if (final === undefined) {
        // A truncated sequence at the end of a chunk. Drop it rather than print it.
        i = text.length
        continue
      }
      if (final === 'm') {
        flush()
        appearance = applySgr(params, appearance)
      }
      // Every other final byte is a sequence we cannot honour, so it vanishes.
      i = j + 1
      continue
    }

    // OSC: ESC ] ... (BEL | ESC \)
    if (next === ']') {
      let j = i + 2
      while (j < text.length) {
        if (text[j] === BEL) {
          j += 1
          break
        }
        if (text[j] === ESC && text[j + 1] === '\\') {
          j += 2
          break
        }
        j += 1
      }
      i = j
      continue
    }

    // Anything else introduced by ESC (including a lone ESC) is dropped.
    i += next === undefined ? 1 : 2
  }

  flush()
  return spans
}

/**
 * The same spans, split at newlines, one array per output line.
 *
 * The panel renders one element per line, so the split happens here where it can
 * be tested without a DOM. A trailing newline does NOT produce a final empty line:
 * every command ends with one, and an extra blank row per command is noise.
 */
export function toAnsiLines(text: string): AnsiSpan[][] {
  const lines: AnsiSpan[][] = [[]]

  for (const span of parseAnsi(text)) {
    const parts = span.text.split('\n')
    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) lines.push([])
      if (parts[index] === '') continue
      lines[lines.length - 1].push({ ...span, text: parts[index] })
    }
  }

  while (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop()
  if (lines.length === 1 && lines[0].length === 0) return []
  return lines
}
