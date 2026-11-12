// Fuzzy matching for Quick Open, `@` file mentions and the command palette.
//
// The behaviour people expect from every editor's Ctrl+P: the query's characters must
// appear in order, matches at the start of a word or path segment count for more,
// consecutive matches count for more, and a hit in the FILE NAME beats the same hit in
// a directory name. Pure and dependency-free so it is testable and costs nothing.

/** Can `q[qi…]` (spaces ignored) still be matched in order within `t[from…]`? */
function restMatches(q: string, qi: number, t: string, from: number): boolean {
  let j = from
  for (let i = qi; i < q.length; i++) {
    const ch = q[i]!
    if (ch === ' ') continue
    j = t.indexOf(ch, j)
    if (j < 0) return false
    j++
  }
  return true
}

/** Higher is better; null when `query` is not a subsequence of `target`. */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.trim().toLowerCase().replace(/\\/g, '/')
  if (q === '') return 0
  const t = target.toLowerCase()
  const nameStart = target.replace(/\\/g, '/').lastIndexOf('/') + 1
  if (!restMatches(q, 0, t, 0)) return null

  let score = 0
  let ti = 0
  let previous = -2
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!
    if (ch === ' ') continue
    let found = -1
    if (previous >= 0 && t[previous + 1] === ch && restMatches(q, qi + 1, t, previous + 2)) {
      // A run of consecutive characters is the strongest signal; keep it going.
      found = previous + 1
    } else {
      // Otherwise prefer a word/segment boundary — but only one after which the rest
      // of the query can still be matched, or a far boundary would strand it.
      for (let k = ti; k < t.length; k++) {
        if (t[k] !== ch) continue
        if (!restMatches(q, qi + 1, t, k + 1)) break
        if (found < 0) found = k
        if (isBoundary(target, k)) {
          found = k
          break
        }
      }
    }
    if (found < 0) return null
    score += 1
    if (found === previous + 1) score += 4
    if (isBoundary(target, found)) score += 6
    if (found >= nameStart) score += 2
    previous = found
    ti = found + 1
  }
  // Shorter targets and an exact name win ties.
  score -= Math.min(20, target.length / 12)
  const name = target.slice(nameStart).toLowerCase()
  if (name === q || name.startsWith(q)) score += 15
  return score
}

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true
  const prev = text[index - 1]!
  const ch = text[index]!
  if ('/\\-_. :'.includes(prev)) return true
  return prev === prev.toLowerCase() && ch !== ch.toLowerCase()
}

/** The best `limit` matches, best first. Stable for equal scores. */
export function fuzzyFilter<T>(items: readonly T[], query: string, key: (item: T) => string, limit = 50): T[] {
  if (query.trim() === '') return items.slice(0, limit)
  const scored: Array<{ item: T; score: number; index: number }> = []
  items.forEach((item, index) => {
    const score = fuzzyScore(query, key(item))
    if (score !== null) scored.push({ item, score, index })
  })
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return scored.slice(0, limit).map((entry) => entry.item)
}
