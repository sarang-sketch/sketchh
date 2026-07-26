// Command runner — executes verify check commands.
// The real implementation shells out via child_process; a fake is injected in tests.

import { spawn } from 'node:child_process'
import type { CommandRunner, CommandOutput } from './types.js'

export class ChildProcessRunner implements CommandRunner {
  constructor(private timeoutMs = 120_000) {}

  run(command: string, args: string[], cwd: string): Promise<CommandOutput> {
    return new Promise(resolve => {
      let stdout = ''
      let stderr = ''
      let settled = false

      // shell:true lets Windows resolve npm/npx/cargo shims; args are pre-split
      // and never contain user free-text, so this is not a shell-injection vector.
      const child = spawn(command, args, { cwd, shell: true })

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill()
        resolve({ exitCode: 124, stdout, stderr: stderr + '\n[timed out]' })
      }, this.timeoutMs)

      child.stdout?.on('data', d => { stdout += d.toString() })
      child.stderr?.on('data', d => { stderr += d.toString() })

      child.on('error', err => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ exitCode: 127, stdout, stderr: stderr + `\n${err.message}` })
      })

      child.on('close', code => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ exitCode: code ?? 1, stdout, stderr })
      })
    })
  }
}
