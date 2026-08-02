// Phase 12.5 gate: host-owned production extension contracts through canonical,
// RPC, host, and workflow execution paths.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ToolDispatcher } from '../src/capabilities/index.js'
import {
  createEngineExtensionRegistry as createExtensionBundle,
  type EngineExtensionRegistry,
} from '../src/extensions/index.js'
import { McpHost, type McpCatalogEntry } from '../src/mcp/index.js'
import { InMemoryStore, JsonlMemoryStore } from '../src/memory/index.js'
import { FakeChatAdapter } from '../src/providers/index.js'
import { METHODS, InvalidParamsError } from '../src/rpc/methods.js'
import { createMethodContext } from '../src/rpc/server.js'
import type { ChatAdapter, Message, ProviderConfig, RunResult } from '../src/types.js'

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

async function tempRoot(prefix = 'sketch-phase12-ext-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function context(root: string, extensions?: EngineExtensionRegistry, env: NodeJS.ProcessEnv = {}) {
  const logs: string[] = []
  const frames: unknown[] = []
  return {
    logs,
    frames,
    ctx: createMethodContext('phase12.5', {
      writeFrame: (frame) => frames.push(frame),
      writeErr: (line) => logs.push(line),
      env,
      cwd: () => root,
      secrets: new Set(),
      ...(extensions === undefined ? {} : { extensions }),
    }),
  }
}

const providerDescriptor = {
  id: 'host-scripted',
  name: 'Host Scripted',
  kind: 'openai-compatible' as const,
  defaultBaseUrl: 'https://host.invalid/v1',
  needsKey: false,
  serverless: false,
}
function scriptedFactory(record: {
  factoryCalls: number
  modelCalls: number
  configs: ProviderConfig[]
  adapters: ChatAdapter[]
}) {
  return (config: ProviderConfig): ChatAdapter => {
    record.factoryCalls++
    record.configs.push(config)
    let turn = 0
    const adapter: ChatAdapter = {
      id: providerDescriptor.id,
      chat: async (messages: readonly Message[]) => {
        record.modelCalls++
        const isPlanAgent = messages.some((message) => message.content.includes('plan artifact'))
        if (isPlanAgent && turn++ === 0) {
          return {
            text: JSON.stringify({ action: 'plan', artifacts: { prd: 'A deterministic host plan.' } }),
            usage: { in: 1, out: 1 },
          }
        }
        return {
          text: JSON.stringify({ action: 'done', text: 'host adapter completed' }),
          usage: { in: 1, out: 1 },
        }
      },
    }
    record.adapters.push(adapter)
    return adapter
  }
}

const externalMcp: McpCatalogEntry = {
  id: 'host-mcp',
  title: 'Host MCP',
  summary: 'A pinned host-supplied test server.',
  requires: 'proc:spawn',
  launch: {
    command: 'npx',
    args: ['-y', 'host-mcp-package@1.2.3', '--label', 'two words'],
  },
  requiresEnv: ['HOST_MCP_TOKEN'],
}

const WORKING_MCP_SERVER = `
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const at = buffer.indexOf('\\n')
    if (at === -1) break
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (line.trim() === '') continue
    const request = JSON.parse(line)
    const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
    if (request.method === 'initialize') send({ protocolVersion: '2024-11-05', capabilities: { tools: {} } })
    else if (request.method === 'tools/list') send({ tools: [{ name: 'echo', description: 'Echo host text' }] })
    else if (request.method === 'tools/call') send({ content: [{ type: 'text', text: 'host echo: ' + String(request.params.arguments.text) }] })
  }
})
setInterval(() => {}, 1000)
`

const planAgent = {
  id: 'z-plan-agent',
  version: '1.4.0',
  title: 'Host Planner',
  instruction: 'Write one small plan and nothing else.',
  signal: { kind: 'plan-artifact' as const },
  capabilities: ['fs:read:project', 'fs:write:project'] as const,
  edits: false,
  blocking: false,
}

const unavailableAgent = {
  id: 'a-integration-agent',
  version: '2.0.1',
  title: 'Integration Agent',
  instruction: 'Run the configured integration signal.',
  signal: { kind: 'verify-stage' as const, stage: 'integration' as const },
  capabilities: ['proc:spawn'] as const,
  edits: true,
  blocking: true,
}

