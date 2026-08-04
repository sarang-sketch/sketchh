// The Test Results panel, driven against the REAL engine and REAL processes.
//
// The client below dispatches the same `METHODS` table the sidecar dispatches, in
// process, pointed at a temp project with a REAL `verify.yaml`. So the stages on screen
// are the stages the engine parsed, and pressing Run really spawns the commands and
// really captures their output.
//
// THE ASSERTIONS THAT MATTER MOST:
//   * §1 — mounting does NOT run anything. A panel that ran a project's build and test
//     suite because a user clicked a sidebar icon would be a trap, and for a policy with
//     a `live` check it would bind a port.
//   * §2 — all nine stages are listed, configured or not, because "lint is not set up
//     here" is information.
//   * §3 — `skipped` and `not-run` are DIFFERENT on screen. Nothing ran either way, but
//     one means "configure something" and the other means "fix the failure above".
//   * §4 — a failure expands to the command's REAL stderr with its real exit code.
//   * §5 — no engine, no report. Nine invented green badges are a claim that a
//     project's tests pass, and a user who believes one ships broken code.
//
// Validates: Requirements 4.3, 4.4, 4.7, 4.8, 27.1

import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { METHODS, type MethodContext } from '@sketch/core'

import { TestResults } from './TestResults'
import { SketchClientProvider } from '../lib/ClientProvider'
import {
  createEventBus,
  type EventHandler,
  type PingResult,
  type SketchClient,
  type VerifyContractResult,
} from '../lib/client'
import { AppStateProvider } from '../state/AppState'

const tmpDirs: string[] = []

function makeProject(policy?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sketch-verify-ui-'))
  tmpDirs.push(dir)
  // No `package.json`: detection must not fire and quietly supply stages the test did
  // not ask for.
  if (policy !== undefined) writeFileSync(join(dir, 'verify.json'), policy, 'utf8')
  return dir
}

/**
 * A policy with three real stages: one that passes, one that fails, and one after the
 * failure. `node -e` is used because it is the one interpreter this suite already
 * requires, so nothing here depends on what else the machine has installed.
 */
function policyWithAFailure(): string {
  return JSON.stringify({
    format: [{ name: 'format', cmd: process.execPath, args: ['-e', 'console.log("formatted 3 files")'] }],
    lint: [
      {
        name: 'lint',
        cmd: process.execPath,
        args: ['-e', 'console.error("app.ts:4:11 no-unused-vars"); process.exit(1)'],
      },
    ],
    unit: [{ name: 'unit', cmd: process.execPath, args: ['-e', 'console.log("12 passed")'] }],
  })
}

function methodContext(): MethodContext {
  return {
    emitEvent: () => {},
    log: () => {},
    rememberSecret: () => {},
    secrets: () => [],
    env: {},
    cwd: () => process.cwd(),
  }
}

class EngineClient implements SketchClient {
  readonly transport = 'stdio' as const
  private readonly bus = createEventBus()
  private readonly ctx = methodContext()
  /** Every verify call, so a test can prove mounting did not run the gauntlet. */
  readonly calls: Array<{ root: string; run?: boolean }> = []

  ping(): Promise<PingResult> {
    return Promise.resolve({ ok: true, version: 'test', transport: 'stdio' })
  }
  run(): Promise<never> {
    return Promise.reject(new Error('the test results panel never starts an agent run'))
  }
  /** This panel starts no run, so it has none to stop. */
  
/** This surface starts no interactive run, so nothing awaits an answer. */

reply(): Promise<never> {
  return Promise.reject(new Error('this surface never answers a question'))
}

cancel(): Promise<never> {
    return Promise.reject(new Error('this surface never cancels a run'))
  }

