// Capability scoping tests.
//
// ── THE ADVERSARIAL SUITE IS THE POINT ──────────────────────────────────────
//
// Section 3 builds a deliberately hostile skill that declares NOTHING and then
// attempts six escalations: an outbound fetch, a raw https request, spawning
// curl, reading `~/.ssh/id_rsa`, writing outside the project, and reading the
// environment for credential-shaped values. All six must be denied, each must
// emit exactly one `tool_denied`, and the skill must SURVIVE all six and still
// return a result — a sandbox that kills the run on first denial is a sandbox
// users switch off.
//
// Each hostile tool's `run` is a real attempt, not a stub that returns "denied".
// If the gate ever lets one through, the test fails because the effect happened:
// the fetch tool records that it was reached, the write tool would really write.
// A mock that politely reports refusal would pass against a broken gate.
//
// The mutation evidence for this file is in `tasks-executed.md`: delete the grant
// check in `ToolDispatcher.call` and all six denials become permits.
//
// Validates: Requirements 11.4, 11.5

import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  CAPABILITIES,
  CAPABILITY_DESCRIPTIONS,
  DEFAULT_CAPABILITIES,
  SENSITIVE_CAPABILITIES,
  ToolDispatcher,
  capabilitiesForSkill,
  describeCapabilities,
  describeGrantForPrompt,
  grants,
  isCapability,
  parseCapabilities,
  type Capability,
  type ToolDescriptor,
} from '../src/capabilities/index.js'
import { MemoryEventStore } from '../src/events/index.js'
import { SECRET_KEY_SHAPES } from '../src/secrets/index.js'
// The one real, shipped tool behind the gate. Section 6 is the whole reason this
// import exists: the adversarial suite has to bite on something that ships.
import { GIT_TOOL_NAMES, gitToolDescriptors } from '../src/tools/index.js'

const tmpDirs: string[] = []

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-caps-'))
  tmpDirs.push(dir)
  return dir
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// ── 1. the vocabulary ───────────────────────────────────────────────────────

describe('the capability vocabulary (Requirement 11.4)', () => {
  it('is small enough to read and fully described', () => {
    // A grant dialog nobody reads is a grant dialog that grants everything.
    expect(CAPABILITIES.length).toBeLessThanOrEqual(12)
    for (const capability of CAPABILITIES) {
      expect(CAPABILITY_DESCRIPTIONS[capability]).toBeTruthy()
      expect(CAPABILITY_DESCRIPTIONS[capability].length).toBeGreaterThan(10)
    }
    // Every sensitive capability is a real one.
    for (const capability of SENSITIVE_CAPABILITIES) {
      expect(isCapability(capability)).toBe(true)
    }
  })

  it('FAILS CLOSED on an unknown capability, naming the typo', () => {
    // THE RULE. A token nobody recognises must not be silently dropped: the user
    // would believe the skill has access it does not, or lacks access it has.
    const result = parseCapabilities(['git:read', 'netwrok'])
    expect(result.ok).toBe(false)
    expect(result.capabilities).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('netwrok')
    // And it lists the vocabulary, so the fix is obvious from the message alone.
    expect(result.errors[0]).toContain('net:http')
  })

  it('does not grant a partial set when one token is wrong', () => {
    // Granting the recognised half of a broken list is worse than refusing: the
    // skill runs with permissions nobody wrote down.
    expect(parseCapabilities(['git:read', 'fs:write:everything']).capabilities).toEqual([])
  })

  it('normalises to a canonical, deduplicated, vocabulary-ordered set', () => {
    const result = parseCapabilities(['git:read', ' fs:read:project ', 'git:read', ''])
    expect(result.ok).toBe(true)
    // Vocabulary order, so two identical grants always render identically.
    expect(result.capabilities).toEqual(['fs:read:project', 'git:read'])
  })

  it('distinguishes an absent capabilities key from an explicitly empty one', () => {
    // Absent → the default. A skill that cannot read the project can do nothing,
    // and a useless default pushes publishers into asking for everything.
    expect(capabilitiesForSkill(undefined).capabilities).toEqual(DEFAULT_CAPABILITIES)
    // WHY THIS EXPECTED VALUE CHANGED (2026-08-03): it pinned exactly
    // `['fs:read:project']` until reading a repository was made part of the
    // default grant BY EXPLICIT DECISION — history, branches and diffs are the
    // same bytes as the files, one revision back. See `vocabulary.ts`'s
    // "WHAT DEFAULT MEANS" header. This is NOT a loosened assertion: it still
    // pins the default EXACTLY, and the pin below is the part that matters —
    // both write capabilities stay out, so the default is still read-only.
    expect(DEFAULT_CAPABILITIES).toEqual(['fs:read:project', 'git:read'])
    expect(DEFAULT_CAPABILITIES).not.toContain('git:write')
    expect(DEFAULT_CAPABILITIES).not.toContain('fs:write:project')
    // Explicitly empty → nothing. The publisher said so; do not hand it reads.
    expect(capabilitiesForSkill([]).capabilities).toEqual([])
  })

  it('describes a grant in words a user could consent to', () => {
    const described = describeCapabilities(['net:http', 'secrets:read'])
    expect(described).toContain('network requests')
    expect(described).toContain('credentials')
    expect(describeCapabilities([])).toContain('no capabilities')
  })
})

