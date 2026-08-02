// Retrieving memory: the Phase 5 primitives, plus a recency prior.
//
// ── WHY THIS IS NOT A SECOND RETRIEVER ─────────────────────────────────────
//
// Requirement 21.5 says to reuse the Phase 5 hybrid path. `hybridSearch` itself cannot be
// reused directly — it is bound to a `RepoGraph` and reads files from disk, and memory
// entries are rows, not files. Writing memory out as files to make it fit would be
// contorting the data to fit a function signature.
//
// So this reuses the PARTS that are corpus-agnostic and were exported for exactly this:
//
//   * `queryTerms` — identifier-aware term extraction with the shared stopword list. One
//     definition of "what is this query asking about", not two that drift.
//   * `countMatches` / `smartCase` — the same per-term matching rules the code retriever
//     uses, so a query behaves the same way against memory as against source.
//   * `reciprocalRankFusion` — the same fusion, so the two channels here combine exactly
//     as the code retriever's channels do.
//   * `RRF_K`, `MAX_RERANK_BOOST` — the same constants.
//
// What is NOT reused is the vector channel. There are no embeddings for memory entries
// and pretending otherwise would mean a silent hash-vector channel contributing noise. The
// two channels here are TEXT and METADATA, and `channels` reports which ran.
//
// ── THE RECENCY PRIOR, AND WHY IT IS A PRIOR AND NOT A SORT ────────────────
//
// A newer memory is usually the right one, so recency has to count. But sorting by
// recency would make memory a stack, and the most useful entry is frequently an old
// architectural decision that explains everything — exactly what a recency sort buries.
//
// So recency is a bounded MULTIPLIER on the relevance score, capped at
// {@link MAX_RECENCY_BOOST}. A strongly matching old entry still beats a barely matching
// new one. `RECENCY_HALF_LIFE_MS` is the knob, it is stated in the result, and
// `recencyBoost` is exported so a test can pin the curve rather than infer it.
//
// ── SUPERSEDED ENTRIES ARE EXCLUDED BY DEFAULT ─────────────────────────────
//
// This is the load-bearing default in the file, and Requirement 21.6 is exactly about it:
// a query must return the newer entry while the older is marked superseded. Retrieving a
// closed entry into a prompt would put a fact the project has explicitly retracted in
// front of the model as current. `includeSuperseded` exists for the panel and for a
// history query, and when it is on, every hit carries `current: false` so a caller cannot
// mistake one for live.
//
// Validates: Requirements 21.5, 21.6

import type { EventInput } from '../events/store.js'
import {
  MAX_RERANK_BOOST,
  RRF_K,
  countMatches,
  fuseRankedIds,
  queryTerms,
  smartCase,
} from '../context/hybrid-search.js'
import { isCurrent, type MemoryEntry, type MemoryKind } from './entries.js'
import type { MemoryStore } from './store.js'

/** Default number of entries returned. */
export const DEFAULT_MEMORY_TOP_K = 8

/**
 * How long until recency's contribution halves. Two weeks.
 *
 * Short enough that this month's decisions outrank last quarter's, long enough that a
 * decision made in the spring is still reachable in the summer.
 */
export const RECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Ceiling on the recency multiplier.
 *
 * 0.5 means a brand-new entry scores at most 1.5× its relevance. Deliberately smaller
 * than {@link MAX_RERANK_BOOST}: recency is weaker evidence than actually matching the
 * question, and a larger cap would let "recent" beat "relevant", which is the failure
 * this whole design is arranged to avoid.
 */
export const MAX_RECENCY_BOOST = 0.5

/** Which channel found a candidate. */
export type MemoryChannel = 'text' | 'metadata'

