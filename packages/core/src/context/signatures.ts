// Signature extraction — the outline pass behind Requirement 18.5.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// When context does not fit, the naive move is to keep the first N chunks whole
// and drop the rest. That spends the whole budget on three function bodies. A
// model handed FORTY signatures — names, parameter types, return types — knows
// what the codebase offers and can ask for the one body it needs. So truncation
// here degrades DETAIL before it degrades COVERAGE, which is what 18.5 asks for.
//
// ── HAND-ROLLED, AND WHAT THAT COSTS ────────────────────────────────────────
//
// `packages/core` has zero runtime dependencies, so there is no tree-sitter and
// no TypeScript compiler API available here. This is a line-oriented scanner
// over brace/paren depth with a small set of declaration patterns. It is a
// HEURISTIC and the output is an OUTLINE, not compilable source: a class header
// is emitted without its closing brace, and bodies are replaced by an elision
// marker.
//
// ── DEGRADING HONESTLY ───────────────────────────────────────────────────────
//
// The one thing this file must never do is emit a mangled fragment and let a
// caller believe it is a signature. Three rules enforce that:
//
//   1. A language with no extractor returns `supported: false` with a reason,
//      an empty declaration list, and NOTHING ELSE. The caller's ladder then
//      skips the signature rungs entirely (see `context/assembly.ts`).
//   2. A declaration whose signature cannot be bounded inside
//      `maxSignatureLines` is COUNTED in `unresolved` and omitted. Half a
//      parameter list is worse than no signature.
//   3. A block that is kept in full but hits `maxBlockLines` carries a visible
//      `// … truncated` marker, so a partial interface never reads as complete.
//
// A chunk that begins mid-function is the normal case for chunked retrieval, and
// it is handled by the same rules: the partial declaration at the top is not
// bounded, so it is not emitted.
//
// ── DETERMINISM ──────────────────────────────────────────────────────────────
//
// Pure function of (path, text). No filesystem, no clock, no iteration over a
// Map. Same input, byte-identical output.
//
// Validates: Requirements 18.5

/** Families the scanner understands. Everything else is `unsupported`. */
export type SignatureLanguage = 'javascript-family' | 'python' | 'unsupported'

export type DeclarationKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'namespace'

/** What replaces an elided body. */
export const BODY_ELISION = '{ … }'
/** What replaces an elided arrow-function body. */
export const ARROW_ELISION = '…'
/** Appended to a kept block that hit the line cap. */
export const TRUNCATION_MARKER = '// … truncated'

export interface Declaration {
  kind: DeclarationKind
  name: string
  /** Original indentation preserved; body elided. Never a partial construct. */
  signature: string
  /** The doc comment immediately above, verbatim. Empty when there is none. */
  doc: string
  /** 0-based line index within the supplied text. */
  line: number
}

export interface SignatureExtraction {
  language: SignatureLanguage
  /** False means: no extractor for this language. Do not offer signature rungs. */
  supported: boolean
  declarations: Declaration[]
  /**
   * Declarations spotted but not bounded inside the line cap, and therefore
   * deliberately omitted. A non-zero count is the honest admission that this
   * scanner did not understand part of the input.
   */
  unresolved: number
  /** Why the result is empty, when it is empty. Null otherwise. */
  reason: string | null
}

export interface ExtractSignatureOptions {
  /** Lines a single signature may span before it is abandoned. */
  maxSignatureLines?: number
  /** Lines of a kept block (interface/type/enum) before it is marked truncated. */
  maxBlockLines?: number
  /** Declarations returned. A cap keeps a generated file from filling a budget. */
  maxDeclarations?: number
  /** Include the doc comment above each declaration. */
  includeDoc?: boolean
}

const MAX_SIGNATURE_LINES = 12
const MAX_BLOCK_LINES = 40
const MAX_DECLARATIONS = 200
/** Lines of a `/** … *\/` or `//` run kept as a doc comment. */
const MAX_DOC_LINES = 8

const JS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
const PYTHON_EXTENSIONS = new Set(['.py', '.pyi'])

