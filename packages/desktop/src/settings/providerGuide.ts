// What a person needs to know to connect each provider: where its keys live, whether
// it has a free tier, and which of the models it lists is a sensible first choice.
//
// This is guidance, not configuration. Endpoints and ids come from the engine's
// registry (`PROVIDER_CATALOG`); the model list comes from the provider itself
// (`provider-models`). Nothing here names a model that must exist: `preferred` is a
// list of patterns matched against what the provider actually returned, and when none
// matches, the first chat model it listed is offered instead.

import type { ProviderModel } from '../lib/client'

export interface ProviderGuide {
  /** Where to create a key. Opened in the system browser. */
  keyUrl?: string
  /** One line under the provider's name. */
  tagline: string
  /** Shown as a badge. */
  badge?: 'Free tier' | 'Free models' | 'Local' | 'Recommended'
  /** What the key looks like, for the input's placeholder. */
  keyHint?: string
  /** Patterns tried in order against the fetched model ids. */
  preferred: RegExp[]
  /** Help when the local runtime is not answering. */
  localHelp?: string
  /** Wizard grouping. */
  group: 'account' | 'key' | 'local' | 'advanced'
}

export const PROVIDER_GUIDES: Readonly<Record<string, ProviderGuide>> = {
  chatgpt: {
    tagline: 'Use your ChatGPT account — Free, Plus, Pro or Business. No API key, no per-token bill.',
    badge: 'Recommended',
    // Codex's own order: the live list arrives already sorted, so the first one wins.
    preferred: [/./],
    group: 'account',
  },
  openrouter: {
    keyUrl: 'https://openrouter.ai/settings/keys',
    tagline: 'One account for hundreds of models — Claude, GPT, Gemini, Llama, DeepSeek — including free ones.',
    badge: 'Free models',
    keyHint: 'sk-or-v1-…',
    preferred: [/qwen.*coder.*:free$/i, /deepseek.*:free$/i, /:free$/i, /claude.*sonnet/i, /gpt-5/i],
    group: 'account',
  },
  gemini: {
    keyUrl: 'https://aistudio.google.com/apikey',
    tagline: 'Google Gemini with a generous free tier from Google AI Studio.',
    badge: 'Free tier',
    keyHint: 'AIza…',
    preferred: [/gemini-[\d.]+-flash$/i, /flash/i, /gemini-[\d.]+-pro$/i, /gemini/i],
    group: 'key',
  },
  groq: {
    keyUrl: 'https://console.groq.com/keys',
    tagline: 'Very fast open models (Llama, Qwen, GPT-OSS) with a free, rate-limited tier.',
    badge: 'Free tier',
    keyHint: 'gsk_…',
    preferred: [/qwen.*coder/i, /llama-3\.3-70b/i, /gpt-oss-120b/i, /qwen/i, /llama/i],
    group: 'key',
  },
  'github-models': {
    keyUrl: 'https://github.com/settings/personal-access-tokens/new',
    tagline: 'Free, rate-limited access with a GitHub token that has the "Models" read permission.',
    badge: 'Free tier',
    keyHint: 'github_pat_…',
    preferred: [/gpt-4\.1-mini/i, /gpt-4o-mini/i, /gpt-4\.1/i, /gpt/i],
    group: 'key',
  },
  cerebras: {
    keyUrl: 'https://cloud.cerebras.ai',
    tagline: 'Fast inference for open models, with a free tier.',
    badge: 'Free tier',
    preferred: [/qwen.*coder/i, /gpt-oss/i, /llama-3\.3-70b/i, /llama/i],
    group: 'key',
  },
  nvidia: {
    keyUrl: 'https://build.nvidia.com',
    tagline: 'NVIDIA NIM: hosted open models with free developer credits.',
    badge: 'Free tier',
    keyHint: 'nvapi-…',
    preferred: [/qwen.*coder/i, /deepseek/i, /llama-3\.3-70b/i, /nemotron/i],
    group: 'key',
  },
  openai: {
    keyUrl: 'https://platform.openai.com/api-keys',
    tagline: 'GPT models, billed by usage on your OpenAI account.',
    keyHint: 'sk-…',
    preferred: [/^gpt-5(\.\d+)?-mini$/i, /^gpt-5/i, /^gpt-4\.1-mini$/i, /^gpt-4o-mini$/i, /^gpt-4/i, /^o\d/i],
    group: 'key',
  },
  anthropic: {
    keyUrl: 'https://console.anthropic.com/settings/keys',
    tagline: 'Claude models, billed by usage on your Anthropic Console account.',
    keyHint: 'sk-ant-…',
    preferred: [/sonnet/i, /haiku/i, /opus/i, /claude/i],
    group: 'key',
  },
  grok: {
    keyUrl: 'https://console.x.ai',
    tagline: 'xAI Grok models, billed by usage.',
    keyHint: 'xai-…',
    preferred: [/code/i, /grok-\d/i, /grok/i],
    group: 'key',
  },
  deepseek: {
    keyUrl: 'https://platform.deepseek.com/api_keys',
    tagline: 'DeepSeek models at low per-token prices.',
    keyHint: 'sk-…',
    preferred: [/deepseek-chat/i, /deepseek/i],
    group: 'key',
  },
  mistral: {
    keyUrl: 'https://console.mistral.ai/api-keys',
    tagline: 'Mistral and Codestral models.',
    preferred: [/codestral/i, /devstral/i, /mistral-large/i, /mistral/i],
    group: 'key',
  },
  kimi: {
    keyUrl: 'https://platform.moonshot.ai/console/api-keys',
    tagline: 'Moonshot Kimi models. Mainland-China accounts use https://api.moonshot.cn/v1.',
    keyHint: 'sk-…',
    preferred: [/kimi-k2/i, /kimi/i, /moonshot/i],
    group: 'key',
  },
  ollama: {
    tagline: 'Free and private: models run on this computer. Nothing leaves the machine.',
    badge: 'Local',
    preferred: [/coder/i, /qwen/i, /llama/i, /deepseek/i],
    localHelp: 'Install Ollama from ollama.com, then run "ollama pull qwen2.5-coder" in a terminal.',
    group: 'local',
  },
  lmstudio: {
    tagline: 'Free and private: run models with LM Studio on this computer.',
    badge: 'Local',
    preferred: [/coder/i, /qwen/i, /llama/i],
    localHelp: 'Open LM Studio, load a model, and start the local server (Developer tab).',
    group: 'local',
  },
  llamacpp: {
    tagline: 'Free and private: a llama.cpp server on this computer.',
    badge: 'Local',
    preferred: [/./],
    localHelp: 'Start it with: llama-server -m <model.gguf> --port 8080',
    group: 'local',
  },
  'azure-openai': {
    keyUrl: 'https://portal.azure.com',
    tagline: 'Your Azure OpenAI resource. Use the …/openai/v1 endpoint of the resource.',
    preferred: [/./],
    group: 'advanced',
  },
  'cloudflare-workers-ai': {
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    tagline: 'Workers AI. Endpoint: https://api.cloudflare.com/client/v4/accounts/<account id>/ai/v1',
    preferred: [/coder/i, /llama/i],
    group: 'advanced',
  },
  custom: {
    tagline: 'Any OpenAI-compatible endpoint: vLLM, LiteLLM, a proxy, or another provider.',
    preferred: [/./],
    group: 'advanced',
  },
}

