// API keys from the environment — the headless and CI path.
//
// Every coding agent people already use reads the conventional variables
// (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, …), so a developer who has
// exported one should not have to paste it again. This is a FALLBACK: a key supplied
// with the request (the desktop resolves one from the OS credential store) always
// wins, and a provider with no variable set behaves exactly as before.
//
// Nothing new crosses a boundary here. The engine already treats every
// credential-named environment variable as a secret to scrub from every frame and
// event (`envSecrets`), so a key read from the environment is redacted everywhere a
// supplied key is. Only variable NAMES ever leave this module towards a surface.

/** `SKETCH_<ID>_API_KEY` first, then the variables each provider documents. */
export const PROVIDER_ENV_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  grok: ['XAI_API_KEY'],
  kimi: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  'github-models': ['GITHUB_TOKEN', 'GH_TOKEN'],
  'azure-openai': ['AZURE_OPENAI_API_KEY'],
  'cloudflare-workers-ai': ['CLOUDFLARE_API_TOKEN'],
  deepseek: ['DEEPSEEK_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  nvidia: ['NVIDIA_API_KEY'],
})

/** The Sketch-specific override for any provider id, including custom ones. */
export function sketchEnvName(providerId: string): string {
  return `SKETCH_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/** Variable names consulted for a provider, in priority order. */
export function envNamesFor(providerId: string): string[] {
  return [sketchEnvName(providerId), ...(PROVIDER_ENV_KEYS[providerId] ?? [])]
}

/** The first non-blank variable for a provider: its NAME and value, or null. */
export function apiKeyFromEnv(
  providerId: string,
  env: Record<string, string | undefined>,
): { name: string; value: string } | null {
  for (const name of envNamesFor(providerId)) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') return { name, value: value.trim() }
  }
  return null
}

/**
 * Which providers have a key in the environment, by variable NAME. For a surface
 * that wants to say "using OPENAI_API_KEY from your environment". Never a value.
 */
export function envKeyPresence(
  providerIds: readonly string[],
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const id of providerIds) {
    const found = apiKeyFromEnv(id, env)
    if (found !== null) out[id] = found.name
  }
  return out
}
