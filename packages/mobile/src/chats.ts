// Saved agent chats. The drawer lists them; tapping one reopens it.
// Chats live only on this phone, in browser storage. The first version of
// the app kept a single chat under `sketch.mobile.chat.v1` — loading migrates
// that chat into the list once, then drops the old key.

import type { ChatTurn } from './agent'
import { newId } from './store'

export interface SavedChat {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  turns: ChatTurn[]
}

export const CHATS_KEY = 'sketch.mobile.chats.v1'
export const LEGACY_CHAT_KEY = 'sketch.mobile.chat.v1'

export function chatTitle(turns: readonly ChatTurn[]): string {
  const first = turns.find((t) => t.role === 'user')
  if (first === undefined) return 'New chat'
  const clean = first.content.trim().replace(/\s+/g, ' ')
  if (clean === '') return 'New chat'
  return clean.length > 42 ? `${clean.slice(0, 42)}…` : clean
}

export function newChat(now = Date.now()): SavedChat {
  return { id: newId(), title: 'New chat', createdAt: now, updatedAt: now, turns: [] }
}

function isChat(value: unknown): value is SavedChat {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as SavedChat).id === 'string' &&
    typeof (value as SavedChat).title === 'string' &&
    Array.isArray((value as SavedChat).turns)
  )
}

export function loadChats(storage: Storage = localStorage): SavedChat[] {
  try {
    const raw = storage.getItem(CHATS_KEY)
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        const chats = parsed.filter(isChat).map((c) => ({
          ...c,
          createdAt: typeof c.createdAt === 'number' ? c.createdAt : Date.now(),
          updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : Date.now(),
          turns: c.turns.filter((t) => t && typeof t.content === 'string' && (t.role === 'user' || t.role === 'assistant')),
        }))
        return chats
      }
    }
    // One-time migration from the single-chat storage of v1.0.
    const legacyRaw = storage.getItem(LEGACY_CHAT_KEY)
    if (legacyRaw !== null) {
      const parsed: unknown = JSON.parse(legacyRaw)
      if (Array.isArray(parsed) && parsed.length > 0) {
        const turns = parsed.filter(
          (t): t is ChatTurn => !!t && typeof t.content === 'string' && (t.role === 'user' || t.role === 'assistant'),
        )
        if (turns.length > 0) {
          const chat: SavedChat = {
            id: newId(),
            title: chatTitle(turns),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            turns,
          }
          storage.setItem(CHATS_KEY, JSON.stringify([chat]))
          storage.removeItem(LEGACY_CHAT_KEY)
          return [chat]
        }
      }
      storage.removeItem(LEGACY_CHAT_KEY)
    }
    return []
  } catch {
    return []
  }
}

export function saveChats(chats: readonly SavedChat[], storage: Storage = localStorage): void {
  try {
    storage.setItem(CHATS_KEY, JSON.stringify(chats))
  } catch {
    // Storage unavailable: chats last for this session only.
  }
}

/** Replace one chat in the list (or add it), newest first. */
export function upsertChat(chats: readonly SavedChat[], chat: SavedChat): SavedChat[] {
  const rest = chats.filter((c) => c.id !== chat.id)
  return [chat, ...rest]
}
