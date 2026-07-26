// Hand-rolled YAML-subset frontmatter parser.
//
// This is deliberately NOT a general YAML implementation. It exists so that
// @sketch/core can read `SKILL.md` files with ZERO runtime dependencies. The
// supported grammar is exactly what SKILL.md frontmatter needs and no more.
//
// SUPPORTED
//   - a `---` fenced block at the very start of the file, and files with no
//     frontmatter at all (then `data` is empty and `body` is the whole file)
//   - `key: value` scalars
//   - single-quoted and double-quoted strings, including values that contain
//     `:` and `#`; `\\`, `\"`, `\n`, `\t` escapes inside double quotes and the
//     `''` escape inside single quotes
//   - inline sequences: `capabilities: [read, write, network]`
//   - block sequences:
//       capabilities:
//         - read
//         - write
//     (item indentation is free; zero-indent items are accepted too)
//   - comments: a `#` that starts a line, and a trailing ` #` after a value —
//     but never a `#` inside a quoted string
//   - blank lines anywhere inside the block
//   - empty values (`key:` with nothing after it) parse to the empty string
//
// EXPLICITLY OUT OF SCOPE — each of these is REPORTED as an error rather than
// silently mis-parsed, because a silent mis-parse of a skill's metadata is
// worse than a skipped skill:
//   - nested maps (`key:` followed by an indented `child: value`)
//   - multi-line block scalars (`|` and `>`, with any chomping indicator)
//   - anchors (`&name`) and aliases (`*name`), including the `<<:` merge key
//   - nested inline sequences and flow mappings (`{ ... }`)
//
// LINE ENDINGS: input is normalized to `\n` before parsing, so CRLF files
// (this repo is developed on Windows) parse identically to LF files. The
// returned `body` is therefore always `\n`-delimited.
//
// This module NEVER throws. Callers need to skip a bad skill and keep going,
// so every failure is returned as `{ ok: false, error }`.
//
// Validates: Requirements 10.1, 10.4

/** A parsed frontmatter value: a scalar string or a sequence of strings. */
export type FrontmatterValue = string | string[]

/** The parsed frontmatter map. */
export type FrontmatterData = Record<string, FrontmatterValue>

/** Success carries the parsed map plus the markdown body after the block. */
export interface FrontmatterOk {
  ok: true
  data: FrontmatterData
  body: string
}

/** Failure carries a human-readable explanation. It never carries a throw. */
export interface FrontmatterErr {
  ok: false
  error: string
}

export type FrontmatterResult = FrontmatterOk | FrontmatterErr

const FENCE = '---'

/** Normalize CRLF/CR to LF so Windows-authored files parse identically. */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/)
}

function err(error: string): FrontmatterErr {
  return { ok: false, error }
}

/**
 * Parse a document consisting of optional `---` fenced YAML-subset frontmatter
 * followed by a markdown body.
 */
export function parseFrontmatter(text: string): FrontmatterResult {
  // A leading BOM would otherwise hide the opening fence.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = splitLines(source)

  if (lines.length === 0 || lines[0]!.trim() !== FENCE) {
    // No frontmatter at all is a valid document, not an error.
    return { ok: true, data: {}, body: source }
  }

  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === FENCE) {
      close = i
      break
    }
  }
  if (close === -1) {
    return err(
      'unterminated frontmatter block: opening "---" has no matching closing "---"',
    )
  }

  const parsed = parseBlock(lines.slice(1, close))
  if (!parsed.ok) return parsed

  // Leading blank lines between the closing fence and the prose are noise.
  const body = lines
    .slice(close + 1)
    .join('\n')
    .replace(/^\n+/, '')

  return { ok: true, data: parsed.data, body }
}

interface BlockOk {
  ok: true
  data: FrontmatterData
}

