// Links in terminal output: a dev server's URL, and the file locations compilers,
// linters, test runners and stack traces print — so a click goes to the line.
//
// Recognised:
//   http(s) URLs                   http://localhost:5173/
//   path:line[:column]             src/app.ts:12:5   ./a.py:3   C:\x\y.js:10:15
//   path(line,column)              src/app.ts(12,5): error TS2322 (tsc, MSBuild)
//   File "path", line N            Python tracebacks
//   a path with a folder in it     src/components/App.tsx (no line: the file's top)
//
// A bare name with no folder and no line ("node.js", "v1.2.3") is not a link: too
// many words look like file names. Pure: the panel decides what a click does.

export type TerminalLinkTarget =
  | { kind: 'url'; url: string }
  | { kind: 'file'; path: string; line?: number; column?: number }

export interface TerminalLink {
  /** Offsets into the line, end exclusive. */
  start: number
  end: number
  target: TerminalLinkTarget
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/g
// A path: optional drive or ./ ../ / prefix, folders, then a name with an extension.
const PATH = String.raw`(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/]|~[\\/])?(?:[\w.@+\-]+[\\/])*[\w@+\-][\w.@+\-]*\.[A-Za-z][A-Za-z0-9]{0,9}`
const FILE_PATTERN = new RegExp(String.raw`(${PATH})(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))?`, 'g')
const PYTHON_PATTERN = /File "([^"]+)", line (\d+)/g

/** Trailing punctuation that ends a sentence, not a URL. */
function trimUrl(url: string): string {
  let out = url.replace(/[.,;:!?]+$/, '')
  // A closing bracket the URL did not open is the sentence's: "(see http://x/a)".
  for (const [open, close] of [['(', ')'], ['[', ']']] as const) {
    while (out.endsWith(close) && out.split(open).length - 1 < out.split(close).length - 1) out = out.slice(0, -1)
  }
  return out
}

/** Lines longer than this (minified bundles, base64) are scanned for URLs only. */
export const MAX_FILE_LINK_SCAN = 2_000
/** And past this, not at all. */
export const MAX_LINK_SCAN = 20_000

/** Every link in one line of output, in order, never overlapping. */
export function findTerminalLinks(text: string): TerminalLink[] {
  const links: TerminalLink[] = []
  if (text.length > MAX_LINK_SCAN) return links
  const taken = (start: number, end: number) => links.some((link) => start < link.end && end > link.start)

  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0])
    if (url.length <= 'http://'.length) continue
    links.push({ start: match.index!, end: match.index! + url.length, target: { kind: 'url', url } })
  }
  if (text.length > MAX_FILE_LINK_SCAN) return links

  for (const match of text.matchAll(PYTHON_PATTERN)) {
    const start = match.index!
    const end = start + match[0].length
    if (taken(start, end)) continue
    links.push({ start, end, target: { kind: 'file', path: match[1]!, line: Number(match[2]) } })
  }

  for (const match of text.matchAll(FILE_PATTERN)) {
    const start = match.index!
    const end = start + match[0].length
    if (taken(start, end)) continue
    const path = match[1]!
    const lineText = match[2] ?? match[4]
    const columnText = match[3] ?? match[5]
    const hasFolder = /[\\/]/.test(path)
    if (lineText === undefined && !hasFolder) continue
    // "1.2.3" and "v1.2" are versions: a "file" whose name is all digits and dots is not one.
    if (/^[\d.]+$/.test(path.replace(/^.*[\\/]/, '').replace(/\.[A-Za-z][A-Za-z0-9]*$/, ''))) continue
    links.push({
      start,
      end,
      target: {
        kind: 'file',
        path,
        ...(lineText !== undefined ? { line: Number(lineText) } : {}),
        ...(columnText !== undefined ? { column: Number(columnText) } : {}),
      },
    })
  }

  return links.sort((a, b) => a.start - b.start)
}

/** Text split into runs: each either plain or one whole link. */
export function splitByLinks(text: string, links: readonly TerminalLink[]): Array<{ text: string; link?: TerminalLinkTarget }> {
  const parts: Array<{ text: string; link?: TerminalLinkTarget }> = []
  let at = 0
  for (const link of links) {
    if (link.start > at) parts.push({ text: text.slice(at, link.start) })
    parts.push({ text: text.slice(link.start, link.end), link: link.target })
    at = link.end
  }
  if (at < text.length) parts.push({ text: text.slice(at) })
  return parts
}


/** Lines whose links are remembered. A streaming command re-renders its whole output on
 *  every update; each line is scanned once, not ten times a second. */
const CACHE_LINES = 4_000
const cache = new Map<string, TerminalLink[]>()

/** `findTerminalLinks`, remembered per line of text. */
export function terminalLinksOf(text: string): TerminalLink[] {
  const known = cache.get(text)
  if (known !== undefined) return known
  const links = findTerminalLinks(text)
  if (cache.size >= CACHE_LINES) cache.clear()
  cache.set(text, links)
  return links
}
