import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { METHODS, bench, type MethodContext } from '@sketch/core'
import { BenchmarksPanel } from './BenchmarksPanel'
import { SketchClientProvider } from '../lib/ClientProvider'
import type { BenchmarkReportResult, SketchClient } from '../lib/client'
import { AppStateProvider } from '../state/AppState'

const roots: string[] = []
afterEach(async () => { cleanup(); while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }) })

const ctx: MethodContext = {
  emitEvent: () => {}, log: () => {}, rememberSecret: () => {}, secrets: () => [],
  env: {}, cwd: () => process.cwd(),
}

function client(read?: (root: string) => Promise<BenchmarkReportResult>) {
  return {
    transport: 'stdio',
    ping: vi.fn().mockResolvedValue({ ok: true, version: 'test', transport: 'stdio' }),
    run: vi.fn(), eval: vi.fn(), subscribe: () => () => {},
    gitStatus: vi.fn(), gitDiff: vi.fn(), gitStage: vi.fn(), gitUnstage: vi.fn(), gitCommit: vi.fn(),
    providerCatalog: vi.fn(), saveProviderSettings: vi.fn(), testProvider: vi.fn(),
    ...(read ? { benchmarkReport: ({ root }: { root: string }) => read(root) } : {}),
  } as unknown as SketchClient
}

function mount(root: string | null, value: SketchClient) {
  return render(<SketchClientProvider client={value}><AppStateProvider initial={{ projectRoot: root }}><BenchmarksPanel /></AppStateProvider></SketchClientProvider>)
}

async function root() { const value = await mkdtemp(join(tmpdir(), 'sketch-bench-ui-')); roots.push(value); return value }

async function writeReport(project: string) {
  const report: bench.BenchReport = {
    version: 1, createdAt: new Date(1700000000000).toISOString(), suiteId: 'suite',
    suiteDigest: `sha256:${'a'.repeat(64)}`, orderedCaseIds: ['case'],
    provider: 'synthetic-offline', model: 'offline-scripted-v1', harness: { id: 'sketch', version: '1' },
    budget: { k: 1, maxCalls: 4, maxTokens: 100, attemptTimeoutMs: 1000, suiteTimeoutMs: 2000 },
    attempts: [{ caseId: 'case', attempt: 1, seed: 'seed', status: 'completed',
      evalResult: { caseId: 'case', score: 1, passed: true, passedChecks: 1, totalChecks: 1, detail: 'ok' },
      verifyStages: [{ stage: 'build', status: 'passed' }, { stage: 'unit', status: 'passed' }],
      manualEdits: null, calls: [{ tokensIn: 1, tokensOut: 1, costUsd: null }], durationMs: 25, detail: 'ok' }],
    metrics: {} as bench.BenchMetrics,
  }
  report.metrics = bench.calculateBenchMetrics(report.attempts, report.orderedCaseIds, 1)
  await bench.writeBenchArtifact(project, report)
}

function engineRead(root: string): Promise<BenchmarkReportResult> {
  return METHODS['benchmark-report']!({ root }, ctx) as Promise<BenchmarkReportResult>
}

describe('Benchmarks panel', () => {
  it('shows honest empty states and never starts a run or eval on mount', async () => {
    const project = await root()
    const value = client(engineRead)
    mount(project, value)
    await waitFor(() => expect(screen.getByText('No benchmark report yet')).toBeTruthy())
    expect(screen.getByText(/never starts a model call, build, or test/)).toBeTruthy()
    expect(value.run).not.toHaveBeenCalled()
    expect(value.eval).not.toHaveBeenCalled()
  })

  it('renders every required metric from a validated real artifact', async () => {
    const project = await root()
    await writeReport(project)
    mount(project, client(engineRead))
    await waitFor(() => expect(screen.getByText('offline-scripted-v1 + Sketch')).toBeTruthy())
    const metrics = screen.getByLabelText('Benchmark metrics').textContent ?? ''
    expect(metrics).toContain('Task completion100.0%')
    expect(metrics).toContain('Build success100.0%')
    expect(metrics).toContain('Test pass100.0%')
    expect(metrics).toContain('Manual editsnot observed')
    expect(metrics).toContain('Costunknown')
    expect(screen.getByLabelText('Pass distribution').textContent).toContain('1 of 1 passes')
    expect(screen.getByText(/never claims Sketch beats a model/)).toBeTruthy()
  })

  it('refuses to fabricate data without an engine and is reachable in navigation', async () => {
    mount(await root(), client())
    expect(screen.getByText('No engine behind this transport')).toBeTruthy()
    expect(screen.queryByLabelText('Benchmark metrics')).toBeNull()
    const activity = await import('../testing/source').then(({ readCode }) => readCode('components/ide/ActivityBar.tsx'))
    const side = await import('../testing/source').then(({ readCode }) => readCode('components/ide/SidePanel.tsx'))
    expect(activity).toContain("id: 'benchmarks'")
    expect(side).toContain("case 'benchmarks'")
  })
})