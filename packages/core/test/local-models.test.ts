// The local model manager against a stand-in Ollama server on 127.0.0.1 that speaks
// the documented API (tags, ps, show, version, pull stream, delete, generate), so
// every request is a real HTTP request over loopback.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyPullLine, type PullState } from '../src/local/ollama.js'
import { fitFor, parseNvidiaSmi, recommend } from '../src/local/hardware.js'
import { saveOfflineSetting } from '../src/privacy/offline.js'
import { METHODS } from '../src/rpc/methods.js'
import { createMethodContext } from '../src/rpc/server.js'

const GiB = 1024 ** 3
const OPEN: NodeJS.ProcessEnv = { SKETCH_OFFLINE: '' }

interface Seen {
  method: string
  path: string
  body: Record<string, unknown>
}

let server: Server
let base: string
let seen: Seen[]
let home: string

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let text = ''
    req.on('data', (chunk) => (text += chunk))
    req.on('end', () => resolve(text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)))
  })
}

beforeEach(async () => {
  seen = []
  home = await mkdtemp(join(tmpdir(), 'sketch-local-models-'))
  server = createServer(async (req, res) => {
    const body = await readBody(req)
    const path = req.url ?? ''
    seen.push({ method: req.method ?? '', path, body })
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (path === '/api/version') return send(200, { version: '0.12.6' })
    if (path === '/api/tags') {
      return send(200, {
        models: [
          { name: 'qwen2.5-coder:7b', size: 4_700_000_000, modified_at: '2026-10-01T00:00:00Z', details: { family: 'qwen2', parameter_size: '7.6B', quantization_level: 'Q4_K_M' } },
          { name: 'nomic-embed-text:latest', size: 274_000_000, details: { family: 'nomic-bert', parameter_size: '137M', quantization_level: 'F16' } },
        ],
      })
    }
    if (path === '/api/ps') return send(200, { models: [{ name: 'qwen2.5-coder:7b', size_vram: 1_000_000, expires_at: '2026-11-01T10:00:00Z' }] })
    if (path === '/api/show') {
      if (body['model'] === 'qwen2.5-coder:7b') {
        return send(200, { capabilities: ['completion', 'tools', 'insert'], model_info: { 'general.architecture': 'qwen2', 'qwen2.context_length': 32768 } })
      }
      return send(200, { capabilities: ['embedding'], model_info: { 'general.architecture': 'nomic-bert', 'nomic-bert.context_length': 2048 } })
    }
    if (path === '/api/delete') return send(200, {})
    if (path === '/api/generate') return send(200, { done: true, done_reason: body['keep_alive'] === 0 ? 'unload' : 'load' })
    if (path === '/api/pull') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write('{"status":"pulling manifest"}\n')
      res.write('{"status":"pulling aaa","digest":"sha256:aaa","total":1000,"completed":400}\n')
      res.write('{"status":"pulling bbb","digest":"sha256:bbb","total":500,"completed":500}\n')
      res.write('{"status":"pulling aaa","digest":"sha256:aaa","total":1000,"completed":1000}\n')
      res.write('{"status":"verifying sha256 digest"}\n')
      res.end('{"status":"success"}\n')
      return
    }
    send(404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(home, { recursive: true, force: true })
})

function ctx() {
  return createMethodContext('local-models', { writeFrame: () => {}, writeErr: () => {}, env: OPEN, cwd: () => process.cwd(), secrets: new Set() })
}

const call = (method: string, params: Record<string, unknown>) => METHODS[method]!({ home, baseUrl: `${base}/v1`, ...params }, ctx())

describe('local-models', () => {
  it('reports the server, each model with what it can do, and which one is loaded', async () => {
    const result = (await call('local-models', {})) as {
      server: { reachable: boolean; version: string; baseUrl: string }
      models: Array<{ name: string; capabilities: string[] | null; contextLength: number | null; loaded: boolean; quantization?: string }>
      recommendations: Array<{ name: string; installed: boolean }>
      hardware: { totalMemory: number }
    }
    expect(result.server).toMatchObject({ reachable: true, version: '0.12.6', baseUrl: base })
    const coder = result.models.find((m) => m.name === 'qwen2.5-coder:7b')!
    expect(coder).toMatchObject({ capabilities: ['completion', 'tools', 'insert'], contextLength: 32768, loaded: true, quantization: 'Q4_K_M' })
    const embed = result.models.find((m) => m.name === 'nomic-embed-text:latest')!
    expect(embed).toMatchObject({ capabilities: ['embedding'], contextLength: 2048, loaded: false })
    expect(result.hardware.totalMemory).toBeGreaterThan(0)
    expect(result.recommendations.find((r) => r.name === 'qwen2.5-coder:7b')?.installed).toBe(true)
    expect(result.recommendations.find((r) => r.name === 'nomic-embed-text')?.installed).toBe(true)
  })

  it('says plainly when no server answers', async () => {
    const result = (await METHODS['local-models']!({ home, baseUrl: 'http://127.0.0.1:9' }, ctx())) as {
      server: { reachable: boolean; error?: string }
      models: unknown[]
    }
    expect(result.server.reachable).toBe(false)
    expect(result.server.error).toBeDefined()
    expect(result.models).toEqual([])
  })
})

describe('downloading, removing, loading', () => {
  it('will not download or remove without the user agreeing first', async () => {
    await expect(call('local-model-pull', { model: 'qwen2.5-coder:3b' })).rejects.toThrow(/confirmed: true/)
    await expect(call('local-model-delete', { model: 'qwen2.5-coder:7b' })).rejects.toThrow(/confirmed: true/)
    expect(seen.filter((s) => s.path === '/api/pull' || s.path === '/api/delete')).toEqual([])
  })

  it('refuses names that are not Ollama model names', async () => {
    for (const model of ['../../etc/passwd', 'a b', '']) {
      await expect(call('local-model-load', { model })).rejects.toThrow()
    }
  })

  it('downloads in the background and reports progress summed over layers', async () => {
    const started = (await call('local-model-pull', { model: 'qwen2.5-coder:3b', confirmed: true })) as PullState
    expect(started.state).toBe('running')
    let state: PullState = started
    for (let i = 0; i < 100 && state.state === 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      state = (await METHODS['local-model-pull-status']!({ id: started.id }, ctx())) as PullState
    }
    expect(state).toMatchObject({ state: 'done', status: 'success', completed: 1500, total: 1500 })
    expect(seen.find((s) => s.path === '/api/pull')?.body).toMatchObject({ model: 'qwen2.5-coder:3b', stream: true })
  })

  it('removes, loads and unloads through the documented endpoints', async () => {
    await call('local-model-delete', { model: 'nomic-embed-text:latest', confirmed: true })
    expect(seen.find((s) => s.path === '/api/delete')).toMatchObject({ method: 'DELETE', body: { model: 'nomic-embed-text:latest' } })

    await call('local-model-load', { model: 'qwen2.5-coder:7b' })
    await call('local-model-load', { model: 'qwen2.5-coder:7b', unload: true })
    const generates = seen.filter((s) => s.path === '/api/generate').map((s) => s.body['keep_alive'])
    expect(generates).toEqual(['30m', 0])
  })

  it('refuses a download in Offline Mode but still lists what is installed', async () => {
    await saveOfflineSetting(true, { env: OPEN, home })
    await expect(call('local-model-pull', { model: 'qwen2.5-coder:3b', confirmed: true })).rejects.toThrow(/Offline Mode is on/)
    const listed = (await call('local-models', {})) as { server: { reachable: boolean } }
    expect(listed.server.reachable).toBe(true)
  })
})

describe('the pieces', () => {
  it('folds a failed pull into the job state', () => {
    const state: PullState = { id: 'x', model: 'm', state: 'running', status: '', completed: 0, total: 0, startedAt: 0 }
    applyPullLine(state, new Map(), '{"error":"pull model manifest: file does not exist"}')
    expect(state).toMatchObject({ state: 'failed', error: 'Ollama: pull model manifest: file does not exist' })
  })

  it('reads nvidia-smi output in MiB', () => {
    expect(parseNvidiaSmi('NVIDIA GeForce RTX 4090, 24564, 1200\n')).toEqual([
      { name: 'NVIDIA GeForce RTX 4090', memoryTotal: 24564 * 1024 * 1024, memoryUsed: 1200 * 1024 * 1024 },
    ])
    expect(parseNvidiaSmi('')).toEqual([])
  })

  it('recommends by memory, and caps the CPU-only pick at 10 GB', () => {
    const best = (totalGiB: number, gpuGiB = 0) =>
      recommend({ totalMemory: totalGiB * GiB, gpus: gpuGiB > 0 ? [{ name: 'gpu', memoryTotal: gpuGiB * GiB, memoryUsed: 0 }] : [] }, [])
        .find((r) => r.best)?.name
    expect(best(8)).toBe('qwen2.5-coder:3b')
    expect(best(16)).toBe('qwen2.5-coder:7b')
    expect(best(64)).toBe('qwen2.5-coder:14b')
    expect(best(64, 24)).toBe('qwen2.5-coder:32b')
    expect(fitFor(20e9, { totalMemory: 8 * GiB, gpus: [] })).toBe('too-big')
  })
})
