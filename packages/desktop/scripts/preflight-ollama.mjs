// Direct production-sidecar preflight for a REAL local Ollama.
//
// This is intentionally not the Requirement 26.2 proof: it does not install the
// app, exercise UI review/apply, or capture process-level DNS/socket activity.
// It requires Ollama-specific identity/model endpoints and loopback, then checks
// sidecar -> index -> run against an explicitly named model. It never starts or
// substitutes a stub/fake provider.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(here, '..')
const repoRoot = resolve(desktopRoot, '..', '..')
const args = new Map()
for (let at = 2; at < process.argv.length; at += 2) {
  const key = process.argv[at]
  const value = process.argv[at + 1]
  if (!key?.startsWith('--') || value === undefined) {
    throw new Error('usage: preflight-ollama.mjs --model <exact-name> [--endpoint http://127.0.0.1:11434/v1]')
  }
  args.set(key, value)
}

const model = args.get('--model') ?? process.env.SKETCH_OLLAMA_MODEL
if (!model?.trim()) throw new Error('real-Ollama preflight requires --model or SKETCH_OLLAMA_MODEL')
const endpoint = new URL(args.get('--endpoint') ?? process.env.SKETCH_OLLAMA_ENDPOINT ?? 'http://127.0.0.1:11434/v1')

function assertLoopback(url) {
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  const loopback = host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
  if (!loopback) throw new Error(`refusing non-loopback Ollama endpoint: ${url.origin}`)
  if (url.protocol !== 'http:') throw new Error('local Ollama endpoint must use http:')
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Ollama endpoint must not contain credentials, a query, or a fragment')
  }
  if (!/^\/v1\/?$/.test(url.pathname)) {
    throw new Error('Ollama OpenAI-compatible endpoint path must be /v1')
  }
}

async function getJson(url, timeoutMs = 5_000) {
  let response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`real Ollama is unavailable at ${url.origin}: ${detail}; no stub or fake fallback is permitted`)
  }
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
  return response.json()
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

assertLoopback(endpoint)
const versionReply = await getJson(new URL('/api/version', endpoint.origin))
if (typeof versionReply?.version !== 'string' || versionReply.version.trim() === '') {
  throw new Error('listener did not answer Ollama /api/version with a version; stubs are not accepted')
}
const tagsReply = await getJson(new URL('/api/tags', endpoint.origin))
const installed = Array.isArray(tagsReply?.models)
  ? tagsReply.models.flatMap((entry) => [entry?.name, entry?.model]).filter((value) => typeof value === 'string')
  : []
if (!installed.includes(model)) {
  throw new Error(`Ollama model ${JSON.stringify(model)} is not installed; available: ${[...new Set(installed)].join(', ') || '(none)'}`)
}

const triple = /^host:\s*(\S+)$/m.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))?.[1]
if (!triple) throw new Error('could not determine the Rust host triple')
const exe = process.platform === 'win32' ? '.exe' : ''
const binary = join(desktopRoot, 'src-tauri', 'binaries', `sketch-engine-${triple}${exe}`)
const script = join(desktopRoot, 'src-tauri', 'resources', 'sketch-engine.mjs')
await Promise.all([stat(binary), stat(script)]).catch(() => {
  throw new Error('host sidecar is missing; run npm run build:sidecar -w @sketch/desktop first')
})

const root = await mkdtemp(join(tmpdir(), 'sketch-real-ollama-preflight-'))
const sourcePath = join(root, 'greet.mjs')
const verifyPath = join(root, 'verify.mjs')
await writeFile(sourcePath, "export const greeting = 'BEFORE'\n", 'utf8')
await writeFile(
  verifyPath,
  "import { readFileSync } from 'node:fs'\n" +
    "const text = readFileSync(new URL('./greet.mjs', import.meta.url), 'utf8')\n" +
    "if (text !== \"export const greeting = 'AFTER'\\n\") process.exit(1)\n",
  'utf8',
)

const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (key.toUpperCase() === 'SKETCH_FAKE_PROVIDER') delete env[key]
}
const child = spawn(binary, [script], { env, stdio: ['pipe', 'pipe', 'pipe'] })
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
let stdout = ''
let stderr = ''
let seq = 0
const pending = new Map()
const events = []

function settleFrame(frame) {
  if (frame?.kind === 'event' && frame.event) {
    events.push(frame.event)
    return
  }
  const waiter = pending.get(String(frame?.id))
  if (!waiter) return
  pending.delete(String(frame.id))
  if (frame.ok) waiter.resolve(frame.result)
  else waiter.reject(new Error(frame.error ?? frame.code ?? 'sidecar RPC failed'))
}

