// The line-splitter, the allowlist mirror, and the refusal/breakage distinction.
//
// These are the three decisions made BEFORE anything is spawned, so each one is
// tested without a process: a line becomes a program plus an argument VECTOR (or is
// refused in a sentence), the gate mirrors the list the BACKEND supplied rather than
// a second hardcoded copy, and a policy refusal is never presented as a machine
// failure.
//
// Validates: Requirements 22.6, 27.1, 27.4, 27.5

import { describe, expect, it } from 'vitest'

import {
  classifyRunFailure,
  formatCommand,
  parseCommandLine,
  programGate,
} from './commandLine'

/** Exactly what the backend would hand back; never a list written in this file's own words. */
const BACKEND_ALLOWLIST = ['git', 'npm', 'node', 'cargo'] as const

function parsed(line: string) {
  const outcome = parseCommandLine(line)
  if (!outcome.ok) throw new Error(`expected '${line}' to parse: ${JSON.stringify(outcome)}`)
  return outcome.command
}

describe('parseCommandLine — a splitter, not a shell', () => {
  it('produces a program and an argument vector, never one command string', () => {
    expect(parsed('npm run build')).toEqual({ program: 'npm', args: ['run', 'build'] })
  })

  it('groups quoted arguments and drops the quotes themselves', () => {
    expect(parsed('git commit -m "hello world"')).toEqual({
      program: 'git',
      args: ['commit', '-m', 'hello world'],
    })
    expect(parsed("git commit -m 'two  spaces'")).toEqual({
      program: 'git',
      args: ['commit', '-m', 'two  spaces'],
    })
    // Quotes group, so an empty argument survives as an empty argument.
    expect(parsed('git commit -m ""')).toEqual({ program: 'git', args: ['commit', '-m', ''] })
  })

  it('leaves a backslash alone, because on Windows it is a path separator', () => {
    expect(parsed('node src\\main.js')).toEqual({ program: 'node', args: ['src\\main.js'] })
  })

  it('collapses runs of whitespace instead of emitting empty arguments', () => {
    expect(parsed('  git   status\t-s  ')).toEqual({ program: 'git', args: ['status', '-s'] })
  })

  it('treats a blank line as nothing to do rather than an error', () => {
    expect(parseCommandLine('')).toEqual({ ok: false, empty: true })
    expect(parseCommandLine('   \t ')).toEqual({ ok: false, empty: true })
  })

  it('refuses shell syntax in a sentence that says there is no shell', () => {
    const cases: Array<[string, string]> = [
      ['git log | head', "'|' cannot pipe output between commands"],
      ['npm test > out.txt', "'>' cannot redirect output to a file"],
      ['node app.js < in.txt', "'<' cannot redirect input from a file"],
      ['npm ci && npm test', "'&' cannot chain or background commands"],
      ['git status; git log', "';' cannot run several commands in sequence"],
      ['echo $(whoami)', "'$(' cannot substitute a command"],
      ['echo `whoami`', "'`' cannot substitute a command"],
    ]
    for (const [line, fragment] of cases) {
      const outcome = parseCommandLine(line)
      expect(outcome.ok, line).toBe(false)
      if (outcome.ok || outcome.empty === true) throw new Error(`expected a message for ${line}`)
      expect(outcome.message).toContain('There is no shell here')
      expect(outcome.message).toContain(fragment)
      expect(outcome.message).toContain('run the parts separately')
    }
  })

  it('names an unclosed quote instead of guessing where it should have closed', () => {
    expect(parseCommandLine('git commit -m "unfinished')).toEqual({
      ok: false,
      message: 'Unclosed double quote.',
    })
    expect(parseCommandLine("git commit -m 'unfinished")).toEqual({
      ok: false,
      message: 'Unclosed single quote.',
    })
  })

  it('names a NUL byte, which no argument vector can carry', () => {
    const outcome = parseCommandLine('git sta\0tus')
    expect(outcome.ok).toBe(false)
    if (outcome.ok || outcome.empty === true) throw new Error('expected a message')
    expect(outcome.message).toContain('NUL byte')
  })
})