export function extensionOf(path: string): string {
  const match = /\.[^./\\]+$/.exec(path)
  return match === null ? '' : match[0].toLowerCase()
}

/** Which extractor, if any, handles this path. */
export function languageOf(path: string): SignatureLanguage {
  const ext = extensionOf(path)
  if (JS_EXTENSIONS.has(ext)) return 'javascript-family'
  if (PYTHON_EXTENSIONS.has(ext)) return 'python'
  return 'unsupported'
}

/** True when this path has an extractor. The ladder's gate. */
export function supportsSignatures(path: string): boolean {
  return languageOf(path) !== 'unsupported'
}

/**
 * Extract an outline. Never throws: a file this scanner cannot read as code
 * comes back empty with a reason, which the caller treats as "no signature
 * rung available" rather than as an error.
 */
export function extractSignatures(
  path: string,
  text: string,
  options: ExtractSignatureOptions = {}
): SignatureExtraction {
  const language = languageOf(path)
  if (language === 'unsupported') {
    const ext = extensionOf(path)
    return {
      language,
      supported: false,
      declarations: [],
      unresolved: 0,
      reason: `no signature extractor for '${ext === '' ? path : ext}'; bodies are the only honest rendering`,
    }
  }

  const lines = text.split('\n').map(line => line.replace(/\r$/, ''))
  const limits = {
    maxSignatureLines: Math.max(1, options.maxSignatureLines ?? MAX_SIGNATURE_LINES),
    maxBlockLines: Math.max(1, options.maxBlockLines ?? MAX_BLOCK_LINES),
    maxDeclarations: Math.max(1, options.maxDeclarations ?? MAX_DECLARATIONS),
    includeDoc: options.includeDoc !== false,
  }

  const scanned =
    language === 'python' ? scanPython(lines, limits) : scanJavaScript(lines, limits)

  return {
    language,
    supported: true,
    declarations: scanned.declarations,
    unresolved: scanned.unresolved,
    reason:
      scanned.declarations.length === 0
        ? 'no bounded declaration found in this text'
        : null,
  }
}

/**
 * Render an outline as text. Declarations in source order, one per line group.
 *
 * The result is an OUTLINE. It is not valid source and is not presented as
 * such — the caller labels the section.
 */
export function renderSignatures(
  extraction: SignatureExtraction,
  options: { includeDoc?: boolean } = {}
): string {
  const withDoc = options.includeDoc === true
  const out: string[] = []
  for (const declaration of extraction.declarations) {
    if (withDoc && declaration.doc !== '') out.push(declaration.doc)
    out.push(declaration.signature)
  }
  return out.join('\n')
}

interface Limits {
  maxSignatureLines: number
  maxBlockLines: number
  maxDeclarations: number
  includeDoc: boolean
}

interface ScanResult {
  declarations: Declaration[]
  unresolved: number
}

// ── shared lexing helpers ───────────────────────────────────────────────────

/**
 * Blank out string, template and comment CONTENT so depth counting never trips
 * over a brace inside a literal. Lengths are preserved, so a column index into
 * the stripped line is valid in the original.
 */
export function stripNoise(line: string): string {
  const out: string[] = []
  let quote: string | null = null
  let inBlockComment = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (inBlockComment) {
      if (ch === '*' && line[i + 1] === '/') {
        out.push(' ', ' ')
        i++
        inBlockComment = false
        continue
      }
      out.push(' ')
      continue
    }
    if (quote !== null) {
      if (ch === '\\') {
        out.push(' ', ' ')
        i++
        continue
      }
      if (ch === quote) quote = null
      out.push(' ')
      continue
    }
    if (ch === '/' && line[i + 1] === '/') {
      for (let k = i; k < line.length; k++) out.push(' ')
      break
    }
    if (ch === '/' && line[i + 1] === '*') {
      out.push(' ', ' ')
      i++
      inBlockComment = true
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      out.push(' ')
      continue
    }
    out.push(ch)
  }
  return out.join('')
}

function indentOf(line: string): string {
  const match = /^[ \t]*/.exec(line)
  return match === null ? '' : match[0]
}

