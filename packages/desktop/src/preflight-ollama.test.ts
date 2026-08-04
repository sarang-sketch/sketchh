import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const repo = path.resolve(__dirname, '../../..')
const script = path.join(repo, 'packages/desktop/scripts/preflight-ollama.mjs')

function preflight(endpoint: string) {
  return spawnSync(
    process.execPath,
    [script, '--model', 'guard-fixture', '--endpoint', endpoint],
    { encoding: 'utf8' },
  )
}

describe('real-Ollama preflight endpoint guard', () => {
  it('refuses localhost instead of trusting an unresolved hostname alias', () => {
    const result = preflight('http://localhost:11434/v1')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('must use a numeric loopback address')
    expect(result.stderr).not.toContain('real Ollama is unavailable')
  })

  it('refuses an explicitly non-loopback address before any provider request', () => {
    const result = preflight('http://192.0.2.1:11434/v1')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('refusing non-loopback Ollama endpoint')
    expect(result.stderr).not.toContain('real Ollama is unavailable')
  })
})
