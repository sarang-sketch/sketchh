// The window's watcher loop against a scripted engine. What these pin, in user terms:
//   * Opening a folder starts watching it: the first poll asks for a cursor, every later
//     poll continues from the last answer.
//   * A change the engine reports reaches the window's readers as one announcement,
//     with the exact paths — or as "look at everything" when there were too many.
//   * An engine without the watcher, or a failed poll, never breaks the window.
//   * Path keys match one file however it is spelled.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

import { SketchClientProvider } from '../lib/ClientProvider'
import type { FsWatchBatch, SketchClient } from '../lib/client'
import { MockSketchClient } from '../lib/mockClient'
import { AppStateProvider } from '../state/AppState'
import { DISK_CHANGED_EVENT, diskPathKey, parentKey } from './diskSync'
import { ProjectWatcher } from './projectWatcher'

const ROOT = 'C:/work/app'

function batch(partial: Partial<FsWatchBatch>): FsWatchBatch {
  return { cursor: 0, paths: [], overflow: false, git: false, watching: true, degraded: false, error: null, ...partial }
}

/** Answers polls from a script, one at a time; a poll past the script waits forever. */
function scriptedClient(script: Array<FsWatchBatch | Error>) {
  const calls: Array<{ root: string; since?: number; timeoutMs?: number }> = []
  const client = Object.assign(new MockSketchClient(), {
    fsWatch: (params: { root: string; since?: number; timeoutMs?: number }, signal?: AbortSignal) => {
      calls.push(params)
      const next = script.shift()
      if (next === undefined) {
        return new Promise<FsWatchBatch>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        })
      }
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
    },
  }) as SketchClient
  return { client, calls }
}

function listen() {
  const events: Array<{ reason?: string; paths?: string[]; git?: boolean }> = []
  const handler = (event: Event) => events.push((event as CustomEvent).detail)
  window.addEventListener(DISK_CHANGED_EVENT, handler)
  return { events, stop: () => window.removeEventListener(DISK_CHANGED_EVENT, handler) }
}

function mount(client: SketchClient, root: string | null = ROOT) {
  return render(
    <SketchClientProvider client={client}>
      <AppStateProvider initial={{ projectRoot: root }}>
        <ProjectWatcher />
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

afterEach(cleanup)

describe('the window watches the open folder', () => {
  it('continues from each answer and announces exactly the changed paths', async () => {
    const { client, calls } = scriptedClient([
      batch({ cursor: 4 }),
      batch({ cursor: 6, paths: ['C:\\work\\app\\src\\a.ts', 'C:\\work\\app\\src'] }),
      batch({ cursor: 6 }),
      batch({ cursor: 9, git: true }),
    ])
    const { events, stop } = listen()
    mount(client)
    await waitFor(() => expect(calls.length).toBe(5))
    stop()
    expect(calls[0]).toEqual({ root: ROOT, timeoutMs: 25_000 })
    expect(calls.slice(1).map((c) => c.since)).toEqual([4, 6, 6, 9])
    // The empty answer (a timeout) announces nothing.
    expect(events).toEqual([
      { reason: 'watcher', paths: ['C:\\work\\app\\src\\a.ts', 'C:\\work\\app\\src'], git: false },
      { reason: 'watcher', paths: [], git: true },
    ])
  })

  it('turns an overflow into "look at everything"', async () => {
    const { client, calls } = scriptedClient([batch({ cursor: 1 }), batch({ cursor: 500, overflow: true })])
    const { events, stop } = listen()
    mount(client)
    await waitFor(() => expect(calls.length).toBe(3))
    stop()
    expect(events).toEqual([{ reason: 'watcher', git: true }])
  })

  it('starts over after a failed poll instead of giving up', async () => {
    const { client, calls } = scriptedClient([batch({ cursor: 2 }), new Error('engine restarted'), batch({ cursor: 0 })])
    mount(client)
    await waitFor(() => expect(calls.length).toBe(4), { timeout: 4_000 })
    // After the failure the cursor is unknown, so the next poll asks for a fresh one.
    expect(calls[2]!.since).toBeUndefined()
    expect(calls[3]!.since).toBe(0)
  })

  it('does nothing without a folder, or with an engine that has no watcher', async () => {
    const { client, calls } = scriptedClient([])
    mount(client, null)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls).toEqual([])
    cleanup()
    // MockSketchClient has no fsWatch at all: mounting must simply not throw.
    mount(new MockSketchClient())
  })
})

describe('path keys', () => {
  it('match a file however it is spelled on Windows, and keep case elsewhere', () => {
    expect(diskPathKey('C:\\Work\\App\\src\\a.ts')).toBe(diskPathKey('c:/work/app/src/a.ts'))
    expect(diskPathKey('/home/Dev/a.ts')).not.toBe(diskPathKey('/home/dev/a.ts'))
    expect(parentKey('C:\\Work\\App\\src\\a.ts')).toBe('c:/work/app/src')
    expect(parentKey('C:/a.ts')).toBe('c:/')
    expect(parentKey('/a.ts')).toBe('/')
  })
})
