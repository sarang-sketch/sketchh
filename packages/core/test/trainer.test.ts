// SkillOpt trainer tests — the strict held-out validation gate.
//
// Uses REAL: the eval harness (which mkdtemps a workspace per case), the real
// agent loop, a real MemoryEventStore, the real filesystem for the artifact
// round trip. The only substituted collaborators are the model and the
// optimizer, both of which are seams by design.
//
// HOW A SKILL CAUSALLY CHANGES THE SCORE OFFLINE. The score is never faked. Each
// eval case asks about one `topic-N` and checks the run output for
// `ANSWER topic-N`. `SkillAwareAdapter` reads the SYSTEM messages it is handed —
// which is exactly how `runTask` injects a skill — and answers a topic only when
// some skill body in front of it declares `covers: topic-N`. So the skill body
// decides the eval score through the same path a real model would use, and a
// candidate's validation mean moves because its BODY changed. A gate tested
// against a hardcoded number would prove nothing.
//
// THE TEST THAT MATTERS MOST is "a candidate that ties is REJECTED": strict `>`
// is the entire anti-rot mechanism, and `>=` would let noise ratchet a skill
// into decay one equal-scoring step at a time.
//
// Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.8

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  trainSkill,
  splitCases,
  serializeSkill,
  scriptedProposeEdit,
  loadSkillFile,
  BEST_SKILL_FILENAME,
} from '../src/skills/index.js'
import type { ProposeEdit } from '../src/skills/index.js'
import { runEvalSet, meanScore } from '../src/evals/index.js'
import { MemoryEventStore } from '../src/events/index.js'
import type { ChatAdapter, EvalCase, EvalResult, Message, Skill, Usage } from '../src/types.js'

const tmpDirs: string[] = []

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-trainer-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

/**
 * A deterministic offline model that ANSWERS A TOPIC ONLY WHEN A SKILL TOLD IT
 * HOW. No network, no key, no randomness. This is the causal link between a
 * skill's body and the eval score.
 */
class SkillAwareAdapter implements ChatAdapter {
  readonly id = 'skill-aware'
  calls = 0

  async chat(messages: Message[]): Promise<{ text: string; usage?: Usage }> {
    this.calls++

    const covered = new Set<string>()
    for (const message of messages) {
      if (message.role !== 'system') continue
      for (const match of message.content.matchAll(/covers:\s*(topic-\d+)/g)) {
        covered.add(match[1]!)
      }
    }

    const prompt = messages.find((m) => m.role === 'user')?.content ?? ''
    const topic = /(topic-\d+)/.exec(prompt)?.[1] ?? 'topic-unknown'

    const text = covered.has(topic)
      ? `ANSWER ${topic}: applied the documented procedure.`
      : `I have no guidance for ${topic} and cannot answer it.`

    return { text: JSON.stringify({ action: 'done', text }), usage: { in: 0, out: 0 } }
  }
}

/** One case per topic. Passes only when the answer for that topic was produced. */
function topicCase(n: number): EvalCase {
  return {
    id: `c${n}`,
    task: { id: `task-c${n}`, prompt: `Solve topic-${n}, please.`, verify: [] },
    checks: [{ kind: 'contains', text: `ANSWER topic-${n}` }],
  }
}

/** A skill whose body declares which topics it covers. The body IS the state. */
function skill(name: string, topics: readonly number[], note = ''): Skill {
  const lines = ['# Procedure', ...topics.map((n) => `covers: topic-${n}`)]
  if (note !== '') lines.push('', note)
  return {
    name,
    description: `Handles topics ${topics.join(', ') || '(none)'}.`,
    body: lines.join('\n'),
    source: `memory:${name}`,
  }
}

interface Harness {
  events: MemoryEventStore
  adapter: SkillAwareAdapter
}

function harness(): Harness {
  return { events: new MemoryEventStore({ secrets: [] }), adapter: new SkillAwareAdapter() }
}

const TRAIN = [topicCase(1), topicCase(2)]
const VAL = [topicCase(3), topicCase(4)]

