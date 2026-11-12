// The usage ledger for model calls that are NOT tied to a message.
//
// Inline completion, inline edit, the git commit-message writer, a connection test and
// model listing all spend tokens, but they are not runs — writing one line per typing
// pause into a project's `.sketch/events/` would bury every run that matters. So they get
// their OWN record, under the engine's home, grouped by CAUSE:
//
//     ~/.sketch/usage/<YYYY-MM-DD>.jsonl
//
// One JSON object per line, append-only, one file per UTC day — the same shape and the
// same "only ever appendFile + mkdir" discipline as the event store. A surface (the Cost
// dashboard) reads it to show "model calls not tied to a message" by cause, with tokens,
// and unknown shown as unknown.
//
// WHAT A LINE NEVER CONTAINS: a key, a prompt, or a reply. It carries only the facts a
// cost view needs — the cause, which provider and model, how many tokens (or that they
// are unknown), whether it succeeded, how many wire attempts it cost, and the project root
// when the call had one. There is nothing to redact because nothing sensitive is written.

import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Usage } from '../types.js'

/** Why a non-run model call happened. A closed set, so a surface can group by it. */
export type UsageCause =
  | 'completion'
  | 'inline-edit'
  | 'commit-message'
  | 'connection-test'
  | 'model-list'

export const USAGE_CAUSES: readonly UsageCause[] = [
  'completion',
  'inline-edit',
  'commit-message',
  'connection-test',
  'model-list',
]

/** One recorded non-run call. Facts only — never a key, a prompt, or a reply. */
export interface UsageRecord {
  ts: number
  cause: UsageCause
  /** Provider id (e.g. `openai`), when known. */
  provider: string | null
  /** The model the caller requested, when known. */
  requestedModel: string | null
  /** The model the provider said answered, when it named one and it differs. */
  answeredModel: string | null
  /** Tokens, or null when the provider reported none (shown as unknown, never 0). */
  usage: Usage | null
  /** Whether the numbers are an estimate (the offline fake adapter). */
  usageEstimated: boolean
  /** Whether the call succeeded. */
  ok: boolean
  /** Wire requests this one logical call cost (first try + bounded retries). */
  attempts: number
  /** The project root the call was made against, when it had one. */
  root: string | null
}

/** What a caller supplies; `ts` and the nulls are filled in. */
export interface UsageEntryInput {
  cause: UsageCause
  provider?: string | null
  requestedModel?: string | null
  answeredModel?: string | null
  usage?: Usage | null
  usageEstimated?: boolean
  ok?: boolean
  attempts?: number
  root?: string | null
}

/** `~/.sketch/usage`. `home` is injectable so a test never writes the real home. */
export function usageDir(home: string = homedir()): string {
  return join(home, '.sketch', 'usage')
}

function fileFor(ts: number, home: string): string {
  const day = new Date(ts).toISOString().slice(0, 10) // YYYY-MM-DD, UTC
  return join(usageDir(home), `${day}.jsonl`)
}

