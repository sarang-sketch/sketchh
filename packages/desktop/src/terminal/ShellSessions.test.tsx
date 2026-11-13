// The window side of a real terminal, against a scripted pseudo-terminal backend and an
// emulator double. What these pin, in user terms:
//   * The emulator's answer to ConPTY's opening query — typed before the shell has an
//     id — still reaches the shell, so Windows shells print their first prompt.
//   * Output appears in order; the exit is reported once, and Enter starts a new shell.
//   * Keystrokes reach the shell in the order they were typed, even when a write is slow.
//   * Ctrl+C copies when text is selected and interrupts otherwise; Ctrl+V pastes.
//   * File locations and URLs in the output are links.
//   * Closing a tab ends its shell; a late event from an ended shell changes nothing.

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PtyBackend, PtyEvent, PtyOpenParams, ShellProfile } from './ptyBackend'
import { ShellSessionManager, terminalTheme, type Emulator, type EmulatorLike } from './ShellSessions'
import { shellKeyAction } from './shellKeys'

const PWSH: ShellProfile = { id: 'powershell', name: 'Windows PowerShell', program: 'C:/Windows/powershell.exe', args: [], family: 'powershell' }
const BASH: ShellProfile = { id: 'git-bash', name: 'Git Bash', program: 'C:/Git/bin/bash.exe', args: ['--login', '-i'], family: 'bash' }

interface OpenCall {
  params: PtyOpenParams
  resolve: () => void
  reject: (err: unknown) => void
  id: number
}

/** A scripted backend: the test decides when a shell starts, what it prints and when it exits. */
class FakePty implements PtyBackend {
  opens: OpenCall[] = []
  writes: Array<{ id: number; data: string }> = []
  resizes: Array<{ id: number; cols: number; rows: number }> = []
  closed: number[] = []
  /** When set, each write waits for this before resolving. */
  writeGate: Promise<void> | null = null
  windowsBuild: number | null = 22631
  private nextId = 1

  async profiles(): Promise<ShellProfile[]> {
    return [PWSH, BASH]
  }

  open(params: PtyOpenParams) {
    const id = this.nextId++
    return new Promise<Awaited<ReturnType<PtyBackend['open']>>>((resolve, reject) => {
      const profile = params.profileId === 'git-bash' ? BASH : PWSH
      this.opens.push({
        params,
        id,
        resolve: () => resolve({ id, pid: 4000 + id, profile, cwd: params.cwd ?? params.projectRoot, windowsBuild: this.windowsBuild }),
        reject,
      })
    })
  }

  async write(id: number, data: string) {
    this.writes.push({ id, data })
    if (this.writeGate !== null) await this.writeGate
  }

  async resize(id: number, cols: number, rows: number) {
    this.resizes.push({ id, cols, rows })
  }

  async close(id: number) {
    this.closed.push(id)
    return true
  }

  emit(index: number, event: PtyEvent) {
    this.opens[index]!.params.onEvent(event)
  }
}

/** Just enough of xterm.js: a line buffer, its events, and a selection the test sets. */
class FakeEmulator {
  cols = 100
  rows = 30
  element: HTMLElement | undefined = undefined
  options: Record<string, unknown> = {}
  written = ''
  selection = ''
  pasted: string[] = []
  cleared = 0
  disposed = false
  dataHandlers: Array<(data: string) => void> = []
  resizeHandlers: Array<(size: { cols: number; rows: number }) => void> = []
  titleHandlers: Array<(title: string) => void> = []
  keyHandler: ((event: KeyboardEvent) => boolean) | null = null
  linkProvider: { provideLinks(row: number, cb: (links: unknown[] | undefined) => void): void } | null = null

  buffer = {
    active: {
      get length() {
        return 0
      },
      getLine: (_row: number) => undefined as { translateToString(trim?: boolean): string } | undefined,
    },
  }