export interface MemoryHit {
  entry: MemoryEntry
  /** Fused relevance before the recency prior. */
  relevance: number
  /** The multiplier recency applied, in `[1, 1 + MAX_RECENCY_BOOST]`. */
  recency: number
  /** `relevance * recency`. What the ordering uses. */
  score: number
  /** How many distinct query terms this entry matched. The first tiebreak. */
  termsMatched: number
  /** Channels that surfaced this entry. */
  channels: MemoryChannel[]
  /** False when the entry's window has closed. Only ever true unless asked otherwise. */
  current: boolean
}

export interface MemoryChannelReport {
  channel: MemoryChannel
  ran: boolean
  hits: number
  reason: string | null
}

export interface RetrieveMemoryOptions {
  store: MemoryStore
  query: string
  topK?: number
  /** Restrict to these kinds. Omitted searches all nine. */
  kinds?: readonly MemoryKind[]
  /** Restrict to one subject, e.g. a file path. */
  subject?: string
  /**
   * Include entries whose window has closed.
   *
   * OFF BY DEFAULT. See the header: a retracted fact presented as current is worse than
   * no memory at all. When on, hits carry `current: false`.
   */
  includeSuperseded?: boolean
  now?: number
  halfLifeMs?: number
  ignoreCase?: boolean
  events?: { emit(event: EventInput): Promise<void> | void }
  runId?: string
}

export interface RetrieveMemoryResult {
  hits: MemoryHit[]
  /** The terms the query was reduced to. Shown so a surface can explain a miss. */
  terms: string[]
  channels: MemoryChannelReport[]
  /** Entries considered before top-k. */
  candidates: number
  /** Entries excluded because their window had closed. */
  supersededExcluded: number
  halfLifeMs: number
}

/** The recency multiplier for an entry. Exported so a test can pin the curve. */
export function recencyBoost(
  ageMs: number,
  halfLifeMs: number = RECENCY_HALF_LIFE_MS,
  maxBoost: number = MAX_RECENCY_BOOST,
): number {
  // NaN gets NO boost. An age that cannot be computed is not evidence of freshness, and
  // the conservative direction is to let relevance decide alone.
  if (Number.isNaN(ageMs)) return 1
  // A future-dated entry (clock skew, or an imported `validFrom`) is capped at the full
  // boost rather than given more than it. Written as `<= 0` and not `!isFinite || <= 0`,
  // because that earlier spelling also caught `+Infinity` and handed an infinitely OLD
  // entry the maximum boost — backwards, and a test caught it.
  if (ageMs <= 0) return 1 + maxBoost
  if (ageMs === Number.POSITIVE_INFINITY) return 1
  // Exponential decay towards no boost at all.
  const decay = Math.pow(0.5, ageMs / Math.max(1, halfLifeMs))
  return 1 + maxBoost * decay
}

/**
 * Retrieve memory for a query.
 *
 * Emits `memory_retrieved` (Requirement 21.5) carrying the ids and scores but NOT the
 * entry text — the same discipline the loop's context breadcrumb follows. Memory text can
 * hold whatever a user wrote down, and the log is sanitised but not omniscient; a caller
 * that wants the text already has it in the return value.
 */
