// Grading a role sub-run against its own signal.
//
// ── WHY THIS IS A SEPARATE FILE FROM THE DISPATCHER ─────────────────────────
//
// The dispatcher decides what to spend money on. This file decides whether the money
// bought anything. Keeping them apart means the grader can be called on a `RunResult` that
// was produced anywhere — a replayed log, a fixture, a captured eval — and a test can prove
// a role fails without running a swarm.
//
// ── THE HAZARD THIS FILE EXISTS TO CLOSE ────────────────────────────────────
//
// `runTask` returns `ok: true` when a task configures no verification at all. That is
// Requirement 5.8 and it is right for the single-agent case, where the user chose not to
// verify. For a ROLE it is a disaster: a sub-run with an empty policy reports confident
// success having proved nothing, and thirteen of those merge into a swarm that looks like
// it worked. `roleVerification` refuses those roles before they run, and
// {@link gradeRole} refuses them AGAIN here — a `verify-stage` role with zero verify
// results fails, whatever `run.ok` says. Two independent refusals, because this is the one
// failure mode of a multi-agent system that is invisible from the outside.
//
// ── NOTHING HERE ASKS A MODEL ANYTHING ─────────────────────────────────────
//
// Every grade is a property of bytes that already exist: a verify result, a `plan_written`
// event, or a path on disk. No model grades its own homework and no model grades another
// model's, because a grader that can be talked out of a verdict is not a grader.
//
// Validates: Requirements 24.5, 24.6

import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { isWithin } from '../orchestrator/file-writer.js'
import type { RunResult, SketchEvent } from '../types.js'
import { NO_FINDINGS_TOKEN, ROLE_DEFINITIONS, type Role, type RoleSignal } from './roles.js'

/** One anchored claim: a path the role cited, and the line when it named one. */
export interface Citation {
  path: string
  line?: number
}

/**
 * Paths a findings role cited.
 *
 * Deliberately mechanical. A path is a run of path characters ending in a short extension,
 * optionally followed by `:<line>`; backticks, brackets and trailing punctuation are
 * stripped. It does NOT try to understand prose — the prompt tells the role to write
 * `path/to/file.ts:42`, and this reads exactly that shape.
 *
 * What it must not do is get clever. A looser matcher would turn any word with a dot in it
 * into a citation, and a role could then satisfy its signal by mentioning `e.g.` — which is
 * the fabrication this check exists to catch.
 */
export function extractCitations(text: string): Citation[] {
  const found = new Map<string, Citation>()
  // Segments of path characters, at least one dot-extension of 1–8 word characters, and an
  // optional `:line`. Windows separators are accepted because a model on Windows will emit
  // them and refusing would fail a role for the machine it ran on.
  const pattern = /(?:[\w.-]+[\\/])*[\w.-]+\.[A-Za-z][\w]{0,7}(?::(\d+))?/g
  for (const match of text.matchAll(pattern)) {
    const raw = match[0]
    const lineText = match[1]
    // Strip the `:line` suffix to get the path itself.
    const path = lineText === undefined ? raw : raw.slice(0, raw.length - lineText.length - 1)
    // A bare sentence-ending token like `code.` never reaches here (the extension needs a
    // letter first), but `e.g` would; a two-character extension of only letters with no
    // separator at all is prose far more often than it is a file.
    if (!path.includes('/') && !path.includes('\\')) {
      const extension = path.slice(path.lastIndexOf('.') + 1)
      if (extension.length < 2) continue
    }
    const normalised = path.replace(/\\/g, '/')
    const existing = found.get(normalised)
    const line = lineText === undefined ? undefined : Number(lineText)
    if (existing === undefined) {
      found.set(normalised, line === undefined ? { path: normalised } : { path: normalised, line })
    } else if (existing.line === undefined && line !== undefined) {
      found.set(normalised, { path: normalised, line })
    }
  }
  return [...found.values()]
}

/** Does this project-relative path resolve to something? Injectable for tests. */
export type PathExists = (relativePath: string) => Promise<boolean>

/**
 * The default existence check: the real filesystem, refusing anything outside the root.
 *
 * The root guard is here as well as in the file writer because a citation is attacker-ish
 * input — it is text a model produced — and `../../etc/passwd` must read as a fabricated
 * citation rather than as a probe that succeeds.
 */
export function diskPathExists(root: string): PathExists {
  const rootAbs = resolve(root)
  return async (relativePath) => {
    let target: string
    try {
      target = resolve(rootAbs, relativePath)
    } catch {
      return false
    }
    if (!isWithin(rootAbs, target)) return false
    try {
      await stat(target)
      return true
    } catch {
      return false
    }
  }
}