  constructor() {
    const lines = () => this.written.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)
    this.buffer = {
      active: {
        get length() {
          return lines().length
        },
        getLine: (row: number) => {
          const text = lines()[row]
          return text === undefined ? undefined : { translateToString: () => text }
        },
      },
    }
  }

  open(parent: HTMLElement) {
    this.element = document.createElement('div')
    this.element.className = 'xterm'
    parent.appendChild(this.element)
  }
  write(data: string) {
    this.written += data
  }
  onData(cb: (data: string) => void) {
    this.dataHandlers.push(cb)
    return { dispose() {} }
  }
  onResize(cb: (size: { cols: number; rows: number }) => void) {
    this.resizeHandlers.push(cb)
    return { dispose() {} }
  }
  onTitleChange(cb: (title: string) => void) {
    this.titleHandlers.push(cb)
    return { dispose() {} }
  }
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
    this.keyHandler = handler
  }
  registerLinkProvider(provider: { provideLinks(row: number, cb: (links: unknown[] | undefined) => void): void }) {
    this.linkProvider = provider
    return { dispose() {} }
  }
  hasSelection() {
    return this.selection !== ''
  }
  getSelection() {
    return this.selection
  }
  clearSelection() {
    this.selection = ''
  }
  selectAll() {
    this.selection = this.written
  }
  clear() {
    this.cleared += 1
  }
  focus() {}
  dispose() {
    this.disposed = true
  }
  scrollToBottom() {}
  paste(data: string) {
    this.pasted.push(data)
  }

  /** The user typing (or the emulator answering a query). */
  type(data: string) {
    for (const handler of this.dataHandlers) handler(data)
  }
}