function countBraces(stripped: string): number {
  let delta = 0
  for (const ch of stripped) {
    if (ch === '{') delta++
    else if (ch === '}') delta--
  }
  return delta
}

/**
 * Line index where the brace opened at (`startLine`, `startCol`) closes, or
 * null when it never does inside `limit` lines.
 */
function findBlockEnd(
  stripped: string[],
  startLine: number,
  startCol: number,
  limit: number
): number | null {
  let depth = 0
  const last = Math.min(stripped.length - 1, startLine + limit - 1)
  for (let i = startLine; i <= last; i++) {
    const text = stripped[i]!
    for (let c = i === startLine ? startCol : 0; c < text.length; c++) {
      const ch = text[c]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) return i
      }
    }
  }
  return null
}

// ── the JavaScript / TypeScript family ──────────────────────────────────────

const RE_CLASS = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/
const RE_INTERFACE = /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/
const RE_ENUM = /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/
const RE_TYPE = /^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)/
const RE_NAMESPACE = /^(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+([A-Za-z_$][\w$]*)/
const RE_FUNCTION = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/
const RE_ARROW_CONST =
  /^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s+)?(?:function\b|[(<])/
const RE_MEMBER =
  /^(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:abstract\s+)?(?:readonly\s+)?(?:async\s+)?(?:get\s+|set\s+)?\*?\s*(?:\[?)([A-Za-z_$][\w$]*)(?:\]?)\s*(?:<[^(]*>)?\s*\(/
/**
 * Keywords that look like a member declaration but are control flow or a call.
 *
 * Written as a split string rather than an array of quoted words on purpose: an
 * array containing `'import', 'require'` reads as a module specifier to the
 * zero-dependency guard in `test/deps.test.ts`, which scans source text. The
 * guard is right to be blunt about it; this is the cheaper side to fix.
 */
const NOT_A_MEMBER = new Set(
  'if for while switch catch return do else function await typeof new super this import require'.split(
    ' '
  )
)

function scanJavaScript(lines: string[], limits: Limits): ScanResult {
  const stripped = lines.map(stripNoise)
  const declarations: Declaration[] = []
  let unresolved = 0

  // Brace depth at the current line, and the depths at which class/interface
  // bodies live. A member is only recognised at a class body's own depth, which
  // is what keeps `doThing(x)` inside a function body from reading as a method.
  let depth = 0
  const classBodyDepths: number[] = []

  for (let i = 0; i < lines.length; i++) {
    while (classBodyDepths.length > 0 && depth < classBodyDepths[classBodyDepths.length - 1]!) {
      classBodyDepths.pop()
    }

    const raw = lines[i]!
    const trimmed = raw.trim()
    if (trimmed === '') {
      depth += countBraces(stripped[i]!)
      continue
    }
    if (declarations.length >= limits.maxDeclarations) {
      depth += countBraces(stripped[i]!)
      continue
    }

    const spotted = spotJsDeclaration(trimmed, depth, classBodyDepths)
    if (spotted === null) {
      depth += countBraces(stripped[i]!)
      continue
    }

    if (spotted.keepBlock) {
      const opened = openBraceColumn(stripped[i]!)
      const end =
        opened === null ? null : findBlockEnd(stripped, i, opened, limits.maxBlockLines)
      const block = renderKeptBlock(lines, stripped, i, end, opened, limits)
      if (block === null) {
        unresolved++
        depth += countBraces(stripped[i]!)
        continue
      }
      declarations.push({
        kind: spotted.kind,
        name: spotted.name,
        signature: block.text,
        doc: limits.includeDoc ? docAbove(lines, i) : '',
        line: i,
      })
      // Skip the block's interior: its members are already in `block.text`.
      for (let k = i; k <= block.endLine; k++) depth += countBraces(stripped[k]!)
      i = block.endLine
      continue
    }

    const bounded = boundJsSignature(lines, stripped, i, limits.maxSignatureLines)
    if (bounded === null) {
      // RULE 2: not bounded, not emitted. Counted instead.
      unresolved++
      depth += countBraces(stripped[i]!)
      continue
    }

    if (spotted.assignment && !/=>|\bfunction\b/.test(bounded.text)) {
      // `const total = (a + b)` is a value, not a callable. It was never a
      // declaration this file claims to extract, so it is dropped rather than
      // rendered as a signature.
      depth += countBraces(stripped[i]!)
      continue
    }

    declarations.push({
      kind: spotted.kind,
      name: spotted.name,
      // A class KEEPS its opening brace: its members are emitted beneath it, so
      // eliding the body here would contradict the lines that follow.
      signature:
        spotted.kind === 'class' && bounded.bodyOpens
          ? bounded.text.slice(0, bounded.text.length - BODY_ELISION.length) + '{'
          : bounded.text,
      doc: limits.includeDoc ? docAbove(lines, i) : '',
      line: i,
    })

    if (spotted.kind === 'class') {
      // A class header keeps its brace so members can nest under it in the
      // outline; record the body depth so members are recognised.
      for (let k = i; k <= bounded.endLine; k++) depth += countBraces(stripped[k]!)
      if (bounded.bodyOpens) classBodyDepths.push(depth)
      i = bounded.endLine
      continue
    }

    // Everything else: step over the body so nested statements are not mined.
    const skipTo = bounded.bodyOpens
      ? findBlockEnd(stripped, bounded.endLine, bounded.bodyColumn ?? 0, lines.length)
      : bounded.endLine
    const stop = skipTo ?? bounded.endLine
    for (let k = i; k <= stop; k++) depth += countBraces(stripped[k]!)
    i = stop
  }

  return { declarations, unresolved }
}

interface SpottedDeclaration {
  kind: DeclarationKind
  name: string
  /** Keep the whole block rather than eliding it: the members ARE the type. */
  keepBlock: boolean
  /** `const x = …` form: only a declaration when the value is callable. */
  assignment?: boolean
}

function spotJsDeclaration(
  trimmed: string,
  depth: number,
  classBodyDepths: number[]
): SpottedDeclaration | null {
  let match = RE_INTERFACE.exec(trimmed)
  if (match !== null) return { kind: 'interface', name: match[1]!, keepBlock: true }

  match = RE_ENUM.exec(trimmed)
  if (match !== null) return { kind: 'enum', name: match[1]!, keepBlock: true }

  match = RE_TYPE.exec(trimmed)
  if (match !== null) return { kind: 'type', name: match[1]!, keepBlock: true }

  match = RE_CLASS.exec(trimmed)
  if (match !== null) return { kind: 'class', name: match[1]!, keepBlock: false }

  match = RE_NAMESPACE.exec(trimmed)
  if (match !== null) return { kind: 'namespace', name: match[1]!, keepBlock: false }

  match = RE_FUNCTION.exec(trimmed)
  if (match !== null) return { kind: 'function', name: match[1]!, keepBlock: false }

  match = RE_ARROW_CONST.exec(trimmed)
  if (match !== null) {
    return { kind: 'function', name: match[1]!, keepBlock: false, assignment: true }
  }

  const inClassBody =
    classBodyDepths.length > 0 && depth === classBodyDepths[classBodyDepths.length - 1]
  if (inClassBody) {
    match = RE_MEMBER.exec(trimmed)
    if (match !== null && !NOT_A_MEMBER.has(match[1]!)) {
      return { kind: 'method', name: match[1]!, keepBlock: false }
    }
  }
  return null
}

function openBraceColumn(stripped: string): number | null {
  const at = stripped.indexOf('{')
  return at === -1 ? null : at
}

/**
 * A kept block: `interface`, `type` and `enum` declarations, whose members are
 * the whole point. Braceless forms (`type A = B | C`) are bounded by their
 * terminator instead.
 */
function renderKeptBlock(
  lines: string[],
  stripped: string[],
  start: number,
  end: number | null,
  openColumn: number | null,
  limits: Limits
): { text: string; endLine: number } | null {
  if (openColumn === null) {
    // No brace on the opening line: a braceless alias, or a brace further down.
    const bounded = boundJsSignature(lines, stripped, start, limits.maxSignatureLines)
    if (bounded === null) return null
    if (!bounded.bodyOpens) return { text: bounded.text, endLine: bounded.endLine }
    const blockEnd = findBlockEnd(
      stripped,
      bounded.endLine,
      bounded.bodyColumn ?? 0,
      limits.maxBlockLines
    )
    if (blockEnd === null) return truncatedBlock(lines, start, limits)
    return { text: lines.slice(start, blockEnd + 1).join('\n'), endLine: blockEnd }
  }

  if (end === null) return truncatedBlock(lines, start, limits)
  return { text: lines.slice(start, end + 1).join('\n'), endLine: end }
}

/**
 * RULE 3: a block that hit the cap is kept, and SAYS it was cut. A silently
 * halved interface reads as a complete one, which is the failure mode this
 * marker exists to prevent.
 */
function truncatedBlock(
  lines: string[],
  start: number,
  limits: Limits
): { text: string; endLine: number } {
  const last = Math.min(lines.length - 1, start + limits.maxBlockLines - 1)
  const kept = lines.slice(start, last + 1)
  kept.push(`${indentOf(lines[start]!)}  ${TRUNCATION_MARKER}`)
  return { text: kept.join('\n'), endLine: last }
}

interface BoundedSignature {
  text: string
  endLine: number
  /** True when a body brace follows the signature. */
  bodyOpens: boolean
  /** Column of that brace on `endLine`. */
  bodyColumn: number | null
}

/** A line ending in one of these is unfinished; the declaration continues. */
const CONTINUES_AFTER = /(?:[=|&,(<+?:.-]|=>|\bextends\b|\bimplements\b|\bkeyof\b|\btypeof\b)$/
/** A line starting with one of these continues the line above it. */
const CONTINUES_BEFORE = /^(?:[|&,)?:.]|=>|\{|extends\b|implements\b)/

/** The line without its trailing `//` comment, trimmed. */
function visibleCode(line: string): string {
  return line.replace(/\s+\/\/.*$/, '').trim()
}

/**
 * Walk forward from a declaration line until the signature is closed by a body
 * brace, a `=>`, a `;`, or the end of a line that is not continued. Returns
 * null when none of those arrives inside `maxLines` — an unbounded declaration
 * is never rendered.
 *
 * The end-of-line rule is what stops a braceless `type A = B | C` from running
 * on and absorbing the NEXT declaration's brace, which would emit exactly the
 * mangled fragment this module promises never to produce.
 */
function boundJsSignature(
  lines: string[],
  stripped: string[],
  start: number,
  maxLines: number
): BoundedSignature | null {
  let parens = 0
  const last = Math.min(lines.length - 1, start + maxLines - 1)

  for (let i = start; i <= last; i++) {
    const text = stripped[i]!
    for (let c = 0; c < text.length; c++) {
      const ch = text[c]!
      if (ch === '(' || ch === '[') {
        parens++
        continue
      }
      if (ch === ')' || ch === ']') {
        parens = Math.max(0, parens - 1)
        continue
      }
      if (parens > 0) continue

      if (ch === '{') {
        const head = joinHead(lines, start, i, c)
        return {
          text: `${head.replace(/\s+$/, '')} ${BODY_ELISION}`,
          endLine: i,
          bodyOpens: true,
          bodyColumn: c,
        }
      }
      if (ch === '=' && text[c + 1] === '>') {
        const head = joinHead(lines, start, i, c + 2)
        return {
          text: `${head.replace(/\s+$/, '')} ${ARROW_ELISION}`,
          endLine: i,
          bodyOpens: false,
          bodyColumn: null,
        }
      }
      if (ch === ';') {
        return {
          text: joinHead(lines, start, i, c + 1),
          endLine: i,
          bodyOpens: false,
          bodyColumn: null,
        }
      }
    }

    if (parens > 0) continue
    const here = visibleCode(lines[i]!)
    if (here === '' || CONTINUES_AFTER.test(here)) continue
    const next = lines[i + 1]
    if (next !== undefined && CONTINUES_BEFORE.test(visibleCode(next))) continue
    return {
      text: joinHead(lines, start, i, lines[i]!.length),
      endLine: i,
      bodyOpens: false,
      bodyColumn: null,
    }
  }
  return null
}

/** Lines `start..end`, with `end` cut at `column`. Indentation preserved. */
function joinHead(lines: string[], start: number, end: number, column: number): string {
  if (start === end) return lines[start]!.slice(0, column).replace(/\s+$/, '')
  const head = lines.slice(start, end).map(l => l.replace(/\s+$/, ''))
  head.push(lines[end]!.slice(0, column).replace(/\s+$/, ''))
  return head.join('\n')
}

/** The `/** … *\/` block or `//` run immediately above `index`. */
function docAbove(lines: string[], index: number): string {
  let i = index - 1
  while (i >= 0 && lines[i]!.trim() === '') i--
  if (i < 0) return ''

  const trimmed = lines[i]!.trim()
  if (trimmed.endsWith('*/')) {
    let start = i
    while (start >= 0 && !lines[start]!.trim().startsWith('/*')) start--
    if (start < 0) return ''
    if (i - start + 1 > MAX_DOC_LINES) return ''
    return lines.slice(start, i + 1).join('\n')
  }
  if (trimmed.startsWith('//')) {
    let start = i
    while (start > 0 && lines[start - 1]!.trim().startsWith('//')) start--
    if (i - start + 1 > MAX_DOC_LINES) start = i - MAX_DOC_LINES + 1
    return lines.slice(start, i + 1).join('\n')
  }
  return ''
}

// ── Python ──────────────────────────────────────────────────────────────────

const RE_PY_DEF = /^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/
const RE_PY_CLASS = /^class\s+([A-Za-z_][\w]*)/

function scanPython(lines: string[], limits: Limits): ScanResult {
  const declarations: Declaration[] = []
  let unresolved = 0

  for (let i = 0; i < lines.length; i++) {
    if (declarations.length >= limits.maxDeclarations) break
    const trimmed = lines[i]!.trim()
    if (trimmed === '') continue

    const def = RE_PY_DEF.exec(trimmed)
    const cls = def === null ? RE_PY_CLASS.exec(trimmed) : null
    if (def === null && cls === null) continue

    const bounded = boundPythonSignature(lines, i, limits.maxSignatureLines)
    if (bounded === null) {
      unresolved++
      continue
    }

    declarations.push({
      kind: def !== null ? 'function' : 'class',
      name: (def ?? cls!)[1]!,
      signature: bounded.text,
      doc: limits.includeDoc ? pythonDocBelow(lines, bounded.endLine) : '',
      line: i,
    })
    i = bounded.endLine
  }

  return { declarations, unresolved }
}

/** A Python header ends at the `:` that closes it at paren depth zero. */
function boundPythonSignature(
  lines: string[],
  start: number,
  maxLines: number
): { text: string; endLine: number } | null {
  let depth = 0
  const last = Math.min(lines.length - 1, start + maxLines - 1)

  for (let i = start; i <= last; i++) {
    const text = stripNoise(lines[i]!)
    for (let c = 0; c < text.length; c++) {
      const ch = text[c]!
      if (ch === '(' || ch === '[') depth++
      else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
      else if (ch === ':' && depth === 0) {
        const head = joinHead(lines, start, i, c + 1)
        return { text: `${head} ${ARROW_ELISION}`, endLine: i }
      }
    }
  }
  return null
}

/** The first line of a docstring directly under a Python header. */
function pythonDocBelow(lines: string[], headerEnd: number): string {
  const next = lines[headerEnd + 1]
  if (next === undefined) return ''
  const trimmed = next.trim()
  if (!trimmed.startsWith('"""') && !trimmed.startsWith("'''")) return ''
  const quote = trimmed.slice(0, 3)
  const body = trimmed.slice(3)
  const closed = body.indexOf(quote)
  const first = closed === -1 ? body : body.slice(0, closed)
  return `${indentOf(next)}${quote}${first.trim()}${quote}`
}
