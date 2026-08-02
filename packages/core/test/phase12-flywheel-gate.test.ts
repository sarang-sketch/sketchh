// Phase 12.4 preparation gate: one community-format skill moves through the
// local flywheel without an HTTP server, hosted provider, or Sketch account.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runEval } from '../src/evals/runner.js'
import { captureRunAsEval, evalsFilePath, loadEvalCases } from '../src/evals/capture.js'
import { MemoryEventStore } from '../src/events/index.js'
import { runTask } from '../src/loop/index.js'
import { DiskFileWriter } from '../src/orchestrator/file-writer.js'
import { PlanWriter } from '../src/plan/index.js'
import { METHODS } from '../src/rpc/methods.js'
import { createMethodContext } from '../src/rpc/server.js'
import {
  hashSkillDirectory,
  installedSkillGrantPath,
  installedSkillsDir,
  readInstalledSkillGrant,
  serializeManifest,
  trainingArtifactPath,
  type RegistryManifest,
} from '../src/registry/index.js'
import { loadSkills, scriptedProposeEdit, trainSkill } from '../src/skills/index.js'
import type { ChatAdapter, RunResult, Skill } from '../src/types.js'

const roots: string[] = []
const NAME = 'community-reviewer'
const WINNER = 'COMMUNITY-WINNER'

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true })
})

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function methodContext(root: string) {
  const frames: unknown[] = []
  const diagnostics: string[] = []
  return {
    frames,
    diagnostics,
    ctx: createMethodContext('phase12.4', {
      writeFrame: (frame) => frames.push(frame),
      writeErr: (line) => diagnostics.push(line),
      env: { SKETCH_FAKE_PROVIDER: '1' },
      cwd: () => root,
      secrets: new Set(),
    }),
  }
}

async function communityRegistry(registry: string, reviewed: boolean): Promise<RegistryManifest> {
  const skillDir = join(registry, 'skills', NAME)
  await mkdir(join(skillDir, 'prompts'), { recursive: true })
  await writeFile(
    join(skillDir, 'skill.json'),
    JSON.stringify({
      name: NAME,
      description: 'A community folder-layout review skill',
      capabilities: ['fs:read:project', 'net:http'],
    }),
  )
  await writeFile(join(skillDir, 'README.md'), 'Review carefully and report the result.\n')
  await writeFile(join(skillDir, 'prompts', 'review.md'), 'Prefer concrete evidence.\n')
  const hashed = await hashSkillDirectory(skillDir)
  const manifest: RegistryManifest = {
    version: 1,
    registry: 'local-community-submissions',
    distribution: 'open',
    entries: [{
      name: NAME,
      version: '1.0.0',
      pack: 'engineering',
      summary: 'Community-format review guidance',
      path: `skills/${NAME}`,
      digest: hashed.digest,
      capabilities: ['fs:read:project'],
      source: 'local community submission fixture',
      license: 'Apache-2.0',
      files: hashed.files,
      ...(reviewed
        ? {
            review: {
              by: 'phase12-reviewer',
              date: '2026-08-02',
              decision: 'approved' as const,
              digest: hashed.digest,
            },
          }
        : {}),
    }],
  }
  await writeFile(join(registry, 'registry.json'), serializeManifest(manifest))
  return manifest
}

function bodyEcho(): ChatAdapter {
  return {
    id: 'phase12-body-echo',
    chat: async (messages) => {
      const body = messages
        .filter((message) => message.role === 'system' && message.content.startsWith('# Skill:'))
        .map((message) => message.content)
        .join('\n')
      return { text: JSON.stringify({ action: 'done', text: body }), usage: { in: 1, out: 1 } }
    },
  }
}

function grantFrom(run: RunResult): string[] {
  const event = run.events.find(
    (candidate) =>
      candidate.kind === 'context_assembled' && candidate.payload.component === 'agent-loop',
  )
  return (event?.payload.capabilityGrant ?? []) as string[]
}