function setup() {
  const pty = new FakePty()
  const emulators: FakeEmulator[] = []
  const factory = (): Emulator => {
    const fake = new FakeEmulator()
    emulators.push(fake)
    return { term: fake as unknown as EmulatorLike, fit: () => {} }
  }
  const manager = new ShellSessionManager(pty, factory, false, () => ({}))
  return { pty, emulators, manager }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  const event = {
    type: 'keydown',
    code: '',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    defaultPrevented: false,
    preventDefault() {
      ;(this as { defaultPrevented: boolean }).defaultPrevented = true
    },
    ...init,
  }
  return event as unknown as KeyboardEvent
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a real shell session', () => {
  it('starts the requested shell in the tab folder at the emulator size', async () => {
    const { pty, manager } = setup()
    manager.ensure('term-1', { projectRoot: 'C:/work/app', cwd: 'C:/work/app/src', profileId: 'git-bash' })
    expect(pty.opens).toHaveLength(1)
    expect(pty.opens[0]!.params).toMatchObject({ projectRoot: 'C:/work/app', cwd: 'C:/work/app/src', profileId: 'git-bash', cols: 100, rows: 30 })
    // The same tab asks again: the same session, no second shell.
    manager.ensure('term-1', { projectRoot: 'C:/work/app', cwd: null, profileId: null })
    expect(pty.opens).toHaveLength(1)
  })

  it("delivers the emulator's answer to ConPTY's opening query once the shell has an id", async () => {
    const { pty, emulators, manager } = setup()
    const session = manager.ensure('term-1', { projectRoot: 'C:/work/app', cwd: null, profileId: null })
    // ConPTY asks where the cursor is before the open call has even returned.
    pty.emit(0, { kind: 'data', data: '\x1b[6n' })
    emulators[0]!.type('\x1b[1;1R')
    expect(pty.writes).toEqual([])
    pty.opens[0]!.resolve()
    await flush()
    await flush()
    expect(pty.writes).toEqual([{ id: 1, data: '\x1b[1;1R' }])
    expect(session.getSnapshot()).toMatchObject({ status: 'running', profile: PWSH, cwd: 'C:/work/app' })
    // The Windows build reaches the emulator, which then expects ConPTY's behaviour.
    expect(emulators[0]!.options['windowsPty']).toEqual({ backend: 'conpty', buildNumber: 22631 })
  })

  it('writes output in order and reports the exit once; Enter starts a new shell', async () => {
    const { pty, emulators, manager } = setup()
    const session = manager.ensure('term-1', { projectRoot: 'C:/work/app', cwd: null, profileId: null })
    pty.opens[0]!.resolve()
    await flush()
    pty.emit(0, { kind: 'data', data: 'PS C:\\work\\app> ' })
    pty.emit(0, { kind: 'data', data: 'npm test\r\n' })
    pty.emit(0, { kind: 'exit', code: 3 })
    expect(emulators[0]!.written).toContain('PS C:\\work\\app> npm test\r\n')
    expect(emulators[0]!.written).toContain('The shell exited with code 3')
    expect(session.getSnapshot()).toMatchObject({ status: 'exited', exitCode: 3 })
    // Typing into an exited shell does nothing, except Enter, which starts a fresh one.
    emulators[0]!.type('x')
    expect(pty.writes).toEqual([])
    emulators[0]!.type('\r')
    await flush()
    expect(pty.opens).toHaveLength(2)
    // A late event from the ended shell is ignored.
    pty.emit(0, { kind: 'data', data: 'ghost' })
    expect(emulators[0]!.written).not.toContain('ghost')
  })

  it('keeps keystrokes in order when a write is slow, batching what was typed meanwhile', async () => {
    const { pty, emulators, manager } = setup()
    manager.ensure('term-1', { projectRoot: 'C:/work/app', cwd: null, profileId: null })
    pty.opens[0]!.resolve()
    await flush()
    let release!: () => void
    pty.writeGate = new Promise<void>((resolve) => {
      release = resolve
    })
    emulators[0]!.type('g')
    emulators[0]!.type('i')
    emulators[0]!.type('t')
    await flush()
    expect(pty.writes.map((w) => w.data)).toEqual(['g'])
    pty.writeGate = null
    release()
    await flush()
    await flush()
    expect(pty.writes.map((w) => w.data)).toEqual(['g', 'it'])
  })

  it('tells the shell its new size after the grid is resized', async () => {
    const { pty, emulators, manager } = setup()
    manager.ensure('term-1', { projectRoot: 'C:/work/app', cwd: null, profileId: null })
    pty.opens[0]!.resolve()
    await flush()
    for (const handler of emulators[0]!.resizeHandlers) handler({ cols: 140, rows: 40 })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(pty.resizes.at(-1)).toEqual({ id: 1, cols: 140, rows: 40 })
  })

  it('reports a shell that cannot start, and tries again on Enter', async () => {
    const { pty, emulators, manager } = setup()
    const session = manager.ensure('term-1', { projectRoot: 'C:/work/app', cwd: null, profileId: 'wsl:Ubuntu' })
    pty.opens[0]!.reject(new Error('The shell "wsl:Ubuntu" is not installed on this computer (any more).'))
    await flush()
    expect(session.getSnapshot()).toMatchObject({ status: 'failed' })
    expect(emulators[0]!.written).toContain('not installed')
    emulators[0]!.type('\r')
    await flush()
    expect(pty.opens).toHaveLength(2)
  })

  it('closing the tab ends the shell and releases the emulator', async () => {
    const { pty, emulators, manager } = setup()
    manager.ensure('term-1', { projectRoot: 'C:/work/app', cwd: null, profileId: null })
    manager.ensure('term-2', { projectRoot: 'C:/work/app', cwd: null, profileId: null })
    pty.opens[0]!.resolve()
    pty.opens[1]!.resolve()
    await flush()
    manager.retain(new Set(['term-2']))
    await flush()
    expect(pty.closed).toEqual([1])
    expect(emulators[0]!.disposed).toBe(true)
    expect(manager.size).toBe(1)
    // A shell started for a tab that closed before it came up is ended at once.
    manager.ensure('term-3', { projectRoot: 'C:/work/app', cwd: null, profileId: null })
    manager.close('term-3')
    pty.opens[2]!.resolve()
    await flush()
    await flush()
    expect(pty.closed).toContain(3)
  })

  it('turns file locations and URLs in the output into links', async () => {
    const { pty, emulators, manager } = setup()
    const opened: unknown[] = []
    manager.setLinkHandler((target) => opened.push(target))
    manager.ensure('term-1', { projectRoot: 'C:/work/app', cwd: null, profileId: null })
    pty.opens[0]!.resolve()
    await flush()
    pty.emit(0, { kind: 'data', data: 'src/app.ts:12:5 - error TS2322\r\n  ➜  Local:   http://localhost:5173/\r\n' })
    const rows: unknown[][] = []
    emulators[0]!.linkProvider!.provideLinks(1, (links) => rows.push(links ?? []))
    emulators[0]!.linkProvider!.provideLinks(2, (links) => rows.push(links ?? []))
    const first = rows[0]![0] as { range: { start: { x: number }; end: { x: number } }; text: string; activate(e: unknown, t: string): void }
    expect(first.text).toBe('src/app.ts:12:5')
    expect(first.range.start.x).toBe(1)
    first.activate({}, first.text)
    const second = rows[1]![0] as { text: string; activate(e: unknown, t: string): void }
    expect(second.text).toBe('http://localhost:5173/')
    second.activate({}, second.text)
    expect(opened).toEqual([
      { kind: 'file', path: 'src/app.ts', line: 12, column: 5 },
      { kind: 'url', url: 'http://localhost:5173/' },
    ])
  })

  it('copies a selection on Ctrl+C, lets an unselected Ctrl+C interrupt, and leaves paste to the web view', async () => {
    const { pty, emulators, manager } = setup()
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText, readText: async () => 'pasted' }, configurable: true })
    manager.ensure('term-1', { projectRoot: 'C:/work/app', cwd: null, profileId: null })
    pty.opens[0]!.resolve()
    await flush()
    const handler = emulators[0]!.keyHandler!

    // No selection: the emulator sends ^C to the shell.
    expect(handler(key({ key: 'c', ctrlKey: true }))).toBe(true)

    emulators[0]!.selection = 'error: something broke'
    const copy = key({ key: 'c', ctrlKey: true })
    expect(handler(copy)).toBe(false)
    expect(copy.defaultPrevented).toBe(true)
    await flush()
    expect(writeText).toHaveBeenCalledWith('error: something broke')
    expect(emulators[0]!.selection).toBe('')

    // Ctrl+V is not prevented: the web view's native paste reaches the emulator.
    const paste = key({ key: 'v', ctrlKey: true })
    expect(handler(paste)).toBe(false)
    expect(paste.defaultPrevented).toBe(false)
  })

  it('reads the recent scrollback as plain text for "Ask Sketch"', async () => {
    const { pty, manager } = setup()
    const session = manager.ensure('term-1', { projectRoot: 'C:/work/app', cwd: null, profileId: null })
    pty.opens[0]!.resolve()
    await flush()
    pty.emit(0, { kind: 'data', data: 'one\r\ntwo\r\n\x1b[31mthree failed\x1b[0m\r\n' })
    expect(session.recentText(2)).toBe('three failed')
    expect(session.recentText(10)).toContain('one\ntwo\nthree failed')
  })
})

