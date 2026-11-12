// One agent session for the whole window.
//
// Both surfaces have a chat: Cowork's main panel and the Code surface's sidebar. Both
// are mounted at once (AppLayout shows one with CSS), so a run started in one must be
// visible, stoppable and answerable from the other — which is impossible if each keeps
// its own copy of "the run in flight". This provider is that one copy.
//
// What used to be here instead: the Code sidebar answered every prompt with a
// `setTimeout` and the fixed sentence "Analyzed your request. I am applying the
// required code changes directly to your editor files and verifying with linter." —
// no engine call at all. Every reply now comes from a real run.
//
// ── WHAT A SEND DOES ────────────────────────────────────────────────────────
//
//   1. refuses honestly when it cannot work: no folder open, no model connected;
//   2. resolves the stored key for THIS call only (Requirement 17.4);
//   3. starts a run with the desktop defaults, the user's agent preferences, and the
//      conversation so far, under an id it chose so Stop works immediately;
//   4. records the result — final text, a compact list of steps, the files changed —
//      on the conversation, so a reopened conversation still says what happened.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { readForEditor, writeFromEditor, byteLength } from '../editor/fileIo'
import { announceDiskChanged } from '../editor/diskSync'
import { useFileIo } from '../editor/FileIoProvider'
import { allHunkIndexes, applyHunks } from '../review/diffEngine'
import {
  acceptedPayload,
  describeDiagnostic,
  newReviewEventId,
  proposalsFrom,
  rejectedPayload,
} from '../review/proposals'
import { useAppDispatch, useAppState, type AgentPrefs, type AppState, type ChatMessage } from '../state/AppState'
import { useOptionalEventPublisher, useSketchClient, useSketchEvents } from './ClientProvider'
import type { RunOptions } from './client'
import type { SketchEvent } from './contracts'
import { withDesktopRunDefaults } from './runDefaults'
import { changedFiles, receiptFor, stepsFor } from './runSummary'
import { resolveApiKeyForRun } from './secrets'
import { canonicalPath, conversationRootRelation, toAbsolutePath } from '../editor/paths'

/** Why a send cannot happen right now, and what would fix it. */
export interface SendBlocker {
  reason: string
  action: 'connect' | 'folder' | null
}

/** A command the active run wants to execute and is waiting for you to allow. */
export interface PendingApproval {
  runId: string
  command: string
  cwd: string
  /** Why this one needs you even in Auto mode, or null (Agent mode asks for every command). */
  risk: string | null
}

export type ApprovalDecision = 'allow' | 'allow-always' | 'deny'

export interface SendOptions {
  /** Project-relative files the agent should read first. */
  files?: string[]
  /** Installed skills to load in full for this run (`/skill-name`). */
  skillNames?: string[]
  /** What the transcript shows as the user's message, when the prompt was expanded. */
  display?: string
  /** Run this one message in a different mode (e.g. `/review` is always read-only). */
  mode?: AgentPrefs['mode']
}

export interface AgentSessionValue {
  /** The run in flight, or null. */
  activeRunId: string | null
  /** The question the active run is waiting on. Non-null turns the box into an answer box. */
  pendingQuestion: string | null
  /** A command waiting for Allow / Deny. */
  pendingApproval: PendingApproval | null
  /** Events of the active run, as they arrive. */
  liveEvents: SketchEvent[]
  /** Why sending is not possible now, or null when it is. */
  blocker: SendBlocker | null
  send(prompt: string, options?: SendOptions): void
  /**
   * True when THIS window's session pressed Stop for the given run id and that run then
   * ended by abort. The chat renders such a run as a neutral "Stopped" (cancelled) state
   * rather than W5's failure styling: the user asked for it to end, so it is not an error.
   * An abort the user did not request (engine shutdown, another reason) is not here and
   * keeps the failure styling.
   */
  wasStopped(runId: string | undefined): boolean
  /**
   * Re-send the request a reply answered, as ONE fresh run. Given an agent reply, it
   * finds the user turn that prompted it and sends that text again. A no-op while a run
   * is in flight or when no prompting user turn can be found, so a click cannot start a
   * second concurrent run or an empty one.
   */
  retry(message: ChatMessage): void
  /** The user prompt that a given agent reply answered, or null when none is found. */
  promptBehind(message: ChatMessage): string | null
  approve(decision: ApprovalDecision): void
  stop(): void
  undo(message: ChatMessage): Promise<void>
  acceptProposals(message: ChatMessage): Promise<void>
  rejectProposals(message: ChatMessage): void
}

