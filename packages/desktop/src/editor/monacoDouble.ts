// A test double for the slice of Monaco named in ./monacoApi.
//
// TEST-ONLY. Nothing under src/ may import this file, and `editor.test.ts` asserts
// that. It exists because the real Monaco does not run under jsdom (it measures a
// live DOM and spawns workers), and the alternative — mocking `ModelRegistry`, the
// reducer, or the reconciliation — would mean testing none of the logic this phase
// is actually about.
//
// WHAT IS FAKE HERE: text storage, the change event, the caret, `dispose`. That is
// all. In particular `setValue` fires the change listener exactly as Monaco's does,
// which is what makes the registry's suppression guard testable at all — without
// that fidelity the double would hide the one bug it is here to catch.
//
// WHAT IS REAL IN EVERY TEST THAT USES IT: `ModelRegistry`, the `AppState` reducer,
// `useFileActions`, `useEngineWriteReconciler`, and every path/canonicalization rule.

import { canonicalPath } from './paths'
import { applyEdit, lineTable, maxColumn as lineMaxColumn, offsetAt } from './inlineEditing'
import { lineChanges } from './lineDiff'
import type {
  CodeEditor,
  CursorPosition,
  DecorationsCollection,
  DiffEditor,
  DiffEditorCreateOptions,
  DiffEditorRuntimeOptions,
  DiffLineChange,
  Disposable,
  EditorDecoration,
  EditorEdit,
  ModelUri,
  MonacoApi,
  SelectionRange,
  TextModel,
  EditorCreateOptions,
} from './monacoApi'
import type { EditorLanguageRule, EditorThemeDefinition } from './extensionRegistry'

/**
 * What the double's model offers ON TOP of `TextModel`, declared so a test can reach
 * for it without casting.
 *
 * `TextModel` is the production surface and must stay that: adding `typeText` to it
 * would put a test affordance in the type the real Monaco has to satisfy. The right
 * place to name these is here, where the fake lives, and `MonacoDouble.model(path)`
 * hands one back with this type — so the four helpers below are checked rather than
 * asserted into existence.
 */
export interface FakeTextModel extends TextModel {
  /** Monaco's language id, as it was passed to `createModel`. */
  readonly language: string
  /** What a keystroke does: change the text and fire the change event. */
  typeText(value: string): void
  /** `setValue` calls so far, so a test can prove a no-op sync writes nothing. */
  readonly setValueCount: number
  /** Live `onDidChangeContent` listeners, so a test can prove disposal unhooks. */
  readonly listenerCount: number
}

/** What the double's editor offers on top of `CodeEditor`, for the same reason. */
export interface FakeCodeEditor extends CodeEditor {
  readonly container: HTMLElement
  readonly options: EditorCreateOptions
  readonly disposed: boolean
  /** Move the caret as Monaco would, so a test can prove the readout is real. */
  moveTo(lineNumber: number, column: number): void
  readonly optionUpdates: Array<Record<string, unknown>>
  readonly revealedLines: number[]
  readonly actions: Map<string, { runs: number; supported: boolean }>
  /** What leaving the text area does. */
  blur(): void
  /** Select a range as a mouse drag would. */
  select(range: SelectionRange): void
  /** Every `executeEdits` call, in order. */
  readonly appliedEdits: Array<{ source: string; edits: EditorEdit[] }>
  /** The decorations currently set through decoration collections. */
  readonly decorations: EditorDecoration[]
}

class FakeUri implements ModelUri {
  constructor(readonly path: string) {}
  toString(): string {
    // Shaped like Monaco's `Uri.file` output, including the encoded drive colon, so
    // a test that inspects a uri sees the real mapping described in ./paths.ts.
    const encoded = /^[A-Za-z]:/.test(this.path)
      ? `${this.path[0]!.toLowerCase()}%3A${this.path.slice(2)}`
      : this.path
    return `file://${encoded.startsWith('/') ? '' : '/'}${encoded}`
  }
}

export class FakeModel implements FakeTextModel {
  private value: string
  private disposed = false
  private listeners = new Set<() => void>()
  /** Counts `setValue` calls, so a test can prove sync writes only when needed. */
  setValueCount = 0

