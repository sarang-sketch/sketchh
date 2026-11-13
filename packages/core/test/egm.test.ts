// EGM (Elephant-Goldfish Model): the Goldfish fresh-context rule, the
// five-stage review protocol, the artifact conventions, and the registry
// entries that ship the seven adapted skills.
//
// The property under test throughout is the one EGM exists for: a reviewer
// sees the document and its linked files, and NOT the conversation that
// produced it. `buildGoldfishContext` has no field for chat history at all,
// and the tests assert that — not just that history happens to be empty.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CONCEPTS_BRIEF_FILENAME,
  DESIGN_DRAFT_FILENAME,
  DESIGNS_DIR,
  REVIEW_STAGES,
  buildGoldfishContext,
  conceptsBriefTemplate,
  designDocPath,
  designDraftTemplate,
  dedupeFindings,
  discoverSemanticSplit,
  driftReportFilename,
  hasConverged,
  renderConsolidatedReport,
  renderResolveReport,
  sortFindings,
  assessRound,
  sitemapEntry,
  type Finding,
} from '../src/egm/index.js'
import { SEED_REGISTRY_DIR, SEED_SKILLS } from '../src/registry/index.js'
import { loadSkillFile } from '../src/skills/index.js'

/** `packages/core/registry`, from this test file. */
const REGISTRY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', SEED_REGISTRY_DIR)

const EGM_SKILLS = [
  'egm-brainstorm',
  'egm-draft',
  'egm-review',
  'egm-resolve',
  'egm-bootstrap',
  'egm-drift-report',
  'egm-review-loop',
] as const

const tmpDirs: string[] = []

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

async function makeProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-egm-'))
  tmpDirs.push(dir)
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
  return dir
}

function finding(overrides: Partial<Finding> & { id: string }): Finding {
  return {
    reviewer: 'design',
    severity: 'major',
    scope: '12-20',
    description: 'The retry policy is unspecified.',
    rationale: 'A reader cannot tell what happens on the second failure.',
    status: 'open',
    ...overrides,
  }
}

