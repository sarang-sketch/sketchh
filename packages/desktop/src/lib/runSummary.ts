// What a run did, in words a person reads — derived from its events and nothing else.
//
// The chat shows a run as it happens and keeps a compact record afterwards: "Read
// src/app.ts", "Edited src/app.ts (+3 −1)", "unit passed". Every line here is a
// projection of an engine event; nothing is invented to fill a gap, and an event this
// module does not recognise is simply not shown.
//
// Pure functions, no React, no IO — so what the chat claims a run did is testable.

import type { SketchEvent } from './contracts'
import type { RunReceipt, RunStepSummary } from '../state/AppState'

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function rec(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// ── line diff ───────────────────────────────────────────────────────────────

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string }

/** Above this many lines on either side, the diff is approximated by prefix/suffix only. */
const LCS_LIMIT = 2_500

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * A minimal line diff: common prefix and suffix trimmed, LCS over what remains.
 * The engine's patch is deliberately one whole-file hunk; this is what turns it into
 * "+3 −1" instead of "+120 −118" for a three-line change.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before)
  const b = splitLines(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const head: DiffLine[] = a.slice(0, start).map((text) => ({ kind: 'same', text }))
  const tail: DiffLine[] = a.slice(endA).map((text) => ({ kind: 'same', text }))
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)

  let middle: DiffLine[]
  if (midA.length > LCS_LIMIT || midB.length > LCS_LIMIT) {
    middle = [...midA.map((text): DiffLine => ({ kind: 'del', text })), ...midB.map((text): DiffLine => ({ kind: 'add', text }))]
  } else {
    // Classic LCS table, then a walk that emits deletions before additions.
    const n = midA.length
    const m = midB.length
    const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i]![j] = midA[i] === midB[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
      }
    }
    middle = []
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        middle.push({ kind: 'same', text: midA[i]! })
        i++
        j++
      } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
        middle.push({ kind: 'del', text: midA[i]! })
        i++
      } else {
        middle.push({ kind: 'add', text: midB[j]! })
        j++
      }
    }
    while (i < n) middle.push({ kind: 'del', text: midA[i++]! })
    while (j < m) middle.push({ kind: 'add', text: midB[j++]! })
  }
  return [...head, ...middle, ...tail]
}

/** Only the changed lines and `context` lines around them; `null` marks a gap. */
export function withContext(lines: readonly DiffLine[], context = 3): Array<DiffLine | null> {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, index) => {
    if (line.kind === 'same') return
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true
  })
  const out: Array<DiffLine | null> = []
  let gap = false
  lines.forEach((line, index) => {
    if (keep[index]) {
      out.push(line)
      gap = false
    } else if (!gap) {
      out.push(null)
      gap = true
    }
  })
  if (out[0] === null) out.shift()
  if (out[out.length - 1] === null) out.pop()
  return out
}

/** The before/after text carried by one of the engine's whole-file patches. */
export function sidesOfPatch(diff: string): { before: string; after: string } | null {
  const lines = diff.split('\n')
  const at = lines.findIndex((line) => line.startsWith('@@'))
  if (at < 0) return null
  const before: string[] = []
  const after: string[] = []
  for (const line of lines.slice(at + 1)) {
    if (line.startsWith('\\')) continue
    if (line.startsWith('-')) before.push(line.slice(1))
    else if (line.startsWith('+')) after.push(line.slice(1))
    else if (line.startsWith(' ')) {
      before.push(line.slice(1))
      after.push(line.slice(1))
    }
  }
  return { before: before.join('\n'), after: after.join('\n') }
}

export interface ChangedFile {
  path: string
  added: number
  removed: number
  created: boolean
  /** The changed region with context, for an inline preview. Empty when unavailable. */
  preview: Array<DiffLine | null>
}

