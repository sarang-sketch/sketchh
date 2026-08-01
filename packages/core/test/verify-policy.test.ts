// The verification contract: nine stages, ordered, with a policy file that wins.
//
// Uses REAL: temp project directories with real `package.json` / `Cargo.toml` /
// `pyproject.toml` files, the real hand-rolled YAML subset parser, and REAL
// SUBPROCESSES for the ordering and failure tests (`process.execPath -e …`). The
// only injected collaborator is the runner in the ordering tests, where the point is
// to observe the sequence rather than to spawn nine processes.
//
// THE TWO RULES THAT LOOK CONTRADICTORY, both asserted here:
//   * an unconfigured stage is `skipped` and does not fail the run (4.4);
//   * a project with nothing configured is `ok` (4.7) — and `verifiedAnything` is
//     false, which is what stops the eval harness reading it as evidence.
//
// Validates: Requirements 4.3, 4.4, 4.5, 4.6, 4.7, 4.8

import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  POLICY_FILENAMES,
  VERIFY_STAGES,
  detectLanguage,
  detectVerifyPolicy,
  formatPolicyResult,
  isVerifyStage,
  parsePolicyJson,
  parsePolicyYaml,
  resolveVerifyPolicy,
  runVerifyPolicy,
  splitArgv,
  verifyProject,
  type VerifyPolicy,
} from '../src/verify/index.js'
import { MemoryEventStore } from '../src/events/index.js'
import type { VerifyCommand, VerifyResult } from '../src/types.js'

const tmpDirs: string[] = []

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-policy-'))
  tmpDirs.push(dir)
  return dir
}

async function write(root: string, relative: string, content: string): Promise<void> {
  const full = join(root, relative)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, content, 'utf8')
}

/** A command that really passes, in a real child process. */
const PASSING: VerifyCommand = {
  name: 'ok',
  cmd: process.execPath,
  args: ['-e', 'process.stdout.write("fine")'],
}

/** A command that really fails and really writes to stderr. */
const FAILING: VerifyCommand = {
  name: 'bad',
  cmd: process.execPath,
  args: ['-e', 'console.error("BOOM"); process.exit(2)'],
}

/** A runner that records the order it was called in, and never spawns. */
function recordingRunner(failOn: string[] = []) {
  const calls: string[][] = []
  const run = async (commands: VerifyCommand[]): Promise<VerifyResult[]> => {
    calls.push(commands.map((command) => command.name))
    return commands.map((command) => ({
      name: command.name,
      ok: !failOn.includes(command.name),
      exitCode: failOn.includes(command.name) ? 1 : 0,
      stdout: '',
      stderr: failOn.includes(command.name) ? 'recorded failure' : '',
      durationMs: 1,
    }))
  }
  return { calls, run: run as never }
}

/** A policy naming one command per given stage. */
function policyFor(stages: readonly string[]): VerifyPolicy {
  const policy: VerifyPolicy = {}
  for (const stage of stages) {
    if (!isVerifyStage(stage)) throw new Error(`not a stage: ${stage}`)
    policy[stage] = [{ name: stage, cmd: 'noop', args: [] }]
  }
  return policy
}

// ── 1. the contract's shape ─────────────────────────────────────────────────

describe('the nine stages (Requirement 4.3)', () => {
  it('are exactly these, in this order', () => {
    // Reproduced from the requirement verbatim. Reordering the constant to make a
    // test pass is what this assertion exists to prevent.
    expect([...VERIFY_STAGES]).toEqual([
      'format',
      'lint',
      'typecheck',
      'build',
      'unit',
      'integration',
      'security',
      'performance',
      'dependency-audit',
    ])
  })

  it('run in contract order regardless of the order the policy declares them', async () => {
    const recorder = recordingRunner()
    // Declared backwards on purpose.
    const policy: VerifyPolicy = {
      'dependency-audit': [{ name: 'dependency-audit', cmd: 'noop' }],
      unit: [{ name: 'unit', cmd: 'noop' }],
      lint: [{ name: 'lint', cmd: 'noop' }],
    }

    await runVerifyPolicy(policy, { run: recorder.run })
    expect(recorder.calls.flat()).toEqual(['lint', 'unit', 'dependency-audit'])
  })
})

