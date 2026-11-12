// What a project can be run with, read from its own files.
//
// Pure: given the root's file names and the text of the few files that declare scripts
// (package.json, Makefile), return the commands a person would type. The Run panel
// shows them as one-click buttons that run in the terminal. Nothing here guesses a
// command a project does not declare, except the conventional entry points of a
// language whose marker file is present (`cargo run` beside Cargo.toml).

export interface RunScript {
  /** Stable key, also the terminal tab's name. */
  id: string
  /** What the button says. */
  label: string
  /** The exact line typed into the terminal. */
  command: string
  /** Where it came from, shown under the label. */
  source: string
  group: 'package' | 'make' | 'python' | 'rust' | 'go' | 'setup'
  /** The one most people mean by "run this project". */
  primary?: boolean
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

export function packageManager(names: ReadonlySet<string>): PackageManager {
  if (names.has('pnpm-lock.yaml')) return 'pnpm'
  if (names.has('yarn.lock')) return 'yarn'
  if (names.has('bun.lockb') || names.has('bun.lock')) return 'bun'
  return 'npm'
}

function runLine(pm: PackageManager, script: string): string {
  if (pm === 'npm') return script === 'test' || script === 'start' ? `npm ${script}` : `npm run ${script}`
  if (pm === 'yarn') return `yarn ${script}`
  if (pm === 'bun') return `bun run ${script}`
  return `pnpm ${script}`
}

/** `package.json` scripts, most useful first. Malformed JSON yields nothing. */
export function packageScripts(text: string, pm: PackageManager): RunScript[] {
  let scripts: Record<string, unknown>
  try {
    const parsed = JSON.parse(text) as { scripts?: unknown }
    if (parsed.scripts === null || typeof parsed.scripts !== 'object' || Array.isArray(parsed.scripts)) return []
    scripts = parsed.scripts as Record<string, unknown>
  } catch {
    return []
  }
  const names = Object.keys(scripts).filter((name) => typeof scripts[name] === 'string' && !/^(pre|post)/.test(name))
  const rank = (name: string) => {
    const order = ['dev', 'start', 'serve', 'build', 'test', 'lint', 'typecheck', 'preview', 'format']
    const at = order.indexOf(name)
    return at === -1 ? order.length : at
  }
  names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  const primary = names.find((n) => n === 'dev') ?? names.find((n) => n === 'start')
  return names.map((name) => ({
    id: `pkg:${name}`,
    label: name,
    command: runLine(pm, name),
    source: String(scripts[name]).slice(0, 120),
    group: 'package' as const,
    ...(name === primary ? { primary: true } : {}),
  }))
}

/** Explicit Makefile targets (not pattern rules, not variables, not dot-targets). */
export function makeTargets(text: string): RunScript[] {
  const seen = new Set<string>()
  const out: RunScript[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/.exec(line)
    if (match === null) continue
    const target = match[1]!
    if (seen.has(target) || target.includes('%')) continue
    seen.add(target)
    out.push({ id: `make:${target}`, label: target, command: `make ${target}`, source: 'Makefile', group: 'make' })
    if (out.length >= 30) break
  }
  return out
}

/** Everything runnable in the project, given its root listing and two file texts. */
export function detectScripts(input: {
  names: readonly string[]
  packageJson?: string | null
  makefile?: string | null
}): RunScript[] {
  const names = new Set(input.names.map((n) => n.toLowerCase()))
  const has = (name: string) => names.has(name.toLowerCase())
  const out: RunScript[] = []

  if (input.packageJson) {
    const pm = packageManager(names)
    // The folder listing hides node_modules, so whether it exists is not known here:
    // installing is offered, never claimed to be needed.
    out.push({ id: 'setup:install', label: 'Install dependencies', command: `${pm} install`, source: 'package.json', group: 'setup' })
    out.push(...packageScripts(input.packageJson, pm))
  }
  if (input.makefile) out.push(...makeTargets(input.makefile))

  if (has('requirements.txt')) {
    out.push({ id: 'py:install', label: 'Install requirements', command: 'python -m pip install -r requirements.txt', source: 'requirements.txt', group: 'setup' })
  }
  if (has('manage.py')) {
    out.push({ id: 'py:django', label: 'Django dev server', command: 'python manage.py runserver', source: 'manage.py', group: 'python' })
  }
  for (const entry of ['main.py', 'app.py']) {
    if (has(entry)) out.push({ id: `py:${entry}`, label: `Run ${entry}`, command: `python ${entry}`, source: entry, group: 'python' })
  }
  if (has('pyproject.toml') || has('pytest.ini') || has('tests')) {
    if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) {
      out.push({ id: 'py:pytest', label: 'Run tests (pytest)', command: 'python -m pytest', source: 'Python project', group: 'python' })
    }
  }
  if (has('cargo.toml')) {
    out.push(
      { id: 'rust:run', label: 'cargo run', command: 'cargo run', source: 'Cargo.toml', group: 'rust' },
      { id: 'rust:test', label: 'cargo test', command: 'cargo test', source: 'Cargo.toml', group: 'rust' },
      { id: 'rust:build', label: 'cargo build', command: 'cargo build', source: 'Cargo.toml', group: 'rust' },
    )
  }
  if (has('go.mod')) {
    out.push(
      { id: 'go:run', label: 'go run .', command: 'go run .', source: 'go.mod', group: 'go' },
      { id: 'go:test', label: 'go test ./...', command: 'go test ./...', source: 'go.mod', group: 'go' },
    )
  }
  return out
}
