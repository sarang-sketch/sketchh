// Running `npm test` on Windows without a shell.
//
// Every command this engine spawns uses `shell: false` and an argument vector, so a
// filename or a model-authored argument is data and never syntax. On Windows that
// rule collides with how Node tools are installed: `npm`, `npx`, `pnpm`, `tsc` and
// every globally installed CLI are `.cmd` batch shims, and a batch file cannot be
// started without `cmd.exe`. `spawn('npm', …, { shell: false })` therefore fails with
// ENOENT — which meant every detected `npm test` verify stage, and every curated MCP
// server launched through `npx`, failed on Windows before it started.
//
// The fix keeps the rule instead of bending it. A Node shim is a fixed wrapper around
// `node <script> %*`; this module reads the shim, finds that script, and returns
// `node <script> ...args` — the exact program the shim would have run, with the
// arguments still a vector. No `cmd.exe`, no re-parsing, no metacharacters. A shim
// this module cannot read is left alone, and the spawn fails with a message that says
// why rather than quietly running something else.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'

export interface SpawnTarget {
  cmd: string
  args: string[]
  /** Set when the command was rewritten from a shim, naming it, for diagnostics. */
  via?: string
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** First PATH hit for `name`, trying the Windows executable extensions in order. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const pathVar = env['PATH'] ?? env['Path'] ?? ''
  const exts = (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext !== '')
  const hasExt = extname(name) !== ''
  for (const dir of pathVar.split(delimiter)) {
    if (dir.trim() === '') continue
    const base = join(dir.replace(/^"|"$/g, ''), name)
    if (hasExt && isFile(base)) return base
    for (const ext of exts) {
      const candidate = `${base}${ext}`
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

/**
 * The JavaScript entry point a Node `.cmd` shim launches, or null.
 *
 * Two shim shapes exist and both are fixed text written by npm:
 *   * npm's own `npm.cmd` / `npx.cmd`: `"%NODE_EXE%" "%NPM_CLI_JS%" %*`, with the
 *     script under `%~dp0\node_modules\npm\bin\`;
 *   * cmd-shim (every global and `node_modules/.bin` CLI):
 *     `"%_prog%"  "%dp0%\node_modules\pkg\bin\cli.js" %*`.
 */
export function shimScript(shimPath: string): string | null {
  let text: string
  try {
    text = readFileSync(shimPath, 'utf8')
  } catch {
    return null
  }
  const dir = dirname(shimPath)
  const expand = (raw: string): string =>
    resolve(raw.replace(/%~dp0\\?|%dp0%\\?/gi, `${dir}\\`).replace(/\\\\/g, '\\'))

  // npm.cmd / npx.cmd: the CLI script variable is SET explicitly.
  const npmStyle = /SET\s+"(NPM_CLI_JS|NPX_CLI_JS)=([^"]+)"/i.exec(text)
  if (npmStyle !== null) {
    const script = expand(npmStyle[2]!)
    if (isFile(script)) return script
  }

  // cmd-shim: the last quoted path before `%*` that is not the program variable —
  // and only when the program it runs is Node. A shim for a Python or shell script
  // sets `_prog` to that interpreter, and running its script with Node would be wrong.
  const prog = /SET\s+"_prog=([^"]+)"/i.exec(text)?.[1]
  if (prog !== undefined && !/(^|[\\/])node(\.exe)?$/i.test(prog.trim())) return null
  const lines = text.split(/\r?\n/).filter((line) => line.includes('%*'))
  for (const line of lines.reverse()) {
    const quoted = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
    for (const candidate of quoted.reverse()) {
      if (/^%_prog%$|^%NODE_EXE%$/i.test(candidate)) continue
      if (!/%~?dp0%?/i.test(candidate)) continue
      const script = expand(candidate)
      if (isFile(script)) return script
    }
  }
  return null
}

/** The Node binary a shim would use: `node.exe` beside it, else on PATH, else ours. */
function nodeFor(shimPath: string, env: NodeJS.ProcessEnv): string {
  const beside = join(dirname(shimPath), 'node.exe')
  if (existsSync(beside)) return beside
  return findOnPath('node.exe', env) ?? process.execPath
}

/**
 * What to hand `spawn` so `cmd` runs without a shell on this platform.
 *
 * Off Windows, and for anything that is already a real executable, this is the
 * identity. On Windows, a bare name is looked up on PATH; a `.cmd`/`.bat` hit that is
 * a Node shim becomes `node <script> ...args`.
 */
export function resolveForSpawn(
  cmd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): SpawnTarget {
  if (platform !== 'win32') return { cmd, args: [...args] }
  const lower = cmd.toLowerCase()
  if (lower.endsWith('.exe') || lower.endsWith('.com')) return { cmd, args: [...args] }

  let found: string | null = null
  if (isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) {
    if (isFile(cmd)) found = cmd
    else {
      for (const ext of ['.exe', '.cmd', '.bat']) {
        if (isFile(`${cmd}${ext}`)) {
          found = `${cmd}${ext}`
          break
        }
      }
    }
  } else {
    found = findOnPath(cmd, env)
  }
  if (found === null) return { cmd, args: [...args] }

  const ext = extname(found).toLowerCase()
  if (ext === '.exe' || ext === '.com') return { cmd: found, args: [...args] }
  if (ext === '.cmd' || ext === '.bat') {
    const script = shimScript(found)
    if (script !== null) return { cmd: nodeFor(found, env), args: [script, ...args], via: found }
  }
  return { cmd, args: [...args] }
}
