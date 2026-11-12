// The non-run usage ledger: recordUsage → summarizeUsage, under an ISOLATED home so no
// test writes the real ~/.sketch. Proves completions / inline edits / commit messages /
// connection tests / model listing are counted by cause, that unknown tokens stay
// unknown (never 0), that a key/prompt/reply is never written, and that a malformed line
// is skipped not absorbed.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordUsage, summarizeUsage, usageDir } from '../src/cost/usage-log.js'

const homes: string[] = []
afterEach(async () => {
  while (homes.length) await rm(homes.pop()!, { recursive: true, force: true }).catch(() => {})
})
async function home(): Promise<string> {
  const h = await mkdtemp(join(tmpdir(), 'usage-home-'))
  homes.push(h)
  return h
}

describe('the non-run usage ledger', () => {
  it('records calls by cause and rolls them up, with tokens summed', async () => {
    const h = await home()
    await recordUsage({ cause: 'completion', provider: 'openai', requestedModel: 'gpt-4o', usage: { in: 10, out: 5 } }, h)
    await recordUsage({ cause: 'completion', provider: 'openai', requestedModel: 'gpt-4o', usage: { in: 20, out: 7 } }, h)
    await recordUsage({ cause: 'inline-edit', provider: 'openai', requestedModel: 'gpt-4o', usage: { in: 100, out: 40 } }, h)

    const summary = await summarizeUsage(h)
    expect(summary.total.calls).toBe(3)
    const completion = summary.byCause.find((c) => c.cause === 'completion')!
    expect(completion.calls).toBe(2)
    expect(completion.tokensIn).toBe(30)
    expect(completion.tokensOut).toBe(12)
    const inlineEdit = summary.byCause.find((c) => c.cause === 'inline-edit')!
    expect(inlineEdit.calls).toBe(1)
  })

  it('shows unknown-usage calls as unknown, never as 0 tokens', async () => {
    const h = await home()
    // A connection test spends a request but has no token usage.
    await recordUsage({ cause: 'connection-test', provider: 'groq', usage: null, ok: true }, h)
    const summary = await summarizeUsage(h)
    const test = summary.byCause.find((c) => c.cause === 'connection-test')!
    expect(test.calls).toBe(1)
    expect(test.usageUnknown).toBe(1)
    expect(test.tokensIn).toBe(0) // nothing to add — NOT a measured zero
    expect(summary.total.usageUnknown).toBe(1)
  })

  it('flags estimated numbers and failures', async () => {
    const h = await home()
    await recordUsage({ cause: 'completion', provider: 'fake', usage: { in: 4, out: 4 }, usageEstimated: true }, h)
    await recordUsage({ cause: 'model-list', provider: 'openai', usage: null, ok: false }, h)
    const summary = await summarizeUsage(h)
    expect(summary.total.usageEstimated).toBe(1)
    expect(summary.total.failed).toBe(1)
  })

  it('never writes a key, a prompt, or a reply to the log file', async () => {
    const h = await home()
    // Even if a caller were to pass extra properties, only the whitelist is written.
    await recordUsage(
      { cause: 'completion', provider: 'openai', requestedModel: 'gpt-4o', usage: { in: 1, out: 1 }, root: 'C:/proj' } as never,
      h,
    )
    const dir = usageDir(h)
    const files = await readdir(dir)
    const text = await readFile(join(dir, files[0]!), 'utf8')
    expect(text).not.toMatch(/sk-/)
    expect(text).not.toMatch(/prompt|reply|messages|apiKey|authorization/i)
    const record = JSON.parse(text.trim())
    expect(Object.keys(record).sort()).toEqual(
      ['answeredModel', 'attempts', 'cause', 'ok', 'provider', 'requestedModel', 'root', 'ts', 'usage', 'usageEstimated'].sort(),
    )
    expect(record.root).toBe('C:/proj')
  })

  it('skips a malformed line rather than absorbing it, and keeps the good ones', async () => {
    const h = await home()
    const dir = usageDir(h)
    await mkdir(dir, { recursive: true })
    const day = new Date().toISOString().slice(0, 10)
    await writeFile(
      join(dir, `${day}.jsonl`),
      [JSON.stringify({ ts: Date.now(), cause: 'completion', usage: { in: 5, out: 5 } }), '{ not json', ''].join('\n'),
      'utf8',
    )
    const summary = await summarizeUsage(h)
    expect(summary.total.calls).toBe(1)
    expect(summary.skipped).toBe(1)
  })

  it('is empty (no throw) when nothing has been recorded', async () => {
    const h = await home()
    const summary = await summarizeUsage(h)
    expect(summary.total.calls).toBe(0)
    expect(summary.byCause).toEqual([])
  })
})
