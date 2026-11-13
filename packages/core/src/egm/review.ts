// The EGM Goldfish review protocol, as data and pure rules.
//
// The five stages (EGM's Stages 5–9), the semantic split between a feature
// spec and its implementation plan, finding severity and deduplication, and
// the review-loop convergence rules. Nothing here calls a model: the stages
// are executed by the agent following the `egm-review` / `egm-review-loop`
// skills, and these functions are what the panel, the report writer, and the
// tests share so "what stage are we on" and "is this round clean" mean the
// same thing everywhere.
//
// The honest limit, stated where it matters: Sketch runs the stages
// sequentially in ONE fresh session. EGM's reference implementation runs
// them as isolated subagents; Sketch has no isolated subagent contexts yet,
// so a stage can in principle be influenced by an earlier stage's findings in
// the same session. What the fresh session DOES guarantee is the property
// that matters most — no drafting conversation — because the session starts
// with an empty history (see `freshContext.ts`).

/** A finding's severity. Blockers and Majors block a clean round; Nits do not. */
export type FindingSeverity = 'blocker' | 'major' | 'nit'

export const SEVERITY_ORDER: readonly FindingSeverity[] = ['blocker', 'major', 'nit']

export interface Finding {
  /** Stable id: `<reviewer>-<round>-<n>`. */
  id: string
  /** Reviewer lens that raised it, e.g. `design_critic`. */
  reviewer: string
  severity: FindingSeverity
  /** Lines (`12-34`), a section header, or `full file`. */
  scope: string
  description: string
  rationale: string
  /** `open` until resolved or accepted as a trade-off. */
  status: 'open' | 'settled' | 'fixed'
}

/** One of the five review stages. */
export interface ReviewStage {
  /** EGM stage number (5–9). */
  stage: 5 | 6 | 7 | 8 | 9
  name: string
  /** Reviewer lenses, in the order EGM runs them. */
  reviewers: readonly string[]
  /** Which part of the document the stage reads. */
  range: 'full' | 'feature' | 'detailed'
  /** The report file the stage writes. */
  reportFile: string
  /** Stage 6 reads the document alone: no GoldfishContext, no standard. */
  takesGoldfishContext: boolean
}

export const REVIEW_STAGES: readonly ReviewStage[] = [
  {
    stage: 5,
    name: 'Initial Zoom Out',
    reviewers: ['zoom-out', 'inventive-catalyst'],
    range: 'full',
    reportFile: 'zoom_out_report.md',
    takesGoldfishContext: true,
  },
  {
    stage: 6,
    name: 'Comprehension Test',
    reviewers: ['comprehension'],
    range: 'full',
    reportFile: 'comprehension_report.md',
    takesGoldfishContext: false,
  },
  {
    stage: 7,
    name: 'Critic Review',
    reviewers: ['design', 'structural', 'style'],
    range: 'feature',
    reportFile: 'critic_report.md',
    takesGoldfishContext: true,
  },
  {
    stage: 8,
    name: 'Intermediate Zoom Out',
    reviewers: ['zoom-out'],
    range: 'full',
    reportFile: 'intermediate_zoom_out_report.md',
    takesGoldfishContext: true,
  },
  {
    stage: 9,
    name: 'Implementation Readiness',
    reviewers: ['implementation-readiness', 'codebase-details', 'style'],
    range: 'detailed',
    reportFile: 'implementation_readiness_report.md',
    takesGoldfishContext: true,
  },
]

/** The report the consolidated preset writes. */
export const CONSOLIDATED_REPORT_FILE = 'consolidated_review_report.md'
/** The report `egm-resolve` writes. */
export const RESOLVE_REPORT_FILE = 'goldfish_review_report.md'

/** The header that divides a feature spec from its implementation plan. */
const SPLIT_HEADERS = [
  'detailed implementation plan',
  'implementation plan',
  'work breakdown',
  'implementation steps',
]

export interface SemanticSplit {
  /** 1-based line of the boundary header, or null when there is no plan. */
  boundaryLine: number | null
  /** 1-based inclusive range of the feature spec. */
  featureRange: { start: number; end: number }
  /** 1-based inclusive range of the implementation plan, or null. */
  detailedRange: { start: number; end: number } | null
}

/**
 * Find the semantic split in a document's lines. The first `##` header that
 * names an implementation plan divides the feature spec (above) from the plan
 * (at and below). With no such header the whole document is the feature spec.
 */
export function discoverSemanticSplit(lines: readonly string[]): SemanticSplit {
  const total = lines.length
  for (let i = 0; i < total; i++) {
    const line = lines[i] ?? ''
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading === null) continue
    const title = (heading[1] ?? '').trim().toLowerCase()
    if (!SPLIT_HEADERS.includes(title)) continue
    const boundary = i + 1
    return {
      boundaryLine: boundary,
      featureRange: { start: 1, end: Math.max(1, boundary - 1) },
      detailedRange: { start: boundary, end: total },
    }
  }
  return {
    boundaryLine: null,
    featureRange: { start: 1, end: Math.max(1, total) },
    detailedRange: null,
  }
}

/** Normalize a finding for comparison: case, whitespace, and punctuation. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * Deduplicate findings: same reviewer, same scope, same normalized
 * description counts once (the first occurrence wins). Reviewers that fail
 * are never represented here — a missing reviewer is "not run", not "zero
 * findings".
 */
