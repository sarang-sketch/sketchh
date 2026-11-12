// Real shells in the terminal panel: one xterm.js emulator per tab, bound to a shell
// running in a pseudo-terminal (see ptyBackend.ts and src-tauri/terminal).
//
// ── SESSIONS OUTLIVE THE PANEL ──────────────────────────────────────────────
//
// Closing the bottom panel, switching to Cowork or to another terminal tab unmounts
// the view, and none of that may end the shell: a dev server keeps serving, a REPL
// keeps its variables. So sessions live here, in a per-window manager above the
// layout, and a view only ATTACHES a session's emulator to its container — the same
// DOM node is moved, scrollback and all, when the panel comes back.
//
// ── ORDER ───────────────────────────────────────────────────────────────────
//
// Output arrives on Tauri's ordered channel. Input is the opposite direction and
// Tauri runs async commands concurrently, so two keystrokes sent as two invokes could
// overtake each other. Input therefore goes through one queue per session: while a
// write is in flight, later keystrokes collect and go as one write after it.
//
// Input typed before the shell has started is queued too. That includes the emulator's
// own answer to ConPTY's opening "where is the cursor?" query, without which Windows
// shells never print their first prompt.
//
// ── OUTPUT IS NOT HTML ──────────────────────────────────────────────────────
//
// xterm.js renders terminal output into its own cell grid; nothing here builds markup
// from it. Links are detected on the plain text of a row and activated through the
// window's own handler: a URL opens in the browser, a file location in the editor.

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ITerminalOptions, ITheme, Terminal as XTerm } from '@xterm/xterm'

import { openExternal } from '../components/Markdown'
import { useAppDispatch, useAppState } from '../state/AppState'
import { COLOR_SCHEME_EVENT, currentScheme, type ColorScheme } from '../styles/colorTheme'
import { APPEARANCE_EVENT } from '../styles/appearance'
import { terminalLinksOf, type TerminalLinkTarget } from './links'
import { tauriPtyBackend, type PtyBackend, type PtyEvent, type ShellProfile } from './ptyBackend'
import { isMacPlatform, shellKeyAction } from './shellKeys'

/** The part of xterm.js's Terminal a session uses. Tests supply a double. */
export type EmulatorLike = Pick<
  XTerm,
  | 'cols'
  | 'rows'
  | 'element'
  | 'buffer'
  | 'open'
  | 'write'
  | 'onData'
  | 'onResize'
  | 'onTitleChange'
  | 'attachCustomKeyEventHandler'
  | 'registerLinkProvider'
  | 'hasSelection'
  | 'getSelection'
  | 'clearSelection'
  | 'selectAll'
  | 'clear'
  | 'focus'
  | 'dispose'
  | 'scrollToBottom'
  | 'paste'
> & { options: ITerminalOptions }

export interface Emulator {
  term: EmulatorLike
  /** Fit the grid to the container the emulator is attached to. */
  fit: () => void
}

export type EmulatorFactory = (options: ITerminalOptions) => Emulator

export type ShellStatus = 'starting' | 'running' | 'exited' | 'failed'

export interface ShellSnapshot {
  status: ShellStatus
  exitCode: number | null
  error: string | null
  profile: ShellProfile | null
  /** The folder the shell started in. */
  cwd: string | null
  /** What the shell last set as its window title (prompt frameworks set the folder). */
  title: string | null
}

export interface ShellStart {
  projectRoot: string
  /** Absolute, inside the project; null for the root. */
  cwd: string | null
  /** Null for the machine's default shell. */
  profileId: string | null
}

type LinkHandler = (target: TerminalLinkTarget, session: ShellSession) => void

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function noop(): void {}

/** The 16 ANSI colours on the dark background. */
const DARK_ANSI = {
  black: '#1e1e1e',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#eab308',
  blue: '#3b82f6',
  magenta: '#d946ef',
  cyan: '#06b6d4',
  white: '#e5e5e5',
  brightBlack: '#737373',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#facc15',
  brightBlue: '#60a5fa',
  brightMagenta: '#e879f9',
  brightCyan: '#22d3ee',
  brightWhite: '#ffffff',
} as const