/** What an Auto-mode run is told when it hit its turn limit and is continued for you. */
export const AUTO_CONTINUE_PROMPT =
  'Continue the same task from where you stopped. Do not redo work that is already done: ' +
  're-read only what you need, finish the remaining steps, check the result, then send "done" with a summary.'

/** How many times one Auto-mode request is continued automatically before it hands back to you. */
export const AUTO_CONTINUE_LIMIT = 2

/**
 * The run options a mode implies. One function, so the composer's label and what the
 * engine is actually asked to do cannot drift apart.
 */
export function modeRunOptions(prefs: AgentPrefs): RunOptions {
  switch (prefs.mode) {
    case 'ask':
      // Read-only in the ENGINE; no command tool; nothing to verify because nothing changes.
      return { readOnly: true, reviewEdits: false, maxIterations: prefs.maxIterations }
    case 'auto': {
      const maxIterations = Math.max(prefs.maxIterations, 50)
      return {
        commands: 'auto',
        autonomous: true,
        reviewEdits: false,
        maxIterations,
        ...(prefs.verifyChanges ? { verifyPolicy: true } : {}),
      }
    }
    case 'agent':
    default:
      return {
        commands: 'ask',
        reviewEdits: !prefs.autoApply,
        maxIterations: prefs.maxIterations,
        // Checking proposals that were never written would test the old code, so the
        // project's checks run only for edits the run actually applied.
        ...(prefs.autoApply && prefs.verifyChanges ? { verifyPolicy: true } : {}),
      }
  }
}

/** A typed answer to an approval: anything that is not clearly a yes is a no. */
export function parseApprovalText(text: string): ApprovalDecision {
  const value = text.trim().toLowerCase()
  if (/^(always|allow always|yes,? always)/.test(value)) return 'allow-always'
  if (/^(y|yes|allow|ok|okay|approve|run it|sure|go)\b/.test(value)) return 'allow'
  return 'deny'
}

/** The terminal reason of a run, from its own events. */
function terminalReason(events: readonly SketchEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.kind === 'run_failed' || event.kind === 'run_completed') {
      const reason = event.payload['reason']
      return typeof reason === 'string' ? reason : event.kind === 'run_completed' ? 'done' : null
    }
  }
  return null
}

const AgentSessionContext = createContext<AgentSessionValue | null>(null)

