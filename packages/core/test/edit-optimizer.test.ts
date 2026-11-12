import { describe, expect, it } from 'vitest'

import { FakeChatAdapter } from '../src/providers/fake.js'
import { providerProposeEdits } from '../src/skills/editOptimizer.js'
import type { EvalResult, Skill } from '../src/types.js'

const SEED: Skill = {
  name: 'context-packing',
  description: 'Choose what code the model sees.',
  body: 'Include the file the question is about. Prefer signatures over bodies.',
  source: 'test',
  capabilities: ['fs:read:project'],
}

const FAILING: EvalResult[] = [
  { caseId: 'fails', score: 0, passed: false, passedChecks: 0, totalChecks: 1, detail: 'missing "signature"' },
]

const edits = (list: unknown[]) => ['```edits', JSON.stringify(list), '```'].join('\n')

describe('SkillOpt-style edit optimizer', () => {
  it('applies a few anchored edits and moves only the body', async () => {
    const propose = providerProposeEdits({
      adapter: new FakeChatAdapter({
        script: [
          edits([
            { op: 'add', text: 'Quote every error verbatim with its path and line.', after: 'Include the file the question is about.' },
            { op: 'replace', find: 'Prefer', text: 'Always prefer' },
          ]),
        ],
      }),
    })
    const candidate = await propose(SEED, FAILING)
    expect(candidate?.body).toBe(
      'Include the file the question is about.\nQuote every error verbatim with its path and line. Always prefer signatures over bodies.',
    )
    expect(candidate?.capabilities).toEqual(['fs:read:project'])
    expect(candidate?.name).toBe(SEED.name)
  })

  it('returns no candidate when no edit applies', async () => {
    const propose = providerProposeEdits({
      adapter: new FakeChatAdapter({ script: [edits([{ op: 'delete', find: 'not in the skill' }])] }),
    })
    expect(await propose(SEED, FAILING)).toBeNull()
  })

  it('remembers edits the gate rejected and lists them in the next prompt', async () => {
    const adapter = new FakeChatAdapter({
      script: [edits([{ op: 'add', text: 'Always include the whole repository in the prompt.' }]), edits([])],
    })
    const rejected: string[] = []
    const propose = providerProposeEdits({ adapter, rejected })

    expect(await propose(SEED, FAILING)).not.toBeNull()
    // The trainer kept the incumbent (the same body comes back): that edit was rejected.
    expect(await propose(SEED, FAILING)).toBeNull()

    expect(rejected).toEqual(['add "Always include the whole repository in the prompt."'])
    const secondPrompt = JSON.stringify(adapter.calls[1])
    expect(secondPrompt).toContain('Already tried and rejected by validation')
    expect(secondPrompt).toContain('Always include the whole repository')
  })

  it('records the last round\u2019s edits once training ends with the incumbent kept', async () => {
    const adapter = new FakeChatAdapter({
      script: [edits([{ op: 'add', text: 'Always include the whole repository in the prompt.' }])],
    })
    const rejected: string[] = []
    const propose = providerProposeEdits({ adapter, rejected })

    expect(await propose(SEED, FAILING)).not.toBeNull()
    // No later call will come, so only settling tells the proposer what the gate did.
    expect(rejected).toEqual([])
    propose.settle(SEED)
    expect(rejected).toEqual(['add "Always include the whole repository in the prompt."'])
    propose.settle(SEED)
    expect(rejected).toHaveLength(1)
  })

  it('does not record edits the gate accepted', async () => {
    const adapter = new FakeChatAdapter({
      script: [edits([{ op: 'replace', find: 'Prefer', text: 'Always prefer' }])],
    })
    const rejected: string[] = []
    const propose = providerProposeEdits({ adapter, rejected })

    const candidate = await propose(SEED, FAILING)
    expect(candidate).not.toBeNull()
    propose.settle(candidate!)
    expect(rejected).toEqual([])
  })

  it('stops at the call budget without asking the model', async () => {
    const adapter = new FakeChatAdapter({ script: [edits([{ op: 'add', text: 'one more rule for the model to follow' }])] })
    const ledger = { calls: 0, tokens: 0, refusal: null as string | null }
    const propose = providerProposeEdits({ adapter, ledger, budget: { maxCalls: 0 } })
    expect(await propose(SEED, FAILING)).toBeNull()
    expect(ledger.refusal).toMatch(/training budget reached/)
    expect(adapter.calls).toHaveLength(0)
  })
})
