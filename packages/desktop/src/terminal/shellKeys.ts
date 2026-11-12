// What a key does when a real shell terminal has focus.
//
// A shell needs nearly every Ctrl key — Ctrl+C interrupts, Ctrl+R searches history,
// Ctrl+W deletes a word, Ctrl+D ends input, Ctrl+L clears — so the emulator gets them
// all, except the handful every desktop terminal (Windows Terminal, VS Code, iTerm)
// gives the clipboard instead:
//
//   * Ctrl+C WITH a selection copies; without one it is the interrupt, as always.
//   * Ctrl+Shift+C / Ctrl+Insert copy. On macOS, Cmd+C copies.
//   * Ctrl+V, Ctrl+Shift+V, Shift+Insert (Cmd+V) paste. The paste is left to the web
//     view's native paste into the emulator's input element, which the emulator turns
//     into a bracketed paste for the shell — no clipboard permission prompt involved.
//   * Cmd+K on macOS clears, as in Terminal.app.
//
// Window-wide shortcuts (Ctrl+P, Ctrl+B, Ctrl+J, Ctrl+`…) are taken by the app's
// capture-phase handler before the emulator sees them, as VS Code's
// "commands to skip shell" do, so nothing here has to know about them.

export interface ShellKey {
  type: string
  key: string
  code?: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

export type ShellKeyAction =
  /** The emulator handles it and the shell gets it. */
  | 'terminal'
  /** Copy the selection to the clipboard. */
  | 'copy'
  /** Let the web view paste into the emulator natively. */
  | 'paste'
  /** Clear the scrollback. */
  | 'clear'

export function shellKeyAction(event: ShellKey, hasSelection: boolean, mac: boolean): ShellKeyAction {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
  if (mac) {
    if (event.metaKey && !event.ctrlKey && !event.altKey) {
      if (key === 'c') return hasSelection ? 'copy' : 'terminal'
      if (key === 'v') return 'paste'
      if (key === 'k') return 'clear'
    }
    return 'terminal'
  }
  if (event.ctrlKey && !event.altKey && !event.metaKey) {
    if (key === 'c' && (event.shiftKey || hasSelection)) return 'copy'
    if (key === 'v') return 'paste'
    if (key === 'Insert' && !event.shiftKey) return hasSelection ? 'copy' : 'terminal'
  }
  if (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && key === 'Insert') return 'paste'
  return 'terminal'
}

/** True on macOS, where Cmd is the clipboard modifier. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? ''
  return /mac/i.test(platform)
}