const KEY_LINE = /^([^\s:#][^:]*):(.*)$/
const SEQ_ITEM = /^-(\s+(.*))?$/
const BLOCK_SCALAR = /^[|>][-+]?\d*$/

function parseBlock(lines: string[]): BlockOk | FrontmatterErr {
  const data: FrontmatterData = {}
  // The key most recently declared with an empty value: only that key may be
  // filled in by a following block sequence.
  let pendingKey: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const at = `line ${i + 2}` // +2: 1-based, and line 1 is the opening fence
    const trimmed = raw.trim()

    if (trimmed === '') continue
    if (trimmed.startsWith('#')) continue

    const indented = /^\s/.test(raw)
    const seq = SEQ_ITEM.exec(trimmed)

    if (seq) {
      if (pendingKey === null) {
        return err(`${at}: sequence item "${trimmed}" does not belong to any key`)
      }
      const item = parseScalar(seq[2] ?? '', at)
      if (!item.ok) return item
      const existing = data[pendingKey]
      if (Array.isArray(existing)) {
        existing.push(item.value)
      } else {
        data[pendingKey] = [item.value]
      }
      continue
    }

    if (indented) {
      if (trimmed.includes(':')) {
        return err(
          `${at}: nested maps are not supported by this YAML subset ` +
            `(offending line: "${trimmed}")`,
        )
      }
      return err(`${at}: unexpected indented line "${trimmed}"`)
    }

    const keyMatch = KEY_LINE.exec(trimmed)
    if (!keyMatch) {
      return err(`${at}: expected "key: value" but found "${trimmed}"`)
    }

    const key = keyMatch[1]!.trim()
    const valueText = keyMatch[2]!.trim()

    if (key === '<<') {
      return err(`${at}: merge keys ("<<:") are not supported by this YAML subset`)
    }
    if (BLOCK_SCALAR.test(valueText)) {
      return err(
        `${at}: multi-line block scalars ("|" and ">") are not supported by ` +
          `this YAML subset (key "${key}")`,
      )
    }
    if (valueText.startsWith('&')) {
      return err(`${at}: anchors ("&") are not supported by this YAML subset`)
    }
    if (valueText.startsWith('*')) {
      return err(`${at}: aliases ("*") are not supported by this YAML subset`)
    }
    if (valueText.startsWith('{')) {
      return err(`${at}: flow mappings ("{ ... }") are not supported by this YAML subset`)
    }

    if (valueText === '') {
      // Either an empty scalar or the head of a block sequence. Record it as
      // the empty string; a following sequence item promotes it to an array.
      data[key] = ''
      pendingKey = key
      continue
    }

    pendingKey = null

    if (valueText.startsWith('[')) {
      const seqValue = parseInlineSequence(valueText, at)
      if (!seqValue.ok) return seqValue
      data[key] = seqValue.value
      continue
    }

    const scalar = parseScalar(valueText, at)
    if (!scalar.ok) return scalar
    data[key] = scalar.value
  }

  return { ok: true, data }
}

interface ScalarOk {
  ok: true
  value: string
}

/** Parse one scalar: quoted (either style) or bare with an optional comment. */
function parseScalar(text: string, at: string): ScalarOk | FrontmatterErr {
  const raw = text.trim()
  if (raw === '') return { ok: true, value: '' }

  const quote = raw[0]
  if (quote === '"' || quote === "'") {
    const quoted = readQuoted(raw, quote, at)
    if (!quoted.ok) return quoted
    const rest = raw.slice(quoted.end).trim()
    if (rest !== '' && !rest.startsWith('#')) {
      return err(`${at}: unexpected content after quoted value: "${rest}"`)
    }
    return { ok: true, value: quoted.value }
  }

  return { ok: true, value: stripComment(raw).trim() }
}

interface QuotedOk {
  ok: true
  value: string
  /** Index just past the closing quote. */
  end: number
}

function readQuoted(raw: string, quote: string, at: string): QuotedOk | FrontmatterErr {
  let out = ''
  for (let i = 1; i < raw.length; i++) {
    const ch = raw[i]!
    if (quote === '"' && ch === '\\') {
      const next = raw[i + 1]
      if (next === undefined) break
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next
      i++
      continue
    }
    if (ch === quote) {
      // Inside single quotes, '' is a literal quote character.
      if (quote === "'" && raw[i + 1] === "'") {
        out += "'"
        i++
        continue
      }
      return { ok: true, value: out, end: i + 1 }
    }
    out += ch
  }
  return err(
    `${at}: unterminated ${quote === '"' ? 'double' : 'single'}-quoted string`,
  )
}

/** Drop a trailing comment: a `#` at position 0 or preceded by whitespace. */
function stripComment(raw: string): string {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '#') continue
    if (i === 0 || /\s/.test(raw[i - 1]!)) return raw.slice(0, i)
  }
  return raw
}

interface SeqOk {
  ok: true
  value: string[]
}

/** Parse `[a, "b, c", 'd']`, allowing a trailing comment after the `]`. */
function parseInlineSequence(raw: string, at: string): SeqOk | FrontmatterErr {
  const items: string[] = []
  let current = ''
  let closed = -1

  for (let i = 1; i < raw.length; i++) {
    const ch = raw[i]!
    if (ch === '"' || ch === "'") {
      const quoted = readQuoted(raw.slice(i), ch, at)
      if (!quoted.ok) return quoted
      current += raw.slice(i, i + quoted.end)
      i += quoted.end - 1
      continue
    }
    if (ch === '[') {
      return err(`${at}: nested inline sequences are not supported by this YAML subset`)
    }
    if (ch === '{') {
      return err(`${at}: flow mappings ("{ ... }") are not supported by this YAML subset`)
    }
    if (ch === ']') {
      closed = i
      break
    }
    if (ch === ',') {
      items.push(current)
      current = ''
      continue
    }
    current += ch
  }

  if (closed === -1) {
    return err(`${at}: unterminated inline sequence: missing "]"`)
  }
  items.push(current)

  const rest = raw.slice(closed + 1).trim()
  if (rest !== '' && !rest.startsWith('#')) {
    return err(`${at}: unexpected content after inline sequence: "${rest}"`)
  }

  // `[]` and a single trailing comma both mean "no more items".
  const out: string[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!.trim()
    if (item === '') {
      if (i === items.length - 1) continue
      return err(`${at}: empty item in inline sequence`)
    }
    const scalar = parseScalar(item, at)
    if (!scalar.ok) return scalar
    out.push(scalar.value)
  }

  return { ok: true, value: out }
}