describe('Phase 12.5 provider and MCP registrations', () => {
  it('uses canonical fresh provider factories in RPC while the fake override wins first', async () => {
    const root = await tempRoot()
    const record = { factoryCalls: 0, modelCalls: 0, configs: [] as ProviderConfig[], adapters: [] as ChatAdapter[] }
    const extensions = createExtensionBundle({
      providers: [{ descriptor: providerDescriptor, factory: scriptedFactory(record) }],
    })

    const first = extensions.providers.resolve({
      id: providerDescriptor.id, kind: providerDescriptor.kind, baseUrl: '', model: 'host-model',
    }, {})
    const second = extensions.providers.resolve({
      id: providerDescriptor.id, kind: providerDescriptor.kind, baseUrl: '', model: 'host-model',
    }, {})
    expect(first).not.toBe(second)
    expect(record.factoryCalls).toBe(2)
    expect(record.configs.map((config) => config.baseUrl)).toEqual([
      providerDescriptor.defaultBaseUrl, providerDescriptor.defaultBaseUrl,
    ])

    const fake = extensions.providers.resolve({
      id: providerDescriptor.id, kind: providerDescriptor.kind, baseUrl: '', model: 'host-model',
    }, { SKETCH_FAKE_PROVIDER: '1' })
    expect(fake).toBeInstanceOf(FakeChatAdapter)
    expect(record.factoryCalls).toBe(2)

    const { ctx } = context(root, extensions)
    const catalog = await METHODS['provider-catalog']!({ home: root }, ctx) as {
      catalog: Array<{ id: string; name: string }>
    }
    expect(catalog.catalog.at(-1)).toMatchObject({ id: providerDescriptor.id, name: providerDescriptor.name })

    const result = await METHODS.run({
      root,
      provider: { id: providerDescriptor.id, kind: providerDescriptor.kind, baseUrl: '', model: 'host-model' },
      task: { id: 'host-provider-run', prompt: 'Complete through the host provider.', verify: [] },
    }, ctx) as RunResult
    expect(result.ok).toBe(true)
    expect(result.finalText).toBe('host adapter completed')
    expect(record.factoryCalls).toBe(3)
  })

  it('preserves external MCP argv and refuses unknown, missing-env, and ungranted launches', async () => {
    const root = await tempRoot()
    const extensions = createExtensionBundle({ mcp: [externalMcp] })
    const { ctx, logs } = context(root, extensions, { SKETCH_FAKE_PROVIDER: '1' })
    const report = await METHODS['mcp-catalog']!({}, ctx) as {
      servers: Array<{
        id: string
        launch: { command: string; args: string[] }
        requires: string
        requiresEnv: string[]
        missingEnv: string[]
      }>
    }
    const entry = report.servers.find((server) => server.id === externalMcp.id)!
    expect(entry.launch).toEqual(externalMcp.launch)
    expect(entry.requires).toBe('proc:spawn')
    expect(entry.requiresEnv).toEqual(['HOST_MCP_TOKEN'])
    expect(entry.missingEnv).toEqual(['HOST_MCP_TOKEN'])

    const host = new McpHost({ root, catalog: extensions.mcp, allowedLaunches: new Set(), env: {} })
    expect(await host.open('not-registered')).toMatchObject({ ok: false, tools: [] })
    const denied = await host.open(externalMcp.id)
    expect(denied.ok).toBe(false)
    expect(denied.detail).toContain('not approved for launch')
    expect(host.openIds).toEqual([])

    const missingEnvHost = new McpHost({
      root, catalog: extensions.mcp, allowedLaunches: new Set([externalMcp.id]), env: {},
    })
    const missing = await missingEnvHost.open(externalMcp.id)
    expect(missing).toMatchObject({ ok: false, missingEnv: ['HOST_MCP_TOKEN'] })
    expect(missingEnvHost.openIds).toEqual([])

    const script = join(root, 'host-mcp.mjs')
    await writeFile(script, WORKING_MCP_SERVER, 'utf8')
    const workingHost = new McpHost({
      root,
      catalog: extensions.mcp,
      allowedLaunches: new Set([externalMcp.id]),
      env: { HOST_MCP_TOKEN: 'present' },
      launchOverrides: {
        [externalMcp.id]: { id: externalMcp.id, command: process.execPath, args: [script] },
      },
      requestTimeoutMs: 2_000,
      handshakeTimeoutMs: 2_000,
    })
    try {
      const opened = await workingHost.open(externalMcp.id)
      expect(opened).toMatchObject({ ok: true, tools: ['host-mcp.echo'] })
      expect(workingHost.descriptors()).toHaveLength(1)
      expect(workingHost.descriptors()[0]).toMatchObject({
        name: 'host-mcp.echo',
        requires: externalMcp.requires,
      })

      const deniedDispatcher = new ToolDispatcher({
        tools: workingHost.descriptors(), granted: [], root, runId: 'denied-host-mcp',
      })
      await expect(deniedDispatcher.call('host-mcp.echo', { text: 'blocked' })).resolves.toMatchObject({
        ok: false, denied: 'capability_denied', missing: 'proc:spawn',
      })

      const allowedDispatcher = new ToolDispatcher({
        tools: workingHost.descriptors(), granted: ['proc:spawn'], root, runId: 'allowed-host-mcp',
      })
      await expect(allowedDispatcher.call('host-mcp.echo', { text: 'permitted' })).resolves.toMatchObject({
        ok: true, denied: null,
      })
      expect((await allowedDispatcher.call('host-mcp.echo', { text: 'visible' })).output)
        .toContain('host echo: visible')
    } finally {
      await workingHost.close()
    }

    await METHODS.run({
      root,
      mcpServers: [externalMcp.id],
      task: { id: 'host-mcp-run', prompt: 'Do not launch an ungranted server.', verify: [] },
    }, ctx)
    expect(logs.some((line) => line.includes(`not starting ${externalMcp.title}`))).toBe(true)
    expect(logs).toContain('mcp: 0 server(s) open, 0 tool(s) reachable with fs:read:project')
  })

  it('rejects malformed external production registrations before they enter a host', () => {
    expect(() => createExtensionBundle({
      providers: [{
        descriptor: { ...providerDescriptor, needsKey: 'yes' as unknown as boolean },
        factory: () => ({ id: 'bad', chat: async () => ({ text: '', usage: { in: 0, out: 0 } }) }),
      }],
    })).toThrow(/needsKey and serverless must be booleans/)

    expect(() => createExtensionBundle({
      mcp: [{ ...externalMcp, launch: { command: 'npx', args: ['host-mcp-package@latest'] } }],
    })).toThrow(/pin an exact package version/)

    expect(() => createExtensionBundle({
      agents: [{ ...planAgent, capabilities: ['not:a:capability' as never] }],
    })).toThrow(/unrecognized capability/)
  })
})

