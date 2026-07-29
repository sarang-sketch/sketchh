// The `Map<path, model>` of Requirement 15.1, and the only bridge between Monaco's
// text buffers and the one state owner.
//
// ---------------------------------------------------------------------------
// HOW THERE IS STILL ONLY ONE CACHE (Requirement 15.2, trap T11)
// ---------------------------------------------------------------------------
// A Monaco model necessarily holds text — that is what a text editor is. So the
// question is not "can two objects hold the same string" (they must) but "can they
// ever disagree about it". They cannot, because every write to either side goes
// through exactly one of two functions in this file, and they run in opposite
// directions:
//
//   state → model     `sync(path, content)`  the ONLY caller of `model.setValue`
//   model → state     the `onUserEdit(path, content)` callback, fired from the ONE
//                     `onDidChangeContent` subscription this registry owns
//
// `AppState.files[path].content` is AUTHORITATIVE. The model is a projection of it:
//   * a model is created from state's content and never from anything else;
//   * a keystroke updates the model first (Monaco owns the caret, undo stack and
//     rendering) and is pushed into state in the same tick, so state converges
//     within one React commit;
//   * anything that is NOT a keystroke — a disk read, an engine write, a conflict
//     reload — is applied to STATE first and reaches the model only through `sync`;
//   * saving reads from state, never from the model.
//
// The subtle bug this file exists to prevent: `setValue` fires
// `onDidChangeContent` just like typing does. Without the `syncing` guard below, a
// reload after an engine write would be reported back as a user edit, re-marking a
// freshly reconciled file dirty forever. So `sync` suppresses the callback for the
// duration of its own write, and only for its own write.
//
// Nothing here reaches for `monaco` directly; the api arrives as a parameter, which
// is what lets this logic be tested for real instead of mocked.
//
// Validates: Requirements 15.1, 15.2, 15.3

import type { MonacoApi, TextModel } from './monacoApi'
import { canonicalPath, languageForPath } from './paths'

export type UserEditListener = (path: string, content: string) => void

interface Entry {
  model: TextModel
  subscription: { dispose(): void }
}

export class ModelRegistry {
  /** Keyed by `canonicalPath`. One entry per open file, never more. */
  private readonly entries = new Map<string, Entry>()

  /** True only while `sync` is writing, so its own change event is ignored. */
  private syncing = false

  constructor(
    private readonly monaco: MonacoApi,
    private readonly onUserEdit: UserEditListener,
  ) {}

  /**
   * The model for `path`, created from `content` if it does not exist yet.
   *
   * An EXISTING model is returned untouched: its text is reconciled by `sync`, and
   * overwriting it here would silently discard whatever the user has typed since
   * the last render. Re-opening an already-open file is therefore free of side
   * effects, which is what makes clicking a tab twice harmless.
   */
  acquire(path: string, content: string): TextModel {
    const key = canonicalPath(path)
    const existing = this.entries.get(key)
    if (existing) return existing.model

    // Monaco keeps its own registry keyed by the path's `file:` URI and throws on a
    // duplicate. A leftover from a hot reload or a previously mismanaged dispose is
    // adopted rather than fought with.
    const model =
      this.monaco.editor.getModel(key) ??
      this.monaco.editor.createModel(content, languageForPath(key), key)

    const subscription = model.onDidChangeContent(() => {
      if (this.syncing) return
      this.onUserEdit(key, model.getValue())
    })

    this.entries.set(key, { model, subscription })
    return model
  }

  get(path: string): TextModel | null {
    return this.entries.get(canonicalPath(path))?.model ?? null
  }

  has(path: string): boolean {
    return this.entries.has(canonicalPath(path))
  }

  /** Canonical paths currently backed by a model. */
  keys(): string[] {
    return [...this.entries.keys()]
  }

  get size(): number {
    return this.entries.size
  }

  /**
   * Push authoritative content into the model. The ONLY `setValue` in the app.
   * Returns true when it actually wrote — a no-op when the model already agrees,
   * which is the common case and keeps the caret and undo stack intact while
   * typing.
   */
  sync(path: string, content: string): boolean {
    const entry = this.entries.get(canonicalPath(path))
    if (!entry || entry.model.isDisposed()) return false
    if (entry.model.getValue() === content) return false

    this.syncing = true
    try {
      entry.model.setValue(content)
    } finally {
      this.syncing = false
    }
    return true
  }

  /**
   * Drop the model for `path`. Both the listener and the model are disposed: a
   * model left behind keeps its whole text buffer and tokenization alive, so
   * leaking one per file opened is a real leak in a long session, not a tidiness
   * concern.
   */
  dispose(path: string): boolean {
    const key = canonicalPath(path)
    const entry = this.entries.get(key)
    if (!entry) return false
    entry.subscription.dispose()
    if (!entry.model.isDisposed()) entry.model.dispose()
    this.entries.delete(key)
    return true
  }

  /**
   * Make the map match `paths` exactly, disposing anything else. Called from a
   * render effect against `state.openFiles`, so the tab list is what decides which
   * models exist — there is no separate close bookkeeping to forget.
   */
  pruneTo(paths: readonly string[]): string[] {
    const keep = new Set(paths.map(canonicalPath))
    const removed: string[] = []
    for (const key of [...this.entries.keys()]) {
      if (keep.has(key)) continue
      this.dispose(key)
      removed.push(key)
    }
    return removed
  }

  disposeAll(): void {
    this.pruneTo([])
  }
}
