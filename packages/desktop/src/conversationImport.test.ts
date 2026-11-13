import { describe, expect, it } from 'vitest'

import { conversationToJson, parseImportedConversation } from './conversationImport'
import type { Conversation } from './state/AppState'

const conversation: Conversation = {
  id: 'conv-1',
  title: 'Tidy the imports',
  messages: [
    { id: 'm1', role: 'user', content: 'tidy the imports', timestamp: 1000 },
    { id: 'm2', role: 'agent', content: 'done', timestamp: 2000 },
  ],
  createdAt: 1000,
  updatedAt: 2000,
  root: 'C:/proj',
}

describe('conversation export / import', () => {
  it('round-trips through JSON', () => {
    const parsed = parseImportedConversation(JSON.parse(conversationToJson(conversation)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.conversation.title).toBe('Tidy the imports')
    expect(parsed.conversation.messages).toHaveLength(2)
    expect(parsed.conversation.messages[0]!.content).toBe('tidy the imports')
    expect(parsed.conversation.root).toBe('C:/proj')
  })

  it('rejects a file with no messages', () => {
    expect(parseImportedConversation({ app: 'sketch', messages: [] }).ok).toBe(false)
  })

  it('rejects a message with an unknown role', () => {
    const parsed = parseImportedConversation({ messages: [{ role: 'robot', content: 'hi' }] })
    expect(parsed.ok).toBe(false)
  })

  it('rejects a file from another app', () => {
    expect(parseImportedConversation({ app: 'other', messages: [{ role: 'user', content: 'hi' }] }).ok).toBe(false)
  })

  it('keeps only role, content and timestamp from each message', () => {
    const parsed = parseImportedConversation({
      messages: [{ role: 'user', content: 'hi', receipt: { cost: 99 }, filesState: 'applied' }],
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.conversation.messages[0]).toEqual(
      expect.objectContaining({ role: 'user', content: 'hi' }),
    )
    expect('receipt' in parsed.conversation.messages[0]!).toBe(false)
  })
})
