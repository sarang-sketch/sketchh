// Test Results — the nine-stage verification contract, as it really is.
//
// ── WHAT THIS PANEL REFUSES TO DO ───────────────────────────────────────────
//
// There is no fixture here, and a fabricated verify report is the worst fixture this
// application could ship. Nine green badges are a claim that a project's format, lint,
// typecheck, build, unit tests, integration tests, security scan, performance check and
// dependency audit all pass. A user who believes one ships broken code. So when there is
// no engine behind the transport, or no folder open, this panel says exactly that and
// shows nothing else.
//
// ── ALL NINE STAGES, ALWAYS ─────────────────────────────────────────────────
//
// The contract is fixed by Requirement 4.3 and every stage is listed whether this
// project configures it or not, because "lint is not set up here" is information a user
// needs and a panel that lists only what exists cannot say it.
//
// ── `skipped` AND `not-run` ARE DIFFERENT WORDS ─────────────────────────────
//
// Nothing ran in either case. `skipped` means the project configures no command for
// that stage; `not-run` means an earlier stage failed and the sequence stopped. The
// engine keeps them distinct (`packages/core/src/verify/policy.ts`) and so does this
// panel, because they call for opposite responses — configure something, or go fix the
// failure above — and one grey badge for both hides which.
//
// ── RESOLVING IS FREE. RUNNING IS A BUTTON ──────────────────────────────────
//
// Mounting reads `verify.yaml` (or detects per stack) and draws the contract. That is a
// file read. It does NOT run anything: executing nine stages because a user clicked a
// sidebar icon would run the whole build and test suite as a side effect of navigation,
// and for a policy with a `live` check it would bind a port. Running is a deliberate
// press, and while it runs the button says so.
//
// ── FAILURES EXPAND TO REAL OUTPUT ──────────────────────────────────────────
//
// A failed stage expands to the actual stdout and stderr the command produced, exit code
// included, because the whole value of a verification panel is the stack trace. Passing
// stages stay collapsed: their logs are noise that crowds out the failure.
//
// Validates: Requirements 4.3, 4.4, 4.7, 4.8, 23.2, 27.1

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, Play, X } from '../components/Icons'
import { useSketchClient } from '../lib/ClientProvider'
import { useAppState } from '../state/AppState'
import type {
  VerifyContractResult,
  VerifyStageResult,
  VerifyStageStatus,
} from '../lib/client'
import styles from './TestResults.module.css'

/** Plain words for each status. The engine's four, not three. */
const STATUS_TEXT: Record<VerifyStageStatus, string> = {
  passed: 'passed',
  failed: 'failed',
  skipped: 'not configured',
  'not-run': 'not run',
}

const STATUS_CLASS: Record<VerifyStageStatus, string> = {
  passed: styles.passed!,
  failed: styles.failed!,
  skipped: styles.skipped!,
  'not-run': styles.notRun!,
}

