// Phase 12.4 third-party evidence gate.
//
// This proves the local flywheel over genuine, byte-pinned third-party skill
// content. It does NOT claim the upstream skill is organically high quality,
// and the deterministic adapter below is not a real model/provider.

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { captureRunAsEval, evalsFilePath, loadEvalCases } from '../src/evals/capture.js'
import { runEval } from '../src/evals/runner.js'
import { MemoryEventStore } from '../src/events/index.js'
import { createEngineExtensionRegistry } from '../src/extensions/index.js'
import { runTask } from '../src/loop/index.js'
import { DiskFileWriter } from '../src/orchestrator/file-writer.js'
import { PlanWriter } from '../src/plan/index.js'
import { METHODS } from '../src/rpc/methods.js'
import { createMethodContext } from '../src/rpc/server.js'
import {
  hashSkillDirectory,
  installedSkillsDir,
  loadManifest,
  readInstalledSkillGrant,
  trainingArtifactPath,
} from '../src/registry/index.js'
import { loadSkillFile, loadSkills, scriptedProposeEdit, trainSkill } from '../src/skills/index.js'
import type { ChatAdapter, Message, RunResult, Skill } from '../src/types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMMUNITY = join(HERE, '..', 'registry', 'community')
const RETAINED = join(COMMUNITY, 'skills', 'dispatching-parallel-agents')
const PROVENANCE = join(COMMUNITY, 'provenance', 'dispatching-parallel-agents.json')
const NAME = 'dispatching-parallel-agents'
const DIRECTORY_DIGEST = 'sha256:af752a5b04e93791b1635d04fd3ab4272facc2d2ae5aea1fe84411ce9331fb3e'
const WINNER = 'THIRD_PARTY_FLYWHEEL_WINNER_12_4'
const roots: string[] = []

interface ProvenanceFile {
  path: string
  gitBlob: string
  sha256: string
  bytes: number
}

