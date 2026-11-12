// The desktop guards: browser behaviour the packaged app must not have, refused only
// when nothing in the app handled the event first.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserShortcut, installDesktopGuards, isEditableTarget, windowTitle } from './desktopGuards'

function key(init: Partial<KeyboardEventInit> & { key: string }, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

function drag(type: 'dragover' | 'drop', types: string[], target: EventTarget = document.body) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent
  const dataTransfer = { types, dropEffect: 'copy' }
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  target.dispatchEvent(event)
  return { event, dataTransfer }
}

describe('browserShortcut', () => {
  const none = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }
  it.each([
    [{ ...none, key: 'F5' }, 'reload'],
    [{ ...none, key: 'r', ctrlKey: true }, 'reload'],
    [{ ...none, key: 'R', ctrlKey: true, shiftKey: true }, 'reload'],
    [{ ...none, key: 'f', ctrlKey: true }, 'find'],
    [{ ...none, key: 'F3' }, 'find'],
    [{ ...none, key: 'g', ctrlKey: true }, 'find'],
    [{ ...none, key: 'p', ctrlKey: true }, 'print'],
    [{ ...none, key: 's', ctrlKey: true }, 'save'],
    [{ ...none, key: 'u', ctrlKey: true }, 'source'],
    [{ ...none, key: 'o', metaKey: true }, 'open'],
    [{ ...none, key: 'F7' }, 'caret'],
    [{ ...none, key: 'F12' }, 'devtools'],
    [{ ...none, key: 'I', ctrlKey: true, shiftKey: true }, 'devtools'],
    [{ ...none, key: 'ArrowLeft', altKey: true }, 'history'],
    [{ ...none, key: 'BrowserBack' }, 'history'],
  ] as const)('%o is %s', (event, kind) => {
    expect(browserShortcut(event)).toBe(kind)
  })

  it.each([
    { ...none, key: 'c', ctrlKey: true },
    { ...none, key: 'v', ctrlKey: true },
    { ...none, key: 'x', ctrlKey: true },
    { ...none, key: 'z', ctrlKey: true },
    { ...none, key: 'a', ctrlKey: true },
    { ...none, key: 'ArrowLeft' },
    { ...none, key: 'ArrowLeft', ctrlKey: true },
    { ...none, key: 'Tab', shiftKey: true },
    { ...none, key: 'a' },
    { ...none, key: 'F2' },
  ])('leaves editing keys alone: %o', (event) => {
    expect(browserShortcut(event)).toBeNull()
  })
})

