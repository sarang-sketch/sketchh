// Reconciling the engine's writes with the editor's buffers (Requirement 15.3).
//
// The engine emits `edit_accepted { path, created, bytes }` after each file it
// writes, and those events reach the UI on the same stream the Timeline reads. The
// path in the payload is the path the model asked for — usually PROJECT-RELATIVE —
// so it is resolved against the open project root before it can be compared with a
// tab (see editor/paths.ts).
//
// WHAT HAPPENS NEXT IS DECIDED BY THE REDUCER, NOT HERE. This hook re-reads the file
// and dispatches `ENGINE_WROTE_FILE`; `AppState` then either updates a clean buffer
// or flags a dirty one as conflicting. Deciding it here would mean reading `isDirty`,
// awaiting a disk read, and acting on a flag that may have changed while we waited —
// a race whose losing outcome is overwriting something the user typed.
//
// WHY A DIRTY BUFFER IS NEVER OVERWRITTEN: the user's unsaved text exists in exactly
// one place and cannot be recovered if we drop it. The engine's version is on disk
// and can be re-read at any time. So the buffer is kept, the conflict is shown, and
// both ways out ("Reload from disk", "Keep my version") are explicit user choices.
//
// Validates: Requirements 15.2, 15.3

import { useEffect, useRef } from 'react'
import type { SketchEvent } from '../lib/contracts'
import { useOptionalSketchEvents } from '../lib/ClientProvider'
import { useAppDispatch, useAppState } from '../state/AppState'
import { useFileIo } from './FileIoProvider'
import { readForEditor } from './fileIo'
import { toAbsolutePath } from './paths'

export interface EngineWrite {
  /** The event's own id, so each write is reconciled exactly once. */
  eventId: string
  /** Canonical absolute path. */
  path: string
  bytes: number
  at: number
}

/**
 * The engine writes described by an event log, in order. Pure, so the mapping from
 * an event payload to a model-map key is testable without React.
 */
export function engineWrites(events: readonly SketchEvent[], root: string): EngineWrite[] {
  const writes: EngineWrite[] = []
  for (const event of events) {
    if (event.kind !== 'edit_accepted') continue
    const raw = event.payload['path']
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const bytes = event.payload['bytes']
    writes.push({
      eventId: event.id,
      path: toAbsolutePath(root, raw),
      bytes: typeof bytes === 'number' ? bytes : 0,
      at: event.ts,
    })
  }
  return writes
}

/**
 * Subscribe the open buffers to the engine's writes. Rendered once, by the editor.
 */
export function useEngineWriteReconciler(): void {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const io = useFileIo()
  const events = useOptionalSketchEvents()

  /** Event ids already handled. The log is cumulative, so this is what bounds work. */
  const handled = useRef<Set<string>>(new Set())
  const openFiles = useRef<readonly string[]>(state.openFiles)
  openFiles.current = state.openFiles

  const root = state.projectRoot

  useEffect(() => {
    if (!root) return
    let cancelled = false

    for (const write of engineWrites(events, root)) {
      if (handled.current.has(write.eventId)) continue
      handled.current.add(write.eventId)
      // A file the editor does not have open needs no reconciliation. The editor is
      // not a cache of the project.
      if (!openFiles.current.includes(write.path)) continue

      void (async () => {
        const outcome = await readForEditor(io, root, write.path)
        if (cancelled) return
        if (!outcome.ok) {
          dispatch({
            type: 'SET_EDITOR_NOTICE',
            payload: {
              level: 'error',
              message: `The engine wrote ${write.path} but the editor could not re-read it. ${outcome.message}`,
            },
          })
          return
        }
        dispatch({
          type: 'ENGINE_WROTE_FILE',
          payload: {
            path: write.path,
            content: outcome.content,
            bytes: write.bytes,
            at: write.at,
          },
        })
      })()
    }

    return () => {
      cancelled = true
    }
  }, [events, root, io, dispatch])
}
