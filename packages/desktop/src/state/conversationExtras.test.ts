// Per-conversation extras: pin/archive, per-chat model, feedback, edit-and-resend.
// Pure functions — every assertion here is about a returned value, never about
// storage, React, or a run having happened.

import { describe, expect, it } from 'vitest'
import {
  archiveConversation,
  editAndResend,
  getExtras,
  getFeedback,
  listArchivedConversations,
  orderConversations,
  pinConversation,
  setFeedback,
  setPerChatModel,
  toggleFeedback,
  unarchiveConversation,
  unpinConversation,
  type ConversationExtrasMap,
} from './conversationExtras'
import type { ChatMessage as AppChatMessage } from './AppState'

const ALLOW = ['gpt-5', 'claude-sonnet-4', 'llama-3-local']

function conv(id: string, updatedAt: number, createdAt = 1000) {
  return { id, title: id, messages: [], createdAt, updatedAt }
}

function msg(id: string, role: AppChatMessage['role'], content: string): AppChatMessage {
  return { id, role, content, timestamp: 1000 }
}

describe('pin / archive', () => {
  it('pins and unpins without touching other conversations', () => {
    const map: ConversationExtrasMap = {}
    const pinned = pinConversation(map, 'a')
    expect(getExtras(pinned, 'a').pinned).toBe(true)
    expect(getExtras(pinned, 'b').pinned).toBe(false)
    expect(map['a']).toBeUndefined() // pure: the input map is not mutated
    expect(getExtras(unpinConversation(pinned, 'a'), 'a').pinned).toBe(false)
  })

  it('archives and unarchives', () => {
    const archived = archiveConversation({}, 'a')
    expect(getExtras(archived, 'a').archived).toBe(true)
    expect(getExtras(unarchiveConversation(archived, 'a'), 'a').archived).toBe(false)
  })

  it('defaults to unpinned, unarchived, no per-chat model', () => {
    expect(getExtras({}, 'missing')).toEqual({ pinned: false, archived: false, model: null })
  })
})

describe('per-chat model', () => {
  it('accepts a model from the allowlist and trims it', () => {
    const result = setPerChatModel({}, 'a', '  gpt-5 ', ALLOW)
    expect(result.ok).toBe(true)
    if (result.ok) expect(getExtras(result.extras, 'a').model).toBe('gpt-5')
  })

  it('rejects an unknown model and leaves the map unchanged', () => {
    const before = pinConversation({}, 'a')
    const result = setPerChatModel(before, 'a', 'made-up-model', ALLOW)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/Unknown model/)
    expect(result.extras).toBe(before)
    expect(getExtras(result.extras, 'a').pinned).toBe(true)
  })

  it('rejects an empty model id and clears with null', () => {
    expect(setPerChatModel({}, 'a', '   ', ALLOW).ok).toBe(false)
    const set = setPerChatModel({}, 'a', 'gpt-5', ALLOW)
    expect(set.ok).toBe(true)
    if (set.ok) {
      const cleared = setPerChatModel(set.extras, 'a', null, ALLOW)
      expect(cleared.ok).toBe(true)
      if (cleared.ok) expect(getExtras(cleared.extras, 'a').model).toBeNull()
    }
  })
})

describe('ordering', () => {
  it('pinned first, then most recent, archived excluded from the main list', () => {
    const conversations = [conv('old', 100), conv('new', 300), conv('pinned-old', 50), conv('archived', 999)]
    const extras = archiveConversation(pinConversation({}, 'pinned-old'), 'archived')
    expect(orderConversations(conversations, extras).map((c) => c.id)).toEqual(['pinned-old', 'new', 'old'])
    expect(listArchivedConversations(conversations, extras).map((c) => c.id)).toEqual(['archived'])
  })

  it('falls back to createdAt when updatedAt is missing', () => {
    const conversations = [
      { id: 'a', title: 'a', messages: [], createdAt: 500 },
      { id: 'b', title: 'b', messages: [], createdAt: 100, updatedAt: 200 },
    ]
    expect(orderConversations(conversations, {}).map((c) => c.id)).toEqual(['a', 'b'])
  })
})

describe('feedback', () => {
  it('sets, toggles off on a repeat vote, and switches vote', () => {
    const voted = setFeedback({}, 'm1', 'up')
    expect(getFeedback(voted, 'm1')).toEqual({ messageId: 'm1', vote: 'up' })
    expect(getFeedback(toggleFeedback(voted, 'm1', 'up'), 'm1')).toBeUndefined()
    expect(getFeedback(toggleFeedback(voted, 'm1', 'down'), 'm1')?.vote).toBe('down')
  })

  it('a null vote clears the entry and a note is stored trimmed', () => {
    const withNote = setFeedback({}, 'm1', 'down', '  wrong file  ')
    expect(getFeedback(withNote, 'm1')?.note).toBe('wrong file')
    expect(getFeedback(setFeedback(withNote, 'm1', null), 'm1')).toBeUndefined()
    // A note without a vote is not feedback.
    expect(getFeedback(setFeedback({}, 'm2', null, 'note'), 'm2')).toBeUndefined()
  })
})

describe('editAndResend', () => {
  const messages: AppChatMessage[] = [
    msg('u1', 'user', 'first'),
    msg('a1', 'agent', 'reply 1'),
    msg('u2', 'user', 'second'),
    msg('a2', 'agent', 'reply 2'),
  ]

  it('replaces the user message, drops everything after it, returns resendFrom', () => {
    const result = editAndResend(messages, 'u1', 'first, rewritten')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.resendFrom).toBe(0)
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0]).toMatchObject({ id: 'u1', content: 'first, rewritten', role: 'user' })
    }
    expect(messages).toHaveLength(4) // input untouched
  })

  it('keeps earlier messages when editing a later user message', () => {
    const result = editAndResend(messages, 'u2', 'second, rewritten')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.resendFrom).toBe(2)
      expect(result.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2'])
    }
  })

  it('rejects agent messages, unknown ids and empty text, returning the list unchanged', () => {
    for (const [id, text] of [['a1', 'x'], ['nope', 'x'], ['u1', '   ']] as const) {
      const result = editAndResend(messages, id, text)
      expect(result.ok).toBe(false)
      expect(result.resendFrom).toBe(-1)
      expect(result.messages).toHaveLength(4)
    }
  })
})