  constructor(
    value: string,
    readonly language: string,
    readonly uri: ModelUri,
  ) {
    this.value = value
  }

  getValue(): string {
    return this.value
  }

  getValueInRange(range: SelectionRange): string {
    const table = lineTable(this.value)
    return this.value.slice(
      offsetAt(table, range.startLineNumber, range.startColumn),
      offsetAt(table, range.endLineNumber, range.endColumn),
    )
  }

  getLineCount(): number {
    return lineTable(this.value).starts.length
  }

  getLineMaxColumn(lineNumber: number): number {
    return lineMaxColumn(lineTable(this.value), lineNumber)
  }

  getEOL(): string {
    return this.value.includes('\r\n') ? '\r\n' : '\n'
  }

  /** What an editor edit does to the text: replace, then fire like a keystroke. */
  applyEdits(edits: EditorEdit[]): void {
    // Last range first, so earlier offsets stay valid.
    const ordered = [...edits].sort(
      (a, b) => b.range.startLineNumber - a.range.startLineNumber || b.range.startColumn - a.range.startColumn,
    )
    let next = this.value
    for (const edit of ordered) next = applyEdit(next, edit)
    this.value = next
    this.fire()
  }

  setValue(value: string): void {
    this.setValueCount += 1
    this.value = value
    this.fire()
  }

  /** What a keystroke does: change the text and fire, with no other ceremony. */
  typeText(value: string): void {
    this.value = value
    this.fire()
  }

  onDidChangeContent(listener: () => void): Disposable {
    this.listeners.add(listener)
    return {
      dispose: () => {
        this.listeners.delete(listener)
      },
    }
  }

  private fire(): void {
    for (const listener of [...this.listeners]) listener()
  }

  isDisposed(): boolean {
    return this.disposed
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }

  get listenerCount(): number {
    return this.listeners.size
  }
}

export class FakeEditor implements FakeCodeEditor {
  private model: TextModel | null = null
  private position: CursorPosition = { lineNumber: 1, column: 1 }
  private cursorListeners = new Set<() => void>()
  disposed = false

  constructor(
    readonly container: HTMLElement,
    readonly options: EditorCreateOptions,
  ) {}

  setModel(model: TextModel | null): void {
    this.model = model
  }

  getModel(): TextModel | null {
    return this.model
  }

  getPosition(): CursorPosition | null {
    return this.position
  }

  /** Move the caret as Monaco would, so a test can prove the readout is real. */
  moveTo(lineNumber: number, column: number): void {
    this.position = { lineNumber, column }
    for (const listener of [...this.cursorListeners]) listener()
  }

  onDidChangeCursorPosition(listener: () => void): Disposable {
    this.cursorListeners.add(listener)
    return {
      dispose: () => {
        this.cursorListeners.delete(listener)
      },
    }
  }

  layout(): void {}
  focus(): void {}

  /** Every `updateOptions` call, in order, so a test can prove settings reach Monaco. */
  readonly optionUpdates: Array<Record<string, unknown>> = []
  /** Every `revealLineInCenter` call. */
  readonly revealedLines: number[] = []
  private blurListeners = new Set<() => void>()
  /** Actions a test registered as available, by id; `getAction` returns these. */
  readonly actions = new Map<string, { runs: number; supported: boolean }>()

  updateOptions(options: Record<string, unknown>): void {
    this.optionUpdates.push({ ...options })
  }

  setPosition(position: CursorPosition): void {
    this.moveTo(position.lineNumber, position.column)
  }

  revealLineInCenter(lineNumber: number): void {
    this.revealedLines.push(lineNumber)
  }

  onDidBlurEditorText(listener: () => void): Disposable {
    this.blurListeners.add(listener)
    return { dispose: () => this.blurListeners.delete(listener) }
  }

  /** What leaving the text area does. */
  blur(): void {
    for (const listener of [...this.blurListeners]) listener()
  }

  getAction(id: string): { run(): Promise<void>; isSupported(): boolean } | null {
    const action = this.actions.get(id)
    if (action === undefined) return null
    return {
      run: async () => {
        action.runs += 1
      },
      isSupported: () => action.supported,
    }
  }

