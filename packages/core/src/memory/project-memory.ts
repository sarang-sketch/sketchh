// In-memory ProjectMemory implementation.
// Backs the full interface with plain maps/arrays; a SQLite-backed version can
// implement the same interface for persistence (see trd.md schema).
// A clock is injected so tests are deterministic.

import type {
  ProjectMemory,
  Decision,
  Standard,
  BugRecord,
  TestRecord,
  ConversationRecord,
} from './types.js'

export type Clock = () => number

export class MemoryProjectMemory implements ProjectMemory {
  private decisions: Decision[] = []
  private standards = new Map<string, Standard>()
  private bugs: BugRecord[] = []
  private tests: TestRecord[] = []
  private conversations: ConversationRecord[] = []

  constructor(private clock: Clock = () => Date.now()) {}

  async addDecision(d: Omit<Decision, 'createdAt'>): Promise<void> {
    this.decisions.push({ ...d, createdAt: this.clock() })
  }

  async listDecisions(): Promise<Decision[]> {
    return [...this.decisions]
  }

  async setStandard(key: string, value: string): Promise<void> {
    this.standards.set(key, { key, value, updatedAt: this.clock() })
  }

  async getStandard(key: string): Promise<string | null> {
    return this.standards.get(key)?.value ?? null
  }

  async listStandards(): Promise<Standard[]> {
    return [...this.standards.values()]
  }

  async addBug(b: Omit<BugRecord, 'createdAt'>): Promise<void> {
    this.bugs.push({ ...b, createdAt: this.clock() })
  }

  async listBugs(): Promise<BugRecord[]> {
    return [...this.bugs]
  }

  async findBugsByFile(file: string): Promise<BugRecord[]> {
    return this.bugs.filter(b => b.files.includes(file))
  }

  async addTestRecord(t: Omit<TestRecord, 'createdAt'>): Promise<void> {
    this.tests.push({ ...t, createdAt: this.clock() })
  }

  async listTestRecords(limit?: number): Promise<TestRecord[]> {
    const all = [...this.tests].reverse() // most recent first
    return limit ? all.slice(0, limit) : all
  }

  async addConversation(c: Omit<ConversationRecord, 'createdAt'>): Promise<void> {
    this.conversations.push({ ...c, createdAt: this.clock() })
  }

  async listConversations(limit?: number): Promise<ConversationRecord[]> {
    const all = [...this.conversations].reverse()
    return limit ? all.slice(0, limit) : all
  }

  async digest(): Promise<string> {
    const lines: string[] = []

    if (this.standards.size > 0) {
      lines.push('## Coding standards')
      for (const s of this.standards.values()) {
        lines.push(`- ${s.key}: ${s.value}`)
      }
    }

    if (this.decisions.length > 0) {
      lines.push('## Key decisions')
      for (const d of this.decisions.slice(-10)) {
        lines.push(`- ${d.summary}${d.rationale ? ` (${d.rationale})` : ''}`)
      }
    }

    if (this.bugs.length > 0) {
      lines.push('## Past bugs to avoid repeating')
      for (const b of this.bugs.slice(-10)) {
        lines.push(`- ${b.description} → fixed by: ${b.fix}`)
      }
    }

    return lines.join('\n')
  }
}