// ── 2. fail fast, and record what ran ───────────────────────────────────────

describe('failing fast', () => {
  it('stops at the first failing stage and marks the rest not-run', async () => {
    const recorder = recordingRunner(['typecheck'])
    const result = await runVerifyPolicy(policyFor(['lint', 'typecheck', 'unit', 'integration']), {
      run: recorder.run,
    })

    expect(result.ok).toBe(false)
    expect(result.failedStage).toBe('typecheck')
    // The slow suites were never spawned.
    expect(recorder.calls.flat()).toEqual(['lint', 'typecheck'])

    const byStage = new Map(result.stages.map((stage) => [stage.stage, stage.status]))
    expect(byStage.get('lint')).toBe('passed')
    expect(byStage.get('typecheck')).toBe('failed')
    // NOT `skipped`. Skipped means the project has no such stage; not-run means we
    // stopped before reaching it, and conflating them would let a broken build claim
    // there are no tests.
    expect(byStage.get('unit')).toBe('not-run')
    expect(byStage.get('integration')).toBe('not-run')
    expect(byStage.get('build')).toBe('skipped')
  })

  it('runs every stage when asked to continue', async () => {
    const recorder = recordingRunner(['lint'])
    const result = await runVerifyPolicy(policyFor(['lint', 'unit']), {
      run: recorder.run,
      continueOnFailure: true,
    })

    expect(recorder.calls.flat()).toEqual(['lint', 'unit'])
    expect(result.ok).toBe(false)
    expect(result.failedStage).toBe('lint')
    expect(result.stages.find((stage) => stage.stage === 'unit')!.status).toBe('passed')
  })

  it('reports the first failure even when a later stage also fails', async () => {
    const recorder = recordingRunner(['lint', 'unit'])
    const result = await runVerifyPolicy(policyFor(['lint', 'unit']), {
      run: recorder.run,
      continueOnFailure: true,
    })
    expect(result.failedStage).toBe('lint')
  })
})

// ── 3. skipped, and the rule that looks contradictory ───────────────────────

describe('skipped stages and the ok rule (Requirements 4.4, 4.7)', () => {
  it('skips an unconfigured stage without failing, and says which one', async () => {
    const result = await runVerifyPolicy(policyFor(['unit']), { run: recordingRunner().run })

    expect(result.ok).toBe(true)
    const skipped = result.stages.filter((stage) => stage.status === 'skipped')
    expect(skipped).toHaveLength(VERIFY_STAGES.length - 1)
    for (const stage of skipped) {
      // The reason names the stage, so a reader of the log never has to work out
      // which of the nine this line is about.
      expect(stage.reason, stage.stage).toBe(
        `no ${stage.stage} stage is configured for this project`,
      )
    }
  })

  it('treats an explicitly empty stage as skipped, not as a pass', async () => {
    const result = await runVerifyPolicy({ unit: [] }, { run: recordingRunner().run })
    expect(result.stages.find((stage) => stage.stage === 'unit')!.status).toBe('skipped')
    expect(result.verifiedAnything).toBe(false)
  })

  it('is ok with nothing configured, and says nothing was verified', async () => {
    // THE TRAP. Both halves asserted together: `ok` is true (4.7) AND
    // `verifiedAnything` is false, which is what the eval harness's `verify-pass`
    // check reads so that an unverified project cannot score a free point.
    const result = await runVerifyPolicy({}, { run: recordingRunner().run })

    expect(result.ok).toBe(true)
    expect(result.verifiedAnything).toBe(false)
    expect(result.ranStages).toEqual([])
    expect(result.results).toEqual([])
    expect(result.stages.every((stage) => stage.status === 'skipped')).toBe(true)
    expect(formatPolicyResult(result)).toContain('no stages are configured')
  })

  it('says something WAS verified as soon as one command ran', async () => {
    const result = await runVerifyPolicy(policyFor(['unit']), { run: recordingRunner().run })
    expect(result.verifiedAnything).toBe(true)
  })
})