export async function retrieveMemory(
  options: RetrieveMemoryOptions,
): Promise<RetrieveMemoryResult> {
  const now = options.now ?? Date.now()
  const topK = Math.max(1, options.topK ?? DEFAULT_MEMORY_TOP_K)
  const halfLifeMs = options.halfLifeMs ?? RECENCY_HALF_LIFE_MS
  const terms = queryTerms(options.query)

  const all = await options.store.all()
  let supersededExcluded = 0
  const corpus = all.filter((entry) => {
    if (options.kinds !== undefined && !options.kinds.includes(entry.kind)) return false
    if (options.subject !== undefined && entry.subject !== options.subject) return false
    if (options.includeSuperseded !== true && !isCurrent(entry, now)) {
      supersededExcluded++
      return false
    }
    return true
  })

  const channels: MemoryChannelReport[] = []
  /** One ranking per channel, ids only — the shape the shared fusion takes. */
  const lists: Array<{ channel: MemoryChannel; ids: string[] }> = []
  const termsMatchedById = new Map<string, number>()
  const channelsById = new Map<string, MemoryChannel[]>()

  // ── the text channel ──────────────────────────────────────────────────────
  if (terms.length === 0) {
    channels.push({ channel: 'text', ran: false, hits: 0, reason: 'the query had no searchable term' })
  } else {
    const scored: Array<{ id: string; score: number }> = []
    for (const entry of corpus) {
      let score = 0
      let matched = 0
      for (const term of terms) {
        const ignoreCase = smartCase(term, options.ignoreCase)
        const { matches, exact } = countMatches(entry.text, term, ignoreCase)
        if (matches === 0) continue
        matched++
        // The same weighting the code retriever uses: an exact-word hit is worth three
        // substring hits.
        score += 3 * exact + (matches - exact)
      }
      if (matched === 0) continue
      termsMatchedById.set(entry.id, Math.max(termsMatchedById.get(entry.id) ?? 0, matched))
      addChannel(channelsById, entry.id, 'text')
      // Coverage first, exactly as `compareHits` does it: matching three of the question's
      // terms once each beats matching one of them twelve times.
      scored.push({ id: entry.id, score: matched * 1000 + score })
    }
    // Sorted by score, id ascending for a total order — so the ranking a channel hands
    // to fusion never depends on the order the store returned its rows in.
    scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    lists.push({ channel: 'text', ids: scored.map((item) => item.id) })
    channels.push({ channel: 'text', ran: true, hits: scored.length, reason: null })
  }

  // ── the metadata channel ──────────────────────────────────────────────────
  //
  // Key, subject and tags are what a person actually searches memory by — "the decision
  // about auth", "the standard for test-location" — and they are short, so a match in one
  // is far stronger evidence than the same match buried in prose. A separate channel
  // rather than a bonus inside the text channel, so fusion can see the agreement between
  // them and `channels` can report each independently.
  if (terms.length === 0) {
    channels.push({
      channel: 'metadata',
      ran: false,
      hits: 0,
      reason: 'the query had no searchable term',
    })
  } else {
    const scored: Array<{ id: string; score: number }> = []
    for (const entry of corpus) {
      const haystack = [entry.key ?? '', entry.subject ?? '', ...(entry.tags ?? [])].join(' ')
      if (haystack.trim() === '') continue
      let score = 0
      let matched = 0
      for (const term of terms) {
        const { matches, exact } = countMatches(haystack, term, smartCase(term, options.ignoreCase))
        if (matches === 0) continue
        matched++
        score += 3 * exact + (matches - exact)
      }
      if (matched === 0) continue
      termsMatchedById.set(entry.id, Math.max(termsMatchedById.get(entry.id) ?? 0, matched))
      addChannel(channelsById, entry.id, 'metadata')
      scored.push({ id: entry.id, score: matched * 1000 + score })
    }
    scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    lists.push({ channel: 'metadata', ids: scored.map((item) => item.id) })
    channels.push({ channel: 'metadata', ran: true, hits: scored.length, reason: null })
  }

  // The SAME fusion arithmetic the code retriever uses, over ids rather than file ranges.
  const fused = fuseRankedIds<MemoryChannel>(lists, RRF_K)

  const byId = new Map(corpus.map((entry) => [entry.id, entry]))
  const hits: MemoryHit[] = []
  for (const candidate of fused) {
    const entry = byId.get(candidate.id)
    if (entry === undefined) continue
    const recency = recencyBoost(now - entry.validFrom, halfLifeMs)
    hits.push({
      entry,
      relevance: candidate.rrf,
      recency,
      score: candidate.rrf * recency,
      termsMatched: termsMatchedById.get(entry.id) ?? 0,
      channels: channelsById.get(entry.id) ?? [],
      current: isCurrent(entry, now),
    })
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // Coverage of the question beats everything but the score itself.
    if (b.termsMatched !== a.termsMatched) return b.termsMatched - a.termsMatched
    if (b.entry.validFrom !== a.entry.validFrom) return b.entry.validFrom - a.entry.validFrom
    return a.entry.id < b.entry.id ? -1 : 1
  })

  const top = hits.slice(0, topK)

  await options.events?.emit({
    runId: options.runId ?? 'memory',
    kind: 'memory_retrieved',
    payload: {
      query: options.query,
      terms,
      // IDS AND SCORES, NOT TEXT. Memory holds whatever the user wrote down.
      hits: top.map((hit) => ({
        id: hit.entry.id,
        kind: hit.entry.kind,
        score: Number(hit.score.toFixed(6)),
        recency: Number(hit.recency.toFixed(4)),
        termsMatched: hit.termsMatched,
        current: hit.current,
      })),
      candidates: hits.length,
      supersededExcluded,
      halfLifeMs,
      channels: channels.map((channel) => ({ channel: channel.channel, ran: channel.ran, hits: channel.hits })),
    },
  })

  return {
    hits: top,
    terms,
    channels,
    candidates: hits.length,
    supersededExcluded,
    halfLifeMs,
  }
}