export function TestResults() {
  const { projectRoot } = useAppState()
  const client = useSketchClient()

  const [contract, setContract] = useState<VerifyContractResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  /** Stages the user has expanded. Failures start expanded; passes do not. */
  const [open, setOpen] = useState<Set<string>>(new Set())

  /** Discards the answer to a superseded request (a different project, a refresh). */
  const generation = useRef(0)

  const canVerify = client.verify !== undefined

  const resolveContract = useCallback(
    async (root: string) => {
      const call = client.verify
      if (call === undefined) return
      generation.current += 1
      const ticket = generation.current
      setLoading(true)
      setError(null)
      try {
        // No `run`. This is a file read and a stack detection, nothing more.
        const answer = await call.call(client, { root })
        if (generation.current !== ticket) return
        setContract(answer)
      } catch (err) {
        if (generation.current !== ticket) return
        setContract(null)
        setError(`The verification contract could not be read: ${message(err)}`)
      } finally {
        if (generation.current === ticket) setLoading(false)
      }
    },
    [client],
  )

  useEffect(() => {
    if (projectRoot === null) {
      setContract(null)
      setError(null)
      return
    }
    void resolveContract(projectRoot)
  }, [projectRoot, resolveContract])

  const runAll = useCallback(async () => {
    const call = client.verify
    if (call === undefined || projectRoot === null) return
    generation.current += 1
    const ticket = generation.current
    setRunning(true)
    setError(null)
    try {
      // A FULL REPORT: `continueOnFailure` is left at the engine's default for this
      // method, which is true. A user looking at a report wants to know that lint
      // failed AND the tests fail, not to fix lint and then discover the tests.
      const answer = await call.call(client, { root: projectRoot, run: true })
      if (generation.current !== ticket) return
      setContract(answer)
      // Failures open themselves. Nothing else does.
      setOpen(
        new Set(
          (answer.result?.stages ?? [])
            .filter((stage) => stage.status === 'failed')
            .map((stage) => stage.stage),
        ),
      )
    } catch (err) {
      if (generation.current !== ticket) return
      setError(`Verification could not run: ${message(err)}`)
    } finally {
      if (generation.current === ticket) setRunning(false)
    }
  }, [client, projectRoot])

  if (projectRoot === null) {
    return (
      <Frame>
        <Empty
          title="No folder opened"
          detail="The verification contract comes from the open project: verify.yaml at its root, or per-stack detection. Open a folder first."
        />
      </Frame>
    )
  }

  if (!canVerify) {
    return (
      <Frame>
        <Empty
          title="No engine behind this transport"
          detail={`The ${client.transport} transport does not implement verify, so there is nothing to report. Invented results would be a claim that this project's tests pass, which is worse than showing nothing.`}
        />
      </Frame>
    )
  }

  const result = contract?.result ?? null
  const byStage = new Map<string, VerifyStageResult>(
    (result?.stages ?? []).map((stage) => [stage.stage, stage]),
  )

  return (
    <Frame
      action={
        <button
          type="button"
          className={styles.runButton}
          onClick={() => void runAll()}
          disabled={running || loading}
        >
          <Play size={12} />
          <span>{running ? 'Running…' : 'Run verification'}</span>
        </button>
      }
    >
      {error !== null && (
        <div className={styles.error} role="alert">
          <AlertCircle size={13} />
          <span>{error}</span>
        </div>
      )}

      {contract !== null && <Source contract={contract} />}

      {/* A malformed policy file is never silent: it does not fall back to detection,
          and its diagnostics are shown rather than logged where nobody looks. */}
      {contract !== null && contract.diagnostics.length > 0 && (
        <ul className={styles.diagnostics} aria-label="Policy file diagnostics">
          {contract.diagnostics.map((diagnostic) => (
            <li key={diagnostic} className={styles.diagnostic}>
              <AlertCircle size={12} />
              <span>{diagnostic}</span>
            </li>
          ))}
        </ul>
      )}

      {result !== null && <Summary result={result} />}

      <ul className={styles.stages} aria-label="Verification stages">
        {(contract?.contract ?? []).map((entry) => {
          const ran = byStage.get(entry.stage)
          const status: VerifyStageStatus = ran?.status ?? (entry.configured ? 'not-run' : 'skipped')
          const expandable = ran !== undefined && ran.results.length > 0
          const isOpen = open.has(entry.stage)
          return (
            <li key={entry.stage} className={styles.stage}>
              <button
                type="button"
                className={styles.stageHead}
                onClick={() => expandable && toggle(setOpen, entry.stage)}
                aria-expanded={expandable ? isOpen : undefined}
                disabled={!expandable}
              >
                <span className={`${styles.badge} ${STATUS_CLASS[status]}`}>
                  {status === 'passed' ? <Check size={11} /> : status === 'failed' ? <X size={11} /> : null}
                  <span>{STATUS_TEXT[status]}</span>
                </span>
                <span className={styles.stageName}>{entry.stage}</span>
                {ran !== undefined && ran.durationMs > 0 && (
                  <span className={styles.duration}>{formatMs(ran.durationMs)}</span>
                )}
              </button>

              {/* The commands, as written in the policy. What "configured" means. */}
              {entry.configured ? (
                <ul className={styles.commands}>
                  {entry.commands.map((command) => (
                    <li key={command} className={styles.command}>
                      <code>{command}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.stageNote}>
                  No command is configured for this stage in this project, so it is skipped. A
                  skipped stage does not fail the contract, and it is not evidence of anything
                  either.
                </p>
              )}

              {/* Why nothing ran, when nothing ran and it was not simply unconfigured. */}
              {ran?.reason !== null && ran?.reason !== undefined && (
                <p className={styles.stageNote}>{ran.reason}</p>
              )}

              {expandable && isOpen && <Output stage={ran} />}
            </li>
          )
        })}
      </ul>

      {/* The live check's own verdict. Its row is already in `integration`; this is
          what a row cannot carry — `failed-to-start` reads differently from
          `runtime-error`, and a pattern-matched verdict is flagged as a heuristic. */}
      {result?.live !== undefined && <Live live={result.live} />}

      {result === null && (
        <p className={styles.footNote}>
          Nothing has run yet. This is the contract, read from{' '}
          {contract?.source === 'file' ? 'a policy file' : contract?.source === 'detected' ? 'stack detection' : 'nowhere'}
          . Press Run verification to execute it.
        </p>
      )}
    </Frame>
  )
}

/** Where the policy came from. A surface should never have to guess. */
function Source({ contract }: { contract: VerifyContractResult }) {
  const text =
    contract.source === 'file'
      ? `Contract read from ${contract.path ?? 'a policy file'}.`
      : contract.source === 'detected'
        ? `No policy file. Stages detected for a ${contract.language ?? 'unknown'} project.`
        : 'No policy file, and no stage could be detected for this project.'
  return (
    <div className={styles.source}>
      <p>{text}</p>
      {contract.live && (
        <p className={styles.sourceNote}>
          A live application check runs as part of the integration stage: the app is started,
          probed, and a runtime error means not done.
        </p>
      )}
      {contract.source === 'none' && (
        <p className={styles.sourceNote}>
          With nothing configured the contract passes trivially. That is not evidence of
          verification — add a verify.yaml at the project root to say what "done" means here.
        </p>
      )}
    </div>
  )
}

/** The headline. `verifiedAnything` is why `ok` alone is not enough. */
function Summary({ result }: { result: NonNullable<VerifyContractResult['result']> }) {
  const passed = result.stages.filter((stage) => stage.status === 'passed').length
  const failed = result.stages.filter((stage) => stage.status === 'failed').length
  return (
    <div className={`${styles.summary} ${result.ok ? styles.summaryOk : styles.summaryBad}`} role="status">
      <strong>
        {!result.verifiedAnything
          ? 'Nothing ran'
          : result.ok
            ? `Passed: ${passed} stage${passed === 1 ? '' : 's'}`
            : `Failed at ${result.failedStage ?? 'an unknown stage'}`}
      </strong>
      <span>
        {!result.verifiedAnything
          ? 'No stage had a command to run, so this result is not evidence that anything works.'
          : `${passed} passed, ${failed} failed, ${formatMs(result.totalDurationMs)} total.`}
      </span>
    </div>
  )
}

/** The real captured output, exit code included. */
function Output({ stage }: { stage: VerifyStageResult }) {
  return (
    <ul className={styles.outputs}>
      {stage.results.map((command) => (
        <li key={command.name} className={styles.output}>
          <div className={styles.outputHead}>
            <span className={command.ok ? styles.passedText : styles.failedText}>
              {command.ok ? 'passed' : 'failed'}
            </span>
            <code>{command.name}</code>
            <span className={styles.duration}>
              exit {command.exitCode} · {formatMs(command.durationMs)}
            </span>
          </div>
          {command.stdout.trim() !== '' && (
            <pre className={styles.log} aria-label={`${command.name} stdout`}>
              {command.stdout.trimEnd()}
            </pre>
          )}
          {command.stderr.trim() !== '' && (
            <pre className={`${styles.log} ${styles.logErr}`} aria-label={`${command.name} stderr`}>
              {command.stderr.trimEnd()}
            </pre>
          )}
          {command.stdout.trim() === '' && command.stderr.trim() === '' && (
            <p className={styles.stageNote}>The command produced no output.</p>
          )}
        </li>
      ))}
    </ul>
  )
}

/** The live check, with its verdict spelled out rather than reduced to pass/fail. */
function Live({ live }: { live: NonNullable<NonNullable<VerifyContractResult['result']>['live']> }) {
  return (
    <div className={styles.live}>
      <div className={styles.liveHead}>
        <span className={`${styles.badge} ${live.verdict === 'passed' ? styles.passed : live.verdict === 'skipped' ? styles.skipped : styles.failed}`}>
          {live.verdict}
        </span>
        <span className={styles.stageName}>live application check</span>
      </div>
      <p className={styles.stageNote}>{live.detail}</p>
      {live.heuristic === true && (
        <p className={styles.stageNote}>
          This verdict came from matching patterns in the application's output, so it is a
          heuristic and can be wrong in both directions.
        </p>
      )}
      {live.stdout !== undefined && live.stdout.trim() !== '' && (
        <pre className={styles.log} aria-label="live check stdout">
          {live.stdout.trimEnd()}
        </pre>
      )}
      {live.stderr !== undefined && live.stderr.trim() !== '' && (
        <pre className={`${styles.log} ${styles.logErr}`} aria-label="live check stderr">
          {live.stderr.trimEnd()}
        </pre>
      )}
    </div>
  )
}

function toggle(set: (updater: (previous: Set<string>) => Set<string>) => void, key: string): void {
  set((previous) => {
    const next = new Set(previous)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function Frame({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <Check size={16} />
          <span>Test Results</span>
        </div>
        {action}
      </div>
      <div className={styles.body}>{children}</div>
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
