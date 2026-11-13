// Hooks, against REAL child processes.
//
// Every hook below is a real `node` child spawned with `shell: false` and fed
// JSON on stdin: one that allows, one that denies, one that prints garbage,
// one that hangs past its deadline, and one that records that SessionStart
// ran. Nothing is mocked, because the failures this layer exists to survive
// only happen to real processes.

import { describe, expect, it, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HookRunner, matchesTool, parseHookDecision } from '../src/hooks/runner.js'
import { loadHooks, parseHooksConfig } from '../src/hooks/config.js'
import { hooksList, hooksSave, hooksTest } from '../src/hooks/rpc.js'
import type { HookConfig } from '../src/hooks/types.js'
import { MemoryEventStore } from '../src/events/index.js'
import { runTask } from '../src/loop/index.js'
import { PlanWriter } from '../src/plan/index.js'
import { DiskFileWriter } from '../src/orchestrator/file-writer.js'
import { FakeChatAdapter } from '../src/providers/fake.js'

const tmpDirs: string[] = []

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-hooks-'))
  tmpDirs.push(dir)
  return dir
}

/** Read stdin as JSON, then run `body` with the parsed payload. */
function hookScript(body: string): string {
  return [
    'let data = ""',
    'process.stdin.setEncoding("utf8")',
    'process.stdin.on("data", (c) => { data += c })',
    `process.stdin.on("end", () => { const payload = JSON.parse(data); ${body} })`,
  ].join('\n')
}

const ALLOW_SCRIPT = hookScript('process.stdout.write(JSON.stringify({ allow: true }))')
const DENY_SCRIPT = hookScript(
  'process.stdout.write(JSON.stringify({ allow: false, reason: "hook says no" }))',
)
const GARBAGE_SCRIPT = hookScript('process.stdout.write("hello, not json")')
const SLEEP_SCRIPT = hookScript('setTimeout(() => process.stdout.write("{}"), 5000)')

function markerScript(file: string): string {
  const escaped = file.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  return hookScript(
    `require("node:fs").appendFileSync('${escaped}', payload.event + "\\n")`,
  )
}

function hook(event: HookConfig['event'], command: string[], extra: Partial<HookConfig> = {}): HookConfig {
  return { event, command, ...extra }
}

describe('config validation', () => {
  it('accepts a valid config and names hooks that lack one', () => {
    const parsed = parseHooksConfig({
      hooks: [
        { event: 'PreToolUse', matcher: 'fs.*', command: [process.execPath, '-e', '1'] },
        { event: 'Stop', command: ['echo', 'bye'] },
      ],
    })
    expect(parsed.problems).toEqual([])
    expect(parsed.config.hooks).toHaveLength(2)
    expect(parsed.config.hooks[0]?.name).toBe('PreToolUse-0')
    expect(parsed.config.hooks[1]?.name).toBe('Stop-1')
  })

  it('rejects a command given as a shell string', () => {
    const parsed = parseHooksConfig({
      hooks: [{ event: 'PreToolUse', command: 'node script.js && rm -rf /' }],
    })
    expect(parsed.config.hooks).toHaveLength(0)
    expect(parsed.problems.join(' ')).toMatch(/argv array, not a shell string/)
  })

  it('rejects shell syntax in the program and a NUL byte in args', () => {
    const parsed = parseHooksConfig({
      hooks: [
        { event: 'Stop', command: ['node; rm -rf /', '-e', '1'] },
        { event: 'Stop', command: ['true', 'a\0b'] },
      ],
    })
    expect(parsed.config.hooks).toHaveLength(0)
    expect(parsed.problems.join(' ')).toMatch(/one executable/)
    expect(parsed.problems.join(' ')).toMatch(/NUL byte/)
  })

  it('accepts semicolons inside an argument: argv is data, not a shell line', () => {
    const parsed = parseHooksConfig({
      hooks: [{ event: 'Stop', command: [process.execPath, '-e', 'a; b; c'] }],
    })
    expect(parsed.problems).toEqual([])
    expect(parsed.config.hooks).toHaveLength(1)
  })

  it('rejects an unknown event, a bad matcher, and an over-long timeout', () => {
    const parsed = parseHooksConfig({
      hooks: [
        { event: 'Midnight', command: ['true'] },
        { event: 'Stop', matcher: 'fs read', command: ['true'] },
        { event: 'Stop', command: ['true'], timeoutMs: 999_999 },
      ],
    })
    expect(parsed.config.hooks).toHaveLength(0)
    expect(parsed.problems).toHaveLength(3)
  })

  it('rejects more than the maximum hook count', () => {
    const hooks = Array.from({ length: 33 }, () => ({ event: 'Stop', command: ['true'] }))
    const parsed = parseHooksConfig({ hooks })
    expect(parsed.config.hooks).toHaveLength(0)
    expect(parsed.problems.join(' ')).toMatch(/at most 32/)
  })

  it('rejects a non-object file and a missing hooks array', () => {
    expect(parseHooksConfig([]).problems).toHaveLength(1)
    expect(parseHooksConfig({ hooks: 'nope' }).problems).toHaveLength(1)
  })
})

