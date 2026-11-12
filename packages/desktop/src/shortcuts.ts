// One source of truth for the keyboard shortcuts Sketch binds.
//
// W9 invariant 5: the Shortcuts tab must list exactly the shortcuts that work, and the
// list must not drift from the handlers. The handlers live in three places —
// `App.tsx` (window-wide), `components/EditorArea.tsx` (tab/editor keys bound on the
// window in IDE mode), and `components/CommandPalette.tsx` (routed into Monaco) — so a
// single array of handler objects is not practical without collapsing those three into
// one. Instead this module is the ONE table the Shortcuts tab renders, and it tags each
// row with the layer that binds it. `shortcuts.contract.test.ts` then fails if a
// shortcut the window globally binds in `App.tsx` is missing from this table (a handler
// with no listing) or if a `global` row here names a chord `App.tsx` does not bind (a
// listing with no handler), keeping the two in lockstep.

/** Which layer binds a shortcut. */
export type ShortcutArea = 'global' | 'editor' | 'monaco' | 'chat'

export interface Shortcut {
  /** The chord, written as the Shortcuts tab shows it (Ctrl = Cmd on macOS). */
  keys: string
  /** What it does, in plain words. */
  what: string
  /** Which layer binds the handler. */
  area: ShortcutArea
}

/**
 * Every shortcut the app binds. This is W8's VERIFIED list (fix-editor-workbench.md §6:
 * every entry maps to a working handler, proved by that item's suites) plus the
 * window-wide chords `App.tsx` binds. The Shortcuts settings tab renders this verbatim.
 */
export const SHORTCUTS: readonly Shortcut[] = [
  // Window-wide (App.tsx → Shortcuts component). These are the ones the contract test
  // cross-checks against the handler.
  { keys: 'Ctrl+,', what: 'Settings', area: 'global' },
  { keys: 'Ctrl+O', what: 'Open a folder', area: 'global' },
  { keys: 'Ctrl+P', what: 'Go to file', area: 'global' },
  { keys: 'Ctrl+Shift+P', what: 'All commands', area: 'global' },
  { keys: 'Ctrl+K', what: 'Edit selected code with AI; open commands in Cowork', area: 'global' },
  { keys: 'Ctrl+L', what: 'Ask about selected code, or focus the agent composer', area: 'global' },
  { keys: 'Ctrl+Shift+L', what: 'Enter or exit focus mode', area: 'global' },
  { keys: 'Ctrl+`', what: 'Show or hide the terminal', area: 'global' },
  { keys: 'Ctrl+Shift+`', what: 'New terminal', area: 'global' },
  { keys: 'Ctrl+J', what: 'Show or hide the bottom panel', area: 'global' },
  { keys: 'Ctrl+B', what: 'Show or hide the side bar', area: 'global' },
  { keys: 'Ctrl+Shift+E', what: 'Explorer', area: 'global' },
  { keys: 'Ctrl+Shift+F', what: 'Search in files', area: 'global' },
  { keys: 'Ctrl+Shift+H', what: 'Replace in files', area: 'global' },
  { keys: 'Ctrl+Shift+G', what: 'Source control', area: 'global' },
  { keys: 'Ctrl+Shift+M', what: 'Problems', area: 'global' },
  { keys: 'Ctrl+N', what: 'New file (in the Explorer)', area: 'global' },
  { keys: 'Ctrl+= / Ctrl+-', what: 'Editor zoom in / out', area: 'global' },
  { keys: 'Ctrl+0', what: 'Reset editor zoom', area: 'global' },
  { keys: 'Alt+Z', what: 'Toggle word wrap', area: 'global' },
  { keys: 'Shift+Alt+R', what: 'Reveal the active file in the Explorer / Finder', area: 'global' },

  // Editor tabs (components/EditorArea.tsx, bound on the window in IDE mode).
  { keys: 'Ctrl+S', what: 'Save', area: 'editor' },
  { keys: 'Ctrl+Alt+S', what: 'Save all', area: 'editor' },
  { keys: 'Ctrl+W', what: 'Close the editor tab', area: 'editor' },
  { keys: 'Ctrl+Tab / Ctrl+PageDown / Ctrl+PageUp', what: 'Switch editor tab', area: 'editor' },

  // Routed into Monaco (components/CommandPalette.tsx and the editor itself).
  { keys: 'Ctrl+F / Ctrl+H', what: 'Find / replace in the file', area: 'monaco' },
  { keys: 'Ctrl+G', what: 'Go to line', area: 'monaco' },
  { keys: 'Ctrl+Shift+O', what: 'Go to symbol in the file', area: 'monaco' },
  { keys: 'F12', what: 'Go to definition', area: 'monaco' },
  { keys: 'F2', what: 'Rename symbol (editor) or file (Explorer)', area: 'monaco' },
  { keys: 'Shift+Alt+F', what: 'Format document', area: 'monaco' },
  { keys: 'Ctrl+/', what: 'Toggle line comment', area: 'monaco' },
  { keys: 'F8 / Shift+F8', what: 'Next / previous problem', area: 'monaco' },
  { keys: 'Alt+F5 / Shift+Alt+F5', what: 'Next / previous change since the last commit', area: 'monaco' },
  { keys: 'Alt+\\', what: 'Ask for an autocomplete suggestion now', area: 'monaco' },
  { keys: 'F5', what: 'Run a project script', area: 'monaco' },

  // Chat composer.
  { keys: 'Shift+Tab', what: 'Cycle agent mode (in the chat box)', area: 'chat' },
]

/**
 * The window-wide chords `App.tsx` binds, as normalised chord strings the contract test
 * compares against the `global` rows above. Keep this in step with the `Shortcuts`
 * keydown handler in `App.tsx`: every branch there has an entry here, and vice versa.
 * Chords are normalised to sorted-modifier + key so the test does not care about the
 * written order ("Ctrl+Shift+P" and "Shift+Ctrl+P" compare equal).
 */
export const GLOBAL_CHORDS: readonly string[] = [
  'ctrl+,',
  'ctrl+o',
  'ctrl+p',
  'ctrl+shift+p',
  'ctrl+k',
  'ctrl+l',
  'ctrl+shift+l',
  'ctrl+`',
  'ctrl+shift+`',
  'ctrl+j',
  'ctrl+b',
  'ctrl+shift+e',
  'ctrl+shift+f',
  'ctrl+shift+h',
  'ctrl+shift+g',
  'ctrl+shift+m',
  'ctrl+n',
  'ctrl+=',
  'ctrl+-',
  'ctrl+0',
  'alt+z',
  'shift+alt+r',
]

const MOD_ORDER = ['ctrl', 'shift', 'alt'] as const

/** Normalise one chord (e.g. "Ctrl+Shift+P") to "ctrl+shift+p" with modifiers sorted. */
export function normalizeChord(chord: string): string {
  const parts = chord
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p !== '')
  const mods = MOD_ORDER.filter((m) => parts.includes(m))
  const keys = parts.filter((p) => !(MOD_ORDER as readonly string[]).includes(p))
  return [...mods, ...keys].join('+')
}

/**
 * Split the `global` display rows into the individual chords they list (a row may list
 * two, e.g. "Ctrl+= / Ctrl+-"), normalised. Used by the contract test.
 */
export function globalDisplayChords(): string[] {
  const out: string[] = []
  for (const s of SHORTCUTS) {
    if (s.area !== 'global') continue
    for (const chord of s.keys.split('/')) out.push(normalizeChord(chord))
  }
  return out
}
