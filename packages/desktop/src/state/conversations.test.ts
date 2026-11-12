// Conversation RENAME: the reducer rule, and that a renamed title survives a reload.
//
// W6 invariant 6 ("rename") needs a way to change a conversation's title, which is state
// the chat panel does not own, so one additive reducer case was added with the lead's
// approval. These tests pin its rule (trim, cap, empty-keeps-old, unknown no-op,
// single-conversation) and prove the new title persists across a save/restore round-trip —
// the "persist across a reload" bar.

import { beforeEach, describe, expect, it } from 'vitest'

import {
  appReducer,
  initialAppState,
  loadPersistedState,
  savePersistedState,
  MAX_CONVERSATION_TITLE,
  type AppState,
  type Conversation,
} from './AppState'

function convo(id: string, title: string): Conversation {
  return { id, title, messages: [], createdAt: 1, updatedAt: 1, root: 'C:/ws' }
}

function withConversations(conversations: Conversation[]): AppState {
  return { ...initialAppState, conversations }
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('RENAME_CONVERSATION reducer', () => {
  it('renames exactly the named conversation and leaves the others alone', () => {
    const state = withConversations([convo('a', 'First'), convo('b', 'Second')])
    const next = appReducer(state, { type: 'RENAME_CONVERSATION', payload: { id: 'b', title: 'Renamed' } })
    expect(next.conversations.find((c) => c.id === 'b')!.title).toBe('Renamed')
    expect(next.conversations.find((c) => c.id === 'a')!.title).toBe('First')
  })

  it('trims surrounding whitespace', () => {
    const state = withConversations([convo('a', 'Old')])
    const next = appReducer(state, { type: 'RENAME_CONVERSATION', payload: { id: 'a', title: '  Clean name  ' } })
    expect(next.conversations[0]!.title).toBe('Clean name')
  })

  it('keeps the old title when the new one is empty or whitespace', () => {
    const state = withConversations([convo('a', 'Keep me')])
    const next = appReducer(state, { type: 'RENAME_CONVERSATION', payload: { id: 'a', title: '   ' } })
    expect(next.conversations[0]!.title).toBe('Keep me')
    // Same reference back: nothing changed.
    expect(next).toBe(state)
  })

  it('caps the title length', () => {
    const state = withConversations([convo('a', 'Old')])
    const long = 'x'.repeat(MAX_CONVERSATION_TITLE + 50)
    const next = appReducer(state, { type: 'RENAME_CONVERSATION', payload: { id: 'a', title: long } })
    expect(next.conversations[0]!.title).toHaveLength(MAX_CONVERSATION_TITLE)
  })

  it('is a no-op for an unknown id', () => {
    const state = withConversations([convo('a', 'Only one')])
    const next = appReducer(state, { type: 'RENAME_CONVERSATION', payload: { id: 'nope', title: 'Nothing' } })
    expect(next).toBe(state)
  })
})

describe('a renamed conversation persists across a reload', () => {
  it('restores the new title from storage', () => {
    const state = withConversations([convo('a', 'Before')])
    const renamed = appReducer(state, { type: 'RENAME_CONVERSATION', payload: { id: 'a', title: 'After' } })
    savePersistedState(renamed)

    // A fresh read of storage — what a reopened app sees.
    const restored = loadPersistedState()
    expect(restored.conversations?.find((c) => c.id === 'a')?.title).toBe('After')
  })
})