/** Files a run edited or proposed, latest state per path, in first-touched order. */
export function changedFiles(events: readonly SketchEvent[]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>()
  const firstBefore = new Map<string, string>()
  for (const event of events) {
    if (event.kind !== 'edit_proposed') continue
    const edits = Array.isArray(event.payload['edits']) ? (event.payload['edits'] as unknown[]) : []
    for (const raw of edits) {
      const edit = rec(raw)
      if (edit === null) continue
      const path = str(edit['path'])
      const diff = str(edit['diff'])
      if (path === null || diff === null) continue
      const sides = sidesOfPatch(diff)
      if (sides === null) continue
      // Against the ORIGINAL bytes of the first touch, so three edits to one file read
      // as the net change, not as three unrelated ones.
      if (!firstBefore.has(path)) firstBefore.set(path, sides.before)
      const original = firstBefore.get(path)!
      const lines = lineDiff(original, sides.after)
      byPath.set(path, {
        path,
        added: lines.filter((l) => l.kind === 'add').length,
        removed: lines.filter((l) => l.kind === 'del').length,
        created: original === '' && edit['wholeFile'] === true,
        preview: withContext(lines).slice(0, 80),
      })
    }
  }
  return [...byPath.values()]
}

// ── steps ───────────────────────────────────────────────────────────────────

const REASONS: Record<string, string> = {
  aborted: 'Stopped by you.',
  budget: 'Stopped at the spend ceiling.',
  max_iterations: 'Stopped at the turn limit.',
  loop_detected: 'Stopped: the model kept repeating itself.',
  provider_error: 'The model provider returned an error.',
  verify_failed: 'Checks failed.',
  edits_failed: 'No changes were applied — every edit failed.',
  edits_partial: 'Some edits did not apply — the change is incomplete.',
  awaiting_human_input: 'Waiting for your answer.',
}

