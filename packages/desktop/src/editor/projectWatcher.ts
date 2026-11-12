// The window's end of the project watcher (core tools/watcher.ts): one long poll at a
// time for the open folder, and every answer announced to the readers that keep the
// window in step with the disk — open tabs, the Explorer, Source Control, Quick Open.
//
// This is what makes a change made OUTSIDE Sketch show up within a moment: a file
// saved in another editor, `git checkout` in an external terminal, a build or a code
// generator writing in the background. The announcement carries the changed paths, so
// a reader re-reads only what changed (diskSync.ts decides what that means for a tab).
//
// Nothing here is required: an engine without `fs-watch`, or a folder that cannot be
// watched, leaves the window exactly as it was — re-reading on focus, after commands
// and after git operations.

import { useEffect, useState } from 'react'

import { useOptionalSketchClient } from '../lib/ClientProvider'
import { useAppState } from '../state/AppState'
import { announceDiskChanged } from './diskSync'

/** How long one poll may wait for a change before it answers empty. */
export const WATCH_POLL_MS = 25_000
/** Waits after failures, doubling, capped. */
const RETRY_MIN_MS = 1_000
const RETRY_MAX_MS = 30_000

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/** Watch the open folder for as long as it is open. Returns whether it is being watched. */
export function useProjectWatcher(): boolean {
  const client = useOptionalSketchClient()
  const root = useAppState().projectRoot
  const [watching, setWatching] = useState(false)

  useEffect(() => {
    setWatching(false)
    if (root === null || client === null || client.fsWatch === undefined) return
    const fsWatch = client.fsWatch.bind(client)
    const controller = new AbortController()
    const { signal } = controller

    void (async () => {
      let cursor: number | undefined
      let retry = RETRY_MIN_MS
      while (!signal.aborted) {
        try {
          const batch = await fsWatch({ root, ...(cursor !== undefined ? { since: cursor } : {}), timeoutMs: WATCH_POLL_MS }, signal)
          if (signal.aborted) return
          if (!batch.watching) {
            // This folder cannot be watched right now (deleted, unmounted, refused).
            setWatching(false)
            cursor = undefined
            await sleep(RETRY_MAX_MS, signal)
            continue
          }
          setWatching(true)
          retry = RETRY_MIN_MS
          const changed = batch.overflow || batch.git || batch.paths.length > 0
          if (cursor !== undefined && changed) {
            announceDiskChanged('watcher', {
              // Too many to list: readers look at everything, as for a terminal command.
              ...(batch.overflow ? {} : { paths: batch.paths }),
              git: batch.git || batch.overflow,
            })
          }
          cursor = batch.cursor
        } catch {
          if (signal.aborted) return
          // The engine restarted or the request failed: start over with a fresh cursor.
          setWatching(false)
          cursor = undefined
          await sleep(retry, signal)
          retry = Math.min(RETRY_MAX_MS, retry * 2)
        }
      }
    })()

    return () => controller.abort()
  }, [client, root])

  return watching
}

/** Mounted once per window, inside the client and state providers. */
export function ProjectWatcher(): null {
  useProjectWatcher()
  return null
}
