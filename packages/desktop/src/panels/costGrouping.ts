// Cost grouping — pure rollups over the CostEntry rows CostDashboard already
// reads from the engine (lib/client.ts). Unknown cost is never rendered as $0:
// a model whose calls are all unpriced has totalCost null.

import type { CostEntry } from '../lib/client'

export interface ModelCostGroup {
  model: string
  calls: number
  /** USD over priced calls, or null when no call in the group could be priced. */
  totalCost: number | null
  unknownCostCalls: number
}

export interface ModelDayCostGroup extends ModelCostGroup {
  /** UTC calendar day of the call, YYYY-MM-DD, from the entry's epoch-ms ts. */
  day: string
}

function modelName(entry: CostEntry): string {
  return entry.model ?? 'model not recorded'
}

function compareGroups(a: ModelCostGroup, b: ModelCostGroup): number {
  if (a.totalCost === null && b.totalCost === null) return b.calls - a.calls || a.model.localeCompare(b.model)
  if (a.totalCost === null) return 1
  if (b.totalCost === null) return -1
  return b.totalCost - a.totalCost || b.calls - a.calls || a.model.localeCompare(b.model)
}

function accumulate(groups: Map<string, ModelCostGroup>, key: string, entry: CostEntry): void {
  let group = groups.get(key)
  if (group === undefined) {
    group = { model: key, calls: 0, totalCost: null, unknownCostCalls: 0 }
    groups.set(key, group)
  }
  group.calls += 1
  if (entry.usd === null) {
    group.unknownCostCalls += 1
  } else {
    group.totalCost = (group.totalCost ?? 0) + entry.usd
  }
}

/**
 * Group entries by model, sorted by total cost descending; models whose cost
 * is entirely unknown sort last with totalCost null.
 */
export function groupByModel(entries: CostEntry[]): ModelCostGroup[] {
  const groups = new Map<string, ModelCostGroup>()
  for (const entry of entries) accumulate(groups, modelName(entry), entry)
  return [...groups.values()].sort(compareGroups)
}

/**
 * Group entries by model and UTC calendar day (from `ts`, epoch ms).
 * Sorted by day descending, then by total cost descending within the day.
 */
export function groupByModelAndDay(entries: CostEntry[]): ModelDayCostGroup[] {
  const groups = new Map<string, ModelDayCostGroup>()
  for (const entry of entries) {
    const day = new Date(entry.ts).toISOString().slice(0, 10)
    const key = `${day}\0${modelName(entry)}`
    let group = groups.get(key)
    if (group === undefined) {
      group = { model: modelName(entry), day, calls: 0, totalCost: null, unknownCostCalls: 0 }
      groups.set(key, group)
    }
    group.calls += 1
    if (entry.usd === null) {
      group.unknownCostCalls += 1
    } else {
      group.totalCost = (group.totalCost ?? 0) + entry.usd
    }
  }
  return [...groups.values()].sort(
    (a, b) => b.day.localeCompare(a.day) || compareGroups(a, b),
  )
}
