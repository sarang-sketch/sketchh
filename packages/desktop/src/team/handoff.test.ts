import { describe, expect, it } from 'vitest'

import { parseHandoffs, roleBrief, rolePrompt } from './handoff'

describe('team handoffs', () => {
  it('reads one request per line addressed to another role', () => {
    const reply = [
      'I built the todo list page.',
      '@backend: add GET /api/todos returning [{ id, title, done }]',
      '  @Database : a todos table with id, title, done ',
    ].join('\n')
    expect(parseHandoffs(reply, 'frontend')).toEqual([
      { to: 'backend', message: 'add GET /api/todos returning [{ id, title, done }]' },
      { to: 'database', message: 'a todos table with id, title, done' },
    ])
  })

  it('ignores a request to itself, an empty request, and lines inside code blocks', () => {
    const reply = [
      '@backend: talking to myself',
      '@frontend:   ',
      '```ts',
      '// @frontend: this is a comment in code',
      '```',
      'Mention of @frontend in a sentence is not a request.',
    ].join('\n')
    expect(parseHandoffs(reply, 'backend')).toEqual([])
  })

  it('tells each role what it owns and how to address the other two', () => {
    const brief = roleBrief('database')
    expect(brief).toContain('Database agent')
    expect(brief).toContain('@frontend:')
    expect(brief).toContain('@backend:')
    expect(brief).not.toContain('@database:')
  })

  it('says who a forwarded message is from', () => {
    expect(rolePrompt('backend', ' add a route ', 'frontend')).toMatch(/The Frontend agent says:\nadd a route$/)
    expect(rolePrompt('backend', 'hello', 'user')).toMatch(/The user says:\nhello$/)
  })
})
