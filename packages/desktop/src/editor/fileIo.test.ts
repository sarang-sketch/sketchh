// Reading and writing for the editor: the outcomes, and what a user is told.
//
// The point of these tests is that no failure is silent and none of them produces an
// empty buffer that looks like an empty file. Containment stays in Rust; what is
// checked here is that its refusal reaches the surface naming the file and the reason
// (Requirements 15.4, 15.6, 27.3).
//
// Validates: Requirements 15.4, 15.6

import { describe, it, expect } from 'vitest'
import { createFakeDisk } from './fakeDisk'
import {
  byteLength,
  describeFileFailure,
  looksBinary,
  readForEditor,
  writeFromEditor,
  MAX_OPEN_BYTES,
} from './fileIo'

const ROOT = 'C:/app'
const A = 'C:/app/src/App.tsx'

describe('readForEditor', () => {
  it('returns the bytes on disk and records the root it was given', async () => {
    const disk = createFakeDisk({ [A]: 'const a = 1' })

    expect(await readForEditor(disk.io, ROOT, A)).toEqual({ ok: true, content: 'const a = 1' })
    // Every call carries the open project. Rust requires it and contains against it.
    expect(disk.reads).toEqual([{ root: ROOT, path: A }])
  })

  it('reports a containment refusal as a refusal, naming the file', async () => {
    const disk = createFakeDisk({ 'C:/elsewhere/id_rsa': 'secret' })

    const outcome = await readForEditor(disk.io, ROOT, 'C:/elsewhere/id_rsa')
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.message).toContain('id_rsa')
    expect(outcome.ok === false && outcome.message).toContain('outside the folder open in Sketch')
  })

  it('says a missing file is missing instead of opening an empty buffer', async () => {
    const outcome = await readForEditor(createFakeDisk().io, ROOT, A)
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.message).toContain('no longer exists on disk')
  })

  it('refuses a file above the size limit, with the size in the message', async () => {
    const big = 'x'.repeat(MAX_OPEN_BYTES + 1)
    const outcome = await readForEditor(createFakeDisk({ [A]: big }).io, ROOT, A)

    expect(outcome.ok).toBe(false)
    // 2,000,000 bytes is 1.9 MiB, and the message says so for both numbers.
    expect(outcome.ok === false && outcome.message).toBe(
      'Cannot open App.tsx: it is 1.9 MB, above the 1.9 MB editor limit.',
    )
  })

  it('refuses a binary file rather than showing mangled text', async () => {
    const outcome = await readForEditor(createFakeDisk({ [A]: 'MZ\u0000\u0000' }).io, ROOT, A)
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.message).toContain('binary')
  })
})

describe('writeFromEditor', () => {
  it('writes through the seam with the project root attached', async () => {
    const disk = createFakeDisk({ [A]: 'old' })

    expect(await writeFromEditor(disk.io, ROOT, A, 'new')).toEqual({ ok: true })
    expect(disk.writes).toEqual([{ root: ROOT, path: A, content: 'new' }])
    expect(disk.read(A)).toBe('new')
  })

  it('turns a refused write into a message and leaves disk untouched', async () => {
    const disk = createFakeDisk()

    const outcome = await writeFromEditor(disk.io, ROOT, 'C:/elsewhere/planted.txt', 'x')
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.message).toContain('outside the folder open in Sketch')
    expect(disk.writes).toEqual([])
    expect(disk.files.size).toBe(0)
  })
})

describe('describeFileFailure', () => {
  it('names the operation and the file for each distinct failure', () => {
    // A LEGACY-wording refusal (pre-W2) is still recognised via ipc/policyMessages.ts,
    // so a message produced by a not-yet-rebuilt engine does not fall through to the
    // raw-string branch. This is the deliberate legacy-phrase coverage.
    expect(describeFileFailure('open', A, new Error("file 'x' escapes the project root C:/app")))
      .toContain('outside the folder open in Sketch')
    // And the CURRENT Rust containment wording is recognised too.
    expect(
      describeFileFailure(
        'open',
        A,
        new Error('This file is outside the folder you have open in Sketch, so it cannot be reached from here:'),
      ),
    ).toContain('outside the folder open in Sketch')
    expect(
      describeFileFailure('save', A, new Error('no project root is open, so no path may be used')),
    ).toContain('no project folder is open')
    expect(describeFileFailure('open', A, new Error('path is not a file'))).toContain(
      'a directory, not a file',
    )
    expect(describeFileFailure('open', A, new Error('stream did not contain valid UTF-8'))).toContain(
      'not UTF-8 text',
    )
    expect(describeFileFailure('save', A, new Error('Access is denied (os error 5)'))).toContain(
      'permission denied',
    )
    // An unrecognized failure keeps the backend's own words rather than guessing.
    expect(describeFileFailure('save', A, new Error('disk full'))).toBe(
      'Cannot save App.tsx: disk full',
    )
  })
})

describe('byteLength and looksBinary', () => {
  it('counts UTF-8 bytes, not characters', () => {
    expect(byteLength('abc')).toBe(3)
    expect(byteLength('é€')).toBe(5)
  })

  it('treats a NUL byte as binary and nothing else', () => {
    expect(looksBinary('plain text')).toBe(false)
    expect(looksBinary('MZ\u0000')).toBe(true)
  })
})