/** A role's verdict, with a reason specific enough to act on. */
export interface RoleGrade {
  role: Role
  signal: RoleSignal
  passed: boolean
  /** Why it passed or failed, in words. Always populated. */
  reason: string
  /** Citations found, for a `citations` role. Empty otherwise. */
  citations: Citation[]
  /** Citations that do not resolve — the fabrication signal. */
  fabricated: string[]
  /** True when a findings role explicitly reported nothing. */
  noFindings: boolean
}

function planFiles(events: readonly SketchEvent[]): string[] {
  const out: string[] = []
  for (const event of events) {
    if (event.kind !== 'plan_written') continue
    const files = event.payload['files']
    if (!Array.isArray(files)) continue
    for (const file of files) if (typeof file === 'string') out.push(file)
  }
  return out
}

/**
 * Grade one role sub-run.
 *
 * `run.finalText` is what a findings role is graded on, because the prompt tells it to
 * report there. Scanning every turn instead would let a role satisfy its signal by naming
 * a file while thinking out loud and then reporting nothing, which is the costume this
 * whole mechanism is trying to prevent.
 */
export async function gradeRole(
  role: Role,
  run: RunResult,
  options: { pathExists: PathExists },
): Promise<RoleGrade> {
  const definition = ROLE_DEFINITIONS[role]
  const signal = definition.signal
  const base = { role, signal, citations: [] as Citation[], fabricated: [] as string[], noFindings: false }

  switch (signal.kind) {
    case 'verify-stage': {
      // THE SECOND REFUSAL. `run.ok` is not enough: a sub-run whose narrowed policy turned
      // out empty reports ok having verified nothing. No results, no pass.
      if (run.verify.length === 0) {
        return {
          ...base,
          passed: false,
          reason:
            `the ${definition.title} role is graded by the "${signal.stage}" stage and no ` +
            'verify command ran, so nothing was checked. A run that verified nothing has ' +
            'not passed, whatever it reported',
        }
      }
      const failed = run.verify.filter((result) => !result.ok)
      if (failed.length > 0) {
        return {
          ...base,
          passed: false,
          reason: `the "${signal.stage}" stage failed: ${failed
            .map((result) => `${result.name} (exit ${result.exitCode})`)
            .join(', ')}`,
        }
      }
      if (!run.ok) {
        return {
          ...base,
          passed: false,
          reason: `the "${signal.stage}" stage passed but the run did not complete: ${
            run.finalText.split('\n')[0] ?? 'no detail'
          }`,
        }
      }
      return {
        ...base,
        passed: true,
        reason: `the "${signal.stage}" stage passed (${run.verify.length} command(s))`,
      }
    }

    case 'plan-artifact': {
      const files = planFiles(run.events)
      if (files.length === 0) {
        return {
          ...base,
          passed: false,
          reason:
            `the ${definition.title} role is graded by the plan artifact it writes, and this ` +
            'run wrote no plan document',
        }
      }
      return {
        ...base,
        passed: true,
        reason: `wrote ${files.length} plan document(s): ${files.join(', ')}`,
      }
    }

    case 'citations': {
      const report = run.finalText
      const citations = extractCitations(report)
      const declaredNone = report.includes(NO_FINDINGS_TOKEN)

      if (citations.length === 0) {
        return declaredNone
          ? {
              ...base,
              passed: true,
              noFindings: true,
              reason: `reported ${NO_FINDINGS_TOKEN}, which is an anchored answer`,
            }
          : {
              ...base,
              passed: false,
              reason:
                `the ${definition.title} role must anchor every claim to a path, and its ` +
                `report cites none. If it found nothing it must say ${NO_FINDINGS_TOKEN}; ` +
                'unanchored prose is not a finding',
            }
      }

      const fabricated: string[] = []
      for (const citation of citations) {
        if (!(await options.pathExists(citation.path))) fabricated.push(citation.path)
      }
      if (fabricated.length > 0) {
        return {
          ...base,
          citations,
          fabricated,
          passed: false,
          reason:
            `cited ${fabricated.length} path(s) that do not exist in this repository: ` +
            `${fabricated.join(', ')}. A finding about a file that is not there is not a finding`,
        }
      }
      return {
        ...base,
        citations,
        passed: true,
        reason: `${citations.length} citation(s), all resolving: ${citations
          .map((citation) => (citation.line === undefined ? citation.path : `${citation.path}:${citation.line}`))
          .join(', ')}`,
      }
    }
  }
}
