// The exact slice of Monaco the editor uses.
//
// Monaco's own types are enormous and its runtime does not load under jsdom (it
// measures a real DOM and spawns web workers). Both problems are solved the same
// way as the engine transport is: name the surface as an interface, depend on the
// interface, and let production supply the real thing (./monacoSetup.ts) while a
// test supplies a double (./monacoDouble.ts).
//
// This is NOT a re-implementation of Monaco and not a second cache of anything —
// it is a structural subset. `monacoSetup.ts` asserts at compile time that the real
// `monaco` namespace satisfies it, so a Monaco upgrade that changes any of these
// signatures fails `tsc` instead of failing at runtime.
//
// Validates: Requirements 15.1, 15.2

import type { EditorLanguageRule, EditorThemeDefinition } from './extensionRegistry'

export interface Disposable {
  dispose(): void
}

/**
 * A model's URI, READ-ONLY as far as this app is concerned.
 *
 * Only Monaco constructs one, we never parse one, and — importantly — we never hand
 * one back to Monaco. That last part is why the api below is keyed by path rather
 * than by URI: `monaco.Uri` is a class with eight fields, so an interface small
 * enough to be honest here could never be passed to `createModel`, whose parameter
 * type is the real `Uri`. Keeping the URI on the way OUT only (for assertions and
 * debugging) keeps this type as small as what we actually read from it.
 */
export interface ModelUri {
  toString(): string
}

export interface TextModel {
  readonly uri: ModelUri
  getValue(): string
  setValue(value: string): void
  onDidChangeContent(listener: () => void): Disposable
  isDisposed(): boolean
  dispose(): void
  /** Text of a range, for editor actions over the selection. Optional for doubles. */
  getValueInRange?(range: SelectionRange): string
  /** Lines in the model, and the last column of one, for whole-line ranges. */
  getLineCount?(): number
  getLineMaxColumn?(lineNumber: number): number
  /** The model's line ending, so inserted text matches the file's. */
  getEOL?(): string
}

export interface CursorPosition {
  lineNumber: number
  column: number
}

