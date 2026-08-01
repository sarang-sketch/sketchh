// Phase 6 gate — signed install, scope enforcement, and a trainer that measures.
//
// THE THREE CLAIMS, from tasks.md 6.7:
//   1. Signed install works and tamper is refused (Requirement 11.2).
//   2. Capability scopes are enforced at the point of execution (Requirement 11.5).
//   3. The trainer accepts an improvement and rejects a regression (Requirement 9.8).
//
// All three offline, with no API key.
//
// ── ONE CHAIN, NOT THREE TESTS ──────────────────────────────────────────────
//
// Section 1 runs them as a single sequence over the SHIPPED registry, because the
// interesting failures live in the joins: a skill can install and then be granted
// the wrong thing; a grant can be right in the manifest and not reach the
// dispatcher; a trained skill can quietly acquire capabilities its installed
// version never had. Each of those is invisible if the three are tested apart.
//
//   the shipped registry → verify the pinned digest → install into a real project
//     → load the installed skill off disk → resolve ITS grant
//     → a real `runTask` in which a denied tool is denied and a granted one runs
//     → train the same skill on captured evals through the strict gate
//     → assert the winner's grant is still the installed one
//
// ── WHAT IS REAL HERE ───────────────────────────────────────────────────────
//
// The registry is the one this package ships. The digests are recomputed from the
// bytes on disk by `node:crypto`. The install writes real files. The loader reads
// them back. `runTask` is the real loop. The trainer is the real trainer with the
// real strict `>` gate. The only substituted collaborator is the model, which is
// what makes this cost nothing and run with the network cable out.
//
// ── WHAT THIS GATE DOES NOT CLAIM ───────────────────────────────────────────
//
// * NOT a signature. The registry is a CONTENT PIN: it proves what you install
//   matches the manifest, not who wrote the manifest. Signed releases are 26.3 and
//   nothing in this repository signs anything yet.
// * NOT a proof that a hostile skill cannot escape. It proves the dispatcher denies
//   an ungranted call. The tool layer that would actually touch the network and the
//   filesystem is 7.3; today the enforcement point exists and the tools do not, so
//   what is proved is the gate, not the sandbox.
// * NOT a real-model training run. `proposeEdit` is driven by the scripted fake, so
//   what is measured is the GATE's arithmetic, not an optimizer's quality.
//
// Validates: Requirements 11.2, 11.5, 9.8, 11.4, 9.3, 9.4
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SEED_REGISTRY_DIR,
  hashSkillDirectory,
  installSkill,
  installedSkillsDir,
  loadManifest,
  verifySkill,
} from '../src/registry/index.js'
import {
  CAPABILITIES,
  ToolDispatcher,
  capabilitiesForSkill,
  type Capability,
  type ToolDescriptor,
} from '../src/capabilities/index.js'
import { loadSkills, providerProposeEdit, trainSkill } from '../src/skills/index.js'
import { MemoryEventStore } from '../src/events/index.js'
import { DiskFileWriter } from '../src/orchestrator/file-writer.js'
import { PlanWriter } from '../src/plan/index.js'
import { runTask } from '../src/loop/index.js'
import { FakeChatAdapter } from '../src/providers/fake.js'
import type { ChatAdapter, EvalCase, SketchEvent } from '../src/types.js'

/** The registry this package ships. */
const REGISTRY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', SEED_REGISTRY_DIR)

/** The seed the chain follows: local git only, so its grant is interesting. */
const SUBJECT = 'commit-context'

const tmpDirs: string[] = []

afterAll(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-phase6-'))
  tmpDirs.push(dir)
  return dir
}

/** A tool that records whether it was actually reached. */
function probe(name: string, requires: Capability) {
  const state = { ran: 0 }
  const tool: ToolDescriptor = {
    name,
    description: `probe requiring ${requires}`,
    requires,
    run: async () => {
      state.ran += 1
      return { ok: true, output: `${name} ran` }
    },
  }
  return { tool, state }
}

const DONE = JSON.stringify({ action: 'done', text: 'finished' })
const toolAction = (name: string) => JSON.stringify({ action: 'tool', name, args: {} })

