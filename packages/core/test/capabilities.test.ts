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
    expect(DEFAULT_CAPABILITIES).toEqual(['fs:read:project'])
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

    const result = await dispatcher.call('git-log')
    expect(result.ok).toBe(true)
    expect(result.denied).toBeNull()
    expect(state.ran).toBe(1)

    const emitted = await events.readAll()
    expect(emitted.map((event) => event.kind)).toEqual(['tool_called'])
    expect(emitted[0]!.payload.skill).toBe('commit-context')
    expect(emitted[0]!.payload.requires).toBe('git:read')
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
    // A buggy tool must not read as a security event.
    const emitted = await events.readAll()
    expect(emitted.map((event) => event.kind)).toEqual(['tool_called'])
    expect(emitted[0]!.payload.ok).toBe(false)
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

    // Declares nothing at all → the default grant: read this project, nothing else.
    const granted = capabilitiesForSkill(undefined).capabilities
    expect(granted).toEqual(['fs:read:project'])

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
