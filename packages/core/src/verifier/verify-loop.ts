// VerifyLoop — the core differentiator.
// Runs checks; on failure, asks a Fixer to propose a fix, applies it, and re-verifies.
// Repeats until all checks pass or maxAttempts is reached.

import { Verifier, type VerifyOptions } from './verifier.js'
import { detectProject } from './detector.js'
import type { VerifySummary, CheckResult, DetectedProject } from './types.js'

// A Fixer diagnoses failing checks and applies changes to disk.
// The orchestrator supplies a real, model-backed implementation.
export interface Fixer {
  // Returns true if it applied a change worth re-verifying, false if it gave up.
  fix(context: FixContext): Promise<boolean>
}

export interface FixContext {
  root: string
  attempt: number
  failingChecks: CheckResult[]
}

export interface VerifyLoopOptions extends VerifyOptions {
  maxAttempts?: number             // default 3
  project?: DetectedProject        // inject a pre-detected project (skips detection)
}

export type LoopStatus = 'passed' | 'exhausted' | 'gave_up'

export interface VerifyLoopResult {
  status: LoopStatus
  attempts: number
  finalResult: VerifySummary
  history: VerifySummary[]
}

export class VerifyLoop {
  constructor(private verifier: Verifier = new Verifier()) {}

  async run(root: string, fixer: Fixer, options: VerifyLoopOptions = {}): Promise<VerifyLoopResult> {
    const maxAttempts = options.maxAttempts ?? 3
    const history: VerifySummary[] = []

    // Detect the project once up front, then re-verify against it each attempt.
    const project = options.project ?? await detectProject(root)

    let result = await this.verifier.verifyDetected(project, options)
    history.push(result)

    let attempt = 0
    while (!result.passed && attempt < maxAttempts) {
      attempt++
      const failingChecks = result.checks.filter(c => !c.passed && !c.skipped)

      const applied = await fixer.fix({ root, attempt, failingChecks })
      if (!applied) {
        return { status: 'gave_up', attempts: attempt, finalResult: result, history }
      }

      result = await this.verifier.verifyDetected(project, options)
      history.push(result)
    }

    return {
      status: result.passed ? 'passed' : 'exhausted',
      attempts: attempt,
      finalResult: result,
      history,
    }
  }
}
