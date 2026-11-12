// The integrated terminal, driven through real shells and real processes.
//
// What these pin, in user terms:
//   * Output appears WHILE a command runs, not only after it exits.
//   * Stop ends a command that would otherwise run forever.
//   * A prompt can be answered: text typed while a program runs reaches its stdin.
//   * `npm install && npm run dev` works on Windows PowerShell 5.1, which has no `&&`.
//   * `cd` moves the terminal, and it cannot leave the open project — not with `..`, not
//     through a junction or symlink.
//   * Nothing runs without consent, and the RPC methods say so in a sentence.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  TerminalHost,
  TerminalRefusal,
  parseCd,
  splitChain,
  wrapPowerShell,
} from '../src/tools/terminal.js'
import { METHODS } from '../src/rpc/methods.js'
import { createMethodContext } from '../src/rpc/server.js'

const roots: string[] = []
const hosts: TerminalHost[] = []
afterEach(async () => {
  while (hosts.length > 0) hosts.pop()!.disposeAll()
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true }).catch(() => {})
})

async function tempRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sketch-term-')))
  roots.push(root)
  return root
}

function host(): TerminalHost {
  const created = new TerminalHost()
  hosts.push(created)
  return created
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until `done` holds or the deadline passes; returns the last read. */
async function pollUntil(
  terminal: TerminalHost,
  id: string,
  done: (out: string, running: boolean) => boolean,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs
  let out = ''
  let since = 0
  for (;;) {
    const read = terminal.read(id, since)
    since = read.next
    out += read.chunks.map((chunk) => chunk.text).join('')
    if (done(out, read.running) || Date.now() > deadline) return { out, read }
    await sleep(40)
  }
}

describe('the terminal host', () => {
  it('refuses to run anything without consent', async () => {
    const root = await tempRoot()
    expect(() => host().start({ root, line: 'node -v', confirmed: false })).toThrow(TerminalRefusal)
  })

  it('streams output while the command is still running, then reports its exit code', async () => {
    const root = await tempRoot()
    const terminal = host()
    const started = terminal.start({
      root,
      line: `node -e "console.log('one'); setTimeout(() => { console.log('two'); process.exit(3) }, 1500)"`,
      confirmed: true,
    })
    expect(started.kind).toBe('run')
    if (started.kind !== 'run') return

    const early = await pollUntil(terminal, started.id, (out) => out.includes('one'))
    expect(early.out).toContain('one')
    expect(early.out).not.toContain('two')
    expect(early.read.running).toBe(true)

    const final = await pollUntil(terminal, started.id, (_out, running) => !running)
    expect(early.out + final.out).toContain('two')
    expect(final.read.running).toBe(false)
    expect(final.read.exitCode).toBe(3)
  }, 30_000)

  it('stops a command that would run forever', async () => {
    const root = await tempRoot()
    const terminal = host()
    const started = terminal.start({
      root,
      line: `node -e "console.log('serving'); setInterval(() => {}, 1000)"`,
      confirmed: true,
    })
    if (started.kind !== 'run') throw new Error('expected a run')
    await pollUntil(terminal, started.id, (out) => out.includes('serving'))
    expect(terminal.read(started.id).running).toBe(true)

    expect(terminal.kill(started.id)).toEqual({ stopped: true })
    const final = await pollUntil(terminal, started.id, (_out, running) => !running, 10_000)
    expect(final.read.running).toBe(false)
    expect(terminal.kill(started.id)).toEqual({ stopped: false })
  }, 30_000)

  it('delivers typed input to the running program', async () => {
    const root = await tempRoot()
    const terminal = host()
    const started = terminal.start({
      root,
      line: `node -e "console.log('name?'); process.stdin.once('data', d => { console.log('hello ' + d.toString().trim()); process.exit(0) })"`,
      confirmed: true,
    })
    if (started.kind !== 'run') throw new Error('expected a run')
    await pollUntil(terminal, started.id, (out) => out.includes('name?'))
    terminal.write(started.id, 'sketch\n')
    const final = await pollUntil(terminal, started.id, (_out, running) => !running)
    expect(final.out).toContain('hello sketch')
    expect(final.read.exitCode).toBe(0)
  }, 30_000)

  it('runs && and || chains with the semantics every shell has', async () => {
    const root = await tempRoot()
    const terminal = host()
    const run = async (line: string) => {
      const started = terminal.start({ root, line, confirmed: true })
      if (started.kind !== 'run') throw new Error('expected a run')
      return pollUntil(terminal, started.id, (_out, running) => !running)
    }
    const both = await run(`node -e "console.log('first')" && node -e "console.log('second')"`)
    expect(both.out).toContain('first')
    expect(both.out).toContain('second')
    expect(both.read.exitCode).toBe(0)

    const stopped = await run(`node -e "process.exit(2)" && node -e "console.log('never')"`)
    expect(stopped.out).not.toContain('never')
    expect(stopped.read.exitCode).toBe(2)

    const rescued = await run(`node -e "process.exit(1)" || node -e "console.log('rescued')"`)
    expect(rescued.out).toContain('rescued')
    expect(rescued.read.exitCode).toBe(0)
  }, 60_000)

  it('keeps stderr apart from stdout', async () => {
    const root = await tempRoot()
    const terminal = host()
    const started = terminal.start({ root, line: `node -e "console.error('oops')"`, confirmed: true })
    if (started.kind !== 'run') throw new Error('expected a run')
    await pollUntil(terminal, started.id, (_out, running) => !running)
    const read = terminal.read(started.id)
    expect(read.chunks.filter((c) => c.stream === 'stderr').map((c) => c.text).join('')).toContain('oops')
  }, 30_000)

  it('moves with cd, and never out of the project', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'src', 'lib'), { recursive: true })
    const terminal = host()

    expect(terminal.start({ root, line: 'cd src', confirmed: true })).toEqual({ kind: 'cd', cwd: join(root, 'src') })
    expect(terminal.start({ root, cwd: join(root, 'src'), line: 'cd lib', confirmed: true })).toEqual({
      kind: 'cd',
      cwd: join(root, 'src', 'lib'),
    })
    expect(terminal.start({ root, cwd: join(root, 'src'), line: 'cd', confirmed: true })).toEqual({ kind: 'cd', cwd: root })
    expect(terminal.start({ root, cwd: join(root, 'src'), line: 'cd..', confirmed: true })).toEqual({ kind: 'cd', cwd: root })
    expect(() => terminal.start({ root, line: 'cd ..', confirmed: true })).toThrow(/outside the open project/)
    expect(() => terminal.start({ root, line: 'cd missing', confirmed: true })).toThrow(/no such folder/)

    // The process really runs where the terminal is.
    const started = terminal.start({ root, cwd: join(root, 'src'), line: `node -e "console.log(process.cwd())"`, confirmed: true })
    if (started.kind !== 'run') throw new Error('expected a run')
    const final = await pollUntil(terminal, started.id, (_out, running) => !running)
    expect(final.out.trim()).toBe(join(root, 'src'))
  }, 30_000)

  it('refuses a cd through a link that points outside the project', async () => {
    const root = await tempRoot()
    const outside = await tempRoot()
    const link = join(root, 'escape')
    // A junction needs no privilege on Windows; a plain symlink everywhere else.
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => host().start({ root, line: 'cd escape', confirmed: true })).toThrow(/outside the open project/)
    expect(() => host().start({ root, cwd: link, line: 'node -v', confirmed: true })).toThrow(/not usable/)
  })
})