describe('Phase 12.4 preparation — the local skill flywheel', () => {
  it('installs, runs, captures, trains, promotes, and reruns without a Sketch server', async () => {
    const project = await temp('sketch-phase12-project-')
    const registry = await temp('sketch-phase12-registry-')
    const { ctx } = methodContext(project)
    let networkCalls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      networkCalls++
      throw new Error('network is forbidden in the serverless flywheel gate')
    }

    try {
      await communityRegistry(registry, false)
      const unreviewed = await METHODS['skill-install']!(
        { root: project, registryDir: registry, name: NAME },
        ctx,
      ) as { ok: boolean; reason: string; files: number }
      expect(unreviewed.ok).toBe(false)
      expect(unreviewed.reason).toContain('carries no review record')
      expect(unreviewed.files).toBe(0)

      await communityRegistry(registry, true)
      const installed = await METHODS['skill-install']!(
        { root: project, registryDir: registry, name: NAME },
        ctx,
      ) as { ok: boolean; granted: string[]; warnings: string[] }
      expect(installed.ok).toBe(true)
      expect(installed.granted).toEqual(['fs:read:project'])
      expect(installed.warnings.join(' ')).toContain('net:http')
      const persistedGrant = await readFile(installedSkillGrantPath(project, NAME), 'utf8')
      expect(persistedGrant).toContain('fs:read:project')
      expect(persistedGrant).not.toContain('net:http')

      const firstLoad = await loadSkills(installedSkillsDir(project))
      expect(firstLoad.diagnostics).toEqual([])
      const seed = firstLoad.skills.find((skill) => skill.name === NAME)!
      expect(seed.source).toBe(join(installedSkillsDir(project), NAME, 'skill.json'))
      expect(seed.capabilities).toContain('net:http')

      const productionRun = await METHODS.run(
        {
          root: project,
          task: { id: 'community-run', prompt: 'Use the installed community skill.', verify: [], skillNames: [NAME] },
        },
        ctx,
      ) as RunResult
      expect(productionRun.ok).toBe(true)
      expect(grantFrom(productionRun)).toEqual(['fs:read:project'])

      // The active digest is live authority, not decoration: changed installed
      // bytes retain the prompt but lose every tool capability until restored.
      const readme = join(installedSkillsDir(project), NAME, 'README.md')
      const originalReadme = await readFile(readme, 'utf8')
      await writeFile(readme, `${originalReadme}tampered\n`)
      const staleRun = await METHODS.run(
        {
          root: project,
          task: { id: 'stale-run', prompt: 'Do not trust changed bytes.', verify: [], skillNames: [NAME] },
        },
        ctx,
      ) as RunResult
      expect(grantFrom(staleRun)).toEqual([])
      await writeFile(readme, originalReadme)

      const reference: Skill = {
        ...seed,
        body: `${seed.body}\n\nAlways include ${WINNER}.`,
      }
      for (let index = 0; index < 4; index++) {
        const events = new MemoryEventStore({ secrets: [] })
        const task = {
          id: `capture-${index}`,
          prompt: 'Review this change.',
          verify: [],
          skillNames: [NAME],
        }
        const run = await runTask(task, {
          adapter: bodyEcho(),
          events,
          root: project,
          skills: [reference],
          plan: new PlanWriter({ baseDir: project, events }),
          files: new DiskFileWriter(),
          maxIterations: 1,
        })
        expect(run.finalText).toContain(WINNER)
        await captureRunAsEval(run, task, {
          evalsPath: evalsFilePath(project),
          checks: [{ kind: 'contains', text: WINNER }],
        })
      }

      const captured = await loadEvalCases(project)
      expect(captured.diagnostics).toEqual([])
      expect(captured.cases).toHaveLength(4)
      for (const evalCase of captured.cases) {
        const replay = await runEval(evalCase, {
          adapter: bodyEcho(),
          events: new MemoryEventStore({ secrets: [] }),
          skills: [reference],
          maxIterations: 1,
        })
        expect(replay.score).toBe(1)
      }

      const trained = await trainSkill({
        seed,
        cases: captured.cases,
        epochs: 1,
        proposeEdit: scriptedProposeEdit([reference]),
        events: new MemoryEventStore({ secrets: [] }),
        adapter: bodyEcho(),
        maxIterations: 1,
        artifactPath: trainingArtifactPath(project, NAME),
      })
      expect(trained.baselineValScore).toBe(0)
      expect(trained.valScore).toBe(1)
      expect(trained.epochs[0]!.verdict).toBe('accepted')

      // Promotion is a separate authorization boundary. A measured candidate
      // cannot widen even its declarations, regardless of the narrower grant.
      const artifact = trainingArtifactPath(project, NAME)
      const measuredCandidate = await readFile(artifact, 'utf8')
      await writeFile(
        artifact,
        `---\nname: ${NAME}\ndescription: changed authority\ncapabilities: fs:read:project, net:http, proc:spawn\n---\n\n${WINNER}\n`,
      )
      const widened = await METHODS['skill-promote']!({ root: project, name: NAME }, ctx) as {
        ok: boolean
        reason: string
      }
      expect(widened.ok).toBe(false)
      expect(widened.reason).toContain('attempted to change declared capabilities')
      await writeFile(artifact, measuredCandidate)

      const promoted = await METHODS['skill-promote']!({ root: project, name: NAME }, ctx) as {
        ok: boolean
        granted: string[]
      }
      expect(promoted.ok).toBe(true)
      expect(promoted.granted).toEqual(['fs:read:project'])

      const finalLoad = await loadSkills(installedSkillsDir(project))
      const active = finalLoad.skills.find((skill) => skill.name === NAME)!
      expect(active.source).toBe(join(installedSkillsDir(project), NAME, 'SKILL.md'))
      expect(active.body).toContain(WINNER)
      const authority = await readInstalledSkillGrant(project, active)
      expect(authority.ok).toBe(true)
      expect(authority.grant?.capabilities).toEqual(['fs:read:project'])

      const finalReplay = await runEval(captured.cases[0]!, {
        adapter: bodyEcho(),
        events: new MemoryEventStore({ secrets: [] }),
        skills: [active],
        maxIterations: 1,
      })
      expect(finalReplay.score).toBe(1)
      expect(networkCalls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  }, 30_000)
})
