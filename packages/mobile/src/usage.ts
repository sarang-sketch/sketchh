// Real daily usage, counted on this phone only. There is no cloud quota and
// no subscription here, so nothing is faked: the drawer shows the tokens and
// requests actually sent to the user's own configured provider today, and
// the counts reset at local midnight.

export interface DayUsage {
  /** Local date, YYYY-MM-DD. */
  date: string
  tokens: number
  calls: number
  chats: number
}

export const USAGE_KEY = 'sketch.mobile.usage.v1'

export function todayKey(date = new Date()): string {
  const y = date.getFullYear()
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function loadUsage(storage: Storage = localStorage, date = new Date()): DayUsage {
  const today = todayKey(date)
  try {
    const raw = storage.getItem(USAGE_KEY)
    if (raw === null) return { date: today, tokens: 0, calls: 0, chats: 0 }
    const parsed = JSON.parse(raw) as Partial<DayUsage>
    if (parsed.date !== today) return { date: today, tokens: 0, calls: 0, chats: 0 }
    return {
      date: today,
      tokens: typeof parsed.tokens === 'number' ? parsed.tokens : 0,
      calls: typeof parsed.calls === 'number' ? parsed.calls : 0,
      chats: typeof parsed.chats === 'number' ? parsed.chats : 0,
    }
  } catch {
    return { date: today, tokens: 0, calls: 0, chats: 0 }
  }
}

export function recordUsage(
  patch: Partial<Pick<DayUsage, 'tokens' | 'calls' | 'chats'>>,
  storage: Storage = localStorage,
  date = new Date(),
): DayUsage {
  const current = loadUsage(storage, date)
  const next: DayUsage = {
    date: current.date,
    tokens: current.tokens + (patch.tokens ?? 0),
    calls: current.calls + (patch.calls ?? 0),
    chats: current.chats + (patch.chats ?? 0),
  }
  try {
    storage.setItem(USAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage unavailable: usage lasts for this session only.
  }
  return next
}

export function clearUsage(storage: Storage = localStorage): void {
  try {
    storage.removeItem(USAGE_KEY)
  } catch {
    // Nothing to clear.
  }
}
