// Skills — the curated registry, what is installed, and what each one is allowed
// to do.
//
// WHAT REPLACED WHAT. This panel used to render `MOCK_SKILLS`: eight invented
// skills with invented authors and versions. Two more copies of the same fiction
// lived in `AppState` as `installedSkills` and `skillMarketplace`, neither of which
// was ever read by anything. All three are gone. Every row here comes from
// `skills-catalog` over the client seam — the pinned manifest for what is
// available, and the filesystem for what is installed.
//
// ── THE SECURITY MODEL IS THE UI ────────────────────────────────────────────
//
// The install confirmation shows the CONTENT HASH that will be verified and every
// CAPABILITY the skill will be granted, in plain words, before the user says yes.
// That is not decoration: a user who cannot see what a skill is allowed to do
// cannot consent to it, and a capability system nobody can see teaches nobody
// anything. Sensitive grants (home directory, spawning processes, reading
// credentials) are called out separately, because those are the ones that reach
// past the project.
//
// The install itself verifies the hash in the engine and refuses on any difference
// (`packages/core/src/registry/install.ts`). This panel cannot ask it not to —
// there is no force control here because there is no force parameter there.
//
// ── ONE PLACE SKILL STATE LIVES ─────────────────────────────────────────────
//
// The catalog is fetched and held here, and re-fetched after any mutation. There is
// no second copy in `AppState`, for the same reason there is exactly one file cache
// (task 3.1): two stores of the same truth diverge, and the one the user is looking
// at is the one that is wrong.
//
// "Enabled" is deliberately NOT a thing this panel invents. A skill reaches a run
// because the run asked for it by name (`task.skillNames`), which is the engine's
// existing contract — a toggle here would be a fourth place skill state lives and
// would not affect any run.
//
// Validates: Requirements 11.1, 11.2, 11.4, 11.6, 14.6, 27.1, 27.3

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Check, Package, Search, Shield, Zap } from '../components/Icons'
import { useSketchClient } from '../lib/ClientProvider'
import { useAppState } from '../state/AppState'
import type {
  SkillInstallResult,
  SkillTrainResult,
  SkillsCatalogEntry,
  SkillsCatalogResult,
} from '../lib/client'
import styles from './SkillsMarketplace.module.css'

/**
 * Plain-language capability descriptions, mirroring the engine's vocabulary
 * (`packages/core/src/capabilities/vocabulary.ts`).
 *
 * Duplicated rather than imported because the desktop bundle takes no runtime
 * dependency on `@sketch/core` — the same rule the git and provider panels follow.
 * `SkillsMarketplace.test.tsx` asserts this table covers the engine's vocabulary
 * exactly, so the two cannot drift.
 */
const CAPABILITY_TEXT: Record<string, string> = {
  'fs:read:project': 'Read files in this project',
  'fs:write:project': 'Create and change files in this project',
  'fs:read:home': 'Read files anywhere in your home directory',
  'fs:write:home': 'Create and change files anywhere in your home directory',
  'net:http': 'Make network requests to any host',
  'net:localhost': 'Make network requests to this machine only',
  'proc:spawn': 'Start other programs, with your permissions',
  'secrets:read': 'Read stored credentials and API keys',
  'git:read': 'Read this repository\u2019s history and diffs',
  'git:write': 'Commit, stage and change this repository',
}

/** Grants that reach past the project. Highlighted, never hidden. */
const SENSITIVE = new Set(['fs:read:home', 'fs:write:home', 'proc:spawn', 'secrets:read'])

type Tab = 'installed' | 'registry'

interface Busy {
  kind: 'loading' | 'installing' | 'training'
  name?: string
}