describe('terminal keys', () => {
  const base = { type: 'keydown', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }
  it('keeps every shell Ctrl key in the shell', () => {
    for (const k of ['r', 'w', 'd', 'l', 'a', 'e', 'u', 'k', 'z']) {
      expect(shellKeyAction({ ...base, key: k, ctrlKey: true }, false, false)).toBe('terminal')
    }
  })
  it('maps the clipboard keys every desktop terminal uses', () => {
    expect(shellKeyAction({ ...base, key: 'C', ctrlKey: true, shiftKey: true }, false, false)).toBe('copy')
    expect(shellKeyAction({ ...base, key: 'V', ctrlKey: true, shiftKey: true }, false, false)).toBe('paste')
    expect(shellKeyAction({ ...base, key: 'Insert', shiftKey: true }, false, false)).toBe('paste')
    expect(shellKeyAction({ ...base, key: 'Insert', ctrlKey: true }, true, false)).toBe('copy')
  })
  it('uses Cmd on macOS and leaves Ctrl+C to the shell there', () => {
    expect(shellKeyAction({ ...base, key: 'c', metaKey: true }, true, true)).toBe('copy')
    expect(shellKeyAction({ ...base, key: 'v', metaKey: true }, false, true)).toBe('paste')
    expect(shellKeyAction({ ...base, key: 'k', metaKey: true }, false, true)).toBe('clear')
    expect(shellKeyAction({ ...base, key: 'c', ctrlKey: true }, true, true)).toBe('terminal')
  })
})

describe('the terminal palette', () => {
  it("follows the window's CSS variables and falls back when they are missing", () => {
    const theme = terminalTheme((name) => (name === '--bg-primary' ? '#000011' : ''))
    expect(theme.background).toBe('#000011')
    expect(theme.foreground).toBe('#eeeeec')
  })

  it('has colours that read on white in the light theme', () => {
    const theme = terminalTheme(() => '', 'light')
    expect(theme).toMatchObject({ background: '#ffffff', foreground: '#1f1f1f', red: '#cf222e', green: '#116329' })
    // The dark palette's bright white would vanish on a white background.
    expect(theme.brightWhite).not.toBe('#ffffff')
  })

  it('repaints every open terminal when the window switches theme, and none that closed', async () => {
    const { emulators, manager } = setup()
    manager.ensure('t1', { projectRoot: 'C:/p', cwd: null, profileId: null })
    manager.ensure('t2', { projectRoot: 'C:/p', cwd: null, profileId: null })
    await flush()
    manager.restyle(terminalTheme(() => '', 'light'))
    expect(emulators.map((e) => (e.options['theme'] as { background: string }).background)).toEqual(['#ffffff', '#ffffff'])
    manager.close('t2')
    manager.restyle(terminalTheme(() => '', 'dark'))
    expect((emulators[0]!.options['theme'] as { red: string }).red).toBe('#ef4444')
    expect((emulators[1]!.options['theme'] as { background: string }).background).toBe('#ffffff')
  })
})
