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

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  GhostCompletionController,
  type GhostCompletionProvider,
} from './ghostCompletion'
import styles from '../components/EditorArea.module.css'
import { canonicalPath } from './paths'
import { registerEditorBridge } from './editorBridge'
import { useAppDispatch, useAppState, type Diagnostic, type EditorSettings } from '../state/AppState'
import type {
  CodeEditor as MonacoEditorInstance,
  DecorationsCollection,
  Disposable,
  EditorCreateOptions,
  EditorDecoration,
  EditorMarker,
  EditorRuntimeOptions,
  MonacoApi,
  SelectionRange,
} from './monacoApi'
import { ModelRegistry } from './models'
import { loadMonaco, type LoadedMonaco } from './monacoSetup'
import { InlineEditWidget, type InlineEditSession } from './InlineEditWidget'
import type { InlineEditRunner } from './inlineCompletion'
import {
  INLINE_EDIT_EVENT,
  eolOf,
  isEmptyRange,
  lineCount,
  lineRange,
  lineTable,
  maxColumn,
  revertEdit,
  sliceAround,
  wholeLines,
  withEol,
  type InlineEditRequestDetail,
} from './inlineEditing'
import { changeAt, changeLine, lineChanges, type LineChange } from './lineDiff'
import { useHeadBaseline } from './changeMarkers'

/** Something the user asked the agent to do with the code in front of them. */
export interface EditorAgentRequest {
  kind: 'ask' | 'explain' | 'fix' | 'tests' | 'edit'
  /** Canonical absolute path of the file. */
  path: string
  /** 1-based inclusive line span of the selection, or null for the whole file. */
  lines: { start: number; end: number } | null
  /** The selected text (empty when nothing is selected). */
  code: string
  /** What the user already said should change (inline edit handed to the chat). */
  instruction?: string
}

export interface CodeEditorProps {
  /** Injected in tests. Production uses the real, lazily loaded Monaco. */
  loader?: () => Promise<LoadedMonaco>
  /** Provider seam. No provider is required and the feature defaults off. */
  completionProvider?: GhostCompletionProvider
  /** Context-menu actions (Explain, Fix, Tests, Edit…) hand their request here. */
  onAgentAction?: (request: EditorAgentRequest) => void
  /** The text area lost focus (for "save on focus change"). */
  onBlurText?: () => void
  /** Inline edit (Ctrl+K). Without it, Ctrl+K hands the selection to the chat. */
  inlineEdit?: InlineEditRunner
}

/** An open inline edit: the widget's session plus where, exactly, it applies. */
interface InlineState extends InlineEditSession {
  key: number
  range: SelectionRange
  /** Write the code on a new line below `range` instead of replacing it. */
  insertBelow: boolean
  /** The buffer before `range` when the edit opened, to prove nothing moved. */
  anchor: string
  before: string
  after: string
  language: string
}

/** Colours for the overview ruler (the scrollbar's map) marks. */
const CHANGE_RULER: Record<LineChange['kind'], string> = {
  added: 'rgba(34, 197, 94, 0.6)',
  modified: 'rgba(59, 130, 246, 0.6)',
  deleted: 'rgba(239, 68, 68, 0.6)',
}

/** The change markers as Monaco decorations. */
export function changeDecorations(changes: readonly LineChange[]): EditorDecoration[] {
  return changes.map((change) => {
    const line = change.kind === 'deleted' ? Math.max(1, change.after) : change.start
    const end = change.kind === 'deleted' ? line : change.end
    const className =
      change.kind === 'deleted'
        ? change.after === 0
          ? 'sketch-change-deleted-top'
          : 'sketch-change-deleted'
        : `sketch-change-${change.kind}`
    return {
      range: { startLineNumber: line, startColumn: 1, endLineNumber: end, endColumn: 1 },
      options: {
        isWholeLine: true,
        linesDecorationsClassName: className,
        overviewRuler: { color: CHANGE_RULER[change.kind], position: 1 },
      },
    }
  })
}

