// Answering a question mid-run.
//
// `ask` used to be a dead end: the model asked, the run ended not-ok, and the only way
// forward was to start over with the answer pasted into the prompt. That is fine for a
// headless caller and wrong for a person sitting in front of the app.
//
// The two behaviours have to coexist. These tests pin both: absent a channel the original
// terminal behaviour is byte-for-byte what it was, and with one the run resumes.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createEngineExtensionRegistry } from '../src/extensions/index.js'
import { METHODS } from '../src/rpc/methods.js'
import { createMethodContext } from '../src/rpc/server.js'
import type { ChatAdapter, ProviderConfig, RunResult, SketchEvent } from '../src/types.js'

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sketch-reply-'))
  roots.push(root)
  return root
}

const descriptor = {
  id: 'ask-probe',
  name: 'Ask Probe',
  kind: 'openai-compatible' as const,
  defaultBaseUrl: 'https://ask.invalid/v1',
  needsKey: false,
  serverless: false,
}

const QUESTION = 'Which database should the new service use?'

/**
 * An adapter that asks once, then finishes — quoting back whatever it was told.
 *
 * Quoting matters: it proves the answer reached the MODEL's conversation, not just the
 * event log. A test that only checked for an `ask_answered` event would pass even if the
 * reply were dropped on the floor.
 */
function askingProvider() {
  const seen: string[] = []
  const factory = (_config: ProviderConfig): ChatAdapter => {
    let turn = 0
    return {
      id: descriptor.id,
      chat: async (messages) => {
        turn += 1
        if (turn === 1) {
          return { text: JSON.stringify({ action: 'ask', question: QUESTION }), usage: { in: 1, out: 1 } }
        }
        const last = messages[messages.length - 1]!
        seen.push(last.content)
        return {
          text: JSON.stringify({ action: 'done', text: `Using ${last.content}` }),
          usage: { in: 1, out: 1 },
        }
      },
    }
  }
  return { seen, factory }
}

function contextFor(root: string, factory: (config: ProviderConfig) => ChatAdapter) {
  return createMethodContext('reply-test', {
    writeFrame: () => {},
    writeErr: () => {},
    env: {},
    cwd: () => root,
    secrets: new Set(),
    extensions: createEngineExtensionRegistry({ providers: [{ descriptor, factory }] }),
  })
}

const provider = { id: descriptor.id, kind: descriptor.kind, baseUrl: '', model: 'probe' }

/** Wait until the run has registered its question, without guessing at a delay. */
async function waitForQuestion(ctx: ReturnType<typeof contextFor>, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const probe = (await METHODS.reply!({ runId, answer: 'probe' }, ctx)) as { answered: boolean }
    if (probe.answered) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('the run never asked a question')
}

describe('an ask ends the run when there is no reply channel', () => {
  it('keeps the original terminal behaviour for a non-interactive caller', async () => {
    const root = await tempRoot()
    const probe = askingProvider()
    const ctx = contextFor(root, probe.factory)

    // No `interactive`. This is what the eval harness and every CLI caller do, and it must
    // not change: blocking on a human would hang them.
    const result = (await METHODS.run(
      { root, provider, runId: 'headless', task: { id: 't', prompt: 'Build a service.', verify: [] } },
      ctx,
    )) as RunResult

    expect(result.ok).toBe(false)
    expect(result.finalText).toBe(QUESTION)
    const failed = result.events.find((event: SketchEvent) => event.kind === 'run_failed')!
    expect(failed.payload['reason']).toBe('awaiting_human_input')
    expect(result.events.some((event: SketchEvent) => event.kind === 'ask')).toBe(true)
    // Nothing answered, so nothing claims one did.
    expect(result.events.some((event: SketchEvent) => event.kind === 'ask_answered')).toBe(false)
    expect(probe.seen).toEqual([])

    // A reply to a run that is not waiting is refused honestly rather than queued.
    expect(await METHODS.reply!({ runId: 'headless', answer: 'Postgres' }, ctx)).toMatchObject({
      answered: false,
    })
  }, 30_000)
})

