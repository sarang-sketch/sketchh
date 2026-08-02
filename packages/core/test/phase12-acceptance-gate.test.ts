// Phase 12.6 acceptance gate — the canonical booking-app flow, end to end, with the plan
// gate, the verification contract, deterministic merge/consensus, and the cost guard all
// exercised over real bytes and real child processes.
//
// THE CLAIM, from tasks.md 12.6: the canonical end-to-end flow runs with the plan gate,
// verification contract, consensus, and cost guard all observable, completing with every
// check green.
//
// ── WHAT THIS GATE PROVES ──────────────────────────────────────────────────
//
//   1. PLAN GATE (6.4). An `edit` before any plan exists is refused by the ENGINE, no
//      `edit_accepted` precedes `plan_written`, and the plan lands as real documents on
//      disk under `.sketch/plan/<runId>/`.
//   2. VERIFICATION CONTRACT (4.7). The project's own commands run as real `node` child
//      processes in contract order. A deliberately wrong implementation fails the `unit`
//      stage and the run is NOT ok; unconfigured stages are skipped and never fail it.
//   3. DETERMINISTIC MERGE AND CONSENSUS (24.7, 24.9). A swarm of verifiable roles merges
//      the union of non-conflicting proposals; two roles proposing one path is refused,
//      leaves the bytes untouched, and leaves a follow-up task instead of a guess.
//   4. COST GUARD (20.4). A budget breach stops the run with `run_failed{reason:"budget"}`
//      and `budget_exceeded`, on the same ledger the dashboard reads, and a breach never
//      escalates to a heavier strategy.
//   5. EVERY CHECK GREEN. The final run verifies the whole assembled app — including checks
//      that only pass because the merged code really exists — and completes ok.
//
// ── WHAT THIS GATE DOES NOT CLAIM ──────────────────────────────────────────
//
// * NOT that a real model built anything. Every model turn here is a scripted adapter, so
//   this is harness evidence, not evidence that a provider can build a booking product.
//   Nothing in this project has ever run against a real provider.
// * NOT that the fixture is a production application. It is a small ESM project whose
//   verification commands are real programs that genuinely fail when the code is wrong.
// * NOT that `swarm` should be on. Requirement 24.8 governs that and its verdict is still
//   off; the swarm here is explicitly requested by this test.
//
// Validates: Requirements 6.4, 4.7, 24.7, 24.9, 20.4

import { afterAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { JsonlEventStore, MemoryEventStore } from '../src/events/index.js'
import { PlanWriter } from '../src/plan/index.js'
import { DiskFileWriter } from '../src/orchestrator/file-writer.js'
import { runTask, PLAN_GATE_REASON } from '../src/loop/index.js'
import { dispatch } from '../src/strategy/index.js'
import { ledgerForRun } from '../src/cost/index.js'
import type { VerifyPolicy } from '../src/verify/index.js'
import type {
  ChatAdapter,
  Message,
  SketchEvent,
  Task,
  Usage,
  VerifyCommand,
} from '../src/types.js'

const tmpDirs: string[] = []

afterAll(async () => {
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => {})
  }
})

async function makeTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

// ── the application under construction ──────────────────────────────────────

const LISTINGS = `export function search(listings, city) {
  return listings.filter((listing) => listing.city === city)
}
`

/** Correct: nightly rate times nights, plus the cleaning fee. */
const PRICING_GOOD = `export function totalPrice(nightlyRate, nights, cleaningFee) {
  return nightlyRate * nights + cleaningFee
}
`

/** Wrong on purpose: silently drops the cleaning fee. The unit stage catches it. */
const PRICING_BAD = `export function totalPrice(nightlyRate, nights) {
  return nightlyRate * nights
}
`

const AVAILABILITY = `export function isAvailable(bookings, date) {
  return !bookings.some((booking) => booking.date === date)
}
`

const LISTING_CARD = `export function renderCard(listing) {
  return \`\${listing.title} in \${listing.city}\`
}
`

const BOOKING = `export function confirm(listing, nights) {
  return { listing: listing.id, nights, status: 'confirmed' }
}
`

// ── the project's own verification commands, as real programs ───────────────