describe('the strict validation gate (Requirements 9.3, 9.4, 9.8)', () => {
  it('ACCEPTS a candidate that scores strictly higher on validation', async () => {
    const h = harness()
    const seed = skill('reviewer', [1, 2, 3]) // val: c3 pass, c4 fail → 0.5
    const better = skill('reviewer', [1, 2, 3, 4]) // val: both pass → 1.0

    const result = await trainSkill({
      seed,
      train: TRAIN,
      val: VAL,
      epochs: 1,
      proposeEdit: scriptedProposeEdit([better]),
      events: h.events,
      adapter: h.adapter,
    })

    expect(result.baselineValScore).toBe(0.5)
    expect(result.valScore).toBe(1)
    expect(result.skill).toBe(better)
    expect(result.skill.body).toContain('covers: topic-4')
    expect(result.accepted).toBe(1)
    expect(result.improved).toBe(true)
    expect(result.epochs[0]!.verdict).toBe('accepted')
  })

  it('REJECTS a candidate that scores lower and returns the incumbent unchanged', async () => {
    const h = harness()
    const seed = skill('reviewer', [1, 2, 3])
    const worse = skill('reviewer', []) // val: 0.0

    const result = await trainSkill({
      seed,
      train: TRAIN,
      val: VAL,
      epochs: 1,
      proposeEdit: scriptedProposeEdit([worse]),
      events: h.events,
      adapter: h.adapter,
    })

    expect(result.epochs[0]!.candidateScore).toBe(0)
    expect(result.epochs[0]!.verdict).toBe('rejected')
    expect(result.skill).toBe(seed)
    expect(result.skill.body).toBe(seed.body)
    expect(result.valScore).toBe(0.5)
    expect(result.accepted).toBe(0)
    expect(result.improved).toBe(false)
  })

  it('REJECTS a candidate that scores EXACTLY EQUAL — ties keep the incumbent', async () => {
    // THE STRICT-GATE TEST. This is the anti-rot property: a `>=` gate would let
    // a random walk of equal-scoring rewrites ratchet the skill into decay, each
    // step individually "not a regression". The tie must lose.
    const h = harness()
    const seed = skill('reviewer', [1, 2, 3], 'Original wording.')
    // Same coverage, different body: a real rewrite that measures identically.
    const tie = skill('reviewer', [1, 2, 3], 'Completely rewritten wording, same coverage.')

    const result = await trainSkill({
      seed,
      train: TRAIN,
      val: VAL,
      epochs: 1,
      proposeEdit: scriptedProposeEdit([tie]),
      events: h.events,
      adapter: h.adapter,
    })

    const epoch = result.epochs[0]!
    expect(tie.body).not.toBe(seed.body) // it really was a different candidate
    expect(epoch.candidateScore).toBe(epoch.incumbentScore) // and it really tied
    expect(epoch.verdict).toBe('rejected')
    expect(epoch.reason).toContain('not strictly greater')
    expect(epoch.reason).toContain('ties keep the incumbent')
    expect(result.skill).toBe(seed)
    expect(result.accepted).toBe(0)
    expect(result.improved).toBe(false)
  })

  it('skips the epoch without touching the incumbent when proposeEdit returns null', async () => {
    const h = harness()
    const seed = skill('reviewer', [1, 2, 3])

    const result = await trainSkill({
      seed,
      train: TRAIN,
      val: VAL,
      epochs: 1,
      proposeEdit: scriptedProposeEdit([null]),
      events: h.events,
      adapter: h.adapter,
    })

    expect(result.epochs[0]!.verdict).toBe('no_proposal')
    expect(result.epochs[0]!.candidateScore).toBeNull()
    expect(result.skill).toBe(seed)
    expect(result.valScore).toBe(0.5)
    // Baseline val (2 cases) + one train pass (2 cases). No candidate was scored.
    expect(h.adapter.calls).toBe(4)
  })
})

