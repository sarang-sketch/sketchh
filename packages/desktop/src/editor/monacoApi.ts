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
}

export interface CursorPosition {
  lineNumber: number
  column: number
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
    /** Monaco's existing model for `path`, or null. Adopted rather than duplicated. */
    getModel(path: string): TextModel | null
    /** A new model for `path`. Throws if Monaco already has one, as Monaco does. */
    createModel(value: string, language: string, path: string): TextModel
    create(container: HTMLElement, options: EditorCreateOptions): CodeEditor
  }
  languages: {
    /** Registers a real Monaco language id and the extensions Monaco associates with it. */
    register(definition: { id: string; extensions: string[] }): void
    /** Installs a host-supplied Monarch tokenizer for that language id. */
    setMonarchTokensProvider(id: string, rules: EditorLanguageRule[]): Disposable
  }
}