const FORMAT_CHECK = `import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const src = fileURLToPath(new URL('../src/', import.meta.url))
const files = (await readdir(src)).filter((name) => name.endsWith('.mjs'))
const problems = []
if (files.length === 0) problems.push('src/ contains no modules')
for (const name of files) {
  const text = await readFile(join(src, name), 'utf8')
  if (text.includes('\\t')) problems.push(name + ': tab character')
  if (/[ \\t]+$/m.test(text)) problems.push(name + ': trailing whitespace')
}
if (problems.length > 0) {
  console.error(problems.join('\\n'))
  process.exit(1)
}
process.stdout.write('format ok: ' + files.length + ' module(s)\\n')
`

const LINT_CHECK = `import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const src = fileURLToPath(new URL('../src/', import.meta.url))
const files = (await readdir(src)).filter((name) => name.endsWith('.mjs'))
const problems = []
for (const name of files) {
  const text = await readFile(join(src, name), 'utf8')
  if (text.includes('TODO')) problems.push(name + ': unresolved TODO')
  if (text.includes('debugger')) problems.push(name + ': debugger statement')
}
if (problems.length > 0) {
  console.error(problems.join('\\n'))
  process.exit(1)
}
process.stdout.write('lint ok: ' + files.length + ' module(s)\\n')
`

/** Really imports every module, so a module that cannot load is a build failure. */
const BUILD_CHECK = `import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const srcUrl = new URL('../src/', import.meta.url)
const files = (await readdir(fileURLToPath(srcUrl))).filter((name) => name.endsWith('.mjs'))
if (files.length === 0) {
  console.error('nothing to build')
  process.exit(1)
}
for (const name of files) await import(new URL(name, srcUrl).href)
process.stdout.write('build ok: ' + files.length + ' module(s)\\n')
`

const UNIT_LISTINGS = `import assert from 'node:assert/strict'
import { search } from '../src/listings.mjs'

const listings = [
  { id: 'a', city: 'Lisbon' },
  { id: 'b', city: 'Porto' },
]
assert.deepEqual(search(listings, 'Lisbon').map((listing) => listing.id), ['a'])
assert.deepEqual(search(listings, 'Nowhere'), [])
process.stdout.write('unit listings ok\\n')
`

const UNIT_PRICING = `import assert from 'node:assert/strict'
import { totalPrice } from '../src/pricing.mjs'

assert.equal(totalPrice(120, 3, 60), 420)
assert.equal(totalPrice(100, 1, 0), 100)
process.stdout.write('unit pricing ok\\n')
`

const UNIT_AVAILABILITY = `import assert from 'node:assert/strict'
import { isAvailable } from '../src/availability.mjs'
import { renderCard } from '../src/listingCard.mjs'

assert.equal(isAvailable([{ date: '2026-08-04' }], '2026-08-05'), true)
assert.equal(isAvailable([{ date: '2026-08-04' }], '2026-08-04'), false)
assert.equal(renderCard({ title: 'Loft', city: 'Lisbon' }), 'Loft in Lisbon')
process.stdout.write('unit availability ok\\n')
`

const UNIT_BOOKING = `import assert from 'node:assert/strict'
import { confirm } from '../src/booking.mjs'

const receipt = confirm({ id: 'a' }, 3)
assert.equal(receipt.status, 'confirmed')
assert.equal(receipt.nights, 3)
assert.equal(receipt.listing, 'a')
process.stdout.write('unit booking ok\\n')
`

interface Project {
  root: string
  check(name: string, script: string): VerifyCommand
}

async function makeProject(): Promise<Project> {
  const root = await makeTmp('sketch-p126-')
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'checks'), { recursive: true })
  await writeFile(join(root, 'src', 'listings.mjs'), LISTINGS, 'utf8')
  await writeFile(join(root, 'checks', 'format.mjs'), FORMAT_CHECK, 'utf8')
  await writeFile(join(root, 'checks', 'lint.mjs'), LINT_CHECK, 'utf8')
  await writeFile(join(root, 'checks', 'build.mjs'), BUILD_CHECK, 'utf8')
  await writeFile(join(root, 'checks', 'unit-listings.mjs'), UNIT_LISTINGS, 'utf8')
  await writeFile(join(root, 'checks', 'unit-pricing.mjs'), UNIT_PRICING, 'utf8')
  await writeFile(join(root, 'checks', 'unit-availability.mjs'), UNIT_AVAILABILITY, 'utf8')
  await writeFile(join(root, 'checks', 'unit-booking.mjs'), UNIT_BOOKING, 'utf8')

  return {
    root,
    check: (name, script) => ({
      name,
      cmd: process.execPath,
      args: [join(root, 'checks', script)],
      cwd: root,
      timeoutMs: 30_000,
    }),
  }
}

