// Background processes for the agent, against real child processes. In user terms:
//   * "npm run dev" no longer hangs the agent: run_command with background: true
//     returns as soon as the server prints its URL, with an id.
//   * The agent can read what the server printed since, wait for new output in one
//     call, and stop it — the server and everything it started.
//   * Background commands go through the same approval as any other command.
//   * Nothing outlives the run: stopAll ends every process the run started.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BackgroundProcesses, READY_PATTERN } from '../src/tools/background.js'
import { backgroundToolDescriptors, commandToolDescriptor } from '../src/tools/command.js'

const SERVER = `
setTimeout(() => console.log('  VITE v5.4.0  ready in 120 ms\\n\\n  ➜  Local:   http://localhost:5173/'), 200)
let n = 0
setInterval(() => console.log('request ' + (++n)), 300)
`
const SILENT = `setInterval(() => {}, 1000)`
const CRASH = `console.error('Error: listen EADDRINUSE: address already in use :::3000'); process.exit(1)`

const roots: string[] = []
const registries: BackgroundProcesses[] = []

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sketch-bg-'))
  roots.push(root)
  await writeFile(join(root, 'server.js'), SERVER)
  await writeFile(join(root, 'silent.js'), SILENT)
  await writeFile(join(root, 'crash.js'), CRASH)
  return root
}

function registry(): BackgroundProcesses {
  const r = new BackgroundProcesses()
  registries.push(r)
  return r
}

const node = process.execPath

afterEach(async () => {
  for (const r of registries.splice(0)) await r.stopAll()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }).catch(() => {})
})

describe('the readiness signal', () => {
  it('recognises what dev servers print when they are up', () => {
    for (const line of [
      'Local:   http://localhost:5173/',
      'ready - started server on 0.0.0.0:3000, url: http://localhost:3000',
      'Server running at http://127.0.0.1:8000/',
      'Listening on port 4000',
      'webpack compiled successfully',
      'Watching for file changes with StatReloader',
    ]) {
      expect(READY_PATTERN.test(line), line).toBe(true)
    }
    expect(READY_PATTERN.test('npm WARN deprecated left-pad')).toBe(false)
  })
})

describe('background processes', () => {
  it('returns as soon as a server prints its URL, then reads, waits and stops it', async () => {
    const root = await project()
    const processes = registry()
    const began = Date.now()
    const started = await processes.start({ argv: [node, 'server.js'], cwd: root, env: process.env, display: 'node server.js' })
    expect(started.state).toBe('running')
    if (started.state !== 'running') return
    expect(started.url).toBe('http://localhost:5173')
    expect(Date.now() - began).toBeLessThan(5_000)

    await processes.waitForOutput(started.id, 5_000)
    const later = processes.read(started.id)
    expect(later.running).toBe(true)
    expect(later.output).toMatch(/request \d+/)
    // A second read only returns what is new.
    expect(processes.read(started.id).output).not.toContain(later.output)

    const stopped = await processes.stop(started.id)
    expect(stopped.stopped).toBe(true)
    expect(processes.read(started.id).running).toBe(false)
  })

  it('reports a server that crashes at start as exited, with its error', async () => {
    const root = await project()
    const started = await registry().start({ argv: [node, 'crash.js'], cwd: root, env: process.env, display: 'node crash.js' })
    expect(started).toMatchObject({ state: 'exited', exitCode: 1 })
    expect(started.output).toContain('EADDRINUSE')
  })

  it('gives up waiting for readiness after wait_ms and leaves it running', async () => {
    const root = await project()
    const processes = registry()
    const started = await processes.start({ argv: [node, 'silent.js'], cwd: root, env: process.env, display: 'node silent.js', waitMs: 400 })
    expect(started).toMatchObject({ state: 'running', ready: false, url: null })
    await processes.stopAll()
    expect(processes.read(started.id).running).toBe(false)
  })
})

describe('run_command with background: true', () => {
  const context = (root: string) => ({ root, runId: 'r-1' }) as never

  it('starts a server, then process_output and stop_process work on it', async () => {
    const root = await project()
    const processes = registry()
    const tool = commandToolDescriptor({ mode: 'auto', background: processes })
    const [output, stop] = backgroundToolDescriptors(processes)
    const started = await tool.run({ command: [node, 'server.js'], background: true }, context(root))
    expect(started.ok).toBe(true)
    expect(started.output).toContain('BACKGROUND PROCESS bg-1')
    expect(started.output).toContain('http://localhost:5173')

    const read = await output!.run({ id: 'bg-1', wait_ms: 3_000 }, context(root))
    expect(read.output).toMatch(/still running/)
    expect(read.output).toMatch(/request \d+/)

    const ended = await stop!.run({ id: 'bg-1' }, context(root))
    expect(ended.output).toContain('stopped')
    expect((await output!.run({ id: 'bg-1' }, context(root))).output).toMatch(/EXITED/)
    // An id that is not this run's is refused, not guessed at.
    expect((await output!.run({ id: 'bg-99' }, context(root))).ok).toBe(false)
    expect((await output!.run({ id: '../etc' }, context(root))).ok).toBe(false)
  })

  it('asks the user first in ask mode, exactly as for any other command', async () => {
    const root = await project()
    const processes = registry()
    const tool = commandToolDescriptor({ mode: 'ask', background: processes })
    const result = await tool.run({ command: [node, 'server.js'], background: true }, context(root))
    expect(result.ok).toBe(false)
    expect(result.output).toContain('COMMAND NOT RUN')
    expect(processes.running()).toBe(0)
  })

  it('is refused where no run owns background processes', async () => {
    const root = await project()
    const tool = commandToolDescriptor({ mode: 'auto' })
    const result = await tool.run({ command: [node, 'server.js'], background: true }, context(root))
    expect(result.ok).toBe(false)
    expect(result.output).toContain('not available')
    expect(tool.description).toContain('Never start dev servers')
    expect(commandToolDescriptor({ mode: 'auto', background: registry() }).description).toContain('"background": true')
  })
})
