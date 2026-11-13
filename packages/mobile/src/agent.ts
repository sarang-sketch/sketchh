// The mobile agent chat. Same controls as the desktop composer — Ask / Agent /
// Auto mode plus a Normal / Turbo speed switch — with the same honest mapping:
//
//   * Normal: up to 12 turns of history sent, up to 30 model turns.
//   * Turbo:  up to 6 turns of history, up to 10 model turns. Same model, same
//     permissions; it just stops sooner and reads less.
//
// The mobile app talks to a provider directly from the phone: the user enters
// an OpenAI-compatible base URL, model and API key in Settings, stored only in
// this phone's browser storage. Without a configured provider the chat cannot
// send — it says so, instead of faking an answer. Agent mode does not edit
// files by itself on mobile: the model may propose code in a fenced block, and
// the user applies it to a file with one tap.

export type AgentMode = 'ask' | 'agent' | 'auto'
export type AgentSpeed = 'normal' | 'turbo'

export const NORMAL_MAX_TURNS = 12
export const TURBO_MAX_TURNS = 6

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface ProviderConfig {
  baseUrl: string
  model: string
  apiKey: string
}

export const PROVIDER_KEY = 'sketch.mobile.provider.v1'

export function loadProvider(storage: Storage = localStorage): ProviderConfig {
  try {
    const raw = storage.getItem(PROVIDER_KEY)
    if (raw === null) return { baseUrl: '', model: '', apiKey: '' }
    const parsed = JSON.parse(raw) as Partial<ProviderConfig>
    return {
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
      model: typeof parsed.model === 'string' ? parsed.model : '',
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
    }
  } catch {
    return { baseUrl: '', model: '', apiKey: '' }
  }
}

export function saveProvider(config: ProviderConfig, storage: Storage = localStorage): void {
  try {
    storage.setItem(PROVIDER_KEY, JSON.stringify(config))
  } catch {
    // Storage unavailable: the config lasts for this session only.
  }
}

/** Rough token count (~1 per 4 characters), the same rule the desktop uses. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function maxTurns(speed: AgentSpeed): number {
  return speed === 'turbo' ? TURBO_MAX_TURNS : NORMAL_MAX_TURNS
}

export function maxModelTurns(mode: AgentMode, speed: AgentSpeed): number {
  if (speed === 'turbo') return mode === 'auto' ? 20 : 10
  return mode === 'auto' ? 50 : 30
}

/** The turns actually sent to the model: the latest ones only, capped by speed. */
export function historyFor(history: readonly ChatTurn[], speed: AgentSpeed): ChatTurn[] {
  return history.slice(-maxTurns(speed))
}

export interface AgentRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** Build the provider request without sending it, so it can be tested. */
export function buildChatRequest(
  config: ProviderConfig,
  history: readonly ChatTurn[],
  prompt: string,
  mode: AgentMode,
  speed: AgentSpeed,
): AgentRequest {
  const base = config.baseUrl.replace(/\/+$/, '')
  const system =
    mode === 'ask'
      ? 'You are Sketch, a coding assistant. Answer and explain only. Never propose file edits.'
      : 'You are Sketch, a coding assistant. When you propose code, put it in one fenced code block with the file path as the language tag when you know it, e.g. ```src/app.js.'
  return {
    url: `${base}/chat/completions`,
    headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
    body: {
      model: config.model,
      messages: [
        { role: 'system', content: system },
        ...historyFor(history, speed).map((t) => ({ role: t.role, content: t.content })),
        { role: 'user', content: prompt },
      ],
      max_tokens: speed === 'turbo' ? 1500 : 4000,
    },
  }
}

export async function sendChat(
  config: ProviderConfig,
  history: readonly ChatTurn[],
  prompt: string,
  mode: AgentMode,
  speed: AgentSpeed,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (config.baseUrl.trim() === '' || config.model.trim() === '') {
    throw new Error('No provider configured. Add a base URL and model in Settings first.')
  }
  const request = buildChatRequest(config, history, prompt, mode, speed)
  const res = await fetchImpl(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body) })
  if (!res.ok) throw new Error(`The provider answered ${res.status}. Check the base URL, model and key in Settings.`)
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = data.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.trim() === '') throw new Error('The provider returned an empty reply.')
  return content
}

/** The first fenced code block in a reply, if the model proposed code. */
export function firstCodeBlock(reply: string): { path: string | null; code: string } | null {
  const match = /```([^\n`]*)\n([\s\S]*?)```/.exec(reply)
  if (match === null) return null
  const tag = (match[1] ?? '').trim()
  return { path: tag !== '' && tag.includes('.') ? tag : null, code: (match[2] ?? '').replace(/\n$/, '') }
}