describe('programGate — a mirror of the backend list', () => {
  it('permits what the backend said it permits', () => {
    for (const program of BACKEND_ALLOWLIST) {
      expect(programGate(program, BACKEND_ALLOWLIST)).toEqual({ ok: true, reason: '' })
    }
  })

  it('refuses a program the backend did not list, and shows the list', () => {
    const gate = programGate('rm', BACKEND_ALLOWLIST)
    expect(gate.ok).toBe(false)
    expect(gate.reason).toContain("'rm' is not on the terminal allowlist")
    expect(gate.reason).toContain('git, npm, node, cargo')
  })

  it('follows the backend list rather than a copy of its own', () => {
    // The same program, two different backends. Neither answer is hardcoded here.
    expect(programGate('deno', ['deno']).ok).toBe(true)
    expect(programGate('git', ['deno']).ok).toBe(false)
  })

  it('says the list is not known yet instead of passing everything', () => {
    const gate = programGate('git', [])
    expect(gate.ok).toBe(false)
    expect(gate.reason).toContain('has not been read from the backend yet')
  })

  it('matches the backend by ignoring a .exe or .cmd suffix', () => {
    expect(programGate('npm.cmd', BACKEND_ALLOWLIST).ok).toBe(true)
    expect(programGate('NODE.EXE', ['NODE']).ok).toBe(true)
  })

  it('refuses a path, since the allowlist is about program names', () => {
    for (const attempt of ['./node', 'C:/Windows/System32/cmd.exe', '..\\..\\node']) {
      const gate = programGate(attempt, BACKEND_ALLOWLIST)
      expect(gate.ok, attempt).toBe(false)
      expect(gate.reason).toContain('is a path')
    }
  })

  it('explains that cd is a builtin with no process behind it', () => {
    const gate = programGate('cd', BACKEND_ALLOWLIST)
    expect(gate.ok).toBe(false)
    expect(gate.reason).toContain('shell builtin')
    expect(gate.reason).toContain('project root')
  })

  it('refuses an empty program name', () => {
    expect(programGate('', BACKEND_ALLOWLIST)).toEqual({ ok: false, reason: 'No program named.' })
  })
})

describe('classifyRunFailure — a refusal is not a breakage', () => {
  it('calls the policy sentences denials — current AND legacy wording', () => {
    for (const message of [
      "'rm' is not on the terminal allowlist",
      'the command is refused',
      'command not confirmed: the terminal tool requires an explicit user confirmation',
      // CURRENT Rust wording (W2): a reword that broke this is the regression this fixes.
      "cwd '../..' escapes the open folder C:/project",
      'This file is outside the folder you have open in Sketch, so it cannot be reached from here:',
      'no project root is open',
      'argument 0 contains a NUL byte',
      "not a directory: 'README.md'",
      // LEGACY wording (pre-W2), still recognised via ipc/policyMessages.ts.
      "cwd '../..' escapes the project root",
      'path is outside the open project root C:/project',
    ]) {
      expect(classifyRunFailure(message), message).toBe('denied')
    }
  })

  it('calls everything else a failure', () => {
    for (const message of [
      'program not found (os error 2)',
      'The Tauri bridge is unavailable in a browser',
      'Access is denied. (os error 5)',
    ]) {
      expect(classifyRunFailure(message), message).toBe('failed')
    }
  })
})

describe('formatCommand', () => {
  it('re-quotes only the arguments that need it', () => {
    expect(formatCommand({ program: 'git', args: ['commit', '-m', 'hello world'] })).toBe(
      'git commit -m "hello world"',
    )
    expect(formatCommand({ program: 'npm', args: ['test'] })).toBe('npm test')
  })
})