describe('config loading from disk', () => {
  it('missing file loads as zero hooks with no problems', async () => {
    const root = await makeRoot()
    const loaded = await loadHooks(root)
    expect(loaded.present).toBe(false)
    expect(loaded.config.hooks).toEqual([])
    expect(loaded.problems).toEqual([])
  })

  it('invalid JSON loads as zero hooks plus the problem', async () => {
    const root = await makeRoot()
    await mkdir(join(root, '.sketch'), { recursive: true })
    await writeFile(join(root, '.sketch', 'hooks.json'), '{ not json', 'utf8')
    const loaded = await loadHooks(root)
    expect(loaded.present).toBe(true)
    expect(loaded.config.hooks).toEqual([])
    expect(loaded.problems.some((p) => p.includes('not valid JSON'))).toBe(true)
  })

  it('an oversized file is refused, not read', async () => {
    const root = await makeRoot()
    await mkdir(join(root, '.sketch'), { recursive: true })
    await writeFile(join(root, '.sketch', 'hooks.json'), ' '.repeat(70_000), 'utf8')
    const loaded = await loadHooks(root)
    expect(loaded.config.hooks).toEqual([])
    expect(loaded.problems.join(' ')).toMatch(/at most 65536/)
  })
})

describe('matching and decision parsing', () => {
  it('glob-matches tool names, * across dots, ? for one character', () => {
    expect(matchesTool('fs.*', 'fs.read')).toBe(true)
    expect(matchesTool('fs.*', 'git.read')).toBe(false)
    expect(matchesTool('fs.read', 'fs.read')).toBe(true)
    expect(matchesTool('fs.rea?', 'fs.read')).toBe(true)
    expect(matchesTool('fs.rea?', 'fs.readx')).toBe(false)
    expect(matchesTool(undefined, 'anything.at.all')).toBe(true)
    expect(matchesTool('*', 'anything')).toBe(true)
  })

  it('only a JSON object with a boolean allow counts as a decision', () => {
    expect(parseHookDecision('')).toEqual({})
    expect(parseHookDecision('hello, not json')).toEqual({})
    expect(parseHookDecision('{"allow": "yes"}')).toEqual({})
    expect(parseHookDecision('[false]')).toEqual({})
    expect(parseHookDecision('{"allow": false, "reason": "nope"}')).toEqual({
      allow: false,
      reason: 'nope',
    })
  })
})

