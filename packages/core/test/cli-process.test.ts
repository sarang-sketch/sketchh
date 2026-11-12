// W10 invariant 6, over the REAL stdio CLI (packages/core/dist/cli.js).
//
// Two things the in-process ProtocolServer test cannot prove, because they are
// properties of the PROCESS, not the dispatch loop:
//
//   1. The engine's own unhandled rejection is LOGGED and does NOT kill the engine
//      silently. On the Node versions that run the sidecar an unhandled rejection
//      terminates the process by default, so this must be proven against a real
//      spawned process, not a mocked one. A test-only switch (SKETCH_TEST_UNHANDLED=1,
//      read only in cli.ts) schedules one rejected promise after start-up; the test
//      asserts the "sketch: unhandled rejection:" line reaches stderr AND the process
//      is still alive and still answers a ping.
//   2. Crafted frames over the real pipe — malformed JSON, an unknown method, an
//      oversized line — each get exactly one error frame and the process survives.
//
// The build must be current: these spawn `dist/cli.js`, so `npm run build -w
// @sketch/core` runs before them (the suite's build step / the doc's command list).

import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js')

interface Frame {
  id?: unknown
  ok?: boolean
  error?: string
  code?: string
  result?: unknown
  kind?: string
}

/** One spawned engine process, with helpers to send frames and read what comes back. */
class Engine {
  readonly child: ChildProcessWithoutNullStreams
  readonly frames: Frame[] = []
  stderr = ''
  private buf = ''
  private seq = 0
  private readonly waiters = new Map<string, (f: Frame) => void>()

  constructor(home: string, extraEnv: Record<string, string> = {}) {
    this.child = spawn(process.execPath, [CLI], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // An isolated HOME/USERPROFILE so the engine never reads the owner's ~/.sketch.
      env: { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv },
    }) as ChildProcessWithoutNullStreams
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      this.buf += chunk
      let nl = this.buf.indexOf('\n')
      while (nl >= 0) {
        const line = this.buf.slice(0, nl)
        this.buf = this.buf.slice(nl + 1)
        if (line.trim() !== '') this.onLine(line)
        nl = this.buf.indexOf('\n')
      }
    })
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk
    })
  }

  private onLine(line: string): void {
    let frame: Frame
    try {
      frame = JSON.parse(line) as Frame
    } catch {
      return
    }
    this.frames.push(frame)
    if (typeof frame.ok === 'boolean' && (typeof frame.id === 'string' || typeof frame.id === 'number')) {
      const key = String(frame.id)
      this.waiters.get(key)?.(frame)
      this.waiters.delete(key)
    }
  }

  /** Send a well-formed request and resolve with its response frame. */
  call(method: string, params: Record<string, unknown> = {}): Promise<Frame> {
    const id = `req-${++this.seq}`
    return new Promise<Frame>((resolve_) => {
      this.waiters.set(id, resolve_)
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  /** Send a raw line verbatim (for crafted / malformed input). */
  writeRaw(line: string): void {
    this.child.stdin.write(`${line}\n`)
  }

  /** The next response/error frame that carries this id, waited for. */
  awaitFrame(id: string, ms = 4000): Promise<Frame> {
    const existing = this.frames.find((f) => String(f.id) === id && typeof f.ok === 'boolean')
    if (existing) return Promise.resolve(existing)
    return new Promise<Frame>((resolve_, reject) => {
      const timer = setTimeout(() => reject(new Error(`no frame for ${id} within ${ms}ms`)), ms)
      this.waiters.set(id, (f) => {
        clearTimeout(timer)
        resolve_(f)
      })
    })
  }

  get alive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null
  }

  stop(): Promise<void> {
    return new Promise<void>((resolve_) => {
      this.child.once('close', () => resolve_())
      this.child.stdin.end()
      this.child.kill()
    })
  }
}

const homes: string[] = []
const engines: Engine[] = []
async function makeHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-cli-proc-'))
  homes.push(dir)
  return dir
}

afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop()
  for (const dir of homes.splice(0)) await rm(dir, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('the engine survives its own unhandled rejection (invariant 6)', () => {
  it('logs the rejection to stderr and keeps serving', async () => {
    const home = await makeHome()
    const eng = new Engine(home, { SKETCH_TEST_UNHANDLED: '1' })
    engines.push(eng)

    // A first ping proves it booted.
    const first = await eng.call('ping')
    expect(first.ok).toBe(true)

    // The injected rejection fires ~50ms after start-up; give it room, then check.
    await sleep(400)
    expect(eng.stderr).toContain('sketch: unhandled rejection:')
    expect(eng.stderr).toContain('test-only injected unhandled rejection')

    // The engine is still alive and still answering AFTER the rejection.
    expect(eng.alive).toBe(true)
    const after = await eng.call('ping')
    expect(after.ok).toBe(true)
  })
})

describe('crafted frames over the real stdio pipe each get one error, process survives (invariant 6)', () => {
  it('answers malformed JSON, an unknown method, and an oversized line, then still pings', async () => {
    const home = await makeHome()
    const eng = new Engine(home)
    engines.push(eng)

    // Boot.
    expect((await eng.call('ping')).ok).toBe(true)
    const framesBefore = eng.frames.length

    // 1) Malformed JSON → one malformed_json error, id null.
    eng.writeRaw('{ this is not json ]')
    // 2) Unknown method → one unknown_method error, echoing the id.
    const unknownId = 'craft-unknown'
    eng.writeRaw(JSON.stringify({ id: unknownId, method: 'no-such-method', params: {} }))
    const unknownFrame = await eng.awaitFrame(unknownId)
    expect(unknownFrame).toMatchObject({ id: unknownId, ok: false, code: 'unknown_method' })

    // 3) Oversized line (2 MB params) → the engine does not crash; it answers (an error
    //    for an unknown method is fine — the point is one frame and a live process).
    const oversizedId = 'craft-oversized'
    const blob = 'x'.repeat(2_000_000)
    eng.writeRaw(JSON.stringify({ id: oversizedId, method: 'no-such-method', params: { blob } }))
    const oversizedFrame = await eng.awaitFrame(oversizedId)
    expect(oversizedFrame).toMatchObject({ id: oversizedId, ok: false })

    // The malformed line produced exactly one error frame with a null id.
    const malformed = eng.frames.filter((f) => f.ok === false && f.code === 'malformed_json')
    expect(malformed.length).toBe(1)
    expect(malformed[0]!.id).toBeNull()

    // New frames appeared (no silent swallow) and the process is still alive.
    expect(eng.frames.length).toBeGreaterThan(framesBefore)
    expect(eng.alive).toBe(true)

    // And it still answers a well-formed request after all the hostile input.
    expect((await eng.call('ping')).ok).toBe(true)
  })
})