child.stdout.on('data', (chunk) => {
  stdout += chunk
  let newline = stdout.indexOf('\n')
  while (newline !== -1) {
    const line = stdout.slice(0, newline).trim()
    stdout = stdout.slice(newline + 1)
    if (line) settleFrame(JSON.parse(line))
    newline = stdout.indexOf('\n')
  }
})
child.stderr.on('data', (chunk) => { stderr += chunk })
child.on('exit', (code) => {
  for (const waiter of pending.values()) waiter.reject(new Error(`sidecar exited ${code}: ${stderr.trim()}`))
  pending.clear()
})

function call(method, params, timeoutMs = 10 * 60_000) {
  const id = `preflight-${++seq}`
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectPromise(new Error(`${method} timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    timer.unref?.()
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolvePromise(value) },
      reject: (error) => { clearTimeout(timer); rejectPromise(error) },
    })
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  })
}

try {
  const ping = await call('ping', {})
  if (typeof ping?.version !== 'string') throw new Error('sidecar ping returned no version')

  const architecture = await call('architecture', { root, index: true })
  if (!architecture?.graphPresent || !architecture?.indexed || architecture.indexed.indexed < 2) {
    throw new Error(`index did not produce a nonempty graph: ${JSON.stringify(architecture)}`)
  }
  const graphBytes = await readFile(architecture.graphPath)
  if (graphBytes.byteLength === 0) throw new Error('graph artifact is empty')

  const run = await call('run', {
    root,
    provider: {
      id: 'ollama-preflight',
      kind: 'openai-compatible',
      baseUrl: endpoint.toString().replace(/\/$/, ''),
      model,
      label: 'Real local Ollama preflight',
    },
    maxIterations: 10,
    reviewEdits: false,
    task: {
      id: `ollama-preflight-${Date.now()}`,
      prompt: "Change greet.mjs so the exported greeting is exactly 'AFTER'. First write a plan, then edit the file, run the configured verification, and finish only after it passes.",
      verify: [{ name: 'expected-bytes', cmd: process.execPath, args: [verifyPath], cwd: root, timeoutMs: 30_000 }],
    },
  })

  const finalBytes = await readFile(sourcePath, 'utf8')
  const runEvents = events.filter((event) => event.runId === run.runId)
  const kinds = runEvents.map((event) => event.kind)
  const required = ['plan_written', 'edit_accepted', 'verify_result', 'run_completed']
  const missing = required.filter((kind) => !kinds.includes(kind))
  const verificationPassed = runEvents.some(
    (event) => event.kind === 'verify_result' && event.payload?.ok === true,
  )
  if (!run.ok) throw new Error(`real Ollama run did not complete: ${run.finalText}`)
  if (finalBytes !== "export const greeting = 'AFTER'\n") throw new Error('run completed without expected fixture bytes')
  if (missing.length > 0) throw new Error(`run omitted required events: ${missing.join(', ')}`)
  if (!verificationPassed) throw new Error('run emitted no passing verify_result')

  const evidence = {
    schemaVersion: 1,
    claim: 'source-sidecar real-Ollama preflight; not Requirement 26.2 clean-machine proof',
    at: new Date().toISOString(),
    engineVersion: ping.version,
    ollama: { endpoint: endpoint.toString(), version: versionReply.version, model },
    fixtureRoot: root,
    graph: { path: architecture.graphPath, sha256: sha256(graphBytes), indexed: architecture.indexed },
    run: {
      runId: run.runId,
      ok: run.ok,
      eventKinds: kinds,
      eventsSha256: sha256(JSON.stringify(events)),
      finalBytesSha256: sha256(finalBytes),
    },
    limitations: [
      'application was not installed or launched',
      'UI review/apply was not exercised',
      'Ollama process provenance was not independently attested',
      'process-level DNS and socket activity was not captured',
    ],
  }
  const artifactDir = join(repoRoot, '.sketch', 'preflight')
  await mkdir(artifactDir, { recursive: true })
  const artifact = join(artifactDir, `real-ollama-${Date.now()}.json`)
  const temporary = `${artifact}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  await rename(temporary, artifact)
  console.log(JSON.stringify({ ...evidence, artifact }, null, 2))
} finally {
  child.stdin.end()
  child.kill()
}
