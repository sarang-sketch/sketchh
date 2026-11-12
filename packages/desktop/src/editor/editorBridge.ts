// A narrow handle on the live editor for code that is not the editor: Save (format on
// save), the command palette (Format Document, Go to Line, Find), the title-bar menus.
//
// The editor registers itself while it is mounted and unregisters on unmount, so a
// caller can always ask and must handle "no editor is showing" — which is a real state
// (the welcome screen, a closed project), not an error.

import type { TextModel } from './monacoApi'

export interface EditorBridge {
  /**
   * Format the buffer for `path` with its language's formatter, if it has one, and
   * return the formatted text. Null when there is no formatter or nothing changed.
   */
  format(path: string): Promise<string | null>
  /** Run a built-in editor action on the visible editor, e.g. `editor.action.gotoLine`. */
  run(actionId: string): boolean
  focus(): void
  /**
   * Put `text` at the caret of the visible editor, replacing the selection, as one
   * undoable edit. False when no file is on screen or the editor cannot edit.
   */
  insertText?(text: string): boolean
  /**
   * The live model of an OPEN file — the same one its tab edits — so the diff view's
   * right-hand side is the real buffer: typing there marks the tab dirty and saving
   * saves it. Null when the file is not open in a tab.
   */
  acquireModel?(path: string): TextModel | null
}

let current: EditorBridge | null = null
const waiting = new Set<() => void>()

export function registerEditorBridge(bridge: EditorBridge): () => void {
  current = bridge
  for (const notify of [...waiting]) notify()
  return () => {
    if (current === bridge) current = null
  }
}

/**
 * Hand `listener` the editor's bridge: at once when an editor is mounted, else as soon
 * as one registers. Something that opens a tab and needs its editor in the same render
 * (the diff view borrowing the tab's model) cannot rely on which effect runs first.
 * Returns a function that stops waiting.
 */
export function whenEditorBridge(listener: (bridge: EditorBridge) => void): () => void {
  if (current !== null) {
    listener(current)
    return () => {}
  }
  const notify = () => {
    if (current === null) return
    waiting.delete(notify)
    listener(current)
  }
  waiting.add(notify)
  return () => {
    waiting.delete(notify)
  }
}

export function editorBridge(): EditorBridge | null {
  return current
}

/** Run an editor action if an editor is showing. True when it was handed over. */
export function runEditorAction(actionId: string): boolean {
  return current?.run(actionId) ?? false
}

/** Insert text at the caret of the visible editor. True when it was inserted. */
export function insertEditorText(text: string): boolean {
  return current?.insertText?.(text) ?? false
}

/** Whether an editor is on screen to insert into. */
export function hasEditor(): boolean {
  return current !== null
}
