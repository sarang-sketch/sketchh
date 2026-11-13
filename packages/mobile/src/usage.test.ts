import { describe, expect, it } from 'vitest'

import { clearUsage, loadUsage, recordUsage, todayKey, USAGE_KEY } from './usage'

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

const monday = new Date(2026, 10, 9, 10, 0, 0)
const tuesday = new Date(2026, 10, 10, 10, 0, 0)

describe('daily usage', () => {
  it('keys usage by local date', () => {
    expect(todayKey(monday)).toBe('2026-11-09')
  })

  it('accumulates tokens, calls and chats within a day', () => {
    const storage = memoryStorage()
    expect(loadUsage(storage, monday)).toEqual({ date: '2026-11-09', tokens: 0, calls: 0, chats: 0 })
    const after = recordUsage({ tokens: 1200, calls: 1, chats: 1 }, storage, monday)
    expect(after).toEqual({ date: '2026-11-09', tokens: 1200, calls: 1, chats: 1 })
    expect(recordUsage({ tokens: 300, calls: 1 }, storage, monday)).toEqual({
      date: '2026-11-09',
      tokens: 1500,
      calls: 2,
      chats: 1,
    })
  })

  it('resets at local midnight instead of carrying yesterday over', () => {
    const storage = memoryStorage()
    recordUsage({ tokens: 500, calls: 1, chats: 1 }, storage, monday)
    expect(loadUsage(storage, tuesday)).toEqual({ date: '2026-11-10', tokens: 0, calls: 0, chats: 0 })
  })

  it('clears the stored record', () => {
    const storage = memoryStorage()
    recordUsage({ tokens: 10 }, storage, monday)
    clearUsage(storage)
    expect(storage.getItem(USAGE_KEY)).toBeNull()
  })
})
