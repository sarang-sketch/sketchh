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
import { AlertCircle, Check, Package, Search, Shield, Trash, Zap } from '../components/Icons'
import { useSketchClient } from '../lib/ClientProvider'
import { useAppState } from '../state/AppState'
import { useConfirm } from '../components/ConfirmDialog'
import type {
  SkillInstallResult,
  SkillPromoteResult,
  SkillTrainResult,
  SkillUninstallResult,
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

/**
 * How training proposes changes. 'edits' is Microsoft SkillOpt's update rule (a few
 * edits tied to exact text, per round); 'rewrite' asks for a whole new body. Either
 * way the held-out gate decides, so the default is the one whose result is easier to
 * read: a small edit that raised the score says which change helped.
 */
type TrainMode = 'edits' | 'rewrite'

const TRAIN_MODE_TEXT: Record<TrainMode, { label: string; hint: string }> = {
  edits: {
    label: 'Small edits (SkillOpt)',
    hint: 'Up to 4 small edits per round, each tied to exact text in the skill. The skill changes only if your held-out runs score higher, and edits that did not help are listed.',
  },
  rewrite: {
    label: 'Full rewrite',
    hint: 'A whole new version of the skill per round. It changes only if your held-out runs score higher.',
  },
}

interface Busy {
  kind: 'loading' | 'installing' | 'training' | 'promoting' | 'uninstalling'
  name?: string
}

export function SkillsMarketplace() {
  const { projectRoot } = useAppState()
  const client = useSketchClient()
  const confirm = useConfirm()

  const [catalog, setCatalog] = useState<SkillsCatalogResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Busy | null>(null)
  const [tab, setTab] = useState<Tab>('registry')
  const [search, setSearch] = useState('')
  /** The entry awaiting confirmation. Nothing installs without passing through this. */
  const [pending, setPending] = useState<SkillsCatalogEntry | null>(null)
  const [installed, setInstalled] = useState<SkillInstallResult | null>(null)
  const [uninstalled, setUninstalled] = useState<SkillUninstallResult | null>(null)
  const [trained, setTrained] = useState<SkillTrainResult | null>(null)
  const [trainMode, setTrainMode] = useState<TrainMode>('edits')
  const [promoted, setPromoted] = useState<SkillPromoteResult | null>(null)

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

  const uninstall = useCallback(
    async (skill: { name: string; capabilities: string[] }) => {
      const call = client.skillUninstall
      if (call === undefined || projectRoot === null) return
      // A destructive action gets an explicit confirmation, naming the grant that
      // will be withdrawn. The dialog keeps the keyboard and marks Uninstall danger.
      const grant =
        skill.capabilities.length === 0
          ? 'It is granted no capabilities.'
          : `It is granted: ${skill.capabilities.join(', ')}.`
      const answer = await confirm({
        title: `Uninstall "${skill.name}"?`,
        message: `Its files under .sketch/skills/${skill.name} and its saved capability grant are removed. ${grant} A run can no longer load it.`,
        detail: 'You can install it again from the Registry; its content hash is re-verified each time.',
        buttons: [
          { id: 'uninstall', label: 'Uninstall', kind: 'danger' },
          { id: 'cancel', label: 'Cancel', kind: 'secondary' },
        ],
        cancelId: 'cancel',
      })
      if (answer !== 'uninstall') return
      setBusy({ kind: 'uninstalling', name: skill.name })
      setError(null)
      setUninstalled(null)
      setInstalled(null)
      try {
        const result = await call.call(client, { root: projectRoot, name: skill.name })
        setUninstalled(result)
        await refresh(projectRoot)
      } catch (err) {
        setError(`Uninstall failed: ${message(err)}`)
      } finally {
        setBusy(null)
      }
    },
    [client, confirm, projectRoot, refresh],
  )

  const train = useCallback(
    async (name: string) => {
      const call = client.skillTrain
      if (call === undefined || projectRoot === null) return
      setBusy({ kind: 'training', name })
      setError(null)
      setTrained(null)
      setPromoted(null)
      try {
        // Write only the measured candidate artifact. It lives outside the active
        // skill directory and cannot affect a run until the user reviews and promotes it.
        setTrained(await call.call(client, { root: projectRoot, name, write: true, mode: trainMode }))
      } catch (err) {
        setError(`Training failed: ${message(err)}`)
      } finally {
        setBusy(null)
      }
    },
    [client, projectRoot, trainMode],
  )

  const promote = useCallback(
    async (name: string) => {
      const call = client.skillPromote
      if (call === undefined || projectRoot === null) return
      setBusy({ kind: 'promoting', name })
      setError(null)
      setPromoted(null)
      try {
        const result = await call.call(client, { root: projectRoot, name })
        setPromoted(result)
        if (result.ok) await refresh(projectRoot)
      } catch (err) {
        setError(`Promotion failed: ${message(err)}`)
      } finally {
        setBusy(null)
      }
    },
    [client, projectRoot, refresh],
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
                        className={`${styles.actionButton} ${styles.actionButtonInline}`}
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

                  <div className={styles.description} title={entry.summary}>
                    {entry.summary}
                  </div>

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
              {client.skillTrain !== undefined && (
                <div className={styles.trainMethod}>
                  <label className={styles.trainMethodRow}>
                    <span>Training method</span>
                    <select
                      className={styles.trainSelect}
                      value={trainMode}
                      disabled={busy !== null}
                      onChange={(event) => setTrainMode(event.target.value as TrainMode)}
                    >
                      {(Object.keys(TRAIN_MODE_TEXT) as TrainMode[]).map((mode) => (
                        <option key={mode} value={mode}>
                          {TRAIN_MODE_TEXT[mode].label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className={styles.trainHint}>{TRAIN_MODE_TEXT[trainMode].hint}</div>
                </div>
              )}
              {catalog.installed.map((skill) => (
                <article key={skill.name} className={styles.skillCard} data-installed={skill.name}>
                  <div className={styles.cardHeader}>
                    <div className={styles.cardTitle}>
                      <Package size={14} />
                      <span className={styles.name}>{skill.name}</span>
                    </div>
                    <span className={styles.installedTag}>
                      <Check size={12} /> installed
                    </span>
                  </div>
                  <div className={styles.description} title={skill.description}>
                    {skill.description}
                  </div>
                  <Capabilities capabilities={skill.capabilities} />
                  <div className={styles.meta} title={skill.source}>
                    {skill.source}
                  </div>
                  <div className={styles.cardActions}>
                    {client.skillTrain !== undefined && (
                      <button
                        className={`${styles.actionButton} ${styles.actionButtonInline}`}
                        disabled={busy !== null}
                        onClick={() => void train(skill.name)}
                        title="Score this skill against your captured runs and propose an improvement"
                      >
                        {busy?.kind === 'training' && busy.name === skill.name
                          ? 'Training…'
                          : 'Train on my project'}
                      </button>
                    )}
                    {client.skillUninstall !== undefined && (
                      <button
                        className={`${styles.dangerButton} ${styles.actionButtonInline}`}
                        disabled={busy !== null}
                        onClick={() => void uninstall(skill)}
                        title={`Remove ${skill.name} and its capability grant from this project`}
                      >
                        {busy?.kind === 'uninstalling' && busy.name === skill.name ? (
                          'Uninstalling…'
                        ) : (
                          <>
                            <Trash size={12} /> Uninstall
                          </>
                        )}
                      </button>
                    )}
                  </div>
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
        {uninstalled !== null && <UninstallOutcome result={uninstalled} />}
        {trained !== null && (
          <TrainOutcome
            result={trained}
            promoted={promoted}
            promoting={busy?.kind === 'promoting' && busy.name === trained.name}
            canPromote={client.skillPromote !== undefined}
            onPromote={() => void promote(trained.name)}
          />
        )}
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

function UninstallOutcome({ result }: { result: SkillUninstallResult }) {
  if (!result.ok) {
    return (
      <div className={styles.error} role="alert">
        <AlertCircle size={13} />
        <span>{result.reason}</span>
      </div>
    )
  }
  // The result is honest about an idempotent no-op: "removed" reads differently
  // from "was already gone", because a user who clicks twice should be told which.
  const removedSomething = result.removedDir || result.removedGrant
  return (
    <div className={styles.notice} role="status">
      <Check size={13} />{' '}
      {removedSomething
        ? `Uninstalled ${result.name}: removed ${[
            result.removedDir ? 'its files' : null,
            result.removedGrant ? 'its capability grant' : null,
          ]
            .filter(Boolean)
            .join(' and ')}. Runs will no longer load it.`
        : `${result.name} was already not installed; nothing to remove.`}
    </div>
  )
}

/**
 * What a training run found.
 *
 * Both scores are always shown, including when nothing was accepted. A trainer that
 * only reports its wins is not a measurement.
 */
function TrainOutcome({
  result,
  promoted,
  promoting,
  canPromote,
  onPromote,
}: {
  result: SkillTrainResult
  promoted: SkillPromoteResult | null
  promoting: boolean
  canPromote: boolean
  onPromote: () => void
}) {
  if (!result.ok) {
    return (
      <div className={styles.notice} role="status">
        <AlertCircle size={13} /> {result.reason}
      </div>
    )
  }

  const hasCandidate =
    result.improved === true &&
    typeof result.artifactPath === 'string' &&
    typeof result.body === 'string'

  return (
    <div className={styles.notice} role="status">
      <Zap size={13} />{' '}
      {result.improved === true
        ? `Accepted an improvement to ${result.name}: held-out score ${fmt(result.baselineValScore)} → ${fmt(result.valScore)}.`
        : `No improvement to ${result.name}. Held-out score stayed at ${fmt(result.valScore)}, so the existing skill was kept.`}{' '}
      Scored {result.cases} captured case(s), split {result.split?.train} train /{' '}
      {result.split?.val} held out. Spent {result.budget?.calls} model call(s).
      {result.mode !== undefined && ` Method: ${TRAIN_MODE_TEXT[result.mode].label}.`}
      {result.budget?.refusal !== null && result.budget?.refusal !== undefined && (
        <div className={styles.warning}>{result.budget.refusal}</div>
      )}
      {result.rejectedEdits !== undefined && result.rejectedEdits.length > 0 && (
        <details className={styles.rejectedEdits}>
          <summary>
            {result.rejectedEdits.length} edit(s) did not raise the held-out score, so they were not
            applied
          </summary>
          <ul aria-label={`Rejected edits for ${result.name}`}>
            {result.rejectedEdits.map((line, index) => (
              <li key={index}>
                <code>{line}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      {hasCandidate && (
        <div className={styles.warning}>
          <div>
            The installed skill has not changed. Review the measured candidate below, stored at{' '}
            <code>{result.artifactPath}</code>.
          </div>
          <pre
            className={styles.digestFull}
            aria-label={`Trained candidate for ${result.name}`}
          >
            {result.body}
          </pre>
          {canPromote ? (
            <button className={styles.actionButton} disabled={promoting} onClick={onPromote}>
              {promoting ? 'Activating…' : 'Use trained version'}
            </button>
          ) : (
            <div>The active transport cannot promote a training candidate.</div>
          )}
        </div>
      )}
      {result.improved === true && !hasCandidate && (
        <div className={styles.warning}>
          The run reported an improvement but returned no reviewable candidate artifact, so it
          cannot be activated here.
        </div>
      )}
      {promoted !== null &&
        (promoted.ok ? (
          <div className={styles.notice} role="status">
            <Check size={13} /> Activated {promoted.name} at {promoted.path}; retained grant{' '}
            {promoted.granted?.join(', ') || 'nothing'} and active digest{' '}
            {promoted.digest?.slice(0, 18)}….
          </div>
        ) : (
          <div className={styles.error} role="alert">
            <AlertCircle size={13} /> {promoted.reason}
          </div>
        ))}
    </div>
  )
}

function fmt(score: number | undefined): string {
  return score === undefined ? '—' : score.toFixed(3)
}

export default SkillsMarketplace
