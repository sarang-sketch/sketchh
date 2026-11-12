// The desktop window is a web view, and a web view keeps behaving like a browser
// unless it is told not to. In an installed IDE each of these is a bug:
//
//   F5, Ctrl+R, Ctrl+Shift+R      reload the whole app: unsaved tabs, the running agent
//                                 and every terminal session are thrown away
//   Ctrl+F, Ctrl+G, F3            the browser's find bar over the IDE (the editor has
//                                 its own; this is everywhere else)
//   Ctrl+P, Ctrl+S, Ctrl+U        print the window, save the page, view its source
//   Ctrl+O                        a file picker that navigates the window to a file
//   F7                            "Turn on caret browsing?"
//   Alt+Left/Right, mouse back    history navigation away from the app
//   F12, Ctrl+Shift+I/J/C         developer tools
//   right-click                   Back / Refresh / Save as / Print / Inspect
//   dropping a file on the window the web view opens the file IN PLACE of the app
//
// Every guard listens in the BUBBLE phase on the window, after every panel and the
// editor, and leaves an event alone when something already called `preventDefault`.
// So Ctrl+F still opens the editor's own find widget and Ctrl+P still opens Quick
// Open: only what nothing in the app claimed reaches the browser default, and that
// is what is refused.
//
// Right-click keeps the web view's own menu where it is genuinely useful: in a text
// field (Cut, Copy, Paste) and over selected text (Copy). A development build keeps
// reload, developer tools and that menu, which is where they are wanted.

/** What a browser would do with a key the app left unhandled. */
export type BrowserShortcut =
  | 'reload'
  | 'find'
  | 'print'
  | 'save'
  | 'source'
  | 'open'
  | 'caret'
  | 'devtools'
  | 'history'

/** The parts of a keyboard event the classification reads. */
export interface ShortcutKey {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/** The browser-only action a key combination triggers, or null for anything else. */
export function browserShortcut(event: ShortcutKey): BrowserShortcut | null {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
  const mod = event.ctrlKey || event.metaKey
  if (key === 'F5' || key === 'BrowserRefresh' || (mod && !event.altKey && key === 'r')) return 'reload'
  if (key === 'F3' || (mod && !event.altKey && (key === 'f' || key === 'g'))) return 'find'
  if (mod && !event.altKey && key === 'p') return 'print'
  if (mod && !event.altKey && !event.shiftKey && key === 's') return 'save'
  if (mod && !event.altKey && !event.shiftKey && key === 'u') return 'source'
  if (mod && !event.altKey && !event.shiftKey && key === 'o') return 'open'
  if (key === 'F7' && !mod && !event.altKey) return 'caret'
  if (key === 'F12' || (mod && event.shiftKey && !event.altKey && (key === 'i' || key === 'j' || key === 'c'))) return 'devtools'
  if (key === 'BrowserBack' || key === 'BrowserForward') return 'history'
  if (event.altKey && !mod && (key === 'ArrowLeft' || key === 'ArrowRight')) return 'history'
  return null
}

/** A text field, a text area, or editable content: where the native menu and keys belong. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null || typeof (target as { closest?: unknown }).closest !== 'function') return false
  const element = target as Element
  if (element.closest('textarea, [contenteditable=""], [contenteditable="true"]') !== null) return true
  const input = element.closest('input')
  if (input === null) return false
  const type = (input.getAttribute('type') ?? 'text').toLowerCase()
  return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image'].includes(type)
}

export interface DesktopGuardOptions {
  /** A development build: reload, developer tools and the native menu stay available. */
  dev: boolean
  /** F5 means "run" in an IDE. Called instead of reloading, when given. */
  onRun?: () => void
}

/**
 * Installs the guards on `target` and returns the function that removes them.
 * Only the desktop shell installs them; in a plain browser tab, reload and the rest
 * are the user's browser, not ours to take away.
 */
export function installDesktopGuards(target: Window, options: DesktopGuardOptions): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    const kind = browserShortcut(event)
    if (kind === null) return
    if (options.dev && (kind === 'reload' || kind === 'devtools')) return
    // Alt+Left in a text field is a caret movement on macOS (Option+Left), not history.
    if (kind === 'history' && isEditableTarget(event.target)) return
    event.preventDefault()
    if (kind === 'reload' && event.key === 'F5' && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      options.onRun?.()
    }
  }

  const onContextMenu = (event: MouseEvent) => {
    if (event.defaultPrevented || options.dev) return
    if (isEditableTarget(event.target)) return
    const selection = target.getSelection?.()
    if (selection !== null && selection !== undefined && selection.toString().trim() !== '') return
    event.preventDefault()
  }

  // The mouse's back and forward buttons are buttons 3 and 4.
  const onMouseButton = (event: MouseEvent) => {
    if (event.button === 3 || event.button === 4) event.preventDefault()
  }

  const carriesFiles = (event: DragEvent) => {
    const types = event.dataTransfer?.types
    if (types === undefined) return false
    return Array.from(types).some((type) => type === 'Files' || type === 'text/uri-list')
  }
  const onDragOver = (event: DragEvent) => {
    if (event.defaultPrevented || !carriesFiles(event)) return
    // Not a drop target anywhere the app did not say so: no "open the file here".
    event.preventDefault()
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'none'
  }
  const onDrop = (event: DragEvent) => {
    if (event.defaultPrevented || !carriesFiles(event)) return
    event.preventDefault()
  }

  target.addEventListener('keydown', onKeyDown)
  target.addEventListener('contextmenu', onContextMenu)
  target.addEventListener('mousedown', onMouseButton)
  target.addEventListener('mouseup', onMouseButton)
  target.addEventListener('auxclick', onMouseButton)
  target.addEventListener('dragover', onDragOver)
  target.addEventListener('drop', onDrop)
  return () => {
    target.removeEventListener('keydown', onKeyDown)
    target.removeEventListener('contextmenu', onContextMenu)
    target.removeEventListener('mousedown', onMouseButton)
    target.removeEventListener('mouseup', onMouseButton)
    target.removeEventListener('auxclick', onMouseButton)
    target.removeEventListener('dragover', onDragOver)
    target.removeEventListener('drop', onDrop)
  }
}

/** True inside the Tauri shell (the packaged app and `tauri dev`), false in a browser. */
export function isDesktopShell(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * The title the operating system shows for the window — the taskbar, Alt+Tab, the
 * Dock — in the form every editor uses: `● file.ts — project — Sketch`.
 */
export function windowTitle(input: { file: string | null; dirty: boolean; folder: string | null }): string {
  const parts = [input.file, input.folder, 'Sketch'].filter((part): part is string => part !== null && part !== '')
  return `${input.dirty && input.file !== null ? '● ' : ''}${parts.join(' — ')}`
}

/** Applies a title to the document and, in the desktop shell, to the native window. */
export async function applyWindowTitle(title: string): Promise<void> {
  if (typeof document !== 'undefined') document.title = title
  if (!isDesktopShell()) return
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().setTitle(title)
  } catch {
    // A shell without the title permission keeps its previous title; nothing else depends on it.
  }
}
