// AI Team — the three strategies, the thirteen roles, and what grades each one.
//
// ── WHAT REPLACED WHAT ──────────────────────────────────────────────────────
//
// This file used to hold four function-local fixtures — Architect/idle, UI Builder/working,
// Backend/done, Security/idle — next to a header reading `1 working` that was a hardcoded
// string, not a count of anything. A second, larger fixture lived in `AppState.agentTeam`:
// twelve entries with a different status vocabulary (`idle|busy|offline` against this file's
// `idle|working|done`), one of them asserted `busy`, and Deployment missing entirely. It was
// read by nothing. Requirement 24.4 names thirteen. Three disagreeing lists, none of them
// true, and the panel was unreachable anyway because no ActivityBar button dispatched
// `agents`. All three are gone; the ActivityBar now has the button.
//
// ── WHY THERE IS NO PER-ROLE STATUS BADGE ───────────────────────────────────
//
// The honest correction, and it is the same one `McpTools` made. A role exists only inside a
// dispatch: `strategy.dispatch` partitions the roles, runs the verifiable ones as sub-runs,
// grades each by its own signal, and it is over. Between dispatches there is no working
// role and no idle one — there are no roles at all. So `strategy-catalog` reports what CAN
// be verified in this project and why not when it cannot, and the live section below is
// filled by `strategy_selected` events as a dispatch actually happens. Nothing on screen
// claims a role is busy unless an event said so.
//
// ── THE SKIPPED ROLES ARE THE POINT, NOT AN OMISSION ────────────────────────
//
// A role whose verification signal this project cannot resolve is shown with its reason,
// because that is the load-bearing fact: Requirement 24.6 refuses to run it, since
// `runTask` returns ok for a task with nothing configured and an unchecked role would report
// confident, meaningless success. Hiding those rows would make a swarm look complete.
//
// Validates: Requirements 24.1, 24.4, 24.6, 24.8, 27.1, 27.3, 27.4, 14.6

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Brain, Check, Shield, Zap } from '../../components/Icons'
import { useOptionalSketchEvents, useSketchClient } from '../../lib/ClientProvider'
import { useAppState } from '../../state/AppState'
import type { RoleStatus, StrategyCatalogResult } from '../../lib/client'
import type { SketchEvent } from '../../lib/contracts'
import styles from './AgentTeamPanel.module.css'

/**
 * Plain words for the engine's capability vocabulary.
 *
 * Duplicated rather than imported, like `McpTools`' copy, because the desktop bundle takes
 * no runtime dependency on `@sketch/core`. The test asserts this table covers every
 * capability the role table actually uses, so the two cannot drift.
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

/** One line the dispatcher put on the log. */
interface DispatchLine {
  id: string
  runId: string
  phase: string
  text: string
}

/** Render one `strategy_selected` payload as a sentence, or null when it is the router's. */
function describeDispatchEvent(event: SketchEvent): DispatchLine | null {
  if (event.kind !== 'strategy_selected') return null
  const payload = event.payload as Record<string, unknown>
  // The cost router used to emit this kind too, with `component: 'router'` and a `policy`
  // key. Its decisions are about which MODEL to use, not which strategy, and the `EventKind`
  // amendment gave them `model_selected`. The check stays because pre-amendment JSONL logs
  // still carry router events here, and showing one would read as a strategy change that
  // never happened.
  if (payload['component'] !== 'dispatcher') return null

  const phase = typeof payload['phase'] === 'string' ? payload['phase'] : 'unknown'
  const strategy = typeof payload['strategy'] === 'string' ? payload['strategy'] : null
  const reason = typeof payload['reason'] === 'string' ? payload['reason'] : null

  let text: string
  if (phase === 'attempt') {
    text = `Attempt ${String(payload['attempt'] ?? '?')}: ${strategy ?? 'unknown strategy'}${
      reason === null ? '' : ` — ${reason}`
    }`
  } else if (phase === 'roles') {
    const verifiable = Array.isArray(payload['verifiable']) ? payload['verifiable'] : []
    const skipped = Array.isArray(payload['skipped']) ? payload['skipped'] : []
    text = `Roles resolved: ${verifiable.length} verifiable, ${skipped.length} skipped for want of a verification signal`
  } else if (phase === 'outcome') {
    const succeeded = payload['succeeded']
    text =
      typeof succeeded === 'string'
        ? `${succeeded} succeeded`
        : `no strategy succeeded${
            typeof payload['stopped'] === 'string' ? ` — ${payload['stopped']}` : ''
          }`
  } else {
    text = `${phase}${strategy === null ? '' : `: ${strategy}`}`
  }

  return { id: event.id, runId: event.runId, phase, text }
}

/** Scrollback cap, so a long escalation cannot grow this panel without bound. */
const MAX_LINES = 60

