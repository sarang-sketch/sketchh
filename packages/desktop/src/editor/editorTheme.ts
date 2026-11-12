// Which Monaco theme the editors use. Monaco's theme is global — every editor and diff
// editor in the window switches together — so this is one switch, not one per editor.
//
// New editors take the registry's active theme when they are created (monacoSetup.ts).
// Editors that are already open are switched through the function the Monaco loader
// binds here once Monaco is in memory; before that there is nothing to switch.

import { SKETCH_LIGHT_THEME_ID, SKETCH_THEME, editorExtensionRegistry } from './extensionRegistry'

export type EditorScheme = 'dark' | 'light'

let applyLive: ((themeId: string) => void) | null = null

/** Called by the Monaco loader, so a switch reaches the editors already on screen. */
export function bindEditorThemeSwitch(apply: (themeId: string) => void): void {
  applyLive = apply
}

export function editorThemeFor(scheme: EditorScheme): string {
  return scheme === 'light' ? SKETCH_LIGHT_THEME_ID : SKETCH_THEME
}

/** Editors created from now on start in this scheme, and open ones switch to it now. */
export function setEditorScheme(scheme: EditorScheme): void {
  const id = editorThemeFor(scheme)
  editorExtensionRegistry.activateTheme(id)
  applyLive?.(id)
}
