// Project memory types.
// Persists decisions, standards, past bugs, and test history per project.

export interface Decision {
  id: string
  summary: string
  rationale: string
  createdAt: number
}

export interface Standard {
  key: string
  value: string
  updatedAt: number
}

export interface BugRecord {
  id: string
  description: string
  fix: string
  files: string[]
  createdAt: number
}

export interface TestRecord {
  id: string
  checkName: string
  passed: boolean
  output: string
  createdAt: number
}

export interface ConversationRecord {
  id: string
  task: string
  messages: string   // JSON-serialised
  createdAt: number
}

export interface ProjectMemory {
  addDecision(d: Omit<Decision, 'createdAt'>): Promise<void>
  listDecisions(): Promise<Decision[]>

  setStandard(key: string, value: string): Promise<void>
  getStandard(key: string): Promise<string | null>
  listStandards(): Promise<Standard[]>

  addBug(b: Omit<BugRecord, 'createdAt'>): Promise<void>
  listBugs(): Promise<BugRecord[]>
  findBugsByFile(file: string): Promise<BugRecord[]>

  addTestRecord(t: Omit<TestRecord, 'createdAt'>): Promise<void>
  listTestRecords(limit?: number): Promise<TestRecord[]>

  addConversation(c: Omit<ConversationRecord, 'createdAt'>): Promise<void>
  listConversations(limit?: number): Promise<ConversationRecord[]>

  // A compact digest loaded into context at session start.
  digest(): Promise<string>
}
