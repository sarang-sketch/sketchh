import { describe, expect, it } from 'vitest'

import { detectScripts, makeTargets, packageManager, packageScripts } from './scripts'

describe('package scripts', () => {
  it('runs them with the package manager the lockfile names, dev first', () => {
    const json = JSON.stringify({ scripts: { test: 'vitest', build: 'tsc', dev: 'vite', pretest: 'lint', lint: 'eslint .' } })
    expect(packageScripts(json, 'npm').map((s) => s.command)).toEqual(['npm run dev', 'npm run build', 'npm test', 'npm run lint'])
    expect(packageScripts(json, 'pnpm')[0]).toMatchObject({ command: 'pnpm dev', primary: true })
    expect(packageScripts(json, 'yarn')[0]!.command).toBe('yarn dev')
    expect(packageManager(new Set(['pnpm-lock.yaml']))).toBe('pnpm')
    expect(packageManager(new Set(['yarn.lock']))).toBe('yarn')
    expect(packageManager(new Set(['package-lock.json']))).toBe('npm')
  })

  it('yields nothing for broken JSON or no scripts', () => {
    expect(packageScripts('{ nope', 'npm')).toEqual([])
    expect(packageScripts('{"name":"x"}', 'npm')).toEqual([])
    expect(packageScripts('{"scripts":[1,2]}', 'npm')).toEqual([])
  })
})

describe('Makefile targets', () => {
  it('lists explicit targets only', () => {
    const text = ['.PHONY: build test', 'CC := gcc', 'build: main.o', '\t$(CC) -o app', 'test:', '%.o: %.c', 'build: again'].join('\n')
    expect(makeTargets(text).map((t) => t.command)).toEqual(['make build', 'make test'])
  })
})

describe('detectScripts', () => {
  it('finds the conventional entry points of each language', () => {
    const scripts = detectScripts({
      names: ['package.json', 'requirements.txt', 'main.py', 'Cargo.toml', 'go.mod', 'manage.py'],
      packageJson: JSON.stringify({ scripts: { start: 'node .' } }),
    })
    const commands = scripts.map((s) => s.command)
    expect(commands).toContain('npm install')
    expect(commands).toContain('npm start')
    expect(commands).toContain('python -m pip install -r requirements.txt')
    expect(commands).toContain('python main.py')
    expect(commands).toContain('python manage.py runserver')
    expect(commands).toContain('cargo run')
    expect(commands).toContain('go test ./...')
  })

  it('invents nothing for a folder with no markers', () => {
    expect(detectScripts({ names: ['notes.txt'] })).toEqual([])
  })
})