/** …and on the light one: deep enough that coloured output reads on white. */
const LIGHT_ANSI = {
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#7d4e00',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f',
} as const

/** The window's palette, read from its CSS variables so the terminal matches the theme. */
export function terminalTheme(read: (name: string) => string = cssVariable, scheme: ColorScheme = currentScheme()): ITheme {
  const v = (name: string, fallback: string) => read(name).trim() || fallback
  const light = scheme === 'light'
  return {
    background: v('--bg-primary', light ? '#ffffff' : '#121212'),
    foreground: v('--text-primary', light ? '#1f1f1f' : '#f5f5f5'),
    cursor: v('--accent', '#f97316'),
    cursorAccent: v('--bg-primary', light ? '#ffffff' : '#121212'),
    selectionBackground: light ? 'rgba(234, 88, 12, 0.22)' : 'rgba(249, 115, 22, 0.35)',
    ...(light ? LIGHT_ANSI : DARK_ANSI),
  }
}

function cssVariable(name: string): string {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return ''
  return getComputedStyle(document.documentElement).getPropertyValue(name)
}

/** One shell and its emulator. */
export class ShellSession {
  readonly tabId: string
  readonly term: EmulatorLike
  private readonly fitGrid: () => void
  private readonly backend: PtyBackend
  private readonly onLink: () => LinkHandler
  private start: ShellStart
  private ptyId: number | null = null
  private generation = 0
  private exitedEarly = false
  private opened = false
  private disposed = false
  /** Input waiting for the shell to start, or for the previous write to land. */
  private outbox = ''
  private writing = false
  private resizeTimer: ReturnType<typeof setTimeout> | null = null
  private snapshot: ShellSnapshot = { status: 'starting', exitCode: null, error: null, profile: null, cwd: null, title: null }
  private readonly listeners = new Set<() => void>()

  constructor(options: {
    tabId: string
    backend: PtyBackend
    emulator: Emulator
    start: ShellStart
    mac: boolean
    onLink: () => LinkHandler
  }) {
    this.tabId = options.tabId
    this.backend = options.backend
    this.term = options.emulator.term
    this.fitGrid = options.emulator.fit
    this.start = options.start
    this.onLink = options.onLink

    this.term.onData((data) => {
      const status = this.snapshot.status
      if (status === 'exited' || status === 'failed') {
        // Like a terminal app's "process exited" state: Enter starts a fresh shell.
        if (data === '\r') void this.restart()
        return
      }
      this.send(data)
    })
    this.term.onResize(({ cols, rows }) => this.scheduleResize(cols, rows))
    this.term.onTitleChange((title) => this.update({ title: title.trim() === '' ? null : title }))
    this.term.attachCustomKeyEventHandler((event) => {
      const action = shellKeyAction(event, this.term.hasSelection(), options.mac)
      if (action === 'terminal') return true
      // Swallow the keyup/keypress of a combination the window handled on keydown.
      if (event.type !== 'keydown') return false
      if (action === 'copy') {
        event.preventDefault()
        void this.copySelection()
      } else if (action === 'clear') {
        event.preventDefault()
        this.term.clear()
      }
      // 'paste': not prevented, so the web view pastes into the emulator natively.
      return false
    })
    this.term.registerLinkProvider({
      provideLinks: (row, callback) => {
        const text = this.term.buffer.active.getLine(row - 1)?.translateToString(true) ?? ''
        const links = terminalLinksOf(text)
        if (links.length === 0) {
          callback(undefined)
          return
        }
        callback(
          links.map((link) => ({
            range: { start: { x: link.start + 1, y: row }, end: { x: link.end, y: row } },
            text: text.slice(link.start, link.end),
            decorations: { pointerCursor: true, underline: true },
            activate: () => this.onLink()(link.target, this),
          })),
        )
      },
    })
  }