export function dedupeFindings<T extends Finding>(findings: readonly T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const finding of findings) {
    const key = `${finding.reviewer}|${finding.scope}|${normalize(finding.description)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(finding)
  }
  return out
}

/** Blockers first, then Majors, then Nits; ties break by reviewer, then scope. */
export function sortFindings<T extends Finding>(findings: readonly T[]): T[] {
  const rank = (severity: FindingSeverity): number => SEVERITY_ORDER.indexOf(severity)
  return [...findings].sort(
    (a, b) =>
      rank(a.severity) - rank(b.severity) ||
      (a.reviewer < b.reviewer ? -1 : a.reviewer > b.reviewer ? 1 : 0) ||
      (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0),
  )
}

export interface RoundAssessment {
  /** True when no unsettled Blocker/Major is open and every requested reviewer ran. */
  clean: boolean
  blockers: number
  majors: number
  nits: number
  /** Reviewers that did not run this round — a round with any is never clean. */
  notRun: string[]
}

/**
 * Assess one review round. A finding counts against the round only while it
 * is `open`: a settled finding is an accepted trade-off, and a fixed finding
 * that comes back is re-opened by the loop driver before this is called.
 */
export function assessRound(
  findings: readonly Finding[],
  reviewerStatus: Readonly<Record<string, 'completed' | 'not run'>>,
): RoundAssessment {
  const open = findings.filter((f) => f.status === 'open')
  const notRun = Object.entries(reviewerStatus)
    .filter(([, status]) => status === 'not run')
    .map(([reviewer]) => reviewer)
    .sort()
  const blockers = open.filter((f) => f.severity === 'blocker').length
  const majors = open.filter((f) => f.severity === 'major').length
  const nits = open.filter((f) => f.severity === 'nit').length
  return { clean: blockers === 0 && majors === 0 && notRun.length === 0, blockers, majors, nits, notRun }
}

/** The review loop converges after two consecutive clean rounds, or caps at 5. */
export const REVIEW_LOOP_MAX_ROUNDS = 5

export function hasConverged(cleanRounds: readonly boolean[]): boolean {
  const n = cleanRounds.length
  return n >= 2 && cleanRounds[n - 1] === true && cleanRounds[n - 2] === true
}

/** How `egm-resolve` judges one finding. Exactly one category each. */
export type ResolveCategory = 'CONTEST' | 'ESCALATE' | 'PROPOSE FIX' | 'DECLINE'

export interface CategorizedFinding extends Finding {
  category: ResolveCategory
  justification: string
  proposedEdit?: string
}

/** Render the consolidated review report (`consolidated_review_report.md`). */
export function renderConsolidatedReport(options: {
  target: string
  lineRange: string
  reviewerStatus: Readonly<Record<string, 'completed' | 'not run'>>
  findings: readonly Finding[]
  /** The honest limit: stages ran in one fresh session, not isolated subagents. */
  sequentialFreshSession: boolean
}): string {
  const sorted = sortFindings(dedupeFindings(options.findings))
  const lines: string[] = [
    '# Goldfish Review Report',
    '',
    `**Target:** \`${options.target}\` (\`${options.lineRange}\`)`,
    '',
    options.sequentialFreshSession
      ? '> Reviewed in one fresh session with no prior chat history. Sketch cannot yet spawn isolated subagent contexts, so the five stages ran sequentially in that session instead of in five isolated ones.'
      : '> Reviewed with fresh-eyes Goldfish reviewers.',
    '',
    '## Reviewer Status',
    '',
    '| Reviewer | Status |',
    '| --- | --- |',
    ...Object.entries(options.reviewerStatus)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([reviewer, status]) => `| \`${reviewer}\` | ${status} |`),
    '',
    '## Prioritized Findings (Blockers -> Major -> Nits)',
    '',
  ]
  if (sorted.length === 0) {
    lines.push('No findings. (A round with no findings is rare — check that every requested reviewer actually ran.)', '')
  }
  for (const finding of sorted) {
    lines.push(
      `### ${finding.description} - Severity: ${finding.severity === 'blocker' ? 'Blocker' : finding.severity === 'major' ? 'Major' : 'Nit'}`,
      `* **Reviewer Lens:** \`${finding.reviewer}\``,
      `* **Affected Scope:** ${finding.scope}`,
      `* **Discrepancy Description**: ${finding.description}`,
      `* **Rationale & Recommendation**: ${finding.rationale}`,
      '',
    )
  }
  return lines.join('\n')
}

/** Render the resolve report (`goldfish_review_report.md`). */
export function renderResolveReport(options: {
  target: string
  lineRange: string
  findings: readonly CategorizedFinding[]
}): string {
  const sorted = sortFindings(options.findings)
  const lines: string[] = [
    '# Goldfish Annotated Review Report',
    '',
    `**Target:** \`${options.target}\` (\`${options.lineRange}\`)`,
    '',
    '## Prioritized Findings & AI Suggestions',
    '',
  ]
  for (const finding of sorted) {
    const severity = finding.severity === 'blocker' ? 'Blocker' : finding.severity === 'major' ? 'Major' : 'Nit'
    lines.push(
      `### ${finding.description} [\`${finding.reviewer}\`] - Severity: ${severity}`,
      `*   **Affected Scope:** ${finding.scope}`,
      `*   **Discrepancy Description:** ${finding.description}`,
      `*   **Rationale:** ${finding.rationale}`,
      `*   ***AI Suggestion:*** ${finding.category}`,
      `*   ***Justification:*** ${finding.justification}`,
    )
    if (finding.proposedEdit !== undefined) {
      lines.push(`*   ***Proposed Edit:*** ${finding.proposedEdit}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
