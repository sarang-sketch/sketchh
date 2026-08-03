// Tests for the shell-less verify runner.
//
// Every case drives a real subprocess: `process.execPath -e <script>` is portable,
// needs no shell, and is guaranteed present. No mocks, no fakes.
//
// Validates: Requirements 4.1, 4.2, 4.6

import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  runCommand,
  runCommands,
  type VerifyEventSink,
} from '../src/verify/index.js'
import type { VerifyCommand } from '../src/types.js'

const node = process.execPath

// A command that runs `script` under the current Node binary.
const nodeCmd = (
  name: string,
  script: string,
  extra: Partial<VerifyCommand> = {},
): VerifyCommand => ({ name, cmd: node, args: ['-e', script], ...extra })

// Records events in arrival order.
class RecordingSink implements VerifyEventSink {
  public seen: Array<{ runId: string; kind: string; payload: Record<string, unknown> }> = []
  emit(e: { runId: string; kind: 'verify_started' | 'verify_result'; payload: Record<string, unknown> }): void {
    this.seen.push(e)
  }
}

describe('runCommand', () => {
  it('reports ok with exit code 0 and captures stdout', async () => {
    const result = await runCommand(nodeCmd('pass', 'process.stdout.write("hello out")'))

    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hello out')
    expect(result.name).toBe('pass')
  })

  it('reports failure with the real exit code and captures stderr', async () => {
    const result = await runCommand(
      nodeCmd('fail', 'process.stderr.write("boom"); process.exit(3)'),
    )

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain('boom')
  })

  it('captures stdout and stderr from the same command', async () => {
    const result = await runCommand(
      nodeCmd('both', 'process.stdout.write("to-out"); process.stderr.write("to-err")'),
    )

    expect(result.stdout).toContain('to-out')
    expect(result.stderr).toContain('to-err')
  })

  it('populates a plausible durationMs', async () => {
    const result = await runCommand(nodeCmd('timed', 'setTimeout(() => {}, 60)'))

    expect(result.durationMs).toBeGreaterThan(0)
    expect(result.durationMs).toBeLessThan(30_000)
  })

  it('kills a command that outlives its timeout and settles as a failure', async () => {
    const started = Date.now()
    const result = await runCommand(
      nodeCmd('slow', 'setTimeout(() => {}, 30000)', { timeoutMs: 200 }),
    )
    const elapsed = Date.now() - started

    expect(result.ok).toBe(false)
    expect(result.stderr.toLowerCase()).toContain('timed out')
    // Close to the timeout, nowhere near the 30s sleep.
    expect(elapsed).toBeLessThan(5_000)
  })

  it('resolves a failure for a nonexistent binary instead of rejecting', async () => {
    const result = await runCommand({
      name: 'missing',
      cmd: 'sketch-definitely-not-a-real-binary',
      args: ['--version'],
    })

    expect(result.ok).toBe(false)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('sketch-definitely-not-a-real-binary')
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  it('treats shell metacharacters as literal arguments (shell: false)', async () => {
    const result = await runCommand({
      name: 'no-shell',
      cmd: node,
      args: [
        '-e',
        'process.stdout.write(process.argv.slice(1).join("|"))',
        '&& echo pwned',
        '$(whoami)',
        '`whoami`',
        '; rm -rf /',
      ],
    })

    expect(result.ok).toBe(true)
    // Arguments arrive verbatim: nothing was expanded, chained, or substituted.
    expect(result.stdout).toBe('&& echo pwned|$(whoami)|`whoami`|; rm -rf /')
  })

  it('truncates output that exceeds the cap', async () => {
    const result = await runCommand(
      nodeCmd(
        'noisy',
        'for (let i = 0; i < 5000; i++) process.stdout.write("x".repeat(200) + "\\n")',
      ),
      { maxOutputBytes: 2_000 },
    )

    expect(result.stdout).toContain('[output truncated at 2000 bytes]')
    expect(result.stdout.length).toBeLessThan(3_000)
  })
})

describe('runCommands', () => {
  it('runs commands in order and returns one result per command', async () => {
    const results = await runCommands([
      nodeCmd('first', 'process.stdout.write("1")'),
      nodeCmd('second', 'process.stdout.write("2")'),
      nodeCmd('third', 'process.stdout.write("3"); process.exit(1)'),
    ])

    expect(results.map(r => r.name)).toEqual(['first', 'second', 'third'])
    expect(results.map(r => r.stdout.trim())).toEqual(['1', '2', '3'])
    expect(results.map(r => r.ok)).toEqual([true, true, false])
  })

  it('stops the run when the signal is aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const results = await runCommands(
      [nodeCmd('a', 'process.stdout.write("a")'), nodeCmd('b', 'process.stdout.write("b")')],
      { signal: controller.signal },
    )

    expect(results).toEqual([])
  })

  it('kills an in-flight command when the signal aborts mid-run', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 150)

    const started = Date.now()
    const results = await runCommands([nodeCmd('long', 'setTimeout(() => {}, 30000)')], {
      signal: controller.signal,
    })
    const elapsed = Date.now() - started

    expect(results).toHaveLength(1)
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.stderr.toLowerCase()).toContain('aborted')
    expect(elapsed).toBeLessThan(5_000)
  })
})

