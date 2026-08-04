// Stopping a run from the wire.
//
// `runTask` has accepted an `AbortSignal` since the loop was written, and until the
// `cancel` method existed nothing on either transport could produce one. That is not a
// small gap: a run that loops, or one started against the wrong provider, could only be
// ended by killing the engine process, which also loses the log.
//
// These tests drive `METHODS` directly, the same table the sidecar and the dev bridge
// dispatch, because that is the surface a Stop button actually reaches.

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
  const root = await mkdtemp(join(tmpdir(), 'sketch-cancel-'))
  roots.push(root)
  return root
}

const descriptor = {
  id: 'cancel-probe',
  name: 'Cancel Probe',
  kind: 'openai-compatible' as const,
  defaultBaseUrl: 'https://cancel.invalid/v1',
  needsKey: false,
  serverless: false,
}

/**
 * An adapter that never answers on its own.
 *
 * This is the shape cancellation has to work against: a real model call that is in
 * flight. It resolves `entered` so a test can cancel at the exact moment a call is
 * outstanding, and it rejects with an `AbortError` the way `fetch` does — the loop's
 * `isAbort` has to recognise it through the adapter, not around it.
 */
function hangingProvider() {
  let announce: () => void
  const entered = new Promise<void>((resolve) => { announce = resolve })
  const factory = (_config: ProviderConfig): ChatAdapter => ({
    id: descriptor.id,
    chat: (_messages, options) =>
      new Promise((_resolve, reject) => {
        announce()
        const signal = options?.signal
        if (signal === undefined) return
        const fail = () => {
          const error = new Error('The operation was aborted.')
          error.name = 'AbortError'
          reject(error)
        }
        if (signal.aborted) fail()
        else signal.addEventListener('abort', fail, { once: true })
      }),
  })
  return { entered, factory }
}

function contextFor(root: string, factory: (config: ProviderConfig) => ChatAdapter) {
  return createMethodContext('cancel-test', {
    writeFrame: () => {},
    writeErr: () => {},
    env: {},
    cwd: () => root,
    secrets: new Set(),
    extensions: createEngineExtensionRegistry({ providers: [{ descriptor, factory }] }),
  })
}

const provider = { id: descriptor.id, kind: descriptor.kind, baseUrl: '', model: 'probe' }

describe('the cancel method stops an in-flight run', () => {
  it('aborts a run the caller named, and the run records why it ended', async () => {
    const root = await tempRoot()
    const probe = hangingProvider()
    const ctx = contextFor(root, probe.factory)

    // The caller supplies the id, which is the whole reason a Stop control can exist: a
    // client that had to wait for `run_started` cannot cancel during the window in which
    // it most wants to.
    const pending = METHODS.run(
      {
        root,
        provider,
        runId: 'stop-me',
        task: { id: 'cancel-task', prompt: 'Hang until stopped.', verify: [] },
      },
      ctx,
    ) as Promise<RunResult>

    await probe.entered
    const stopped = (await METHODS.cancel!({ runId: 'stop-me' }, ctx)) as {
      runId: string
      cancelled: boolean
    }
    expect(stopped).toMatchObject({ runId: 'stop-me', cancelled: true })

    const result = await pending
    expect(result.runId).toBe('stop-me')
    expect(result.ok).toBe(false)

    // The run writes its own terminal event. `cancel` fabricating one would put a
    // second author on the log, and the two would disagree the first time an abort
    // raced a completion.
    const failed = result.events.find((event: SketchEvent) => event.kind === 'run_failed')
    expect(failed).toBeDefined()
    expect(failed!.payload['reason']).toBe('aborted')
    expect(result.events.filter((event: SketchEvent) => event.kind === 'run_failed')).toHaveLength(1)
  }, 30_000)

  it('reports honestly when there is nothing to cancel, and does not leak finished runs', async () => {
    const root = await tempRoot()
    const probe = hangingProvider()
    const ctx = contextFor(root, probe.factory)

    // Never started.
    expect(await METHODS.cancel!({ runId: 'no-such-run' }, ctx)).toMatchObject({ cancelled: false })

    const pending = METHODS.run(
      { root, provider, runId: 'finished', task: { id: 't', prompt: 'Hang.', verify: [] } },
      ctx,
    ) as Promise<RunResult>
    await probe.entered
    await METHODS.cancel!({ runId: 'finished' }, ctx)
    await pending

    // Already finished answers the same way as never started: a caller can only act on
    // whether a run is still going, so those cases are deliberately indistinguishable.
    // This also proves the registry is emptied — otherwise it grows with every run.
    expect(await METHODS.cancel!({ runId: 'finished' }, ctx)).toMatchObject({ cancelled: false })
    // A second cancel is idempotent, not an error.
    expect(await METHODS.cancel!({ runId: 'finished' }, ctx)).toMatchObject({ cancelled: false })
  }, 30_000)

  it('refuses a missing or malformed id rather than guessing which run was meant', async () => {
    const root = await tempRoot()
    const probe = hangingProvider()
    const ctx = contextFor(root, probe.factory)

    await expect(METHODS.cancel!({}, ctx)).rejects.toThrow(/params\.runId is required/)
    await expect(METHODS.cancel!({ runId: '' }, ctx)).rejects.toThrow(/params\.runId/)

    // A run id becomes a log correlation key and a registry key. Separators and control
    // characters are refused for the same reason a provider id is.
    for (const bad of ['../escape', 'has space', 'nul\u0000byte', 'a'.repeat(129)]) {
      await expect(
        METHODS.run({ root, provider, runId: bad, task: { id: 't', prompt: 'p', verify: [] } }, ctx),
      ).rejects.toThrow(/params\.runId/)
    }
  }, 30_000)

  it('refuses a second run under an id already in flight', async () => {
    const root = await tempRoot()
    const probe = hangingProvider()
    const ctx = contextFor(root, probe.factory)

    const pending = METHODS.run(
      { root, provider, runId: 'shared', task: { id: 'first', prompt: 'Hang.', verify: [] } },
      ctx,
    ) as Promise<RunResult>
    await probe.entered

    // Accepting this would leave `cancel` unable to say which run it stopped and would
    // silently make one of the two uncancellable. It also turns a double-submit into an
    // error instead of two bills.
    await expect(
      METHODS.run(
        { root, provider, runId: 'shared', task: { id: 'second', prompt: 'Hang too.', verify: [] } },
        ctx,
      ),
    ).rejects.toThrow(/already running/)

    await METHODS.cancel!({ runId: 'shared' }, ctx)
    await pending

    // And the id is reusable once the first run is over.
    const after = METHODS.run(
      { root, provider, runId: 'shared', task: { id: 'third', prompt: 'Hang again.', verify: [] } },
      ctx,
    ) as Promise<RunResult>
    await METHODS.cancel!({ runId: 'shared' }, ctx)
    expect((await after).runId).toBe('shared')
  }, 30_000)
})