// ── 4. real subprocesses ────────────────────────────────────────────────────

describe('against real processes', () => {
  it('passes a real command and records its output and duration', async () => {
    const events = new MemoryEventStore({ secrets: [] })
    const result = await runVerifyPolicy(
      { unit: [PASSING] },
      { sink: events, runId: 'policy-run' },
    )

    expect(result.ok).toBe(true)
    expect(result.results[0]!.stdout).toContain('fine')
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0)

    // Requirement 4.6: the pair comes from the runner's sink, and the policy layer
    // does not re-emit either kind.
    const kinds = (await events.readAll()).map((event) => event.kind)
    expect(kinds).toEqual(['verify_started', 'verify_result'])
  })

  it('fails a real failing command and keeps its stderr', async () => {
    const result = await runVerifyPolicy({ lint: [FAILING], unit: [PASSING] })

    expect(result.ok).toBe(false)
    expect(result.failedStage).toBe('lint')
    expect(result.results[0]!.stderr).toContain('BOOM')
    expect(result.results[0]!.exitCode).toBe(2)
    // Fail-fast: the unit stage never ran, so there is one result, not two.
    expect(result.results).toHaveLength(1)
  })

  it('fails, rather than throwing, when the tool is not installed', async () => {
    // "The tool is not installed" is a verification failure the user has to see, not
    // an exception that kills the run.
    const result = await runVerifyPolicy({
      lint: [{ name: 'lint', cmd: 'sketch-no-such-binary-anywhere', args: [] }],
    })
    expect(result.ok).toBe(false)
    expect(result.failedStage).toBe('lint')
    expect(result.results[0]!.ok).toBe(false)
  })

  it('requires every command in a stage to pass', async () => {
    const result = await runVerifyPolicy({ unit: [PASSING, FAILING] })
    expect(result.stages.find((stage) => stage.stage === 'unit')!.status).toBe('failed')
    expect(result.results).toHaveLength(2)
  })
})

// ── 5. the policy file ──────────────────────────────────────────────────────