function addChannel(
  map: Map<string, MemoryChannel[]>,
  id: string,
  channel: MemoryChannel,
): void {
  const existing = map.get(id) ?? []
  if (!existing.includes(channel)) existing.push(channel)
  map.set(id, existing)
}

/**
 * Render retrieved memory for a prompt.
 *
 * Each entry carries its validity window, because a model told "we use REST" without being
 * told when that was true cannot reason about it. Superseded entries, when included, are
 * labelled as retracted rather than merely dated — the label is the point.
 */
export function renderMemoryForPrompt(hits: readonly MemoryHit[]): string {
  if (hits.length === 0) return ''
  const lines: string[] = []
  for (const hit of hits) {
    const since = new Date(hit.entry.validFrom).toISOString().slice(0, 10)
    const status = hit.current
      ? `since ${since}`
      : `RETRACTED — was valid from ${since}${hit.entry.reason === undefined ? '' : `, superseded because ${hit.entry.reason}`}`
    const subject = hit.entry.subject === undefined ? '' : ` [${hit.entry.subject}]`
    lines.push(`- (${hit.entry.kind}${subject}, ${status}) ${hit.entry.text}`)
  }
  return lines.join('\n')
}

/**
 * A compact digest of current memory, for the assembly layer's `memory` rung.
 *
 * Grouped by kind in the contract's order so the shape is stable between calls, and
 * capped per kind so one chatty kind cannot crowd out the others. This is the seam
 * `assembleContext({ memory })` already expects — Phase 9 fills it rather than adding a
 * second path into the prompt.
 */
export async function memoryDigest(options: {
  store: MemoryStore
  now?: number
  /** Entries per kind. Default 8. */
  perKind?: number
}): Promise<string> {
  const now = options.now ?? Date.now()
  const perKind = Math.max(1, options.perKind ?? 8)
  const live = await options.store.query({ currentOnly: true, at: now })

  const sections: string[] = []
  const headings: Record<MemoryKind, string> = {
    decision: 'Decisions',
    architecture: 'Architecture',
    standard: 'Standards',
    preference: 'Preferences',
    style: 'Style',
    bug: 'Past bugs to avoid repeating',
    conversation: 'Earlier conversations',
    performance: 'Performance history',
    test: 'Test history',
  }

  for (const kind of Object.keys(headings) as MemoryKind[]) {
    const entries = live
      .filter((entry) => entry.kind === kind)
      .sort((a, b) => b.validFrom - a.validFrom)
      .slice(0, perKind)
    if (entries.length === 0) continue
    sections.push(`## ${headings[kind]}`)
    for (const entry of entries) {
      const since = new Date(entry.validFrom).toISOString().slice(0, 10)
      const subject = entry.subject === undefined ? '' : ` [${entry.subject}]`
      sections.push(`- ${entry.text}${subject} (since ${since})`)
    }
  }

  return sections.join('\n')
}
