import type { AgentMode } from '../state/AppState'

export type WorkflowCategory = 'Build' | 'Review' | 'Research' | 'Writing' | 'Organize'
export interface Workflow {
  id: string
  title: string
  description: string
  category: WorkflowCategory
  prompt: string
  mode: AgentMode
  personal?: boolean
}

/** Starters are instructions, never fabricated runs or claims of installed capabilities. */
export const WORKFLOWS: readonly Workflow[] = [
  { id: 'feature', title: 'Build a feature', description: 'Go from an idea to a tested implementation.', category: 'Build', mode: 'agent', prompt: 'Help me build a new feature in this project. First read the project and explain the relevant architecture. Work out a small implementation plan, implement it using the existing conventions, and run the appropriate checks. Explain what changed and anything that still needs attention.\n\nThe feature I want: ' },
  { id: 'bug', title: 'Find & fix a bug', description: 'Trace the cause. Fix it. Verify it stays fixed.', category: 'Build', mode: 'agent', prompt: 'Find likely bugs in this project and fix the most serious one. Read the relevant code, identify the root cause, make a focused fix, and run the existing checks. Add a regression test when it meaningfully proves the fix. Report what you verified.' },
  { id: 'review', title: 'Review my changes', description: 'A second pair of eyes before you ship.', category: 'Review', mode: 'ask', prompt: 'Review the current uncommitted changes using git status and git diff. Read the surrounding code for context. Identify actionable bugs, security issues, regressions, and missing tests. Put findings in order of severity with file and line references. Do not edit files. If you find no issues, say so and explain the limits of the review.' },
  { id: 'explore', title: 'Explore this project', description: 'Find your way through an unfamiliar codebase.', category: 'Research', mode: 'ask', prompt: 'Explain how this project is structured and where the main entry points are. Read the code first. Describe what the project does, the major modules, how they connect, how to run and test it, and the best places to start making a change. Cite actual file paths. Do not edit files.' },
  { id: 'tests', title: 'Cover the important paths', description: 'Add useful tests where they matter most.', category: 'Build', mode: 'agent', prompt: 'Add unit tests for the most important module that has none. Inspect the current test framework and coverage first. Focus on meaningful behavior, edge cases, and failure handling. Run the relevant suite and report the actual results.' },
  { id: 'spec', title: 'Plan a feature', description: 'Clarify requirements before writing code.', category: 'Research', mode: 'ask', prompt: 'Help me plan a feature for this project. Read the relevant source, identify the constraints, and produce requirements, a design, a small implementation checklist, and a verification plan. Name the files likely to change and unresolved questions. Do not implement anything yet.\n\nThe feature: ' },
  { id: 'docs', title: 'Write project docs', description: 'Turn the code into a clear getting-started guide.', category: 'Writing', mode: 'agent', prompt: 'Write a clear README section explaining how to run this project. Verify the install, development, build, and test commands from the actual configuration. Explain prerequisites and project structure. Follow the existing documentation style and do not invent commands or features.' },
  { id: 'refactor', title: 'Simplify a module', description: 'Make code easier to change, one step at a time.', category: 'Build', mode: 'agent', prompt: 'Find a module in this project that would benefit from a small refactor. Explain why, preserve its behavior and public interface, and simplify it without unrelated changes. Run the existing tests and appropriate checks. Summarize the improvement and remaining risks.' },
  { id: 'release', title: 'Prepare release notes', description: 'Summarize what changed for the people using it.', category: 'Writing', mode: 'ask', prompt: 'Read the recent Git history and relevant changes, then draft clear release notes. Group user-visible additions, fixes, and breaking changes. Use only changes supported by the history. Flag anything uncertain. Do not publish, tag a release, or modify files.' },
  { id: 'organize', title: 'Organize project files', description: 'Make a tidy plan for a busy workspace.', category: 'Organize', mode: 'ask', prompt: 'Inspect this workspace and suggest a clearer organization for its files and documentation. Identify duplicates and confusing locations, explain any import or link impact, and give me a proposed move list. Do not move or delete anything yet.' },
]

export const WORKFLOWS_STORAGE_KEY = 'sketch.workflows.v1'
export const MAX_PERSONAL_WORKFLOWS = 48

export function normalizeWorkflows(input: unknown): Workflow[] {
  if (!Array.isArray(input)) return []
  const result: Workflow[] = []
  const ids = new Set<string>()
  for (const entry of input) {
    if (result.length >= MAX_PERSONAL_WORKFLOWS) break
    if (!entry || typeof entry !== 'object') continue
    const s = entry as Record<string, unknown>
    if (typeof s.id !== 'string' || !/^personal-[a-z0-9_-]{1,91}$/i.test(s.id) || ids.has(s.id) || typeof s.title !== 'string' || !s.title.trim() || typeof s.prompt !== 'string' || !s.prompt.trim()) continue
    ids.add(s.id)
    result.push({ id: s.id, title: s.title.trim().slice(0, 80), prompt: s.prompt.slice(0, 20_000), description: typeof s.description === 'string' ? s.description.slice(0, 180) : '', category: ['Build', 'Review', 'Research', 'Writing', 'Organize'].includes(s.category as string) ? s.category as WorkflowCategory : 'Build', mode: ['ask', 'agent', 'auto'].includes(s.mode as string) ? s.mode as AgentMode : 'ask', personal: true })
  }
  return result
}
