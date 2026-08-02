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

import { editorExtensionRegistry } from './extensionRegistry'
import type { MonacoApi } from './monacoApi'

let pendingApi: Promise<MonacoApi> | null = null

export interface LoadedMonaco {
  api: MonacoApi
  /** Theme name to pass to `editor.create`. */
  theme: string
}

/** Applies the current registry to a Monaco API. Used by the real lazy loader. */
export function prepareMonaco(api: MonacoApi): LoadedMonaco {
  for (const registered of editorExtensionRegistry.registeredThemes()) {
    api.editor.defineTheme(registered.id, registered.definition)
  }
  for (const registered of editorExtensionRegistry.registeredLanguages()) {
    api.languages.register({ id: registered.id, extensions: registered.extensions })
    api.languages.setMonarchTokensProvider(registered.id, registered.rules)
  }
  return { api, theme: editorExtensionRegistry.activeTheme }
}

/** Loads bundled Monaco once; each editor sees registrations made before creation. */
export function loadMonaco(): Promise<LoadedMonaco> {
  pendingApi ??= import('./monacoRuntime').then((mod) => mod.monacoApi)
  return pendingApi.then(prepareMonaco)
}