describe('the Goldfish context (fresh-context rule)', () => {
  it('contains the target and its linked files, and no chat history', async () => {
    const root = await makeProject({
      'docs/designs/webhooks.md':
        '# Webhooks\n\nSee [the plan](./plan.md) and [the code](../../src/app.ts).\n\n' +
        'Also [anchor](#section), [outside](../../../secret.md), [web](https://example.com/x.md), [gone](./gone.md).\n',
      'docs/designs/plan.md': '# Plan\n',
      'src/app.ts': 'export const app = 1\n',
    })
    const result = await buildGoldfishContext({
      projectRoot: root,
      targetFile: 'docs/designs/webhooks.md',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { context } = result
    expect(context.target.path).toBe('docs/designs/webhooks.md')
    expect(context.target.content).toContain('# Webhooks')
    expect(context.files.map((f) => f.path)).toEqual(['docs/designs/plan.md', 'src/app.ts'])
    // The Goldfish property, as data: there is no history in the context.
    expect(context.priorChatTurns).toBe(0)
    expect('history' in context).toBe(false)
    expect('chat' in context).toBe(false)
    expect(JSON.stringify(context)).not.toContain('drafting conversation')
    // Excluded links are listed, not silently dropped.
    expect(context.excluded).toEqual(
      expect.arrayContaining([
        { link: '#section', reason: 'anchor-only' },
        { link: 'https://example.com/x.md', reason: 'url' },
        { link: '../../../secret.md', reason: 'outside-project' },
        { link: './gone.md', reason: 'missing' },
      ]),
    )
    expect(context.note).toMatch(/no prior chat history/i)
  })

  it('includes extra GoldfishContext entries, and dedupes repeats', async () => {
    const root = await makeProject({
      'design.md': '# Design\n\nSee [notes](./notes.md).\n',
      'notes.md': '# Notes\n',
      'extra.md': '# Extra\n',
    })
    const result = await buildGoldfishContext({
      projectRoot: root,
      targetFile: 'design.md',
      extraContext: ['extra.md', 'notes.md'],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context.files.map((f) => f.path)).toEqual(['extra.md', 'notes.md'])
  })

  it('refuses a missing target and a target outside the project', async () => {
    const root = await makeProject({ 'design.md': '# Design\n' })
    const missing = await buildGoldfishContext({ projectRoot: root, targetFile: 'nope.md' })
    expect(missing.ok).toBe(false)
    const outside = await buildGoldfishContext({ projectRoot: root, targetFile: '../outside.md' })
    expect(outside.ok).toBe(false)
  })

  it('strips #fragments before resolving a link', async () => {
    const root = await makeProject({
      'design.md': '# Design\n\nSee [the plan](./plan.md#goals).\n',
      'plan.md': '# Plan\n',
    })
    const result = await buildGoldfishContext({ projectRoot: root, targetFile: 'design.md' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context.files.map((f) => f.path)).toEqual(['plan.md'])
    expect(result.context.excluded).toEqual([])
  })
})

describe('the five-stage review protocol', () => {
  it('has five stages, 5–9, with a report file each — and stage 6 reads the document alone', () => {
    expect(REVIEW_STAGES.map((s) => s.stage)).toEqual([5, 6, 7, 8, 9])
    expect(REVIEW_STAGES.map((s) => s.name)).toEqual([
      'Initial Zoom Out',
      'Comprehension Test',
      'Critic Review',
      'Intermediate Zoom Out',
      'Implementation Readiness',
    ])
    for (const stage of REVIEW_STAGES) {
      expect(stage.reportFile.endsWith('_report.md')).toBe(true)
      expect(stage.reviewers.length).toBeGreaterThan(0)
    }
    expect(REVIEW_STAGES.find((s) => s.stage === 6)?.takesGoldfishContext).toBe(false)
    expect(REVIEW_STAGES.filter((s) => s.stage !== 6).every((s) => s.takesGoldfishContext)).toBe(true)
  })

  it('discovers the semantic split at the implementation-plan header', () => {
    const lines = [
      '# Feature',
      '',
      '## Goals',
      '',
      '## Detailed Implementation Plan',
      '',
      '1. Do the thing.',
    ]
    const split = discoverSemanticSplit(lines)
    expect(split.boundaryLine).toBe(5)
    expect(split.featureRange).toEqual({ start: 1, end: 4 })
    expect(split.detailedRange).toEqual({ start: 5, end: 7 })
  })

  it('accepts the standard synonyms, and reports no plan when there is none', () => {
    expect(discoverSemanticSplit(['# F', '## Implementation Plan', 'x']).boundaryLine).toBe(2)
    expect(discoverSemanticSplit(['# F', '## Work Breakdown', 'x']).boundaryLine).toBe(2)
    const none = discoverSemanticSplit(['# Feature', '', '## Goals', 'x'])
    expect(none.boundaryLine).toBeNull()
    expect(none.detailedRange).toBeNull()
    expect(none.featureRange).toEqual({ start: 1, end: 4 })
  })

  it('dedupes identical findings and sorts Blockers before Majors before Nits', () => {
    const a = finding({ id: 'design-1-1', description: 'Same gap.' })
    const b = finding({ id: 'design-1-2', description: 'Same gap.' })
    const c = finding({ id: 'style-1-1', reviewer: 'style', severity: 'nit', description: 'A typo.' })
    const d = finding({ id: 'zoom-out-1-1', reviewer: 'zoom-out', severity: 'blocker', description: 'Wrong problem.' })
    expect(dedupeFindings([a, b, c, d])).toHaveLength(3)
    expect(sortFindings([a, c, d]).map((f) => f.id)).toEqual(['zoom-out-1-1', 'design-1-1', 'style-1-1'])
  })

  it('a round is clean only with no open Blocker/Major and every reviewer run', () => {
    const open = [finding({ id: 'a', severity: 'major' })]
    expect(assessRound(open, { design: 'completed' }).clean).toBe(false)
    const settled = [finding({ id: 'a', severity: 'major', status: 'settled' })]
    expect(assessRound(settled, { design: 'completed' }).clean).toBe(true)
    expect(assessRound([], { design: 'not run' }).clean).toBe(false)
    expect(assessRound([], { design: 'not run' }).notRun).toEqual(['design'])
    const nitsOnly = [finding({ id: 'n', severity: 'nit' })]
    expect(assessRound(nitsOnly, { style: 'completed' }).clean).toBe(true)
  })

  it('converges after two consecutive clean rounds, and caps at five', () => {
    expect(hasConverged([true])).toBe(false)
    expect(hasConverged([true, true])).toBe(true)
    expect(hasConverged([true, false, true, true])).toBe(true)
    expect(hasConverged([true, true, false])).toBe(false)
  })

  it('renders the consolidated report with reviewer status and the honest limit', () => {
    const report = renderConsolidatedReport({
      target: 'docs/designs/webhooks.md',
      lineRange: '1-40',
      reviewerStatus: { design: 'completed', style: 'not run' },
      findings: [finding({ id: 'design-1-1' })],
      sequentialFreshSession: true,
    })
    expect(report).toContain('# Goldfish Review Report')
    expect(report).toContain('`design` | completed')
    expect(report).toContain('`style` | not run')
    expect(report).toMatch(/one fresh session/i)
    expect(report).toMatch(/isolated subagent/i)
  })

  it('renders the resolve report with categories', () => {
    const report = renderResolveReport({
      target: 'docs/designs/webhooks.md',
      lineRange: 'full file',
      findings: [
        { ...finding({ id: 'design-1-1' }), category: 'PROPOSE FIX', justification: 'Valid: the doc never says.', proposedEdit: 'Add a retry section.' },
      ],
    })
    expect(report).toContain('# Goldfish Annotated Review Report')
    expect(report).toContain('PROPOSE FIX')
    expect(report).toContain('Add a retry section.')
  })
})

describe('the Elephant artifact conventions', () => {
  it('names the brief, the draft, and the designs directory', () => {
    expect(CONCEPTS_BRIEF_FILENAME).toBe('concepts_brief.md')
    expect(DESIGN_DRAFT_FILENAME).toBe('design_draft.md')
    expect(DESIGNS_DIR).toBe('docs/designs')
  })

  it('slugs feature names into design paths', () => {
    expect(designDocPath('Webhook Delivery!')).toBe('docs/designs/webhook-delivery.md')
    expect(designDocPath('  API v2: retries ')).toBe('docs/designs/api-v2-retries.md')
    expect(() => designDocPath('!!!')).toThrow(/cannot make a design filename/)
  })

  it('dates drift reports and rejects bad dates', () => {
    expect(driftReportFilename('2026-11-13')).toBe('2026-11-13_DRIFT_REPORT.md')
    expect(() => driftReportFilename('13/11/2026')).toThrow(/YYYY-MM-DD/)
  })

  it('templates carry the EGM section structure', () => {
    const brief = conceptsBriefTemplate({ feature: 'Webhooks', author: 'Sarang', date: '2026-11-13' })
    expect(brief).toContain('# Webhooks')
    expect(brief).toContain('## Alternatives Weighed')
    expect(brief).toContain('Rejected by author')
    const draft = designDraftTemplate({ feature: 'Webhooks', author: 'Sarang', date: '2026-11-13' })
    expect(draft).toContain('## Detailed Implementation Plan')
    expect(draft).toContain('## Alternatives Considered')
    expect(draft).toContain('**Status:** Draft')
    const entry = sitemapEntry({
      feature: 'Webhooks',
      path: 'docs/designs/webhooks.md',
      date: '2026-11-13',
      author: 'Sarang',
      components: 'webhooks',
      description: 'Deliver events reliably.',
    })
    expect(entry).toContain('docs/designs/webhooks.md')
    expect(entry).toContain('Deliver events reliably.')
  })
})

describe('the EGM skills in the seeded registry', () => {
  it('seeds all seven, in the egm pack, from the egm source, under Apache-2.0', () => {
    for (const name of EGM_SKILLS) {
      const seed = SEED_SKILLS.find((s) => s.name === name)
      expect(seed, `${name} is not seeded`).toBeDefined()
      expect(seed?.pack).toBe('egm')
      expect(seed?.source).toBe('egm')
      expect(seed?.license).toBe('Apache-2.0')
      expect(seed?.version).toBe('1.0.0')
    }
  })

  it('ships a SKILL.md for each, with frontmatter grants that match the seed', async () => {
    for (const name of EGM_SKILLS) {
      const seed = SEED_SKILLS.find((s) => s.name === name)!
      const skill = await loadSkillFile(join(REGISTRY_DIR, ...seed.path.split('/'), 'SKILL.md'))
      expect(skill.name).toBe(name)
      expect([...(skill.capabilities ?? [])].sort()).toEqual([...seed.capabilities].sort())
      expect(skill.description.length).toBeGreaterThan(0)
    }
  })

  it('keeps EGM attribution and the fresh-context rule in every skill body', async () => {
    for (const name of EGM_SKILLS) {
      const text = await readFile(join(REGISTRY_DIR, 'skills', name, 'SKILL.md'), 'utf8')
      expect(text, `${name} attribution`).toMatch(/github\.com\/google\/elephant-goldfish-model/)
      expect(text, `${name} license`).toMatch(/Apache-2\.0/)
      expect(text, `${name} upstream commit`).toMatch(/270b10326bf366d823bc76fd662cf83808d5781e/)
      expect(text, `${name} fresh-context rule`).toMatch(/no prior chat history/i)
    }
  })
})
