// Daily briefing: pure grouping of the day's events. No fake data — the
// caller supplies the events (runs, costs, tasks, conversations it actually
// recorded); an empty input briefs to an empty list and the panel shows its
// empty state.

export type BriefingKind = 'run' | 'cost' | 'task' | 'conversation'

export interface BriefingEvent {
  kind: BriefingKind
  title: string
  detail: string
  /** When it happened: epoch ms, or an ISO date string. */
  at: number | string
}

export interface BriefingItem {
  kind: BriefingKind
  title: string
  detail: string
  /** Where the item leads, when the caller knows one. */
  href?: string
}

export const MAX_BRIEFING_ITEMS = 50

export const BRIEFING_KIND_ORDER: readonly BriefingKind[] = ['run', 'cost', 'task', 'conversation']

export const BRIEFING_KIND_LABELS: Record<BriefingKind, string> = {
  run: 'Runs',
  cost: 'Costs',
  task: 'Tasks',
  conversation: 'Conversations',
}

function timeOf(at: number | string): number {
  if (typeof at === 'number') return Number.isFinite(at) ? at : 0
  const parsed = Date.parse(at)
  return Number.isNaN(parsed) ? 0 : parsed
}

function isBriefingKind(kind: unknown): kind is BriefingKind {
  return kind === 'run' || kind === 'cost' || kind === 'task' || kind === 'conversation'
}

/**
 * Group the day's events by kind (runs, costs, tasks, conversations), most
 * recent first within each group, deduped by title+kind (the newest copy
 * wins), capped at 50 items total. Events with an empty title or an unknown
 * kind are dropped — a briefing must not show a row it cannot name.
 */
export function buildBriefing(events: readonly BriefingEvent[]): BriefingItem[] {
  const seen = new Set<string>()
  const items: Array<BriefingItem & { at: number }> = []
  const sorted = [...events].sort((a, b) => timeOf(b.at) - timeOf(a.at))
  for (const event of sorted) {
    if (!isBriefingKind(event.kind)) continue
    const title = event.title.trim()
    if (title === '') continue
    const key = `${event.kind}\n${title.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({ kind: event.kind, title, detail: event.detail, at: timeOf(event.at) })
  }
  // Groups in kind order, most recent first inside each group; cap at 50.
  const grouped = BRIEFING_KIND_ORDER.flatMap((kind) =>
    items.filter((item) => item.kind === kind).sort((a, b) => b.at - a.at),
  )
  return grouped.slice(0, MAX_BRIEFING_ITEMS).map(({ kind, title, detail }) => ({ kind, title, detail }))
}
