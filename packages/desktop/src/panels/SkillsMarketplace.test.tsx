// The Skills panel, driven against the REAL engine and a REAL pinned registry.
//
// The client below dispatches the same `METHODS` table the sidecar and the dev
// bridge dispatch, in process, pointed at a temp registry whose digests were
// computed by the real `pinRegistry`. So the hash on screen is the hash the engine
// computed, the grant on screen is the grant the manifest pins, and an install
// really writes files and really refuses when a byte changed.
//
// THE ASSERTIONS THAT MATTER MOST:
//   * §1 — the fixtures are GONE. `MOCK_SKILLS`, and the two never-read copies in
//     `AppState`, are asserted absent at the source level, because a panel that
//     renders invented skill names, versions and — worst — content hashes and
//     capability grants is teaching the user to trust a fabrication.
//   * §3 — the confirmation step shows the digest and every capability BEFORE the
//     install call happens. A user who cannot see what a skill may do cannot
//     consent to it.
//   * §4 — a tampered skill is refused, and the panel shows the engine's own
//     sentence naming the file that differs.
//
// Validates: Requirements 11.1, 11.2, 11.4, 11.6, 14.6, 27.1, 27.3

import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { METHODS, capabilities as caps, registry as reg, type MethodContext } from '@sketch/core'

import { SkillsMarketplace } from './SkillsMarketplace'
import { ConfirmProvider } from '../components/ConfirmDialog'
import { SketchClientProvider } from '../lib/ClientProvider'
import {
  createEventBus,
  type EventHandler,
  type PingResult,
  type SketchClient,
  type SkillInstallResult,
  type SkillUninstallResult,
  type SkillPromoteResult,
  type SkillsCatalogResult,
  type SkillTrainResult,
} from '../lib/client'
import { AppStateProvider } from '../state/AppState'

// ── a real pinned registry on disk ──────────────────────────────────────────

const tmpDirs: string[] = []

const SKILL_MD = `---
name: commit-context
description: Explain why a file looks the way it does, from local git history.
capabilities: git:read, fs:read:project
---

# Commit context

Find the introducing commit, read its whole diff, and quote the SHA. Say when the
history is silent rather than inventing a rationale.
`

const RISKY_MD = `---
name: wide-reach
description: A skill that asks for everything, so the grant dialog has something to warn about.
capabilities: net:http, secrets:read, proc:spawn, fs:read:home
---

# Wide reach

This exists to exercise the sensitive-capability path in the install dialog.
`

const SCRIPT = 'print("history")\n'

function write(root: string, relative: string, content: string): void {
  const full = join(root, relative)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

/** Build a two-skill registry and pin it with the engine's own pinning code. */
async function makeRegistry(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'sketch-skills-ui-reg-'))
  tmpDirs.push(dir)

  write(dir, join('skills', 'commit-context', 'SKILL.md'), SKILL_MD)
  write(dir, join('skills', 'commit-context', 'tools', 'history.py'), SCRIPT)
  write(dir, join('skills', 'wide-reach', 'SKILL.md'), RISKY_MD)

  await reg.writePinnedRegistry({
    dir,
    registry: 'test-curated',
    distribution: 'curated',
    seeds: [
      {
        name: 'commit-context',
        version: '1.0.0',
        pack: 'engineering',
        summary: 'Explain why a file looks the way it does, from local git history.',
        path: 'skills/commit-context',
        capabilities: ['git:read', 'fs:read:project'],
        source: 'sketch',
        license: 'Apache-2.0',
      },
      {
        name: 'wide-reach',
        version: '0.1.0',
        pack: 'web-data',
        summary: 'A skill that asks for everything, so the dialog has something to warn about.',
        path: 'skills/wide-reach',
        capabilities: ['net:http', 'secrets:read', 'proc:spawn', 'fs:read:home'],
        source: 'sketch',
        license: 'Apache-2.0',
      },
    ],
  })
  return dir
}

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sketch-skills-ui-proj-'))
  tmpDirs.push(dir)
  return dir
}

