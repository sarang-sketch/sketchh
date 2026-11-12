// Markdown for model output, rendered as React elements and NOTHING ELSE.
//
// Model output is attacker-influenced text: it is shaped by the files the model read
// and the tools it called. Rendering it with `innerHTML` (or a library that does) is
// how an AI tool turns a crafted README into script execution in a window that can
// reach the user's keychain — the class of bug behind opencode's CVE-2026-22813. So
// this parser builds elements directly: every character of input ends up in a text
// node, there is no `dangerouslySetInnerHTML` anywhere, and the only attribute taken
// from input is a link's URL, which must be http(s) and is opened by the system
// browser rather than navigated to inside the app.
//
// Supported: headings, paragraphs, bold, italic, inline code, fenced code with a copy
// button, bullet and numbered lists, blockquotes, simple tables, rules and links.

import { Fragment, useState, type ReactNode } from 'react'
import { Check, Copy, Download } from './Icons'
import styles from './Markdown.module.css'

/** Open an external link in the user's browser. Only http(s), only on a click. */
export async function openExternal(url: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      const shell = await import('@tauri-apps/plugin-shell')
      await shell.open(parsed.toString())
      return
    } catch {
      // Fall through to the browser path below.
    }
  }
  window.open(parsed.toString(), '_blank', 'noopener,noreferrer')
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className={styles.copyBtn}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
          .catch(() => {})
      }}
      aria-label={copied ? 'Copied' : 'Copy code'}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

// ── inline ──────────────────────────────────────────────────────────────────

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]+\]\([^)\s]+\))/

export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  let rest = text
  let n = 0
  while (rest.length > 0) {
    const match = INLINE.exec(rest)
    if (match === null) {
      out.push(rest)
      break
    }
    if (match.index > 0) out.push(rest.slice(0, match.index))
    const token = match[0]
    const key = `${keyPrefix}-${n++}`
    if (token.startsWith('`')) {
      out.push(
        <code key={key} className={styles.inlineCode}>
          {token.slice(1, -1)}
        </code>,
      )
    } else if (token.startsWith('**') || token.startsWith('__')) {
      out.push(<strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>)
    } else if (token.startsWith('[')) {
      const label = token.slice(1, token.indexOf(']('))
      const url = token.slice(token.indexOf('](') + 2, -1)
      const safe = /^https?:\/\//i.test(url)
      out.push(
        safe ? (
          <a
            key={key}
            href={url}
            className={styles.link}
            onClick={(event) => {
              event.preventDefault()
              void openExternal(url)
            }}
            title={url}
          >
            {label}
          </a>
        ) : (
          <span key={key}>{label}</span>
        ),
      )
    } else {
      // A single * or _ only reads as emphasis when it is not part of a word: `a_b_c`
      // and `2*3*4` stay as they are.
      const before = rest[match.index - 1]
      if (before !== undefined && /\w/.test(before)) {
        out.push(token)
      } else {
        out.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>)
      }
    }
    rest = rest.slice(match.index + token.length)
  }
  return out
}

// ── blocks ──────────────────────────────────────────────────────────────────