function newId(): string {
  const webcrypto = globalThis.crypto as { randomUUID?: () => string } | undefined
  return typeof webcrypto?.randomUUID === 'function'
    ? webcrypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The conversation so far, as plain turns: user prompts and agent replies only. */
export function historyFrom(messages: readonly ChatMessage[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const message of messages) {
    if (message.role === 'system' || message.content.trim() === '') continue
    turns.push({ role: message.role === 'user' ? 'user' : 'assistant', content: message.content })
  }
  return turns.slice(-12)
}

/** Why a send would not work, judged from state alone. */
export function sendBlocker(state: AppState): SendBlocker | null {
  if (state.providerSettingsPath !== null && state.providers.length === 0) {
    return { reason: 'Connect a model to start. It takes about a minute, and a free option is available.', action: 'connect' }
  }
  if (!state.projectRoot) {
    return { reason: 'Open a project folder so Sketch knows which code to work on.', action: 'folder' }
  }
  return null
}

export function AgentSessionProvider({ children }: { children: ReactNode }) {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const client = useSketchClient()
  const events = useSketchEvents()
  const publish = useOptionalEventPublisher()
  const io = useFileIo()

  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)

  // Async work must act on the state as it is when it resolves.
  const latest = useRef(state)
  latest.current = state
  const latestEvents = useRef(events)
  latestEvents.current = events
  const activeRef = useRef<string | null>(null)
  activeRef.current = activeRunId
  // Run ids THIS session pressed Stop for. A run that then ends by abort is rendered as a
  // neutral "Stopped", not a failure (the user asked for it). Kept here, in the session
  // wiring, so no message field or reducer action is needed. Rendered the same way by both
  // surfaces because both read this one session.
  const stoppedRuns = useRef(new Set<string>())

  const say = useCallback(
    (role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}) => {
      dispatch({ type: 'ADD_MESSAGE', payload: { id: newId(), role, content, timestamp: Date.now(), ...extra } })
    },
    [dispatch],
  )

  const liveEvents = useMemo(
    () => (activeRunId === null ? [] : events.filter((event) => event.runId === activeRunId)),
    [events, activeRunId],
  )

  // A paused run announces itself on the event stream, not on the run promise. Read
  // from the ONE accumulated log every panel reads, so there is no second
  // subscription to fall out of step with it. Each event is acted on once.
  //
  // Two kinds of pause share the `ask` kind: the model's own question (free text) and a
  // command waiting for approval (`payload.approval`), which gets Allow / Deny buttons
  // instead of a chat bubble.
  const handledAsks = useRef(new Set<string>())
  useEffect(() => {
    for (const event of liveEvents) {
      if (handledAsks.current.has(event.id)) continue
      if (event.kind === 'ask') {
        handledAsks.current.add(event.id)
        const approval = event.payload['approval']
        if (approval !== null && typeof approval === 'object' && !Array.isArray(approval)) {
          const record = approval as Record<string, unknown>
          setPendingApproval({
            runId: event.runId,
            command: typeof record['command'] === 'string' ? record['command'] : 'a command',
            cwd: typeof record['cwd'] === 'string' ? record['cwd'] : '.',
            risk: typeof record['risk'] === 'string' ? record['risk'] : null,
          })
          continue
        }
        const question = event.payload['question']
        if (typeof question !== 'string' || question.trim() === '') continue
        // Auto mode answers inside the engine; the question is still worth showing.
        if (latest.current.agentPrefs.mode === 'auto') {
          say('system', `The agent asked "${question.trim()}" and decided for itself (Auto mode).`)
          continue
        }
        setPendingQuestion(question)
        say('agent', question)
        dispatch({ type: 'SET_THINKING', payload: { isThinking: false } })
      } else if (event.kind === 'ask_answered') {
        handledAsks.current.add(event.id)
        const approval = event.payload['approval']
        if (approval !== null && typeof approval === 'object') setPendingApproval(null)
        else setPendingQuestion(null)
      }
    }
  }, [dispatch, liveEvents, say])

  const approve = useCallback(
    (decision: ApprovalDecision) => {
      const runId = activeRef.current
      if (runId === null) return
      setPendingApproval(null)
      const answer = decision === 'allow-always' ? 'always' : decision === 'allow' ? 'yes' : 'no'
      client.reply(runId, answer).catch((err: unknown) => {
        say('system', `Could not deliver your decision: ${messageOf(err)}`)
      })
    },
    [client, say],
  )

  const stop = useCallback(() => {
    const runId = activeRef.current
    if (runId === null) return
    // Remember that the USER asked this run to stop, so its abort terminal event reads as
    // a neutral "Stopped", not a failure.
    stoppedRuns.current.add(runId)
    dispatch({ type: 'SET_THINKING', payload: { isThinking: true, stage: 'Stopping the run…' } })
    client.cancel(runId).catch((err: unknown) => {
      say('system', `Could not stop the run: ${messageOf(err)}`)
    })
  }, [client, dispatch, say])

  const wasStopped = useCallback((runId: string | undefined): boolean => runId !== undefined && stoppedRuns.current.has(runId), [])

  /**
   * Start one run. `display` is what the transcript shows as the user's turn; `null`
   * means this run was started FOR the user (an Auto-mode continuation), which the
   * transcript says in a system note instead of putting words in their mouth.
   */
  const startRunRef = useRef<(prompt: string, display: string | null, options: SendOptions, continuation: number) => void>(() => {})
  const startRun = useCallback(
    (prompt: string, display: string | null, options: SendOptions, continuation: number) => {
      const snapshot = latest.current
      const selected = snapshot.providers.find((entry) => entry.id === snapshot.selectedProvider)
      if (selected === undefined && snapshot.selectedProvider !== null) {
        if (display !== null) say('user', display)
        say('system', 'The selected model is no longer configured. Pick another one, or connect a model.')
        return
      }
      // The picker can choose a different model of the same provider for this run.
      const provider =
        selected === undefined
          ? undefined
          : snapshot.selectedModel !== null && snapshot.selectedModel !== selected.model
            ? { ...selected, model: snapshot.selectedModel }
            : selected

      const history = historyFrom(snapshot.chatMessages)
      const attached = (options.files ?? []).filter((path) => path.trim() !== '')
      const fullPrompt =
        attached.length === 0
          ? prompt
          : `${prompt}\n\nFiles to look at first: ${attached.map((path) => `\`${path}\``).join(', ')}`

      const runId = newId()
      setActiveRunId(runId)
      activeRef.current = runId
      if (display !== null) say('user', display)
      dispatch({ type: 'SET_THINKING', payload: { isThinking: true, stage: 'Starting…' } })

      // The RUN root is the conversation's own root, not the workspace boundary.
      // Selecting a conversation never moves the open folder (the editor/explorer/
      // command_policy boundary stays the workspace), but a conversation's history and
      // file references are relative to the folder it ran in — so a follow-up run has to
      // use THAT root to resolve them (Req 15.6; W2 invariants 1-2). It is used only when
      // it sits inside (or equals) the open workspace; a conversation rooted OUTSIDE the
      // workspace is selected read-only and cannot send (see conversationRunRoot /
      // Composer's guard), so it never reaches here with a wrong root. With no active
      // conversation root, or none inside the workspace, the run uses the workspace root.
      const workspaceRoot = snapshot.projectRoot
      const active = snapshot.conversations.find((c) => c.id === snapshot.activeConversationId)
      const convRoot = active?.root ? canonicalPath(active.root) : null
      // A conversation rooted INSIDE the workspace runs against its own root; anything
      // else (none, or outside) runs against the workspace root. A conversation rooted
      // OUTSIDE cannot reach here — Composer blocks its send.
      const runRoot =
        conversationRootRelation(workspaceRoot, convRoot) === 'inside' ? convRoot : workspaceRoot
      const root = runRoot ?? undefined
      const prefs = options.mode !== undefined ? { ...snapshot.agentPrefs, mode: options.mode } : snapshot.agentPrefs
      const mode = modeRunOptions(prefs)
      const maxIterations = mode.maxIterations ?? prefs.maxIterations
      const skillNames = (options.skillNames ?? []).filter((name) => name.trim() !== '')

      const withKey = async () => {
        if (provider === undefined) return undefined
        return resolveApiKeyForRun(provider.id, (reason) => {
          say('system', `Continuing without a stored key for ${provider.label}: ${reason}`)
        })
      }

      const finish = () => {
        setActiveRunId(null)
        activeRef.current = null
        setPendingQuestion(null)
        setPendingApproval(null)
        dispatch({ type: 'SET_THINKING', payload: { isThinking: false } })
        // The agent's own edits are reconciled as they land; a command it ran (a
        // formatter, an install, a code generator) may have changed more.
        announceDiskChanged('agent')
      }

      withKey()
        .then((apiKey) =>
          client.run(
            { id: newId(), prompt: fullPrompt, verify: [], ...(skillNames.length > 0 ? { skillNames } : {}) },
            withDesktopRunDefaults({
              runId,
              interactive: true,
              autoSkills: true,
              ...(provider !== undefined ? { provider } : {}),
              ...(apiKey !== null && apiKey !== undefined ? { apiKey } : {}),
              ...(root !== undefined ? { root } : {}),
              ...mode,
              maxIterations,
              budget: { maxCalls: Math.max(40, maxIterations + 10), maxTokens: 400_000, maxUsd: prefs.maxUsd, onBreach: 'stop' },
              ...(history.length > 0 ? { history } : {}),
              // The user's own MCP servers they switched on for chats. The engine still
              // refuses an unapproved project server and every server in Offline Mode.
              ...(prefs.mcpServers !== undefined && prefs.mcpServers.length > 0 ? { userMcpServers: prefs.mcpServers } : {}),
            }),
          ),
        )
        .then((result) => {
          const runEvents = latestEvents.current.filter((event) => event.runId === runId)
          const source = runEvents.length > 0 ? runEvents : result.events
          const files = changedFiles(source).map(({ path, added, removed, created }) => ({ path, added, removed, created }))
          const proposedOnly = mode.reviewEdits === true
          finish()
          // A run the USER stopped (this session pressed Stop) that then ended by abort is
          // NOT a failure: it ended because they asked. Render a neutral "Stopped" — a plain
          // sentence and no `ok: false` "did not finish" marker — while the receipt still
          // shows what ran before the stop. An abort the user did NOT request (engine
          // shutdown, some other reason) is left as the engine reported it, failure and all.
          const userStopped = terminalReason(source) === 'aborted' && stoppedRuns.current.has(runId)
          const finalText = userStopped
            ? 'Stopped. Nothing more was changed after you pressed Stop.'
            : result.finalText || (result.ok ? 'Done.' : 'The run ended without a reply.')
          say('agent', finalText, {
            runId,
            // undefined (not false) for a user stop, so no failure styling fires; the plain
            // sentence carries the neutral "Stopped" state.
            ok: userStopped ? undefined : result.ok,
            steps: stepsFor(source),
            receipt: receiptFor(source),
            ...(files.length > 0 ? { files, filesState: proposedOnly ? 'proposed' : 'applied' } : {}),
            ...(root !== undefined ? { root } : {}),
          })

          // AUTO MODE DOES NOT STOP AT THE TURN LIMIT — up to a bound. Running out of
          // turns is not the task failing, and "say continue" is exactly the
          // interruption Auto mode exists to remove. Bounded, so a task that is really
          // stuck still comes back to the person after a couple of rounds.
          const reason = terminalReason(source)
          if (prefs.mode === 'auto' && reason === 'max_iterations' && continuation < AUTO_CONTINUE_LIMIT) {
            const touched = files.map((file) => file.path)
            say('system', `Reached the turn limit; continuing automatically (${continuation + 1} of ${AUTO_CONTINUE_LIMIT}).`)
            const followUp =
              touched.length === 0 ? AUTO_CONTINUE_PROMPT : `${AUTO_CONTINUE_PROMPT}\nFiles changed so far: ${touched.join(', ')}.`
            startRunRef.current(followUp, null, { skillNames }, continuation + 1)
          }
        })
        .catch((err: unknown) => {
          finish()
          say('system', `The engine (${client.transport} transport) could not run this: ${messageOf(err)}`)
        })
    },
    [client, dispatch, say],
  )
  startRunRef.current = startRun

  const send = useCallback(
    (raw: string, options: SendOptions = {}) => {
      const text = raw.trim()
      if (text === '') return
      const snapshot = latest.current
      const display = (options.display ?? text).trim() || text

      // A command waiting for approval: a typed "yes" / "no" / "always" answers it.
      if (pendingApproval !== null && activeRef.current !== null) {
        say('user', display)
        approve(parseApprovalText(text))
        return
      }

      // A question in flight turns the box into an answer box.
      if (pendingQuestion !== null && activeRef.current !== null) {
        const runId = activeRef.current
        say('user', display)
        setPendingQuestion(null)
        dispatch({ type: 'SET_THINKING', payload: { isThinking: true, stage: 'Continuing with your answer…' } })
        client
          .reply(runId, text)
          .then((outcome) => {
            if (!outcome.answered) {
              say('system', `That run was no longer waiting for an answer: ${outcome.detail ?? 'it had already moved on'}`)
            }
          })
          .catch((err: unknown) => say('system', `Could not deliver the answer: ${messageOf(err)}`))
        return
      }

      // One run at a time: a second concurrent run is a second bill nobody asked for.
      if (activeRef.current !== null) return

      const blocked = sendBlocker(snapshot)
      if (blocked !== null) {
        say('user', display)
        say('system', blocked.reason)
        if (blocked.action === 'connect') dispatch({ type: 'OPEN_CONNECT' })
        return
      }

      startRun(text, display, options, 0)
    },
    [approve, client, dispatch, pendingApproval, pendingQuestion, say, startRun],
  )

  /** The user prompt a reply answered: the last user turn strictly before it. */
  const promptBehind = useCallback((message: ChatMessage): string | null => {
    const messages = latest.current.chatMessages
    const at = messages.findIndex((m) => m.id === message.id)
    const from = at === -1 ? messages.length - 1 : at - 1
    for (let i = from; i >= 0; i--) {
      const m = messages[i]!
      if (m.role === 'user' && m.content.trim() !== '') return m.content
    }
    return null
  }, [])

  const retry = useCallback(
    (message: ChatMessage) => {
      // Never start a second concurrent run, and never answer a paused run with a retry.
      if (activeRef.current !== null) return
      const prompt = promptBehind(message)
      if (prompt === null) {
        say('system', 'There is no earlier request to retry here.')
        return
      }
      // One fresh run per click: the same request path as typing it again.
      send(prompt)
    },
    [promptBehind, say, send],
  )

  /** Re-read open, unedited buffers after files changed on disk underneath them. */
  const refreshOpenFiles = useCallback(
    async (root: string, paths: readonly string[], removed: readonly string[]) => {
      for (const path of paths) {
        const absolute = toAbsolutePath(root, path)
        const open = latest.current.files[absolute]
        if (!open || open.isDirty) continue
        const read = await readForEditor(io, root, absolute)
        if (read.ok) dispatch({ type: 'RELOAD_FILE', payload: { path: absolute, content: read.content } })
      }
      for (const path of removed) {
        const absolute = toAbsolutePath(root, path)
        if (latest.current.files[absolute] && !latest.current.files[absolute]!.isDirty) {
          dispatch({ type: 'CLOSE_FILE', payload: absolute })
        }
      }
    },
    [dispatch, io],
  )

  const undo = useCallback(
    async (message: ChatMessage) => {
      const root = message.root ?? latest.current.projectRoot
      if (!message.runId || !root || client.undoRun === undefined) {
        say('system', 'This run cannot be undone from here.')
        return
      }
      try {
        const outcome = await client.undoRun({ root, runId: message.runId })
        if (!outcome.found) {
          say('system', 'There is nothing to undo for that run: no snapshot was recorded, or it was already undone.')
          dispatch({ type: 'UPDATE_MESSAGE', payload: { id: message.id, patch: { filesState: 'undone' } } })
          return
        }
        await refreshOpenFiles(root, outcome.restored, outcome.removed)
        dispatch({ type: 'UPDATE_MESSAGE', payload: { id: message.id, patch: { filesState: 'undone' } } })
        const changed = outcome.restored.length + outcome.removed.length
        const skipped = outcome.skipped.map((s) => `${s.path} (${s.reason})`).join(', ')
        say(
          'system',
          `Undone: ${changed} file${changed === 1 ? '' : 's'} put back.` +
            (skipped === '' ? '' : ` Left alone because you changed them since: ${skipped}.`),
        )
      } catch (err) {
        say('system', `Undo failed: ${messageOf(err)}`)
      }
    },
    [client, dispatch, refreshOpenFiles, say],
  )

  const acceptProposals = useCallback(
    async (message: ChatMessage) => {
      const root = message.root ?? latest.current.projectRoot
      if (!message.runId || !root) return
      const proposals = proposalsFrom(latestEvents.current, root).filter(
        (p) => p.runId === message.runId && p.outcome.state === 'open',
      )
      if (proposals.length === 0) {
        say('system', 'Those proposals are no longer open — they were reviewed already, or this window was restarted. Ask again to regenerate them.')
        return
      }
      // In order, each against what is on disk NOW, so a later proposal to the same
      // file lands on top of an earlier one or is refused by name.
      for (const proposal of proposals) {
        for (const file of proposal.files) {
          if (file.hunks.length === 0) continue
          const open = latest.current.files[file.path]
          const baseline = open ? { ok: true as const, content: open.content } : await readForEditor(io, root, file.path)
          // A file the run CREATED does not exist on disk yet: its patch starts from
          // nothing (`@@ -0,0`), so the baseline is the empty string, not a failure.
          const createsFile = file.diff !== null && /^@@ -0,0 /m.test(file.diff)
          let original: string
          if (baseline.ok) original = baseline.content
          else if (createsFile) original = ''
          else {
            say('system', baseline.message)
            return
          }
          const applied = applyHunks(original, file.hunks, allHunkIndexes(file.hunks))
          if (!applied.ok) {
            say('system', `${describeDiagnostic(file.statedPath, applied.error)} Open Diff Review in the Code view to review it hunk by hunk.`)
            return
          }
          const written = await writeFromEditor(io, root, file.path, applied.content)
          if (!written.ok) {
            say('system', written.message)
            return
          }
          if (latest.current.files[file.path]) {
            dispatch({ type: 'RELOAD_FILE', payload: { path: file.path, content: applied.content } })
          }
          publish({
            id: newReviewEventId(),
            ts: Date.now(),
            runId: proposal.runId,
            kind: 'edit_accepted',
            payload: acceptedPayload(
              { proposalId: proposal.id, path: file.statedPath, hunks: allHunkIndexes(file.hunks) },
              byteLength(applied.content),
            ),
          })
        }
      }
      dispatch({ type: 'UPDATE_MESSAGE', payload: { id: message.id, patch: { filesState: 'accepted' } } })
    },
    [dispatch, io, publish, say],
  )

  const rejectProposals = useCallback(
    (message: ChatMessage) => {
      const root = message.root ?? latest.current.projectRoot ?? ''
      const proposals = proposalsFrom(latestEvents.current, root).filter(
        (p) => p.runId === message.runId && p.outcome.state === 'open',
      )
      for (const proposal of proposals) {
        for (const file of proposal.files) {
          publish({
            id: newReviewEventId(),
            ts: Date.now(),
            runId: proposal.runId,
            kind: 'edit_rejected',
            payload: rejectedPayload(
              { proposalId: proposal.id, path: file.statedPath, hunks: allHunkIndexes(file.hunks) },
              'rejected from the chat',
            ),
          })
        }
      }
      dispatch({ type: 'UPDATE_MESSAGE', payload: { id: message.id, patch: { filesState: 'rejected' } } })
    },
    [dispatch, publish],
  )

  const blocker = sendBlocker(state)

  const value = useMemo<AgentSessionValue>(
    () => ({ activeRunId, pendingQuestion, pendingApproval, liveEvents, blocker, send, retry, promptBehind, wasStopped, approve, stop, undo, acceptProposals, rejectProposals }),
    [activeRunId, pendingQuestion, pendingApproval, liveEvents, blocker, send, retry, promptBehind, wasStopped, approve, stop, undo, acceptProposals, rejectProposals],
  )

  return <AgentSessionContext.Provider value={value}>{children}</AgentSessionContext.Provider>
}

/** The window's one agent session. */
export function useAgentSession(): AgentSessionValue {
  const value = useContext(AgentSessionContext)
  if (value === null) throw new Error('useAgentSession must be used inside <AgentSessionProvider>')
  return value
}

/** For a panel that may render outside the provider (tests): null when there is none. */
export function useOptionalAgentSession(): AgentSessionValue | null {
  return useContext(AgentSessionContext)
}