  eval(): Promise<never[]> {
    return Promise.resolve([])
  }
  subscribe(handler: EventHandler) {
    return this.bus.subscribe(handler)
  }
  gitStatus(): Promise<never> {
    return Promise.reject(new Error('unused'))
  }
  gitDiff(): Promise<never> {
    return Promise.reject(new Error('unused'))
  }
  gitStage(): Promise<never> {
    return Promise.reject(new Error('unused'))
  }
  gitUnstage(): Promise<never> {
    return Promise.reject(new Error('unused'))
  }
  gitCommit(): Promise<never> {
    return Promise.reject(new Error('unused'))
  }
  providerCatalog(): Promise<never> {
    return Promise.reject(new Error('unused'))
  }
  saveProviderSettings(): Promise<never> {
    return Promise.reject(new Error('unused'))
  }
  testProvider(): Promise<never> {
    return Promise.reject(new Error('unused'))
  }

  verify(params: {
    root: string
    run?: boolean
    continueOnFailure?: boolean
  }): Promise<VerifyContractResult> {
    this.calls.push({ root: params.root, ...(params.run !== undefined ? { run: params.run } : {}) })
    return METHODS['verify']!(
      {
        root: params.root,
        ...(params.run === true ? { run: true } : {}),
        ...(params.continueOnFailure !== undefined
          ? { continueOnFailure: params.continueOnFailure }
          : {}),
      },
      this.ctx,
    ) as Promise<VerifyContractResult>
  }
}

/** A transport with no engine behind the capability at all. */
function withoutVerify(client: EngineClient): SketchClient {
  const stripped = Object.create(client) as SketchClient
  stripped.verify = undefined
  return stripped
}