export function AgentTeamPanel() {
  const client = useSketchClient()
  const { projectRoot } = useAppState()

  const [catalog, setCatalog] = useState<StrategyCatalogResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  // The accumulated log the provider already holds, filtered to the dispatcher's own lines.
  // Derived rather than collected into local state: a second copy of the event stream would
  // start empty when the panel mounts, so a dispatch that finished a second before the user
  // opened this panel would read as "nothing has been dispatched".
  const events = useOptionalSketchEvents()
  const lines = useMemo(
    () =>
      events
        .map(describeDispatchEvent)
        .filter((line): line is DispatchLine => line !== null)
        .slice(-MAX_LINES),
    [events],
  )

  const canRead = client.strategyCatalog !== undefined

  const refresh = useCallback(async () => {
    const call = client.strategyCatalog
    if (call === undefined) return
    generation.current += 1
    const ticket = generation.current
    setError(null)
    try {
      const answer = await call.call(client, projectRoot === null ? {} : { root: projectRoot })
      if (generation.current !== ticket) return
      setCatalog(answer)
    } catch (err) {
      if (generation.current !== ticket) return
      setCatalog(null)
      setError(`The role catalog could not be read: ${message(err)}`)
    }
  }, [client, projectRoot])

  // Resolving the verification contract and answering which roles it could grade is local,
  // free, side-effect-free work, so it may happen on mount. Nothing here starts a dispatch.
  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!canRead) {
    return (
      <Frame>
        <Empty
          title="No engine behind this transport"
          detail={`The ${client.transport} transport does not implement strategy-catalog. Whether a role can be verified depends on the open project's verification contract, so it cannot be answered without an engine. An invented list would be the four fixtures this panel replaced.`}
        />
      </Frame>
    )
  }

  return (
    <Frame>
      {error !== null && (
        <div className={styles.error} role="alert">
          <AlertCircle size={13} />
          <span>{error}</span>
        </div>
      )}

      {catalog !== null && (
        <>
          <div className={styles.summary} role="status">
            <strong>
              {catalog.verifiableRoles} of {catalog.roles.length} roles verifiable in this project
            </strong>
            <span>
              Default strategy: <code>{catalog.defaultStrategy}</code>. Verification contract
              resolved by {catalog.policySource}
              {catalog.configuredStages.length === 0
                ? ', configuring no stages at all'
                : `, configuring ${catalog.configuredStages.join(', ')}`}
              .
            </span>
          </div>

          <section className={styles.section} aria-label="Strategies">
            <h3 className={styles.sectionTitle}>Strategies</h3>
            <ul className={styles.strategies}>
              {catalog.strategies.map((option) => (
                <li key={option.strategy} className={styles.strategy}>
                  <div className={styles.strategyHead}>
                    <code className={styles.strategyName}>{option.strategy}</code>
                    {option.default && <span className={styles.defaultMark}>default</span>}
                  </div>
                  <p className={styles.strategyText}>{option.description}</p>
                </li>
              ))}
            </ul>
            {/* Requirement 24.8. This says OFF and why, rather than shipping a swarm nobody
                measured — which is the phase where most products lie. */}
            <p className={styles.gate}>
              <Zap size={12} />
              <span>
                <strong>{catalog.swarmDefault.enable ? 'swarm may default' : 'swarm is off'}</strong>{' '}
                — {catalog.swarmDefault.reason}
              </span>
            </p>
          </section>

          <section className={styles.section} aria-label="Roles">
            <h3 className={styles.sectionTitle}>Roles</h3>
            <ul className={styles.roles}>
              {catalog.roles.map((role) => (
                <RoleRow key={role.role} role={role} />
              ))}
            </ul>
          </section>

          <section className={styles.section} aria-label="Dispatcher activity">
            <h3 className={styles.sectionTitle}>Dispatcher activity</h3>
            {lines.length === 0 ? (
              <p className={styles.emptySubtext}>
                Nothing has been dispatched in this session. Roles exist only inside a dispatch,
                so there is no per-role status to show between them — these lines fill in from
                the <code>strategy_selected</code> events a run emits.
              </p>
            ) : (
              <ol className={styles.activity}>
                {lines.map((line) => (
                  <li key={line.id} className={styles.activityLine}>
                    <span className={styles.phase}>{line.phase}</span>
                    <span>{line.text}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </Frame>
  )
}

function RoleRow({ role }: { role: RoleStatus }) {
  return (
    <li className={`${styles.role} ${role.available ? styles.ready : styles.skipped}`}>
      <div className={styles.head}>
        <span className={`${styles.badge} ${role.available ? styles.ready : styles.needs}`}>
          {role.available ? <Check size={11} /> : <AlertCircle size={11} />}
          <span>{role.available ? 'verifiable' : 'skipped'}</span>
        </span>
        <span className={styles.title}>{role.title}</span>
        {role.edits && <span className={styles.tag}>edits files</span>}
        {role.blocking && (
          <span className={styles.blockingTag}>
            <Shield size={10} />
            <span>can block</span>
          </span>
        )}
      </div>

      <p className={styles.instruction}>{role.instruction}</p>

      <p className={styles.signal}>
        <Brain size={12} />
        <span>
          Graded by {role.signal}
        </span>
      </p>

      <p className={styles.capability}>
        {role.capabilities
          .map((capability) => CAPABILITY_TEXT[capability] ?? capability)
          .join('; ')}
        {'. '}
        <span className={styles.capabilityNote}>
          Intersected with the run&rsquo;s own grant, never added to it.
        </span>
      </p>

      {role.reason !== null && <p className={styles.reason}>{role.reason}</p>}
    </li>
  )
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className={styles.container}>{children}</div>
}

function Empty({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className={styles.emptyState}>
      <div className={styles.emptyText}>{title}</div>
      {detail !== undefined && <p className={styles.emptySubtext}>{detail}</p>}
    </div>
  )
}