// ── the client: the real engine, in process ─────────────────────────────────

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
  readonly installs: string[] = []
  readonly uninstalls: string[] = []
  readonly trainWrites: boolean[] = []
  readonly trainModes: Array<'rewrite' | 'edits' | undefined> = []
  readonly promotions: string[] = []
  /** A throwaway home directory for the embedded-registry fallback. */
  readonly home: string = (() => {
    const dir = mkdtempSync(join(tmpdir(), 'sketch-skills-ui-home-'))
    tmpDirs.push(dir)
    return dir
  })()

  constructor(
    private readonly registryDir: string | null,
    private readonly trainingResult?: SkillTrainResult,
  ) {}

  ping(): Promise<PingResult> {
    return Promise.resolve({ ok: true, version: 'test', transport: 'stdio' })
  }
  run(): Promise<never> {
    return Promise.reject(new Error('the skills panel never starts a run'))
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

  skillsCatalog(params: { root: string }): Promise<SkillsCatalogResult> {
    return METHODS['skills-catalog']!(
      {
        root: params.root,
        // With no registry configured the engine falls back to the curated registry it
        // embeds, materialized under `<home>/.sketch/registry` — a temp home here, so a
        // test run never writes into the developer's real home directory.
        ...(this.registryDir === null ? { home: this.home } : { registryDir: this.registryDir }),
      },
      this.ctx,
    ) as Promise<SkillsCatalogResult>
  }

  skillInstall(params: { root: string; name: string }): Promise<SkillInstallResult> {
    this.installs.push(params.name)
    return METHODS['skill-install']!(
      {
        root: params.root,
        name: params.name,
        ...(this.registryDir === null ? { home: this.home } : { registryDir: this.registryDir }),
      },
      this.ctx,
    ) as Promise<SkillInstallResult>
  }

  skillUninstall(params: { root: string; name: string }): Promise<SkillUninstallResult> {
    this.uninstalls.push(params.name)
    return METHODS['skill-uninstall']!(
      { root: params.root, name: params.name },
      this.ctx,
    ) as Promise<SkillUninstallResult>
  }

  skillTrain(params: {
    root: string
    name: string
    write?: boolean
    mode?: 'rewrite' | 'edits'
  }): Promise<SkillTrainResult> {
    this.trainWrites.push(params.write === true)
    this.trainModes.push(params.mode)
    if (this.trainingResult !== undefined) return Promise.resolve(this.trainingResult)
    return METHODS['skill-train']!(
      {
        root: params.root,
        name: params.name,
        provider: null,
        ...(params.write === true ? { write: true } : {}),
        ...(params.mode !== undefined ? { mode: params.mode } : {}),
      },
      { ...this.ctx, env: { SKETCH_FAKE_PROVIDER: '1' } },
    ) as Promise<SkillTrainResult>
  }

  skillPromote(params: { root: string; name: string }): Promise<SkillPromoteResult> {
    this.promotions.push(params.name)
    return METHODS['skill-promote']!(params, this.ctx) as Promise<SkillPromoteResult>
  }
}

/** A transport with no engine behind the capability at all. */
function withoutSkills(client: EngineClient): SketchClient {
  const stripped = Object.create(client) as SketchClient
  stripped.skillsCatalog = undefined
  stripped.skillInstall = undefined
  stripped.skillUninstall = undefined
  stripped.skillTrain = undefined
  stripped.skillPromote = undefined
  return stripped
}

function mount(root: string | null, client: SketchClient) {
  return render(
    <SketchClientProvider client={client}>
      <AppStateProvider initial={{ projectRoot: root }}>
        <ConfirmProvider>
          <SkillsMarketplace />
        </ConfirmProvider>
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

/** Mount and wait for the registry list to arrive. */
async function opened(root: string, client: SketchClient) {
  mount(root, client)
  await waitFor(() => expect(screen.getByText('commit-context')).toBeDefined(), { timeout: 5000 })
}

afterEach(() => {
  cleanup()
})

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A locked temp directory is not a test failure.
    }
  }
})

// ── 1. the fixtures are gone ────────────────────────────────────────────────

