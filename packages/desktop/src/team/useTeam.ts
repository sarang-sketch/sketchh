// The three team chats: each role keeps its own transcript and runs as an ordinary
// agent run in the open project. A reply's @role lines are forwarded to that role,
// at most MAX_HANDOFFS times per message from the user.

import { useCallback, useRef, useState } from 'react'

import { useSketchClient } from '../lib/ClientProvider'
import { withDesktopRunDefaults } from '../lib/runDefaults'
import { resolveApiKeyForRun } from '../lib/secrets'
import { useAppState } from '../state/AppState'
import { MAX_HANDOFFS, parseHandoffs, rolePrompt, ROLE_INFO, TEAM_ROLES, type TeamRole } from './handoff'

export interface TeamMessage {
  id: string
  /** Who wrote it: the person, this role's agent, another role, or a system note. */
  from: 'user' | 'agent' | 'system' | TeamRole
  text: string
}

type PerRole<T> = Record<TeamRole, T>

const emptyRoles = <T,>(value: () => T): PerRole<T> => ({ frontend: value(), backend: value(), database: value() })

let counter = 0
const newId = () => globalThis.crypto?.randomUUID?.() ?? `team-${Date.now().toString(36)}-${(counter++).toString(36)}`

export interface TeamSession {
  messages: PerRole<TeamMessage[]>
  busy: PerRole<boolean>
  /** Send a message from the person to one role. */
  send(role: TeamRole, text: string): void
  /** Forwards left before the team waits for the person again. */
  handoffsLeft: number
}

export function useTeam(): TeamSession {
  const client = useSketchClient()
  const state = useAppState()
  const latest = useRef(state)
  latest.current = state

  const [messages, setMessages] = useState<PerRole<TeamMessage[]>>(() => emptyRoles(() => []))
  const [busy, setBusy] = useState<PerRole<boolean>>(() => emptyRoles(() => false))
  const [handoffsLeft, setHandoffsLeft] = useState(MAX_HANDOFFS)
  const transcripts = useRef<PerRole<TeamMessage[]>>(emptyRoles(() => []))
  const queues = useRef<PerRole<Promise<void>>>(emptyRoles(() => Promise.resolve()))
  const forwarded = useRef(0)

  const add = useCallback((role: TeamRole, message: Omit<TeamMessage, 'id'>) => {
    const entry = { ...message, id: newId() }
    transcripts.current = { ...transcripts.current, [role]: [...transcripts.current[role], entry] }
    setMessages(transcripts.current)
  }, [])

  const runOnce = useCallback(
    async (role: TeamRole, text: string, from: TeamRole | 'user'): Promise<string | null> => {
      const snapshot = latest.current
      const selected = snapshot.providers.find((entry) => entry.id === snapshot.selectedProvider)
      if (selected === undefined) {
        add(role, { from: 'system', text: 'Connect a model first (Settings → Models). A free option is available.' })
        return null
      }
      const provider =
        snapshot.selectedModel !== null && snapshot.selectedModel !== selected.model
          ? { ...selected, model: snapshot.selectedModel }
          : selected
      const history = transcripts.current[role]
        .filter((m) => m.from !== 'system')
        .map((m) => ({ role: m.from === 'agent' ? ('assistant' as const) : ('user' as const), content: m.text }))
      setBusy((now) => ({ ...now, [role]: true }))
      try {
        const apiKey = await resolveApiKeyForRun(provider.id, (reason) =>
          add(role, { from: 'system', text: `Continuing without a stored key for ${provider.label}: ${reason}` }),
        )
        const root = snapshot.projectRoot ?? undefined
        const result = await client.run(
          { id: newId(), prompt: rolePrompt(role, text, from), verify: [] },
          withDesktopRunDefaults({
            runId: newId(),
            provider,
            ...(apiKey !== null && apiKey !== undefined ? { apiKey } : {}),
            ...(root !== undefined ? { root } : {}),
            ...(history.length > 0 ? { history } : {}),
          }),
        )
        const reply = result.finalText || (result.ok ? 'Done.' : 'The run ended without a reply.')
        add(role, { from: 'agent', text: reply })
        return reply
      } catch (err) {
        add(role, { from: 'system', text: `The run could not start: ${err instanceof Error ? err.message : String(err)}` })
        return null
      } finally {
        setBusy((now) => ({ ...now, [role]: false }))
      }
    },
    [add, client],
  )

  // One run at a time per role; a role's messages are handled in arrival order.
  const deliver = useCallback(
    (role: TeamRole, text: string, from: TeamRole | 'user') => {
      add(role, { from, text })
      queues.current[role] = queues.current[role].then(async () => {
        const reply = await runOnce(role, text, from)
        if (reply === null) return
        for (const handoff of parseHandoffs(reply, role)) {
          if (forwarded.current >= MAX_HANDOFFS) {
            add(role, {
              from: 'system',
              text: `Not forwarded to ${ROLE_INFO[handoff.to].title}: the team reached ${MAX_HANDOFFS} hand-offs for this message. Send it on yourself if it is still needed.`,
            })
            continue
          }
          forwarded.current += 1
          setHandoffsLeft(MAX_HANDOFFS - forwarded.current)
          deliverRef.current(handoff.to, handoff.message, role)
        }
      })
    },
    [add, runOnce],
  )
  const deliverRef = useRef(deliver)
  deliverRef.current = deliver

  const send = useCallback(
    (role: TeamRole, raw: string) => {
      const text = raw.trim()
      if (text === '' || !TEAM_ROLES.includes(role)) return
      forwarded.current = 0
      setHandoffsLeft(MAX_HANDOFFS)
      deliver(role, text, 'user')
    },
    [deliver],
  )

  return { messages, busy, send, handoffsLeft }
}