describe('the runner', () => {
  it('PreToolUse allow proceeds', async () => {
    const root = await makeRoot()
    const runner = new HookRunner(
      { hooks: [hook('PreToolUse', [process.execPath, '-e', ALLOW_SCRIPT])] },
      { root },
    )
    const decision = await runner.preToolUse('fs.read', { path: 'a.txt' })
    expect(decision).toEqual({ allowed: true })
  })

  it('PreToolUse deny blocks, with the hook reason', async () => {
    const root = await makeRoot()
    const runner = new HookRunner(
      { hooks: [hook('PreToolUse', [process.execPath, '-e', DENY_SCRIPT])] },
      { root },
    )
    const decision = await runner.preToolUse('fs.read', { path: 'a.txt' })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('hook says no')
  })

  it('a deny for one tool does not deny another', async () => {
    const root = await makeRoot()
    const runner = new HookRunner(
      {
        hooks: [
          hook('PreToolUse', [process.execPath, '-e', DENY_SCRIPT], { matcher: 'fs.*' }),
        ],
      },
      { root },
    )
    expect((await runner.preToolUse('git.log', {})).allowed).toBe(true)
    expect((await runner.preToolUse('fs.read', {})).allowed).toBe(false)
  })

  it('non-blocking PreToolUse deny is observed, not honoured', async () => {
    const root = await makeRoot()
    const runner = new HookRunner(
      {
        hooks: [
          hook('PreToolUse', [process.execPath, '-e', DENY_SCRIPT], { blocking: false }),
        ],
      },
      { root },
    )
    expect((await runner.preToolUse('fs.read', {})).allowed).toBe(true)
  })

  it('garbage stdout is ignored and the call proceeds', async () => {
    const root = await makeRoot()
    const runner = new HookRunner(
      { hooks: [hook('PreToolUse', [process.execPath, '-e', GARBAGE_SCRIPT])] },
      { root },
    )
    const decision = await runner.preToolUse('fs.read', {})
    expect(decision.allowed).toBe(true)
  })

  it('a hanging hook times out, is killed, and the call proceeds', async () => {
    const root = await makeRoot()
    const runner = new HookRunner(
      {
        hooks: [
          hook('PreToolUse', [process.execPath, '-e', SLEEP_SCRIPT], { timeoutMs: 150 }),
        ],
      },
      { root },
    )
    const started = Date.now()
    const decision = await runner.preToolUse('fs.read', {})
    const elapsed = Date.now() - started
    expect(decision.allowed).toBe(true)
    expect(elapsed).toBeLessThan(3000)
    const outcomes = await runner.run('PreToolUse', 'fs.read', { input: {} })
    expect(outcomes[0]?.timedOut).toBe(true)
    expect(outcomes[0]?.ok).toBe(false)
  })

  it('a missing program fails the hook, never the caller', async () => {
    const root = await makeRoot()
    const runner = new HookRunner(
      { hooks: [hook('PreToolUse', ['definitely-not-a-real-program-xyz'])] },
      { root },
    )
    const decision = await runner.preToolUse('fs.read', {})
    expect(decision.allowed).toBe(true)
  })

  it('SessionStart runs and PostToolUse deny is ignored', async () => {
    const root = await makeRoot()
    const marker = join(root, 'hooks-ran.txt')
    const events = new MemoryEventStore({ secrets: [] })
    const runner = new HookRunner(
      {
        hooks: [
          hook('SessionStart', [process.execPath, '-e', markerScript(marker)], {
            name: 'on-start',
          }),
          hook('PostToolUse', [process.execPath, '-e', DENY_SCRIPT]),
        ],
      },
      { root, events, runId: 'run-1' },
    )
    await runner.runSessionStart({ runId: 'run-1' })
    await expect(readFile(marker, 'utf8')).resolves.toBe('SessionStart\n')
    // PostToolUse observes only: a deny there resolves, it does not throw.
    await runner.postToolUse('fs.read', {}, 'some output', { runId: 'run-1' })
    const logged = await events.forRun('run-1')
    expect(logged.filter((e) => (e.kind as string) === 'hook_run')).toHaveLength(2)
    expect(logged[0]?.payload['hook']).toBe('on-start')
  })
})

