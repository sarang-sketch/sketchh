// Per-conversation extras: pin/archive, a per-chat model, thumbs feedback,
// and edit-and-resend. Pure functions only — no React, no localStorage, no
// AppState import. The coordinator owns persistence (AppState + storage);
// these functions only compute the next value, so they are testable in
// isolation and cannot half-apply a change.
//
// What is NOT here, deliberately: the agent re-run after edit-and-resend.
// `editAndResend` returns `resendFrom` and the truncated message list; the
// caller (AgentChat / the run pipeline) must start a new run from there.
// Nothing in this file claims that run happened.

import type { ChatMessage, Conversation } from './AppState'

/** Extra state for one conversation, keyed by conversation id. */
export interface ConversationExtras {
  pinned: boolean
  archived: boolean
  /** Per-chat model id, or null when the conversation uses the global model. */
  model?: string | null
}

export type ConversationExtrasMap = Record<string, ConversationExtras>

/** Feedback on one agent message. A `null` vote means "no feedback". */
export type FeedbackVote = 'up' | 'down' | null

export interface FeedbackEntry {
  messageId: string
  vote: Exclude<FeedbackVote, null>
  /** Optional free-text note attached to the vote. */
  note?: string
}

export type FeedbackStore = Record<string, FeedbackEntry>

export const DEFAULT_EXTRAS: ConversationExtras = { pinned: false, archived: false, model: null }

export function getExtras(map: ConversationExtrasMap, id: string): ConversationExtras {
  return map[id] ?? DEFAULT_EXTRAS
}

function update(map: ConversationExtrasMap, id: string, patch: Partial<ConversationExtras>): ConversationExtrasMap {
  return { ...map, [id]: { ...getExtras(map, id), ...patch } }
}

export function pinConversation(map: ConversationExtrasMap, id: string): ConversationExtrasMap {
  return update(map, id, { pinned: true })
}

export function unpinConversation(map: ConversationExtrasMap, id: string): ConversationExtrasMap {
  return update(map, id, { pinned: false })
}

export function archiveConversation(map: ConversationExtrasMap, id: string): ConversationExtrasMap {
  return update(map, id, { archived: true })
}

export function unarchiveConversation(map: ConversationExtrasMap, id: string): ConversationExtrasMap {
  return update(map, id, { archived: false })
}

export type SetModelResult =
  | { ok: true; extras: ConversationExtrasMap }
  | { ok: false; reason: string; extras: ConversationExtrasMap }

/**
 * Set (or clear, with `null`) the model for one conversation. The model must
 * be in `allowlist` — an unknown id is rejected and the map is returned
 * unchanged, so a stale or mistyped model can never be silently stored.
 * Pass an empty allowlist only when no model is selectable at all.
 */
export function setPerChatModel(
  map: ConversationExtrasMap,
  id: string,
  model: string | null,
  allowlist: readonly string[],
): SetModelResult {
  if (model === null) return { ok: true, extras: update(map, id, { model: null }) }
  const trimmed = model.trim()
  if (trimmed === '') return { ok: false, reason: 'Model id must not be empty.', extras: map }
  if (!allowlist.includes(trimmed)) {
    return { ok: false, reason: `Unknown model "${trimmed}": not in the configured model list.`, extras: map }
  }
  return { ok: true, extras: update(map, id, { model: trimmed }) }
}

type Orderable = Pick<Conversation, 'id' | 'createdAt'> & { updatedAt?: number }

function lastActivity(c: Orderable): number {
  return c.updatedAt ?? c.createdAt
}

/**
 * The main conversation list: archived conversations excluded, pinned first,
 * then most recently active. Ties break by id so the order is deterministic.
 */
export function orderConversations<T extends Orderable>(conversations: readonly T[], extras: ConversationExtrasMap): T[] {
  return [...conversations]
    .filter((c) => !getExtras(extras, c.id).archived)
    .sort((a, b) => {
      const aPinned = getExtras(extras, a.id).pinned
      const bPinned = getExtras(extras, b.id).pinned
      if (aPinned !== bPinned) return aPinned ? -1 : 1
      const byTime = lastActivity(b) - lastActivity(a)
      if (byTime !== 0) return byTime
      return a.id.localeCompare(b.id)
    })
}

/** Archived conversations only, most recently active first. */
export function listArchivedConversations<T extends Orderable>(
  conversations: readonly T[],
  extras: ConversationExtrasMap,
): T[] {
  return [...conversations]
    .filter((c) => getExtras(extras, c.id).archived)
    .sort((a, b) => lastActivity(b) - lastActivity(a) || a.id.localeCompare(b.id))
}

/**
 * Record feedback. A `null` vote clears the entry (same as never having
 * voted). A note without a vote is ignored — a note alone is not feedback.
 */
export function setFeedback(
  store: FeedbackStore,
  messageId: string,
  vote: FeedbackVote,
  note?: string,
): FeedbackStore {
  if (vote === null) {
    const next = { ...store }
    delete next[messageId]
    return next
  }
  const entry: FeedbackEntry = { messageId, vote }
  if (note !== undefined && note.trim() !== '') entry.note = note.trim()
  return { ...store, [messageId]: entry }
}

/** Toggle: voting the same way again clears the vote; voting the other way switches it. */
export function toggleFeedback(store: FeedbackStore, messageId: string, vote: Exclude<FeedbackVote, null>): FeedbackStore {
  return store[messageId]?.vote === vote ? setFeedback(store, messageId, null) : setFeedback(store, messageId, vote)
}

export function getFeedback(store: FeedbackStore, messageId: string): FeedbackEntry | undefined {
  return store[messageId]
}

export type EditAndResendResult =
  | { ok: true; messages: ChatMessage[]; resendFrom: number }
  | { ok: false; reason: string; messages: ChatMessage[]; resendFrom: -1 }

/**
 * Edit a user message and prepare a re-run: the message's text is replaced
 * (same id, same timestamp) and every message after it is dropped, because
 * the agent's replies below it answered the old text. `resendFrom` is the
 * index the agent must re-run from. The re-run itself is NOT done here —
 * the caller must start it. Only a `user` message can be edited; editing an
 * agent message, an unknown id, or an empty replacement is rejected and the
 * list is returned unchanged.
 */
export function editAndResend(
  messages: readonly ChatMessage[],
  messageId: string,
  newText: string,
): EditAndResendResult {
  const trimmed = newText.trim()
  if (trimmed === '') return { ok: false, reason: 'The replacement text must not be empty.', messages: [...messages], resendFrom: -1 }
  const index = messages.findIndex((m) => m.id === messageId)
  if (index === -1) return { ok: false, reason: `No message with id "${messageId}".`, messages: [...messages], resendFrom: -1 }
  const target = messages[index]!
  if (target.role !== 'user') {
    return { ok: false, reason: 'Only a user message can be edited and resent.', messages: [...messages], resendFrom: -1 }
  }
  const next = [...messages.slice(0, index), { ...target, content: trimmed }]
  return { ok: true, messages: next, resendFrom: index }
}
