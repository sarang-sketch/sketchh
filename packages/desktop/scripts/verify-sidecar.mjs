// One-off check: does the artifact pair produced by build-sidecar.mjs actually
// speak the protocol? Spawns binaries/sketch-engine-<triple>[.exe] with
// resources/sketch-engine.mjs as its argument — the same argv the Tauri sidecar
// gets — and exercises ping, an unknown method, and a malformed line.
//
// This does NOT verify Tauri's own spawn path (that needs a Tauri build).

import { execSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(here, '..')
const triple =
  process.env.SKETCH_TARGET_TRIPLE ??
  /^host:\s*(\S+)$/m.exec(execSync('rustc -vV', { encoding: 'utf8' }))[1]
const exe = process.platform === 'win32' ? '.exe' : ''

const binary = join(desktopRoot, 'src-tauri', 'binaries', `sketch-engine-${triple}${exe}`)
const script = join(desktopRoot, 'src-tauri', 'resources', 'sketch-engine.mjs')

const child = spawn(binary, [script], { stdio: ['pipe', 'pipe', 'pipe'] })

let buffer = ''
const frames = []
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim() !== '') frames.push(JSON.parse(line))
    index = buffer.indexOf('\n')
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => process.stderr.write(`[sidecar stderr] ${chunk}`))

child.stdin.write(`${JSON.stringify({ id: 'a1', method: 'ping', params: {} })}\n`)
child.stdin.write(`${JSON.stringify({ id: 2, method: 'no-such-method', params: {} })}\n`)
child.stdin.write('{ not json\n')
child.stdin.end()

await new Promise((done) => child.on('close', done))

console.log(JSON.stringify(frames, null, 2))

const ping = frames.find((f) => f.id === 'a1')
const unknown = frames.find((f) => f.id === 2)
const malformed = frames.find((f) => f.id === null)

const checks = [
  ['ping responded ok', ping?.ok === true && typeof ping.result?.version === 'string'],
  ['unknown method refused, process survived', unknown?.ok === false],
  ['malformed line refused, process survived', malformed?.ok === false],
]

let failed = false
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`)
  if (!pass) failed = true
}
process.exitCode = failed ? 1 : 0
