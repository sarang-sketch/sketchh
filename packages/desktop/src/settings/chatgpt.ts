// The window's side of "Sign in with ChatGPT": names, the settings entry, and how a
// plan reads on screen. No tokens pass through here — the engine keeps those.

import type { ChatGPTModelInfo, ProviderModel } from '../lib/client'
import type { ProviderSettingsEntry } from '../lib/contracts'

export const CHATGPT_ID = 'chatgpt'
/** The fixed endpoint, mirrored from the engine's catalog. The engine ignores any other. */
export const CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/codex'

const PLAN_NAMES: Readonly<Record<string, string>> = {
  free: 'Free',
  free_workspace: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro',
  promax: 'Pro',
  team: 'Business',
  business: 'Business',
  self_serve_business_prolite: 'Business',
  self_serve_business_usage_based: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
  edu_plus: 'Edu',
  edu_pro: 'Edu',
  education: 'Edu',
  k12: 'Edu',
}

/** "plus" → "Plus"; an unknown plan id is title-cased rather than hidden. */
export function describePlan(plan: string | undefined): string | null {
  if (plan === undefined || plan.trim() === '') return null
  const key = plan.trim().toLowerCase()
  const known = PLAN_NAMES[key]
  if (known !== undefined) return known
  return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** "Signed in as person@example.com · Plus" — or as little of it as is known. */
export function describeAccount(account: { email?: string; plan?: string } | undefined): string {
  if (account === undefined) return 'Signed in to ChatGPT'
  const plan = describePlan(account.plan)
  const who = account.email !== undefined ? `Signed in as ${account.email}` : 'Signed in to ChatGPT'
  return plan === null ? who : `${who} · ${plan}`
}

/** The key-free providers.json entry for a ChatGPT account. */
export function chatgptEntry(model: string): ProviderSettingsEntry {
  return { id: CHATGPT_ID, kind: 'openai-compatible', baseUrl: CHATGPT_BASE_URL, model, label: 'ChatGPT' }
}

/** The engine's ChatGPT models, in the shape the model pickers already render. */
export function toProviderModels(models: readonly ChatGPTModelInfo[]): ProviderModel[] {
  return models.map((m) => ({
    id: m.id,
    ...(m.name !== m.id ? { name: m.name } : {}),
    ...(m.contextLength !== undefined ? { contextLength: m.contextLength } : {}),
  }))
}
