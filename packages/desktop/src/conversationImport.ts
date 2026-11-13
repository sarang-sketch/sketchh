// Import a conversation from a JSON file — the counterpart of "Download as JSON".
//
// The format is the one the sidebar writes: `{ app: 'sketch', version: 1,
// title, createdAt, updatedAt, root?, messages: [{ role, content, timestamp? }] }`.
// Anything else is rejected with a plain reason, never half-imported: a file a
// person edited by hand, or one from another app, must not silently become a
// conversation with the wrong messages. Imported messages keep only role, content
// and timestamp — run receipts, file states and steps are re-derived by new runs,
// not trusted from a file.

import type { ChatMessage, Conversation } from './state/AppState'

const ROLES: readonly ChatMessage['role'][] = ['user', 'agent', 'system']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse an imported conversation, or return why it cannot be imported. */
export function parseImportedConversation(
  value: unknown,
): { ok: true; conversation: Conversation } | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: 'That file is not a Sketch conversation export.' }
  if (value.app !== undefined && value.app !== 'sketch') {
    return { ok: false, reason: 'That file is not a Sketch conversation export.' }
  }
  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    return { ok: false, reason: 'That file has no messages to import.' }
  }
  const messages: ChatMessage[] = []
  for (const raw of value.messages) {
    if (!isRecord(raw) || !ROLES.includes(raw.role as ChatMessage['role']) || typeof raw.content !== 'string') {
      return { ok: false, reason: 'That file has a message without a valid role and text, so it was not imported.' }
    }
    const timestamp = typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp) ? raw.timestamp : Date.now()
    messages.push({ id: `imported-${messages.length}-${timestamp}`, role: raw.role as ChatMessage['role'], content: raw.content, timestamp })
  }
  const title = typeof value.title === 'string' && value.title.trim() !== '' ? value.title.trim().slice(0, 120) : 'Imported chat'
  const now = Date.now()
  return {
    ok: true,
    conversation: {
      id: `conv-import-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      messages: messages.slice(-200),
      createdAt: typeof value.createdAt === 'number' ? value.createdAt : now,
      updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : now,
      root: typeof value.root === 'string' ? value.root : null,
    },
  }
}

/** The JSON text the sidebar writes for a conversation, so export and import agree. */
export function conversationToJson(conversation: Conversation): string {
  return JSON.stringify(
    {
      app: 'sketch',
      version: 1,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      root: conversation.root ?? null,
      messages: conversation.messages.map((m) => ({ role: m.role, content: m.content, timestamp: m.timestamp })),
    },
    null,
    2,
  )
}
