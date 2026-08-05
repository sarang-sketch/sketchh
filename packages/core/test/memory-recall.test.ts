// Memory that reaches the model.
//
// Writing memory from a run closed half the compounding loop. This is the other half, and
// it was the half that made the store pointless without it: `assembleContext` has accepted
// a `memory` input since Phase 5 and the `run` method never passed one, so a project could
// accumulate decisions, standards and past bugs that no run ever saw.
//
// The load-bearing assertion is that the digest reaches the MODEL'S MESSAGES. An event or a
// return value proving assembly "included memory" would pass just as happily if the text
// were dropped between assembly and the prompt.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildRepoGraph } from '../src/context/repo-graph.js'
import { createEngineExtensionRegistry } from '../src/extensions/index.js'
import { JsonlMemoryStore } from '../src/memory/index.js'
import { METHODS } from '../src/rpc/methods.js'
import { createMethodContext } from '../src/rpc/server.js'
import type { ChatAdapter, Message, ProviderConfig, RunResult } from '../src/types.js'

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

const DECISION = 'Retries use exponential backoff capped at 30 seconds.'

/** A project with something to retrieve AND something remembered. */
async function projectWithMemory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sketch-recall-'))
  roots.push(root)
  // Real content, so retrieval has a chunk to find and memory is not the only section.
  await writeFile(
    join(root, 'retry.ts'),
    'export function retry(attempts: number) {\n  return attempts * 2\n}\n',
    'utf8',
  )
  // A persisted graph: with none, retrieval is skipped and memory never gets a chance.
  await buildRepoGraph({ root, baseDir: root, persist: true })
  await new JsonlMemoryStore({ baseDir: root }).add({
    kind: 'decision',
    text: DECISION,
    source: 'user',
  })
  return root
}

const descriptor = {
  id: 'recall-probe',
  name: 'Recall Probe',
  kind: 'openai-compatible' as const,
  defaultBaseUrl: 'https://recall.invalid/v1',
  needsKey: false,
  serverless: false,
}

/** Captures every message the model was shown, then finishes immediately. */
function capturingProvider() {
  const shown: Message[][] = []
  const factory = (_config: ProviderConfig): ChatAdapter => ({
    id: descriptor.id,
    chat: async (messages) => {
      shown.push([...messages])
      return { text: JSON.stringify({ action: 'done', text: 'ok' }), usage: { in: 1, out: 1 } }
    },
  })
  return { shown, factory }
}

function contextFor(root: string, factory: (config: ProviderConfig) => ChatAdapter) {
  const logs: string[] = []
  return {
    logs,
    ctx: createMethodContext('recall-test', {
      writeFrame: () => {},
      writeErr: (line) => logs.push(line),
      env: {},
      cwd: () => root,
      secrets: new Set(),
      extensions: createEngineExtensionRegistry({ providers: [{ descriptor, factory }] }),
    }),
  }
}

const provider = { id: descriptor.id, kind: descriptor.kind, baseUrl: '', model: 'probe' }

function everythingShown(shown: Message[][]): string {
  return shown.flat().map((message) => message.content).join('\n')
}

describe('a run is shown what the project already decided', () => {
  it('puts the memory digest in the prompt when retrieval is on', async () => {
    const root = await projectWithMemory()
    const probe = capturingProvider()
    const { ctx } = contextFor(root, probe.factory)

    const result = (await METHODS.run(
      {
        root,
        provider,
        contextBudgetTokens: 4_000,
        task: { id: 'recall', prompt: 'Fix the retry backoff.', verify: [] },
      },
      ctx,
    )) as RunResult
    expect(result.ok).toBe(true)

    // THE MODEL SAW IT. Not an event claiming assembly happened — the actual messages.
    expect(everythingShown(probe.shown)).toContain(DECISION)
  }, 30_000)

  it('sends no memory when the caller opts out', async () => {
    const root = await projectWithMemory()
    const probe = capturingProvider()
    const { ctx } = contextFor(root, probe.factory)

    await METHODS.run(
      {
        root,
        provider,
        contextBudgetTokens: 4_000,
        recallMemory: false,
        task: { id: 'no-recall', prompt: 'Fix the retry backoff.', verify: [] },
      },
      ctx,
    )
    expect(everythingShown(probe.shown)).not.toContain(DECISION)
  }, 30_000)

  it('sends no memory when retrieval itself is off', async () => {
    const root = await projectWithMemory()
    const probe = capturingProvider()
    const { ctx } = contextFor(root, probe.factory)

    // No `contextBudgetTokens`. Memory rides inside the retrieval budget, so with no budget
    // there is nothing to ride in — otherwise memory would be an unbounded second channel
    // into the prompt, which is exactly what the assembly layer exists to prevent.
    await METHODS.run(
      { root, provider, task: { id: 'no-retrieval', prompt: 'Fix the retry backoff.', verify: [] } },
      ctx,
    )
    expect(everythingShown(probe.shown)).not.toContain(DECISION)
  }, 30_000)

  it('runs normally for a project that has remembered nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sketch-recall-empty-'))
    roots.push(root)
    await writeFile(join(root, 'a.ts'), 'export const a = 1\n', 'utf8')
    await buildRepoGraph({ root, baseDir: root, persist: true })
    const probe = capturingProvider()
    const { ctx } = contextFor(root, probe.factory)

    const result = (await METHODS.run(
      {
        root,
        provider,
        contextBudgetTokens: 4_000,
        task: { id: 'empty', prompt: 'Change a.', verify: [] },
      },
      ctx,
    )) as RunResult
    // An empty store must add no heading with nothing under it, and must not be an error.
    expect(result.ok).toBe(true)
    expect(everythingShown(probe.shown)).not.toContain('Project memory')
  }, 30_000)

  it('continues without memory rather than failing when the store cannot be read', async () => {
    const root = await projectWithMemory()
    const probe = capturingProvider()
    const { ctx, logs } = contextFor(root, probe.factory)

    const result = (await METHODS.run(
      {
        root,
        provider,
        contextBudgetTokens: 4_000,
        // An unknown store id. Reading memory must never be the reason a run fails: the
        // task is still doable with code context alone.
        memoryStore: 'no-such-store',
        task: { id: 'broken-store', prompt: 'Fix the retry backoff.', verify: [] },
      },
      ctx,
    )) as RunResult
    expect(result.ok).toBe(true)
    expect(everythingShown(probe.shown)).not.toContain(DECISION)
    expect(logs.join('\n')).toContain('project memory not included')
  }, 30_000)
})
