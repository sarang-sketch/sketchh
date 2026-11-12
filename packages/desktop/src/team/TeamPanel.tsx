// Build Team: three chats, one per part of the app, that hand work to each other.

import { useEffect, useRef, useState } from 'react'

import { ROLE_INFO, TEAM_ROLES, type TeamRole } from './handoff'
import { useTeam, type TeamMessage } from './useTeam'
import styles from './TeamPanel.module.css'

function author(message: TeamMessage, role: TeamRole): string {
  if (message.from === 'user') return 'You'
  if (message.from === 'system') return 'Sketch'
  if (message.from === 'agent') return ROLE_INFO[role].title
  return `From ${ROLE_INFO[message.from].title}`
}

export function TeamPanel() {
  const team = useTeam()
  const [active, setActive] = useState<TeamRole>('frontend')
  const [draft, setDraft] = useState('')
  const [seen, setSeen] = useState<Record<TeamRole, number>>({ frontend: 0, backend: 0, database: 0 })
  const listRef = useRef<HTMLDivElement>(null)

  const messages = team.messages[active]
  useEffect(() => {
    setSeen((now) => ({ ...now, [active]: messages.length }))
    listRef.current?.scrollTo?.({ top: listRef.current.scrollHeight })
  }, [active, messages.length])

  const submit = () => {
    if (draft.trim() === '') return
    team.send(active, draft)
    setDraft('')
  }

  return (
    <div className={styles.panel}>
      <div className={styles.tabs} role="tablist" aria-label="Team chats">
        {TEAM_ROLES.map((role) => {
          const unread = team.messages[role].length - seen[role]
          return (
            <button
              key={role}
              role="tab"
              aria-selected={role === active}
              className={`${styles.tab} ${role === active ? styles.tabActive : ''}`}
              onClick={() => setActive(role)}
            >
              {ROLE_INFO[role].title}
              {team.busy[role] && <span className={styles.dot} aria-label={`${ROLE_INFO[role].title} is working`} />}
              {role !== active && unread > 0 && <span className={styles.unread}>{unread}</span>}
            </button>
          )
        })}
      </div>

      <div className={styles.messages} ref={listRef} role="log" aria-label={`${ROLE_INFO[active].title} chat`}>
        {messages.length === 0 ? (
          <div className={styles.empty}>
            <p>
              The {ROLE_INFO[active].title} agent owns {ROLE_INFO[active].focus}.
            </p>
            <p>
              Describe what to build. When it needs something from another part of the app, it asks that agent directly,
              and the request shows up in that tab.
            </p>
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`${styles.message} ${message.from === 'user' ? styles.mine : ''} ${message.from === 'system' ? styles.note : ''}`}
            >
              <div className={styles.author}>{author(message, active)}</div>
              <div className={styles.text}>{message.text}</div>
            </div>
          ))
        )}
      </div>

      <div className={styles.composer}>
        <textarea
          className={styles.input}
          value={draft}
          placeholder={`Message the ${ROLE_INFO[active].title} agent`}
          aria-label={`Message the ${ROLE_INFO[active].title} agent`}
          rows={3}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <div className={styles.footer}>
          <span className={styles.hint}>{team.handoffsLeft} hand-offs left for this message</span>
          <button className={styles.send} onClick={submit} disabled={draft.trim() === ''}>
            Send
          </button>
        </div>
      </div>
    </div>
  )
}

export default TeamPanel