describe('acceptance is decided on the held-out split ONLY (Requirement 9.2)', () => {
  it('rejects a candidate that is better on TRAIN and worse on VAL', async () => {
    const h = harness()
    // Seed: half of train, half of val.
    const seed = skill('reviewer', [1, 3])
    // Candidate: all of train, none of val. Train-overfitted, exactly the failure
    // mode a held-out split exists to catch.
    const overfit = skill('reviewer', [1, 2])

    // Measure both splits directly first, so the claim is proven, not assumed.
    const scoreOn = async (cases: readonly EvalCase[], s: Skill): Promise<number> =>
      meanScore(
        await runEvalSet(cases, { adapter: h.adapter, events: h.events, skills: [s] }),
      )
    expect(await scoreOn(TRAIN, seed)).toBe(0.5)
    expect(await scoreOn(TRAIN, overfit)).toBe(1) // strictly BETTER on train
    expect(await scoreOn(VAL, seed)).toBe(0.5)
    expect(await scoreOn(VAL, overfit)).toBe(0) // strictly WORSE on val

    const result = await trainSkill({
      seed,
      train: TRAIN,
      val: VAL,
      epochs: 1,
      proposeEdit: scriptedProposeEdit([overfit]),
      events: h.events,
      adapter: h.adapter,
    })

    expect(result.epochs[0]!.trainScore).toBe(0.5) // the incumbent's train mean
    expect(result.epochs[0]!.candidateScore).toBe(0) // scored on val, not train
    expect(result.epochs[0]!.verdict).toBe('rejected')
    expect(result.skill).toBe(seed)
    expect(result.valScore).toBe(0.5)
  })
})

describe('multiple epochs', () => {
  it('does not let a rejected candidate poison a later accepted one, and bestVal only rises', async () => {
    const h = harness()
    const seed = skill('reviewer', [1, 2, 3]) // val 0.5
    const regression = skill('reviewer', []) // val 0.0 → rejected
    const improvement = skill('reviewer', [1, 2, 3, 4]) // val 1.0 → accepted
    const laterRegression = skill('reviewer', [4]) // val 0.5 → rejected

    const result = await trainSkill({
      seed,
      train: TRAIN,
      val: VAL,
      epochs: 3,
      proposeEdit: scriptedProposeEdit([regression, improvement, laterRegression]),
      events: h.events,
      adapter: h.adapter,
    })

    expect(result.epochs.map((e) => e.verdict)).toEqual(['rejected', 'accepted', 'rejected'])
    expect(result.epochs.map((e) => e.candidateScore)).toEqual([0, 1, 0.5])
    expect(result.skill).toBe(improvement)
    expect(result.valScore).toBe(1)
    expect(result.accepted).toBe(1)

    // Monotonic: the champion's score never decreases.
    const bests = result.epochs.map((e) => e.bestScore)
    expect(bests).toEqual([0.5, 1, 1])
    for (let i = 1; i < bests.length; i++) {
      expect(bests[i]!).toBeGreaterThanOrEqual(bests[i - 1]!)
    }
  })

  it('survives a proposeEdit that THROWS and keeps training', async () => {
    // A provider-backed optimizer (Phase 6.4) throws for ordinary reasons: rate
    // limits, timeouts, malformed completions. Losing the incumbent — or
    // discarding an earlier accepted candidate — because a remote call failed is
    // strictly worse than skipping the epoch. The gate is not weakened: no
    // candidate exists, so nothing is scored and nothing is accepted.
    const h = harness()
    const seed = skill('reviewer', [1, 2, 3])
    const improvement = skill('reviewer', [1, 2, 3, 4])

    let call = 0
    const flaky: ProposeEdit = async (incumbent: Skill, trainResults: readonly EvalResult[]) => {
      call++
      if (call === 1) throw new Error('optimizer upstream returned 429')
      expect(incumbent).toBe(seed) // the throw did not disturb the incumbent
      expect(trainResults).toHaveLength(TRAIN.length)
      return improvement
    }

    const result = await trainSkill({
      seed,
      train: TRAIN,
      val: VAL,
      epochs: 2,
      proposeEdit: flaky,
      events: h.events,
      adapter: h.adapter,
    })

    expect(result.epochs).toHaveLength(2)
    expect(result.epochs[0]!.verdict).toBe('error')
    expect(result.epochs[0]!.error).toContain('429')
    expect(result.epochs[0]!.candidateScore).toBeNull()
    expect(result.epochs[0]!.bestScore).toBe(0.5)
    expect(result.epochs[1]!.verdict).toBe('accepted')
    expect(result.skill).toBe(improvement)
    expect(result.valScore).toBe(1)
  })
})

