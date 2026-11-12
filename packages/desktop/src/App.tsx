import { useEffect, useRef } from 'react'
import { AppLayout } from './components/AppLayout'
import { ConfirmProvider, useConfirm } from './components/ConfirmDialog'
import { AppStateProvider, DEFAULT_EDITOR_SETTINGS, useAppDispatch, useAppState, type AppState } from './state/AppState'
import { SketchClientProvider, useOptionalSketchClient } from './lib/ClientProvider'
import { GitProvider } from './git/GitProvider'
import { AgentSessionProvider } from './lib/AgentSession'
import { TerminalRunnerProvider } from './terminal/TerminalRunner'
import { ShellTerminalsProvider } from './terminal/ShellSessions'
import { useProviderConfig } from './settings/useProviderConfig'
import { useFileActions } from './editor/useFileActions'
import { ProjectWatcher } from './editor/projectWatcher'
import { basename } from './editor/paths'
import { applyWindowTitle, installDesktopGuards, isDesktopShell, windowTitle } from './lib/desktopGuards'
import { askToClose, takeCloseConfirmed } from './lib/windowClose'
import { ColorThemeController } from './styles/colorTheme'

const ONBOARDED_KEY = 'sketch.onboarded.v1'

/**
 * What only the desktop window needs: the web view's browser behaviour switched off
 * (reload, find bar, print, back, its own right-click menu, a dropped file opening in
 * place of the app), F5 meaning Run, and a real window title for the taskbar and
 * Alt+Tab: `● App.tsx — my-project — Sketch`.
 */
