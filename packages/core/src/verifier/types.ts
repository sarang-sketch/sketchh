// Types for the verify loop

export type CheckName = 'lint' | 'typecheck' | 'test' | 'build'

export interface CheckResult {
  name: CheckName
  passed: boolean
  output: string
  durationMs: number
  skipped: boolean   // true when the project has no such check configured
}

// Aggregate outcome of a full verifier pass over a project.
// Named VerifySummary because the canonical per-command result type in
// src/types.ts owns the name `VerifyResult`.
export interface VerifySummary {
  passed: boolean
  checks: CheckResult[]
}

export interface DetectedProject {
  root: string
  language: 'node' | 'python' | 'rust' | 'go' | 'unknown'
  checks: CheckConfig[]
}

export interface CheckConfig {
  name: CheckName
  command: string
  args: string[]
}

// Abstracts command execution so the verifier is unit-testable without a shell.
export interface CommandRunner {
  run(command: string, args: string[], cwd: string): Promise<CommandOutput>
}

export interface CommandOutput {
  exitCode: number
  stdout: string
  stderr: string
}
