// One lazy, cached entry point to the real Monaco.
//
// The import is dynamic for three reasons: Monaco is by far the largest thing in the
// bundle and belongs in its own chunk that loads when an editor first mounts; it
// touches `self`, `matchMedia` and real layout at module scope, so a static import
// would drag it into every test that renders anything; and a failure to load is then
// a value the UI can report rather than a blank screen.
//
// This module is the seam tests replace (`vi.mock('./monacoSetup')`). Everything
// below it — the model map, the reducer, the reconciliation — runs for real.

import type { MonacoApi } from './monacoApi'

let pending: Promise<{ api: MonacoApi; theme: string }> | null = null

export interface LoadedMonaco {
  api: MonacoApi
  /** Theme name to pass to `editor.create`. */
  theme: string
}

/** Loads Monaco once per session. Concurrent callers share one load. */
export function loadMonaco(): Promise<LoadedMonaco> {
  pending ??= import('./monacoRuntime').then((mod) => ({
    api: mod.monacoApi,
    theme: mod.SKETCH_THEME,
  }))
  return pending
}