/** One readable line per event worth showing. */
export function stepFor(event: SketchEvent): RunStepSummary | null {
  const p = event.payload
  switch (event.kind) {
    case 'repo_indexed': {
      const files = num(p['files'])
      return files === null ? null : { kind: 'index', text: `Indexed ${files} file${files === 1 ? '' : 's'}` }
    }
    case 'tool_called': {
      if (p['phase'] !== 'result') return null
      const name = str(p['name']) ?? 'tool'
      const detail = rec(p['detail']) ?? {}
      const ok = p['ok'] !== false
      if (name === 'read_file') {
        const path = str(detail['path'])
        return { kind: 'read', text: path === null ? 'Read a file' : `Read ${path}`, ok }
      }
      if (name === 'list_dir') {
        const path = str(detail['path'])
        return { kind: 'list', text: path === null || path === '.' ? 'Listed the project' : `Listed ${path}`, ok }
      }
      if (name === 'search_code') {
        const query = str(detail['query'])
        const hits = num(detail['hits'])
        return {
          kind: 'search',
          text: `Searched${query === null ? '' : ` for "${clip(query, 40)}"`}${hits === null ? '' : ` — ${hits} match${hits === 1 ? '' : 'es'}`}`,
          ok,
        }
      }
      if (name === 'find_files') {
        const pattern = str(detail['pattern'])
        const matches = num(detail['matches'])
        return {
          kind: 'search',
          text: `Found files${pattern === null ? '' : ` matching "${clip(pattern, 40)}"`}${matches === null ? '' : ` — ${matches}`}`,
          ok,
        }
      }
      if (name === 'run_command') {
        const command = str(detail['command']) ?? 'a command'
        if (detail['approved'] === false) return { kind: 'command', text: `Did not run ${clip(command, 80)}`, ok: false }
        const exitCode = num(detail['exitCode'])
        if (detail['background'] === true) {
          const url = str(detail['url'])
          if (str(detail['id']) !== null) {
            return { kind: 'command', text: `Started ${clip(command, 70)} in the background${url === null ? '' : ` — ${url}`}`, ok: true }
          }
          return { kind: 'command', text: `Tried to start ${clip(command, 70)} — it exited${exitCode === null ? '' : ` with ${exitCode}`}`, ok: false }
        }
        return {
          kind: 'command',
          text: `Ran ${clip(command, 80)}${exitCode === null ? '' : exitCode === 0 ? ' — passed' : ` — exit ${exitCode}`}`,
          ok: exitCode === 0,
        }
      }
      if (name === 'process_output') {
        const running = detail['running']
        return { kind: 'command', text: `Checked the background process${running === false ? ' — it has exited' : ''}`, ok }
      }
      if (name === 'stop_process') return { kind: 'command', text: 'Stopped the background process', ok }
      if (name === 'use_skill') {
        const skill = str(detail['name'])
        return { kind: 'skill', text: skill === null ? 'Loaded a skill' : `Used the ${skill} skill`, ok }
      }
      if (name === 'git-status') return { kind: 'tool', text: 'Checked git status', ok }
      if (name === 'git-diff') return { kind: 'tool', text: 'Read the git diff', ok }
      if (name === 'git-branch') return { kind: 'tool', text: 'Checked the branch', ok }
      return { kind: 'tool', text: `Used ${name}`, ok }
    }
    case 'tool_denied':
      return { kind: 'warn', text: `Tool ${str(p['name']) ?? ''} was not allowed`.replace('  ', ' '), ok: false }
    case 'plan_written':
      return { kind: 'plan', text: 'Wrote a plan' }
    case 'edit_proposed': {
      const edits = Array.isArray(p['edits']) ? (p['edits'] as unknown[]) : []
      const paths = edits.map((e) => str(rec(e)?.['path'])).filter((x): x is string => x !== null)
      if (paths.length === 0) return null
      const verb = p['reviewRequired'] === true ? 'Proposed changes to' : 'Edited'
      return { kind: 'edit', text: `${verb} ${paths.join(', ')}` }
    }
    case 'edit_rejected': {
      const path = str(p['path'])
      const reason = str(p['reason'])
      if (str(p['source']) === 'review') return null
      return { kind: 'warn', text: `Edit${path === null ? '' : ` to ${path}`} refused${reason === null ? '' : `: ${clip(reason, 90)}`}`, ok: false }
    }
    case 'verify_result': {
      const name = str(p['name']) ?? 'check'
      const ok = p['ok'] === true
      return { kind: 'verify', text: `${name} ${ok ? 'passed' : 'failed'}`, ok }
    }
    case 'think': {
      if (p['degraded'] === true) return null
      const text = str(p['text'])
      return text === null ? null : { kind: 'think', text: clip(text, 160) }
    }
    case 'ask': {
      const question = str(p['question'])
      return question === null ? null : { kind: 'ask', text: clip(question, 160) }
    }
    case 'budget_exceeded':
      return { kind: 'warn', text: clip(str(p['detail']) ?? 'Spend ceiling reached', 140), ok: false }
    case 'run_failed': {
      const reason = str(p['reason'])
      if (reason === null || reason === 'done') return null
      return { kind: 'error', text: REASONS[reason] ?? `Run ended: ${reason}`, ok: false }
    }
    default:
      return null
  }
}

/** Every step of a run, in order, with consecutive duplicates collapsed. */
export function stepsFor(events: readonly SketchEvent[]): RunStepSummary[] {
  const out: RunStepSummary[] = []
  for (const event of events) {
    const step = stepFor(event)
    if (step === null) continue
    const last = out[out.length - 1]
    if (last !== undefined && last.kind === step.kind && last.text === step.text) continue
    out.push(step)
  }
  return out.slice(-60)
}

/** A short present-tense label for what the run is doing right now. */
export function currentActivity(events: readonly SketchEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    switch (event.kind) {
      case 'repo_indexed':
        return 'Indexing the project…'
      case 'llm_request':
        return 'Thinking…'
      case 'tool_called': {
        if (event.payload['phase'] !== 'start') return 'Thinking…'
        const name = str(event.payload['name'])
        const summary = str(event.payload['summary'])
        const what = summary === null ? null : clip(summary, 70)
        switch (name) {
          case 'run_command':
            return what === null ? 'Running a command…' : `Running ${what}…`
          case 'read_file':
            return what === null ? 'Reading the project…' : `Reading ${what}…`
          case 'search_code':
            return what === null ? 'Searching the code…' : `Searching for "${what}"…`
          case 'list_dir':
            return what === null || what === '.' ? 'Looking around the project…' : `Looking in ${what}…`
          case 'find_files':
            return 'Finding files…'
          case 'use_skill':
            return what === null ? 'Loading a skill…' : `Loading the ${what} skill…`
          default:
            return name !== null && name.startsWith('git-') ? 'Checking git…' : 'Using a tool…'
        }
      }
      case 'plan_written':
        return 'Planning…'
      case 'edit_proposed':
        return 'Editing files…'
      case 'verify_started':
        return `Running ${str(event.payload['name']) ?? 'checks'}…`
      case 'ask':
        return event.payload['approval'] !== undefined ? 'Waiting for your approval' : 'Waiting for your answer'
      case 'run_started':
        return 'Starting…'
      default:
        continue
    }
  }
  return 'Starting…'
}

