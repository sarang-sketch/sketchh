// Check the production import graph, without a browser or a model request.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist')
const manifest = JSON.parse(await readFile(resolve(dist, '.vite/manifest.json'), 'utf8'))
const entry = Object.keys(manifest).find((key) => manifest[key].isEntry)
assert.ok(entry, 'Build the desktop before checking its bundle')

function graph(key, seen = new Set()) {
  if (seen.has(key)) return seen
  assert.ok(manifest[key], `Missing manifest entry ${key}`)
  seen.add(key)
  for (const dependency of manifest[key].imports ?? []) graph(dependency, seen)
  return seen
}

const shell = graph(entry)
const cowork = graph('src/components/AgentLayout.tsx', new Set(shell))
// Rollup can give this shared dynamic chunk a generated manifest key.
// Match its stable chunk name, then check the same lazy-loading guarantees.
const monaco = Object.keys(manifest).find((key) => manifest[key].name === 'monacoRuntime' && manifest[key].file.endsWith('.js'))
assert.ok(monaco, 'Monaco must have a separate JavaScript chunk')
const deferred = [
  'src/components/IdeLayout.tsx',
  monaco,
  'src/components/settings/SettingsDialog.tsx',
  'src/panels/agent/WorkflowLibrary.tsx',
]
for (const key of deferred) {
  assert.ok(manifest[key]?.isDynamicEntry, `${key} must have its own lazy entry`)
  assert.ok(!cowork.has(key), `${key} must not load when opening Cowork`)
}
const xterm = Object.keys(manifest).find((key) => key.includes('/@xterm/xterm/') && manifest[key].file.endsWith('.js'))
assert.ok(xterm && manifest[xterm].isDynamicEntry && !cowork.has(xterm), 'The terminal renderer must stay out of Cowork startup')

async function bytes(keys) {
  const files = [...new Set([...keys].map((key) => manifest[key].file))]
  const buffers = await Promise.all(files.map((file) => readFile(resolve(dist, file))))
  return { chunks: files.length, raw: buffers.reduce((sum, data) => sum + data.length, 0), gzip: buffers.reduce((sum, data) => sum + gzipSync(data).length, 0) }
}

console.log(JSON.stringify({
  check: 'Workbench loading boundaries passed',
  shellJavaScript: await bytes(shell),
  coworkJavaScript: await bytes(cowork),
  deferred: [...deferred, xterm],
  scope: 'Static production JavaScript graph. Excludes CSS, fonts and runtime data; not a startup timing or competitor benchmark.',
}, null, 2))
