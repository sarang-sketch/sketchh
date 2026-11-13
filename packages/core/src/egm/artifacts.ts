// EGM file conventions: where the Elephant's artifacts live and what they
// look like.
//
// The workflow is `concepts_brief.md` (brainstorm) → `design_draft.md`
// (draft, section by section) → `docs/designs/<feature>.md` (approved spec,
// registered in `docs/designs/SITEMAP.md`) → review reports beside the draft.
// Drift reports are dated files at the project root. These constants are the
// one place that mapping lives, so a skill prompt, the panel, and the tests
// cannot disagree about a filename.

/** The brainstorm artifact, in the project root. */
export const CONCEPTS_BRIEF_FILENAME = 'concepts_brief.md'
/** The draft artifact, in the project root, while it is being written. */
export const DESIGN_DRAFT_FILENAME = 'design_draft.md'
/** Where approved specs are saved. */
export const DESIGNS_DIR = 'docs/designs'
/** The index of approved specs inside the designs directory. */
export const SITEMAP_FILENAME = 'SITEMAP.md'

/** `2026-11-13` → `2026-11-13_DRIFT_REPORT.md`. Throws on a bad date. */
export function driftReportFilename(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`drift report date must be YYYY-MM-DD, got ${JSON.stringify(date)}`)
  }
  return `${date}_DRIFT_REPORT.md`
}

/**
 * Turn a feature name into a designs filename: lowercase, spaces and runs of
 * punctuation become one `-`, anything else is dropped. `Webhook Delivery!`
 * becomes `webhook-delivery.md`. An empty result throws — a design with no
 * name has nowhere to be saved.
 */
export function designDocPath(featureName: string): string {
  const slug = featureName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug === '') {
    throw new Error(`cannot make a design filename from ${JSON.stringify(featureName)}`)
  }
  return `${DESIGNS_DIR}/${slug}.md`
}

/** The skeleton of a brainstorm brief (EGM's `concepts_brief.md` structure). */
export function conceptsBriefTemplate(options: {
  feature: string
  author: string
  date: string
}): string {
  return [
    `# ${options.feature}`,
    '',
    `* **Author:** ${options.author}`,
    `* **Date:** ${options.date}`,
    '',
    '## Overview',
    '',
    '[High-level summary: feature, target user, core value, in plain English.]',
    '',
    '## Analysis',
    '',
    '[Cohesive analysis from the review lenses: contradictions, suggested patterns, secondary trade-offs, the Ideal Final Result.]',
    '',
    '## Goals vs. Non-Goals',
    '',
    '* **In-Scope Goals:** [Explicit scope items]',
    '* **Out-of-Scope Non-Goals:** [Features intentionally excluded]',
    '',
    '## Alternatives Weighed',
    '',
    '[Each rejected option with its technical reason. Mark author decisions as "Rejected by author: <reason>".]',
    '',
    '## Key Decisions & Staging for Next Steps',
    '',
    '[Decisions resolved here, to carry into `/egm-draft`.]',
    '',
  ].join('\n')
}

/** The skeleton of a design document (EGM's `design_doc.md` template). */
export function designDraftTemplate(options: {
  feature: string
  author: string
  date: string
  status?: 'Draft' | 'Proposed' | 'In Review' | 'Approved'
}): string {
  return [
    `# ${options.feature}`,
    '',
    `* **Author:** ${options.author}`,
    `* **Status:** ${options.status ?? 'Draft'}`,
    `* **Date:** ${options.date}`,
    '',
    '## Overview',
    '',
    '## The Problem',
    '',
    '## Goals',
    '',
    '## Non-Goals',
    '',
    '## Open Questions',
    '',
    '## Critical User Journeys (CUJs)',
    '',
    '## Technical Plan (Architecture)',
    '',
    '## Alternatives Considered',
    '',
    '## Detailed Implementation Plan',
    '',
    '## Risks & Mitigations',
    '',
    '## Testing Plan',
    '',
  ].join('\n')
}

/** One line for `docs/designs/SITEMAP.md` when a design is approved. */
export function sitemapEntry(options: {
  feature: string
  path: string
  date: string
  author: string
  components: string
  description: string
}): string {
  return [
    `## ${options.feature}`,
    '',
    `- Link: [${options.feature}](${options.path})`,
    `- Date: ${options.date}`,
    `- Author: ${options.author}`,
    `- Components: ${options.components}`,
    `- Description: ${options.description}`,
    '',
  ].join('\n')
}
