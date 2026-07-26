// End-to-end integration test.
// Uses REAL: ContextEngine, Verifier, VerifyLoop, Orchestrator, DiskFileWriter, MemoryProjectMemory.
// Uses FAKE: provider (canned responses, no network) and command runner (no shell).
// Proves the whole pipeline composes and writes real files to a temp directory.

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ContextEngine, HashEmbedder } from '../src/context/index.js'
import { Verifier, VerifyLoop } from '../src/verifier/index.js'
import type { CommandRunner, CommandOutput, DetectedProject } from '../src/verifier/index.js'
import { MemoryProjectMemory } from '../src/memory/index.js'
import { Orchestrator, Planner, AgentRunner, DiskFileWriter } from '../src/orchestrator/index.js'
import type { ContextProvider } from '../src/orchestrator/index.js'
import type {
  ProviderAdapter,
  Message,
  CompletionOptions,
  CompletionResponse,
} from '../src/providers/index.js'

// A scripted provider: returns different canned JSON depending on the system prompt,
// so the same adapter can act as both planner and runner.
class ScriptedProvider implements ProviderAdapter {
  readonly id = 'scripted'
  readonly name = 'Scripted'
  configure(): void {}
  async *stream(): AsyncIterable<never> {}
  async listModels() { return [] }
  estimateCost() { return 0 }

  async complete(_messages: Message[], options: CompletionOptions): Promise<CompletionResponse> {
    const sys = options.systemPrompt ?? ''
    let content = '{}'
    if (sys.includes('planning a coding task')) {
      content = JSON.stringify({
        summary: 'create a greeting module',
        steps: [{ id: 's1', description: 'create greet.js', files: ['greet.js'], dependsOn: [] }],
      })
    } else if (sys.includes('implementing one step')) {
      content = JSON.stringify({
        notes: 'created greet.js',
        edits: [{ path: 'greet.js', content: 'export const greet = (n) => `hi ${n}`\n' }],
      })
    }
    return { content, usage: { inputTokens: 10, outputTokens: 10 } }
  }
}

// Command runner that always passes (exit 0).
const passingRunner: CommandRunner = {
  async run(): Promise<CommandOutput> { return { exitCode: 0, stdout: 'ok', stderr: '' } },
}

// A node project with a single test check.
const nodeProject = (root: string): DetectedProject => ({
  root,
  language: 'node',
  checks: [{ name: 'test', command: 'npm', args: ['test'] }],
})

let tmp: string

async function makeTmp(): Promise<string> {
  tmp = await mkdtemp(join(tmpdir(), 'sketch-e2e-'))
  return tmp
}

describe('End-to-end pipeline', () => {
  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('plans, writes a real file, verifies, and completes', async () => {
    const root = await makeTmp()
    const provider = new ScriptedProvider()

    // Real context engine (offline hash embedder).
    const engine = new ContextEngine({ embedder: new HashEmbedder(128) })
    await engine.reindexFile('existing.js', 'export const x = 1', 'h1')
    const contextProvider: ContextProvider = {
      retrieve: (task, topK) => engine.retrieve(task, topK),
    }

    // Real verifier + loop, but with a passing fake command runner and injected project.
    const verifyLoop = new VerifyLoop(new Verifier(passingRunner))
    // Patch run to inject the detected project (temp dir has no package.json).
    const originalRun = verifyLoop.run.bind(verifyLoop)
    verifyLoop.run = (r, fixer, opts) =>
      originalRun(r, fixer, { ...opts, runner: passingRunner, project: nodeProject(root) })

    const memory = new MemoryProjectMemory(() => 1)

    const orch = new Orchestrator({
      planner: new Planner(provider, 'test-model'),
      runner: new AgentRunner(provider, 'test-model'),
      verifyLoop,
      context: contextProvider,
      memory,
      fileWriter: new DiskFileWriter(),
    })

    const events: string[] = []
    const result = await orch.run(root, 'create a greeting function', {
      onEvent: e => events.push(e.type),
    })

    // The task completed.
    expect(result.status).toBe('done')

    // A real file was written to disk with the model's content.
    const written = await readFile(join(root, 'greet.js'), 'utf8')
    expect(written).toContain('export const greet')

    // The full event sequence fired.
    expect(events).toContain('plan')
    expect(events).toContain('step_start')
    expect(events).toContain('file_edit')
    expect(events).toContain('verify')
    expect(events).toContain('done')

    // Memory captured the run.
    expect(await memory.listTestRecords()).toHaveLength(1)
    expect((await memory.listConversations())).toHaveLength(1)
  })

  it('refuses to write outside the project directory', async () => {
    const root = await makeTmp()
    const writer = new DiskFileWriter()
    await expect(
      writer.apply(root, [{ path: '../escape.js', content: 'x' }])
    ).rejects.toThrow(/outside project directory/)
  })
})
