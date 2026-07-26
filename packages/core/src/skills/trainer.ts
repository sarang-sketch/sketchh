// The SkillOpt trainer and its strict held-out validation gate.
//
// OFF THE HOT PATH (Requirement 9.6). Nothing in this file is reachable from
// `runTask`. It runs ON DEMAND, ON SAVE, or NIGHTLY — never inside a
// user-facing task run. `src/loop/` does not import it and must not: a trainer
// call in the loop would multiply every user task by `epochs × |cases|` model
// calls. `test/trainer.test.ts` enforces that structurally.
//
// WHAT IS TRAINED. A skill's markdown BODY is the trainable state
// (Requirement 9.1). No weights change, nothing is fine-tuned, no model is
// downloaded. The optimizer proposes a new body; the gate decides whether it
// survives. The deployed artifact is a compact `best_skill.md` in exactly the
// `SKILL.md` shape the existing loader reads back, so deployment is a file copy.
//
// THE GATE, reproduced from design.md and implemented below verbatim in shape:
//
//   let best = seed
//   let bestVal = meanScore(await runEvalSet(val, depsFor(best)))
//   for (let e = 1; e <= epochs; e++) {
//     const trainRes = await runEvalSet(train, depsFor(best))
//     const cand = await proposeEdit(best, trainRes)          // injected seam
//     if (!cand) continue
//     const candVal = meanScore(await runEvalSet(val, depsFor(cand)))
//     if (candVal > bestVal) { best = cand; bestVal = candVal }   // STRICT
//   }
//
// THE ANTI-ROT PROPERTY (Requirements 9.3, 9.4). Acceptance is `candVal >
// bestVal` and nothing else. A TIE KEEPS THE INCUMBENT. That single character
// is the whole anti-rot mechanism: eval scores are noisy, and a `>=` gate would
// let a random walk of equal-scoring candidates ratchet a skill into decay one
// harmless-looking step at a time, each step "not a regression". There is
// deliberately NO force-accept, NO tolerance epsilon, and NO `>=` mode. The
// optimizer is swappable; the gate is ours and never moves.
//
// FOUR CONSEQUENCES OF STANDING ON THE EVAL HARNESS, each load-bearing:
//   * `meanScore([])` is 0, never NaN. So an EMPTY VALIDATION SPLIT can never
//     accept a candidate (`0 > 0` is false) and the incumbent is retained. That
//     is the safe direction for a degenerate input, and it is why the fewer-than-
//     two-cases rule below is allowed to produce an empty val split.
//   * A case that throws scores 0 and the set continues, so one broken case
//     lowers a candidate's mean rather than killing the run.
//   * A zero-check case scores 0 without running the task, so a truncated
//     evals.jsonl line cannot hand every candidate a free point.
//   * When `depsFor` omits `root`, the harness mkdtemps a fresh isolated
//     workspace per case and removes it. That is what we want for training: a
//     candidate must not be scored on bytes a previous candidate wrote.
//
// EVENTS. There is no `skill_trained` kind in the `EventKind` contract and this
// file does not invent one — changing types.ts requires a spec update first.
// Training narration is therefore recorded as `think` carrying a
// `component: 'skillopt'` discriminator, the same way the loop records an `ask`
// as a `think`. The per-case `eval_scored` events come from the harness and are
// not duplicated here. SPEC GAP, recorded rather than patched: a dedicated
// `skill_trained` kind would make training runs greppable without a payload
// discriminator.
//
// Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.8

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { meanScore, runEvalSet } from '../evals/index.js'
import type { EvalDeps } from '../evals/index.js'
import { newRunId } from '../events/index.js'
import type { EventStore } from '../events/index.js'
import type { ChatAdapter, EvalCase, EvalResult, Skill } from '../types.js'

/** Filename of the deployed artifact (Requirement 9.1). */
export const BEST_SKILL_FILENAME = 'best_skill.md'

/** Fraction of cases used for training when the caller does not say. */
export const DEFAULT_SPLIT_RATIO = 0.7

/**
 * Default split seed. A FIXED string, not a clock or a random value: a gate
 * whose partition reshuffles per call is not reproducible, and two runs of the
 * same trainer over the same cases must compare like with like.
 */
export const DEFAULT_SPLIT_SEED = 'sketch-skillopt-v1'

/**
 * Default epoch count: 1. Conservative on purpose — each epoch costs
 * `|train| + |val|` model calls, and once `proposeEdit` is provider-backed
 * (Phase 6.4) those are billed. Callers that want a longer search say so.
 */
export const DEFAULT_EPOCHS = 1

