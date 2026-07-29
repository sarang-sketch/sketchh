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
import type {
  CodeEditor,
  CursorPosition,
  Disposable,
  ModelUri,
  MonacoApi,
  TextModel,
} from './monacoApi'

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
  readonly disposed: boolean
  /** Move the caret as Monaco would, so a test can prove the readout is real. */
  moveTo(lineNumber: number, column: number): void
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

  constructor(readonly container: HTMLElement) {}

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
  editors: FakeCodeEditor[]
  lastEditor(): FakeCodeEditor
  /**
   * The fake model for `path`, with the fake's own helpers visible. Throws rather
   * than returning null so a test that names the wrong path fails saying so.
   * Includes disposed models, which is what makes disposal assertable.
   */
  model(path: string): FakeTextModel
}

export function createMonacoDouble(): MonacoDouble {
  const created = new Map<string, FakeModel>()
  const live = new Map<string, FakeModel>()
  const editors: FakeEditor[] = []

  const api: MonacoApi = {
    editor: {
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
      create(container) {
        const editor = new FakeEditor(container)
        editors.push(editor)
        return editor
      },
    },
  }

  return {
    api,
    created,
    live,
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