function sanitizeModel(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Append one usage line. Best-effort by design: a failure to write a cost breadcrumb must
 * never fail the completion or edit it describes, so write errors are swallowed. Only the
 * whitelisted facts are written — there is no field through which a key, prompt or reply
 * could reach the file.
 */
export async function recordUsage(input: UsageEntryInput, home: string = homedir()): Promise<void> {
  const ts = Date.now()
  const record: UsageRecord = {
    ts,
    cause: input.cause,
    provider: sanitizeModel(input.provider),
    requestedModel: sanitizeModel(input.requestedModel),
    answeredModel: sanitizeModel(input.answeredModel),
    usage: input.usage ?? null,
    usageEstimated: input.usageEstimated === true,
    ok: input.ok !== false,
    attempts: typeof input.attempts === 'number' && input.attempts > 0 ? Math.floor(input.attempts) : 1,
    root: typeof input.root === 'string' && input.root.trim() !== '' ? input.root : null,
  }
  const file = fileFor(ts, home)
  try {
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // A missing cost breadcrumb is not worth failing a user action over.
  }
}

/** One cause's rollup for a surface. */
export interface UsageCauseSummary {
  cause: UsageCause
  calls: number
  tokensIn: number
  tokensOut: number
  /** Calls whose tokens the provider did not report (shown as unknown, never 0). */
  usageUnknown: number
  /** Calls whose numbers are estimates. */
  usageEstimated: number
  /** Calls that failed. */
  failed: number
}

/** The whole non-run usage summary a surface renders. */
export interface UsageSummary {
  total: { calls: number; tokensIn: number; tokensOut: number; usageUnknown: number; usageEstimated: number; failed: number }
  byCause: UsageCauseSummary[]
  /** Log lines that could not be parsed, reported never absorbed. */
  skipped: number
}

function parseLine(line: string): UsageRecord | null {
  let obj: unknown
  try {
    obj = JSON.parse(line)
  } catch {
    return null
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null
  const r = obj as Record<string, unknown>
  if (typeof r['ts'] !== 'number' || typeof r['cause'] !== 'string') return null
  if (!USAGE_CAUSES.includes(r['cause'] as UsageCause)) return null
  const usage =
    r['usage'] !== null && typeof r['usage'] === 'object' && !Array.isArray(r['usage']) &&
    typeof (r['usage'] as Record<string, unknown>)['in'] === 'number' &&
    typeof (r['usage'] as Record<string, unknown>)['out'] === 'number'
      ? { in: (r['usage'] as { in: number }).in, out: (r['usage'] as { out: number }).out }
      : null
  return {
    ts: r['ts'] as number,
    cause: r['cause'] as UsageCause,
    provider: sanitizeModel(r['provider']),
    requestedModel: sanitizeModel(r['requestedModel']),
    answeredModel: sanitizeModel(r['answeredModel']),
    usage,
    usageEstimated: r['usageEstimated'] === true,
    ok: r['ok'] !== false,
    attempts: typeof r['attempts'] === 'number' ? r['attempts'] : 1,
    root: sanitizeModel(r['root']),
  }
}

/**
 * Read and roll up the non-run usage log. Pure over the bytes it reads: unknown-usage
 * calls are counted but their (absent) tokens add nothing, so a surface shows "unknown"
 * rather than a fabricated zero.
 */
export async function summarizeUsage(home: string = homedir()): Promise<UsageSummary> {
  const dir = usageDir(home)
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort()
  } catch {
    files = []
  }

  const byCause = new Map<UsageCause, UsageCauseSummary>()
  for (const cause of USAGE_CAUSES) {
    byCause.set(cause, { cause, calls: 0, tokensIn: 0, tokensOut: 0, usageUnknown: 0, usageEstimated: 0, failed: 0 })
  }
  let skipped = 0

  for (const name of files) {
    let text: string
    try {
      text = await readFile(join(dir, name), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      const record = parseLine(line)
      if (record === null) {
        skipped += 1
        continue
      }
      const bucket = byCause.get(record.cause)!
      bucket.calls += 1
      if (record.usage === null) bucket.usageUnknown += 1
      else {
        bucket.tokensIn += record.usage.in
        bucket.tokensOut += record.usage.out
      }
      if (record.usageEstimated) bucket.usageEstimated += 1
      if (!record.ok) bucket.failed += 1
    }
  }

  const causes = [...byCause.values()].filter((c) => c.calls > 0)
  const total = causes.reduce(
    (acc, c) => ({
      calls: acc.calls + c.calls,
      tokensIn: acc.tokensIn + c.tokensIn,
      tokensOut: acc.tokensOut + c.tokensOut,
      usageUnknown: acc.usageUnknown + c.usageUnknown,
      usageEstimated: acc.usageEstimated + c.usageEstimated,
      failed: acc.failed + c.failed,
    }),
    { calls: 0, tokensIn: 0, tokensOut: 0, usageUnknown: 0, usageEstimated: 0, failed: 0 },
  )
  return { total, byCause: causes, skipped }
}
