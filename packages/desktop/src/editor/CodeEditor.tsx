// The Monaco host: one editor instance, one model map, one direction of truth.
//
// This component owns no file state. It projects `AppState` onto Monaco and reports
// keystrokes back, and the projection is deliberately one-way per direction:
//
//   state → model   the "sync" effect below, calling `ModelRegistry.sync`
//   model → state   the `onUserEdit` callback handed to the registry at construction
//
// Everything else it holds is VIEW state, which is genuinely local: which line the
// caret is on, each tab's scroll position, whether Monaco finished loading. None of
// that is file content, so none of it can diverge from the file record.
//
// Validates: Requirements 15.1, 15.2, 15.3

import { useEffect, useRef, useState } from 'react'
import {
  GhostCompletionController,
  type GhostCompletionProvider,
} from './ghostCompletion'
import styles from '../components/EditorArea.module.css'
import { useAppDispatch, useAppState } from '../state/AppState'
import type {
  CodeEditor as MonacoEditorInstance,
  Disposable,
  EditorCreateOptions,
} from './monacoApi'
import { ModelRegistry } from './models'
import { loadMonaco, type LoadedMonaco } from './monacoSetup'

export interface CodeEditorProps {
  /** Injected in tests. Production uses the real, lazily loaded Monaco. */
  loader?: () => Promise<LoadedMonaco>
  /** Provider seam. No provider is required and the feature defaults off. */
  completionProvider?: GhostCompletionProvider
}

/** Passed to `editor.create`. No language service is bundled — see monacoRuntime.ts. */
const EDITOR_OPTIONS: Omit<EditorCreateOptions, 'theme'> = {
  automaticLayout: true,
  fontFamily: "'JetBrains Mono', ui-monospace, 'Cascadia Mono', monospace",
  fontSize: 12,
  lineHeight: 19,
  lineNumbers: 'on',
  minimap: { enabled: true },
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  renderWhitespace: 'selection',
  tabSize: 2,
  fixedOverflowWidgets: true,
  padding: { top: 12, bottom: 12 },
}

export function CodeEditor({ loader = loadMonaco, completionProvider }: CodeEditorProps) {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const latestState = useRef(state)
  latestState.current = state

  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<MonacoEditorInstance | null>(null)
  const registryRef = useRef<ModelRegistry | null>(null)
  const ghostController = useRef<GhostCompletionController | null>(null)
  /** Per-tab scroll and selection. View state, not file state. */
  const viewStates = useRef<Map<string, unknown>>(new Map())
  const shownPath = useRef<string | null>(null)

  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [cursor, setCursor] = useState({ lineNumber: 1, column: 1 })
  const [ghost, setGhost] = useState<string | null>(null)

  // ── Mount: load Monaco, build the model map, create the one editor ──────────
  useEffect(() => {
    let cancelled = false
    let cursorSubscription: Disposable | null = null

    ghostController.current = completionProvider
      ? new GhostCompletionController({
          provider: completionProvider,
          enabled: () => latestState.current.ghostCompletionsEnabled,
          onSuggestion: setGhost,
        })
      : null

    loader()
      .then(({ api, theme }) => {
        const container = containerRef.current
        if (cancelled || !container) return

        // The ONLY model→state path in the app. `ModelRegistry` suppresses its own
        // programmatic writes, so this fires for user input and nothing else.
        registryRef.current = new ModelRegistry(api, (path, content) => {
          dispatch({ type: 'UPDATE_FILE_CONTENT', payload: { path, content } })
          ghostController.current?.update({ path, content, cursorOffset: content.length })
        })

        const editor = api.editor.create(container, { ...EDITOR_OPTIONS, theme })
        editorRef.current = editor
        cursorSubscription = editor.onDidChangeCursorPosition(() => {
          const position = editor.getPosition()
          if (position) setCursor({ lineNumber: position.lineNumber, column: position.column })
        })
        setReady(true)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      cancelled = true
      cursorSubscription?.dispose()
      // Models first: each holds a full text buffer and its tokenization, so one
      // leaked per file opened is a real leak in a long session.
      registryRef.current?.disposeAll()
      registryRef.current = null
      editorRef.current?.dispose()
      editorRef.current = null
      shownPath.current = null
      ghostController.current?.dispose()
      ghostController.current = null
    }
  }, [completionProvider, dispatch, loader])

  // Turning the feature off cancels queued and in-flight requests immediately.
  useEffect(() => {
    if (!state.ghostCompletionsEnabled) ghostController.current?.cancel()
  }, [state.ghostCompletionsEnabled])

  // ── Which model is on screen ────────────────────────────────────────────────
  useEffect(() => {
    const editor = editorRef.current
    const registry = registryRef.current
    if (!ready || !editor || !registry) return

    const path = state.activeFile
    const entry = path ? state.files[path] : undefined

    if (!entry) {
      if (shownPath.current !== null) {
        editor.setModel(null)
        shownPath.current = null
      }
      return
    }
    if (shownPath.current === entry.path && registry.has(entry.path)) return

    if (shownPath.current !== null && editor.saveViewState) {
      viewStates.current.set(shownPath.current, editor.saveViewState())
    }
    // Existing models are returned untouched; only a first open creates one.
    editor.setModel(registry.acquire(entry.path, entry.content))
    const saved = viewStates.current.get(entry.path)
    if (saved !== undefined) editor.restoreViewState?.(saved)
    shownPath.current = entry.path

    const position = editor.getPosition()
    setCursor(
      position
        ? { lineNumber: position.lineNumber, column: position.column }
        : { lineNumber: 1, column: 1 },
    )
  }, [ready, state.activeFile, state.files])

  // ── state → model, for every open buffer ────────────────────────────────────
  // Not only the active one: an engine write to a background tab has to land in
  // that tab's model too, or switching to it would show stale text.
  useEffect(() => {
    const registry = registryRef.current
    if (!ready || !registry) return
    for (const path of state.openFiles) {
      const entry = state.files[path]
      if (entry && registry.has(path)) registry.sync(path, entry.content)
    }
  }, [ready, state.openFiles, state.files])

  // ── Closed tabs lose their models ───────────────────────────────────────────
  // Driven off the tab list rather than off the close handler, so there is one
  // place where a model can outlive its tab, and it is this one.
  useEffect(() => {
    const registry = registryRef.current
    if (!ready || !registry) return
    for (const removed of registry.pruneTo(state.openFiles)) {
      viewStates.current.delete(removed)
    }
  }, [ready, state.openFiles])

  if (loadError !== null) {
    return (
      <div className={styles.editorFailure} role="alert">
        <strong>The code editor failed to load.</strong>
        <span>{loadError}</span>
      </div>
    )
  }

  return (
    <div className={styles.editorBody}>
      <div className={styles.monacoHost} ref={containerRef} data-testid="monaco-host" />
      {ghost !== null && state.ghostCompletionsEnabled && (
        <div className={styles.ghostCompletion} aria-label="Ghost completion">
          {ghost}
        </div>
      )}
      <div className={styles.statusBar} aria-label="cursor position">
        Ln {cursor.lineNumber}, Col {cursor.column}
      </div>
    </div>
  )
}

export default CodeEditor