// ── scripted model turns ────────────────────────────────────────────────────

const PLAN = JSON.stringify({
  action: 'plan',
  artifacts: {
    prd: 'Guests search listings, price a stay, and confirm a booking.',
    stories: 'As a guest I search by city, see a total price, and book available dates.',
    architecture: 'One ESM module per concern under src/, verified by checks/.',
    folders: 'src/ for modules, checks/ for the verification commands.',
    components: 'listings, pricing, availability, listing card, booking.',
    api: 'search(listings, city), totalPrice(rate, nights, fee), confirm(listing, nights).',
    schema: 'Listing { id, city, title }; Booking { date }.',
    security: 'No credentials in the app; no network calls in any module.',
    tests: 'checks/unit-*.mjs assert each module through real imports.',
    milestones: 'pricing, then availability and the card, then booking.',
    risks: 'Silent arithmetic errors; the unit stage is what catches them.',
    dependencies: 'Node built-ins only.',
  },
})
const VERIFY = JSON.stringify({ action: 'verify' })
const THINK = JSON.stringify({ action: 'think', text: 'considering the next step' })

function edit(path: string, replace: string): string {
  return JSON.stringify({ action: 'edit', edits: [{ path, search: '', replace }] })
}

function done(text: string): string {
  return JSON.stringify({ action: 'done', text })
}

/** A scripted adapter that reports a fixed, priceable usage and counts its calls. */
function scripted(options: {
  id?: string
  model?: string
  script: readonly string[]
  usage?: Usage
}): { adapter: ChatAdapter; calls: () => number } {
  let index = 0
  let calls = 0
  const adapter: ChatAdapter = {
    id: options.id ?? 'scripted',
    ...(options.model !== undefined ? { model: options.model } : {}),
    chat: async () => {
      calls += 1
      const text = options.script[Math.min(index, options.script.length - 1)]!
      index += 1
      return { text, usage: options.usage ?? { in: 12, out: 8 } }
    },
  }
  return { adapter, calls: () => calls }
}

/**
 * One adapter serving many role sub-runs, keyed on a phrase in the prompt it is handed.
 * `FakeChatAdapter` cannot do this: its script index advances globally, so the second
 * sub-run would resume the first one's script mid-sequence.
 */
class RoleAdapter implements ChatAdapter {
  readonly id = 'scripted-roles'
  readonly model = 'scripted'
  readonly served: string[] = []
  readonly #counts = new Map<string, number>()

  constructor(private readonly scripts: Record<string, readonly string[]>) {}

  async chat(messages: Message[]): Promise<{ text: string; usage?: Usage }> {
    const joined = messages.map((message) => message.content).join('\n')
    const key =
      Object.keys(this.scripts).find(
        (candidate) => candidate !== '*' && joined.includes(candidate),
      ) ?? '*'
    this.served.push(key)
    const index = this.#counts.get(key) ?? 0
    this.#counts.set(key, index + 1)
    const script = this.scripts[key] ?? this.scripts['*'] ?? [done('nothing to do')]
    return { text: script[Math.min(index, script.length - 1)]!, usage: { in: 12, out: 8 } }
  }
}

const kinds = (events: readonly SketchEvent[]): string[] => events.map((event) => event.kind)

function task(id: string, prompt: string): Task {
  return { id, prompt, verify: [] }
}

// ── the chain ───────────────────────────────────────────────────────────────

