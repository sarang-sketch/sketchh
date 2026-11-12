// "Reveal in File Explorer / Finder" and "Open in External Terminal". What these pin:
//   * Exactly what would run on Windows, macOS and Linux — pure plans, nothing opened.
//   * A folder name never reaches a command interpreter's parser.
//   * A path outside the project is refused before anything is spawned.
//   * A program that cannot start is a clear refusal, not a hang.

import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { METHODS } from '../src/rpc/methods.js'
import { createMethodContext } from '../src/rpc/server.js'
import { OsOpenRefusal, externalTerminalPlan, launch, revealPlan, type PlanEnvironment } from '../src/tools/desktopOpen.js'

function machine(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, files: string[] = []): PlanEnvironment {
  const present = new Set(files)
  return { platform, env, exists: (path) => present.has(path) }
}

const WIN_ENV = { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe', LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' }

describe('reveal plans', () => {
  it('selects the item in File Explorer on Windows, with the switch written as Explorer parses it', () => {
    const plan = revealPlan('C:\\work\\my app\\src\\a & b.ts', false, machine('win32', WIN_ENV))
    expect(plan).toEqual({
      program: 'C:\\Windows\\explorer.exe',
      args: ['/select,"C:\\work\\my app\\src\\a & b.ts"'],
      verbatim: true,
      label: 'File Explorer',
    })
  })

  it('reveals in Finder on macOS', () => {
    expect(revealPlan('/Users/dev/app/a.ts', false, machine('darwin', {}))).toEqual({ program: '/usr/bin/open', args: ['-R', '/Users/dev/app/a.ts'], label: 'Finder' })
  })

  it('opens the containing folder on Linux', () => {
    const plan = revealPlan('/home/dev/app/src/a.ts', false, machine('linux', { PATH: '/usr/bin' }, ['/usr/bin/xdg-open']))
    expect(plan).toEqual({ program: '/usr/bin/xdg-open', args: ['/home/dev/app/src'], label: 'the file manager' })
  })
})

describe('external terminal plans', () => {
  it('prefers Windows Terminal, and passes the folder as an argument, not through a shell', () => {
    const wt = 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe'
    const plan = externalTerminalPlan('C:\\work\\app & co', machine('win32', WIN_ENV, [wt]))
    expect(plan).toEqual({ program: wt, args: ['-d', 'C:\\work\\app & co'], cwd: 'C:\\work\\app & co', label: 'Windows Terminal' })
    expect(plan.verbatim).toBeUndefined()
  })

  it('without Windows Terminal, starts a new PowerShell window whose folder is only the working directory', () => {
    const plan = externalTerminalPlan('C:\\work\\%PATH% & calc', machine('win32', WIN_ENV))
    expect(plan.program).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(plan.cwd).toBe('C:\\work\\%PATH% & calc')
    // Nothing the folder is called is on cmd.exe's command line.
    expect(plan.args.join(' ')).not.toContain('work')
    expect(plan.args.slice(0, 4)).toEqual(['/d', '/c', 'start', '""'])
  })

  it('opens Terminal.app on macOS and the first terminal found on Linux', () => {
    expect(externalTerminalPlan('/Users/dev/app', machine('darwin', {}))).toMatchObject({ program: '/usr/bin/open', args: ['-a', 'Terminal', '/Users/dev/app'] })
    const linux = externalTerminalPlan('/home/dev/app', machine('linux', { PATH: '/usr/local/bin:/usr/bin' }, ['/usr/bin/konsole']))
    expect(linux).toEqual({ program: '/usr/bin/konsole', args: ['--workdir', '/home/dev/app'], cwd: '/home/dev/app', label: 'Konsole' })
  })
})

describe('launching', () => {
  it('resolves once the program has started, and refuses one that cannot start', async () => {
    await expect(launch({ program: process.execPath, args: ['-e', ''], label: 'node' })).resolves.toBeUndefined()
    await expect(launch({ program: join(tmpdir(), 'sketch-no-such-program.exe'), args: [], label: 'nothing' })).rejects.toBeInstanceOf(OsOpenRefusal)
  })
})

describe('over the method table', () => {
  const ctx = () =>
    createMethodContext('o-1', { writeFrame: () => {}, writeErr: () => {}, env: process.env, cwd: () => process.cwd(), secrets: new Set() })

  it('refuses a path outside the project before spawning anything', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sketch-os-'))
    const outside = await mkdtemp(join(tmpdir(), 'sketch-os-outside-'))
    try {
      await mkdir(join(root, 'src'))
      await writeFile(join(outside, 'secret.txt'), 'x')
      await expect(METHODS['os-reveal']!({ root, path: join(outside, 'secret.txt') }, ctx())).rejects.toThrow(/outside the project/)
      await expect(METHODS['os-open-terminal']!({ root, path: '../' }, ctx())).rejects.toThrow(/outside the project/)
      await expect(METHODS['os-reveal']!({ root, path: 'src/missing.ts' }, ctx())).rejects.toThrow(/does not exist/)
      await expect(METHODS['os-reveal']!({ root }, ctx())).rejects.toThrow(/params.path/)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
