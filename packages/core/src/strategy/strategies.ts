// The three strategies and the ladder between them.
//
// Its own file because both the dispatcher and the merge step need the vocabulary, and a
// union defined in one of them and imported by the other is a cycle waiting to happen.
//
// ── SINGLE IS THE DEFAULT, AND THAT IS A PRODUCT DECISION ───────────────────
//
// Requirement 24.1. This is the phase where most products lie: they ship a swarm because
// thirteen agents demo well, and the user pays thirteen times for a result one agent
// produced. So `single` is the default, the heavier strategies are opt-in, and Requirement
// 24.8 says `swarm` may only BECOME a default for a task class after measured pass@k lift
// over `single` on the internal suite. `passk.ts` is that measurement, and
// `shouldDefaultToSwarm` returns false when there is no data — which is the state this
// repository is in and says so.
//
// Validates: Requirements 24.1, 24.2, 24.3

/** The three, cheapest first. Order is the escalation order. */
export const STRATEGIES = ['single', 'plan-then-code', 'swarm'] as const

export type Strategy = (typeof STRATEGIES)[number]

export function isStrategy(value: unknown): value is Strategy {
  return typeof value === 'string' && (STRATEGIES as readonly string[]).includes(value)
}

/**
 * What a run gets when nobody chose (Requirement 24.1).
 *
 * Not a constant to be tuned later: changing it is a spec change, because it changes what
 * every existing caller pays.
 */
export const DEFAULT_STRATEGY: Strategy = 'single'

/**
 * The escalation order. Lighter to heavier, and escalation only ever moves right.
 *
 * `STRATEGIES` is already in this order; the alias exists so a reader of the dispatcher
 * sees the intent rather than inferring it from a declaration order they have to trust.
 */
export const ESCALATION_LADDER: readonly Strategy[] = STRATEGIES

/** How many strategies remain above this one. 0 for `swarm`. */
export function heavierThan(strategy: Strategy): readonly Strategy[] {
  return ESCALATION_LADDER.slice(ESCALATION_LADDER.indexOf(strategy) + 1)
}

/** One line per strategy, for a panel. Plain about what it costs. */
export const STRATEGY_DESCRIPTIONS: Readonly<Record<Strategy, string>> = Object.freeze({
  single: 'One agent, one run. The default, and what every measurement is compared against.',
  'plan-then-code':
    'A Planner sub-run writes the plan, then one implementation run works from it. Two runs, ' +
    'so roughly twice the cost of single.',
  swarm:
    'Every verifiable role runs as its own sub-run and their edits are merged deterministically. ' +
    'As many runs as there are verifiable roles, so as many bills. Off by default until measured ' +
    'pass@k lift says otherwise.',
})