describe('RPC functions', () => {
  it('hooks-list, hooks-save, and hooks-test round-trip through disk', async () => {
    const root = await makeRoot()
    const before = await hooksList(root, {})
    expect(before.present).toBe(false)
    expect(before.hooks).toEqual([])

    const saved = await hooksSave(root, {
      config: {
        hooks: [
          { event: 'PreToolUse', command: [process.execPath, '-e', ALLOW_SCRIPT] },
        ],
      },
    })
    expect(saved.ok).toBe(true)
    expect(saved.problems).toEqual([])

    const after = await hooksList(root, {})
    expect(after.present).toBe(true)
    expect(after.hooks).toHaveLength(1)
    expect(after.hooks[0]?.command[0]).toBe(process.execPath)

    const tested = await hooksTest(root, { event: 'PreToolUse', tool: 'fs.read', input: {} })
    expect(tested.matched).toHaveLength(1)
    expect(tested.outcomes).toHaveLength(1)
    expect(tested.outcomes[0]?.allowed).toBe(true)
    expect(tested.outcomes[0]?.ok).toBe(true)
  })

  it('hooks-save refuses an invalid config and writes nothing', async () => {
    const root = await makeRoot()
    const saved = await hooksSave(root, {
      config: { hooks: [{ event: 'PreToolUse', command: 'node x.js' }] },
    })
    expect(saved.ok).toBe(false)
    expect(saved.problems.length).toBeGreaterThan(0)
    const listed = await hooksList(root, {})
    expect(listed.present).toBe(false)
  })

  it('hooks-test with no matching hook reports an empty run', async () => {
    const root = await makeRoot()
    const tested = await hooksTest(root, { event: 'Stop' })
    expect(tested.matched).toEqual([])
    expect(tested.outcomes).toEqual([])
  })
})

describe('loop integration', () => {
  async function harness() {
    const root = await makeRoot()
    const events = new MemoryEventStore({ secrets: [] })
    return {
      root,
      events,
      plan: new PlanWriter({ baseDir: root, events }),
      files: new DiskFileWriter(),
    }
  }

  const TOOL_SCRIPT = [
    JSON.stringify({ action: 'tool', name: 'echo', args: { text: 'hi' } }),
    JSON.stringify({ action: 'done', text: 'finished' }),
  ]

  it('a PreToolUse deny blocks the tool call and the run continues', async () => {
    const h = await harness()
    let calls = 0
    const tools = {
      availableTools: [{ name: 'echo', description: 'echo' }],
      call: async () => {
        calls++
        return { ok: true, name: 'echo', output: 'echo: hi', denied: null }
      },
    }
    const marker = join(h.root, 'session.txt')
    const runner = new HookRunner(
      {
        hooks: [
          hook('SessionStart', [process.execPath, '-e', markerScript(marker)]),
          hook('PreToolUse', [process.execPath, '-e', DENY_SCRIPT]),
        ],
      },
      { root: h.root, events: h.events },
    )
    const adapter = new FakeChatAdapter({ script: TOOL_SCRIPT })
    const result = await runTask(
      { id: 't1', prompt: 'Use the echo tool.', verify: [] },
      {
        adapter,
        events: h.events,
        plan: h.plan,
        files: h.files,
        root: h.root,
        maxIterations: 4,
        tools,
        hooks: runner,
      },
    )
    expect(calls).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.finalText).toBe('finished')
    await expect(readFile(marker, 'utf8')).resolves.toBe('SessionStart\n')
    const events = await h.events.forRun(result.runId)
    const denied = events.find((e) => e.kind === 'tool_denied')
    expect(denied?.payload['component']).toBe('hooks')
    expect(denied?.payload['reason']).toBe('hook says no')
    // SessionStart + PreToolUse each logged one hook_run outcome.
    expect(events.filter((e) => (e.kind as string) === 'hook_run').length).toBeGreaterThanOrEqual(2)
  })

  it('a PreToolUse allow lets the tool run', async () => {
    const h = await harness()
    let calls = 0
    const tools = {
      availableTools: [{ name: 'echo', description: 'echo' }],
      call: async () => {
        calls++
        return { ok: true, name: 'echo', output: 'echo: hi', denied: null }
      },
    }
    const runner = new HookRunner(
      { hooks: [hook('PreToolUse', [process.execPath, '-e', ALLOW_SCRIPT])] },
      { root: h.root, events: h.events },
    )
    const adapter = new FakeChatAdapter({ script: TOOL_SCRIPT })
    const result = await runTask(
      { id: 't1', prompt: 'Use the echo tool.', verify: [] },
      {
        adapter,
        events: h.events,
        plan: h.plan,
        files: h.files,
        root: h.root,
        maxIterations: 4,
        tools,
        hooks: runner,
      },
    )
    expect(calls).toBe(1)
    expect(result.ok).toBe(true)
  })
})
