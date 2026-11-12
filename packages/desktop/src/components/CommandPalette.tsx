// Quick Open (Ctrl+P) and the Command Palette (Ctrl+Shift+P) — the two keyboard
// entry points every editor user reaches for first.
//
// One overlay, two modes, the VS Code convention: in Quick Open, typing `>` switches to
// commands; in the palette, deleting the `>` switches back to files. Files come from the
// engine's walker (`.gitignore` applied); commands are this app's real actions, each of
// which dispatches the same action its button does — the palette adds no behaviour of
// its own.

import { useEffect, useMemo, useRef, useState } from 'react'

import { useAppDispatch, useAppState, type AppState } from '../state/AppState'
import { useOptionalAgentSession } from '../lib/AgentSession'
import { useOptionalSketchClient } from '../lib/ClientProvider'
import { useFileActions } from '../editor/useFileActions'
import { runEditorAction } from '../editor/editorBridge'
import { diffKindFor, requestDiff } from '../editor/DiffView'
import { useOptionalGit } from '../git/GitProvider'
import { currentScheme } from '../styles/colorTheme'
import { relativeToRoot, toAbsolutePath } from '../editor/paths'
import { fuzzyFilter } from '../lib/fuzzy'
import { isComposing } from '../lib/keys'
import { useProjectFiles } from '../lib/useProjectIndex'
import { FileCode, Search } from './Icons'
import styles from './CommandPalette.module.css'

interface PaletteAction {
  id: string
  label: string
  detail?: string
  keys?: string
  run(): void
}

type Panel = Exclude<AppState['ideActivePanel'], null>

