// Closing the window with unsaved edits asks first — however the window is closed.
//
// The title bar's ✕ always asked. Alt+F4, the taskbar's Close and the Dock's Quit did
// not: the window has no native frame, those go straight to the operating system, and
// the edits were gone. The desktop shell now hears every close request
// (`onCloseRequested`), and both paths ask the same question through `askToClose`.
//
// The title bar asks before it calls `close()`, so it marks the close as already
// confirmed; the close request that follows is then let through without asking twice.

import type { Confirm } from '../components/ConfirmDialog'

let confirmed = false

/** The next close request was already confirmed by the user (the title bar asked). */
export function markCloseConfirmed(): void {
  confirmed = true
}

/** Whether the pending close was already confirmed; reading it clears it. */
export function takeCloseConfirmed(): boolean {
  const was = confirmed
  confirmed = false
  return was
}

/**
 * Asks about unsaved files before the window closes. Resolves true to close: nothing
 * unsaved, "Don't Save", or "Save" that saved everything. False keeps the window open.
 */
export async function askToClose(dirtyNames: readonly string[], confirm: Confirm, saveAll: () => Promise<boolean>): Promise<boolean> {
  if (dirtyNames.length === 0) return true
  const choice = await confirm({
    title: dirtyNames.length === 1 ? `Save changes to ${dirtyNames[0]} before closing?` : `Save changes to ${dirtyNames.length} files before closing?`,
    message: 'Your changes will be lost if you don’t save them.',
    buttons: [
      { id: 'save', label: dirtyNames.length === 1 ? 'Save' : 'Save All', kind: 'primary' },
      { id: 'discard', label: 'Don’t Save', kind: 'danger' },
      { id: 'cancel', label: 'Cancel' },
    ],
    cancelId: 'cancel',
  })
  if (choice === 'cancel') return false
  if (choice === 'save') return saveAll()
  return true
}
