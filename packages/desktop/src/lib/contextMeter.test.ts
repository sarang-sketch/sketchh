import { describe, expect, it } from 'vitest'

import { contextSummary, estimateTokens, formatContextSummary } from './contextMeter'
import type { ChatMessage } from '../state/AppState'

const messages: ChatMessage[] = [
  { id: 'm1', role: 'user', content: 'hello there', timestamp: 1 },
  { id: 'm2', role: 'agent', content: 'hi', timestamp: 2 },
  { id: 'm3', role: 'system', content: 'a note', timestamp: 3 },
]

describe('context meter', () => {
  it('estimates ~1 token per 4 characters', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('counts turns, not system notes, and caps kept turns', () => {
    const summary = contextSummary(messages, 12)
    expect(summary.turns).toBe(2)
    expect(summary.estimatedTokens).toBe(estimateTokens('hello there') + estimateTokens('hi'))
    expect(summary.keptTurns).toBe(2)
    expect(contextSummary(messages, 1).keptTurns).toBe(1)
  })

  it('formats the one-line meter', () => {
    expect(formatContextSummary({ turns: 8, estimatedTokens: 3200, keptTurns: 8 })).toBe(
      'Context ≈ 3.2k tokens · 8 turns · last 8 sent',
    )
    expect(formatContextSummary({ turns: 1, estimatedTokens: 12, keptTurns: 1 })).toBe(
      'Context ≈ 12 tokens · 1 turn · last 1 sent',
    )
  })
})