export function SkillsMarketplace() {
  const { projectRoot } = useAppState()
  const client = useSketchClient()

  const [catalog, setCatalog] = useState<SkillsCatalogResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Busy | null>(null)
  const [tab, setTab] = useState<Tab>('registry')
  const [search, setSearch] = useState('')
  /** The entry awaiting confirmation. Nothing installs without passing through this. */
  const [pending, setPending] = useState<SkillsCatalogEntry | null>(null)
  const [installed, setInstalled] = useState<SkillInstallResult | null>(null)
  const [trained, setTrained] = useState<SkillTrainResult | null>(null)

  /** Discards a response for a superseded request (a different project, a refresh). */
  const generation = useRef(0)

  const canRead = client.skillsCatalog !== undefined

  const refresh = useCallback(
    async (root: string) => {
      const call = client.skillsCatalog
      if (call === undefined) return
      generation.current += 1
      const ticket = generation.current
      setBusy({ kind: 'loading' })
      setError(null)
      try {
        const answer = await call.call(client, { root })
        if (generation.current !== ticket) return
        setCatalog(answer)
      } catch (err) {
        if (generation.current !== ticket) return
        setCatalog(null)
        setError(`The skill catalog could not be read: ${message(err)}`)
      } finally {
        if (generation.current === ticket) setBusy(null)
      }
    },
    [client],
  )

  // Reading the manifest and the installed directory is local work, so it may
  // happen on mount. Installing and training never do: both are user decisions,
  // and training can cost money.
  useEffect(() => {
    if (projectRoot === null) {
      setCatalog(null)
      setError(null)
      return
    }
    void refresh(projectRoot)
  }, [projectRoot, refresh])

  const confirmInstall = useCallback(async () => {
    const call = client.skillInstall
    const entry = pending
    if (call === undefined || entry === null || projectRoot === null) return
    setBusy({ kind: 'installing', name: entry.name })
    setError(null)
    setInstalled(null)
    try {
      const result = await call.call(client, { root: projectRoot, name: entry.name })
      setInstalled(result)
      // A refusal is a result, not an exception: it is shown with the reason the
      // engine gave, which names the file whose hash differs.
      if (result.ok) setTab('installed')
      await refresh(projectRoot)
    } catch (err) {
      setError(`Install failed: ${message(err)}`)
    } finally {
      setPending(null)
      setBusy(null)
    }
  }, [client, pending, projectRoot, refresh])

  const train = useCallback(
    async (name: string) => {
      const call = client.skillTrain
      if (call === undefined || projectRoot === null) return
      setBusy({ kind: 'training', name })
      setError(null)
      setTrained(null)
      try {
        // `write` is not passed: the run reports what it found and the user decides.
        setTrained(await call.call(client, { root: projectRoot, name }))
      } catch (err) {
        setError(`Training failed: ${message(err)}`)
      } finally {
        setBusy(null)
      }
    },
    [client, projectRoot],
  )

  const entries = useMemo(() => {
    const all = catalog?.entries ?? []
    const needle = search.trim().toLowerCase()
    if (needle === '') return all
    return all.filter(
      (entry) =>
        entry.name.toLowerCase().includes(needle) ||
        entry.summary.toLowerCase().includes(needle) ||
        entry.pack.toLowerCase().includes(needle),
    )
  }, [catalog, search])

  if (projectRoot === null) {
    return (
      <Frame>
        <Empty
          title="No folder opened"
          detail="Skills install into the open project, under .sketch/skills/. Open a folder first."
        />
      </Frame>
    )
  }

  if (!canRead) {
    return (
      <Frame>
        <Empty
          title="No engine behind this transport"
          detail={`The ${client.transport} transport does not implement skills-catalog, so there is no registry to read. A made-up catalog would invent content hashes and capability grants, which is worse than showing nothing.`}
        />
      </Frame>
    )
  }

  return (
    <Frame
      search={
        <div className={styles.searchBox}>
          <Search size={14} className={styles.searchIcon} />
          <input
            type="text"
            placeholder="Search skills..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className={styles.searchInput}
            aria-label="Search skills"
          />
        </div>
      }
    >
      {error !== null && (
        <div className={styles.error} role="alert">
          <AlertCircle size={13} />
          <span>{error}</span>
        </div>
      )}

      <div className={styles.tabs} role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'registry'}
          className={`${styles.tab} ${tab === 'registry' ? styles.active : ''}`}
          onClick={() => setTab('registry')}
        >
          Registry{catalog === null ? '' : ` (${catalog.entries.length})`}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'installed'}
          className={`${styles.tab} ${tab === 'installed' ? styles.active : ''}`}
          onClick={() => setTab('installed')}
        >
          Installed{catalog === null ? '' : ` (${catalog.installed.length})`}
        </button>
      </div>

      {catalog?.diagnostic !== undefined && (
        <div className={styles.notice} role="status">
          {catalog.diagnostic}
        </div>
      )}

      {catalog !== null && catalog.registry !== undefined && (
        <div className={styles.summary}>
          {catalog.registry} · {catalog.distribution} · content-pinned, verified on install
          {catalog.distribution === 'curated' &&
            ' · the open marketplace is not enabled in this build'}
        </div>
      )}

      <div className={styles.content}>
        {busy?.kind === 'loading' && catalog === null && <Empty title="Reading the registry…" />}

        {tab === 'registry' &&
          catalog !== null &&
          (entries.length === 0 ? (
            <Empty
              title={catalog.entries.length === 0 ? 'No registry configured' : 'Nothing matches'}
              detail={
                catalog.entries.length === 0
                  ? catalog.diagnostic ??
                    'This build has no pinned registry to read, so there is nothing to install.'
                  : `No skill matches “${search}”.`
              }
            />
          ) : (
            <div className={styles.skillList}>
              {entries.map((entry) => (
                <article key={entry.name} className={styles.skillCard} data-skill={entry.name}>
                  <div className={styles.cardHeader}>
                    <div className={styles.cardTitle}>
                      <Package size={14} />
                      <span className={styles.name}>{entry.name}</span>
                      <span className={styles.version}>v{entry.version}</span>
                    </div>
                    {entry.installed ? (
                      <span className={styles.installedTag}>
                        <Check size={12} /> installed
                      </span>
                    ) : (
                      <button
                        className={styles.actionButton}
                        disabled={busy !== null}
                        onClick={() => {
                          setInstalled(null)
                          setPending(entry)
                        }}
                      >
                        Install…
                      </button>
                    )}
                  </div>

                  <div className={styles.description}>{entry.summary}</div>

                  {/* The grant, on the card, before anyone clicks anything. */}
                  <Capabilities capabilities={entry.capabilities} />

                  <div className={styles.cardFooter}>
                    <span className={styles.badge}>{entry.pack}</span>
                    <span className={styles.meta}>
                      {entry.source} · {entry.license} · {entry.files} file(s)
                    </span>
                  </div>
                  <div className={styles.digest} title={entry.digest}>
                    {entry.digest.slice(0, 26)}…
                  </div>
                </article>
              ))}
            </div>
          ))}

        {tab === 'installed' &&
          catalog !== null &&
          (catalog.installed.length === 0 ? (
            <Empty
              title="No skills installed"
              detail={`Nothing has been installed into ${catalog.installedDir}. Install one from the Registry tab; its content hash is verified before anything is written.`}
            />
          ) : (
            <div className={styles.skillList}>
              {catalog.installed.map((skill) => (
                <article key={skill.name} className={styles.skillCard} data-installed={skill.name}>
                  <div className={styles.cardHeader}>
                    <div className={styles.cardTitle}>
                      <Package size={14} />
                      <span className={styles.name}>{skill.name}</span>
                    </div>
                    {client.skillTrain !== undefined && (
                      <button
                        className={styles.actionButton}
                        disabled={busy !== null}
                        onClick={() => void train(skill.name)}
                        title="Score this skill against your captured runs and propose an improvement"
                      >
                        {busy?.kind === 'training' && busy.name === skill.name
                          ? 'Training…'
                          : 'Train on my project'}
                      </button>
                    )}
                  </div>
                  <div className={styles.description}>{skill.description}</div>
                  <Capabilities capabilities={skill.capabilities} />
                  <div className={styles.meta}>{skill.source}</div>
                </article>
              ))}
            </div>
          ))}

        {catalog !== null && catalog.diagnostics.length > 0 && (
          <div className={styles.notice} role="status">
            {catalog.diagnostics.length} installed skill(s) could not be loaded:{' '}
            {catalog.diagnostics.join('; ')}
          </div>
        )}

        {installed !== null && <InstallOutcome result={installed} />}
        {trained !== null && <TrainOutcome result={trained} />}
      </div>

      {pending !== null && (
        <ConfirmInstall
          entry={pending}
          busy={busy?.kind === 'installing'}
          onCancel={() => setPending(null)}
          onConfirm={() => void confirmInstall()}
        />
      )}
    </Frame>
  )
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function Frame({ children, search }: { children: React.ReactNode; search?: React.ReactNode }) {
  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <Package size={16} />
          <span>Skills</span>
        </div>
        {search}
      </div>
      {children}
    </div>
  )
}