/**
 * The optimizer seam (Requirement 9.5).
 *
 * Receives the incumbent skill and its scores on the TRAIN split — never the
 * validation split, because an optimizer that can see the held-out set can
 * overfit to it and the gate stops meaning anything.
 *
 * Returning `null` means "no proposal this epoch": the epoch is recorded and the
 * incumbent is untouched. Offline this is a deterministic stub
 * ({@link scriptedProposeEdit}); in real training it is a provider call or the
 * SkillOpt optimizer.
 */
export type ProposeEdit = (
  skill: Skill,
  trainResults: readonly EvalResult[],
) => Promise<Skill | null>

/** How one epoch ended. */
export type EpochVerdict =
  /** Candidate beat the incumbent on validation, strictly. */
  | 'accepted'
  /** Candidate scored equal or worse on validation. The incumbent was kept. */
  | 'rejected'
  /** `proposeEdit` returned null. Nothing was scored. */
  | 'no_proposal'
  /** `proposeEdit` threw. Nothing was scored, the incumbent survived. */
  | 'error'

/** One epoch of the audit trail. Phase 6 and Phase 11 both read this. */
export interface TrainEpoch {
  /** 1-based, matching the design's loop. */
  epoch: number
  verdict: EpochVerdict
  /** Incumbent's mean on the train split this epoch (the optimizer's input). */
  trainScore: number
  /** Incumbent's validation mean entering the epoch. */
  incumbentScore: number
  /** Candidate's validation mean, or `null` when no candidate was scored. */
  candidateScore: number | null
  /** Validation mean after the verdict was applied. */
  bestScore: number
  /** Why the verdict came out that way, in words. */
  reason: string
  /** Name of the proposed candidate, when there was one. */
  candidateName?: string
  /** Message from a throwing `proposeEdit`. */
  error?: string
}

/** A deterministic train/validation partition. */
export interface CaseSplit {
  train: EvalCase[]
  val: EvalCase[]
}

/** The outcome of a training run: the winner plus everything needed to audit it. */
export interface TrainResult {
  /** The winning skill. The seed itself when nothing beat it. */
  skill: Skill
  /** Winning validation mean. */
  valScore: number
  /** The seed's validation mean, measured before any candidate existed. */
  baselineValScore: number
  /** The seed, for comparison. */
  seed: Skill
  /** True only when a candidate was accepted, i.e. `valScore > baselineValScore`. */
  improved: boolean
  /** How many candidates passed the gate. */
  accepted: number
  /** Per-epoch history, in order. */
  epochs: TrainEpoch[]
  /** The partition acceptance was decided on. */
  split: CaseSplit
  /** The `best_skill.md` bytes for the winner, whether or not they were written. */
  artifact: string
  /** Where the artifact was written, when it was. */
  artifactPath?: string
}

export interface TrainSkillOptions {
  /** The starting skill. Its body is the trainable state. */
  seed: Skill

  /** All cases, to be split deterministically. Ignored when `train`/`val` are given. */
  cases?: readonly EvalCase[]
  /** Explicit train split. Supplying either `train` or `val` skips splitting. */
  train?: readonly EvalCase[]
  /** Explicit held-out split. */
  val?: readonly EvalCase[]
  /** Train fraction. Defaults to {@link DEFAULT_SPLIT_RATIO}. */
  splitRatio?: number
  /** Split seed. Defaults to {@link DEFAULT_SPLIT_SEED}. */
  splitSeed?: string

  /** Epochs to run. Defaults to {@link DEFAULT_EPOCHS}. 0 is legal: baseline only. */
  epochs?: number

  /** The optimizer seam. */
  proposeEdit: ProposeEdit

  /** The log. Also handed to the eval harness by the default `depsFor`. */
  events: EventStore

  /**
   * Build the harness deps for one candidate. Defaults to
   * `(skill) => ({ adapter, events, skills: [skill], maxIterations })`, which is
   * why `EvalDeps` makes `root`/`plan`/`files` optional: only `skills` varies
   * between candidates.
   */
  depsFor?: (skill: Skill) => EvalDeps
  /** Required unless `depsFor` is supplied. */
  adapter?: ChatAdapter
  /** Passed through to the default `depsFor`. */
  maxIterations?: number

  /** Write `best_skill.md` here. Omit to train purely in memory. */
  artifactPath?: string
  /** Artifact write seam. Defaults to `mkdir -p` + `writeFile`. */
  writeArtifact?: (path: string, contents: string) => Promise<void>

  /** Run id for the trainer's own events. Defaults to a fresh one. */
  runId?: string
}