/** How long typing must pause before the change markers are recomputed. */
const CHANGE_MARKER_DELAY_MS = 250

/** Passed to `editor.create`. Settings-driven options are layered on by `optionsFor`. */
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
  inlineSuggest: { enabled: true },
  cursorSmoothCaretAnimation: 'on',
}

/** The user's editor settings as Monaco options. Line height follows the font size. */
export function optionsFor(settings: EditorSettings): EditorRuntimeOptions {
  return {
    fontSize: settings.fontSize,
    lineHeight: Math.round(settings.fontSize * 1.55),
    tabSize: settings.tabSize,
    insertSpaces: settings.insertSpaces,
    wordWrap: settings.wordWrap ? 'on' : 'off',
    minimap: { enabled: settings.minimap },
    lineNumbers: settings.lineNumbers,
    renderWhitespace: settings.renderWhitespace,
    stickyScroll: { enabled: settings.stickyScroll },
    bracketPairColorization: { enabled: settings.bracketPairColorization },
    guides: { bracketPairs: settings.bracketPairColorization, indentation: true },
  }
}

const SEVERITY: Record<number, Diagnostic['severity'] | undefined> = { 8: 'error', 4: 'warning', 2: 'info' }

/** Monaco markers → the app's problems. Hints (severity 1) are not problems. */
export function toDiagnostics(markers: EditorMarker[]): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const marker of markers) {
    const severity = SEVERITY[marker.severity]
    if (severity === undefined) continue
    const code = marker.code === undefined ? undefined : typeof marker.code === 'string' ? marker.code : marker.code.value
    out.push({
      severity,
      message: marker.message,
      line: marker.startLineNumber,
      column: marker.startColumn,
      endLine: marker.endLineNumber,
      endColumn: marker.endColumn,
      ...(marker.source !== undefined ? { source: marker.source } : {}),
      ...(code !== undefined ? { code } : {}),
    })
  }
  return out.slice(0, 500)
}

/** The editor's agent actions: id, menu label, and which request they make. */
const AGENT_ACTIONS: ReadonlyArray<{ id: string; label: string; kind: EditorAgentRequest['kind']; order: number }> = [
  { id: 'sketch.ask', label: 'Sketch: Ask About This Code', kind: 'ask', order: 1 },
  { id: 'sketch.edit', label: 'Sketch: Edit With Instructions…', kind: 'edit', order: 2 },
  { id: 'sketch.explain', label: 'Sketch: Explain This Code', kind: 'explain', order: 3 },
  { id: 'sketch.fix', label: 'Sketch: Find and Fix Bugs Here', kind: 'fix', order: 4 },
  { id: 'sketch.tests', label: 'Sketch: Write Tests for This', kind: 'tests', order: 5 },
]

