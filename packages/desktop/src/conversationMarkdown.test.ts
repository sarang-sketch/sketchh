// W9 invariant 8a — a conversation exports to faithful Markdown.
import { describe, it, expect } from 'vitest'
import { conversationToMarkdown, fenceFor } from './conversationMarkdown'
import type { Conversation } from './state/AppState'

const base: Conversation = {
  id: 'c1',
  title: 'Fix the login bug',
  createdAt: Date.UTC(2026, 0, 2, 10, 0),
  root: '/home/me/project',
  messages: [
    { id: 'm1', role: 'user', content: 'Why does login fail?', timestamp: Date.UTC(2026, 0, 2, 10, 1) },
    {
      id: 'm2',
      role: 'agent',
      content: 'The token expires. Here is the fix:\n\n```ts\nconst t = refresh()\n```',
      timestamp: Date.UTC(2026, 0, 2, 10, 2),
      files: [{ path: 'src/auth.ts', added: 3, removed: 1, created: false }],
      filesState: 'applied',
    },
  ],
}

describe('conversationToMarkdown', () => {
  it('includes the title, both messages, and preserves a code block', () => {
    const md = conversationToMarkdown(base)
    expect(md).toContain('# Fix the login bug')
    expect(md).toContain('Why does login fail?')
    expect(md).toContain('## You')
    expect(md).toContain('## Sketch')
    expect(md).toContain('```ts')
    expect(md).toContain('const t = refresh()')
  })

  it('records the files a run changed', () => {
    const md = conversationToMarkdown(base)
    expect(md).toContain('`src/auth.ts` (+3 −1)')
    expect(md).toMatch(/Files \(applied\)/)
  })

  it('falls back to a placeholder for an empty message and a default title', () => {
    const md = conversationToMarkdown({
      ...base,
      title: '   ',
      messages: [{ id: 'x', role: 'user', content: '', timestamp: base.createdAt }],
    })
    expect(md).toContain('# Conversation')
    expect(md).toContain('_(no text)_')
  })

  it('fences a code run with one more backtick than it contains', () => {
    expect(fenceFor('plain')).toBe('```')
    expect(fenceFor('a ``` b')).toBe('````')
    expect(fenceFor('a ```` b')).toBe('`````')
  })
})