describe('the train/validation split is deterministic (Requirement 9.2)', () => {
  const many = [1, 2, 3, 4, 5, 6, 7].map(topicCase)

  it('yields the same partition for the same seed, across calls', () => {
    const a = splitCases(many, { seed: 'seed-A' })
    const b = splitCases(many, { seed: 'seed-A' })
    expect(a.train.map((c) => c.id)).toEqual(b.train.map((c) => c.id))
    expect(a.val.map((c) => c.id)).toEqual(b.val.map((c) => c.id))
    // ...and the default seed is fixed too, not a clock or a random value.
    expect(splitCases(many).train.map((c) => c.id)).toEqual(
      splitCases(many).train.map((c) => c.id),
    )
  })

  it('does not overlap and together covers every case', () => {
    const { train, val } = splitCases(many, { seed: 'seed-B' })
    const trainIds = train.map((c) => c.id)
    const valIds = val.map((c) => c.id)

    expect(train.length).toBeGreaterThan(0)
    expect(val.length).toBeGreaterThan(0)
    expect(trainIds.filter((id) => valIds.includes(id))).toEqual([])
    expect([...trainIds, ...valIds].sort()).toEqual(many.map((c) => c.id).sort())
    // 70% of 7 rounds to 5 train / 2 val.
    expect(train).toHaveLength(5)
    expect(val).toHaveLength(2)
  })

  it('honours the ratio and never produces an empty side', () => {
    expect(splitCases(many, { ratio: 0.5 }).train).toHaveLength(4)
    // Extreme ratios still leave both sides usable.
    expect(splitCases(many, { ratio: 0 }).train).toHaveLength(1)
    expect(splitCases(many, { ratio: 1 }).val).toHaveLength(1)
  })

  it('is the same partition trainSkill uses, twice in a row', async () => {
    const h = harness()
    const seed = skill('reviewer', [1, 2, 3])
    const run = async () =>
      trainSkill({
        seed,
        cases: many,
        epochs: 0,
        proposeEdit: scriptedProposeEdit([]),
        events: h.events,
        adapter: h.adapter,
      })

    const first = await run()
    const second = await run()
    expect(first.split.train.map((c) => c.id)).toEqual(second.split.train.map((c) => c.id))
    expect(first.split.val.map((c) => c.id)).toEqual(second.split.val.map((c) => c.id))
    expect(first.baselineValScore).toBe(second.baselineValScore)
  })
})

describe('the per-epoch history is the audit trail', () => {
  it('records each candidate score, its verdict, and a reason', async () => {
    const h = harness()
    const seed = skill('reviewer', [1, 2, 3])

    const result = await trainSkill({
      seed,
      train: TRAIN,
      val: VAL,
      epochs: 3,
      proposeEdit: scriptedProposeEdit([
        skill('reviewer', []),
        null,
        skill('reviewer', [1, 2, 3, 4]),
      ]),
      events: h.events,
      adapter: h.adapter,
    })

    expect(result.epochs.map((e) => e.epoch)).toEqual([1, 2, 3])
    expect(result.epochs.map((e) => e.verdict)).toEqual(['rejected', 'no_proposal', 'accepted'])
    expect(result.epochs.map((e) => e.candidateScore)).toEqual([0, null, 1])
    expect(result.epochs.map((e) => e.incumbentScore)).toEqual([0.5, 0.5, 0.5])
    for (const epoch of result.epochs) {
      expect(epoch.reason).not.toBe('')
      expect(epoch.trainScore).toBeGreaterThanOrEqual(0)
    }
    expect(result.epochs[2]!.reason).toContain('strictly greater')
  })

  it('narrates training on the event log under skill_trained', async () => {
    const h = harness()
    await trainSkill({
      seed: skill('reviewer', [1, 2, 3]),
      train: TRAIN,
      val: VAL,
      epochs: 1,
      proposeEdit: scriptedProposeEdit([skill('reviewer', [1, 2, 3, 4])]),
      events: h.events,
      adapter: h.adapter,
    })

    const log = await h.events.readAll()
    // Found BY KIND. This used to be `think` + `component: 'skillopt'`, which
    // meant a training run could only be located by reading payloads — and shared
    // a kind with the model's own reasoning.
    const trainerEvents = log.filter((e) => e.kind === 'skill_trained')
    expect(trainerEvents).toHaveLength(3)
    expect(trainerEvents.every((e) => e.payload.component === undefined)).toBe(true)
    // `phase` stays a payload key: these three are steps within one fact, not
    // three different facts, so they do not each earn a kind.
    expect(trainerEvents.map((e) => e.payload.phase)).toEqual([
      'training_started',
      'epoch',
      'training_completed',
    ])
    // And the trainer no longer contributes to `think`, which is the model's.
    expect(log.some((e) => e.kind === 'think')).toBe(false)
    expect(new Set(log.map((e) => e.kind)).has('eval_scored')).toBe(true)
  })
})

