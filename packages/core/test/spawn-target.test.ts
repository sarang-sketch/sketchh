// resolveForSpawn: `npm test` without a shell on Windows.
//
// Driven against REAL shim files written into a temp directory (the exact text npm
// and cmd-shim produce), plus — on a Windows host — the machine's real `npm`, so the
// verify runner's most common command is proven to start shell-free.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCommand } from '../src/verify/runner.js'
import { resolveForSpawn, shimScript } from '../src/verify/spawnTarget.js'

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-shim-'))
  dirs.push(dir)
  return dir
}

const NPM_STYLE = [
  '@ECHO OFF',
  'SETLOCAL',
  'SET "NODE_EXE=%~dp0\\node.exe"',
  'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
  '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
].join('\r\n')

const CMD_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  ')',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\tool\\bin\\cli.js" %*',
].join('\r\n')

describe('shim reading', () => {
  it('finds the script behind npm.cmd and behind a cmd-shim', async () => {
    const dir = await tmp()
    await mkdir(join(dir, 'node_modules', 'npm', 'bin'), { recursive: true })
    await mkdir(join(dir, 'node_modules', 'tool', 'bin'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '')
    await writeFile(join(dir, 'node_modules', 'tool', 'bin', 'cli.js'), '')
    await writeFile(join(dir, 'npm.cmd'), NPM_STYLE)
    await writeFile(join(dir, 'tool.cmd'), CMD_SHIM)

    expect(shimScript(join(dir, 'npm.cmd'))).toBe(join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    expect(shimScript(join(dir, 'tool.cmd'))).toBe(join(dir, 'node_modules', 'tool', 'bin', 'cli.js'))
  })

  it('rewrites a PATH shim to node <script> with the arguments still a vector', async () => {
    const dir = await tmp()
    await mkdir(join(dir, 'node_modules', 'tool', 'bin'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'tool', 'bin', 'cli.js'), '')
    await writeFile(join(dir, 'tool.cmd'), CMD_SHIM)
    const env = { PATH: dir, PATHEXT: '.EXE;.CMD' }
    const target = resolveForSpawn('tool', ['run', 'a & b | c'], env, 'win32')
    expect(target.args).toEqual([join(dir, 'node_modules', 'tool', 'bin', 'cli.js'), 'run', 'a & b | c'])
    expect(target.via).toBe(join(dir, 'tool.cmd'))
  })

  it('leaves a command alone off Windows, and a shim it cannot read alone on Windows', async () => {
    expect(resolveForSpawn('npm', ['test'], {}, 'linux')).toEqual({ cmd: 'npm', args: ['test'] })
    const dir = await tmp()
    await writeFile(join(dir, 'weird.cmd'), '@echo off\r\npython "%~dp0\\x.py" %*')
    const target = resolveForSpawn('weird', [], { PATH: dir, PATHEXT: '.CMD' }, 'win32')
    expect(target.cmd).toBe('weird')
  })
})

describe.skipIf(process.platform !== 'win32')('the real npm on this Windows host', () => {
  it('starts `npm --version` through the verify runner with no shell', async () => {
    const result = await runCommand({ name: 'npm-version', cmd: 'npm', args: ['--version'], timeoutMs: 60_000 })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  }, 70_000)
})