describe('verify.yaml (Requirement 4.5)', () => {
  it('parses a stage per line and a block sequence', () => {
    const { policy, diagnostics } = parsePolicyYaml(
      ['lint: npm run lint', 'unit:', '  - npm test', '  - node --test test/extra.js', ''].join('\n'),
    )

    expect(diagnostics).toEqual([])
    expect(policy.lint).toEqual([{ name: 'lint', cmd: 'npm', args: ['run', 'lint'] }])
    expect(policy.unit).toEqual([
      { name: 'unit', cmd: 'npm', args: ['test'] },
      { name: 'unit[1]', cmd: 'node', args: ['--test', 'test/extra.js'] },
    ])
  })

  it('reports an unknown stage instead of configuring nothing', () => {
    // `tests:` instead of `unit:` would otherwise report every stage skipped and the
    // author would believe their tests were running.
    const { policy, diagnostics } = parsePolicyYaml('tests: npm test\n')
    expect(policy.unit).toBeUndefined()
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toContain('unknown stage "tests"')
    expect(diagnostics[0]).toContain('unit')
  })

  it('reports a construct outside the supported subset rather than mis-parsing it', () => {
    // A nested map is exactly what someone reaching for real YAML writes first.
    const { diagnostics } = parsePolicyYaml(['unit:', '  cmd: npm', '  args: [test]'].join('\n'))
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toContain('not parseable')
  })

  it('takes precedence over detection, and names the file it used', async () => {
    const root = await makeProject()
    // A Node project whose detected policy would be `npm test`.
    await write(root, 'package.json', JSON.stringify({ scripts: { test: 'vitest run' } }))
    await write(root, 'verify.yaml', 'lint: npm run lint\n')

    const resolved = await resolveVerifyPolicy(root)
    expect(resolved.source).toBe('file')
    expect(resolved.path).toBe(join(root, 'verify.yaml'))
    expect(resolved.policy.lint).toBeDefined()
    // The detected `unit` stage is NOT merged in: the file is the whole intent.
    expect(resolved.policy.unit).toBeUndefined()
  })

  it('does not fall back to detection when the file is broken', async () => {
    // Falling back would silently run a different gauntlet than the author wrote,
    // and their build would pass for reasons they cannot see.
    const root = await makeProject()
    await write(root, 'package.json', JSON.stringify({ scripts: { test: 'vitest run' } }))
    await write(root, 'verify.yaml', 'unit:\n  cmd: npm\n')

    const resolved = await resolveVerifyPolicy(root)
    expect(resolved.source).toBe('file')
    expect(resolved.diagnostics.length).toBeGreaterThan(0)
    expect(resolved.policy.unit).toBeUndefined()
  })

  it('accepts verify.json for argv a command line cannot express', async () => {
    const root = await makeProject()
    await write(
      root,
      'verify.json',
      JSON.stringify({
        unit: [{ cmd: 'node', args: ['-e', 'console.log("a b  c")'], timeoutMs: 5000 }],
        lint: ['npm run lint'],
      }),
    )

    const resolved = await resolveVerifyPolicy(root)
    expect(resolved.source).toBe('file')
    expect(resolved.policy.unit).toEqual([
      { name: 'unit', cmd: 'node', args: ['-e', 'console.log("a b  c")'], timeoutMs: 5000 },
    ])
    expect(resolved.policy.lint).toEqual([{ name: 'lint', cmd: 'npm', args: ['run', 'lint'] }])
  })

  it('reports a malformed JSON policy without throwing', () => {
    expect(parsePolicyJson('{').diagnostics[0]).toContain('not valid JSON')
    expect(parsePolicyJson('[]').diagnostics[0]).toContain('must be a JSON object')
    expect(parsePolicyJson('{"unit": 3}').diagnostics[0]).toContain('must be an array')
    expect(parsePolicyJson('{"unit": [{"args": []}]}').diagnostics[0]).toContain('cmd must be')
  })

  it('prefers verify.yaml over verify.json when both exist', async () => {
    const root = await makeProject()
    await write(root, 'verify.yaml', 'lint: npm run lint\n')
    await write(root, 'verify.json', JSON.stringify({ unit: ['npm test'] }))

    const resolved = await resolveVerifyPolicy(root)
    expect(resolved.path).toBe(join(root, POLICY_FILENAMES[0]))
    expect(resolved.policy.unit).toBeUndefined()
  })
})

describe('splitArgv', () => {
  it('splits on whitespace and respects quotes', () => {
    expect(splitArgv('npm run lint')).toEqual(['npm', 'run', 'lint'])
    expect(splitArgv('node -e "console.log(1)"')).toEqual(['node', '-e', 'console.log(1)'])
    expect(splitArgv("node -e 'a b'")).toEqual(['node', '-e', 'a b'])
    expect(splitArgv('  spaced   out  ')).toEqual(['spaced', 'out'])
    expect(splitArgv('')).toEqual([])
    // An empty quoted string is a real argument.
    expect(splitArgv('cmd ""')).toEqual(['cmd', ''])
  })

  it('does not pretend to be a shell', () => {
    // No pipes, no redirection, no expansion: the metacharacters arrive as literal
    // argv text and the command fails loudly instead of doing something surprising.
    expect(splitArgv('npm test | grep fail')).toEqual(['npm', 'test', '|', 'grep', 'fail'])
    expect(splitArgv('echo $HOME')).toEqual(['echo', '$HOME'])
    expect(splitArgv('cmd > out.txt')).toEqual(['cmd', '>', 'out.txt'])
  })
})

// ── 6. detection, extended from the baseline (Requirement 4.8) ──────────────