describe('installDesktopGuards', () => {
  let remove: () => void = () => {}
  const onRun = vi.fn()

  beforeEach(() => {
    document.body.innerHTML = '<div id="panel">Explorer</div><textarea id="field"></textarea><input id="check" type="checkbox" />'
    onRun.mockReset()
    remove = installDesktopGuards(window, { dev: false, onRun })
  })
  afterEach(() => {
    remove()
    window.getSelection()?.removeAllRanges()
  })

  it('refuses reload, and F5 means Run instead', () => {
    expect(key({ key: 'F5' }).defaultPrevented).toBe(true)
    expect(onRun).toHaveBeenCalledTimes(1)
    expect(key({ key: 'r', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(key({ key: 'F5', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(onRun).toHaveBeenCalledTimes(1)
  })

  it('refuses the find bar, print, view source and caret browsing outside the editor', () => {
    for (const init of [{ key: 'f', ctrlKey: true }, { key: 'p', ctrlKey: true }, { key: 'u', ctrlKey: true }, { key: 'F7' }]) {
      expect(key(init).defaultPrevented).toBe(true)
    }
  })

  it('never touches copy, paste, undo or select-all', () => {
    for (const k of ['c', 'v', 'x', 'z', 'a', 'y']) {
      expect(key({ key: k, ctrlKey: true }, document.getElementById('field')!).defaultPrevented).toBe(false)
    }
  })

  it('leaves a key alone that the app already handled — the editor keeps its own Ctrl+F', () => {
    const panel = document.getElementById('panel')!
    const handled = (event: Event) => event.preventDefault()
    panel.addEventListener('keydown', handled)
    // The editor handled F5 too: no Run on top of whatever it did.
    key({ key: 'F5' }, panel)
    panel.removeEventListener('keydown', handled)
    expect(onRun).not.toHaveBeenCalled()
  })

  it('keeps Option/Alt+arrow in a text field (word movement on macOS), refuses it elsewhere', () => {
    expect(key({ key: 'ArrowLeft', altKey: true }, document.getElementById('field')!).defaultPrevented).toBe(false)
    expect(key({ key: 'ArrowLeft', altKey: true }, document.getElementById('panel')!).defaultPrevented).toBe(true)
  })

  it('a development build keeps reload and developer tools', () => {
    remove()
    remove = installDesktopGuards(window, { dev: true, onRun })
    expect(key({ key: 'F5' }).defaultPrevented).toBe(false)
    expect(key({ key: 'F12' }).defaultPrevented).toBe(false)
    expect(onRun).not.toHaveBeenCalled()
    // The find bar is still not ours to show.
    expect(key({ key: 'f', ctrlKey: true }).defaultPrevented).toBe(true)
  })

  it("refuses the web view's menu on the app's chrome, keeps it in text fields and over a selection", () => {
    const menu = (target: Element) => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      target.dispatchEvent(event)
      return event.defaultPrevented
    }
    const panel = document.getElementById('panel')!
    expect(menu(panel)).toBe(true)
    expect(menu(document.getElementById('field')!)).toBe(false)

    const range = document.createRange()
    range.selectNodeContents(panel)
    window.getSelection()!.addRange(range)
    expect(menu(panel)).toBe(false)
  })

  it("leaves the app's own context menus to the app", () => {
    const panel = document.getElementById('panel')!
    const own = (event: Event) => event.preventDefault()
    panel.addEventListener('contextmenu', own)
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    panel.dispatchEvent(event)
    panel.removeEventListener('contextmenu', own)
    // Prevented exactly once, by the app; the guard did not need to.
    expect(event.defaultPrevented).toBe(true)
  })

  it('refuses the mouse back and forward buttons', () => {
    for (const button of [3, 4]) {
      const event = new MouseEvent('mouseup', { bubbles: true, cancelable: true, button })
      document.body.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    }
    const left = new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 })
    document.body.dispatchEvent(left)
    expect(left.defaultPrevented).toBe(false)
  })

  it('a file dropped on the window is refused instead of opening in place of the app', () => {
    const over = drag('dragover', ['Files'])
    expect(over.event.defaultPrevented).toBe(true)
    expect(over.dataTransfer.dropEffect).toBe('none')
    expect(drag('drop', ['Files']).event.defaultPrevented).toBe(true)
    expect(drag('dragover', ['text/uri-list', 'text/plain']).event.defaultPrevented).toBe(true)
  })

  it("leaves the app's own drags (Explorer moves, tab reorder) to their drop targets", () => {
    expect(drag('dragover', ['application/x-sketch-path']).event.defaultPrevented).toBe(false)
    expect(drag('dragover', ['text/plain']).event.defaultPrevented).toBe(false)
  })

  it('removing the guards restores the defaults', () => {
    remove()
    remove = () => {}
    expect(key({ key: 'F5' }).defaultPrevented).toBe(false)
    expect(drag('dragover', ['Files']).event.defaultPrevented).toBe(false)
  })
})

describe('isEditableTarget', () => {
  it('knows text fields from buttons and checkboxes', () => {
    document.body.innerHTML =
      '<input id="a" /><input id="b" type="search" /><input id="c" type="checkbox" /><button id="d">x</button><div contenteditable="true"><span id="e">t</span></div>'
    expect(isEditableTarget(document.getElementById('a'))).toBe(true)
    expect(isEditableTarget(document.getElementById('b'))).toBe(true)
    expect(isEditableTarget(document.getElementById('c'))).toBe(false)
    expect(isEditableTarget(document.getElementById('d'))).toBe(false)
    expect(isEditableTarget(document.getElementById('e'))).toBe(true)
    expect(isEditableTarget(null)).toBe(false)
  })
})

describe('windowTitle', () => {
  it('names the file, the folder and the app, and marks unsaved work', () => {
    expect(windowTitle({ file: 'App.tsx', dirty: true, folder: 'sketch' })).toBe('● App.tsx — sketch — Sketch')
    expect(windowTitle({ file: 'App.tsx', dirty: false, folder: 'sketch' })).toBe('App.tsx — sketch — Sketch')
    expect(windowTitle({ file: null, dirty: false, folder: 'sketch' })).toBe('sketch — Sketch')
    expect(windowTitle({ file: null, dirty: true, folder: null })).toBe('Sketch')
  })
})