type Block =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'rule' }
  | { kind: 'para'; text: string }

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/.exec(line)
    if (fence !== null) {
      const marker = fence[1]!
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trim().startsWith(marker.slice(0, 3))) body.push(lines[i++]!)
      i++ // closing fence (or end of input: an unterminated block still renders)
      blocks.push({ kind: 'code', lang: fence[2] ?? '', text: body.join('\n') })
      continue
    }
    if (line.trim() === '') {
      i++
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!.replace(/\s+#+\s*$/, '') })
      i++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: 'rule' })
      i++
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      const header = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!))
      blocks.push({ kind: 'table', header, rows })
      continue
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ''))
      blocks.push({ kind: 'quote', text: body.join('\n') })
      continue
    }
    const bullet = /^\s*[-*+]\s+(.*)$/
    const numbered = /^\s*\d+[.)]\s+(.*)$/
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line)
      const pattern = ordered ? numbered : bullet
      const items: string[] = []
      while (i < lines.length) {
        const current = lines[i]!
        const item = pattern.exec(current)
        if (item !== null) {
          items.push(item[1]!)
          i++
        } else if (/^\s{2,}\S/.test(current) && items.length > 0) {
          // A wrapped or nested continuation line belongs to the previous item.
          items[items.length - 1] = `${items[items.length - 1]} ${current.trim()}`
          i++
        } else break
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^\s*(```|~~~|#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/.test(lines[i]!)
    ) {
      para.push(lines[i++]!)
    }
    if (para.length === 0) {
      // A line that looked like a block start but did not match one in full.
      para.push(lines[i++]!)
    }
    blocks.push({ kind: 'para', text: para.join('\n') })
  }
  return blocks
}

function renderLines(text: string, key: string): ReactNode[] {
  const parts = text.split('\n')
  return parts.map((part, index) => (
    <Fragment key={`${key}-${index}`}>
      {renderInline(part, `${key}-${index}`)}
      {index < parts.length - 1 && <br />}
    </Fragment>
  ))
}

/**
 * `headingOffset`: how many levels to demote headings. A chat bubble demotes by two so a
 * reply's `#` does not shout over the conversation; a document preview shows them as
 * written (0).
 *
 * `onInsertCode`: when given, each code block also has an Insert button that hands the
 * block's text over — the chat passes the editor's "insert at the cursor".
 */
export function Markdown({
  text,
  className,
  headingOffset = 2,
  onInsertCode,
}: {
  text: string
  className?: string
  headingOffset?: number
  onInsertCode?: (code: string) => void
}) {
  const blocks = parseBlocks(text)
  return (
    <div className={`${styles.markdown} ${className ?? ''}`}>
      {blocks.map((block, index) => {
        const key = `b${index}`
        switch (block.kind) {
          case 'code':
            return (
              <div key={key} className={styles.codeBlock}>
                <div className={styles.codeHeader}>
                  <span className={styles.codeLang}>{block.lang || 'text'}</span>
                  {onInsertCode !== undefined && (
                    <button
                      type="button"
                      className={styles.copyBtn}
                      onClick={() => onInsertCode(block.text)}
                      aria-label="Insert code at the cursor"
                      title="Insert at the cursor in the editor, replacing any selection (Ctrl+Z undoes it)"
                    >
                      <Download size={12} />
                      Insert
                    </button>
                  )}
                  <CopyButton text={block.text} />
                </div>
                <pre className={styles.codeContent}>
                  <code>{block.text}</code>
                </pre>
              </div>
            )
          case 'heading': {
            const Tag = (`h${Math.min(6, Math.max(1, block.level + headingOffset))}` as unknown) as 'h3'
            return (
              <Tag key={key} className={styles.heading}>
                {renderInline(block.text, key)}
              </Tag>
            )
          }
          case 'list':
            return block.ordered ? (
              <ol key={key} className={styles.list}>
                {block.items.map((item, j) => (
                  <li key={j}>{renderInline(item, `${key}-${j}`)}</li>
                ))}
              </ol>
            ) : (
              <ul key={key} className={styles.list}>
                {block.items.map((item, j) => (
                  <li key={j}>{renderInline(item, `${key}-${j}`)}</li>
                ))}
              </ul>
            )
          case 'quote':
            return (
              <blockquote key={key} className={styles.quote}>
                {renderLines(block.text, key)}
              </blockquote>
            )
          case 'table':
            return (
              <div key={key} className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      {block.header.map((cell, j) => (
                        <th key={j}>{renderInline(cell, `${key}-h${j}`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, j) => (
                          <td key={j}>{renderInline(cell, `${key}-${r}-${j}`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          case 'rule':
            return <hr key={key} className={styles.rule} />
          case 'para':
            return (
              <p key={key} className={styles.para}>
                {renderLines(block.text, key)}
              </p>
            )
        }
      })}
    </div>
  )
}

export default Markdown