describe('the panel ships no fixture (Requirement 14.6)', () => {
  function code(relative: string): string {
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), relative), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
  }

  it('declares no MOCK_SKILLS and invents no skill names', () => {
    const panel = code('SkillsMarketplace.tsx')
    expect(panel).not.toMatch(/\b(?:MOCK|SAMPLE|EXAMPLE|FIXTURE|DEMO)_[A-Z0-9_]+/)
    // The old fixture's inventions, by name.
    for (const invented of ['Superpowers', 'AgenticLabs', 'InterviewDAO', 'TokenSaver', 'Caveman']) {
      expect(panel, invented).not.toContain(invented)
    }
    expect(panel).toContain('client.skillsCatalog')
  })

  it('leaves no second copy of skill state in AppState', () => {
    const state = code('../state/AppState.tsx')
    expect(state).not.toMatch(/installedSkills:\s*Skill\[\]/)
    expect(state).not.toMatch(/skillMarketplace:\s*Skill\[\]/)
    expect(state).not.toMatch(/case 'TOGGLE_SKILL'/)
    expect(state).not.toMatch(/case 'INSTALL_SKILL'/)
  })

  it('keeps its capability wording in step with the engine\u2019s vocabulary', () => {
    // The desktop bundle takes no runtime dependency on @sketch/core, so the
    // descriptions are duplicated. This is what stops the two drifting: every
    // capability the engine defines has UI text, and the UI invents none.
    const panel = code('SkillsMarketplace.tsx')
    for (const capability of caps.CAPABILITIES) {
      expect(panel, capability).toContain(`'${capability}'`)
    }
    const declared = [...panel.matchAll(/'((?:fs|net|proc|secrets|git):[a-z:]+)'/g)].map(
      (match) => match[1]!,
    )
    for (const capability of new Set(declared)) {
      expect(caps.isCapability(capability), `${capability} is not in the vocabulary`).toBe(true)
    }
  })
})

// ── 2. honest nothings ──────────────────────────────────────────────────────

describe('honest empty states (Requirements 27.3, 27.5)', () => {
  it('says no folder is opened, and reads nothing', async () => {
    mount(null, new EngineClient(await makeRegistry()))
    expect(await screen.findByText('No folder opened')).toBeDefined()
    expect(screen.queryByText('commit-context')).toBeNull()
  })

  it('names a transport with no engine behind the capability', async () => {
    mount(makeProject(), withoutSkills(new EngineClient(await makeRegistry())))
    expect(await screen.findByText('No engine behind this transport')).toBeDefined()
    // And says why a fabricated catalog would be worse than nothing.
    expect(document.body.textContent).toContain('content hashes')
  })

  it('falls back to the curated registry built into the engine when none is configured', async () => {
    // A shipped app is one bundled engine file with no registry/ beside it. It used to
    // report "No registry configured" and could install nothing; it now uses the
    // curated registry the engine embeds, verified exactly like any other.
    mount(makeProject(), new EngineClient(null))
    expect(await screen.findByText('commit-context')).toBeDefined()
    expect(screen.queryByText('No registry configured')).toBeNull()
  })

  it('says no registry is configured when the engine reports none, rather than showing an empty list', async () => {
    const client = new EngineClient(null)
    const reportsNone: SketchClient = Object.assign(Object.create(Object.getPrototypeOf(client)), client, {
      skillsCatalog: async (params: { root: string }): Promise<SkillsCatalogResult> => ({
        ...(await client.skillsCatalog(params)),
        entries: [],
        registryDir: null,
        diagnostic:
          'no skill registry is configured: pass params.registryDir, or set SKETCH_REGISTRY_DIR. The curated registry ships inside @sketch/core under registry/',
      }),
    })
    mount(makeProject(), reportsNone)
    expect(await screen.findByText('No registry configured')).toBeDefined()
    expect(document.body.textContent).toContain('registryDir')
  })

  it('says nothing is installed, and where it looked', async () => {
    const project = makeProject()
    await opened(project, new EngineClient(await makeRegistry()))

    fireEvent.click(screen.getByRole('tab', { name: /Installed/ }))
    expect(await screen.findByText('No skills installed')).toBeDefined()
    expect(document.body.textContent).toContain(join(project, '.sketch', 'skills'))
  })
})

// ── 3. the grant is visible before consent ──────────────────────────────────