  getSnapshot = (): ShellSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private update(patch: Partial<ShellSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of [...this.listeners]) listener()
  }

  /** Start the shell (again, after an exit). */
  async launch(): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    this.exitedEarly = false
    this.ptyId = null
    this.outbox = ''
    this.update({ status: 'starting', exitCode: null, error: null })
    try {
      const opened = await this.backend.open({
        projectRoot: this.start.projectRoot,
        cwd: this.start.cwd,
        profileId: this.start.profileId,
        cols: this.term.cols,
        rows: this.term.rows,
        onEvent: (event) => this.receive(generation, event),
      })
      if (this.disposed || generation !== this.generation) {
        void this.backend.close(opened.id).catch(noop)
        return
      }
      if (opened.windowsBuild !== null && opened.windowsBuild !== undefined) {
        this.term.options.windowsPty = { backend: 'conpty', buildNumber: opened.windowsBuild }
      }
      this.update({ profile: opened.profile, cwd: opened.cwd })
      if (this.exitedEarly) return
      this.ptyId = opened.id
      this.update({ status: 'running' })
      // The grid may have been fitted while the shell was starting.
      void this.backend.resize(opened.id, this.term.cols, this.term.rows).catch(noop)
      this.flush()
    } catch (err) {
      if (this.disposed || generation !== this.generation) return
      const message = messageOf(err)
      this.update({ status: 'failed', error: message })
      this.term.write(`\r\n\x1b[31mCould not start the shell: ${message.replace(/[\r\n]+/g, ' ')}\x1b[0m\r\n\x1b[2mPress Enter to try again.\x1b[0m\r\n`)
    }
  }

  private receive(generation: number, event: PtyEvent): void {
    if (this.disposed || generation !== this.generation) return
    if (event.kind === 'data') {
      this.term.write(event.data)
      return
    }
    this.exitedEarly = true
    this.ptyId = null
    this.outbox = ''
    this.update({ status: 'exited', exitCode: event.code })
    const code = event.code === null ? '' : ` with code ${event.code}`
    this.term.write(`\r\n\x1b[2m[The shell exited${code}. Press Enter to start a new one.]\x1b[0m\r\n`)
  }

  /** Keystrokes, a paste, a command line: to the shell, in order. */
  send(data: string): void {
    if (this.disposed || data === '') return
    this.outbox += data
    this.flush()
  }

  /** Type a command into the shell and run it, as if the user had. */
  runLine(line: string): void {
    this.send(`${line.replace(/[\r\n]+$/, '')}\r`)
  }

  private flush(): void {
    if (this.writing || this.ptyId === null || this.outbox === '') return
    this.writing = true
    const id = this.ptyId
    void (async () => {
      try {
        while (this.outbox !== '' && this.ptyId === id && !this.disposed) {
          const chunk = this.outbox
          this.outbox = ''
          try {
            await this.backend.write(id, chunk)
          } catch {
            // The shell went away between keystrokes; its exit event says so.
            break
          }
        }
      } finally {
        this.writing = false
        if (this.outbox !== '' && this.ptyId !== null && this.ptyId !== id) this.flush()
      }
    })()
  }

  private scheduleResize(cols: number, rows: number): void {
    if (this.resizeTimer !== null) clearTimeout(this.resizeTimer)
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null
      const id = this.ptyId
      if (id !== null) void this.backend.resize(id, cols, rows).catch(noop)
    }, 40)
  }

  /** Show this session's emulator in `container`, moving it there if it is elsewhere. */
  attach(container: HTMLElement): void {
    if (this.disposed) return
    if (!this.opened) {
      this.term.open(container)
      this.opened = true
    } else if (this.term.element !== undefined && this.term.element.parentElement !== container) {
      container.appendChild(this.term.element)
    }
    this.fit()
  }

  /** Fit the grid to its container. A hidden container (size 0) is left alone. */
  fit(): void {
    if (!this.opened || this.disposed) return
    try {
      this.fitGrid()
    } catch {
      // Not laid out yet; the next resize fits it.
    }
  }

  focus(): void {
    if (this.opened && !this.disposed) this.term.focus()
  }

  async copySelection(): Promise<boolean> {
    const text = this.term.getSelection()
    if (text === '') return false
    try {
      await navigator.clipboard.writeText(text)
      this.term.clearSelection()
      return true
    } catch {
      return false
    }
  }

  /** Paste text as the user would: the emulator brackets it for the shell. */
  paste(text: string): void {
    if (text !== '') this.term.paste(text)
  }

  clear(): void {
    this.term.clear()
  }

  selectAll(): void {
    this.term.selectAll()
  }

  /** The last `limit` lines of the scrollback, as plain text. */
  recentText(limit = 200): string {
    const buffer = this.term.buffer.active
    const lines: string[] = []
    for (let row = Math.max(0, buffer.length - limit); row < buffer.length; row += 1) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? '')
    }
    return lines.join('\n').replace(/\s+$/, '')
  }

  /** End this shell and start a new one in the same tab, same folder, same profile. */
  async restart(next?: Partial<ShellStart>): Promise<void> {
    if (this.disposed) return
    const id = this.ptyId
    this.ptyId = null
    if (next !== undefined) this.start = { ...this.start, ...next }
    if (id !== null) await this.backend.close(id).catch(noop)
    this.term.write('\r\n')
    await this.launch()
  }

  /** End the shell and release the emulator. Final. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    if (this.resizeTimer !== null) clearTimeout(this.resizeTimer)
    const id = this.ptyId
    this.ptyId = null
    this.listeners.clear()
    try {
      this.term.dispose()
    } catch {
      // Already torn down with its container.
    }
    if (id !== null) await this.backend.close(id).catch(noop)
  }

  get isDisposed(): boolean {
    return this.disposed
  }
}

/** Every shell session in this window, by terminal tab. */
export class ShellSessionManager {
  private readonly sessions = new Map<string, ShellSession>()
  private linkHandler: LinkHandler = noop

