// Adapters for OpenAI-compatible providers: Groq, Ollama, OpenRouter, Grok, Kimi, LM Studio, custom.
// They reuse OpenAIAdapter's wire format and only differ in base URL, auth, and cost table.

import { OpenAIAdapter } from './openai.js'
import type { Model, TokenUsage } from './types.js'

// Groq — fast inference, OpenAI-compatible
export class GroqAdapter extends OpenAIAdapter {
  readonly id = 'groq'
  readonly name = 'Groq'
  protected defaultBaseUrl() { return 'https://api.groq.com/openai/v1' }
  estimateCost(_usage: TokenUsage, _modelId: string): number {
    // Groq pricing varies by model; update per https://groq.com/pricing
    return 0
  }
}

// OpenRouter — one key, many models. The onboarding path for new users.
export class OpenRouterAdapter extends OpenAIAdapter {
  readonly id = 'openrouter'
  readonly name = 'OpenRouter'
  protected defaultBaseUrl() { return 'https://openrouter.ai/api/v1' }
  estimateCost(_usage: TokenUsage, _modelId: string): number {
    // OpenRouter returns per-request cost in its response; prefer that over a static table.
    return 0
  }
}

// xAI Grok — OpenAI-compatible
export class GrokAdapter extends OpenAIAdapter {
  readonly id = 'grok'
  readonly name = 'Grok (xAI)'
  protected defaultBaseUrl() { return 'https://api.x.ai/v1' }
  estimateCost(_usage: TokenUsage, _modelId: string): number { return 0 }
}

// Moonshot Kimi — OpenAI-compatible
export class KimiAdapter extends OpenAIAdapter {
  readonly id = 'kimi'
  readonly name = 'Kimi (Moonshot)'
  protected defaultBaseUrl() { return 'https://api.moonshot.cn/v1' }
  estimateCost(_usage: TokenUsage, _modelId: string): number { return 0 }
}

// Ollama — local, no API key required. Cost is always zero.
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

  estimateCost(): number { return 0 } // local inference is free
}

// LM Studio — local, OpenAI-compatible
export class LMStudioAdapter extends OllamaAdapter {
  readonly id = 'lmstudio'
  readonly name = 'LM Studio (local)'
  protected defaultBaseUrl() { return 'http://localhost:1234/v1' }
}

// Generic custom endpoint — user supplies base URL and key
export class CustomAdapter extends OpenAIAdapter {
  readonly id = 'custom'
  readonly name = 'Custom (OpenAI-compatible)'
  protected defaultBaseUrl() { return '' }
  estimateCost(): number { return 0 }
}
