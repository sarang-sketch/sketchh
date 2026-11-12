// Three chats that build one app together: Frontend, Backend and Database.
//
// Each role is an ordinary agent run with a role brief in front of the prompt. A role
// passes work to another by ending its reply with lines of the form
//
//   @backend: add GET /api/todos returning [{ id, title, done }]
//
// The panel forwards each such line into that role's chat as a new message. Forwarding
// is bounded per user message (MAX_HANDOFFS), so two roles cannot bounce work back and
// forth forever.

export type TeamRole = 'frontend' | 'backend' | 'database'

export const TEAM_ROLES: readonly TeamRole[] = ['frontend', 'backend', 'database']

/** Messages forwarded automatically after one message from the user. */
export const MAX_HANDOFFS = 6

export const ROLE_INFO: Readonly<Record<TeamRole, { title: string; focus: string }>> = {
  frontend: {
    title: 'Frontend',
    focus: 'the user interface: pages, components, styling, client state, and calls to the backend API',
  },
  backend: {
    title: 'Backend',
    focus: 'the server: API routes, business logic, validation, authentication, and calls to the database',
  },
  database: {
    title: 'Database',
    focus: 'the data layer: schema, migrations, indexes, seed data, and the queries the backend needs',
  },
}

export interface Handoff {
  to: TeamRole
  message: string
}

/** The brief put in front of every prompt a role receives. */
export function roleBrief(role: TeamRole): string {
  const info = ROLE_INFO[role]
  const peers = TEAM_ROLES.filter((other) => other !== role)
  return [
    `You are the ${info.title} agent on a three-agent team building one app in this project.`,
    `You own ${info.focus}. Work only on your part; the other agents own theirs.`,
    `When another agent must do something for your part to work (a route, a table, a field, a`,
    `contract change), end your reply with one line per request, exactly in this form:`,
    ...peers.map((peer) => `@${peer}: <what you need, with the exact names, routes and fields>`),
    'Only add such a line when the other agent must act. Do not ask them to repeat work.',
  ].join('\n')
}

/** The prompt a run receives: the role brief, then who the message is from, then the message. */
export function rolePrompt(role: TeamRole, message: string, from: TeamRole | 'user'): string {
  const sender = from === 'user' ? 'The user' : `The ${ROLE_INFO[from].title} agent`
  return `${roleBrief(role)}\n\n${sender} says:\n${message.trim()}`
}

const HANDOFF_LINE = /^\s*@(frontend|backend|database)\s*:\s*(.+?)\s*$/i

/**
 * Requests a reply makes of the other roles, in order. A line addressed to the role
 * that wrote it is ignored, as is a request with nothing after the colon. Lines inside
 * a fenced code block are code, not requests.
 */
export function parseHandoffs(reply: string, from: TeamRole): Handoff[] {
  const handoffs: Handoff[] = []
  let inFence = false
  for (const line of reply.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const match = HANDOFF_LINE.exec(line)
    if (match === null) continue
    const to = match[1]!.toLowerCase() as TeamRole
    const message = match[2]!.trim()
    if (to === from || message === '') continue
    handoffs.push({ to, message })
  }
  return handoffs
}
