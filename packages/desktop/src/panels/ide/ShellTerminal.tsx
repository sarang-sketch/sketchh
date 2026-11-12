// One real shell, on screen: the session's emulator attached to this view, the
// once-per-folder question before the first shell starts, and a right-click menu.
//
// The session belongs to ShellSessions (above the layout); this view only shows it.
// Unmounting — the panel closing, another tab selected — detaches nothing that
// matters: the shell keeps running and its scrollback is intact when it comes back.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { ContextMenu, type ContextMenuItem } from '../../components/ContextMenu'
import { AlertCircle, Play } from '../../components/Icons'
import { openExternal } from '../../components/Markdown'
import { basename, isWithinRoot, toAbsolutePath } from '../../editor/paths'
import { useFileActions } from '../../editor/useFileActions'
import { useOptionalAgentSession } from '../../lib/AgentSession'
import { useAppDispatch, useAppState, type TerminalTab } from '../../state/AppState'
import { useShellSnapshot, useShellTerminals, type ShellSession } from '../../terminal/ShellSessions'
import { allowFolderForSession, isFolderAllowed, trustFolder } from '../../terminal/trust'
import styles from './ShellTerminal.module.css'

/** How much of the scrollback "Ask Sketch" sends when nothing is selected. */
const ASK_LINES = 80