function Empty({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className={styles.emptyState}>
      <div className={styles.emptyText}>{title}</div>
      {detail !== undefined && <p className={styles.emptySubtext}>{detail}</p>}
    </div>
  )
}

/** The grant, in words, with the ones that reach past the project marked. */
function Capabilities({ capabilities }: { capabilities: string[] }) {
  if (capabilities.length === 0) {
    return (
      <ul className={styles.capabilities}>
        <li className={styles.capability}>No capabilities: this skill can only read what it is handed</li>
      </ul>
    )
  }
  return (
    <ul className={styles.capabilities} aria-label="Capabilities this skill is granted">
      {capabilities.map((capability) => (
        <li
          key={capability}
          className={SENSITIVE.has(capability) ? styles.capabilitySensitive : styles.capability}
          data-capability={capability}
        >
          {SENSITIVE.has(capability) && <Shield size={11} />}
          <code>{capability}</code>
          {' — '}
          {/* An unknown token is shown verbatim rather than glossed: the engine
              fails closed on it, and inventing a description would be a guess. */}
          {CAPABILITY_TEXT[capability] ?? 'unrecognised capability; the engine will refuse it'}
        </li>
      ))}
    </ul>
  )
}

interface ConfirmProps {
  entry: SkillsCatalogEntry
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}