export function CommandPalette() {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const session = useOptionalAgentSession()
  const fileActions = useFileActions()
  const client = useOptionalSketchClient()
  const git = useOptionalGit()
  const open = state.paletteOpen
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const { files, loading, truncated } = useProjectFiles(open !== null)

  // `>` in the box means commands, whichever shortcut opened it (Ctrl+Shift+P starts
  // with one), and deleting it goes back to files — the VS Code convention.
  const commandMode = query.startsWith('>')
  const text = commandMode ? query.replace(/^>\s*/, '') : query

  useEffect(() => {
    if (open === null) return
    setQuery(open === 'commands' ? '>' : '')
    setSelected(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  const close = () => dispatch({ type: 'CLOSE_PALETTE' })

  const actions = useMemo<PaletteAction[]>(() => {
    const showPanel = (panel: Panel) => () => {
      dispatch({ type: 'SET_MODE', payload: 'ide' })
      dispatch({ type: 'SET_ACTIVE_PANEL', payload: panel })
    }
    const ask = (prompt: string, display: string, mode?: 'ask') => () => session?.send(prompt, { display, ...(mode ? { mode } : {}) })
    const notifyError = (err: unknown) =>
      dispatch({ type: 'SET_EDITOR_NOTICE', payload: { level: 'error', message: err instanceof Error ? err.message : String(err) } })
    const activeRel = state.activeFile && state.projectRoot ? relativeToRoot(state.projectRoot, state.activeFile) : null
    const list: PaletteAction[] = [
      { id: 'appearance.open', label: 'Preferences: Appearance & Customization', detail: 'Colors, typography, density and panel placement', run: () => dispatch({ type: 'OPEN_SETTINGS', payload: 'appearance' }) },
      { id: 'view.focus', label: state.focusMode ? 'View: Exit Focus Mode' : 'View: Enter Focus Mode', keys: 'Ctrl+Shift+L', run: () => dispatch({ type: 'TOGGLE_FOCUS_MODE' }) },
      { id: 'chat.focus', label: 'Chat: Focus Agent', keys: 'Ctrl+L', run: () => dispatch({ type: 'FOCUS_COMPOSER' }) },
      { id: 'workflows.open', label: 'Cowork: Workflow Library', detail: 'Use a starter or create your own reusable workflow', run: () => { dispatch({ type: 'SET_MODE', payload: 'agent' }); dispatch({ type: 'SET_AGENT_VIEW', payload: 'workflows' }) } },
      { id: 'layout.build', label: 'Layout: Build', run: () => dispatch({ type: 'APPLY_LAYOUT_PRESET', payload: 'balanced' }) },
      { id: 'layout.review', label: 'Layout: Review Changes', run: () => dispatch({ type: 'APPLY_LAYOUT_PRESET', payload: 'review' }) },
      { id: 'layout.write', label: 'Layout: Write', run: () => dispatch({ type: 'APPLY_LAYOUT_PRESET', payload: 'write' }) },
      { id: 'layout.sidebar', label: 'Layout: Move Sidebar ' + (state.appearance.sidebarPosition === 'left' ? 'Right' : 'Left'), run: () => dispatch({ type: 'SET_APPEARANCE', payload: { sidebarPosition: state.appearance.sidebarPosition === 'left' ? 'right' : 'left' } }) },
      { id: 'layout.agent', label: 'Layout: Move Agent Panel ' + (state.appearance.agentPosition === 'left' ? 'Right' : 'Left'), run: () => dispatch({ type: 'SET_APPEARANCE', payload: { agentPosition: state.appearance.agentPosition === 'left' ? 'right' : 'left' } }) },
      { id: 'chat.new', label: 'Chat: New Conversation', run: () => dispatch({ type: 'NEW_CONVERSATION' }) },
      { id: 'mode.ask', label: 'Agent Mode: Ask (read-only)', detail: 'Answers and explains; never changes files', run: () => dispatch({ type: 'SET_AGENT_PREFS', payload: { mode: 'ask' } }) },
      { id: 'mode.agent', label: 'Agent Mode: Agent', detail: 'Edits with undo; asks before running commands', run: () => dispatch({ type: 'SET_AGENT_PREFS', payload: { mode: 'agent' } }) },
      { id: 'mode.auto', label: 'Agent Mode: Auto', detail: 'Works to completion without asking', run: () => dispatch({ type: 'SET_AGENT_PREFS', payload: { mode: 'auto' } }) },
      {
        id: 'autocomplete.toggle',
        label: `Autocomplete: Turn ${state.ghostCompletionsEnabled ? 'Off' : 'On'}`,
        detail: 'AI code suggestions as you type (Tab to accept)',
        run: () => dispatch({ type: 'SET_GHOST_COMPLETIONS', payload: !state.ghostCompletionsEnabled }),
      },
      { id: 'file.goto', label: 'Go to File…', keys: 'Ctrl+P', run: () => dispatch({ type: 'OPEN_PALETTE', payload: 'files' }) },
      { id: 'folder.open', label: 'File: Open Folder…', keys: 'Ctrl+O', run: () => void fileActions.openFolder() },
      {
        id: 'repo.clone',
        label: 'Git: Clone Repository…',
        run: () => {
          dispatch({ type: 'SET_MODE', payload: 'ide' })
          window.dispatchEvent(new Event('sketch:clone'))
        },
      },
      { id: 'view.code', label: 'View: Switch to Code', run: () => dispatch({ type: 'SET_MODE', payload: 'ide' }) },
      { id: 'view.cowork', label: 'View: Switch to Cowork', run: () => dispatch({ type: 'SET_MODE', payload: 'agent' }) },
      { id: 'view.chat', label: 'View: Toggle Chat Panel', run: () => dispatch({ type: 'TOGGLE_RIGHT_PANEL' }) },
      { id: 'view.terminal', label: 'View: Toggle Terminal', keys: 'Ctrl+`', run: () => { dispatch({ type: 'SET_MODE', payload: 'ide' }); dispatch({ type: 'SHOW_BOTTOM_PANEL', payload: 'terminal' }) } },
      { id: 'view.problems', label: 'View: Problems', keys: 'Ctrl+Shift+M', run: () => { dispatch({ type: 'SET_MODE', payload: 'ide' }); dispatch({ type: 'SHOW_BOTTOM_PANEL', payload: 'problems' }) } },
      { id: 'view.panel', label: 'View: Toggle Bottom Panel', keys: 'Ctrl+J', run: () => dispatch({ type: 'TOGGLE_BOTTOM_PANEL' }) },
      { id: 'view.sidebar', label: 'View: Toggle Side Bar', keys: 'Ctrl+B', run: () => dispatch({ type: state.mode === 'ide' ? 'TOGGLE_IDE_SIDE_PANEL' : 'TOGGLE_SIDEBAR' }) },
      { id: 'view.wrap', label: `View: Turn Word Wrap ${state.editorSettings.wordWrap ? 'Off' : 'On'}`, keys: 'Alt+Z', run: () => dispatch({ type: 'SET_EDITOR_SETTINGS', payload: { wordWrap: !state.editorSettings.wordWrap } }) },
      { id: 'view.minimap', label: `View: Turn Minimap ${state.editorSettings.minimap ? 'Off' : 'On'}`, run: () => dispatch({ type: 'SET_EDITOR_SETTINGS', payload: { minimap: !state.editorSettings.minimap } }) },
      { id: 'view.zoomin', label: 'View: Editor Zoom In', keys: 'Ctrl+=', run: () => dispatch({ type: 'SET_EDITOR_SETTINGS', payload: { fontSize: state.editorSettings.fontSize + 1 } }) },
      { id: 'view.zoomout', label: 'View: Editor Zoom Out', keys: 'Ctrl+-', run: () => dispatch({ type: 'SET_EDITOR_SETTINGS', payload: { fontSize: state.editorSettings.fontSize - 1 } }) },
      { id: 'terminal.new', label: 'Terminal: New Terminal', keys: 'Ctrl+Shift+`', run: () => { dispatch({ type: 'SET_MODE', payload: 'ide' }); dispatch({ type: 'TERMINAL_NEW' }) } },
      { id: 'run.scripts', label: 'Run: Run a Project Script…', run: showPanel('run') },
      { id: 'file.autosave', label: `File: Turn Auto Save ${state.editorSettings.autoSave === 'off' ? 'On' : 'Off'}`, run: () => dispatch({ type: 'SET_EDITOR_SETTINGS', payload: { autoSave: state.editorSettings.autoSave === 'off' ? 'afterDelay' : 'off' } }) },
      { id: 'settings.editor', label: 'Preferences: Editor Settings', run: () => dispatch({ type: 'OPEN_SETTINGS', payload: 'editor' }) },
      {
        id: 'theme.toggle',
        label: `Preferences: Switch to ${currentScheme() === 'light' ? 'Dark' : 'Light'} Theme`,
        detail: 'The whole window, the editor and the terminal',
        run: () => dispatch({ type: 'SET_EDITOR_SETTINGS', payload: { colorTheme: currentScheme() === 'light' ? 'dark' : 'light' } }),
      },
      {
        id: 'theme.system',
        label: 'Preferences: Color Theme: Match System',
        detail: "Follow the operating system's light or dark mode",
        run: () => dispatch({ type: 'SET_EDITOR_SETTINGS', payload: { colorTheme: 'system' } }),
      },
      { id: 'help.keys', label: 'Help: Keyboard Shortcuts', run: () => dispatch({ type: 'OPEN_SETTINGS', payload: 'shortcuts' }) },
      { id: 'panel.explorer', label: 'View: Explorer', run: showPanel('explorer') },
      { id: 'panel.search', label: 'View: Search in Files', run: showPanel('search') },
      { id: 'panel.git', label: 'View: Source Control', run: showPanel('git') },
      { id: 'panel.review', label: 'View: Review Proposed Changes', run: showPanel('review') },
      { id: 'panel.skills', label: 'View: Skills', run: showPanel('skills') },
      { id: 'panel.tests', label: 'View: Test Results', run: showPanel('tests') },
      { id: 'panel.memory', label: 'View: Project Memory', run: showPanel('memory') },
      { id: 'panel.architecture', label: 'View: Live Architecture', run: showPanel('architecture') },
      { id: 'panel.cost', label: 'View: Cost', run: showPanel('cost') },
      { id: 'panel.mcp', label: 'View: MCP Tools', run: showPanel('mcp') },
      { id: 'model.connect', label: 'Models: Connect a Model…', detail: 'Free options available', run: () => dispatch({ type: 'OPEN_CONNECT' }) },
      { id: 'model.pick', label: 'Models: Choose Model', run: () => dispatch({ type: 'OPEN_SETTINGS', payload: 'models' }) },
      { id: 'settings.open', label: 'Preferences: Open Settings', keys: 'Ctrl+,', run: () => dispatch({ type: 'OPEN_SETTINGS' }) },
      { id: 'agent.init', label: 'Sketch: Write AGENTS.md for This Project (/init)', run: ask('Create or update AGENTS.md at the project root so an AI coding agent can work here well. Read the project first; cover what it is, structure and entry points, exact install/build/run/test commands, and conventions. Only facts you verified.', '/init') },
      { id: 'agent.explain', label: 'Sketch: Explain This Project', run: ask('Explain how this project is structured: its purpose, main folders and entry points, how the pieces connect, and how to run it. Read the code first and cite file paths.', 'Explain this project', 'ask') },
      { id: 'agent.review', label: 'Sketch: Review My Uncommitted Changes', run: ask('Review the current uncommitted changes (use git-status and git-diff). Point out bugs, risks and missing tests, most important first. Do not edit files.', '/review', 'ask') },
    ]
    if (state.projectRoot !== null) {
      const newEntry = (kind: 'file' | 'folder') => () => {
        dispatch({ type: 'SET_MODE', payload: 'ide' })
        dispatch({ type: 'SET_ACTIVE_PANEL', payload: 'explorer' })
        requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('sketch:explorer-new', { detail: { kind } })))
      }
      list.push(
        { id: 'file.new', label: 'File: New File…', keys: 'Ctrl+N', run: newEntry('file') },
        { id: 'file.newfolder', label: 'File: New Folder…', run: newEntry('folder') },
      )
      const root = state.projectRoot
      if (client?.osOpenTerminal !== undefined) {
        list.push({
          id: 'terminal.external',
          label: 'Terminal: Open External Terminal',
          detail: 'Your system terminal app, in this folder',
          run: () => void client.osOpenTerminal!({ root }).catch(notifyError),
        })
      }
      if (client?.osReveal !== undefined) {
        const active = state.activeFile
        list.push({
          id: 'file.reveal',
          label: active !== null ? 'File: Reveal Active File in the System File Manager' : 'File: Reveal Project Folder in the System File Manager',
          keys: 'Shift+Alt+R',
          run: () => void client.osReveal!({ root, path: active ?? root }).catch(notifyError),
        })
      }
    }
    if (state.openFiles.length > 0) {
      list.push(
        { id: 'file.saveall', label: 'File: Save All', keys: 'Ctrl+Alt+S', run: () => void fileActions.saveAll() },
        { id: 'file.closeall', label: 'File: Close All Editors', run: () => void fileActions.closeMany(state.openFiles) },
      )
    }
    if (activeRel !== null) {
      const editor = (id: string) => () => {
        // The palette closes first; the editor takes the focus back for the action. A
        // command that finds no editor says so, as the title bar's menus do.
        requestAnimationFrame(() => {
          if (!runEditorAction(id)) {
            dispatch({ type: 'SET_EDITOR_NOTICE', payload: { level: 'info', message: 'That command works in the code editor, which is not ready yet. Try again in a moment.' } })
          }
        })
      }
      list.push(
        { id: 'file.save', label: 'File: Save', keys: 'Ctrl+S', run: () => void fileActions.save(state.activeFile!) },
        { id: 'file.close', label: 'File: Close Editor', keys: 'Ctrl+W', run: () => void fileActions.closePath(state.activeFile!) },
        { id: 'editor.format', label: 'Format Document', keys: 'Shift+Alt+F', run: editor('editor.action.formatDocument') },
        { id: 'editor.gotoline', label: 'Go to Line…', keys: 'Ctrl+G', run: editor('editor.action.gotoLine') },
        { id: 'editor.symbol', label: 'Go to Symbol in File…', keys: 'Ctrl+Shift+O', run: editor('editor.action.quickOutline') },
        { id: 'editor.find', label: 'Find in File', keys: 'Ctrl+F', run: editor('actions.find') },
        { id: 'editor.replace', label: 'Replace in File', keys: 'Ctrl+H', run: editor('editor.action.startFindReplaceAction') },
        { id: 'editor.comment', label: 'Toggle Line Comment', keys: 'Ctrl+/', run: editor('editor.action.commentLine') },
        { id: 'editor.inlineEdit', label: 'Sketch: Edit Selection with AI…', detail: 'Describe a change, see the diff, accept or reject it', keys: 'Ctrl+K', run: editor('sketch.inlineEdit') },
        { id: 'git.nextChange', label: 'Git: Go to Next Change', keys: 'Alt+F5', run: editor('sketch.git.nextChange') },
        { id: 'git.previousChange', label: 'Git: Go to Previous Change', keys: 'Shift+Alt+F5', run: editor('sketch.git.previousChange') },
        { id: 'git.revertChange', label: 'Git: Revert the Change at the Cursor', detail: 'Put back the lines as they were in the last commit', run: editor('sketch.git.revertChange') },
        { id: 'editor.reveal', label: 'File: Reveal Active File in Explorer', run: () => { dispatch({ type: 'SET_ACTIVE_PANEL', payload: 'explorer' }); window.dispatchEvent(new CustomEvent('sketch:reveal-in-explorer', { detail: { path: state.activeFile } })) } },
        { id: 'agent.fixfile', label: `Sketch: Find and Fix Bugs in ${activeRel}`, run: ask(`Find the most likely bugs in \`${activeRel}\` and fix them. Explain each root cause, make the smallest correct change, then run the project's checks.`, `Fix bugs in ${activeRel}`) },
        { id: 'agent.testfile', label: `Sketch: Write Tests for ${activeRel}`, run: ask(`Write unit tests for \`${activeRel}\` using the project's existing framework and style. Run them and make them pass.`, `Write tests for ${activeRel}`) },
      )
      const diffKind = diffKindFor(git?.status ?? null, git?.root ?? state.projectRoot, state.activeFile!)
      if (diffKind !== null && diffKind !== 'deleted') {
        const path = state.activeFile!
        list.push({
          id: 'git.openChanges',
          label: 'Git: Open Changes (Side by Side)',
          detail: diffKind === 'staged' ? 'The staged version next to the last commit' : 'Your edits next to the last staged or committed version',
          run: () => requestDiff({ path, kind: diffKind }),
        })
      }
    }
    if (session?.activeRunId) list.unshift({ id: 'agent.stop', label: 'Sketch: Stop the Running Agent', run: () => session.stop() })
    return list
  }, [client, dispatch, fileActions, git?.root, git?.status, session, state.activeFile, state.editorSettings, state.ghostCompletionsEnabled, state.mode, state.openFiles, state.projectRoot])

  const commandItems = useMemo(() => fuzzyFilter(actions, text, (a) => a.label, 40), [actions, text])
  const fileItems = useMemo(() => (commandMode ? [] : fuzzyFilter(files, text, (f) => f, 40)), [commandMode, files, text])
  const count = commandMode ? commandItems.length : fileItems.length

  useEffect(() => setSelected(0), [commandMode, text])

  if (open === null) return null

  const choose = (index: number) => {
    if (commandMode) {
      const action = commandItems[index]
      if (action === undefined) return
      close()
      action.run()
      return
    }
    const rel = fileItems[index]
    if (rel === undefined || state.projectRoot === null) return
    close()
    dispatch({ type: 'SET_MODE', payload: 'ide' })
    void fileActions.openPath(toAbsolutePath(state.projectRoot, rel))
  }

  return (
    <div className={styles.backdrop} onMouseDown={close} role="presentation">
      <div
        className={styles.palette}
        role="dialog"
        aria-label={commandMode ? 'Command palette' : 'Go to file'}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={styles.inputRow}>
          <Search size={14} />
          <input
            ref={inputRef}
            className={styles.input}
            value={query}
            placeholder={commandMode ? 'Type a command…' : state.projectRoot ? 'Search files by name (type > for commands)' : 'Open a folder to search its files (type > for commands)'}
            aria-label={commandMode ? 'Command' : 'File name'}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                close()
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                if (count > 0) setSelected((current) => (current + 1) % count)
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                if (count > 0) setSelected((current) => (current - 1 + count) % count)
              } else if (e.key === 'Enter') {
                if (isComposing(e)) return
                e.preventDefault()
                choose(selected)
              }
            }}
          />
        </div>
        <div className={styles.list} role="listbox">
          {commandMode
            ? commandItems.map((action, index) => (
                <button
                  key={action.id}
                  type="button"
                  role="option"
                  aria-selected={index === selected}
                  className={`${styles.item} ${index === selected ? styles.active : ''}`}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => choose(index)}
                >
                  <span className={styles.label}>{action.label}</span>
                  {action.detail !== undefined && <span className={styles.detail}>{action.detail}</span>}
                  {action.keys !== undefined && <kbd className={styles.keys}>{action.keys}</kbd>}
                </button>
              ))
            : fileItems.map((rel, index) => {
                const slash = rel.lastIndexOf('/')
                return (
                  <button
                    key={rel}
                    type="button"
                    role="option"
                    aria-selected={index === selected}
                    className={`${styles.item} ${index === selected ? styles.active : ''}`}
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => choose(index)}
                  >
                    <FileCode size={13} />
                    <span className={styles.label}>{rel.slice(slash + 1)}</span>
                    <span className={styles.detail}>{slash > 0 ? rel.slice(0, slash) : ''}</span>
                  </button>
                )
              })}
          {count === 0 && (
            <div className={styles.empty}>
              {commandMode
                ? 'No command matches.'
                : state.projectRoot === null
                  ? 'No folder is open.'
                  : loading
                    ? 'Listing the project…'
                    : 'No file matches.'}
            </div>
          )}
          {!commandMode && truncated && <div className={styles.empty}>Large project: only the first files were listed.</div>}
        </div>
      </div>
    </div>
  )
}