describe('event emission', () => {
  it('emits verify_started before verify_result for each command', async () => {
    const sink = new RecordingSink()

    await runCommands(
      [nodeCmd('one', 'process.stdout.write("x")'), nodeCmd('two', 'process.exit(2)')],
      { sink, runId: 'run-42' },
    )

    expect(sink.seen.map(e => e.kind)).toEqual([
      'verify_started',
      'verify_result',
      'verify_started',
      'verify_result',
    ])
    expect(sink.seen.every(e => e.runId === 'run-42')).toBe(true)
    expect(sink.seen[0]!.payload.name).toBe('one')
    expect(sink.seen[1]!.payload.ok).toBe(true)
    expect(sink.seen[3]!.payload.exitCode).toBe(2)
  })

  it('still reports a result when the sink throws', async () => {
    const brokenSink: VerifyEventSink = {
      emit() {
        throw new Error('sink is down')
      },
    }

    const result = await runCommand(nodeCmd('resilient', 'process.exit(0)'), {
      sink: brokenSink,
    })

    expect(result.ok).toBe(true)
  })
})

// ── the invariant: nothing in this package spawns through a shell ─────────────
//
// The legacy `src/verifier/` was deleted because its command runner spawned with
// `shell: true`. Nothing routed untrusted input into it, but "no caller does that
// yet" is a fact about today's call graph, not a property of the code. This guard
// makes it a property: `shell: true` cannot exist anywhere under
// `packages/core/src/`, so the next person to need a Windows shim resolved has to
// resolve the shim rather than hand a string to cmd.exe.
//
// Source-level, and deliberately so — the same shape as the append-only guard in
// `memory.test.ts`. A behavioural test can only cover the spawn sites it knows
// about; this covers the ones nobody has written yet.

describe('no shell: true anywhere in packages/core/src', () => {
  const srcRoot = fileURLToPath(new URL('../src/', import.meta.url))

  /** Every `.ts` file under src, recursively. */
  function tsFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...tsFiles(full))
      else if (entry.name.endsWith('.ts')) out.push(full)
    }
    return out.sort()
  }

  /** Drop block and line comments so prose about `shell: true` does not trip the guard. */
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  const files = tsFiles(srcRoot)

  it('finds source files to check, so a broken walk cannot pass vacuously', () => {
    expect(files.length).toBeGreaterThan(50)
    expect(files.some((f) => f.endsWith(join('verify', 'runner.ts')))).toBe(true)
  })

  it('has no shell: true, and every shell option is explicitly false', () => {
    const offenders: string[] = []

    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'))
      const relative = file.slice(srcRoot.length).replace(/\\/g, '/')

      for (const match of code.matchAll(/shell\s*:\s*([A-Za-z0-9_.!]+)/g)) {
        // Not just "never true": every spawn option in this package states `false`
        // out loud. A computed value is how `true` gets back in without the word.
        if (match[1] !== 'false') offenders.push(`${relative}: shell: ${match[1]}`)
      }
    }

    expect(offenders, `spawn without a shell. Offending sites:\n${offenders.join('\n')}`).toEqual([])
  })

  it('the legacy verifier directory is gone, not merely unused', () => {
    expect(existsSync(join(srcRoot, 'verifier'))).toBe(false)
    expect(files.some((f) => f.includes(`${sep}verifier${sep}`))).toBe(false)
  })
})