export function ShellTerminalView({ tab, active }: { tab: TerminalTab; active: boolean }) {
  const shells = useShellTerminals()
  const state = useAppState()
  const dispatch = useAppDispatch()
  const agent = useOptionalAgentSession()
  const fileActions = useFileActions()
  const fileActionsRef = useRef(fileActions)
  fileActionsRef.current = fileActions

  const root = state.projectRoot
  const [allowed, setAllowed] = useState(() => isFolderAllowed(root))
  useEffect(() => setAllowed(isFolderAllowed(root)), [root])

  const manager = shells?.manager ?? null
  const [session, setSession] = useState<ShellSession | null>(() => manager?.get(tab.id) ?? null)
  const snapshot = useShellSnapshot(session)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Start the tab's shell once the folder is allowed (or pick up the running one).
  useEffect(() => {
    if (manager === null || root === null) return
    const existing = manager.get(tab.id)
    if (existing !== undefined) {
      setSession(existing)
      return
    }
    if (!allowed) return
    setSession(manager.ensure(tab.id, { projectRoot: root, cwd: tab.cwd, profileId: tab.profileId ?? null }))
  }, [allowed, manager, root, tab.cwd, tab.id, tab.profileId])

  // Show the emulator here, and keep its grid fitted to the panel.
  useLayoutEffect(() => {
    const container = containerRef.current
    if (session === null || container === null) return
    session.attach(container)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => session.fit())
    observer.observe(container)
    return () => observer.disconnect()
  }, [session])

  // The active tab takes the keyboard, as switching terminals does everywhere.
  useEffect(() => {
    if (!active || session === null) return
    const id = requestAnimationFrame(() => {
      session.fit()
      session.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [active, session])

  // Ctrl+` and "run it" buttons ask for the terminal's focus.
  useEffect(() => {
    if (!active) return
    const focus = () => session?.focus()
    window.addEventListener('sketch:focus-terminal', focus)
    return () => window.removeEventListener('sketch:focus-terminal', focus)
  }, [active, session])

  // The tab is named after its shell once the shell is known: "PowerShell", "Git Bash".
  const profileName = snapshot.profile?.name ?? null
  useEffect(() => {
    if (profileName === null || !/^Terminal \d+$/.test(tab.title)) return
    dispatch({ type: 'TERMINAL_RETITLE', payload: { id: tab.id, title: profileName } })
  }, [dispatch, profileName, tab.id, tab.title])

  // A link in the output: a URL opens in the browser, a file location in the editor.
  useEffect(() => {
    if (manager === null) return
    manager.setLinkHandler((target, from) => {
      if (target.kind === 'url') {
        void openExternal(target.url)
        return
      }
      const project = state.projectRoot
      if (project === null) return
      const base = from.getSnapshot().cwd ?? project
      const absolute = toAbsolutePath(base, target.path)
      if (!isWithinRoot(project, absolute)) {
        dispatch({
          type: 'SET_EDITOR_NOTICE',
          payload: { level: 'info', message: `${target.path} is outside the open folder, so it cannot be opened here.` },
        })
        return
      }
      dispatch({ type: 'SET_MODE', payload: 'ide' })
      void fileActionsRef.current.openPath(absolute).then(() => {
        if (target.line !== undefined) {
          dispatch({ type: 'REVEAL_IN_EDITOR', payload: { path: absolute, line: target.line, column: target.column ?? 1 } })
        }
      })
    })
  }, [dispatch, manager, state.projectRoot])

  const askSketch = useCallback(() => {
    if (session === null || agent === null) return
    const selected = session.term.getSelection().trim()
    const text = selected !== '' ? selected : session.recentText(ASK_LINES)
    const clipped = text.length > 8000 ? `…${text.slice(-8000)}` : text
    if (state.rightPanelCollapsed) dispatch({ type: 'TOGGLE_RIGHT_PANEL' })
    agent.send(
      `Here is ${selected !== '' ? 'part of' : 'the end of'} my ${snapshot.profile?.name ?? 'terminal'} output:\n\n` +
        `\`\`\`\n${clipped || '(empty)'}\n\`\`\`\n\n` +
        'Explain what happened. If something failed, find the cause in the project and fix it.',
      { display: selected !== '' ? 'Ask about the selected terminal output' : 'Ask about the terminal output' },
    )
  }, [agent, dispatch, session, snapshot.profile?.name, state.rightPanelCollapsed])

  const paste = useCallback(async () => {
    if (session === null) return
    try {
      session.paste(await navigator.clipboard.readText())
      session.focus()
    } catch {
      setNotice('Press Ctrl+V (⌘V on a Mac) to paste.')
      window.setTimeout(() => setNotice(null), 3000)
    }
  }, [session])

  if (shells === null) return null

  if (root === null) {
    return <div className={styles.message}>Open a folder to start a terminal in it.</div>
  }

  if (!allowed && session === null) {
    return (
      <div className={styles.consent} role="alertdialog" aria-label="Allow terminals in this folder">
        <div className={styles.consentTitle}>
          Start {tab.profileId !== null && tab.profileId !== undefined ? shells.profiles.find((p) => p.id === tab.profileId)?.name ?? 'a shell' : shells.profiles[0]?.name ?? 'a shell'} in{' '}
          <strong>{basename(root) || root}</strong>?
        </div>
        <div className={styles.consentNote}>
          A terminal runs whatever you type with your permissions, like any terminal. Sketch asks once per folder.
        </div>
        <div className={styles.consentActions}>
          <button
            type="button"
            className={styles.primary}
            autoFocus
            onClick={() => {
              trustFolder(root)
              setAllowed(true)
            }}
          >
            <Play size={12} /> Always allow in this folder
          </button>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => {
              allowFolderForSession(root)
              setAllowed(true)
            }}
          >
            Allow until I restart
          </button>
        </div>
      </div>
    )
  }

  const hasSelection = session?.term.hasSelection() ?? false
  const items: ContextMenuItem[] = [
    { id: 'copy', label: 'Copy', hint: 'Ctrl+C', disabled: !hasSelection, run: () => void session?.copySelection() },
    { id: 'paste', label: 'Paste', hint: 'Ctrl+V', run: () => void paste() },
    { id: 'select-all', label: 'Select All', run: () => session?.selectAll() },
    'separator',
    {
      id: 'ask',
      label: hasSelection ? 'Ask Sketch about the selection' : 'Ask Sketch about this output',
      disabled: agent === null || agent.activeRunId !== null,
      run: askSketch,
    },
    'separator',
    { id: 'clear', label: 'Clear', run: () => session?.clear() },
    { id: 'restart', label: 'Restart shell', run: () => void session?.restart() },
  ]

  return (
    <div className={styles.shell}>
      <div
        ref={containerRef}
        className={styles.screen}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenu({ x: event.clientX, y: event.clientY })
        }}
        data-testid={`shell-${tab.id}`}
      />
      {snapshot.status === 'failed' && (
        <div className={styles.banner} role="alert">
          <AlertCircle size={12} /> {snapshot.error ?? 'The shell could not start.'}
          <button type="button" className={styles.secondary} onClick={() => void session?.restart()}>
            Try again
          </button>
        </div>
      )}
      {notice !== null && (
        <div className={styles.toast} role="status">
          {notice}
        </div>
      )}
      {menu !== null && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} label="Terminal" />}
    </div>
  )
}
