// `skill-train` with mode 'edits' (Microsoft SkillOpt's update rule), end to end
// through the RPC method: a real project on disk, captured eval cases, an installed
// skill, and a scripted model whose proposed edit does not help.
//
// The point is the last round. The edit optimizer learns that its edits were
// rejected only when the next round starts, and the default is one round, so the
// method has to settle the optimizer with the skill the gate kept. Without that,
// `rejectedEdits` is empty after every default run and the panel has nothing to show.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { evalsFilePath } from '../src/evals/capture.js'
import { createEngineExtensionRegistry } from '../src/extensions/index.js'
import { installedSkillsDir } from '../src/registry/grants.js'
import { METHODS } from '../src/rpc/methods.js'
import { createMethodContext } from '../src/rpc/server.js'
import type { ChatAdapter, EvalCase, ProviderConfig } from '../src/types.js'

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

const NAME = 'review-notes'
const PROPOSED = 'Always include the whole repository in the prompt.'

const descriptor = {
  id: 'train-probe',
  name: 'Train Probe',
  kind: 'openai-compatible' as const,
  defaultBaseUrl: 'https://train.invalid/v1',
  needsKey: false,
  serverless: false,
}

const provider = { id: descriptor.id, kind: descriptor.kind, baseUrl: '', model: 'probe' }

/** Proposes one edit; every agent run under the skill misses the word the checks want. */
function trainingProvider() {
  const proposals: string[] = []
  const factory = (_config: ProviderConfig): ChatAdapter => ({
    id: descriptor.id,
    chat: async (messages) => {
      if (messages[0]?.content.startsWith('You improve the instruction text of an agent skill with small')) {
        proposals.push(messages[1]?.content ?? '')
        return {
          text: ['```edits', JSON.stringify([{ op: 'add', text: PROPOSED }]), '```'].join('\n'),
          usage: { in: 1, out: 1 },
        }
      }
      return { text: JSON.stringify({ action: 'done', text: 'Looks fine to me.' }), usage: { in: 1, out: 1 } }
    },
  })
  return { proposals, factory }
}

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sketch-skill-train-'))
  roots.push(root)
  const skillDir = join(installedSkillsDir(root), NAME)
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${NAME}\ndescription: Write review notes.\ncapabilities: fs:read:project\n---\n\n# Review notes\n\nRead the diff before writing anything.\n`,
  )
  const cases: EvalCase[] = [1, 2].map((n) => ({
    id: `case-${n}`,
    task: { id: `case-${n}`, prompt: `Review change ${n}.`, verify: [], skillNames: [NAME] },
    checks: [{ kind: 'contains', text: 'SIGNATURE-CHECKED' }],
  }))
  await mkdir(join(root, '.sketch', 'evals'), { recursive: true })
  await writeFile(evalsFilePath(root), cases.map((c) => JSON.stringify(c)).join('\n') + '\n')
  return root
}

function contextFor(root: string, factory: (config: ProviderConfig) => ChatAdapter) {
  return createMethodContext('skill-train-test', {
    writeFrame: () => {},
    writeErr: () => {},
    env: {},
    cwd: () => root,
    secrets: new Set(),
    extensions: createEngineExtensionRegistry({ providers: [{ descriptor, factory }] }),
  })
}

describe('skill-train in SkillOpt edits mode', () => {
  it('reports the edits the held-out gate rejected, including the last round\u2019s', async () => {
    const root = await project()
    const probe = trainingProvider()
    const result = (await METHODS['skill-train']!(
      { root, name: NAME, provider, mode: 'edits' },
      contextFor(root, probe.factory),
    )) as {
      ok: boolean
      mode: string
      improved: boolean
      epochs: Array<{ verdict: string }>
      rejectedEdits?: string[]
      body: string
    }

    expect(result.ok).toBe(true)
    expect(result.mode).toBe('edits')
    expect(probe.proposals).toHaveLength(1)
    expect(result.epochs.map((epoch) => epoch.verdict)).toEqual(['rejected'])
    expect(result.improved).toBe(false)
    expect(result.rejectedEdits).toEqual([`add "${PROPOSED}"`])
    // The gate kept the installed text.
    expect(result.body).not.toContain(PROPOSED)
  })

  it('refuses a mode it does not know', async () => {
    const root = await project()
    const probe = trainingProvider()
    await expect(
      METHODS['skill-train']!({ root, name: NAME, provider, mode: 'bogus' }, contextFor(root, probe.factory)),
    ).rejects.toThrow(/params\.mode must be "rewrite" or "edits"/)
    expect(probe.proposals).toHaveLength(0)
  })
})