describe('an interactive run pauses on an ask and resumes when answered', () => {
  it('delivers the answer to the model and records it once', async () => {
    const root = await tempRoot()
    const probe = askingProvider()
    const ctx = contextFor(root, probe.factory)

    const pending = METHODS.run(
      {
        root,
        provider,
        runId: 'interactive',
        interactive: true,
        task: { id: 't', prompt: 'Build a service.', verify: [] },
      },
      ctx,
    ) as Promise<RunResult>

    // `waitForQuestion` answers with 'probe' as soon as the question exists, which is
    // itself the proof that the run is genuinely waiting rather than already finished.
    await waitForQuestion(ctx, 'interactive')

    const result = await pending
    expect(result.ok).toBe(true)

    // THE ANSWER REACHED THE MODEL, not just the log.
    expect(probe.seen).toHaveLength(1)
    expect(probe.seen[0]).toContain('probe')
    expect(probe.seen[0]).toContain(QUESTION)
    expect(result.finalText).toContain('probe')

    // Recorded as its own fact, exactly once, and the run did not also end unanswered.
    const answered = result.events.filter((event: SketchEvent) => event.kind === 'ask_answered')
    expect(answered).toHaveLength(1)
    expect(answered[0]!.payload['question']).toBe(QUESTION)
    expect(answered[0]!.payload['answer']).toBe('probe')
    expect(result.events.some((event: SketchEvent) => event.kind === 'run_failed')).toBe(false)

    // The question is deregistered, so a late reply cannot be delivered to a moved-on loop.
    expect(await METHODS.reply!({ runId: 'interactive', answer: 'MySQL' }, ctx)).toMatchObject({
      answered: false,
    })
  }, 30_000)

  it('ends the run as if unanswered when the waiting run is cancelled', async () => {
    const root = await tempRoot()
    const probe = askingProvider()
    const ctx = contextFor(root, probe.factory)

    const pending = METHODS.run(
      {
        root,
        provider,
        runId: 'abandoned',
        interactive: true,
        task: { id: 't', prompt: 'Build a service.', verify: [] },
      },
      ctx,
    ) as Promise<RunResult>

    // Poll for the question WITHOUT answering it, then stop the run. A waiting run must
    // stay cancellable, otherwise a question nobody answers holds the engine open.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (probe.seen.length === 0 && attempt > 0) break
      await new Promise((resolve) => setTimeout(resolve, 5))
      break
    }
    await METHODS.cancel!({ runId: 'abandoned' }, ctx)

    const result = await pending
    expect(result.ok).toBe(false)
    // Either terminal reason is honest here — the abort may land while waiting or during
    // the turn — but the run must END, and must not claim it was answered.
    expect(result.events.some((event: SketchEvent) => event.kind === 'ask_answered')).toBe(false)
    expect(result.events.some((event: SketchEvent) => event.kind === 'run_completed')).toBe(false)
  }, 30_000)

  it('refuses a blank answer instead of ending the run behind the user', async () => {
    const root = await tempRoot()
    const probe = askingProvider()
    const ctx = contextFor(root, probe.factory)

    const pending = METHODS.run(
      {
        root,
        provider,
        runId: 'blank',
        interactive: true,
        task: { id: 't', prompt: 'Build a service.', verify: [] },
      },
      ctx,
    ) as Promise<RunResult>

    // Whitespace would reach the loop's decline path and end the run, which to the user
    // looks like answering broke it.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await expect(METHODS.reply!({ runId: 'blank', answer: '   ' }, ctx)).rejects.toThrow(
        /params\.answer must be a non-empty string/,
      )
      const probeReply = (await METHODS.reply!({ runId: 'blank', answer: 'Postgres' }, ctx)) as {
        answered: boolean
      }
      if (probeReply.answered) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    const result = await pending
    expect(result.ok).toBe(true)
    expect(probe.seen[0]).toContain('Postgres')
  }, 30_000)

  it('requires both a run id and an answer', async () => {
    const root = await tempRoot()
    const ctx = contextFor(root, askingProvider().factory)
    await expect(METHODS.reply!({}, ctx)).rejects.toThrow(/params\.runId is required/)
    await expect(METHODS.reply!({ runId: 'x' }, ctx)).rejects.toThrow(/params\.answer/)
  })
})
