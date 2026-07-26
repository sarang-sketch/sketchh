// Verifier — runs the configured checks in order and returns structured results.
// Order matters: lint → typecheck → test → build. Fail-fast is optional.

import { detectProject } from './detector.js'
import { ChildProcessRunner } from './command-runner.js'
import type {
  CommandRunner,
  VerifySummary,
  CheckResult,
  CheckName,
  DetectedProject,
} from './types.js'

const CHECK_ORDER: CheckName[] = ['lint', 'typecheck', 'test', 'build']

export interface VerifyOptions {
  runner?: CommandRunner
  failFast?: boolean       // stop at the first failing check (default false)
  only?: CheckName[]       // run only these checks if provided
}

export class Verifier {
  private runner: CommandRunner

  constructor(runner?: CommandRunner) {
    this.runner = runner ?? new ChildProcessRunner()
  }

  async verify(root: string, options: VerifyOptions = {}): Promise<VerifySummary> {
    const project = await detectProject(root)
    return this.verifyDetected(project, options)
  }

  async verifyDetected(project: DetectedProject, options: VerifyOptions = {}): Promise<VerifySummary> {
    const runner = options.runner ?? this.runner
    const failFast = options.failFast ?? false
    const checks: CheckResult[] = []

    const ordered = [...project.checks].sort(
      (a, b) => CHECK_ORDER.indexOf(a.name) - CHECK_ORDER.indexOf(b.name)
    )

    for (const check of ordered) {
      if (options.only && !options.only.includes(check.name)) continue

      const start = nowMs()
      const out = await runner.run(check.command, check.args, project.root)
      const passed = out.exitCode === 0

      checks.push({
        name: check.name,
        passed,
        output: combineOutput(out.stdout, out.stderr),
        durationMs: nowMs() - start,
        skipped: false,
      })

      if (!passed && failFast) break
    }

    // Record checks that the project simply does not have as skipped, for clarity.
    for (const name of CHECK_ORDER) {
      if (options.only && !options.only.includes(name)) continue
      if (!ordered.some(c => c.name === name)) {
        checks.push({ name, passed: true, output: '', durationMs: 0, skipped: true })
      }
    }

    checks.sort((a, b) => CHECK_ORDER.indexOf(a.name) - CHECK_ORDER.indexOf(b.name))

    return {
      passed: checks.every(c => c.passed),
      checks,
    }
  }
}

function combineOutput(stdout: string, stderr: string): string {
  const parts = [stdout.trim(), stderr.trim()].filter(Boolean)
  return parts.join('\n')
}

// Wall-clock helper isolated so it is easy to see where time is measured.
// Not using performance.now to keep this dependency-free across runtimes.
function nowMs(): number {
  return Date.now()
}