  private selection: SelectionRange | null = null

  getSelection(): SelectionRange | null {
    return this.selection ?? {
      startLineNumber: this.position.lineNumber,
      startColumn: this.position.column,
      endLineNumber: this.position.lineNumber,
      endColumn: this.position.column,
    }
  }

  setSelection(range: SelectionRange): void {
    this.selection = { ...range }
  }

  /** Select a range as a mouse drag would; the caret goes to its end. */
  select(range: SelectionRange): void {
    this.selection = { ...range }
    this.moveTo(range.endLineNumber, range.endColumn)
  }

  readonly appliedEdits: Array<{ source: string; edits: EditorEdit[] }> = []

  executeEdits(source: string, edits: EditorEdit[]): boolean {
    const model = this.model as FakeModel | null
    if (model === null || typeof model.applyEdits !== 'function') return false
    this.appliedEdits.push({ source, edits: edits.map((edit) => ({ range: { ...edit.range }, text: edit.text })) })
    model.applyEdits(edits)
    return true
  }

  pushUndoStop(): boolean {
    return true
  }

  private collections: Array<{ items: EditorDecoration[] }> = []

  createDecorationsCollection(decorations: EditorDecoration[] = []): DecorationsCollection {
    const holder = { items: [...decorations] }
    this.collections.push(holder)
    return {
      set: (next: EditorDecoration[]) => {
        holder.items = [...next]
        return next.map((_, index) => `d${index}`)
      },
      clear: () => {
        holder.items = []
      },
    }
  }

  get decorations(): EditorDecoration[] {
    return this.collections.flatMap((holder) => holder.items)
  }

  dispose(): void {
    this.disposed = true
    this.cursorListeners.clear()
  }
}

export interface MonacoDouble {
  api: MonacoApi
  /** Every model ever created, by canonical path, including disposed ones. */
  created: Map<string, FakeTextModel>
  /** Models Monaco still has, i.e. not disposed. Mirrors Monaco's own registry. */
  live: Map<string, FakeTextModel>
  /** In-memory models (no file behind them), in creation order, disposed ones included. */
  scratch: FakeTextModel[]
  /** Every diff editor created, in order. */
  diffEditors: FakeDiffEditor[]
  /** The theme `setTheme` last switched to, or null. */
  readonly theme: string | null
  /** Theme definitions supplied through Monaco's real registration surface. */
  definedThemes: Map<string, EditorThemeDefinition>
  /** Host languages whose id, extensions, and tokenizer reached Monaco setup. */
  registeredLanguages: Map<string, { extensions: string[]; rules: EditorLanguageRule[] }>
  editors: FakeCodeEditor[]
  lastEditor(): FakeCodeEditor
  /**
   * The fake model for `path`, with the fake's own helpers visible. Throws rather
   * than returning null so a test that names the wrong path fails saying so.
   * Includes disposed models, which is what makes disposal assertable.
   */
  model(path: string): FakeTextModel
}

/**
 * Monaco's diff editor, faked as far as the diff view uses it. Like the real one it
 * recomputes whenever either side's text changes and says so through `onDidUpdateDiff`;
 * the changes are the gutter's own line diff, which is enough to count them.
 */
export class FakeDiffEditor implements DiffEditor {
  model: { original: TextModel; modified: TextModel } | null = null
  disposed = false
  readonly optionUpdates: DiffEditorRuntimeOptions[] = []
  readonly navigations: Array<'next' | 'previous'> = []
  private changes: DiffLineChange[] | null = null
  private listeners = new Set<() => void>()
  private watching: Disposable[] = []

  constructor(
    readonly container: HTMLElement,
    readonly options: DiffEditorCreateOptions,
  ) {}

  setModel(model: { original: TextModel; modified: TextModel } | null): void {
    for (const subscription of this.watching) subscription.dispose()
    this.watching = []
    this.model = model
    this.changes = null
    if (model === null) return
    this.watching.push(
      model.original.onDidChangeContent(() => this.recompute()),
      model.modified.onDidChangeContent(() => this.recompute()),
    )
    this.recompute()
  }