/** A selection or range, 1-based like Monaco's own. */
export interface SelectionRange {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

/** One text replacement, as Monaco's `executeEdits` takes it. */
export interface EditorEdit {
  range: SelectionRange
  text: string
}

/** The decoration options this app sets. All real Monaco option names. */
export interface EditorDecorationOptions {
  isWholeLine?: boolean
  /** A CSS class for the strip between the line numbers and the text (the change bar). */
  linesDecorationsClassName?: string
  /** A CSS class over the text itself. */
  className?: string
  /** A mark in the scrollbar's overview ruler. `position` is Monaco's OverviewRulerLane (1 left, 2 center, 4 right). */
  overviewRuler?: { color: string; position: number }
}

export interface EditorDecoration {
  range: SelectionRange
  options: EditorDecorationOptions
}

/** A set of decorations that can be replaced or cleared as one. */
export interface DecorationsCollection {
  set(decorations: EditorDecoration[]): unknown
  clear(): void
}

/** An entry for the editor's context menu and command palette. */
export interface EditorActionDescriptor {
  id: string
  label: string
  /** Monaco keybinding numbers (KeyMod | KeyCode), already combined. */
  keybindings?: number[]
  contextMenuGroupId?: string
  contextMenuOrder?: number
  run(): void
}

export interface CodeEditor {
  setModel(model: TextModel | null): void
  getModel(): TextModel | null
  getPosition(): CursorPosition | null
  onDidChangeCursorPosition(listener: () => void): Disposable
  layout(): void
  focus(): void
  dispose(): void
  /** View state is per-tab scroll and selection. Optional: a double may skip it. */
  saveViewState?(): unknown
  restoreViewState?(state: unknown): void
  /** The current selection. Optional: a double may skip it. */
  getSelection?(): SelectionRange | null
  /** Run a built-in editor command, e.g. `editor.action.inlineSuggest.trigger`. */
  trigger?(source: string, handlerId: string, payload: unknown): void
  /** Apply changed settings (font size, wrap, minimap…) to a live editor. */
  updateOptions?(options: EditorRuntimeOptions): void
  /** Move the caret. Optional for doubles. */
  setPosition?(position: CursorPosition): void
  /** Scroll so `lineNumber` is in the middle of the viewport. */
  revealLineInCenter?(lineNumber: number): void
  /** The text area lost focus — the moment "save on focus change" acts. */
  onDidBlurEditorText?(listener: () => void): Disposable
  /** A built-in action by id, to ask whether it applies here and to run it. */
  getAction?(id: string): { run(): Promise<void>; isSupported(): boolean } | null
  /** Select a range (and so reveal what an inline edit will replace). */
  setSelection?(range: SelectionRange): void
  /** Replace ranges as one user-visible edit, undoable with Ctrl+Z. */
  executeEdits?(source: string, edits: EditorEdit[]): boolean
  /** Close the current undo step, so an inline edit undoes on its own. */
  pushUndoStop?(): boolean
  /** Decorations that live and die together: the gutter's change markers. */
  createDecorationsCollection?(decorations?: EditorDecoration[]): DecorationsCollection
}

/** Options that may change while an editor is open. All real Monaco option names. */
export interface EditorRuntimeOptions {
  fontSize?: number
  lineHeight?: number
  tabSize?: number
  insertSpaces?: boolean
  wordWrap?: 'on' | 'off'
  minimap?: { enabled: boolean }
  lineNumbers?: 'on' | 'off' | 'relative'
  renderWhitespace?: 'none' | 'boundary' | 'selection' | 'trailing' | 'all'
  stickyScroll?: { enabled: boolean }
  bracketPairColorization?: { enabled: boolean }
  guides?: { bracketPairs?: boolean; indentation?: boolean }
  /** Language-service completions as you type; word completions otherwise. */
  quickSuggestions?: boolean
}

/** One problem a language service attached to a model, as Monaco reports it. */
export interface EditorMarker {
  /** Monaco's MarkerSeverity: 8 error, 4 warning, 2 info, 1 hint. */
  severity: number
  message: string
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
  source?: string
  code?: string | { value: string }
}

/**
 * One inline-completion request, as the editor's provider sees it: the whole buffer
 * and the caret offset, plus a signal Monaco aborts when the user types on.
 */
export interface InlineCompletionRequest {
  path: string
  language: string
  content: string
  cursorOffset: number
  signal: AbortSignal
}

/**
 * The editor options this app actually sets, named one by one instead of passed as
 * a `Record<string, unknown>`.
 *
 * A bag of `unknown` cannot be handed to Monaco's own `create` — `unknown` is not a
 * `string` — so it would have forced a cast at the only place a typo in an option
 * name or value could be caught. Every field below is a real Monaco option, and the
 * unions are the subsets we use.
 */
export interface EditorCreateOptions {
  /** A theme registered with `defineTheme`. */
  theme: string
  automaticLayout?: boolean
  fontFamily?: string
  fontSize?: number
  lineHeight?: number
  lineNumbers?: 'on' | 'off' | 'relative'
  minimap?: { enabled: boolean }
  scrollBeyondLastLine?: boolean
  smoothScrolling?: boolean
  renderWhitespace?: 'none' | 'boundary' | 'selection' | 'trailing' | 'all'
  tabSize?: number
  fixedOverflowWidgets?: boolean
  padding?: { top?: number; bottom?: number }
  readOnly?: boolean
  /** Monaco's native ghost-text widget. */
  inlineSuggest?: { enabled: boolean }
  insertSpaces?: boolean
  wordWrap?: 'on' | 'off'
  stickyScroll?: { enabled: boolean }
  bracketPairColorization?: { enabled: boolean }
  guides?: { bracketPairs?: boolean; indentation?: boolean }
  /** Smooth caret animation. */
  cursorSmoothCaretAnimation?: 'off' | 'explicit' | 'on'
}

/** One region that differs, 1-based; an end of 0 means "nothing on this side". */
export interface DiffLineChange {
  readonly originalStartLineNumber: number
  readonly originalEndLineNumber: number
  readonly modifiedStartLineNumber: number
  readonly modifiedEndLineNumber: number
}

/** The diff options this app sets when creating one. All real Monaco option names. */
export interface DiffEditorCreateOptions {
  theme: string
  automaticLayout?: boolean
  /** The right-hand (modified) side. The live file stays editable; a snapshot does not. */
  readOnly?: boolean
  originalEditable?: boolean
  renderSideBySide?: boolean
  /** Fall back to the inline view when the editor is too narrow for two columns. */
  useInlineViewWhenSpaceIsLimited?: boolean
  /** Below this width (px) the fallback applies. Monaco's default is 900. */
  renderSideBySideInlineBreakpoint?: number
  hideUnchangedRegions?: { enabled?: boolean }
  ignoreTrimWhitespace?: boolean
  fontFamily?: string
  fontSize?: number
  lineHeight?: number
  minimap?: { enabled: boolean }
  scrollBeyondLastLine?: boolean
  fixedOverflowWidgets?: boolean
}

/** Diff options that may change while it is open. */
export interface DiffEditorRuntimeOptions {
  renderSideBySide?: boolean
  hideUnchangedRegions?: { enabled?: boolean }
  ignoreTrimWhitespace?: boolean
  readOnly?: boolean
  fontSize?: number
  lineHeight?: number
}

/** Monaco's diff editor, as far as the diff view uses it. */
export interface DiffEditor {
  setModel(model: { original: TextModel; modified: TextModel } | null): void
  updateOptions(options: DiffEditorRuntimeOptions): void
  goToDiff(target: 'next' | 'previous'): void
  /** Null until the first diff has been computed. */
  getLineChanges(): DiffLineChange[] | null
  onDidUpdateDiff(listener: () => void): Disposable
  /** The right-hand editor, to put the caret in it. */
  focusModified(): void
  layout(): void
  dispose(): void
}

/**
 * The api the editor talks to, KEYED BY CANONICAL PATH rather than by `Uri`.
 *
 * `ModelRegistry` never needs a URI for its own sake — it needs "the model for this
 * path", "a new model for this path", and "an editor". Naming the surface that way
 * means the only code that knows about `monaco.Uri` is the four lines of
 * monacoRuntime.ts that call `Uri.file`, and the path → URI mapping stays exactly
 * one function call deep (see ./paths.ts for what that mapping is).
 */
export interface MonacoApi {
  editor: {
    /** Registers a local theme definition before an editor selects it. */
    defineTheme(name: string, definition: EditorThemeDefinition): void
    /** Switch every editor to a registered theme (Monaco's themes are global). Optional for doubles. */
    setTheme?(name: string): void
    /** Monaco's existing model for `path`, or null. Adopted rather than duplicated. */
    getModel(path: string): TextModel | null
    /** A new model for `path`. Throws if Monaco already has one, as Monaco does. */
    createModel(value: string, language: string, path: string): TextModel
    /**
     * A model with no file behind it — Monaco names it in memory, so it can never
     * collide with a file's model — for the left side of a diff ("as committed").
     * Optional for doubles.
     */
    createScratchModel?(value: string, language: string): TextModel
    create(container: HTMLElement, options: EditorCreateOptions): CodeEditor
    /** Two models side by side (or inline) with their differences. Optional for doubles. */
    createDiffEditor?(container: HTMLElement, options: DiffEditorCreateOptions): DiffEditor
    /** Fires with the paths whose problems changed. Optional for doubles. */
    onDidChangeMarkers?(listener: (paths: string[]) => void): Disposable
    /** The problems attached to `path`'s model. Optional for doubles. */
    getMarkers?(path: string): EditorMarker[]
  }
  /**
   * IntelliSense, hover, go-to-definition and problems for TypeScript, JavaScript, JSON,
   * CSS and HTML. Loaded on first use (the services and their workers are large) and
   * switchable without a reload. Optional: test doubles have no language services.
   */
  languageServices?: {
    setEnabled(enabled: boolean): Promise<void>
  }
  languages: {
    /** Registers a real Monaco language id and the extensions Monaco associates with it. */
    register(definition: { id: string; extensions: string[] }): void
    /** Installs a host-supplied Monarch tokenizer for that language id. */
    setMonarchTokensProvider(id: string, rules: EditorLanguageRule[]): Disposable
    /**
     * Native ghost text for every language: Monaco renders the suggestion inline,
     * Tab accepts it, Esc dismisses it, and typing on cancels the request. Optional
     * because a test double has no inline-suggest widget to drive.
     */
    registerInlineCompletions?(
      provide: (request: InlineCompletionRequest) => Promise<string | null>,
      options?: { debounceMs?: number },
    ): Disposable
  }
  /** Context-menu / F1 actions on one editor. Optional for doubles. */
  addEditorAction?(editor: CodeEditor, action: EditorActionDescriptor): Disposable
  /** Monaco key codes for the shortcuts this app binds. Optional for doubles. */
  keys?: { ctrlCmd: number; shift: number; alt: number; keyL: number; keyK: number; backslash: number; keyI: number; f5?: number }
}
