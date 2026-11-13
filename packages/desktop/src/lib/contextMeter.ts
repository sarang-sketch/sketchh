// The context meter: how much of this conversation a run actually sees.
//
// The numbers are estimates, and they say so: tokens are ~1 per 4 characters of
// message text, the same rough rule the fake provider uses. Only the last 12
// turns reach the model in Normal speed, 6 in Turbo — older turns are still in
// the transcript, they just are not sent. No provider call is made to measure
// this; it is arithmetic over the messages already in state.

import type { ChatMessage } from '../state/AppState'

/** Rough token count for a stretch of text: ~1 token per 4 characters. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export interface ContextSummary {
  /** User + agent turns in the conversation (system notes excluded). */
  turns: number
  /** Estimated tokens across the whole conversation. */
  estimatedTokens: number
  /** Turns the next run will actually be sent. */
  keptTurns: number
}

export function contextSummary(messages: readonly ChatMessage[], maxTurns: number): ContextSummary {
  const turns = messages.filter((m) => m.role === 'user' || m.role === 'agent')
  const estimatedTokens = turns.reduce((sum, m) => sum + estimateTokens(m.content), 0)
  return { turns: turns.length, estimatedTokens, keptTurns: Math.min(turns.length, maxTurns) }
}

/** "≈ 3.2k tokens · 8 turns · last 12 sent" — the one-line meter text. */
export function formatContextSummary(summary: ContextSummary): string {
  const tokens = summary.estimatedTokens >= 1000 ? `${(summary.estimatedTokens / 1000).toFixed(1)}k` : `${summary.estimatedTokens}`
  return `Context ≈ ${tokens} tokens · ${summary.turns} turn${summary.turns === 1 ? '' : 's'} · last ${summary.keptTurns} sent`
}