describe('the install dialog shows what it will verify and grant (Requirement 11.4)', () => {
  it('lists the real digest and every capability before the install call', async () => {
    const registryDir = await makeRegistry()
    const client = new EngineClient(registryDir)
    await opened(makeProject(), client)

    // The manifest's own digest, so the number on screen is not decorative.
    const { manifest } = await reg.loadManifest(registryDir)
    const entry = manifest.entries.find((candidate) => candidate.name === 'commit-context')!

    fireEvent.click(screen.getAllByText('Install…')[0]!)

    const dialog = await screen.findByRole('dialog', { name: /Install commit-context/ })
    expect(dialog.textContent).toContain(entry.digest)
    expect(dialog.textContent).toContain('git:read')
    expect(dialog.textContent).toContain('fs:read:project')
    expect(dialog.textContent).toContain('Read this repository')
    // NOT INSTALLED YET. The dialog is a consent step, not a progress indicator.
    expect(client.installs).toEqual([])
  })

  it('calls out the capabilities that reach past the project', async () => {
    const registryDir = await makeRegistry()
    await opened(makeProject(), new EngineClient(registryDir))

    // `wide-reach` asks for the network, credentials, process spawning and home reads.
    const card = document.querySelector('[data-skill="wide-reach"]')!
    fireEvent.click(card.querySelector('button')!)

    const dialog = await screen.findByRole('dialog', { name: /Install wide-reach/ })
    expect(dialog.textContent).toContain('reach past this project')
    for (const sensitive of ['secrets:read', 'proc:spawn', 'fs:read:home']) {
      expect(dialog.textContent, sensitive).toContain(sensitive)
    }
    // The sensitive ones are marked in the list, not just mentioned in prose.
    expect(dialog.querySelector('[data-capability="secrets:read"]')).not.toBeNull()
  })

  it('installs nothing when the user cancels', async () => {
    const project = makeProject()
    const client = new EngineClient(await makeRegistry())
    await opened(project, client)

    fireEvent.click(screen.getAllByText('Install…')[0]!)
    fireEvent.click(await screen.findByText('Cancel'))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(client.installs).toEqual([])
    expect(existsSync(join(project, '.sketch', 'skills'))).toBe(false)
  })

  it('really installs on confirm, and shows what was verified', async () => {
    const project = makeProject()
    const client = new EngineClient(await makeRegistry())
    await opened(project, client)

    fireEvent.click(screen.getAllByText('Install…')[0]!)
    fireEvent.click(await screen.findByText('Verify and install'))

    await waitFor(() => expect(screen.getByText(/Installed commit-context/)).toBeDefined(), {
      timeout: 5000,
    })
    // Real bytes on disk, scripts included.
    expect(existsSync(join(project, '.sketch', 'skills', 'commit-context', 'SKILL.md'))).toBe(true)
    expect(
      existsSync(join(project, '.sketch', 'skills', 'commit-context', 'tools', 'history.py')),
    ).toBe(true)
    expect(document.body.textContent).toContain('2 file(s) verified')
    expect(client.installs).toEqual(['commit-context'])
  })
})

// ── 4. tamper is refused, and the panel says which file ─────────────────────

describe('a tampered skill is refused (Requirement 11.2)', () => {
  it('shows the engine\u2019s refusal, naming the file that differs', async () => {
    const registryDir = await makeRegistry()
    const project = makeProject()

    // One character in the script the manifest never mentions by name.
    write(registryDir, join('skills', 'commit-context', 'tools', 'history.py'), 'print("tampered")\n')

    await opened(project, new EngineClient(registryDir))
    fireEvent.click(screen.getAllByText('Install…')[0]!)
    fireEvent.click(await screen.findByText('Verify and install'))

    const alert = await waitFor(() => screen.getByRole('alert'), { timeout: 5000 })
    expect(alert.textContent).toContain('refusing to install')
    expect(alert.textContent).toContain('tools/history.py')
    // And nothing was written.
    expect(existsSync(join(project, '.sketch', 'skills', 'commit-context'))).toBe(false)
  })
})

// ── 5. the registry is curated, and says so ─────────────────────────────────

describe('distribution (Requirement 11.6)', () => {
  it('states that the open marketplace is not enabled', async () => {
    await opened(makeProject(), new EngineClient(await makeRegistry()))
    expect(document.body.textContent).toContain('curated')
    expect(document.body.textContent).toContain('open marketplace is not enabled')
  })
})

// ── 6. training is explicit and reports both scores ─────────────────────────

