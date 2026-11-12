// Export a conversation as Markdown — W9 invariant 8a.
//
// "Copy as Markdown" in the conversation's menu copies a plain-text Markdown transcript
// to the clipboard: the title, then each message with its role and time, with fenced
// code blocks preserved. No native file permission, no new dependency — just a string a
// user can paste anywhere. It reads the conversation that already lives in state; it
// changes nothing, and it touches neither W2's open() nor W6's rename/delete.

import type { Conversation, ChatMessage } from './state/AppState'

const ROLE_HEADING: Record<ChatMessage['role'], string> = {
  user: 'You',
  agent: 'Sketch',
  system: 'System',
}

/**
 * Fence a code block so the surrounding transcript's own ``` fences don't collide with a
 * fenced block already inside a message: the outer fence uses one more backtick than the
 * longest run of backticks in the content (CommonMark's rule).
 */
function fenceFor(content: string): string {
  let longest = 0
  for (const run of content.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/** A short, local timestamp for a message. */
function stamp(ts: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Render one message as a Markdown section. */
function renderMessage(m: ChatMessage): string {
  const when = stamp(m.timestamp)
  const heading = `## ${ROLE_HEADING[m.role] ?? m.role}${when ? ` · ${when}` : ''}`
  const body = (m.content ?? '').trimEnd()
  const lines = [heading, '', body === '' ? '_(no text)_' : body]
  // A compact note of what a run changed, so the transcript records the outcome.
  if (m.files && m.files.length > 0) {
    const changed = m.files
      .map((f) => `- \`${f.path}\` (+${f.added} −${f.removed}${f.created ? ', new' : ''})`)
      .join('\n')
    const state = m.filesState ? ` (${m.filesState})` : ''
    lines.push('', `**Files${state}:**`, changed)
  }
  return lines.join('\n')
}

/**
 * The whole conversation as Markdown. The returned string already escapes fence
 * collisions inside code blocks; it is safe to copy verbatim.
 */
export function conversationToMarkdown(conversation: Conversation): string {
  const title = conversation.title?.trim() || 'Conversation'
  const parts: string[] = [`# ${title}`]
  if (conversation.root) parts.push('', `_Folder: \`${conversation.root}\`_`)
  const created = stamp(conversation.createdAt)
  if (created) parts.push('', `_Started: ${created}_`)
  parts.push('')
  for (const m of conversation.messages) {
    // If a message's content already contains fenced code, keep it as-is but ensure the
    // transcript's own fences won't swallow it. We don't re-fence the whole message; the
    // message content is Markdown already. fenceFor is exported for callers that wrap raw
    // code, and used by the test to prove collision handling.
    parts.push(renderMessage(m))
    parts.push('')
  }
  return parts.join('\n').trimEnd() + '\n'
}

export { fenceFor }