describe('the deployed best_skill.md artifact (Requirement 9.1)', () => {
  it('round-trips through loadSkillFile back to an equivalent Skill', async () => {
    const h = harness()
    const root = await makeTmp()
    const artifactPath = join(root, '.sketch', 'skills', 'reviewer', BEST_SKILL_FILENAME)

    const winner: Skill = {
      ...skill('reviewer', [1, 2, 3, 4], 'Quote "carefully": colons: too.'),
      capabilities: ['read', 'write'],
    }

    const result = await trainSkill({
      seed: skill('reviewer', [1, 2, 3]),
      train: TRAIN,
      val: VAL,
      epochs: 1,
      proposeEdit: scriptedProposeEdit([winner]),
      events: h.events,
      adapter: h.adapter,
    })
    expect(result.skill).toBe(winner)

    const written = await trainSkill({
      seed: skill('reviewer', [1, 2, 3]),
      train: TRAIN,
      val: VAL,
      epochs: 1,
      proposeEdit: scriptedProposeEdit([winner]),
      events: h.events,
      adapter: h.adapter,
      artifactPath,
    })
    expect(written.artifactPath).toBe(artifactPath)

    const reloaded = await loadSkillFile(artifactPath)
    expect(reloaded.name).toBe(winner.name)
    expect(reloaded.description).toBe(winner.description)
    expect(reloaded.body).toBe(winner.body.trim())
    expect(reloaded.capabilities).toEqual(['read', 'write'])
    // `source` becomes the artifact's own path, which is the point of deploying it.
    expect(reloaded.source).toBe(artifactPath)

    // The reloaded skill still scores what the winner scored: the artifact is the
    // deployed form, not a lossy summary.
    const score = meanScore(
      await runEvalSet(VAL, { adapter: h.adapter, events: h.events, skills: [reloaded] }),
    )
    expect(score).toBe(written.valScore)
  })

  it('is usable purely in memory: no file is written without an artifactPath', async () => {
    const h = harness()
    const root = await makeTmp()
    const result = await trainSkill({
      seed: skill('reviewer', [1, 2, 3]),
      train: TRAIN,
      val: VAL,
      epochs: 0,
      proposeEdit: scriptedProposeEdit([]),
      events: h.events,
      adapter: h.adapter,
    })

    expect(result.artifactPath).toBeUndefined()
    expect(result.artifact).toContain('name: "reviewer"')
    expect(readdirSync(root)).toEqual([])
    expect(serializeSkill(result.skill)).toBe(result.artifact)
  })
})

