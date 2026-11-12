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

import { editorExtensionRegistry, SKETCH_LIGHT_THEME_ID, SKETCH_THEME } from './extensionRegistry'
import { bindEditorThemeSwitch } from './editorTheme'
import { workbenchTheme } from './workbenchTheme'
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
    api.editor.defineTheme(registered.id, registered.id === SKETCH_THEME || registered.id === SKETCH_LIGHT_THEME_ID ? workbenchTheme(registered.definition) : registered.definition)
  }
  for (const registered of editorExtensionRegistry.registeredLanguages()) {
    api.languages.register({ id: registered.id, extensions: registered.extensions })
    api.languages.setMonarchTokensProvider(registered.id, registered.rules)
  }
  // Light ↔ dark from now on reaches the editors already open, not only new ones.
  const setTheme = api.editor.setTheme
  if (setTheme !== undefined) bindEditorThemeSwitch((id) => {
    const registered = editorExtensionRegistry.registeredThemes().find((theme) => theme.id === id)
    if (registered && (id === SKETCH_THEME || id === SKETCH_LIGHT_THEME_ID)) api.editor.defineTheme(id, workbenchTheme(registered.definition))
    setTheme(id)
  })
  return { api, theme: editorExtensionRegistry.activeTheme }
}

/** Loads bundled Monaco once; each editor sees registrations made before creation. */
export function loadMonaco(): Promise<LoadedMonaco> {
  pendingApi ??= import('./monacoRuntime').then((mod) => mod.monacoApi)
  return pendingApi.then(prepareMonaco)
}
