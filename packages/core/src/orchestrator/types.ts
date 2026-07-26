// Orchestrator types — the state machine that drives a task from request to done.

export type TaskStatus =
  | 'idle'
  | 'planning'
  | 'awaiting_approval'
  | 'executing'
  | 'verifying'
  | 'fixing'
  | 'done'
  | 'needs_human'
  | 'cancelled'
  | 'error'

export interface PlanStep {
  id: string
  description: string
  files: string[]
  dependsOn: string[]
}

export interface Plan {
  taskId: string
  summary: string
  steps: PlanStep[]
  estimatedFiles: string[]
}

export interface FileEdit {
  path: string
  // Full new content of the file. The orchestrator diffs against disk before applying.
  content: string
}

export interface StepResult {
  stepId: string
  edits: FileEdit[]
  notes: string
}

// Events emitted as the task progresses. The desktop UI subscribes to these.
export type OrchestratorEvent =
  | { type: 'status'; taskId: string; status: TaskStatus; message?: string }
  | { type: 'plan'; taskId: string; plan: Plan }
  | { type: 'step_start'; taskId: string; step: PlanStep }
  | { type: 'file_edit'; taskId: string; path: string }
  | { type: 'verify'; taskId: string; passed: boolean; summary: string }
  | { type: 'done'; taskId: string; summary: string }
  | { type: 'error'; taskId: string; message: string }