  private recompute(): void {
    const model = this.model
    if (model === null) return
    this.changes = lineChanges(model.original.getValue(), model.modified.getValue()).map((change) =>
      change.kind === 'deleted'
        ? { originalStartLineNumber: 1, originalEndLineNumber: 1, modifiedStartLineNumber: change.after, modifiedEndLineNumber: 0 }
        : { originalStartLineNumber: 1, originalEndLineNumber: 1, modifiedStartLineNumber: change.start, modifiedEndLineNumber: change.end },
    )
    for (const listener of [...this.listeners]) listener()
  }

  getLineChanges(): DiffLineChange[] | null {
    return this.changes
  }

  onDidUpdateDiff(listener: () => void): Disposable {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  updateOptions(options: DiffEditorRuntimeOptions): void {
    this.optionUpdates.push({ ...options })
  }

  goToDiff(target: 'next' | 'previous'): void {
    this.navigations.push(target)
  }

  focusModified(): void {}
  layout(): void {}

  dispose(): void {
    this.disposed = true
    for (const subscription of this.watching) subscription.dispose()
    this.watching = []
    this.listeners.clear()
  }
}

export function createMonacoDouble(): MonacoDouble {
  const created = new Map<string, FakeModel>()
  const live = new Map<string, FakeModel>()
  const scratch: FakeModel[] = []
  const diffEditors: FakeDiffEditor[] = []
  let theme: string | null = null
  const definedThemes = new Map<string, EditorThemeDefinition>()
  const languageExtensions = new Map<string, string[]>()
  const registeredLanguages = new Map<string, { extensions: string[]; rules: EditorLanguageRule[] }>()
  const editors: FakeEditor[] = []

  const api: MonacoApi = {
    editor: {
      defineTheme(name, definition) {
        definedThemes.set(name, definition)
      },
      setTheme(name) {
        theme = name
      },
      createScratchModel(value, language) {
        // Shaped like Monaco's own in-memory uris, which no file path can produce.
        const model = new FakeModel(value, language, { toString: () => `inmemory://model/${scratch.length + 1}` })
        scratch.push(model)
        return model
      },
      createDiffEditor(container, options) {
        const diff = new FakeDiffEditor(container, options)
        diffEditors.push(diff)
        return diff
      },
      createModel(value, language, path) {
        if (live.has(path)) {
          // Monaco throws on a duplicate uri. Reproduced so a test would catch a
          // registry that creates two models for one file.
          throw new Error(`a model already exists for ${path}`)
        }
        const model = new FakeModel(value, language, new FakeUri(path))
        created.set(path, model)
        live.set(path, model)
        const originalDispose = model.dispose.bind(model)
        model.dispose = () => {
          live.delete(path)
          originalDispose()
        }
        return model
      },
      getModel(path) {
        return live.get(path) ?? null
      },
      create(container, options) {
        const editor = new FakeEditor(container, options)
        editors.push(editor)
        return editor
      },
    },
    languages: {
      register(definition) {
        languageExtensions.set(definition.id, [...definition.extensions])
      },
      setMonarchTokensProvider(id, rules) {
        registeredLanguages.set(id, {
          extensions: [...(languageExtensions.get(id) ?? [])],
          rules: rules.map((rule) => ({ ...rule })),
        })
        return { dispose: () => registeredLanguages.delete(id) }
      },
    },
  }

  return {
    api,
    created,
    live,
    scratch,
    diffEditors,
    get theme() {
      return theme
    },
    definedThemes,
    registeredLanguages,
    editors,
    lastEditor() {
      const editor = editors[editors.length - 1]
      if (!editor) throw new Error('no editor was created')
      return editor
    },
    model(path) {
      const key = canonicalPath(path)
      const model = created.get(key)
      if (!model) {
        throw new Error(
          `no model was created for ${key}; created: ${[...created.keys()].join(', ') || 'none'}`,
        )
      }
      return model
    },
  }
}

/** A `loadMonaco`-shaped loader over the double. */
export function doubleLoader(double: MonacoDouble) {
  return () => Promise.resolve({ api: double.api, theme: 'test-theme' })
}