export function CodeEditor({ loader = loadMonaco, completionProvider, onAgentAction, onBlurText, inlineEdit }: CodeEditorProps) {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const latestState = useRef(state)
  latestState.current = state

  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<MonacoEditorInstance | null>(null)
  const apiRef = useRef<MonacoApi | null>(null)
  const registryRef = useRef<ModelRegistry | null>(null)
  const ghostController = useRef<GhostCompletionController | null>(null)
  const agentActionRef = useRef(onAgentAction)
  agentActionRef.current = onAgentAction
  const blurRef = useRef(onBlurText)
  blurRef.current = onBlurText
  const inlineEditRef = useRef(inlineEdit)
  inlineEditRef.current = inlineEdit
  /** Per-tab scroll and selection. View state, not file state. */
  const viewStates = useRef<Map<string, unknown>>(new Map())
  const shownPath = useRef<string | null>(null)
  /** The last reveal request acted on, so one request moves the caret once. */
  const revealed = useRef(0)

  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [cursor, setCursor] = useState({ lineNumber: 1, column: 1 })
  const [ghost, setGhost] = useState<string | null>(null)

  // ── Inline edit (Ctrl+K) ─────────────────────────────────────────────────────
  const [inline, setInline] = useState<InlineState | null>(null)
  const inlineKey = useRef(0)
  /** A request for a file that is not on screen yet (Problems → Fix opens it first). */
  const pendingInline = useRef<InlineEditRequestDetail | null>(null)

  /** Opens inline edit on the visible file. False when there is nothing to edit. */
  const openInlineEdit = useCallback((request: InlineEditRequestDetail = {}): boolean => {
    const editor = editorRef.current
    const model = editor?.getModel() ?? null
    const path = shownPath.current
    if (editor === null || model === null || path === null || inlineEditRef.current === undefined) return false
    const text = model.getValue()
    const table = lineTable(text)
    let range: SelectionRange
    let insertBelow = false
    if (request.lines !== undefined) {
      range = lineRange(table, request.lines.start, request.lines.end)
    } else {
      const selection = editor.getSelection?.() ?? null
      if (selection !== null && !isEmptyRange(selection)) {
        range = wholeLines(selection, table)
      } else {
        // No selection: write on the caret's line if it is blank, else on a new line below it.
        const position = editor.getPosition() ?? { lineNumber: 1, column: 1 }
        const line = Math.min(Math.max(position.lineNumber, 1), lineCount(table))
        const start = table.starts[line - 1]!
        const blank = text.slice(start, start + table.lengths[line - 1]!).trim() === ''
        if (blank) {
          range = lineRange(table, line, line)
        } else {
          const end = maxColumn(table, line)
          range = { startLineNumber: line, startColumn: end, endLineNumber: line, endColumn: end }
          insertBelow = true
        }
      }
    }
    const { before, inside, after } = sliceAround(text, range)
    const eol = eolOf(text)
    const entry = latestState.current.files[path]
    const where = insertBelow
      ? `New code below line ${range.startLineNumber}`
      : range.startLineNumber === range.endLineNumber
        ? `Line ${range.startLineNumber}`
        : `Lines ${range.startLineNumber}–${range.endLineNumber}`
    inlineKey.current += 1
    if (!insertBelow) editor.setSelection?.(range)
    editor.revealLineInCenter?.(range.startLineNumber)
    setInline({
      key: inlineKey.current,
      path,
      target: `${where} · ${entry?.name ?? path}`,
      original: insertBelow ? '' : inside,
      ...(request.instruction !== undefined ? { instruction: request.instruction } : {}),
      ...(request.autoRun === true ? { autoRun: true } : {}),
      range,
      insertBelow,
      anchor: before,
      // The model sees an insertion on its own new line.
      before: insertBelow ? `${before}${eol}` : before,
      after,
      language: entry?.language ?? 'plaintext',
    })
    return true
  }, [])
  const openInlineRef = useRef(openInlineEdit)
  openInlineRef.current = openInlineEdit

  // Menus, the palette and Problems → Fix ask for inline edit with an event.
  useEffect(() => {
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<InlineEditRequestDetail | undefined>).detail ?? {}
      if (detail.path !== undefined && canonicalPath(detail.path) !== shownPath.current) {
        // Not on screen yet: done when it is (see the model swap below).
        pendingInline.current = { ...detail, path: canonicalPath(detail.path) }
        return
      }
      if (!openInlineRef.current(detail)) {
        dispatch({
          type: 'SET_EDITOR_NOTICE',
          payload: { level: 'info', message: 'Inline edit needs a connected model and a file in the editor.' },
        })
      }
    }
    window.addEventListener(INLINE_EDIT_EVENT, onRequest)
    return () => window.removeEventListener(INLINE_EDIT_EVENT, onRequest)
  }, [dispatch])

  const acceptInline = (session: InlineState, proposed: string): string | null => {
    const editor = editorRef.current
    const model = editor?.getModel() ?? null
    if (editor === null || model === null || shownPath.current !== session.path) {
      return 'The file is no longer on screen, so nothing was changed.'
    }
    const text = model.getValue()
    const now = sliceAround(text, session.range)
    // Every target ends at the end of a line; typing on that line moves its end.
    const endMoved = maxColumn(lineTable(text), session.range.endLineNumber) !== session.range.endColumn
    if (endMoved || now.before !== session.anchor || (!session.insertBelow && now.inside !== session.original)) {
      return 'The code changed while the edit was being written, so it was not applied. Press Regenerate to write it again.'
    }
    if (editor.executeEdits === undefined) return 'This editor cannot apply edits.'
    const eol = model.getEOL?.() ?? eolOf(text)
    const body = withEol(proposed, eol)
    editor.pushUndoStop?.()
    const applied = editor.executeEdits('sketch.inlineEdit', [
      { range: session.range, text: session.insertBelow ? `${eol}${body}` : body },
    ])
    editor.pushUndoStop?.()
    if (applied === false) return 'The editor refused the edit.'
    setInline(null)
    editor.focus()
    return null
  }

  // Another tab: the edit belonged to the file it was opened on.
  useEffect(() => {
    if (inline !== null && inline.path !== state.activeFile) setInline(null)
  }, [inline, state.activeFile])

  // ── Change markers: what changed since the last commit ─────────────────────
  const baseline = useHeadBaseline(ready ? state.activeFile : null)
  const decorations = useRef<DecorationsCollection | null>(null)
  const changes = useRef<LineChange[]>([])
  const activeContent = state.activeFile !== null ? state.files[state.activeFile]?.content : undefined
  useEffect(() => {
    const editor = editorRef.current
    if (!ready || editor === null) return
    const timer = setTimeout(() => {
      const model = editor.getModel()
      const shown = shownPath.current
      const next =
        baseline === undefined || baseline === null || model === null || shown === null || shown !== state.activeFile
          ? []
          : lineChanges(baseline, model.getValue())
      changes.current = next
      if (next.length === 0 && decorations.current === null) return
      decorations.current ??= editor.createDecorationsCollection?.() ?? null
      decorations.current?.set(changeDecorations(next))
    }, CHANGE_MARKER_DELAY_MS)
    return () => clearTimeout(timer)
  }, [ready, baseline, activeContent, state.activeFile])

  /** Next / previous change from the caret, wrapping around; Revert the one at the caret. */
  const changeOps = useRef({
    go(direction: 1 | -1): boolean {
      const editor = editorRef.current
      const list = changes.current
      if (editor === null || list.length === 0) return false
      const here = editor.getPosition()?.lineNumber ?? 1
      const lines = list.map(changeLine)
      const target =
        direction === 1
          ? (lines.find((line) => line > here) ?? lines[0]!)
          : ([...lines].reverse().find((line) => line < here) ?? lines[lines.length - 1]!)
      editor.setPosition?.({ lineNumber: target, column: 1 })
      editor.revealLineInCenter?.(target)
      editor.focus()
      return true
    },
    revert(): boolean {
      const editor = editorRef.current
      const model = editor?.getModel() ?? null
      if (editor === null || model === null || editor.executeEdits === undefined) return false
      const change = changeAt(changes.current, editor.getPosition()?.lineNumber ?? 1)
      if (change === null) return false
      const text = model.getValue()
      const edit = revertEdit(change, lineTable(text), model.getEOL?.() ?? eolOf(text))
      editor.pushUndoStop?.()
      editor.executeEdits('sketch.revertChange', [edit])
      editor.pushUndoStop?.()
      return true
    },
  })

  // ── Mount: load Monaco, build the model map, create the one editor ──────────
  useEffect(() => {
    let cancelled = false
    let cursorSubscription: Disposable | null = null
    let cursorTimer: ReturnType<typeof setTimeout> | null = null
    const extras: Disposable[] = []

    loader()
      .then(({ api, theme }) => {
        const container = containerRef.current
        if (cancelled || !container) return
        apiRef.current = api

        // Native ghost text where Monaco has the widget (the real app); the overlay
        // controller otherwise (test doubles). Never both: two suggestion sources for
        // one caret would be two answers to the same question.
        const native = completionProvider !== undefined && api.languages.registerInlineCompletions !== undefined
        ghostController.current =
          completionProvider !== undefined && !native
            ? new GhostCompletionController({
                provider: completionProvider,
                enabled: () => latestState.current.ghostCompletionsEnabled,
                onSuggestion: setGhost,
              })
            : null
        if (native) {
          extras.push(
            api.languages.registerInlineCompletions!(async (request) => {
              if (!latestState.current.ghostCompletionsEnabled) return null
              // Only the buffer on screen: a suggestion for a background model is noise.
              const shown = shownPath.current
              if (shown === null) return null
              return completionProvider!({
                path: shown,
                content: request.content,
                cursorOffset: request.cursorOffset,
                language: request.language,
                signal: request.signal,
              })
            }),
          )
        }

        // The ONLY model→state path in the app. `ModelRegistry` suppresses its own
        // programmatic writes, so this fires for user input and nothing else.
        registryRef.current = new ModelRegistry(api, (path, content) => {
          dispatch({ type: 'UPDATE_FILE_CONTENT', payload: { path, content } })
          ghostController.current?.update({ path, content, cursorOffset: content.length })
        })

        const editor = api.editor.create(container, {
          ...EDITOR_OPTIONS,
          ...optionsFor(latestState.current.editorSettings),
          theme,
        })
        editorRef.current = editor

        // Problems: Monaco's markers for open files, into the one state owner.
        if (api.editor.onDidChangeMarkers !== undefined && api.editor.getMarkers !== undefined) {
          const getMarkers = api.editor.getMarkers
          extras.push(
            api.editor.onDidChangeMarkers((paths) => {
              const open = new Set(latestState.current.openFiles)
              for (const raw of paths) {
                const path = canonicalPath(raw)
                if (!open.has(path)) continue
                dispatch({ type: 'SET_DIAGNOSTICS', payload: { path, diagnostics: toDiagnostics(getMarkers(path)) } })
              }
            }),
          )
        }
        void api.languageServices?.setEnabled(latestState.current.editorSettings.languageFeatures).catch(() => {})

        if (editor.onDidBlurEditorText !== undefined) {
          extras.push(editor.onDidBlurEditorText(() => blurRef.current?.()))
        }

        // Format on save, Format Document, Go to Line… reach this editor through the bridge.
        const unregister = registerEditorBridge({
          async format(path) {
            const model = editor.getModel()
            if (shownPath.current !== path || model === null) return null
            const action = editor.getAction?.('editor.action.formatDocument') ?? null
            if (action === null || !action.isSupported()) return null
            const before = model.getValue()
            await action.run()
            const after = model.getValue()
            return after === before ? null : after
          },
          run(actionId) {
            // Sketch's own editor operations first; they are not Monaco actions.
            const notice = (message: string) =>
              dispatch({ type: 'SET_EDITOR_NOTICE', payload: { level: 'info', message } })
            if (actionId === 'sketch.inlineEdit') {
              if (!openInlineRef.current()) notice('Inline edit needs a connected model and a file in the editor.')
              return true
            }
            if (actionId === 'sketch.git.nextChange' || actionId === 'sketch.git.previousChange') {
              if (!changeOps.current.go(actionId === 'sketch.git.nextChange' ? 1 : -1)) {
                notice('This file has no changes since the last commit.')
              }
              return true
            }
            if (actionId === 'sketch.git.revertChange') {
              if (!changeOps.current.revert()) notice('The caret is not on a line that changed since the last commit.')
              return true
            }
            const action = editor.getAction?.(actionId) ?? null
            editor.focus()
            if (action !== null) {
              void action.run()
              return true
            }
            // Undo and redo are commands, not actions.
            if (editor.trigger === undefined) return false
            editor.trigger('menu', actionId, null)
            return true
          },
          focus() {
            editor.focus()
          },
          insertText(text) {
            const model = editor.getModel()
            if (shownPath.current === null || model === null || editor.executeEdits === undefined) return false
            const position = editor.getPosition() ?? { lineNumber: 1, column: 1 }
            const selection = editor.getSelection?.() ?? null
            const range = selection ?? {
              startLineNumber: position.lineNumber,
              startColumn: position.column,
              endLineNumber: position.lineNumber,
              endColumn: position.column,
            }
            const body = withEol(text, model.getEOL?.() ?? eolOf(model.getValue()))
            editor.pushUndoStop?.()
            const applied = editor.executeEdits('sketch.insert', [{ range, text: body }])
            editor.pushUndoStop?.()
            editor.focus()
            return applied !== false
          },
          acquireModel(path) {
            // Created from the authoritative state text exactly as a tab's own model is,
            // so the registry stays the one owner (and the one listener) of every file model.
            const registry = registryRef.current
            const key = canonicalPath(path)
            const entry = latestState.current.files[key]
            if (registry === null || entry === undefined) return null
            return registry.acquire(key, entry.content)
          },
        })
        extras.push({ dispose: unregister })

        // The agent, one right-click (or shortcut) away from the code.
        if (api.addEditorAction !== undefined) {
          const keys = api.keys
          for (const action of AGENT_ACTIONS) {
            const keybindings =
              keys === undefined
                ? undefined
                : action.kind === 'ask'
                  ? [keys.ctrlCmd | keys.keyL]
                  : action.kind === 'edit'
                    ? [keys.ctrlCmd | keys.keyK]
                    : undefined
            extras.push(
              api.addEditorAction(editor, {
                id: action.id,
                label: action.label,
                contextMenuGroupId: '0_sketch',
                contextMenuOrder: action.order,
                ...(keybindings !== undefined ? { keybindings } : {}),
                run: () => {
                  const path = shownPath.current
                  const handler = agentActionRef.current
                  // Ctrl+K edits in place when inline edit is available; the chat otherwise.
                  if (action.kind === 'edit' && inlineEditRef.current !== undefined && openInlineRef.current()) return
                  if (path === null || handler === undefined) return
                  const selection = editor.getSelection?.() ?? null
                  const model = editor.getModel()
                  const hasSelection =
                    selection !== null &&
                    (selection.startLineNumber !== selection.endLineNumber || selection.startColumn !== selection.endColumn)
                  const code = hasSelection && model?.getValueInRange ? model.getValueInRange(selection!) : ''
                  handler({
                    kind: action.kind,
                    path,
                    lines: hasSelection ? { start: selection!.startLineNumber, end: selection!.endLineNumber } : null,
                    code,
                  })
                },
              }),
            )
          }
          if (keys !== undefined) {
            // Alt+\ asks for a suggestion right now, like every Copilot-style editor.
            extras.push(
              api.addEditorAction(editor, {
                id: 'sketch.inlineSuggest',
                label: 'Sketch: Suggest Code Here (Autocomplete)',
                keybindings: [keys.alt | keys.backslash],
                run: () => editor.trigger?.('sketch', 'editor.action.inlineSuggest.trigger', {}),
              }),
            )
          }
          // Change markers: move between them and put one back, as in VS Code.
          const f5 = keys?.f5
          for (const op of [
            { id: 'sketch.git.nextChange', label: 'Git: Go to Next Change', run: () => changeOps.current.go(1), keys: f5 !== undefined ? [keys!.alt | f5] : undefined },
            { id: 'sketch.git.previousChange', label: 'Git: Go to Previous Change', run: () => changeOps.current.go(-1), keys: f5 !== undefined ? [keys!.shift | keys!.alt | f5] : undefined },
            { id: 'sketch.git.revertChange', label: 'Git: Revert This Change', run: () => changeOps.current.revert(), keys: undefined, menu: true },
          ]) {
            extras.push(
              api.addEditorAction(editor, {
                id: op.id,
                label: op.label,
                ...(op.keys !== undefined ? { keybindings: op.keys } : {}),
                ...(op.menu === true ? { contextMenuGroupId: '1_sketch_git', contextMenuOrder: 1 } : {}),
                run: () => {
                  op.run()
                },
              }),
            )
          }
        }

        cursorSubscription = editor.onDidChangeCursorPosition(() => {
          const position = editor.getPosition()
          if (!position) return
          setCursor({ lineNumber: position.lineNumber, column: position.column })
          // The status bar shows it too. Debounced: every caret move re-renders the
          // window, and a held arrow key moves the caret dozens of times a second.
          if (cursorTimer !== null) clearTimeout(cursorTimer)
          cursorTimer = setTimeout(() => {
            dispatch({ type: 'SET_CURSOR', payload: { line: position.lineNumber, column: position.column } })
          }, 120)
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
      if (cursorTimer !== null) clearTimeout(cursorTimer)
      for (const extra of extras) extra.dispose()
      // Models first: each holds a full text buffer and its tokenization, so one
      // leaked per file opened is a real leak in a long session.
      registryRef.current?.disposeAll()
      registryRef.current = null
      editorRef.current?.dispose()
      editorRef.current = null
      apiRef.current = null
      shownPath.current = null
      ghostController.current?.dispose()
      ghostController.current = null
    }
  }, [completionProvider, dispatch, loader])

  // Turning the feature off cancels queued and in-flight requests immediately.
  useEffect(() => {
    if (!state.ghostCompletionsEnabled) ghostController.current?.cancel()
  }, [state.ghostCompletionsEnabled])

  // ── Settings → the live editor ──────────────────────────────────────────────
  const settings: EditorSettings = state.editorSettings
  useEffect(() => {
    const editor = editorRef.current
    if (!ready || editor === null) return
    editor.updateOptions?.(optionsFor(settings))
  }, [ready, settings])

  useEffect(() => {
    if (!ready) return
    void apiRef.current?.languageServices?.setEnabled(settings.languageFeatures).catch(() => {})
  }, [ready, settings.languageFeatures])

  // ── Reveal: put the caret on a line the user asked for ─────────────────────
  // Runs after the model swap below has shown the right file; the nonce makes one
  // request move the caret exactly once, however many renders follow.
  const reveal = state.revealRequest
  useEffect(() => {
    const editor = editorRef.current
    if (!ready || editor === null || reveal === null) return
    if (reveal.nonce === revealed.current) return
    if (shownPath.current !== reveal.path || state.activeFile !== reveal.path) return
    revealed.current = reveal.nonce
    editor.setPosition?.({ lineNumber: reveal.line, column: reveal.column })
    editor.revealLineInCenter?.(reveal.line)
    editor.focus()
  }, [ready, reveal, state.activeFile, state.files])

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

    // An inline edit asked for this file before it was on screen (Problems → Fix).
    const pending = pendingInline.current
    if (pending !== null && pending.path === entry.path) {
      pendingInline.current = null
      openInlineRef.current(pending)
    }
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
      {inline !== null && inlineEdit !== undefined && (
        <InlineEditWidget
          key={inline.key}
          session={inline}
          generate={(instruction, signal) =>
            inlineEdit(
              {
                path: inline.path,
                language: inline.language,
                // The model is shown plain line feeds; the edit is written with the file's own.
                before: withEol(inline.before, '\n'),
                selection: withEol(inline.original, '\n'),
                after: withEol(inline.after, '\n'),
                instruction,
              },
              signal,
            )
          }
          accept={(proposed) => acceptInline(inline, proposed)}
          onClose={() => {
            setInline(null)
            editorRef.current?.focus()
          }}
          openInChat={
            onAgentAction === undefined
              ? undefined
              : (instruction) => {
                  setInline(null)
                  onAgentAction({
                    kind: 'edit',
                    path: inline.path,
                    lines: inline.insertBelow ? null : { start: inline.range.startLineNumber, end: inline.range.endLineNumber },
                    code: inline.original,
                    instruction,
                  })
                }
          }
        />
      )}
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
