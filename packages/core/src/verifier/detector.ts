// Detects project type and which verify checks apply, based on config files present.

import { readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import type { DetectedProject, CheckConfig } from './types.js'

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return null }
}

export async function detectProject(root: string): Promise<DetectedProject> {
  if (await exists(join(root, 'package.json'))) {
    return { root, language: 'node', checks: await detectNodeChecks(root) }
  }
  if (
    await exists(join(root, 'pyproject.toml')) ||
    await exists(join(root, 'setup.py')) ||
    await exists(join(root, 'requirements.txt'))
  ) {
    return { root, language: 'python', checks: await detectPythonChecks(root) }
  }
  if (await exists(join(root, 'Cargo.toml'))) {
    return { root, language: 'rust', checks: rustChecks() }
  }
  if (await exists(join(root, 'go.mod'))) {
    return { root, language: 'go', checks: goChecks() }
  }
  return { root, language: 'unknown', checks: [] }
}

async function detectNodeChecks(root: string): Promise<CheckConfig[]> {
  const pkg = await readJson(join(root, 'package.json'))
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>
  const checks: CheckConfig[] = []

  // Prefer package.json scripts; fall back to config-file detection.
  if (scripts.lint) {
    checks.push({ name: 'lint', command: 'npm', args: ['run', 'lint'] })
  } else if (
    await exists(join(root, '.eslintrc.js')) ||
    await exists(join(root, '.eslintrc.json')) ||
    await exists(join(root, '.eslintrc.cjs')) ||
    await exists(join(root, 'eslint.config.js')) ||
    await exists(join(root, 'eslint.config.mjs'))
  ) {
    checks.push({ name: 'lint', command: 'npx', args: ['eslint', '.'] })
  }

  if (scripts.typecheck) {
    checks.push({ name: 'typecheck', command: 'npm', args: ['run', 'typecheck'] })
  } else if (await exists(join(root, 'tsconfig.json'))) {
    checks.push({ name: 'typecheck', command: 'npx', args: ['tsc', '--noEmit'] })
  }

  if (scripts.test) {
    checks.push({ name: 'test', command: 'npm', args: ['test'] })
  }

  if (scripts.build) {
    checks.push({ name: 'build', command: 'npm', args: ['run', 'build'] })
  }

  return checks
}

async function detectPythonChecks(root: string): Promise<CheckConfig[]> {
  const checks: CheckConfig[] = []

  if (
    await exists(join(root, 'ruff.toml')) ||
    await exists(join(root, '.ruff.toml')) ||
    await exists(join(root, 'pyproject.toml'))
  ) {
    checks.push({ name: 'lint', command: 'ruff', args: ['check', '.'] })
  }

  if (
    await exists(join(root, 'mypy.ini')) ||
    await exists(join(root, '.mypy.ini'))
  ) {
    checks.push({ name: 'typecheck', command: 'mypy', args: ['.'] })
  }

  if (
    await exists(join(root, 'pytest.ini')) ||
    await exists(join(root, 'tests')) ||
    await exists(join(root, 'pyproject.toml'))
  ) {
    checks.push({ name: 'test', command: 'pytest', args: [] })
  }

  return checks
}

function rustChecks(): CheckConfig[] {
  return [
    { name: 'lint', command: 'cargo', args: ['clippy', '--', '-D', 'warnings'] },
    { name: 'test', command: 'cargo', args: ['test'] },
    { name: 'build', command: 'cargo', args: ['build'] },
  ]
}

function goChecks(): CheckConfig[] {
  return [
    { name: 'lint', command: 'go', args: ['vet', './...'] },
    { name: 'test', command: 'go', args: ['test', './...'] },
    { name: 'build', command: 'go', args: ['build', './...'] },
  ]
}
