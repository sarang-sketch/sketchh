// Build the engine sidecar for the Tauri bundle.
//
// Produces TWO artifacts, because a bundled JavaScript file is not an executable:
//
//   src-tauri/binaries/sketch-engine-<target-triple>[.exe]   the Node runtime
//   src-tauri/resources/sketch-engine.mjs                    the engine bundle
//
// Tauri's `externalBin` requires the `-<target-triple>` suffix on the binary
// (https://v2.tauri.app/develop/sidecar/), so the runtime is copied under that
// exact name and the engine travels beside it as a bundled resource. This is the
// second option the Tauri Node.js sidecar guide names — embed the runtime and ship
// the bundled JavaScript as a resource — chosen over `pkg`/Node SEA because those
// add a build-time dependency, and C3 keeps the toolchain thin. The cost is stated
// plainly: the app ships a Node binary (~100 MB) and the engine source is readable
// inside the installer.
//
// esbuild comes from the Vite toolchain already present in the workspace; nothing
// is added to packages/core, whose zero-runtime-dependency rule is untouched
// (C3, Requirement 12.7).
//
// Run it with: npm run build:sidecar -w @sketch/desktop
// The Tauri build runs it automatically (tauri.conf.json beforeBuildCommand).

import { execSync } from 'node:child_process'
import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(here, '..')
const coreCli = resolve(desktopRoot, '../core/src/cli.ts')
const binariesDir = join(desktopRoot, 'src-tauri', 'binaries')
const resourcesDir = join(desktopRoot, 'src-tauri', 'resources')

/** The `-$TARGET_TRIPLE` suffix Tauri looks for. rustc is the authority on it. */
function targetTriple() {
  if (process.env.SKETCH_TARGET_TRIPLE) return process.env.SKETCH_TARGET_TRIPLE
  try {
    const info = execSync('rustc -vV', { encoding: 'utf8' })
    const host = /^host:\s*(\S+)$/m.exec(info)
    if (host) return host[1]
  } catch {
    // fall through to the explicit failure below
  }
  throw new Error(
    'cannot determine the target triple: rustc is not on PATH. Install Rust (the ' +
      'Tauri build needs it anyway) or set SKETCH_TARGET_TRIPLE explicitly.',
  )
}

async function bundleEngine(outFile) {
  const esbuild = await import('esbuild')
  const result = await esbuild.build({
    entryPoints: [coreCli],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // Node built-ins stay external; @sketch/core has no other imports (C3).
    packages: 'bundle',
    logLevel: 'warning',
    metafile: true,
  })
  const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0
  return bytes
}

function copyNodeRuntime(target) {
  copyFileSync(process.execPath, target)
}

const triple = targetTriple()
const exeSuffix = process.platform === 'win32' ? '.exe' : ''
const sidecarBinary = join(binariesDir, `sketch-engine-${triple}${exeSuffix}`)
const engineBundle = join(resourcesDir, 'sketch-engine.mjs')

mkdirSync(binariesDir, { recursive: true })
mkdirSync(resourcesDir, { recursive: true })

const bundledBytes = await bundleEngine(engineBundle)
copyNodeRuntime(sidecarBinary)

const runtimeBytes = statSync(sidecarBinary).size
process.stdout.write(
  [
    `engine bundle : ${engineBundle} (${(bundledBytes / 1024).toFixed(0)} KiB)`,
    `node runtime  : ${sidecarBinary} (${(runtimeBytes / 1024 / 1024).toFixed(0)} MiB, from ${process.execPath})`,
    `target triple : ${triple}`,
    '',
  ].join('\n'),
)