/**
 * The consent step. Shows what will be verified and what will be granted.
 *
 * Sensitive grants are listed again, separately, above the button — a user
 * skim-reading a list of ten capabilities will miss `secrets:read`, and that is the
 * one they most need to see.
 */
function ConfirmInstall({ entry, busy, onCancel, onConfirm }: ConfirmProps) {
  const sensitive = entry.capabilities.filter((capability) => SENSITIVE.has(capability))
  return (
    <div className={styles.confirm} role="dialog" aria-label={`Install ${entry.name}`}>
      <div className={styles.confirmTitle}>
        Install {entry.name} v{entry.version}?
      </div>
      <div className={styles.confirmBody}>
        <p>{entry.summary}</p>
        <p>
          <strong>Source:</strong> {entry.source} · <strong>License:</strong> {entry.license}
        </p>
        <p>
          <strong>Verified content hash</strong> over {entry.files} file(s):
        </p>
        <pre className={styles.digestFull}>{entry.digest}</pre>
        <p>
          Every file is re-hashed before anything is written. If one byte differs from this hash the
          install is refused, and the refusal names the file.
        </p>
        <p>
          <strong>This skill will be granted:</strong>
        </p>
        <Capabilities capabilities={entry.capabilities} />
        {sensitive.length > 0 && (
          <p className={styles.warning}>
            <Shield size={12} /> {sensitive.join(', ')} reach past this project. Only continue if you
            trust the source.
          </p>
        )}
      </div>
      <div className={styles.confirmActions}>
        <button className={styles.actionButton} disabled={busy} onClick={onConfirm}>
          {busy ? 'Verifying…' : 'Verify and install'}
        </button>
        <button className={styles.secondaryButton} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function InstallOutcome({ result }: { result: SkillInstallResult }) {
  if (!result.ok) {
    return (
      <div className={styles.error} role="alert">
        <AlertCircle size={13} />
        {/* The engine's sentence, not a paraphrase: it names the differing file. */}
        <span>{result.reason}</span>
      </div>
    )
  }
  return (
    <div className={styles.notice} role="status">
      <Check size={13} /> Installed {result.name}: {result.files} file(s) verified against{' '}
      {result.digest?.slice(0, 18)}…, granted {result.granted?.join(', ') || 'nothing'}.
      {result.warnings.map((warning) => (
        <div key={warning} className={styles.warning}>
          {warning}
        </div>
      ))}
    </div>
  )
}

/**
 * What a training run found.
 *
 * Both scores are always shown, including when nothing was accepted. A trainer that
 * only reports its wins is not a measurement.
 */
function TrainOutcome({ result }: { result: SkillTrainResult }) {
  if (!result.ok) {
    return (
      <div className={styles.notice} role="status">
        <AlertCircle size={13} /> {result.reason}
      </div>
    )
  }
  return (
    <div className={styles.notice} role="status">
      <Zap size={13} />{' '}
      {result.improved === true
        ? `Accepted an improvement to ${result.name}: held-out score ${fmt(result.baselineValScore)} → ${fmt(result.valScore)}.`
        : `No improvement to ${result.name}. Held-out score stayed at ${fmt(result.valScore)}, so the existing skill was kept.`}{' '}
      Scored {result.cases} captured case(s), split {result.split?.train} train /{' '}
      {result.split?.val} held out. Spent {result.budget?.calls} model call(s).
      {result.budget?.refusal !== null && result.budget?.refusal !== undefined && (
        <div className={styles.warning}>{result.budget.refusal}</div>
      )}
      {result.improved === true && (
        <div className={styles.warning}>
          Nothing was written. The proposed body is available from the engine; review it before
          replacing the installed skill.
        </div>
      )}
    </div>
  )
}

function fmt(score: number | undefined): string {
  return score === undefined ? '—' : score.toFixed(3)
}

export default SkillsMarketplace
