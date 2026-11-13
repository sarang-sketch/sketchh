// Daily briefing panel: a dated summary of what actually happened — runs,
// costs, tasks, conversations — grouped by kind. Props-driven and honest:
// with no items it says so instead of inventing a day.

import { BRIEFING_KIND_LABELS, BRIEFING_KIND_ORDER, type BriefingItem, type BriefingKind } from './dailyBriefing'

export const DAILY_BRIEFING_EMPTY = 'Nothing to brief — no runs, costs or tasks recorded for this day'

export interface DailyBriefingProps {
  /** The day being briefed, e.g. '2026-11-13'. Shown as given. */
  date: string
  items: BriefingItem[]
  /** Re-fetch the day's events. Optional: the panel works read-only without it. */
  onRefresh?: () => void
}

export function DailyBriefing({ date, items, onRefresh }: DailyBriefingProps) {
  const groups = BRIEFING_KIND_ORDER.map((kind) => ({
    kind,
    items: items.filter((item) => item.kind === kind),
  })).filter((group) => group.items.length > 0)

  return (
    <div data-testid="daily-briefing">
      <h2>Daily briefing — {date}</h2>
      {onRefresh !== undefined && (
        <button type="button" onClick={onRefresh}>Refresh</button>
      )}
      {items.length === 0 ? (
        <p>{DAILY_BRIEFING_EMPTY}</p>
      ) : (
        groups.map(({ kind, items: groupItems }) => (
          <section key={kind} aria-label={BRIEFING_KIND_LABELS[kind as BriefingKind]}>
            <h3>{BRIEFING_KIND_LABELS[kind as BriefingKind]}</h3>
            <ul>
              {groupItems.map((item, index) => (
                <li key={`${item.kind}-${item.title}-${index}`}>
                  {item.href !== undefined ? (
                    <a href={item.href}>{item.title}</a>
                  ) : (
                    <span>{item.title}</span>
                  )}
                  {item.detail !== '' && <span> — {item.detail}</span>}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  )
}

export default DailyBriefing
