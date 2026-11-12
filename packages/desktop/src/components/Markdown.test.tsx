// Markdown renders model output as React elements and NOTHING ELSE.
//
// Model output is attacker-influenced text (it is shaped by the files the model read and
// the tools it called), so the one invariant that matters most here is that it can never
// inject HTML or script into the window — the class of bug behind opencode's
// CVE-2026-22813. These tests feed the three canonical payloads (`<img onerror>`,
// `<script>`, a `javascript:` link) and assert they end up as inert text, never as a
// live element or a navigable link. The rest cover the formatting the chat relies on:
// headings, lists, tables, links, inline code, block quotes, and a fenced code block
// with a language label and a working Copy button.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Markdown } from './Markdown'

afterEach(() => cleanup())

describe('Markdown is inject-safe (CVE-class: model output can never run as HTML/script)', () => {
  it('renders an <img onerror> payload as text, with no <img> element and no handler', () => {
    const payload = `Look: <img src=x onerror="window.__pwned = 1">`
    const { container } = render(<Markdown text={payload} />)
    // No real <img> element was created, so its onerror can never fire.
    expect(container.querySelector('img')).toBeNull()
    // The angle-bracket markup survives as literal text (it ended up in a text node).
    expect(container.textContent).toContain('<img src=x onerror=')
    // And nothing executed.
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })

  it('renders a <script> tag as text, with no <script> element', () => {
    const payload = 'Before <script>window.__ran = 1</script> after'
    const { container } = render(<Markdown text={payload} />)
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<script>window.__ran = 1</script>')
    expect((window as unknown as { __ran?: number }).__ran).toBeUndefined()
  })

  it('refuses a javascript: link: it is plain text, not an anchor', () => {
    const { container } = render(<Markdown text={'[click me](javascript:alert(1))'} />)
    const anchors = container.querySelectorAll('a')
    // Either no anchor at all, or none whose href is the javascript: URL.
    for (const a of anchors) expect(a.getAttribute('href')?.startsWith('javascript:')).not.toBe(true)
    // The label is still shown to the reader, just not as a live link.
    expect(container.textContent).toContain('click me')
  })

  it('renders an http(s) link as a real anchor that opens externally, not in-app', () => {
    // Not running under Tauri, so openExternal falls through to window.open; stub it so
    // the click does not reach jsdom's unimplemented window.open.
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const { container } = render(<Markdown text={'See [the docs](https://example.com/guide)'} />)
    const anchor = container.querySelector('a')
    expect(anchor).not.toBeNull()
    expect(anchor!.getAttribute('href')).toBe('https://example.com/guide')
    // A click is intercepted (preventDefault) so the app never navigates its own window,
    // and it is routed to the external opener instead.
    const clicked = fireEvent.click(anchor!)
    expect(clicked).toBe(false) // preventDefault() was called
    expect(open).toHaveBeenCalledWith('https://example.com/guide', '_blank', 'noopener,noreferrer')
    open.mockRestore()
  })
})

describe('Markdown formatting', () => {
  it('renders headings, a bullet list, a table, inline code and a block quote', () => {
    const text = [
      '# Title',
      '',
      '- first',
      '- second',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      'Use `npm run build` to compile.',
      '',
      '> a quoted note',
    ].join('\n')
    const { container } = render(<Markdown text={text} headingOffset={0} />)
    expect(screen.getByText('Title').tagName).toBe('H1')
    expect(container.querySelectorAll('ul li')).toHaveLength(2)
    const table = container.querySelector('table')!
    expect(table).not.toBeNull()
    expect(within(table).getAllByRole('columnheader')).toHaveLength(2)
    expect(within(table).getByText('1')).toBeTruthy()
    expect(container.querySelector('code')!.textContent).toBe('npm run build')
    expect(container.querySelector('blockquote')!.textContent).toContain('a quoted note')
  })

  it('shows a fenced code block with its language label and a working Copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const code = "const x = 1\nconsole.log(x)"
    render(<Markdown text={'```ts\n' + code + '\n```'} />)
    // The language label is shown.
    expect(screen.getByText('ts')).toBeTruthy()
    // Copy copies the block text and flips to a "Copied" state.
    const copy = screen.getByRole('button', { name: 'Copy code' })
    fireEvent.click(copy)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(code))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy()
  })
})