interface Provenance {
  upstream: {
    repository: string
    immutableUrl: string
    commit: string
    commitDate: string
    retainedBytes: string
    lineEndings: string
  }
  acquisitionDate: string
  directoryDigest: string
  files: ProvenanceFile[]
  license: { spdx: string; file: string; identity: string }
  review: {
    decision: string
    rationale: string
    classification: string
    executables: boolean
    network: boolean
    secrets: boolean
    capabilities: string[]
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

async function tempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sketch-third-party-flywheel-'))
  roots.push(root)
  return root
}

function gitBlobId(blobBytes: Buffer): string {
  return createHash('sha1')
    .update(Buffer.from(`blob ${blobBytes.byteLength}\0`, 'utf8'))
    .update(blobBytes)
    .digest('hex')
}

function methodContext(root: string, calls: Message[][]) {
  const provider = {
    id: 'third-party-evidence-script',
    name: 'Third-party evidence script',
    kind: 'openai-compatible' as const,
    defaultBaseUrl: 'https://offline.invalid/v1',
    needsKey: false,
    serverless: false,
  }
  const extensions = createEngineExtensionRegistry({
    providers: [{
      descriptor: provider,
      factory: (): ChatAdapter => ({
        id: provider.id,
        chat: async (messages) => {
          calls.push(messages.map((message) => ({ ...message })))
          return {
            text: JSON.stringify({ action: 'done', text: 'scripted production run complete' }),
            usage: { in: 1, out: 1 },
          }
        },
      }),
    }],
  })
  const frames: unknown[] = []
  const diagnostics: string[] = []
  return {
    provider,
    frames,
    diagnostics,
    ctx: createMethodContext('phase12.4-third-party', {
      writeFrame: (frame) => frames.push(frame),
      writeErr: (line) => diagnostics.push(line),
      env: {},
      cwd: () => root,
      secrets: new Set(),
      extensions,
    }),
  }
}

function bodyEcho(): ChatAdapter {
  return {
    id: 'third-party-body-echo',
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

describe('Phase 12.4 — reviewed third-party bytes turn the server-less flywheel', () => {
  it('verifies provenance, installs, runs, captures, trains, promotes, and replays offline', async () => {
    const project = await tempProject()
    const calls: Message[][] = []
    const { provider, ctx } = methodContext(project, calls)
    const listen = vi.spyOn(Server.prototype, 'listen')
    const originalFetch = globalThis.fetch
    let fetchCount = 0
    globalThis.fetch = async () => {
      fetchCount++
      throw new Error('network is forbidden in the third-party flywheel gate')
    }

    try {
      const provenance = JSON.parse(await readFile(PROVENANCE, 'utf8')) as Provenance
      const retainedFiles = await readdir(RETAINED)
      expect(retainedFiles.sort()).toEqual(['LICENSE', 'README.md', 'SKILL.md'])
      expect(provenance.upstream).toEqual({
        repository: 'https://github.com/dotcomjack/parallel-agents-skill.git',
        immutableUrl: 'https://github.com/dotcomjack/parallel-agents-skill/tree/f26435da141df656eaed219dc23da776f46d9320',
        commit: 'f26435da141df656eaed219dc23da776f46d9320',
        commitDate: '2026-05-22T17:14:02-04:00',
        retainedBytes: 'Exact Git blob bytes from the pinned commit',
        lineEndings: 'LF enforced by root .gitattributes',
      })
      expect(provenance.acquisitionDate).toBe('2026-08-03')
      expect(provenance.directoryDigest).toBe(DIRECTORY_DIGEST)
      expect(provenance.license).toEqual({
        spdx: 'MIT',
        file: 'LICENSE',
        identity: 'MIT License; Copyright (c) 2026 dotcomjack',
      })
      expect(provenance.review).toMatchObject({
        decision: 'approved',
        classification: 'instruction-only',
        executables: false,
        network: false,
        secrets: false,
        capabilities: [],
      })
      expect(provenance.review.rationale).toContain('were not executed')

      for (const file of provenance.files) {
        const bytes = await readFile(join(RETAINED, file.path))
        expect(bytes.byteLength, file.path).toBe(file.bytes)
        expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, file.path).toBe(file.sha256)
        expect(gitBlobId(bytes), file.path).toBe(file.gitBlob)
      }
      const retainedHash = await hashSkillDirectory(RETAINED)
      expect(retainedHash.digest).toBe(DIRECTORY_DIGEST)
      expect(retainedHash.files).toEqual(
        provenance.files.map((file) => ({ path: file.path, digest: file.sha256, bytes: file.bytes })),
      )

      const { manifest } = await loadManifest(COMMUNITY)
      expect(manifest.distribution).toBe('open')
      expect(manifest.entries).toHaveLength(1)
      expect(manifest.entries[0]).toMatchObject({
        name: NAME,
        digest: DIRECTORY_DIGEST,
        capabilities: [],
        license: 'MIT',
        review: { decision: 'approved', digest: DIRECTORY_DIGEST },
      })
      const installed = await METHODS['skill-install']!({
        root: project,
        registryDir: COMMUNITY,
        name: NAME,
      }, ctx) as {
        ok: boolean
        digest: string
        granted: string[]
        warnings: string[]
        files: number
      }
      expect(installed).toMatchObject({
        ok: true,
        digest: DIRECTORY_DIGEST,
        granted: [],
        warnings: [],
        files: 3,
      })

      const installedDir = join(installedSkillsDir(project), NAME)
      expect((await hashSkillDirectory(installedDir)).digest).toBe(DIRECTORY_DIGEST)
      for (const file of provenance.files) {
        expect(await readFile(join(installedDir, file.path))).toEqual(await readFile(join(RETAINED, file.path)))
      }

      const seed = await loadSkillFile(join(installedDir, 'SKILL.md'))
      const retainedSkill = await loadSkillFile(join(RETAINED, 'SKILL.md'))
      expect({ ...seed, source: '' }).toEqual({ ...retainedSkill, source: '' })
      expect(seed.capabilities ?? []).toEqual([])

      const productionRun = await METHODS.run({
        root: project,
        provider: {
          id: provider.id,
          kind: provider.kind,
          baseUrl: '',
          model: 'deterministic-script',
        },
        maxIterations: 1,
        task: {
          id: 'third-party-production-run',
          prompt: 'Use the reviewed third-party skill.',
          verify: [],
          skillNames: [NAME],
        },
      }, ctx) as RunResult
      expect(productionRun.ok).toBe(true)
      expect(grantFrom(productionRun)).toEqual([])
      const expectedSkillPrompt = `# Skill: ${retainedSkill.name}\n${retainedSkill.description}\n\n${retainedSkill.body}`.trimEnd()
      const loadedPrompts = calls.flat().filter(
        (message) => message.role === 'system' && message.content.startsWith(`# Skill: ${NAME}`),
      )
      expect(loadedPrompts.map((message) => message.content)).toEqual([expectedSkillPrompt])

      const reference: Skill = { ...seed, body: `${seed.body}\n\nAlways emit ${WINNER}.` }
      for (let index = 0; index < 4; index++) {
        const events = new MemoryEventStore({ secrets: [] })
        const task = {
          id: `third-party-capture-${index}`,
          prompt: 'Dispatch two independent investigations.',
          verify: [],
          skillNames: [NAME],
        }
        const run = await runTask(task, {
          adapter: bodyEcho(),
          events,
          root: project,
          skills: [reference],
          capabilityGrant: [],
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
          capabilityGrant: [],
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
      expect(trained.split.train).toHaveLength(3)
      expect(trained.split.val).toHaveLength(1)
      expect(trained.baselineValScore).toBe(0)
      expect(trained.valScore).toBe(1)
      expect(trained.valScore).toBeGreaterThan(trained.baselineValScore)
      expect(trained.epochs).toEqual([
        expect.objectContaining({ verdict: 'accepted', incumbentScore: 0, candidateScore: 1 }),
      ])

      const authorityBefore = await readInstalledSkillGrant(project, seed)
      expect(authorityBefore).toMatchObject({ ok: true, grant: { capabilities: [] } })
      const artifact = trainingArtifactPath(project, NAME)
      const measuredCandidate = await readFile(artifact, 'utf8')
      const capabilityChangingCandidate = measuredCandidate.replace(
        '\n---\n\n',
        '\ncapabilities: ["fs:read:project"]\n---\n\n',
      )
      expect(capabilityChangingCandidate).not.toBe(measuredCandidate)
      await writeFile(artifact, capabilityChangingCandidate, 'utf8')
      const refused = await METHODS['skill-promote']!({ root: project, name: NAME }, ctx) as {
        ok: boolean
        reason: string
      }
      expect(refused.ok).toBe(false)
      expect(refused.reason).toContain('attempted to change declared capabilities')
      const unchanged = (await loadSkills(installedSkillsDir(project))).skills.find(
        (skill) => skill.name === NAME,
      )!
      expect((await readInstalledSkillGrant(project, unchanged)).grant?.capabilities).toEqual([])

      await writeFile(artifact, measuredCandidate, 'utf8')
      const promoted = await METHODS['skill-promote']!({ root: project, name: NAME }, ctx) as {
        ok: boolean
        granted: string[]
      }
      expect(promoted).toMatchObject({ ok: true, granted: [] })
      const active = (await loadSkills(installedSkillsDir(project))).skills.find(
        (skill) => skill.name === NAME,
      )!
      expect(active.body).toContain(WINNER)
      expect((await readInstalledSkillGrant(project, active))).toMatchObject({
        ok: true,
        grant: { capabilities: [] },
      })

      const finalReplay = await runEval(captured.cases[0]!, {
        adapter: bodyEcho(),
        events: new MemoryEventStore({ secrets: [] }),
        skills: [active],
        capabilityGrant: [],
        maxIterations: 1,
      })
      expect(finalReplay.score).toBe(1)
      expect(fetchCount).toBe(0)
      // METHODS are invoked in-process: no RPC sidecar and no listening server.
      expect(listen).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  }, 30_000)
})