/**
 * Shown when Ollama is connected. Ollama's default context window is 4,096 tokens
 * (docs.ollama.com/faq), too small for agent work, and its OpenAI-compatible endpoint
 * ignores a per-request `num_ctx`, so the server-wide setting is the reliable fix.
 */
export const OLLAMA_CONTEXT_NOTE =
  'Ollama reads only 4,096 tokens of each request by default and silently drops the rest. For agent work, set the environment variable OLLAMA_CONTEXT_LENGTH=32768 and restart Ollama.'

export function guideFor(id: string): ProviderGuide {
  return PROVIDER_GUIDES[id] ?? { tagline: 'An OpenAI-compatible endpoint.', preferred: [/./], group: 'advanced' }
}

/** The model to preselect: the first preference that matches what the provider listed. */
export function preferredModel(providerId: string, models: readonly ProviderModel[]): string | null {
  if (models.length === 0) return null
  for (const pattern of guideFor(providerId).preferred) {
    const hit = models.find((model) => pattern.test(model.id))
    if (hit !== undefined) return hit.id
  }
  return models[0]!.id
}

/** Price as a person reads it. Null when the provider published none. */
export function describePrice(model: ProviderModel): string | null {
  if (model.free) return 'free'
  if (model.inputPerMillion === undefined || model.outputPerMillion === undefined) return null
  const fmt = (n: number) => (n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3))
  return `$${fmt(model.inputPerMillion)} / $${fmt(model.outputPerMillion)} per M tokens`
}

export function describeContext(model: ProviderModel): string | null {
  if (model.contextLength === undefined) return null
  const k = model.contextLength / 1000
  return k >= 1000 ? `${(k / 1000).toFixed(1)}M ctx` : `${Math.round(k)}K ctx`
}