function mount(root: string | null, client: SketchClient) {
  return render(
    <SketchClientProvider client={client}>
      <AppStateProvider initial={{ projectRoot: root }}>
        <TestResults />
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

afterEach(cleanup)
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

// ── 1. mounting reads the contract and runs NOTHING ─────────────────────────

describe('mounting', () => {
  it('resolves the contract without executing a single command', async () => {
    const root = makeProject(policyWithAFailure())
    const client = new EngineClient()
    mount(root, client)

    await waitFor(() => expect(screen.getByText(/Contract read from/)).toBeTruthy())

    // One call, and it did not ask to run. Running the project's build and test suite
    // because a panel mounted would be a trap.
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0]!.run).toBeUndefined()

    // And the panel says so, rather than showing empty badges that look like results.
    expect(screen.getByText(/Nothing has run yet/)).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('says when nothing could be resolved, and that a trivial pass is not evidence', async () => {
    // Empty project: no policy file, and nothing detection recognises.
    const root = makeProject()
    mount(root, new EngineClient())

    await waitFor(() =>
      expect(screen.getByText(/no stage could be detected for this project/)).toBeTruthy(),
    )
    expect(screen.getByText(/That is not evidence of verification/)).toBeTruthy()
  })
})

// ── 2. all nine stages, configured or not ───────────────────────────────────

describe('the contract', () => {
  const NINE = [
    'format',
    'lint',
    'typecheck',
    'build',
    'unit',
    'integration',
    'security',
    'performance',
    'dependency-audit',
  ]

  it('lists every stage in contract order, including the ones this project skips', async () => {
    const root = makeProject(policyWithAFailure())
    mount(root, new EngineClient())

    await waitFor(() => expect(screen.getByText(/Contract read from/)).toBeTruthy())

    const listed = screen
      .getByLabelText('Verification stages')
      .querySelectorAll('[class*="stageName"]')
    expect([...listed].map((node) => node.textContent)).toEqual(NINE)
  })

  it('shows the actual command lines for a configured stage', async () => {
    const root = makeProject(policyWithAFailure())
    mount(root, new EngineClient())

    await waitFor(() => expect(screen.getByText(/Contract read from/)).toBeTruthy())
    // The argv as the policy wrote it, so a user can see what would run.
    expect(screen.getByText(/formatted 3 files/)).toBeTruthy()
  })

  it('explains an unconfigured stage instead of leaving it blank', async () => {
    const root = makeProject(policyWithAFailure())
    mount(root, new EngineClient())

    await waitFor(() => expect(screen.getByText(/Contract read from/)).toBeTruthy())
    // Six of the nine are unconfigured here, and each says why it is grey.
    expect(screen.getAllByText(/No command is configured for this stage/).length).toBe(6)
  })
})

// ── 3. running: real processes, real output, and the four distinct statuses ──

describe('running the gauntlet', () => {
  it('runs only when the button is pressed, and reports the real failure', async () => {
    const root = makeProject(policyWithAFailure())
    const client = new EngineClient()
    mount(root, client)

    await waitFor(() => expect(screen.getByText(/Contract read from/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Run verification/ }))

    await waitFor(
      () => expect(screen.getByRole('status').textContent).toContain('Failed at lint'),
      { timeout: 15_000 },
    )

    // Two calls now: the mount's resolve, and this run.
    expect(client.calls.map((call) => call.run === true)).toEqual([false, true])
  })

  it('keeps “not configured” and a real failure visually and textually distinct', async () => {
    const root = makeProject(policyWithAFailure())
    mount(root, new EngineClient())

    await waitFor(() => expect(screen.getByText(/Contract read from/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Run verification/ }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Failed at lint'), {
      timeout: 15_000,
    })

    // A word, not only a colour: the two greys would be indistinguishable otherwise,
    // and they call for opposite responses.
    expect(screen.getAllByText('not configured').length).toBe(6)
    expect(screen.getAllByText('passed').length).toBeGreaterThan(0)
    expect(screen.getAllByText('failed').length).toBeGreaterThan(0)
  })

  it('expands a failure to the command’s REAL stderr and exit code', async () => {
    const root = makeProject(policyWithAFailure())
    mount(root, new EngineClient())

    await waitFor(() => expect(screen.getByText(/Contract read from/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Run verification/ }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Failed at lint'), {
      timeout: 15_000,
    })

    // Failures open themselves; the whole value of the panel is the output.
    const stderr = await screen.findByLabelText('lint stderr')
    expect(stderr.textContent).toContain('app.ts:4:11 no-unused-vars')
    expect(screen.getByText(/exit 1/)).toBeTruthy()
  })

  it('reports a full run, not a fail-fast one, so every failure is visible at once', async () => {
    const root = makeProject(
      JSON.stringify({
        lint: [{ name: 'lint', cmd: process.execPath, args: ['-e', 'process.exit(1)'] }],
        unit: [{ name: 'unit', cmd: process.execPath, args: ['-e', 'process.exit(1)'] }],
      }),
    )
    mount(root, new EngineClient())

    await waitFor(() => expect(screen.getByText(/Contract read from/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Run verification/ }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Failed at lint'), {
      timeout: 15_000,
    })

    // BOTH failures. A user fixing lint and then discovering the tests separately is
    // the reason this method defaults to continuing.
    expect(screen.getByRole('status').textContent).toContain('2 failed')
    expect(screen.queryAllByText('not run')).toHaveLength(0)
  })
})

// ── 4. malformed policy is never silent ─────────────────────────────────────

describe('a malformed policy file', () => {
  it('shows the diagnostic rather than silently falling back to detection', async () => {
    const root = makeProject('{ this is not json')
    mount(root, new EngineClient())

    await waitFor(() => expect(screen.getByLabelText('Policy file diagnostics')).toBeTruthy())
    // Requirement 4.4's real risk: a project whose tests silently stopped running.
    expect(screen.getByLabelText('Policy file diagnostics').textContent).toBeTruthy()
  })
})

// ── 5. no engine, no report ─────────────────────────────────────────────────

describe('honest empty states', () => {
  it('refuses to invent a report when the transport has no engine', async () => {
    const client = withoutVerify(new EngineClient())
    mount(makeProject(policyWithAFailure()), client)

    expect(screen.getByText('No engine behind this transport')).toBeTruthy()
    expect(screen.getByText(/worse than showing nothing/)).toBeTruthy()
    // Not one badge. Nine invented green badges are a claim about someone's code.
    expect(screen.queryByLabelText('Verification stages')).toBeNull()
  })

  it('says why it is empty when no folder is open', () => {
    mount(null, new EngineClient())
    expect(screen.getByText('No folder opened')).toBeTruthy()
    expect(screen.queryByLabelText('Verification stages')).toBeNull()
  })
})