/** FNV-1a, 32-bit. Enough to derive a stable shuffle key; not a hash for security. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * Split cases into train and validation, DETERMINISTICALLY.
 *
 * Order is a seeded hash of `seed:caseId:index`, so the same seed and the same
 * cases always yield the same partition — a gate whose split moves between runs
 * cannot be compared against itself. `index` is in the key so duplicate case ids
 * still order stably.
 *
 * FEWER THAN TWO CASES HAS NO HELD-OUT SET. One case cannot be both trained on
 * and held out, so everything goes to `train` and `val` is empty. Combined with
 * `meanScore([]) === 0` and strict `>`, that means no candidate can be accepted:
 * the incumbent is retained. Refusing to train is the right answer to "train me
 * on one example", and it fails toward keeping what already works.
 */
export function splitCases(
  cases: readonly EvalCase[],
  options: { ratio?: number; seed?: string } = {},
): CaseSplit {
  const seed = options.seed ?? DEFAULT_SPLIT_SEED
  const ratio = Math.min(1, Math.max(0, options.ratio ?? DEFAULT_SPLIT_RATIO))

  if (cases.length === 0) return { train: [], val: [] }
  if (cases.length < 2) return { train: [...cases], val: [] }

  const ordered = cases
    .map((evalCase, index) => ({ evalCase, key: fnv1a(`${seed}:${evalCase.id}:${index}`), index }))
    .sort((a, b) => (a.key === b.key ? a.index - b.index : a.key - b.key))
    .map((entry) => entry.evalCase)

  // Both splits stay non-empty: a split with an empty side is not a split.
  const trainCount = Math.min(
    ordered.length - 1,
    Math.max(1, Math.round(ordered.length * ratio)),
  )
  return { train: ordered.slice(0, trainCount), val: ordered.slice(trainCount) }
}

/** Quote a scalar for the frontmatter subset the loader parses. */
function quoteScalar(text: string): string {
  // JSON string escaping is a subset of what ./frontmatter.ts reads back for a
  // double-quoted value (`\\`, `\"`, `\n`, `\t`).
  return JSON.stringify(text)
}

/**
 * Serialize a skill back to `SKILL.md` shape: frontmatter plus body.
 *
 * The deployed artifact must be readable by the loader that reads hand-written
 * skills — one format, no special case — so this is the exact inverse of
 * `loadSkillFile` for `name`, `description`, `capabilities`, and `body`.
 * `source` is deliberately not serialized: it is where a skill came FROM, and
 * for the artifact that becomes the artifact's own path on load.
 */
export function serializeSkill(skill: Skill): string {
  const lines = ['---', `name: ${quoteScalar(skill.name)}`]
  lines.push(`description: ${quoteScalar(skill.description)}`)
  if (skill.capabilities && skill.capabilities.length > 0) {
    lines.push(`capabilities: [${skill.capabilities.map(quoteScalar).join(', ')}]`)
  }
  lines.push('---', '', skill.body.trim(), '')
  return lines.join('\n')
}

/**
 * A deterministic offline `proposeEdit` (Requirement 9.5): hands back the given
 * proposals in order, one per epoch, then `null` forever.
 *
 * This is the whole offline optimizer. It has no network, no key, no clock and
 * no randomness, which is what lets the gate's behaviour be pinned exactly: a
 * proposal that improves, one that regresses, one that TIES, and a `null`.
 */