/** What a run verifiably did, from its events alone. See `RunReceipt`. */
export function receiptFor(events: readonly SketchEvent[]): RunReceipt {
  const checks: RunReceipt['checks'] = []
  const commands: RunReceipt['commands'] = []
  const models: string[] = []
  let modelsAnswered = false
  let modelCalls = 0
  let tokensIn = 0
  let tokensOut = 0
  let tokensUnknownCalls = 0
  let tokensEstimated = false
  let retries = 0
  let started: number | null = null
  let ended: number | null = null
  let edits: { applied: number; failed: number } | undefined
  for (const event of events) {
    const p = event.payload
    switch (event.kind) {
      case 'run_started':
        started ??= event.ts
        break
      case 'run_completed':
      case 'run_failed': {
        ended = event.ts
        // Edit accounting the engine put on the terminal event (completion honesty).
        // Absent on an old log, which reads as "no edit outcome recorded".
        const applied = num(p['editsApplied'])
        const failed = num(p['editsFailed'])
        if (applied !== null || failed !== null) {
          edits = { applied: applied ?? 0, failed: failed ?? 0 }
        }
        break
      }
      case 'verify_result': {
        const name = str(p['name'])
        if (name !== null) checks.push({ name, ok: p['ok'] === true })
        break
      }
      case 'llm_response': {
        modelCalls++
        // The provider reported no usage when the event says `usageKnown: false`: its
        // zeros are a placeholder, not a measurement, so they are NOT summed and the call
        // is counted as unknown instead. An old log without the flag reads as known.
        const usageKnown = p['usageKnown'] !== false
        if (usageKnown) {
          const usage = rec(p['usage'])
          tokensIn += num(usage?.['in']) ?? 0
          tokensOut += num(usage?.['out']) ?? 0
        } else {
          tokensUnknownCalls++
        }
        if (p['usageEstimated'] === true) tokensEstimated = true
        // Automatic retries beyond the first try (attempts 3 ⇒ 2 retries).
        const attempts = num(p['attempts'])
        if (attempts !== null && attempts > 1) retries += attempts - 1
        // The model that ANSWERED: the response model when the provider named one,
        // else the requested model. Deduped, first-seen order. `modelsAnswered` records
        // whether any call carried the provider-named model, so a surface can label a
        // requested-only list "(requested)".
        const responded = str(p['responseModel'])
        if (responded !== null) modelsAnswered = true
        const shown = responded ?? str(p['model'])
        if (shown !== null && !models.includes(shown)) models.push(shown)
        break
      }
      case 'tool_called': {
        if (p['phase'] !== 'result' || p['name'] !== 'run_command') break
        const detail = rec(p['detail']) ?? {}
        const command = str(detail['command'])
        const exitCode = num(detail['exitCode'])
        if (command !== null && exitCode !== null) commands.push({ command, exitCode })
        break
      }
      default:
        break
    }
  }
  return {
    // The LAST outcome per check name: a check that failed and was fixed reads as passed.
    checks: [...new Map(checks.map((check) => [check.name, check])).values()],
    commands,
    modelCalls,
    tokens: { in: tokensIn, out: tokensOut },
    tokensUnknownCalls,
    tokensEstimated,
    retries,
    models,
    modelsAnswered,
    durationMs: started !== null && ended !== null ? Math.max(0, ended - started) : null,
    ...(edits !== undefined ? { edits } : {}),
  }
}