describe('degenerate inputs keep the incumbent', () => {
  const improvement = skill('reviewer', [1, 2, 3, 4])

  it('handles zero cases', async () => {
    const h = harness()
    const seed = skill('reviewer', [1, 2, 3])
    const result = await trainSkill({
      seed,
      cases: [],
      epochs: 1,
      proposeEdit: scriptedProposeEdit([improvement]),
      events: h.events,
      adapter: h.adapter,
    })

    expect(result.split).toEqual({ train: [], val: [] })
    expect(result.baselineValScore).toBe(0) // meanScore([]) is 0, never NaN
    expect(result.epochs[0]!.verdict).toBe('rejected') // 0 > 0 is false
    expect(result.skill).toBe(seed)
    expect(result.valScore).toBe(0)
    expect(h.adapter.calls).toBe(0)
  })

  it('handles an empty validation split', async () => {
    const h = harness()
    const seed = skill('reviewer', [1, 2, 3])
    const result = await trainSkill({
      seed,
      train: TRAIN,
      val: [],
      epochs: 2,
      proposeEdit: scriptedProposeEdit([improvement, improvement]),
      events: h.events,
      adapter: h.adapter,
    })

    // Nothing held out means nothing can be proven, so nothing is accepted.
    expect(result.epochs.map((e) => e.verdict)).toEqual(['rejected', 'rejected'])
    expect(result.skill).toBe(seed)
    expect(result.accepted).toBe(0)
  })

  it('handles a single case: no held-out set exists, so the incumbent stands', async () => {
    const h = harness()
    const seed = skill('reviewer', [1, 2, 3])
    const result = await trainSkill({
      seed,
      cases: [topicCase(4)],
      epochs: 1,
      proposeEdit: scriptedProposeEdit([improvement]),
      events: h.events,
      adapter: h.adapter,
    })

    expect(result.split.train.map((c) => c.id)).toEqual(['c4'])
    expect(result.split.val).toEqual([])
    expect(result.skill).toBe(seed)
    expect(result.accepted).toBe(0)
  })

  it('handles epochs: 0 by measuring the baseline and stopping', async () => {
    const h = harness()
    const seed = skill('reviewer', [1, 2, 3])
    let proposals = 0
    const result = await trainSkill({
      seed,
      train: TRAIN,
      val: VAL,
      epochs: 0,
      proposeEdit: async () => {
        proposals++
        return improvement
      },
      events: h.events,
      adapter: h.adapter,
    })

    expect(proposals).toBe(0)
    expect(result.epochs).toEqual([])
    expect(result.baselineValScore).toBe(0.5)
    expect(result.valScore).toBe(0.5)
    expect(result.skill).toBe(seed)
    expect(h.adapter.calls).toBe(VAL.length) // baseline only
  })
})

describe('offline by construction (constraint C2)', () => {
  it('NETWORK TRIPWIRE: a full training run makes zero fetch calls', async () => {
    const calls: unknown[][] = []
    const original = globalThis.fetch
    globalThis.fetch = ((...args: unknown[]) => {
      calls.push(args)
      throw new Error('NETWORK TRIPWIRE: the trainer must never touch the network')
    }) as unknown as typeof fetch

    try {
      const h = harness()
      const result = await trainSkill({
        seed: skill('reviewer', [1, 2, 3]),
        cases: [1, 2, 3, 4, 5].map(topicCase),
        epochs: 3,
        proposeEdit: scriptedProposeEdit([
          skill('reviewer', []),
          skill('reviewer', [1, 2, 3, 4, 5]),
          null,
        ]),
        events: h.events,
        adapter: h.adapter,
      })
      expect(result.epochs).toHaveLength(3)
    } finally {
      globalThis.fetch = original
    }

    expect(calls).toEqual([])
  })
})

describe('off the hot path (Requirement 9.6)', () => {
  it('is not imported anywhere under src/loop', () => {
    // A trainer call inside `runTask` would multiply every user task by
    // `epochs × |cases|` model calls. This is a structural guard, not a comment.
    const loopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'loop')
    const offenders: string[] = []
    for (const entry of readdirSync(loopDir)) {
      const full = join(loopDir, entry)
      if (!statSync(full).isFile() || !entry.endsWith('.ts')) continue
      if (/trainer/.test(readFileSync(full, 'utf8'))) offenders.push(entry)
    }
    expect(offenders).toEqual([])
  })
})