export function scriptedProposeEdit(proposals: readonly (Skill | null)[]): ProposeEdit {
  let next = 0
  return async (_skill: Skill, _trainResults: readonly EvalResult[]): Promise<Skill | null> => {
    const proposal = next < proposals.length ? proposals[next]! : null
    next++
    return proposal
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function defaultWriteArtifact(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, 'utf8')
}

/**
 * Train one skill against captured eval cases, accepting a candidate ONLY on a
 * strictly greater held-out validation mean.
 *
 * Always resolves: a throwing optimizer is recorded as a failed epoch and
 * training continues (see the `catch` below). Runs entirely on whatever
 * `ChatAdapter` is injected — on `FakeChatAdapter` it is offline and free.
 */
export async function trainSkill(options: TrainSkillOptions): Promise<TrainResult> {
  const events = options.events
  const runId = options.runId ?? newRunId(Date.now())
  const epochs = Math.max(0, Math.floor(options.epochs ?? DEFAULT_EPOCHS))

  const split: CaseSplit =
    options.train !== undefined || options.val !== undefined
      ? { train: [...(options.train ?? [])], val: [...(options.val ?? [])] }
      : splitCases(options.cases ?? [], {
          ratio: options.splitRatio,
          seed: options.splitSeed,
        })

  const depsFor =
    options.depsFor ??
    ((skill: Skill): EvalDeps => {
      const adapter = options.adapter
      if (adapter === undefined) {
        throw new Error(
          'trainSkill requires either `depsFor` or `adapter`: the trainer scores ' +
            'candidates through the eval harness and cannot invent a model',
        )
      }
      const deps: EvalDeps = { adapter, events, skills: [skill] }
      if (options.maxIterations !== undefined) deps.maxIterations = options.maxIterations
      return deps
    })

  const emit = async (payload: Record<string, unknown>): Promise<void> => {
    // No `skill_trained` kind exists in the contract; `think` + a discriminator,
    // as the loop does for `ask`. See the header note.
    await events.emit({ runId, kind: 'think', payload: { component: 'skillopt', ...payload } })
  }

  let best = options.seed
  let bestVal = meanScore(await runEvalSet(split.val, depsFor(best)))
  const baselineValScore = bestVal

  await emit({
    phase: 'training_started',
    skill: options.seed.name,
    epochs,
    trainCases: split.train.length,
    valCases: split.val.length,
    baselineValScore,
  })

  const history: TrainEpoch[] = []
  let accepted = 0

  for (let epoch = 1; epoch <= epochs; epoch++) {
    const trainResults = await runEvalSet(split.train, depsFor(best))
    const trainScore = meanScore(trainResults)

    let candidate: Skill | null
    try {
      candidate = await options.proposeEdit(best, trainResults)
    } catch (err) {
      // A THROWING OPTIMIZER MUST NOT ABORT TRAINING. Once `proposeEdit` is
      // provider-backed (Phase 6.4) a throw is an ordinary event: a rate limit,
      // a timeout, a malformed completion. Losing the incumbent — or worse,
      // discarding candidates already accepted in earlier epochs — because a
      // remote call failed would be a strictly worse outcome than skipping the
      // epoch. It cannot weaken the gate: no candidate exists, so nothing is
      // scored and nothing is accepted.
      const error = messageOf(err)
      const record: TrainEpoch = {
        epoch,
        verdict: 'error',
        trainScore,
        incumbentScore: bestVal,
        candidateScore: null,
        bestScore: bestVal,
        reason: `proposeEdit threw, so this epoch produced no candidate: ${error}`,
        error,
      }
      history.push(record)
      await emit({ phase: 'epoch', ...record })
      continue
    }

    if (!candidate) {
      const record: TrainEpoch = {
        epoch,
        verdict: 'no_proposal',
        trainScore,
        incumbentScore: bestVal,
        candidateScore: null,
        bestScore: bestVal,
        reason: 'proposeEdit returned no candidate, so the incumbent is unchanged',
      }
      history.push(record)
      await emit({ phase: 'epoch', ...record })
      continue
    }

    // Scored on the HELD-OUT split only (Requirement 9.2). The train scores above
    // are the optimizer's input; they never decide acceptance.
    const candVal = meanScore(await runEvalSet(split.val, depsFor(candidate)))

    // THE GATE. Strict `>`. A tie keeps the incumbent (Requirements 9.3, 9.4).
    const incumbentScore = bestVal
    const accept = candVal > bestVal
    if (accept) {
      best = candidate
      bestVal = candVal
      accepted++
    }

    const record: TrainEpoch = {
      epoch,
      verdict: accept ? 'accepted' : 'rejected',
      trainScore,
      incumbentScore,
      candidateScore: candVal,
      bestScore: bestVal,
      reason: accept
        ? `accepted: validation mean ${candVal} is strictly greater than the ` +
          `incumbent's ${incumbentScore}`
        : `rejected: validation mean ${candVal} is not strictly greater than the ` +
          `incumbent's ${incumbentScore} (ties keep the incumbent)`,
      candidateName: candidate.name,
    }
    history.push(record)
    await emit({ phase: 'epoch', ...record })
  }

  const artifact = serializeSkill(best)
  let artifactPath: string | undefined
  if (options.artifactPath !== undefined) {
    const write = options.writeArtifact ?? defaultWriteArtifact
    await write(options.artifactPath, artifact)
    artifactPath = options.artifactPath
  }

  await emit({
    phase: 'training_completed',
    skill: best.name,
    baselineValScore,
    valScore: bestVal,
    accepted,
    epochsRun: history.length,
    improved: bestVal > baselineValScore,
    artifactPath: artifactPath ?? null,
  })

  const result: TrainResult = {
    skill: best,
    valScore: bestVal,
    baselineValScore,
    seed: options.seed,
    improved: bestVal > baselineValScore,
    accepted,
    epochs: history,
    split,
    artifact,
  }
  if (artifactPath !== undefined) result.artifactPath = artifactPath
  return result
}