describe('training from the panel (Requirement 9.6)', () => {
  it('does not train on mount, and reports honestly with no captured evals', async () => {
    const project = makeProject()
    const client = new EngineClient(await makeRegistry())
    await opened(project, client)

    // Install first, so there is something to train.
    fireEvent.click(screen.getAllByText('Install…')[0]!)
    fireEvent.click(await screen.findByText('Verify and install'))
    await waitFor(() => expect(screen.getByText(/Installed commit-context/)).toBeDefined(), {
      timeout: 5000,
    })

    fireEvent.click(screen.getByRole('tab', { name: /Installed/ }))
    const train = await screen.findByText('Train on my project')
    expect(client.trainWrites).toEqual([])
    fireEvent.click(train)

    // No runs have been captured in this temp project, so the honest answer is that
    // there is nothing to train on — not a fabricated improvement.
    await waitFor(() => expect(document.body.textContent).toContain('at least 2 captured eval'), {
      timeout: 5000,
    })
    expect(client.trainWrites).toEqual([true])
    expect(screen.queryByText('Use trained version')).toBeNull()
  })

  it('shows the measured candidate and requires an explicit click before promotion', async () => {
    const project = makeProject()
    const registryDir = await makeRegistry()
    const artifactPath = reg.trainingArtifactPath(project, 'commit-context')
    const candidateBody = '# Commit context\n\nAlways include REVIEWED-CANDIDATE.'
    const candidate = `---\nname: commit-context\ndescription: Explain history with the trained guidance.\ncapabilities: git:read, fs:read:project\n---\n\n${candidateBody}\n`
    const client = new EngineClient(registryDir, {
      ok: true,
      name: 'commit-context',
      improved: true,
      accepted: 1,
      baselineValScore: 0.5,
      valScore: 1,
      cases: 4,
      split: { train: 2, val: 2 },
      epochs: [],
      budget: { calls: 1, tokens: 20, refusal: null },
      artifactPath,
      body: candidateBody,
    })
    await opened(project, client)

    fireEvent.click(screen.getAllByText('Install…')[0]!)
    fireEvent.click(await screen.findByText('Verify and install'))
    await waitFor(() => expect(screen.getByText(/Installed commit-context/)).toBeDefined(), {
      timeout: 5000,
    })
    write(project, join('.sketch', 'training', 'commit-context', 'best_skill.md'), candidate)

    const activePath = join(project, '.sketch', 'skills', 'commit-context', 'SKILL.md')
    expect(readFileSync(activePath, 'utf8')).not.toContain('REVIEWED-CANDIDATE')

    fireEvent.click(screen.getByRole('tab', { name: /Installed/ }))
    fireEvent.click(await screen.findByText('Train on my project'))

    const review = await screen.findByLabelText('Trained candidate for commit-context')
    expect(review.textContent).toContain('REVIEWED-CANDIDATE')
    expect(client.trainWrites).toEqual([true])
    expect(client.promotions).toEqual([])
    // Merely training and rendering the review did not replace the installed bytes.
    expect(readFileSync(activePath, 'utf8')).not.toContain('REVIEWED-CANDIDATE')

    fireEvent.click(screen.getByText('Use trained version'))
    await waitFor(() => expect(document.body.textContent).toContain('Activated commit-context'), {
      timeout: 5000,
    })
    expect(client.promotions).toEqual(['commit-context'])
    expect(readFileSync(activePath, 'utf8')).toContain('REVIEWED-CANDIDATE')
  })

  it('trains with SkillOpt small edits by default, and with a full rewrite when chosen', async () => {
    const client = new EngineClient(await makeRegistry())
    await opened(makeProject(), client)

    fireEvent.click(screen.getAllByText('Install…')[0]!)
    fireEvent.click(await screen.findByText('Verify and install'))
    await waitFor(() => expect(screen.getByText(/Installed commit-context/)).toBeDefined(), {
      timeout: 5000,
    })
    fireEvent.click(screen.getByRole('tab', { name: /Installed/ }))

    const method = (await screen.findByLabelText('Training method')) as HTMLSelectElement
    expect(method.value).toBe('edits')
    expect(document.body.textContent).toContain('Up to 4 small edits per round')

    fireEvent.click(screen.getByText('Train on my project'))
    await waitFor(() => expect(document.body.textContent).toContain('at least 2 captured eval'), {
      timeout: 5000,
    })

    fireEvent.change(method, { target: { value: 'rewrite' } })
    expect(document.body.textContent).toContain('A whole new version of the skill per round')
    fireEvent.click(screen.getByText('Train on my project'))
    await waitFor(() => expect(client.trainModes).toEqual(['edits', 'rewrite']), { timeout: 5000 })
  })

  it('lists the edits the held-out check rejected', async () => {
    const client = new EngineClient(await makeRegistry(), {
      ok: true,
      name: 'commit-context',
      improved: false,
      accepted: 0,
      baselineValScore: 0.5,
      valScore: 0.5,
      cases: 4,
      split: { train: 2, val: 2 },
      epochs: [],
      budget: { calls: 1, tokens: 20, refusal: null },
      body: '# Commit context',
      mode: 'edits',
      rejectedEdits: ['add "Always include the whole repository in the prompt."'],
    })
    await opened(makeProject(), client)

    fireEvent.click(screen.getAllByText('Install…')[0]!)
    fireEvent.click(await screen.findByText('Verify and install'))
    await waitFor(() => expect(screen.getByText(/Installed commit-context/)).toBeDefined(), {
      timeout: 5000,
    })
    fireEvent.click(screen.getByRole('tab', { name: /Installed/ }))
    fireEvent.click(await screen.findByText('Train on my project'))

    const list = await screen.findByLabelText('Rejected edits for commit-context')
    expect(list.textContent).toContain('Always include the whole repository in the prompt.')
    expect(document.body.textContent).toContain('1 edit(s) did not raise the held-out score')
    expect(document.body.textContent).toContain('Method: Small edits (SkillOpt).')
    expect(screen.queryByText('Use trained version')).toBeNull()
  })
})