describe('auto-detection', () => {
  it('preserves the baseline four for a Node project, mapping test to unit', async () => {
    const root = await makeProject()
    await write(
      root,
      'package.json',
      JSON.stringify({
        scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'vitest run', build: 'tsc' },
      }),
    )

    const { policy, language } = await detectVerifyPolicy(root)
    expect(language).toBe('node')
    expect(policy.lint).toEqual([{ name: 'lint', cmd: 'npm', args: ['run', 'lint'] }])
    expect(policy.typecheck).toEqual([{ name: 'typecheck', cmd: 'npm', args: ['run', 'typecheck'] }])
    expect(policy.build).toEqual([{ name: 'build', cmd: 'npm', args: ['run', 'build'] }])
    // `npm test`, not `npm run test`, and it satisfies the `unit` stage.
    expect(policy.unit).toEqual([{ name: 'unit', cmd: 'npm', args: ['test'] }])
  })

  it('keeps the baseline config-file fallbacks', async () => {
    const root = await makeProject()
    await write(root, 'package.json', JSON.stringify({ name: 'x' }))
    await write(root, 'tsconfig.json', '{}')
    await write(root, 'eslint.config.js', 'export default []')

    const { policy } = await detectVerifyPolicy(root)
    expect(policy.lint).toEqual([{ name: 'lint', cmd: 'npx', args: ['eslint', '.'] }])
    expect(policy.typecheck).toEqual([{ name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'] }])
  })

  it('adds a stage only when the project already declared it', async () => {
    // A detector that invents `npm audit` for every Node project has invented a
    // stage the author never asked for, and its first failure is an advisory in a
    // transitive dependency that has nothing to do with the change.
    const bare = await makeProject()
    await write(bare, 'package.json', JSON.stringify({ name: 'bare' }))
    const bareDetected = await detectVerifyPolicy(bare)
    expect(bareDetected.policy['dependency-audit']).toBeUndefined()
    expect(bareDetected.policy.security).toBeUndefined()
    expect(bareDetected.policy.performance).toBeUndefined()
    expect(bareDetected.policy.integration).toBeUndefined()
    expect(bareDetected.policy.format).toBeUndefined()

    const rich = await makeProject()
    await write(
      rich,
      'package.json',
      JSON.stringify({
        scripts: {
          'format:check': 'prettier --check .',
          'test:integration': 'vitest run integration',
          audit: 'npm audit --audit-level=high',
          bench: 'node bench.js',
        },
      }),
    )
    const richDetected = await detectVerifyPolicy(rich)
    expect(richDetected.policy.format).toEqual([
      { name: 'format', cmd: 'npm', args: ['run', 'format:check'] },
    ])
    expect(richDetected.policy.integration).toEqual([
      { name: 'integration', cmd: 'npm', args: ['run', 'test:integration'] },
    ])
    expect(richDetected.policy['dependency-audit']).toEqual([
      { name: 'dependency-audit', cmd: 'npm', args: ['run', 'audit'] },
    ])
    expect(richDetected.policy.performance).toEqual([
      { name: 'performance', cmd: 'npm', args: ['run', 'bench'] },
    ])
  })

  it('recognises typecheck under any of its usual script names', async () => {
    for (const script of ['typecheck', 'type-check', 'types', 'tsc']) {
      const root = await makeProject()
      await write(root, 'package.json', JSON.stringify({ scripts: { [script]: 'tsc --noEmit' } }))
      const { policy } = await detectVerifyPolicy(root)
      expect(policy.typecheck, script).toEqual([
        { name: 'typecheck', cmd: 'npm', args: ['run', script] },
      ])
    }
  })

  it('detects rust and go with check-only formatters', async () => {
    const rust = await makeProject()
    await write(rust, 'Cargo.toml', '[package]\nname = "x"\n')
    const rustPolicy = (await detectVerifyPolicy(rust)).policy
    // `--check`, never a rewrite: a formatter that edits files during verification
    // changes the thing being verified.
    expect(rustPolicy.format).toEqual([{ name: 'format', cmd: 'cargo', args: ['fmt', '--check'] }])
    expect(rustPolicy.unit).toEqual([{ name: 'unit', cmd: 'cargo', args: ['test'] }])

    const go = await makeProject()
    await write(go, 'go.mod', 'module x\n')
    const goPolicy = (await detectVerifyPolicy(go)).policy
    expect(goPolicy.lint).toEqual([{ name: 'lint', cmd: 'go', args: ['vet', './...'] }])
    expect(goPolicy.unit).toEqual([{ name: 'unit', cmd: 'go', args: ['test', './...'] }])
  })

  it('detects python and never rewrites while checking', async () => {
    const root = await makeProject()
    await write(root, 'pyproject.toml', '[project]\nname = "x"\n')
    const { policy, language } = await detectVerifyPolicy(root)
    expect(language).toBe('python')
    expect(policy.format).toEqual([{ name: 'format', cmd: 'ruff', args: ['format', '--check', '.'] }])
    expect(policy.unit).toEqual([{ name: 'unit', cmd: 'pytest', args: [] }])
  })

  it('reports an unknown stack as having no stages, not as an error', async () => {
    const root = await makeProject()
    await write(root, 'README.md', '# just docs\n')

    expect(await detectLanguage(root)).toBe('unknown')
    const resolved = await resolveVerifyPolicy(root)
    expect(resolved.source).toBe('none')
    expect(resolved.diagnostics).toEqual([])

    const result = await runVerifyPolicy(resolved.policy)
    expect(result.ok).toBe(true)
    expect(result.verifiedAnything).toBe(false)
  })
})

// ── 7. end to end ──────────────────────────────────────────────────────────

describe('verifyProject', () => {
  it('resolves and runs a real policy file against real processes', async () => {
    const root = await makeProject()
    await write(
      root,
      'verify.json',
      JSON.stringify({
        lint: [{ cmd: process.execPath, args: ['-e', 'process.stdout.write("linted")'] }],
        unit: [{ cmd: process.execPath, args: ['-e', 'console.error("failed"); process.exit(3)'] }],
      }),
    )

    const result = await verifyProject(root)
    expect(result.resolved.source).toBe('file')
    expect(result.ok).toBe(false)
    expect(result.failedStage).toBe('unit')
    expect(result.stages.find((stage) => stage.stage === 'lint')!.status).toBe('passed')
    expect(result.results.at(-1)!.stderr).toContain('failed')

    const summary = formatPolicyResult(result)
    expect(summary).toContain('VERIFY FAIL at unit')
    expect(summary).toContain('lint: PASSED')
    expect(summary).toContain('build: SKIPPED')
  })
})

// ── 8. the loop under the contract ──────────────────────────────────────────
//
// The nine stages only mean something if `done` is decided by them. These drive the
// REAL `runTask` with a real policy and real subprocesses.

describe('the agent loop under the verification contract (Requirement 4.7)', () => {
  const DONE = JSON.stringify({ action: 'done', text: 'finished' })
  const VERIFY = '{"action":"verify"}'

  async function harness() {
    const root = await makeProject()
    const { MemoryEventStore: Store } = await import('../src/events/index.js')
    const { PlanWriter } = await import('../src/plan/index.js')
    const { DiskFileWriter } = await import('../src/orchestrator/file-writer.js')
    const events = new Store({ secrets: [] })
    return {
      root,
      events,
      plan: new PlanWriter({ baseDir: root, events }),
      files: new DiskFileWriter(),
    }
  }

  it('is not done when a stage fails, and says which one', async () => {
    const h = await harness()
    const { runTask } = await import('../src/loop/index.js')
    const { FakeChatAdapter } = await import('../src/providers/fake.js')
    const adapter = new FakeChatAdapter({ script: [VERIFY, DONE] })

    const result = await runTask(
      { id: 't1', prompt: 'change something', verify: [] },
      {
        adapter,
        events: h.events,
        plan: h.plan,
        files: h.files,
        root: h.root,
        maxIterations: 4,
        verifyPolicy: { lint: [PASSING], unit: [FAILING], integration: [PASSING] },
      },
    )

    // THE CLAIM: broken tests mean not done.
    expect(result.ok).toBe(false)
    const terminal = result.events.find((event) => event.kind === 'run_failed')!
    expect(terminal.payload.reason).toBe('verify_failed')
    const policy = terminal.payload.policy as { failedStage: string; ranStages: string[] }
    expect(policy.failedStage).toBe('unit')
    // Fail-fast held inside the run: integration never ran.
    expect(policy.ranStages).toEqual(['lint', 'unit'])

    // The model saw which stage failed and its captured stderr.
    const seen = (adapter.lastMessages ?? []).map((message) => message.content).join('\n')
    expect(seen).toContain('VERIFY FAIL at unit')
    expect(seen).toContain('integration: NOT-RUN')
  })

  it('is done when every non-skipped stage passes', async () => {
    const h = await harness()
    const { runTask } = await import('../src/loop/index.js')
    const { FakeChatAdapter } = await import('../src/providers/fake.js')

    const result = await runTask(
      { id: 't2', prompt: 'change something', verify: [] },
      {
        adapter: new FakeChatAdapter({ script: [VERIFY, DONE] }),
        events: h.events,
        plan: h.plan,
        files: h.files,
        root: h.root,
        maxIterations: 4,
        verifyPolicy: { lint: [PASSING], unit: [PASSING] },
      },
    )

    expect(result.ok).toBe(true)
    const terminal = result.events.find((event) => event.kind === 'run_completed')!
    const policy = terminal.payload.policy as { ok: boolean; verifiedAnything: boolean }
    expect(policy.ok).toBe(true)
    expect(policy.verifiedAnything).toBe(true)
  })

  it('runs the gauntlet on done even when the model never asked to verify', async () => {
    const h = await harness()
    const { runTask } = await import('../src/loop/index.js')
    const { FakeChatAdapter } = await import('../src/providers/fake.js')

    const result = await runTask(
      { id: 't3', prompt: 'change something', verify: [] },
      {
        adapter: new FakeChatAdapter({ script: [DONE] }),
        events: h.events,
        plan: h.plan,
        files: h.files,
        root: h.root,
        maxIterations: 4,
        verifyPolicy: { unit: [FAILING] },
      },
    )

    // The model asserting completion is exactly the moment to check the claim.
    expect(result.iterations).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.events.map((event) => event.kind)).toContain('verify_result')
  })

  it('leaves task.verify as the path for a task\u2019s own commands', async () => {
    // The two are not merged: a task cannot append a tenth stage to a project's
    // contract, and a project's contract cannot swallow a case's own assertions.
    const h = await harness()
    const { runTask } = await import('../src/loop/index.js')
    const { FakeChatAdapter } = await import('../src/providers/fake.js')

    const result = await runTask(
      { id: 't4', prompt: 'x', verify: [FAILING] },
      {
        adapter: new FakeChatAdapter({ script: [VERIFY, DONE] }),
        events: h.events,
        plan: h.plan,
        files: h.files,
        root: h.root,
        maxIterations: 4,
      },
    )

    expect(result.ok).toBe(false)
    expect(result.verify.map((entry) => entry.name)).toEqual(['bad'])
    // No policy in force, so no policy payload on the terminal event.
    expect(result.events.find((event) => event.kind === 'run_failed')!.payload.policy).toBeUndefined()
  })

  it('is ok with a policy whose every stage is unconfigured', async () => {
    const h = await harness()
    const { runTask } = await import('../src/loop/index.js')
    const { FakeChatAdapter } = await import('../src/providers/fake.js')

    const result = await runTask(
      { id: 't5', prompt: 'x', verify: [] },
      {
        adapter: new FakeChatAdapter({ script: [VERIFY, DONE] }),
        events: h.events,
        plan: h.plan,
        files: h.files,
        root: h.root,
        maxIterations: 4,
        // Explicitly empty stages: the project has no lint and no tests.
        verifyPolicy: { lint: [], unit: [] },
      },
    )

    expect(result.ok).toBe(true)
    const policy = result.events.find((event) => event.kind === 'run_completed')!.payload.policy as {
      verifiedAnything: boolean
    }
    // And it says out loud that nothing was verified, which is what stops an eval's
    // `verify-pass` check reading this as evidence.
    expect(policy.verifiedAnything).toBe(false)
  })
})