  constructor(
    private readonly backend: PtyBackend,
    private readonly createEmulator: EmulatorFactory,
    private readonly mac: boolean,
    private readonly options: () => ITerminalOptions = defaultEmulatorOptions,
  ) {}

  setLinkHandler(handler: LinkHandler): void {
    this.linkHandler = handler
  }

  get(tabId: string): ShellSession | undefined {
    return this.sessions.get(tabId)
  }

  /** The tab's session, created and started on first use. */
  ensure(tabId: string, start: ShellStart): ShellSession {
    const existing = this.sessions.get(tabId)
    if (existing !== undefined && !existing.isDisposed) return existing
    const session = new ShellSession({
      tabId,
      backend: this.backend,
      emulator: this.createEmulator(this.options()),
      start,
      mac: this.mac,
      onLink: () => this.linkHandler,
    })
    this.sessions.set(tabId, session)
    void session.launch()
    return session
  }

  close(tabId: string): void {
    const session = this.sessions.get(tabId)
    if (session === undefined) return
    this.sessions.delete(tabId)
    void session.dispose()
  }

  /** Close the sessions whose tabs no longer exist. */
  retain(tabIds: ReadonlySet<string>): void {
    for (const tabId of [...this.sessions.keys()]) if (!tabIds.has(tabId)) this.close(tabId)
  }

  closeAll(): void {
    for (const tabId of [...this.sessions.keys()]) this.close(tabId)
  }

  /** New colours for every open terminal (the window switched between light and dark). */
  restyle(theme: ITheme = terminalTheme()): void {
    for (const session of this.sessions.values()) {
      if (!session.isDisposed) session.term.options.theme = theme
    }
  }

  get size(): number {
    return this.sessions.size
  }
}

/** How every emulator starts: the window's font and colours, generous scrollback. */
export function defaultEmulatorOptions(): ITerminalOptions {
  const mono = cssVariable('--font-mono').trim()
  return {
    fontFamily: mono !== '' ? `${mono}, Consolas, 'Courier New', monospace` : "'JetBrains Mono', Consolas, 'Courier New', monospace",
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 10_000,
    allowProposedApi: false,
    // Right-click is the window's menu (Copy, Paste, Ask Sketch…), not a word select.
    rightClickSelectsWord: false,
    macOptionIsMeta: true,
    theme: terminalTheme(),
    // OSC 8 hyperlinks (ls --hyperlink, many CLIs): http(s) only, in the browser.
    linkHandler: {
      activate: (_event, uri) => {
        void openExternal(uri)
      },
    },
  }
}

