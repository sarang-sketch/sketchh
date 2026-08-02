// Adapters for OpenAI-compatible providers: Groq, Ollama, OpenRouter, Grok, Kimi, LM Studio, custom.
// They reuse OpenAIAdapter's wire format and only differ in base URL and auth.
//
// ── SIX `estimateCost` STUBS WERE DELETED FROM THIS FILE ────────────────────
//
// Every class here used to override `estimateCost` with `return 0`. For Ollama and LM
// Studio that was true — they run on the user's machine. For Groq, OpenRouter, Grok,
// Kimi and a custom endpoint it was a LIE THAT READ AS FREE: a real run against a
// hosted provider reported no cost at all.
//
// There is now one implementation, in `BaseAdapter`, delegating to the one price table
// in `cost/pricing.ts`. It prices any model the table knows whatever provider serves it,
// and the two local runtimes get a real zero through that table's provider fallback
// rather than through a hardcoded return.

import { OpenAIAdapter } from './openai.js'
import type { Model } from './types.js'

// Groq — fast inference, OpenAI-compatible
export class GroqAdapter extends OpenAIAdapter {
  readonly id = 'groq'
  readonly name = 'Groq'
  protected defaultBaseUrl() { return 'https://api.groq.com/openai/v1' }
}

// OpenRouter — one key, many models. The onboarding path for new users.
//
// OpenRouter returns a per-request cost in its own response body, which is better than
// any static table. Reading it is not done here: it would need the raw response to
// survive the adapter's parse, and the ledger's contract is that cost is derived from
// the event log. Recorded as an improvement, not implemented as a guess.
export class OpenRouterAdapter extends OpenAIAdapter {
  readonly id = 'openrouter'
  readonly name = 'OpenRouter'
  protected defaultBaseUrl() { return 'https://openrouter.ai/api/v1' }
}

// xAI Grok — OpenAI-compatible
export class GrokAdapter extends OpenAIAdapter {
  readonly id = 'grok'
  readonly name = 'Grok (xAI)'
  protected defaultBaseUrl() { return 'https://api.x.ai/v1' }
}

// Moonshot Kimi — OpenAI-compatible
export class KimiAdapter extends OpenAIAdapter {
  readonly id = 'kimi'
  readonly name = 'Kimi (Moonshot)'
  protected defaultBaseUrl() { return 'https://api.moonshot.cn/v1' }
}

// Ollama — local, no API key required. Cost is a real zero, from the price table.
export class OllamaAdapter extends OpenAIAdapter {
  readonly id: string = 'ollama'
  readonly name: string = 'Ollama (local)'
  protected defaultBaseUrl() { return 'http://localhost:11434/v1' }

  // Ollama needs no auth — override the key assertion to a no-op.
  protected assertApiKey(): void { /* local, no key needed */ }

  async listModels(): Promise<Model[]> {
    // Ollama exposes /api/tags on the root host, not the /v1 path.
    const root = this.baseUrl.replace(/\/v1\/?$/, '')
    try {
      const data = await this.fetchJson<{ models: Array<{ name: string }> }>(
        `${root}/api/tags`,
        { headers: { 'Content-Type': 'application/json' } }
      )
      return data.models.map(m => ({ id: m.name, name: m.name, contextWindow: 8192 }))
    } catch {
      return []
    }
  }
}

// LM Studio — local, OpenAI-compatible
export class LMStudioAdapter extends OllamaAdapter {
  readonly id = 'lmstudio'
  readonly name = 'LM Studio (local)'
  protected defaultBaseUrl() { return 'http://localhost:1234/v1' }
}

// Generic custom endpoint — user supplies base URL and key.
//
// Deliberately NOT priced at zero. A custom endpoint is whatever the user pointed it at,
// which is often a hosted model that costs money, so an unrecognised model here reports
// unpriced through the ledger rather than free.
export class CustomAdapter extends OpenAIAdapter {
  readonly id = 'custom'
  readonly name = 'Custom (OpenAI-compatible)'
  protected defaultBaseUrl() { return '' }
}