describe('Phase 12.5 memory, agent, and workflow registrations', () => {
  it('selects a host memory factory through RPC, defaults to JSONL, and refuses unknown ids', async () => {
    const root = await tempRoot()
    let memoryId = 0
    const store = new InMemoryStore({ ids: () => `memory-${++memoryId}` })
    const selectedRoots: string[] = []
    const extensions = createExtensionBundle({
      memoryStores: [{
        id: 'host-memory',
        factory: (selectedRoot) => {
          selectedRoots.push(selectedRoot)
          return store
        },
      }],
    })
    const { ctx } = context(root, extensions)

    const remembered = await METHODS['memory-remember']!({
      root,
      memoryStore: 'host-memory',
      kind: 'decision',
      key: 'architecture',
      text: 'Use the first host memory decision.',
    }, ctx) as { entry: { id: string; text: string } }
    expect(remembered.entry).toMatchObject({ id: 'memory-1', text: 'Use the first host memory decision.' })

    const replacement = await METHODS['memory-remember']!({
      root,
      memoryStore: 'host-memory',
      kind: 'decision',
      key: 'architecture',
      text: 'Use the newer host memory decision.',
      reason: 'the architecture changed',
    }, ctx) as { entry: { id: string }; superseded: { id: string; reason: string } }
    expect(replacement.entry.id).toBe('memory-2')
    expect(replacement.superseded).toEqual(
      expect.objectContaining({ id: 'memory-1', reason: 'the architecture changed' }),
    )

    const search = await METHODS['memory-search']!({
      root, memoryStore: 'host-memory', query: 'newer host architecture decision',
    }, ctx) as { hits: Array<{ entry: { id: string; text: string } }> }
    expect(search.hits.map((hit) => hit.entry.id)).toContain('memory-2')
    expect(search.hits.map((hit) => hit.entry.id)).not.toContain('memory-1')

    const listed = await METHODS['memory-list']!({ root, memoryStore: 'host-memory' }, ctx) as {
      entries: Array<{ id: string; current: boolean; reason?: string }>
    }
    expect(listed.entries.find((entry) => entry.id === 'memory-1')).toMatchObject({
      current: false, reason: 'the architecture changed',
    })
    expect(listed.entries.find((entry) => entry.id === 'memory-2')).toMatchObject({ current: true })
    expect(selectedRoots).toEqual([root, root, root, root])

    const closed = await METHODS['memory-supersede']!({
      root,
      memoryStore: 'host-memory',
      id: 'memory-2',
      reason: 'explicit host cleanup',
    }, ctx) as { ok: boolean; closed: { validTo: number | null; reason?: string } }
    expect(closed).toMatchObject({ ok: true, closed: { reason: 'explicit host cleanup' } })
    expect(closed.closed.validTo).not.toBeNull()

    await expect(METHODS['memory-list']!({ root, memoryStore: 'unknown-store' }, ctx))
      .rejects.toBeInstanceOf(InvalidParamsError)

    const defaultResult = await METHODS['memory-remember']!({
      root, kind: 'decision', text: 'The default remains persistent JSONL.',
    }, ctx) as { entry: { text: string } }
    expect(defaultResult.entry.text).toContain('persistent JSONL')
    const defaultStore = new JsonlMemoryStore({ baseDir: root })
    expect((await defaultStore.all()).some((entry) => entry.text.includes('persistent JSONL'))).toBe(true)
  })

  it('runs registered agents only through an explicit versioned workflow in deterministic order', async () => {
    const root = await tempRoot()
    const record = { factoryCalls: 0, modelCalls: 0, configs: [] as ProviderConfig[], adapters: [] as ChatAdapter[] }
    let workflowCalls = 0
    const extensions = createExtensionBundle({
      providers: [{ descriptor: providerDescriptor, factory: scriptedFactory(record) }],
      agents: [planAgent, unavailableAgent],
      workflows: [{
        descriptor: {
          id: 'host-pipeline',
          version: '3.2.1',
          description: 'Run a fixed host-owned agent sequence.',
        },
        execute: async ({ runAgent }) => {
          workflowCalls++
          const first = await runAgent(planAgent.id, { context: 'First and deterministic.' })
          const second = await runAgent(unavailableAgent.id)
          return { identity: 'host-pipeline@3.2.1', executions: [first, second] }
        },
      }],
    })
    const { ctx } = context(root, extensions)
    const provider = {
      id: providerDescriptor.id, kind: providerDescriptor.kind,
      baseUrl: providerDescriptor.defaultBaseUrl, model: 'host-model',
    }

    const normal = await METHODS.run({
      root, provider,
      task: { id: 'default-stays-single', prompt: 'Use the unchanged default run.', verify: [] },
    }, ctx) as RunResult
    expect(normal.ok).toBe(true)
    expect(workflowCalls).toBe(0)

    const catalog = await METHODS['strategy-catalog']!({ root }, ctx) as {
      defaultStrategy: string
      customAgents: Array<{ id: string; version: string; edits: boolean; blocking: boolean }>
      workflows: Array<{ id: string; version: string }>
    }
    expect(catalog.defaultStrategy).toBe('single')
    expect(catalog.customAgents.map((agent) => agent.id)).toEqual([
      unavailableAgent.id, planAgent.id,
    ])
    expect(catalog.customAgents.find((agent) => agent.id === unavailableAgent.id)).toMatchObject({
      version: unavailableAgent.version, edits: true, blocking: true,
    })
    expect(catalog.workflows).toEqual([{
      id: 'host-pipeline', version: '3.2.1', description: 'Run a fixed host-owned agent sequence.',
    }])

    const callsBeforeWorkflow = record.modelCalls
    const executed = await METHODS.run({
      root, provider, workflow: 'host-pipeline',
      task: { id: 'explicit-workflow', prompt: 'Execute the registered workflow.', verify: [] },
    }, ctx) as {
      identity: string
      executions: Array<{
        agent: { id: string; version: string; instruction: string; signal: { kind: string } }
        ran: boolean
        skipped: string | null
        capabilities: string[]
        run: RunResult | null
        grade: { passed: boolean } | null
      }>
    }
    expect(executed.identity).toBe('host-pipeline@3.2.1')
    expect(executed.executions.map((entry) => entry.agent.id)).toEqual([
      planAgent.id, unavailableAgent.id,
    ])
    expect(executed.executions[0]).toMatchObject({
      ran: true,
      skipped: null,
      capabilities: ['fs:read:project'],
      agent: {
        version: planAgent.version,
        instruction: planAgent.instruction,
        signal: { kind: 'plan-artifact' },
      },
      grade: { passed: true },
    })
    expect(executed.executions[0]!.run?.events.some((event) => event.kind === 'plan_written')).toBe(true)
    expect(executed.executions[1]).toMatchObject({
      ran: false,
      capabilities: [],
      run: null,
      grade: null,
    })
    expect(executed.executions[1]!.skipped).toContain('integration')
    // Only the verifiable planner reached the model (plan then done). The unavailable
    // agent was rejected before its sub-run could spend a turn.
    expect(record.modelCalls - callsBeforeWorkflow).toBe(2)
    expect(workflowCalls).toBe(1)

    await expect(METHODS.run({
      root, provider, workflow: 'not-registered',
      task: { id: 'unknown-workflow', prompt: 'Refuse this.', verify: [] },
    }, ctx)).rejects.toBeInstanceOf(InvalidParamsError)
    expect(workflowCalls).toBe(1)
  })
})
