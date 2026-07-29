// The model map and the one-cache guarantee at its own level.
//
// `ModelRegistry` is exercised for real here; only Monaco's text buffer is a double
// (see ./monacoDouble.ts), and that double fires change events on `setValue` exactly
// as Monaco does, which is the behaviour these tests depend on.
//
// Validates: Requirements 15.1, 15.2, 15.3

import { describe, it, expect, beforeEach } from 'vitest'
import { createMonacoDouble, type MonacoDouble } from './monacoDouble'
import { ModelRegistry } from './models'

const A = 'C:/app/src/App.tsx'
const B = 'C:/app/src/styles.css'

let monaco: MonacoDouble
let edits: Array<{ path: string; content: string }>
let registry: ModelRegistry

beforeEach(() => {
  monaco = createMonacoDouble()
  edits = []
  registry = new ModelRegistry(monaco.api, (path, content) => edits.push({ path, content }))
})

describe('ModelRegistry — Map<path, model> keyed by absolute path', () => {
  it('creates one model per file and keys it by the canonical path', () => {
    registry.acquire(A, 'const a = 1')
    registry.acquire(B, 'body {}')

    expect(registry.keys()).toEqual([A, B])
    expect(registry.size).toBe(2)
    expect(monaco.live.size).toBe(2)
  })

  it('returns the same model for every spelling of the same path', () => {
    const first = registry.acquire('c:\\app\\src\\App.tsx', 'const a = 1')
    const second = registry.acquire('C:/app/src/./App.tsx', 'IGNORED')

    expect(second).toBe(first)
    expect(registry.size).toBe(1)
    // The second call must not overwrite the buffer: doing so would drop whatever
    // the user typed since it was opened.
    expect(first.getValue()).toBe('const a = 1')
  })

  it('maps a Windows path to a file: uri with the drive colon encoded', () => {
    const model = registry.acquire(A, '')
    expect(model.uri.toString()).toBe('file:///c%3A/app/src/App.tsx')
  })

  it('adopts a model Monaco already holds instead of creating a duplicate', () => {
    // A hot reload can leave a model behind. Monaco throws on a duplicate uri, so
    // the registry has to reuse it.
    const orphan = monaco.api.editor.createModel('left over', 'typescript', A)
    expect(registry.acquire(A, 'ignored')).toBe(orphan)
    expect(monaco.live.size).toBe(1)
  })
})

describe('ModelRegistry — the two directions of truth', () => {
  it('reports a keystroke to the state owner', () => {
    // `monaco.model(path)` is the same object the registry holds, typed as the fake
    // so its `typeText` helper is visible without casting a `TextModel`.
    expect(registry.acquire(A, 'const a = 1')).toBe(monaco.model(A))
    monaco.model(A).typeText('const a = 2')

    expect(edits).toEqual([{ path: A, content: 'const a = 2' }])
  })

  it('does NOT report its own sync as a user edit', () => {
    // Monaco fires the same change event for setValue as for typing. Without the
    // suppression guard, reconciling an engine write would mark the file dirty
    // forever — the bug this test exists to pin.
    registry.acquire(A, 'const a = 1')
    expect(registry.sync(A, 'from the engine')).toBe(true)

    expect(edits).toEqual([])
    expect(registry.get(A)!.getValue()).toBe('from the engine')
  })

  it('does not write the model when it already agrees', () => {
    registry.acquire(A, 'same')
    expect(registry.sync(A, 'same')).toBe(false)
    expect(monaco.model(A).setValueCount).toBe(0)
  })

  it('resumes reporting keystrokes after a sync', () => {
    registry.acquire(A, 'a')
    registry.sync(A, 'b')
    monaco.model(A).typeText('b!')
    expect(edits).toEqual([{ path: A, content: 'b!' }])
  })

  it('ignores a sync for a file it has no model for', () => {
    expect(registry.sync('C:/app/nope.ts', 'x')).toBe(false)
  })
})

describe('ModelRegistry — disposal', () => {
  it('disposes the model and its listener on close', () => {
    registry.acquire(A, 'x')
    expect(registry.dispose(A)).toBe(true)

    // Read from `created`, which keeps disposed models, so disposal is assertable.
    const model = monaco.model(A)
    expect(model.isDisposed()).toBe(true)
    expect(model.listenerCount).toBe(0)
    expect(registry.size).toBe(0)
    // Gone from Monaco's registry too, so the uri is free to be opened again.
    expect(monaco.live.size).toBe(0)
  })

  it('leaks nothing across an open/close cycle', () => {
    for (let i = 0; i < 5; i += 1) {
      registry.acquire(A, `pass ${i}`)
      registry.dispose(A)
    }
    expect(registry.size).toBe(0)
    expect(monaco.live.size).toBe(0)
  })

  it('prunes to exactly the given tab list and says what it dropped', () => {
    registry.acquire(A, 'a')
    registry.acquire(B, 'b')

    expect(registry.pruneTo([A])).toEqual([B])
    expect(registry.keys()).toEqual([A])
    expect(monaco.live.has(B)).toBe(false)
  })

  it('disposeAll empties the map', () => {
    registry.acquire(A, 'a')
    registry.acquire(B, 'b')
    registry.disposeAll()
    expect(registry.size).toBe(0)
    expect(monaco.live.size).toBe(0)
  })
})