describe('Phase 12.6 acceptance — the canonical flow end to end', () => {
  it('runs plan gate, verification contract, merge, consensus, and cost guard over real bytes', async () => {
    expect(process.env.OPENAI_API_KEY ?? '').toBe('')
    expect(process.env.ANTHROPIC_API_KEY ?? '').toBe('')

    const project = await makeProject()
    const root = project.root
    const report: string[] = []

    // The JSONL store, so every claim below is made about bytes that really landed.
    const events = new JsonlEventStore({ baseDir: root, secrets: () => [] })
    const plan = new PlanWriter({ baseDir: root, events })
    const files = new DiskFileWriter()

    /** The project's contract: four configured stages, five deliberately unconfigured. */
    const policy: VerifyPolicy = {
      format: [project.check('format', 'format.mjs')],
      lint: [project.check('lint', 'lint.mjs')],
      build: [project.check('build', 'build.mjs')],
      unit: [
        project.check('unit-listings', 'unit-listings.mjs'),
        project.check('unit-pricing', 'unit-pricing.mjs'),
      ],
    }

    // ── (1) THE PLAN GATE, IN THE ENGINE (6.4) ──────────────────────────────
    //
    // The first turn tries to write code before any plan exists. The engine asks the
    // filesystem, refuses, and feeds the refusal back; the model then plans and retries.
    const first = scripted({
      script: [
        edit('src/pricing.mjs', PRICING_GOOD),
        PLAN,
        edit('src/pricing.mjs', PRICING_GOOD),
        VERIFY,
        done('pricing implemented and verified'),
      ],
    })
    const build = await runTask(
      task('acceptance-pricing', 'Add total pricing for a stay, with its cleaning fee.'),
      { adapter: first.adapter, events, plan, files, root, verifyPolicy: policy, maxIterations: 8 },
    )

    const order = kinds(build.events)
    const rejected = build.events.filter((event) => event.kind === 'edit_rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.payload['reason']).toBe(PLAN_GATE_REASON)
    // The refusal came BEFORE any plan, and nothing was accepted before the plan existed.
    expect(order.indexOf('edit_rejected')).toBeLessThan(order.indexOf('plan_written'))
    expect(order.indexOf('edit_accepted')).toBeGreaterThan(order.indexOf('plan_written'))
    expect(
      order.slice(0, order.indexOf('plan_written')).includes('edit_accepted'),
    ).toBe(false)

    // The plan is real documents on disk for THIS run, not a flag (6.1–6.3).
    const planned = await readdir(join(root, '.sketch', 'plan', build.runId))
    expect(planned).toContain('prd.md')
    expect(planned.length).toBe(12)
    expect(await readFile(join(root, '.sketch', 'plan', build.runId, 'prd.md'), 'utf8')).toContain(
      'Guests search listings',
    )
    expect(await plan.hasPlan(build.runId)).toBe(true)

    // The run is green, and it is green because real child processes said so.
    expect(build.ok).toBe(true)
    expect(await readFile(join(root, 'src', 'pricing.mjs'), 'utf8')).toBe(PRICING_GOOD)
    const buildStages = build.events.find((event) => event.kind === 'run_completed')!.payload[
      'policy'
    ] as { ok: boolean; ranStages: string[]; verifiedAnything: boolean }
    expect(buildStages.ok).toBe(true)
    expect(buildStages.verifiedAnything).toBe(true)
    expect(buildStages.ranStages).toEqual(['format', 'lint', 'build', 'unit'])
    expect(kinds(build.events).filter((kind) => kind === 'run_completed' || kind === 'run_failed'))
      .toHaveLength(1)
    report.push(
      `  plan gate: edit refused before plan, ${planned.length} plan document(s), then accepted`,
    )
    report.push(`  contract: ${buildStages.ranStages.join(' → ')} all passed on real processes`)

    // ── (2) THE CONTRACT REFUSES WRONG CODE (4.7) ───────────────────────────
    //
    // Same project, same contract, an implementation that silently drops the cleaning fee.
    // The model says it is done; the `unit` stage disagrees, and the run is not ok.
    const broken = scripted({
      script: [PLAN, edit('src/pricing.mjs', PRICING_BAD), VERIFY, done('pricing simplified')],
    })
    const brokenRun = await runTask(
      task('acceptance-regression', 'Simplify the pricing function.'),
      { adapter: broken.adapter, events, plan, files, root, verifyPolicy: policy, maxIterations: 8 },
    )

    expect(brokenRun.ok).toBe(false)
    const brokenTerminal = brokenRun.events.find((event) => event.kind === 'run_failed')!
    expect(brokenTerminal.payload['reason']).toBe('verify_failed')
    const brokenPolicy = brokenTerminal.payload['policy'] as {
      ok: boolean
      failedStage: string | null
      stages: Array<{ stage: string; status: string }>
    }
    expect(brokenPolicy.ok).toBe(false)
    expect(brokenPolicy.failedStage).toBe('unit')
    // Earlier stages really passed; the five unconfigured stages are skipped, and a skipped
    // stage is not a failure (4.4). The failure is the wrong arithmetic, nothing else.
    const status = (stage: string): string =>
      brokenPolicy.stages.find((entry) => entry.stage === stage)!.status
    expect([status('format'), status('lint'), status('build')]).toEqual([
      'passed',
      'passed',
      'passed',
    ])
    expect(status('unit')).toBe('failed')
    expect(status('typecheck')).toBe('skipped')
    expect(status('performance')).toBe('skipped')
    const failedResult = brokenRun.verify.find((entry) => !entry.ok)!
    expect(failedResult.name).toBe('unit-pricing')
    expect(failedResult.exitCode).not.toBe(0)
    report.push(
      `  contract: wrong pricing failed the "${brokenPolicy.failedStage}" stage ` +
        `(${failedResult.name}), run not ok`,
    )

    // Restore the project. The breakage above was deliberate and its evidence is captured;
    // the rest of the chain builds on correct code.
    await writeFile(join(root, 'src', 'pricing.mjs'), PRICING_GOOD, 'utf8')

    // ── (3) THE SWARM MERGES THE UNION (24.7, 24.9) ─────────────────────────
    //
    // Six roles, every one of them graded by a signal this project really configures:
    // Documentation by `format`, Backend and Testing by `unit`, Frontend by `build`, and
    // Security and Reviewer by anchored citations.
    const swarmAdapter = new RoleAdapter({
      'as the Backend role': [
        PLAN,
        edit('src/availability.mjs', AVAILABILITY),
        VERIFY,
        done('availability implemented'),
      ],
      'as the Frontend role': [
        PLAN,
        edit('src/listingCard.mjs', LISTING_CARD),
        VERIFY,
        done('listing card implemented'),
      ],
      'as the Testing role': [
        PLAN,
        edit('checks/unit-stay.mjs', UNIT_AVAILABILITY),
        VERIFY,
        done('stay checks written'),
      ],
      'as the Documentation role': [
        PLAN,
        edit('BOOKING.md', '# Booking\n\nSearch, price, check availability, confirm.\n'),
        VERIFY,
        done('documentation updated'),
      ],
      'as the Security role': [PLAN, done('no credentials and no network use. NO FINDINGS')],
      'as the Reviewer role': [PLAN, done('the modules match the plan. NO FINDINGS')],
      '*': [PLAN, done('nothing to add. NO FINDINGS')],
    })

    const swarm = await dispatch(
      task('acceptance-swarm', 'Add availability, a listing card, its checks, and the docs.'),
      {
        adapter: swarmAdapter,
        events,
        plan,
        files,
        root,
        verifyPolicy: policy,
        strategy: 'swarm',
        roles: ['backend', 'frontend', 'testing', 'documentation', 'security', 'reviewer'],
        maxIterations: 8,
        dispatchId: 'acceptance-swarm-1',
      },
    )

    expect(swarm.ok).toBe(true)
    expect(swarm.succeeded).toBe('swarm')
    const attempt = swarm.attempts.at(-1)!
    // Every requested role ran: none was skipped for want of a verification signal.
    expect(attempt.roles.filter((role) => role.ran).map((role) => role.role)).toEqual([
      'backend',
      'frontend',
      'testing',
      'documentation',
      'security',
      'reviewer',
    ])
    expect(attempt.roles.every((role) => role.grade?.passed === true)).toBe(true)
    // Consensus is real and it ran only because this is `swarm` (24.9).
    expect(attempt.consensus).not.toBeNull()
    expect(attempt.consensus!.reached).toBe(true)
    expect(attempt.consensus!.dissenting).toEqual([])
    expect(attempt.consensus!.blockers).toEqual([])
    // The union of non-conflicting proposals, and nothing invented.
    expect(attempt.merge!.ok).toBe(true)
    expect(attempt.merge!.conflicts).toEqual([])
    expect(attempt.merge!.applied.map((entry) => entry.path).sort()).toEqual([
      'BOOKING.md',
      'checks/unit-stay.mjs',
      'src/availability.mjs',
      'src/listingCard.mjs',
    ])
    // The merged change was verified ONCE, as a whole, and passed.
    expect(attempt.verify!.ok).toBe(true)
    expect(attempt.verify!.ranStages).toEqual(['format', 'lint', 'build', 'unit'])
    expect(await readFile(join(root, 'src', 'availability.mjs'), 'utf8')).toBe(AVAILABILITY)
    expect(await readFile(join(root, 'src', 'listingCard.mjs'), 'utf8')).toBe(LISTING_CARD)

    // The Timeline reconstructs from events alone, so consensus/merge/verification must be
    // on the dispatcher's durable outcome event rather than only on this return object.
    const swarmOutcome = swarm.events.find((event) => event.payload['phase'] === 'outcome')!
    const visibleAttempt = (swarmOutcome.payload['attempts'] as Array<{
      consensus?: { reached: boolean; agreeing: string[]; dissenting: string[]; blockerRoles: string[] }
      merge?: { ok: boolean; applied: string[]; conflicts: unknown[] }
      verify?: { ok: boolean; ranStages: string[]; verifiedAnything: boolean }
    }>)[0]!
    expect(visibleAttempt.consensus).toEqual({
      reached: true,
      agreeing: ['backend', 'frontend', 'testing', 'documentation', 'security', 'reviewer'],
      dissenting: [],
      blockerRoles: [],
      reason: attempt.consensus!.reason,
    })
    expect(visibleAttempt.merge).toEqual({
      ok: true,
      applied: ['BOOKING.md', 'checks/unit-stay.mjs', 'src/availability.mjs', 'src/listingCard.mjs'],
      conflicts: [],
    })
    expect(visibleAttempt.verify).toEqual({
      ok: true,
      failedStage: null,
      ranStages: ['format', 'lint', 'build', 'unit'],
      verifiedAnything: true,
    })
    report.push(
      `  swarm: ${attempt.roles.filter((role) => role.ran).length} verified roles, ` +
        `${attempt.merge!.applied.length} files merged, consensus reached, merged change verified`,
    )

    // ── (4) A CONFLICT IS REFUSED, NOT GUESSED (24.7) ───────────────────────
    //
    // Two roles propose the same path from the same bytes. The action protocol emits
    // whole-file replacements, so combining them would mean inventing which lines belonged
    // to whom. Nothing is written and a follow-up task carries the decision out.
    const beforeConflict = await readFile(join(root, 'src', 'availability.mjs'), 'utf8')
    const clashing = new RoleAdapter({
      'as the Backend role': [
        PLAN,
        edit('src/availability.mjs', AVAILABILITY.replace('!bookings', '!!!bookings')),
        VERIFY,
        done('availability rewritten'),
      ],
      'as the Testing role': [
        PLAN,
        edit('src/availability.mjs', `${AVAILABILITY}\nexport const source = 'testing'\n`),
        VERIFY,
        done('availability rewritten differently'),
      ],
      '*': [PLAN, done('nothing to add. NO FINDINGS')],
    })

    const conflicted = await dispatch(
      task('acceptance-conflict', 'Rework availability.'),
      {
        adapter: clashing,
        events,
        plan,
        files,
        root,
        verifyPolicy: policy,
        strategy: 'swarm',
        roles: ['backend', 'testing'],
        maxIterations: 8,
        dispatchId: 'acceptance-swarm-2',
      },
    )

    expect(conflicted.ok).toBe(false)
    const clash = conflicted.attempts.at(-1)!
    expect(clash.reason).toBe('merge_conflict')
    expect(clash.merge!.ok).toBe(false)
    expect(clash.merge!.applied).toEqual([])
    expect(clash.merge!.conflicts).toHaveLength(1)
    expect(clash.merge!.conflicts[0]!.path).toBe('src/availability.mjs')
    expect(clash.merge!.conflicts[0]!.code).toBe('multiple-proposers')
    expect(clash.merge!.conflicts[0]!.roles.sort()).toEqual(['backend', 'testing'])
    // A task, not a guess — and the bytes on disk are exactly what they were.
    expect(conflicted.followUps).toHaveLength(1)
    expect(conflicted.followUps[0]!.origin).toBe('merge-conflict')
    expect(conflicted.followUps[0]!.paths).toEqual(['src/availability.mjs'])
    expect(await readFile(join(root, 'src', 'availability.mjs'), 'utf8')).toBe(beforeConflict)
    report.push(
      `  merge: 2 proposals for 1 path refused as ${clash.merge!.conflicts[0]!.code}, ` +
        `1 follow-up task, bytes unchanged`,
    )

    // ── (5) THE COST GUARD STOPS THE RUN (20.4) ─────────────────────────────
    //
    // A priced model, a ceiling, and a script that would never finish on its own. What ends
    // this run is the budget, and the spend it stops on is the ledger's own number.
    const expensive = scripted({
      id: 'openai',
      model: 'gpt-4o',
      script: [PLAN, THINK, THINK, THINK, THINK, done('never reached')],
      usage: { in: 200_000, out: 50_000 },
    })
    const budget = { maxTokens: 600_000, onBreach: 'stop' as const }
    const stopped = await runTask(
      task('acceptance-budget', 'Do expensive work forever.'),
      {
        adapter: expensive.adapter,
        events,
        plan,
        files,
        root,
        verifyPolicy: policy,
        maxIterations: 10,
        budget,
      },
    )

    expect(stopped.ok).toBe(false)
    const stoppedTerminal = stopped.events.find((event) => event.kind === 'run_failed')!
    expect(stoppedTerminal.payload['reason']).toBe('budget')
    expect(stopped.iterations).toBeLessThan(10)
    const exceeded = stopped.events.find((event) => event.kind === 'budget_exceeded')!
    expect(exceeded.payload['limit']).toBe('tokens')
    expect(exceeded.payload['configured']).toBe('stop')
    expect(exceeded.payload['outcome']).toBe('stopped')
    // One ledger, not two counters: the number that stopped the run is the number the
    // dashboard shows for it.
    const ledger = ledgerForRun(stopped.events, stopped.runId)
    const spent = exceeded.payload['spent'] as { tokens: number; usd: number; calls: number }
    expect(spent.tokens).toBe(ledger.tokensIn + ledger.tokensOut)
    expect(spent.usd).toBe(ledger.usd)
    expect(spent.calls).toBe(ledger.calls)
    report.push(
      `  cost guard: stopped on the tokens ceiling after ${spent.calls} call(s), ` +
        `spent ${spent.tokens} tokens = the ledger's own figure`,
    )

    // A breach is NOT a failure "within budget", so it never buys a heavier strategy (24.3).
    const noEscalation = await dispatch(
      task('acceptance-budget-ladder', 'Do expensive work forever.'),
      {
        adapter: scripted({
          id: 'openai',
          model: 'gpt-4o',
          script: [PLAN, THINK, THINK, THINK, done('never reached')],
          usage: { in: 200_000, out: 50_000 },
        }).adapter,
        events,
        plan,
        files,
        root,
        verifyPolicy: policy,
        strategy: 'single',
        escalate: true,
        budget,
        maxIterations: 10,
        dispatchId: 'acceptance-budget-ladder-1',
      },
    )
    expect(noEscalation.ok).toBe(false)
    expect(noEscalation.attempts).toHaveLength(1)
    expect(noEscalation.attempts[0]!.reason).toBe('budget')
    expect(noEscalation.finalText).toContain('did not fail within its budget')
    report.push('  cost guard: a breach did not escalate to a heavier strategy')

    // ── (6) EVERY CHECK GREEN ON THE ASSEMBLED APP ──────────────────────────
    //
    // The final contract adds the checks that only pass because the merged code really
    // exists, plus the booking check the last run has to earn.
    const finalPolicy: VerifyPolicy = {
      ...policy,
      unit: [
        ...policy.unit!,
        project.check('unit-availability', 'unit-availability.mjs'),
        project.check('unit-booking', 'unit-booking.mjs'),
      ],
    }
    const finish = scripted({
      script: [PLAN, edit('src/booking.mjs', BOOKING), VERIFY, done('booking confirmed end to end')],
    })
    const green = await runTask(
      task('acceptance-booking', 'Confirm a booking for an available listing.'),
      {
        adapter: finish.adapter,
        events,
        plan,
        files,
        root,
        verifyPolicy: finalPolicy,
        maxIterations: 8,
      },
    )

    expect(green.ok).toBe(true)
    expect(green.finalText).toBe('booking confirmed end to end')
    const greenPolicy = green.events.find((event) => event.kind === 'run_completed')!.payload[
      'policy'
    ] as { ok: boolean; failedStage: string | null; ranStages: string[] }
    expect(greenPolicy.ok).toBe(true)
    expect(greenPolicy.failedStage).toBeNull()
    expect(greenPolicy.ranStages).toEqual(['format', 'lint', 'build', 'unit'])
    // Five real programs, every one of them green, including the two that depend on the
    // swarm's merged modules.
    expect(green.verify.map((entry) => entry.name)).toEqual([
      'format',
      'lint',
      'build',
      'unit-listings',
      'unit-pricing',
      'unit-availability',
      'unit-booking',
    ])
    expect(green.verify.every((entry) => entry.ok)).toBe(true)
    expect(kinds(green.events).filter((kind) => kind === 'run_completed' || kind === 'run_failed'))
      .toHaveLength(1)

    // The whole app is on disk, written by the runs above and nothing else.
    const modules = (await readdir(join(root, 'src'))).sort()
    expect(modules).toEqual([
      'availability.mjs',
      'booking.mjs',
      'listingCard.mjs',
      'listings.mjs',
      'pricing.mjs',
    ])
    report.push(
      `  green: ${green.verify.length} real checks passed over ${modules.length} modules, run ok`,
    )

    // Every claim above was made about persisted events, not in-memory hopes.
    const persisted = await events.readAll()
    expect(persisted.length).toBeGreaterThan(0)
    for (const runId of [build.runId, brokenRun.runId, stopped.runId, green.runId]) {
      const slice = await events.forRun(runId)
      expect(
        slice.filter((event) => event.kind === 'run_completed' || event.kind === 'run_failed'),
      ).toHaveLength(1)
    }

    console.log(
      [
        '[phase 12.6 acceptance] the canonical flow, offline, no key:',
        ...report,
        '  NOT PROVED: every model turn was scripted. This is harness evidence, not evidence',
        '  that a real provider can build a booking product.',
      ].join('\n'),
    )
  }, 120_000)

  it('keeps the budget stop deterministic across identical runs (20.4)', async () => {
    const project = await makeProject()
    const budget = { maxTokens: 400_000, onBreach: 'stop' as const }

    const outcomes: Array<{ reason: unknown; limit: unknown; outcome: unknown; calls: number }> = []
    for (const attempt of [1, 2]) {
      const events = new MemoryEventStore({ secrets: [] })
      const result = await runTask(
        task(`budget-determinism-${attempt}`, 'Do expensive work forever.'),
        {
          adapter: scripted({
            id: 'openai',
            model: 'gpt-4o',
            script: [PLAN, THINK, THINK, THINK, done('never reached')],
            usage: { in: 150_000, out: 50_000 },
          }).adapter,
          events,
          plan: new PlanWriter({ baseDir: project.root, events }),
          files: new DiskFileWriter(),
          root: project.root,
          maxIterations: 10,
          budget,
        },
      )
      const exceeded = result.events.find((event) => event.kind === 'budget_exceeded')!
      const failed = result.events.find((event) => event.kind === 'run_failed')!
      outcomes.push({
        reason: failed.payload['reason'],
        limit: exceeded.payload['limit'],
        outcome: exceeded.payload['outcome'],
        calls: (exceeded.payload['spent'] as { calls: number }).calls,
      })
    }

    // Same configuration, same ceiling, same stop — by configuration, not by luck (20.4).
    expect(outcomes[0]).toEqual(outcomes[1])
    expect(outcomes[0]!.reason).toBe('budget')
    expect(outcomes[0]!.outcome).toBe('stopped')
  }, 60_000)
})