describe('terminal line handling', () => {
  it('recognises cd and leaves compound lines to the shell', () => {
    expect(parseCd('cd')).toBeNull()
    expect(parseCd('cd ~')).toBeNull()
    expect(parseCd('cd src')).toBe('src')
    expect(parseCd('cd "my folder"')).toBe('my folder')
    expect(parseCd('cd /d D:\\work')).toBe('D:\\work')
    expect(parseCd('Set-Location -Path lib')).toBe('lib')
    expect(parseCd('cd..')).toBe('..')
    expect(parseCd('cd src && npm test')).toBeUndefined()
    expect(parseCd('npm test')).toBeUndefined()
    expect(parseCd('cdk deploy')).toBeUndefined()
  })

  it('splits chains outside quotes only', () => {
    expect(splitChain('npm test')).toBeNull()
    expect(splitChain('echo "a && b"')).toBeNull()
    expect(splitChain("echo 'x || y'")).toBeNull()
    expect(splitChain('npm i && npm run dev')).toEqual([
      { op: null, text: 'npm i' },
      { op: '&&', text: 'npm run dev' },
    ])
    expect(splitChain('a || b && c')?.map((p) => p.op)).toEqual([null, '||', '&&'])
    expect(splitChain('a &&')).toBeNull()
  })

  it('keeps a trailing comment from swallowing the exit-code bookkeeping', () => {
    const script = wrapPowerShell('npm test && echo done # note')
    const lines = script.split('\n')
    // The comment sits alone on its line; the closing brace is on the next one.
    const at = lines.indexOf('echo done # note')
    expect(at).toBeGreaterThan(0)
    expect(lines[at + 1]).toBe('$__sketchOk = $?')
    expect(lines[at + 2]).toBe('}')
  })
})

describe('the terminal over the method table', () => {
  const ctx = () =>
    createMethodContext('t-1', {
      writeFrame: () => {},
      writeErr: () => {},
      env: process.env,
      cwd: () => process.cwd(),
      secrets: new Set(),
    })

  it('runs, reads and finishes a command through term-start and term-read', async () => {
    const root = await tempRoot()
    const started = (await METHODS['term-start']!(
      { root, line: `node -e "console.log('via rpc')"`, confirmed: true },
      ctx(),
    )) as { kind: string; id: string }
    expect(started.kind).toBe('run')

    let out = ''
    let since = 0
    let running = true
    const deadline = Date.now() + 20_000
    while (running && Date.now() < deadline) {
      const read = (await METHODS['term-read']!({ id: started.id, since }, ctx())) as {
        chunks: Array<{ text: string }>
        next: number
        running: boolean
        exitCode: number | null
      }
      out += read.chunks.map((c) => c.text).join('')
      since = read.next
      running = read.running
      if (running) await sleep(40)
    }
    expect(out).toContain('via rpc')
    expect(running).toBe(false)
  }, 30_000)

  it('answers a refusal as invalid params, in words', async () => {
    const root = await tempRoot()
    await expect(METHODS['term-start']!({ root, line: 'node -v' }, ctx())).rejects.toThrow(/only when the user asks/)
    await expect(METHODS['term-read']!({ id: 'not-an-id' }, ctx())).rejects.toThrow(/not a terminal command id/)
    await expect(METHODS['term-kill']!({ id: 'term-abc-999' }, ctx())).rejects.toThrow(/No terminal command/)
  })
})