// ── 7. uninstall is offered, confirmed, and removes the skill (B-002) ────────

describe('uninstall an installed skill (B-002)', () => {
  /** Install commit-context, switch to the Installed tab. */
  async function installed(project: string, client: EngineClient): Promise<void> {
    await opened(project, client)
    fireEvent.click(screen.getAllByText('Install…')[0]!)
    fireEvent.click(await screen.findByText('Verify and install'))
    await waitFor(() => expect(screen.getByText(/Installed commit-context/)).toBeDefined(), {
      timeout: 5000,
    })
    fireEvent.click(screen.getByRole('tab', { name: /Installed/ }))
    await screen.findByText('Uninstall')
  }

  it('offers an Uninstall control on every installed card', async () => {
    const project = makeProject()
    await installed(project, new EngineClient(await makeRegistry()))
    const card = document.querySelector('[data-installed="commit-context"]')!
    expect(card.textContent).toContain('Uninstall')
  })

  it('requires a destructive confirmation and removes nothing when cancelled', async () => {
    const project = makeProject()
    const client = new EngineClient(await makeRegistry())
    await installed(project, client)

    fireEvent.click(screen.getByText('Uninstall'))
    // The confirm dialog names the skill and is a destructive (alertdialog) prompt.
    const dialog = await screen.findByRole('alertdialog', { name: /Uninstall "commit-context"/ })
    expect(dialog.textContent).toContain('.sketch/skills/commit-context')
    fireEvent.click(screen.getByText('Cancel'))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(client.uninstalls).toEqual([])
    // Still on disk.
    expect(existsSync(join(project, '.sketch', 'skills', 'commit-context', 'SKILL.md'))).toBe(true)
  })

  it('removes the skill directory and grant, and the catalog shows it gone, on confirm', async () => {
    const project = makeProject()
    const client = new EngineClient(await makeRegistry())
    await installed(project, client)

    const grantPath = reg.installedSkillGrantPath(project, 'commit-context')
    expect(existsSync(grantPath)).toBe(true)

    fireEvent.click(screen.getByText('Uninstall'))
    const confirmDialog = await screen.findByRole('alertdialog', { name: /Uninstall "commit-context"/ })
    // The danger button inside the dialog (the card button also reads "Uninstall").
    const { getByText: getInDialog } = within(confirmDialog)
    fireEvent.click(getInDialog('Uninstall'))

    await waitFor(() => expect(document.body.textContent).toContain('Uninstalled commit-context'), {
      timeout: 5000,
    })
    expect(client.uninstalls).toEqual(['commit-context'])
    // The directory and the grant are gone.
    expect(existsSync(join(project, '.sketch', 'skills', 'commit-context'))).toBe(false)
    expect(existsSync(grantPath)).toBe(false)
    // The Installed tab now shows the empty state.
    expect(await screen.findByText('No skills installed')).toBeDefined()
  })

  it('shows no Uninstall control when the transport cannot uninstall', async () => {
    const project = makeProject()
    const base = new EngineClient(await makeRegistry())
    // A transport that lists/installs but has no uninstall seam.
    const noUninstall = Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
      skillUninstall: undefined,
    }) as SketchClient
    await opened(project, noUninstall)
    fireEvent.click(screen.getAllByText('Install…')[0]!)
    fireEvent.click(await screen.findByText('Verify and install'))
    await waitFor(() => expect(screen.getByText(/Installed commit-context/)).toBeDefined(), {
      timeout: 5000,
    })
    fireEvent.click(screen.getByRole('tab', { name: /Installed/ }))
    await waitFor(() =>
      expect(document.querySelector('[data-installed="commit-context"]')).not.toBeNull(),
    )
    expect(screen.queryByText('Uninstall')).toBeNull()
  })
})