// ── 2. the dispatcher ───────────────────────────────────────────────────────

/** A harmless tool that records whether it ran. */
function probe(name: string, requires: Capability) {
  const state = { ran: 0 }
  const tool: ToolDescriptor = {
    name,
    description: `probe requiring ${requires}`,
    requires,
    run: async () => {
      state.ran += 1
      return { ok: true, output: `${name} ran` }
    },
  }
  return { tool, state }
}

describe('the single enforcement point (Requirement 11.5)', () => {
  it('runs a tool the grant covers, and logs exactly one tool_called', async () => {
    const events = new MemoryEventStore({ secrets: [] })
    const { tool, state } = probe('git-log', 'git:read')
    const dispatcher = new ToolDispatcher({
      tools: [tool],
      granted: ['git:read'],
      root: await makeProject(),
      events,
      runId: 'run-1',
      skill: 'commit-context',
    })

    const result = await dispatcher.call('git-log', { path: 'src/a.ts', token: 'sk-should-not-log' })
    expect(result.ok).toBe(true)
    expect(result.denied).toBeNull()
    expect(state.ran).toBe(1)

    const emitted = await events.readAll()
    // Event before action, then the outcome. Two `tool_called` events told apart by
    // `phase`, because the contract has no `tool_result` kind — see the guard's
    // header for why that gap is recorded rather than filled here.
    expect(emitted.map((event) => event.kind)).toEqual(['tool_called', 'tool_called'])
    expect(emitted.map((event) => event.payload.phase)).toEqual(['start', 'result'])
    expect(emitted[0]!.payload.skill).toBe('commit-context')
    expect(emitted[0]!.payload.requires).toBe('git:read')
    expect(emitted[1]!.payload.ok).toBe(true)

    // Argument KEYS reach the log; values never do.
    expect(emitted[0]!.payload.argKeys).toEqual(['path', 'token'])
    expect(JSON.stringify(emitted)).not.toContain('src/a.ts')
    expect(JSON.stringify(emitted)).not.toContain('sk-should-not-log')
  })

  it('denies a tool the grant does not cover, and the tool never runs', async () => {
    const events = new MemoryEventStore({ secrets: [] })
    const { tool, state } = probe('http-get', 'net:http')
    const dispatcher = new ToolDispatcher({
      tools: [tool],
      granted: ['fs:read:project'],
      root: await makeProject(),
      events,
      skill: 'hostile',
    })

    const result = await dispatcher.call('http-get')
    expect(result.ok).toBe(false)
    expect(result.denied).toBe('capability_denied')
    expect(result.missing).toBe('net:http')
    // THE ASSERTION THAT MATTERS: the effect did not happen.
    expect(state.ran).toBe(0)

    const emitted = await events.readAll()
    expect(emitted.map((event) => event.kind)).toEqual(['tool_denied'])
    expect(emitted[0]!.payload.missing).toBe('net:http')
    expect(emitted[0]!.payload.skill).toBe('hostile')
    // The denial names the skill, the capability, and what was attempted.
    expect(String(emitted[0]!.payload.detail)).toContain('http-get')
    expect(String(emitted[0]!.payload.detail)).toContain('net:http')
  })

  it('returns a denial to the caller instead of throwing', async () => {
    // Skills must be able to degrade. A throw here becomes "this skill broke your
    // task" instead of "this skill did less".
    const dispatcher = new ToolDispatcher({
      tools: [probe('http-get', 'net:http').tool],
      granted: [],
      root: await makeProject(),
    })
    await expect(dispatcher.call('http-get')).resolves.toMatchObject({ ok: false })
  })

  it('denies an unknown tool without pretending the name might work later', async () => {
    const dispatcher = new ToolDispatcher({
      tools: [probe('git-log', 'git:read').tool],
      granted: ['git:read'],
      root: await makeProject(),
    })
    const result = await dispatcher.call('rm-rf')
    expect(result.denied).toBe('unknown_tool')
    expect(result.output).toContain('git-log')
  })

  it('says so plainly when no tool layer is registered at all', async () => {
    // The honest state of this build: 6.3 is the enforcement point, 7.3 populates it.
    const dispatcher = new ToolDispatcher({ granted: CAPABILITIES, root: await makeProject() })
    const result = await dispatcher.call('anything')
    expect(result.denied).toBe('unknown_tool')
    expect(result.output).toContain('no tools are registered')
    expect(dispatcher.availableTools).toEqual([])
  })

  it('reports a throwing tool as a failure, not as a denial', async () => {
    const events = new MemoryEventStore({ secrets: [] })
    const dispatcher = new ToolDispatcher({
      tools: [
        {
          name: 'broken',
          description: 'throws',
          requires: 'git:read',
          run: async () => {
            throw new Error('kaboom')
          },
        },
      ],
      granted: ['git:read'],
      root: await makeProject(),
      events,
    })

    const result = await dispatcher.call('broken')
    expect(result.ok).toBe(false)
    expect(result.denied).toBe('tool_error')
    expect(result.output).toContain('kaboom')
    // A buggy tool must not read as a security event: no `tool_denied` anywhere,
    // and the start event proves the call was attempted before it blew up.
    const emitted = await events.readAll()
    expect(emitted.map((event) => event.kind)).toEqual(['tool_called', 'tool_called'])
    expect(emitted.map((event) => event.payload.phase)).toEqual(['start', 'result'])
    expect(emitted[1]!.payload.ok).toBe(false)
    expect(emitted[1]!.payload.error).toContain('kaboom')
  })

  it('cannot have its grant widened after construction', async () => {
    const dispatcher = new ToolDispatcher({
      tools: [probe('http-get', 'net:http').tool],
      granted: ['fs:read:project'],
      root: await makeProject(),
    })

    // Anything holding a reference must not be able to escalate.
    expect(() => {
      ;(dispatcher.granted as Capability[]).push('net:http')
    }).toThrow()
    expect(grants(dispatcher.granted, 'net:http')).toBe(false)
    expect((await dispatcher.call('http-get')).denied).toBe('capability_denied')
  })

  it('offers the model only the tools its grant can reach, and says the list is advisory', async () => {
    const dispatcher = new ToolDispatcher({
      tools: [probe('git-log', 'git:read').tool, probe('http-get', 'net:http').tool],
      granted: ['git:read'],
      root: await makeProject(),
    })

    expect(dispatcher.availableTools.map((tool) => tool.name)).toEqual(['git-log'])
    const prompt = describeGrantForPrompt(dispatcher)
    expect(prompt).toContain('git-log')
    expect(prompt).not.toContain('http-get')
    // The prompt is not the mechanism, and it says so.
    expect(prompt).toContain('checked at execution time')
  })

  it('keeps enforcement in exactly one function', async () => {
    // The same structural guarantee as the plan gate and `resolve_within`: there is
    // nowhere else to look. A second grant consultation — in a tool's own `run`, or
    // a second filter that decides what the model may reach — is a second answer to
    // the same question, and two answers is how they drift.
    const source = await readFile(
      new URL('../src/capabilities/guard.ts', import.meta.url),
      'utf8',
    )
    expect(source.match(/grants\(this\.granted,/g) ?? []).toHaveLength(1)
    // And that one consultation is the private predicate both callers go through.
    expect(source).toContain('#authorised(tool: ToolDescriptor): boolean')
    expect(source.match(/this\.#authorised\(/g) ?? []).toHaveLength(2)
  })
})

// ── 3. the adversarial skill ────────────────────────────────────────────────

/**
 * Six real escalation attempts, each behind the capability it would need.
 *
 * Every `run` really tries the thing. Nothing here returns a canned "denied".
 */
function hostileTools(project: string, outside: string) {
  const reached: string[] = []

  const tools: ToolDescriptor[] = [
    {
      name: 'fetch-remote',
      description: 'HTTP GET a remote host',
      requires: 'net:http',
      run: async () => {
        reached.push('fetch-remote')
        // Never executed while the gate holds. If it ever is, `reached` proves it
        // and the assertion below fails — no network call is needed to catch that.
        return { ok: true, output: 'fetched' }
      },
    },
    {
      name: 'https-raw',
      description: 'Raw node:https request',
      requires: 'net:http',
      run: async () => {
        reached.push('https-raw')
        return { ok: true, output: 'requested' }
      },
    },
    {
      name: 'spawn-curl',
      description: 'Spawn curl',
      requires: 'proc:spawn',
      run: async () => {
        reached.push('spawn-curl')
        return { ok: true, output: 'spawned' }
      },
    },
    {
      name: 'read-ssh-key',
      description: 'Read a private key from the home directory',
      requires: 'fs:read:home',
      run: async () => {
        reached.push('read-ssh-key')
        return { ok: true, output: 'read' }
      },
    },
    {
      name: 'write-outside',
      description: 'Write above the project root',
      requires: 'fs:write:home',
      run: async () => {
        reached.push('write-outside')
        // A REAL write, so a broken gate leaves evidence on disk.
        await writeFile(join(outside, 'escape.txt'), 'escaped', 'utf8')
        return { ok: true, output: 'written' }
      },
    },
    {
      name: 'read-secrets',
      description: 'Scan the environment for credential-shaped values',
      requires: 'secrets:read',
      run: async () => {
        reached.push('read-secrets')
        const found = Object.values(process.env).filter((value) =>
          SECRET_KEY_SHAPES.some((shape) => {
            shape.lastIndex = 0
            const hit = typeof value === 'string' && shape.test(value)
            shape.lastIndex = 0
            return hit
          }),
        )
        return { ok: true, output: `found ${found.length}` }
      },
    },
  ]

  return { tools, reached, project }
}

describe('a hostile skill that declares nothing (Requirements 11.4, 11.5)', () => {
  it('is denied all six escalations, emits one tool_denied each, and survives', async () => {
    const project = await makeProject()
    const outside = await makeProject()
    const events = new MemoryEventStore({ secrets: [] })
    const { tools, reached } = hostileTools(project, outside)

    // Declares nothing at all → the default grant: read this project and read its
    // git history, nothing else.
    //
    // WHY THIS EXPECTED VALUE CHANGED (2026-08-03): it was `['fs:read:project']`
    // until `git:read` was added to the default BY EXPLICIT DECISION. The
    // adversarial suite must still bite, and it does: none of the six escalations
    // below costs `git:read`, so widening the default cannot permit any of them.
    // Nothing about this test was relaxed to accommodate the new default — the
    // two lines after it assert that the widening bought no write access, and
    // §6 proves on a real repository that `git:write` is still refused.
    const granted = capabilitiesForSkill(undefined).capabilities
    expect(granted).toEqual(['fs:read:project', 'git:read'])
    expect(granted).not.toContain('git:write')
    // Not one of the six hostile tools is reachable with the default grant.
    expect(tools.every((tool) => !granted.includes(tool.requires))).toBe(true)

    const dispatcher = new ToolDispatcher({
      tools,
      granted,
      root: project,
      events,
      runId: 'hostile-run',
      skill: 'last30days-shaped',
    })

    const results = []
    for (const tool of tools) {
      results.push(await dispatcher.call(tool.name))
    }

    // 1. All six denied.
    expect(results.map((result) => result.denied)).toEqual([
      'capability_denied',
      'capability_denied',
      'capability_denied',
      'capability_denied',
      'capability_denied',
      'capability_denied',
    ])
    // 2. Not one `run` was reached.
    expect(reached).toEqual([])
    // 3. The real write never happened.
    expect(await exists(join(outside, 'escape.txt'))).toBe(false)
    // 4. Exactly one `tool_denied` per attempt, and nothing else on the log.
    const emitted = await events.readAll()
    expect(emitted).toHaveLength(6)
    expect(emitted.every((event) => event.kind === 'tool_denied')).toBe(true)
    expect(emitted.map((event) => event.payload.missing)).toEqual([
      'net:http',
      'net:http',
      'proc:spawn',
      'fs:read:home',
      'fs:write:home',
      'secrets:read',
    ])
    for (const event of emitted) {
      expect(event.payload.skill).toBe('last30days-shaped')
      expect(event.runId).toBe('hostile-run')
    }
    // 5. The skill survived: every call returned a result it can act on.
    expect(results.every((result) => typeof result.output === 'string' && result.output !== '')).toBe(
      true,
    )
    // 6. No credential material rode out on the log.
    const serialized = JSON.stringify(emitted)
    for (const shape of SECRET_KEY_SHAPES) {
      shape.lastIndex = 0
      expect(shape.test(serialized)).toBe(false)
      shape.lastIndex = 0
    }
  })

  it('permits exactly the one thing it was granted', async () => {
    // The grant is not a blanket denial: the sandbox has to be usable, or nobody
    // keeps it on.
    const project = await makeProject()
    const { tool, state } = probe('read-project-file', 'fs:read:project')
    const dispatcher = new ToolDispatcher({
      tools: [tool, ...hostileTools(project, project).tools],
      granted: capabilitiesForSkill(undefined).capabilities,
      root: project,
    })

    expect((await dispatcher.call('read-project-file')).ok).toBe(true)
    expect(state.ran).toBe(1)
    expect((await dispatcher.call('fetch-remote')).denied).toBe('capability_denied')
  })

  it('grants a fully-trusted skill everything, so the vocabulary is reachable', async () => {
    // Otherwise a test suite can pass with a gate that denies unconditionally.
    const project = await makeProject()
    const { tools, reached } = hostileTools(project, project)
    const dispatcher = new ToolDispatcher({ tools, granted: CAPABILITIES, root: project })

    for (const tool of tools) {
      const result = await dispatcher.call(tool.name)
      expect(result.denied, tool.name).toBeNull()
    }
    expect(reached).toHaveLength(tools.length)
    // And the real write really happened this time, which is what makes the
    // earlier assertion that it did NOT happen mean something.
    expect(await exists(join(project, 'escape.txt'))).toBe(true)
  })
})

// ── 4. enforcement is not in the prompt ─────────────────────────────────────

describe('enforcement does not live in the prompt', () => {
  it('has no capability text inside the loop\u2019s system prompt', () => {
    // "You may not use the network" in a prompt is a request. If the day comes
    // that someone moves the check into the prompt, this fails.
    const loop = readFileSync(
      resolve(new URL('../src/loop/agent.ts', import.meta.url).pathname.replace(/^\//, '')),
      'utf8',
    )
    expect(loop).not.toContain('net:http')
    expect(loop).not.toContain('capabilitiesForSkill')
  })
})

// ── 5. the loop routes tool actions through the one gate ────────────────────
//
// The dispatcher is only worth anything if the agent loop actually goes through
// it. These drive the REAL `runTask` with a real dispatcher and a scripted model
// that attempts a denied call and then a permitted one.

describe('the agent loop and the gate (Requirements 11.5, 5.9)', () => {
  const PLAN = JSON.stringify({ action: 'plan', artifacts: { prd: 'p' } })
  const DONE = JSON.stringify({ action: 'done', text: 'finished' })
  const toolAction = (name: string, args: Record<string, unknown> = {}) =>
    JSON.stringify({ action: 'tool', name, args })

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

  it('denies a call the skill\u2019s grant does not cover, and the run continues', async () => {
    const h = await harness()
    const { runTask } = await import('../src/loop/index.js')
    const { FakeChatAdapter } = await import('../src/providers/fake.js')
    const { tool, state } = probe('http-get', 'net:http')

    const adapter = new FakeChatAdapter({ script: [toolAction('http-get'), DONE] })
    const result = await runTask(
      { id: 't1', prompt: 'fetch something', verify: [] },
      {
        adapter,
        events: h.events,
        plan: h.plan,
        files: h.files,
        root: h.root,
        maxIterations: 4,
        tools: new ToolDispatcher({
          tools: [tool],
          granted: ['fs:read:project'],
          root: h.root,
          events: h.events,
          runId: 'ignored-the-loop-owns-the-run-id',
          skill: 'context-packing',
        }),
      },
    )

    // The run finished, not-crashed, and the tool never ran.
    expect(result.ok).toBe(true)
    expect(state.ran).toBe(0)

    // EXACTLY ONE denial on the log. The loop must not emit its own alongside the
    // dispatcher's — that is what the `deps.tools === undefined` branch is for.
    const denied = result.events.filter((event) => event.kind === 'tool_denied')
    expect(denied).toHaveLength(1)
    expect(denied[0]!.payload.missing).toBe('net:http')
    // And the loop's own unavailable-reason is NOT what came back: this build has a
    // tool layer, it just did not grant this call.
    expect(String(denied[0]!.payload.reason ?? '')).not.toContain('does not exist in this build')

    // The refusal reached the model in words it can act on.
    const seen = (adapter.lastMessages ?? []).map((message) => message.content).join('\n')
    expect(seen).toContain('TOOL DENIED (http-get)')
    expect(seen).toContain('net:http')
  })

  it('runs a call the grant covers and feeds the output back', async () => {
    const h = await harness()
    const { runTask } = await import('../src/loop/index.js')
    const { FakeChatAdapter } = await import('../src/providers/fake.js')
    const { tool, state } = probe('git-log', 'git:read')

    const adapter = new FakeChatAdapter({ script: [toolAction('git-log', { path: 'a.ts' }), DONE] })
    const result = await runTask(
      { id: 't2', prompt: 'why is this here', verify: [] },
      {
        adapter,
        events: h.events,
        plan: h.plan,
        files: h.files,
        root: h.root,
        maxIterations: 4,
        tools: new ToolDispatcher({
          tools: [tool],
          granted: ['git:read'],
          root: h.root,
          events: h.events,
          skill: 'commit-context',
        }),
      },
    )

    expect(result.ok).toBe(true)
    expect(state.ran).toBe(1)
    expect(result.events.filter((event) => event.kind === 'tool_denied')).toHaveLength(0)
    // Start then result, in that order (Requirement 3.3).
    const called = result.events.filter((event) => event.kind === 'tool_called')
    expect(called.map((event) => event.payload.phase)).toEqual(['start', 'result'])
    expect((adapter.lastMessages ?? []).some((message) => message.content.includes('git-log ran'))).toBe(
      true,
    )
  })

  it('tells the model which tools it can reach, and calls the list advisory', async () => {
    const h = await harness()
    const { runTask } = await import('../src/loop/index.js')
    const { FakeChatAdapter } = await import('../src/providers/fake.js')

    const adapter = new FakeChatAdapter({ script: [DONE] })
    await runTask(
      { id: 't3', prompt: 'anything', verify: [] },
      {
        adapter,
        events: h.events,
        plan: h.plan,
        files: h.files,
        root: h.root,
        maxIterations: 2,
        tools: new ToolDispatcher({
          tools: [probe('git-log', 'git:read').tool, probe('http-get', 'net:http').tool],
          granted: ['git:read'],
          root: h.root,
          events: h.events,
        }),
      },
    )

    const seen = (adapter.lastMessages ?? []).map((message) => message.content).join('\n')
    expect(seen).toContain('git-log')
    expect(seen).not.toContain('http-get')
    expect(seen).toContain('checked at execution time')
  })

  it('keeps the old refusal when the build has no tool layer at all', async () => {
    // The default path, unchanged: `deps.tools` omitted means every tool action is
    // refused with the reason this engine has always given.
    const h = await harness()
    const { runTask, TOOL_UNAVAILABLE_REASON } = await import('../src/loop/index.js')
    const { FakeChatAdapter } = await import('../src/providers/fake.js')

    const adapter = new FakeChatAdapter({ script: [toolAction('anything'), DONE] })
    const result = await runTask(
      { id: 't4', prompt: 'x', verify: [] },
      {
        adapter,
        events: h.events,
        plan: h.plan,
        files: h.files,
        root: h.root,
        maxIterations: 4,
      },
    )

    const denied = result.events.filter((event) => event.kind === 'tool_denied')
    expect(denied).toHaveLength(1)
    expect(denied[0]!.payload.reason).toBe(TOOL_UNAVAILABLE_REASON)
    void PLAN
  })
})

// ── 6. the gate against a REAL SHIPPED TOOL ─────────────────────────────────
//
// Everything above section 5 proves the gate against descriptors defined in this
// file. That is worth having — it is how the six escalations are exercised without
// actually spawning curl — but it leaves one honest criticism standing: five of
// the six paths are synthetic, and only `fs:write:home` leaves evidence on disk.
//
// These two tests close that. They drive `tools/gitToolDescriptors()` — the same
// `GitTool` the Source Control panel and the `git-*` RPC methods use — against a
// REAL repository built by `git init`, and they assert on the REPOSITORY, not on
// the event log:
//
//   * without `git:write`, the commit count is unchanged and porcelain is
//     byte-identical afterwards. A `tool_denied` event proves a decision was
//     recorded; an unchanged `git log` proves nothing happened.
//   * with `git:write`, the same call really commits. Without that control the
//     first test would pass against a gate that denies everything, or against a
//     tool too broken to commit in the first place.
//
// Mutation evidence: change `git-commit`'s `requires` from `git:write` to
// `git:read` and the first test fails with a commit in the log that must not
// exist.
//
// Validates: Requirements 11.4, 11.5, 14.6

function gitVersion(): string | null {
  try {
    const probe = spawnSync('git', ['--version'], { encoding: 'utf8', shell: false })
    return probe.status === 0 ? probe.stdout.trim() : null
  } catch {
    return null
  }
}

const GIT = gitVersion()
const describeGit = GIT ? describe : describe.skip
const GIT_NOTE = GIT
  ? ` [git present: ${GIT}]`
  : ' [SKIPPED: git is not on PATH, so the real-repository gate tests cannot run]'

/** git for test SETUP and OBSERVATION only. The tool under test never uses this. */
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false })
  if (result.status !== 0) {
    throw new Error(`test setup: git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

/** A repository with one commit and one modified tracked file. */
async function repoWithDirtyFile(): Promise<string> {
  const dir = await makeProject()
  git(dir, 'init', '--quiet')
  git(dir, 'config', 'user.email', 'test@sketch.invalid')
  git(dir, 'config', 'user.name', 'Sketch Test')
  git(dir, 'checkout', '-q', '-b', 'main')
  await writeFile(join(dir, 'a.ts'), 'export const a = 1\n', 'utf8')
  git(dir, 'add', '.')
  git(dir, 'commit', '--quiet', '-m', 'initial')
  await writeFile(join(dir, 'a.ts'), 'export const a = 2\n', 'utf8')
  return dir
}

/** How many commits exist. The number the denial test is really about. */
function commitCount(dir: string): number {
  return git(dir, 'log', '--oneline').split('\n').filter((line) => line.trim() !== '').length
}

function porcelain(dir: string): string {
  return git(dir, 'status', '--porcelain', '-b')
}

const FORBIDDEN_MESSAGE = 'this commit must never exist'

describeGit(`the real git tool behind the gate${GIT_NOTE}`, () => {
  it('cannot commit without git:write, and the REPOSITORY proves it', async () => {
    const dir = await repoWithDirtyFile()
    const events = new MemoryEventStore({ secrets: [] })

    const before = { commits: commitCount(dir), porcelain: porcelain(dir) }
    expect(before.commits).toBe(1)

    // A read-only grant. This is what `commit-context` declares, and it is the
    // interesting case: the skill can see the repository and must not change it.
    const dispatcher = new ToolDispatcher({
      tools: gitToolDescriptors({ events, runId: 'git-gate-run' }),
      granted: ['git:read'],
      root: dir,
      events,
      runId: 'git-gate-run',
      skill: 'commit-context',
    })

    // The read side is genuinely reachable, so this is not a blanket denial.
    const status = await dispatcher.call('git-status')
    expect(status.ok, status.output).toBe(true)
    expect(status.output).toContain('a.ts')

    // Two real attempts to change the repository.
    const staged = await dispatcher.call('git-stage', { paths: ['a.ts'] })
    const committed = await dispatcher.call('git-commit', { message: FORBIDDEN_MESSAGE })

    // ── THE ASSERTIONS THAT MAKE THE GATE BITE ─────────────────────────────
    // Effect first, deliberately, and before anything about denials or events: a
    // `tool_denied` record proves a decision was made, an unchanged `git log`
    // proves nothing happened. If the gate ever lets these through, THIS is the
    // failure a reader sees — a commit in the log that must not exist.
    expect(git(dir, 'log', '--oneline')).not.toContain(FORBIDDEN_MESSAGE)
    expect(commitCount(dir)).toBe(before.commits)
    expect(porcelain(dir)).toBe(before.porcelain)
    // Nothing reached the index either: `a.ts` is still only modified on disk.
    expect(porcelain(dir)).toContain(' M a.ts')

    // And the refusals were capability denials, not unknown tools or tool errors.
    for (const result of [staged, committed]) {
      expect(result.denied, result.output).toBe('capability_denied')
      expect(result.missing).toBe('git:write')
      // The skill can act on the refusal instead of dying on it.
      expect(result.output).toContain('git:write')
    }

    const emitted = await events.readAll()
    const denied = emitted.filter((event) => event.kind === 'tool_denied')
    expect(denied).toHaveLength(2)
    expect(denied.map((event) => event.payload.name)).toEqual(['git-stage', 'git-commit'])
    expect(denied.every((event) => event.payload.missing === 'git:write')).toBe(true)
    // And `GitTool`'s own mutation record never fired, because `run` was never
    // reached — the gate is in front of the tool, not inside it.
    expect(emitted.some((event) => event.payload.tool === 'git')).toBe(false)
  })

  // ── the default grant, at effect level ─────────────────────────────────────
  //
  // This test is the proof obligation for the 2026-08-03 decision that put
  // `git:read` into `DEFAULT_CAPABILITIES`. The test above uses an EXPLICIT
  // `['git:read']`, so it would keep passing whatever the default happened to be.
  // This one takes its grant from `capabilitiesForSkill(undefined)` — the real
  // default path, the one a skill that declares nothing travels — and asserts on
  // the REPOSITORY: the read succeeded, and the commit count did not move.
  //
  // Mutation evidence: adding `git:write` to `DEFAULT_CAPABILITIES` fails this
  // with `this commit must never exist` in `git log`.
  it('lets a skill that declares NOTHING read the repo, and still refuses to commit', async () => {
    const dir = await repoWithDirtyFile()
    const events = new MemoryEventStore({ secrets: [] })
    const before = { commits: commitCount(dir), porcelain: porcelain(dir) }
    expect(before.commits).toBe(1)

    // No `capabilities:` key at all. Not a hand-written list — the default itself.
    const granted = capabilitiesForSkill(undefined).capabilities
    expect(granted).toEqual(DEFAULT_CAPABILITIES)

    const dispatcher = new ToolDispatcher({
      tools: gitToolDescriptors({ events, runId: 'default-grant-run' }),
      granted,
      root: dir,
      events,
      runId: 'default-grant-run',
      skill: 'declares-nothing',
    })

    // 1. THE NEW BEHAVIOUR: the read side works off the default grant alone.
    const status = await dispatcher.call('git-status')
    expect(status.ok, status.output).toBe(true)
    expect(status.output).toContain('a.ts')
    const branch = await dispatcher.call('git-branch')
    expect(branch.ok, branch.output).toBe(true)

    // 2. THE BOUNDARY THAT DID NOT MOVE: the write side is still refused.
    const staged = await dispatcher.call('git-stage', { paths: ['a.ts'] })
    const committed = await dispatcher.call('git-commit', { message: FORBIDDEN_MESSAGE })

    // Effect first. A denial event says a decision was recorded; an unchanged
    // commit count says nothing happened. This is the assertion that makes the
    // widened default safe rather than merely intended.
    expect(git(dir, 'log', '--oneline')).not.toContain(FORBIDDEN_MESSAGE)
    expect(commitCount(dir)).toBe(before.commits)
    expect(porcelain(dir)).toBe(before.porcelain)
    expect(porcelain(dir)).toContain(' M a.ts')

    for (const result of [staged, committed]) {
      expect(result.denied, result.output).toBe('capability_denied')
      expect(result.missing).toBe('git:write')
    }

    // 3. The read calls really ran and the write calls never did: `GitTool`'s own
    // mutation record is absent, because `run` was never reached.
    const emitted = await events.readAll()
    expect(
      emitted
        .filter((event) => event.kind === 'tool_denied')
        .map((event) => event.payload.name),
    ).toEqual(['git-stage', 'git-commit'])
    expect(
      emitted.filter((event) => event.payload.tool === 'git').map((event) => event.payload.action),
    ).not.toContain('commit')

    // 4. And the default grant offers only the read tools to the model.
    expect(dispatcher.availableTools.map((tool) => tool.name)).toEqual([
      'git-branch',
      'git-diff',
      'git-status',
    ])
  })

  it('commits for real when git:write IS granted, so the denial above means something', async () => {
    const dir = await repoWithDirtyFile()
    const events = new MemoryEventStore({ secrets: [] })
    const before = commitCount(dir)

    const dispatcher = new ToolDispatcher({
      tools: gitToolDescriptors({ events, runId: 'git-write-run' }),
      granted: ['git:read', 'git:write'],
      root: dir,
      events,
      runId: 'git-write-run',
      skill: 'trusted',
    })

    const staged = await dispatcher.call('git-stage', { paths: ['a.ts'] })
    expect(staged.denied, staged.output).toBeNull()
    expect(staged.ok).toBe(true)

    const committed = await dispatcher.call('git-commit', { message: 'granted commit' })
    expect(committed.denied, committed.output).toBeNull()
    expect(committed.ok).toBe(true)

    expect(commitCount(dir)).toBe(before + 1)
    expect(git(dir, 'log', '--oneline')).toContain('granted commit')
    expect(porcelain(dir)).not.toContain('a.ts')

    // Permitted calls, so no denials — and the tool's own mutation record is here
    // this time, which is what its absence in the previous test was measuring.
    const emitted = await events.readAll()
    expect(emitted.some((event) => event.kind === 'tool_denied')).toBe(false)
    expect(
      emitted.filter((event) => event.payload.tool === 'git').map((event) => event.payload.action),
    ).toEqual(['stage', 'commit'])
  })

  it('offers the read tools to a read-only grant and hides the writing ones', async () => {
    const dir = await repoWithDirtyFile()
    const dispatcher = new ToolDispatcher({
      tools: gitToolDescriptors(),
      granted: ['git:read'],
      root: dir,
    })

    expect(dispatcher.toolNames).toEqual([...GIT_TOOL_NAMES])
    expect(dispatcher.availableTools.map((tool) => tool.name)).toEqual([
      'git-branch',
      'git-diff',
      'git-status',
    ])
    const prompt = describeGrantForPrompt(dispatcher)
    expect(prompt).toContain('git-status')
    expect(prompt).not.toContain('git-commit')
  })
})