/** xterm.js, loaded on first use so the main bundle does not carry it. */
export async function loadXtermEmulator(): Promise<EmulatorFactory> {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/xterm/css/xterm.css'),
  ])
  return (options) => {
    const term = new Terminal(options)
    const fit = new FitAddon()
    term.loadAddon(fit)
    return { term, fit: () => fit.fit() }
  }
}

export interface ShellTerminals {
  manager: ShellSessionManager
  /** The shells this machine has, its default first. */
  profiles: ShellProfile[]
  /** Look for shells again (after the user installs one). */
  refreshProfiles: () => Promise<void>
}

const ShellTerminalsContext = createContext<ShellTerminals | null>(null)

/**
 * Real shells for the window, when it is the desktop app and its backend can start
 * them. Elsewhere the context stays null and the panel keeps its classic runner.
 */
export function ShellTerminalsProvider({
  children,
  backend: injectedBackend,
  createEmulator,
}: {
  children: ReactNode
  /** Tests inject a scripted backend. Default: the Tauri backend, when there is one. */
  backend?: PtyBackend | null
  /** Tests inject an emulator double. Default: xterm.js, loaded on demand. */
  createEmulator?: EmulatorFactory
}) {
  const dispatch = useAppDispatch()
  const state = useAppState()
  const [value, setValue] = useState<ShellTerminals | null>(null)

  useEffect(() => {
    const backend = injectedBackend === undefined ? tauriPtyBackend() : injectedBackend
    if (backend === null) return
    let cancelled = false
    let manager: ShellSessionManager | null = null
    void (async () => {
      try {
        const [profiles, factory] = await Promise.all([
          backend.profiles(),
          createEmulator !== undefined ? Promise.resolve(createEmulator) : loadXtermEmulator(),
        ])
        if (cancelled || profiles.length === 0) return
        manager = new ShellSessionManager(backend, factory, isMacPlatform())
        const current = manager
        const refreshProfiles = async () => {
          const fresh = await backend.profiles(true)
          setValue((prev) => (prev === null || prev.manager !== current ? prev : { ...prev, profiles: fresh }))
        }
        setValue({ manager, profiles, refreshProfiles })
        dispatch({ type: 'TERMINAL_SHELLS_AVAILABLE', payload: true })
      } catch {
        // A backend without terminal commands (an older build): the classic runner stays.
      }
    })()
    return () => {
      cancelled = true
      manager?.closeAll()
    }
  }, [createEmulator, dispatch, injectedBackend])

  // A closed tab's shell ends with it.
  const tabIds = useMemo(() => new Set(state.terminals.map((t) => t.id)), [state.terminals])
  useEffect(() => {
    value?.manager.retain(tabIds)
  }, [tabIds, value])

  // Light ↔ dark: every open terminal repaints in the new colours, scrollback included.
  useEffect(() => {
    if (value === null) return
    const restyle = () => value.manager.restyle()
    window.addEventListener(COLOR_SCHEME_EVENT, restyle)
    window.addEventListener(APPEARANCE_EVENT, restyle)
    return () => {
      window.removeEventListener(COLOR_SCHEME_EVENT, restyle)
      window.removeEventListener(APPEARANCE_EVENT, restyle)
    }
  }, [value])

  return <ShellTerminalsContext.Provider value={value}>{children}</ShellTerminalsContext.Provider>
}

export function useShellTerminals(): ShellTerminals | null {
  return useContext(ShellTerminalsContext)
}

const IDLE_SNAPSHOT: ShellSnapshot = { status: 'starting', exitCode: null, error: null, profile: null, cwd: null, title: null }
const noSubscription = () => noop

/** A session's live status, for the view. */
export function useShellSnapshot(session: ShellSession | null | undefined): ShellSnapshot {
  return useSyncExternalStore(
    session?.subscribe ?? noSubscription,
    session?.getSnapshot ?? (() => IDLE_SNAPSHOT),
    session?.getSnapshot ?? (() => IDLE_SNAPSHOT),
  )
}
