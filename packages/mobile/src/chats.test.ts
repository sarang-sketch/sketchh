import { describe, expect, it } from 'vitest'

import { chatTitle, loadChats, newChat, saveChats, upsertChat, CHATS_KEY, LEGACY_CHAT_KEY, type SavedChat } from './chats'
import type { ChatTurn } from './agent'

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key)
    },
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
  }
}

const turns: ChatTurn[] = [
  { role: 'user', content: 'How do I sort this list in app.js?' },
  { role: 'assistant', content: 'Use Array.sort.' },
]

describe('saved chats', () => {
  it('titles a chat from its first user message', () => {
    expect(chatTitle(turns)).toBe('How do I sort this list in app.js?')
    expect(chatTitle([])).toBe('New chat')
    expect(chatTitle([{ role: 'user', content: 'x'.repeat(100) }])).toBe(`${'x'.repeat(42)}…`)
  })

  it('round-trips through storage, newest first on upsert', () => {
    const storage = memoryStorage()
    const a = newChat(1000)
    const b = newChat(2000)
    const list = upsertChat(upsertChat([], a), b)
    expect(list[0]).toBe(b)
    saveChats(list, storage)
    const loaded = loadChats(storage)
    expect(loaded).toHaveLength(2)
    expect(loaded[0]!.id).toBe(b.id)
  })

  it('migrates the old single chat once and drops the legacy key', () => {
    const storage = memoryStorage()
    storage.setItem(LEGACY_CHAT_KEY, JSON.stringify(turns))
    const loaded = loadChats(storage)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.title).toBe('How do I sort this list in app.js?')
    expect(loaded[0]!.turns).toEqual(turns)
    expect(storage.getItem(LEGACY_CHAT_KEY)).toBeNull()
    expect(storage.getItem(CHATS_KEY)).not.toBeNull()
    // Second load reads the migrated list, not the legacy key.
    expect(loadChats(storage)).toHaveLength(1)
  })

  it('returns an empty list for corrupt storage', () => {
    const storage = memoryStorage()
    storage.setItem(CHATS_KEY, 'not json')
    expect(loadChats(storage)).toEqual([])
  })

  it('keeps an updated chat at the top', () => {
    const a: SavedChat = { ...newChat(1000), turns }
    const b: SavedChat = { ...newChat(2000), turns: [] }
    const updated: SavedChat = { ...a, title: 'Renamed', updatedAt: 3000 }
    expect(upsertChat([a, b], updated)[0]).toBe(updated)
  })
})