export function DesktopShell() {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const confirm = useConfirm()
  const fileActions = useFileActions()
  // The close handler is registered once and reads the window as it is when asked.
  const latest = useRef({ state, confirm, fileActions })
  latest.current = { state, confirm, fileActions }

  useEffect(() => {
    if (!isDesktopShell()) return
    return installDesktopGuards(window, {
      dev: import.meta.env.DEV,
      onRun: () => {
        dispatch({ type: 'SET_MODE', payload: 'ide' })
        dispatch({ type: 'SET_ACTIVE_PANEL', payload: 'run' })
      },
    })
  }, [dispatch])

  // Alt+F4, the taskbar's Close, the Dock's Quit: the same question as the title bar's ✕.
  useEffect(() => {
    if (!isDesktopShell()) return
    let disposed = false
    let unlisten: (() => void) | null = null
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().onCloseRequested(async (event) => {
          if (takeCloseConfirmed()) return
          const { state: s, confirm: ask, fileActions: actions } = latest.current
          const dirty = s.openFiles.filter((p) => s.files[p]?.isDirty).map((p) => s.files[p]!.name)
          if (!(await askToClose(dirty, ask, () => actions.saveAll()))) event.preventDefault()
        }),
      )
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch(() => {
        // No close hook: the window closes as the operating system says, as before.
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  const active = state.activeFile !== null ? state.files[state.activeFile] : undefined
  const title = windowTitle({
    file: state.mode === 'ide' && active !== undefined ? active.name : null,
    dirty: active?.isDirty === true,
    folder: state.projectRoot !== null ? basename(state.projectRoot) : null,
  })
  useEffect(() => {
    void applyWindowTitle(title)
  }, [title])
  return null
}

/**
 * First run: once the engine has answered with an EMPTY provider list, open the
 * "Connect a model" wizard — once. Dismissing it is respected on every later start;
 * the composer still shows a Connect button for as long as nothing is configured.
 */
function FirstRun() {
  const state = useAppState()
  const dispatch = useAppDispatch()
  // Loads providers.json at startup, so the first-run check has an answer.
  useProviderConfig()

  useEffect(() => {
    if (state.providerSettingsPath === null || state.providers.length > 0) return
    let seen = false
    try {
      seen = window.localStorage.getItem(ONBOARDED_KEY) === '1'
      window.localStorage.setItem(ONBOARDED_KEY, '1')
    } catch {
      // No storage: offer it this session and every session.
    }
    if (!seen) dispatch({ type: 'OPEN_CONNECT' })
  }, [dispatch, state.providerSettingsPath, state.providers.length])

  return null
}

/** Window-wide shortcuts that are not tied to one panel. */
export function Shortcuts() {
  const dispatch = useAppDispatch()
  const state = useAppState()
  const latest = useRef(state)
  latest.current = state
  const fileActions = useFileActions()
  const fileActionsRef = useRef(fileActions)
  fileActionsRef.current = fileActions
  const client = useOptionalSketchClient()
  const clientRef = useRef(client)
  clientRef.current = client
  useEffect(() => {
    const showPanel = (panel: NonNullable<AppState['ideActivePanel']>) => {
      dispatch({ type: 'SET_MODE', payload: 'ide' })
      dispatch({ type: 'SET_ACTIVE_PANEL', payload: panel })
    }
    // Capture phase: Monaco handles keys it knows and stops them, and these must work
    // with the caret in the editor exactly as they do anywhere else.
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey
      // Alt+Z: word wrap, the one common editor toggle without Ctrl.
      if (!mod && event.altKey && !event.shiftKey && event.code === 'KeyZ' && latest.current.mode === 'ide') {
        event.preventDefault()
        event.stopPropagation()
        dispatch({ type: 'SET_EDITOR_SETTINGS', payload: { wordWrap: !latest.current.editorSettings.wordWrap } })
        return
      }
      // Shift+Alt+R: reveal the active file in File Explorer / Finder, as in VS Code.
      if (!mod && event.altKey && event.shiftKey && event.code === 'KeyR') {
        const s = latest.current
        const reveal = clientRef.current?.osReveal
        if (s.projectRoot === null || reveal === undefined) return
        event.preventDefault()
        event.stopPropagation()
        void reveal.call(clientRef.current, { root: s.projectRoot, path: s.activeFile ?? s.projectRoot }).catch((err: unknown) => {
          dispatch({ type: 'SET_EDITOR_NOTICE', payload: { level: 'error', message: err instanceof Error ? err.message : String(err) } })
        })
        return
      }
      if (!mod) return
      const s = latest.current
      const key = event.key.toLowerCase()
      const take = () => {
        event.preventDefault()
        event.stopPropagation()
      }
      if (key === ',') {
        take()
        dispatch({ type: 'OPEN_SETTINGS' })
      } else if (key === 'l' && event.shiftKey && !event.altKey) {
        take()
        dispatch({ type: 'TOGGLE_FOCUS_MODE' })
      } else if (key === 'l' && !event.altKey) {
        // Monaco owns Ctrl+L for sending the selected code to Sketch. Outside the
        // editor the same chord brings the composer into view and focuses it.
        if (s.mode === 'ide' && event.target instanceof Element && event.target.closest('.monaco-editor, .xterm, [data-terminal-input]')) return
        take()
        dispatch({ type: 'FOCUS_COMPOSER' })
      } else if (key === 'k' && s.mode === 'agent' && !event.shiftKey && !event.altKey) {
        take()
        dispatch({ type: 'OPEN_PALETTE', payload: 'commands' })
      } else if (key === 'o' && !event.shiftKey && !event.altKey) {
        // Open Folder, as in every editor. Unclaimed, the web view would show its own
        // file picker and navigate the whole window to the chosen file.
        take()
        void fileActionsRef.current.openFolder()
      } else if (key === 'p' && event.shiftKey) {
        take()
        dispatch({ type: 'OPEN_PALETTE', payload: 'commands' })
      } else if (key === 'p' && !event.altKey) {
        take()
        dispatch({ type: 'OPEN_PALETTE', payload: 'files' })
      } else if (event.code === 'Backquote') {
        take()
        if (event.shiftKey) {
          dispatch({ type: 'SET_MODE', payload: 'ide' })
          dispatch({ type: 'TERMINAL_NEW' })
        } else if (s.bottomPanelOpen && s.bottomPanelTab === 'terminal') {
          dispatch({ type: 'TOGGLE_BOTTOM_PANEL' })
        } else {
          dispatch({ type: 'SET_MODE', payload: 'ide' })
          dispatch({ type: 'SHOW_BOTTOM_PANEL', payload: 'terminal' })
          requestAnimationFrame(() => window.dispatchEvent(new Event('sketch:focus-terminal')))
        }
      } else if (key === 'j' && !event.shiftKey) {
        take()
        dispatch({ type: 'TOGGLE_BOTTOM_PANEL' })
      } else if (key === 'b' && !event.shiftKey && !event.altKey) {
        take()
        dispatch({ type: s.mode === 'ide' ? 'TOGGLE_IDE_SIDE_PANEL' : 'TOGGLE_SIDEBAR' })
      } else if (event.shiftKey && key === 'e') {
        take()
        showPanel('explorer')
      } else if (event.shiftKey && key === 'f') {
        take()
        showPanel('search')
        requestAnimationFrame(() => window.dispatchEvent(new Event('sketch:focus-search')))
      } else if (event.shiftKey && key === 'h') {
        take()
        showPanel('search')
        requestAnimationFrame(() => window.dispatchEvent(new Event('sketch:focus-replace')))
      } else if (event.shiftKey && key === 'g') {
        take()
        showPanel('git')
      } else if (event.shiftKey && key === 'm') {
        take()
        dispatch({ type: 'SET_MODE', payload: 'ide' })
        dispatch({ type: 'SHOW_BOTTOM_PANEL', payload: 'problems' })
      } else if (key === 'n' && !event.shiftKey && !event.altKey && s.projectRoot !== null && s.mode === 'ide') {
        take()
        showPanel('explorer')
        requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('sketch:explorer-new', { detail: { kind: 'file' } })))
      } else if ((key === '=' || key === '+') && s.mode === 'ide') {
        take()
        dispatch({ type: 'SET_EDITOR_SETTINGS', payload: { fontSize: s.editorSettings.fontSize + 1 } })
      } else if (key === '-' && s.mode === 'ide') {
        take()
        dispatch({ type: 'SET_EDITOR_SETTINGS', payload: { fontSize: s.editorSettings.fontSize - 1 } })
      } else if (key === '0' && s.mode === 'ide') {
        take()
        dispatch({ type: 'SET_EDITOR_SETTINGS', payload: { fontSize: DEFAULT_EDITOR_SETTINGS.fontSize } })
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [dispatch])
  return null
}

export function App() {
  return (
    // The client seam wraps the app: one client, one event subscription, chosen by
    // the factory. Nothing below this point knows which transport is live.
    <SketchClientProvider>
      {/* `persist`: conversations, opened folders and agent preferences survive a
          restart, in this window's local storage and nowhere else. */}
      <AppStateProvider persist>
        {/* One git owner for the window: the Source Control panel lists the changes
            and the status bar names the branch, both from the same status. Inside
            AppStateProvider because it needs the open project root, and inside the
            client provider because it reaches git through the engine seam. */}
        <GitProvider>
          {/* One agent session for both surfaces: a run started in Cowork can be
              watched, answered and stopped from the Code sidebar, and vice versa. */}
          <AgentSessionProvider>
            {/* Terminal commands run in the engine and are polled here, above the
                panel, so a dev server keeps streaming while the panel is closed. */}
            <TerminalRunnerProvider>
              {/* Real shells (desktop app): sessions live here, not in the panel, so a
                  shell keeps running and keeps its scrollback while the panel is shut. */}
              <ShellTerminalsProvider>
              {/* "Save changes?", "Move to Trash?": one modal question at a time. */}
              <ConfirmProvider>
                <FirstRun />
                <ColorThemeController />
                <Shortcuts />
                <DesktopShell />
                {/* Real-time disk changes for the open folder, whoever made them. */}
                <ProjectWatcher />
                <AppLayout />
              </ConfirmProvider>
              </ShellTerminalsProvider>
            </TerminalRunnerProvider>
          </AgentSessionProvider>
        </GitProvider>
      </AppStateProvider>
    </SketchClientProvider>
  )
}