const kinds = (events: readonly SketchEvent[]) => events.map((event) => event.kind)

// ── 1. the chain ────────────────────────────────────────────────────────────

describe('Phase 6 gate — install, enforce, train', () => {
  it('runs the whole chain offline, with no key', async () => {
    // Offline and unkeyed, asserted rather than assumed.
    expect(process.env.ANTHROPIC_API_KEY ?? '').toBe('')
    expect(process.env.OPENAI_API_KEY ?? '').toBe('')

    const project = await makeProject()
    const events = new MemoryEventStore({ secrets: [] })
    const report: string[] = []

    // ── (a) the shipped registry, verified ────────────────────────────────
    const { manifest, dir } = await loadManifest(REGISTRY_DIR)
    expect(manifest.distribution).toBe('curated')
    const entry = manifest.entries.find((candidate) => candidate.name === SUBJECT)!
    expect(entry).toBeDefined()

    const recomputed = await hashSkillDirectory(join(dir, ...entry.path.split('/')))
    expect(recomputed.digest).toBe(entry.digest)
    const verified = await verifySkill(join(dir, ...entry.path.split('/')), entry, entry.files)
    expect(verified.ok).toBe(true)
    report.push(
      `  pinned ${entry.name} v${entry.version}: ${entry.digest.slice(0, 19)}… over ${recomputed.files.length} file(s)`,
    )

    // ── (b) install ───────────────────────────────────────────────────────
    const install = await installSkill({
      manifest,
      registryDir: dir,
      name: SUBJECT,
      projectRoot: project,
      events,
      runId: 'gate-install',
    })
    expect(install.reason).toBeNull()
    expect(install.ok).toBe(true)
    expect(install.granted).toEqual(['fs:read:project', 'git:read'])
    report.push(`  installed into ${install.dir}, granted ${install.granted!.join(', ')}`)

    // ── (c) the installed skill, read back off disk ───────────────────────
    const loaded = await loadSkills(installedSkillsDir(project))
    expect(loaded.diagnostics).toEqual([])
    const skill = loaded.skills.find((candidate) => candidate.name === SUBJECT)!
    expect(skill.body.length).toBeGreaterThan(400)

    // The GRANT the dispatcher will enforce comes from the manifest, not from the
    // skill's own frontmatter. They agree here — asserted — and the manifest is
    // what wins if they ever do not.
    const declared = capabilitiesForSkill(skill.capabilities)
    expect(declared.ok).toBe(true)
    expect([...declared.capabilities].sort()).toEqual([...install.granted!].sort())
    const granted = install.granted!

    // ── (d) enforcement, inside a real run ────────────────────────────────
    const gitTool = probe('git-log', 'git:read')
    const netTool = probe('http-get', 'net:http')
    const fsWriteTool = probe('write-home', 'fs:write:home')

    const adapter = new FakeChatAdapter({
      script: [
        toolAction('http-get'), // denied: not granted
        toolAction('write-home'), // denied: not granted
        toolAction('git-log'), // permitted: granted
        DONE,
      ],
    })

    const run = await runTask(
      { id: 'gate', prompt: 'Explain why this file looks like this.', verify: [] },
      {
        adapter,
        events,
        plan: new PlanWriter({ baseDir: project, events }),
        files: new DiskFileWriter(),
        root: project,
        maxIterations: 6,
        skills: [skill],
        tools: new ToolDispatcher({
          tools: [gitTool.tool, netTool.tool, fsWriteTool.tool],
          granted,
          root: project,
          events,
          skill: skill.name,
        }),
      },
    )

    // The run completed. A denial degrades a skill; it does not break a task.
    expect(run.ok).toBe(true)
    // Two denials, one permitted call, and the ungranted tools never ran.
    const denied = run.events.filter((event) => event.kind === 'tool_denied')
    expect(denied).toHaveLength(2)
    expect(denied.map((event) => event.payload.missing)).toEqual(['net:http', 'fs:write:home'])
    expect(netTool.state.ran).toBe(0)
    expect(fsWriteTool.state.ran).toBe(0)
    expect(gitTool.state.ran).toBe(1)
    // Every denial names the skill whose grant it was.
    for (const event of denied) expect(event.payload.skill).toBe(SUBJECT)
    // And the permitted call is on the log twice: announced, then resolved.
    const called = run.events.filter((event) => event.kind === 'tool_called')
    expect(called.map((event) => event.payload.phase)).toEqual(['start', 'result'])
    report.push(
      `  run ${run.runId}: 2 denied (net:http, fs:write:home), 1 permitted (git:read), run ok`,
    )

    // ── (e) train the same skill through the strict gate ──────────────────
    const cases: EvalCase[] = ['a', 'b', 'c', 'd'].map((id) => ({
      id,
      task: { id, prompt: 'Say the word SHA.', verify: [] },
      checks: [{ kind: 'contains', text: 'SHA' }],
    }))

    const trained = await trainSkill({
      // A body that does NOT mention the word the checks look for, so there is a
      // real improvement available to find.
      seed: { ...skill, body: 'Read the history and report what it says.' },
      cases,
      epochs: 1,
      events,
      adapter: bodyEchoAdapter(),
      maxIterations: 2,
      proposeEdit: providerProposeEdit({
        adapter: new FakeChatAdapter({
          script: [
            '```skill\nQuote the SHA of every commit you cite, and say when the history is silent.\n```',
          ],
        }),
      }),
    })

    expect(trained.baselineValScore).toBe(0)
    expect(trained.valScore).toBe(1)
    expect(trained.improved).toBe(true)
    expect(trained.epochs[0]!.verdict).toBe('accepted')

    // ── (f) THE JOIN THAT MATTERS: training did not widen the grant ───────
    expect(trained.skill.capabilities).toEqual(skill.capabilities)
    expect(trained.artifact).not.toContain('net:http')
    report.push(
      `  trained ${SUBJECT}: held-out ${trained.baselineValScore.toFixed(3)} → ${trained.valScore.toFixed(3)}, ` +
        `grant unchanged (${trained.skill.capabilities?.join(', ')})`,
    )

    // eslint-disable-next-line no-console
    console.log(['[phase 6 gate] the chain, offline, no key:', ...report].join('\n'))
  })

  it('refuses the same install when one byte of the skill changed', async () => {
    // Requirement 11.2, against the SHIPPED registry rather than a fixture: copy it,
    // tamper with the copy, and watch the install refuse and name the file.
    const { manifest, dir } = await loadManifest(REGISTRY_DIR)
    const entry = manifest.entries.find((candidate) => candidate.name === SUBJECT)!

    const copy = await makeProject()
    const skillDir = join(copy, ...entry.path.split('/'))
    const original = await readFile(join(dir, ...entry.path.split('/'), 'SKILL.md'), 'utf8')
    await writeFile(join(copy, 'registry-note.txt'), 'scratch\n', 'utf8')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), `${original}\nOne appended line.\n`, 'utf8')

    const project = await makeProject()
    const result = await installSkill({
      manifest,
      registryDir: copy,
      name: SUBJECT,
      projectRoot: project,
      pinnedFiles: entry.files,
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('refusing to install')
    expect(result.reason).toContain('SKILL.md')
    expect(result.written).toEqual([])
    const { readdir } = await import('node:fs/promises')
    await expect(readdir(installedSkillsDir(project))).rejects.toThrow()
  })

  it('rejects a regression and keeps the incumbent (Requirement 9.8)', async () => {
    const cases: EvalCase[] = ['a', 'b', 'c', 'd'].map((id) => ({
      id,
      task: { id, prompt: 'Say the word SHA.', verify: [] },
      checks: [{ kind: 'contains', text: 'SHA' }],
    }))

    const incumbent = 'Quote the SHA of every commit you cite.'
    const result = await trainSkill({
      seed: { name: SUBJECT, description: 'd', body: incumbent, source: 'test' },
      cases,
      epochs: 1,
      events: new MemoryEventStore({ secrets: [] }),
      adapter: bodyEchoAdapter(),
      maxIterations: 2,
      proposeEdit: providerProposeEdit({
        adapter: new FakeChatAdapter({
          // Tidier prose that drops the token the checks depend on.
          script: ['```skill\nQuote the identifier of every commit you cite, and be brief.\n```'],
        }),
      }),
    })

    expect(result.baselineValScore).toBe(1)
    expect(result.epochs[0]!.verdict).toBe('rejected')
    expect(result.improved).toBe(false)
    expect(result.skill.body).toBe(incumbent)
  })

  it('rejects a tie, which is the anti-rot mechanism (Requirements 9.3, 9.4)', async () => {
    // A `>=` gate would let a random walk of equal-scoring candidates ratchet a
    // skill into decay one harmless-looking step at a time. Flip `>` to `>=` in
    // `trainer.ts` and this fails — the mutation is recorded in tasks-executed.md.
    const cases: EvalCase[] = ['a', 'b', 'c', 'd'].map((id) => ({
      id,
      task: { id, prompt: 'Say the word SHA.', verify: [] },
      checks: [{ kind: 'contains', text: 'SHA' }],
    }))

    const incumbent = 'Quote the SHA of every commit you cite.'
    const result = await trainSkill({
      seed: { name: SUBJECT, description: 'd', body: incumbent, source: 'test' },
      cases,
      epochs: 1,
      events: new MemoryEventStore({ secrets: [] }),
      adapter: bodyEchoAdapter(),
      maxIterations: 2,
      proposeEdit: providerProposeEdit({
        adapter: new FakeChatAdapter({
          // Different words, same score: still mentions SHA, so it ties at 1.0.
          script: ['```skill\nAlways quote the SHA. Different wording, identical score.\n```'],
        }),
      }),
    })

    expect(result.epochs[0]!.candidateScore).toBe(result.epochs[0]!.incumbentScore)
    expect(result.epochs[0]!.verdict).toBe('rejected')
    expect(result.skill.body).toBe(incumbent)
  })

  it('keeps the vocabulary reachable, so the gate is not passing by denying everything', async () => {
    // A capability system that denies unconditionally passes every denial test and
    // is useless. Granted everything, every probe runs.
    const project = await makeProject()
    const probes = CAPABILITIES.map((capability) => probe(`probe-${capability}`, capability))
    const dispatcher = new ToolDispatcher({
      tools: probes.map((entry) => entry.tool),
      granted: CAPABILITIES,
      root: project,
    })

    for (const entry of probes) {
      expect((await dispatcher.call(entry.tool.name)).denied, entry.tool.name).toBeNull()
    }
    expect(probes.every((entry) => entry.state.ran === 1)).toBe(true)
  })

  it('keeps the trainer off the hot path (Requirement 9.6)', async () => {
    // Structural: nothing under `src/loop/` may import the trainer or the optimizer.
    // A trainer call inside a run would multiply every user task by `epochs × |cases|`
    // model calls, and the user would never know why their task cost what it did.
    const loopDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'loop')
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(loopDir)
    for (const file of files.filter((name) => name.endsWith('.ts'))) {
      const source = await readFile(join(loopDir, file), 'utf8')
      expect(source, file).not.toContain('trainer.js')
      expect(source, file).not.toContain('optimizer.js')
      expect(source, file).not.toContain('trainSkill')
    }
  })
})

/**
 * A model that echoes the skill body back as its `done` text.
 *
 * That is what makes an eval score a measurement of the BODY: a case whose check
 * looks for a word passes exactly when the body contains it. An instrument, not a
 * model — the same discipline as the Phase 5 gate's context probe, and it is why
 * this gate measures the trainer's arithmetic rather than a model's mood.
 */
function bodyEchoAdapter(): ChatAdapter {
  return {
    id: 'body-echo',
    chat: async (messages) => {
      const body = messages
        .filter((message) => message.role === 'system' && message.content.startsWith('# Skill:'))
        .map((message) => message.content)
        .join('\n')
      return { text: JSON.stringify({ action: 'done', text: body }), usage: { in: 1, out: 1 } }
    },
  }
}

void kinds
