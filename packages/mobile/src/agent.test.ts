import { describe, expect, it, vi } from 'vitest'

import { buildChatRequest, firstCodeBlock, historyFor, maxModelTurns, sendChat, type ChatTurn, type ProviderConfig } from './agent'

const config: ProviderConfig = { baseUrl: 'https://example.test/v1/', model: 'test-model', apiKey: 'sk-test' }
const history: ChatTurn[] = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i}` }))

describe('mobile agent', () => {
  it('sends fewer turns in Turbo than in Normal', () => {
    expect(historyFor(history, 'normal')).toHaveLength(12)
    expect(historyFor(history, 'turbo')).toHaveLength(6)
  })

  it('caps model turns in Turbo', () => {
    expect(maxModelTurns('agent', 'normal')).toBe(30)
    expect(maxModelTurns('agent', 'turbo')).toBe(10)
    expect(maxModelTurns('auto', 'turbo')).toBe(20)
  })

  it('builds an OpenAI-compatible request with the configured model', () => {
    const request = buildChatRequest(config, history, 'hi', 'agent', 'normal')
    expect(request.url).toBe('https://example.test/v1/chat/completions')
    expect(request.headers.Authorization).toBe('Bearer sk-test')
    expect(request.body.model).toBe('test-model')
    const messages = request.body.messages as Array<{ role: string }>
    expect(messages).toHaveLength(1 + 12 + 1) // system + history + prompt
  })

  it('sends the request and returns the reply text', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hello back' } }] }),
    } as unknown as Response))
    await expect(sendChat(config, [], 'hi', 'ask', 'normal', fetchImpl as unknown as typeof fetch)).resolves.toBe('hello back')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('refuses to send without a provider', async () => {
    await expect(sendChat({ baseUrl: '', model: '', apiKey: '' }, [], 'hi', 'ask', 'normal')).rejects.toThrow('No provider configured')
  })

  it('finds a fenced code block to apply', () => {
    expect(firstCodeBlock('here:\n```src/app.js\nconst x = 1\n```')).toEqual({ path: 'src/app.js', code: 'const x = 1' })
    expect(firstCodeBlock('no code here')).toBeNull()
  })
})
