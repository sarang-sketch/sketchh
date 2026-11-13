// DailyBriefing: grouped rendering, the empty state, and the pure
// buildBriefing grouping/sorting/dedupe/cap.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DailyBriefing, DAILY_BRIEFING_EMPTY } from './DailyBriefing'
import { buildBriefing, MAX_BRIEFING_ITEMS, type BriefingEvent } from './dailyBriefing'

afterEach(cleanup)

describe('buildBriefing (pure)', () => {
  it('groups by kind in run/cost/task/conversation order, most recent first', () => {
    const events: BriefingEvent[] = [
      { kind: 'task', title: 'Fix tests', detail: 'done', at: 100 },
      { kind: 'run', title: 'vitest run', detail: 'passed', at: 300 },
      { kind: 'run', title: 'typecheck', detail: 'passed', at: 200 },
      { kind: 'cost', title: '$0.42 spent', detail: 'gpt-5', at: 150 },
    ]
    const items = buildBriefing(events)
    expect(items.map((i) => i.title)).toEqual(['vitest run', 'typecheck', '$0.42 spent', 'Fix tests'])
  })

  it('dedupes by title+kind keeping the newest, and drops empty titles and unknown kinds', () => {
    const events = [
      { kind: 'run', title: 'vitest run', detail: 'old', at: 100 },
      { kind: 'run', title: 'Vitest Run', detail: 'new', at: 200 },
      { kind: 'task', title: 'vitest run', detail: 'different kind, kept', at: 300 },
      { kind: 'run', title: '   ', detail: 'no title', at: 400 },
      { kind: 'mystery', title: 'x', detail: 'unknown kind', at: 500 },
    ] as unknown as BriefingEvent[]
    const items = buildBriefing(events)
    expect(items.map((i) => `${i.kind}:${i.title}:${i.detail}`)).toEqual([
      'run:Vitest Run:new',
      'task:vitest run:different kind, kept',
    ])
  })

  it('caps at 50 items and accepts ISO date strings', () => {
    const events: BriefingEvent[] = Array.from({ length: 60 }, (_, i) => ({
      kind: 'task' as const,
      title: `Task ${i}`,
      detail: '',
      at: `2026-11-13T00:${String(i % 60).padStart(2, '0')}:00Z`,
    }))
    expect(buildBriefing(events)).toHaveLength(MAX_BRIEFING_ITEMS)
    expect(buildBriefing([])).toEqual([])
  })
})

describe('DailyBriefing panel', () => {
  it('shows the empty state — no fake data — when there is nothing to brief', () => {
    render(<DailyBriefing date="2026-11-13" items={[]} />)
    expect(screen.getByText('Daily briefing — 2026-11-13')).toBeTruthy()
    expect(screen.getByText(DAILY_BRIEFING_EMPTY)).toBeTruthy()
  })

  it('renders items grouped by kind, with links when an href is given', () => {
    const onRefresh = vi.fn()
    render(
      <DailyBriefing
        date="2026-11-13"
        onRefresh={onRefresh}
        items={[
          { kind: 'conversation', title: 'Sketchh polish', detail: '3 messages' },
          { kind: 'run', title: 'vitest run', detail: 'passed', href: '/runs/1' },
        ]}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Runs' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Conversations' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'vitest run' }).getAttribute('href')).toBe('/runs/1')
    expect(screen.getByText('Sketchh polish')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })
})
