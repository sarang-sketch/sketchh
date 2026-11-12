// Files inside the project that the agent may still not touch.
//
// Containment (`isWithin`, real-path checks) answers "is this inside the folder the
// user opened?". It does not answer "is this a file the agent should write?", and
// three kinds of file inside every project are not:
//
//   * `.git/` — git's own state. A hook (`.git/hooks/pre-commit`) or a config entry
//     (`core.hooksPath`, an alias) written there RUNS on the user's next git command.
//     A prompt injection in any file the agent reads could otherwise turn one edit
//     into code execution outside every approval this engine asks for.
//   * Sketch's own records under `.sketch/` — the run log, undo snapshots and memory
//     are evidence of what the agent did; the agent must not be able to rewrite them.
//   * Secrets — `.env` files and private keys. Writing them can plant credentials;
//     READING them sends their contents to the model provider. Both are refused.
//     Templates (`.env.example`, `.env.sample`, `.env.template`) are ordinary files.
//
// Paths are compared case-insensitively with forward slashes, because Windows and
// macOS treat `.GIT/hooks` and `.git/hooks` as the same folder.

/** Folders under `.sketch/` that hold the engine's own records. */
const ENGINE_RECORDS = new Set(['events', 'snapshots', 'memory', 'auth', 'cache', 'index', 'training'])

const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.defaults'])

const PRIVATE_KEYS = /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)$|\.(pem|p12|pfx)$/

function segments(relativePath: string): string[] {
  return relativePath
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part !== '' && part !== '.')
    .map((part) => part.toLowerCase())
}

/** A secrets file: `.env`, `.env.local`, `.env.production`... or a private key. Templates are not. */
export function isSecretsFile(relativePath: string): boolean {
  const name = segments(relativePath).pop() ?? ''
  if (ENV_TEMPLATES.has(name)) return false
  if (name === '.env' || name.startsWith('.env.')) return true
  return PRIVATE_KEYS.test(name)
}

/**
 * Why the agent may not WRITE this project-relative path, or `null` when it may.
 * The reason is shown to the model, and through the run's record to the user.
 */
export function writeRefusal(relativePath: string): string | null {
  const parts = segments(relativePath)
  if (parts.includes('.git')) {
    return `${relativePath} is inside .git, git's own folder. Hooks and config there run on your next git command, so the agent may not write them.`
  }
  if (parts[0] === '.sketch' && parts.length > 1 && ENGINE_RECORDS.has(parts[1]!)) {
    return `${relativePath} is part of Sketch's own record of what the agent did, so the agent may not change it.`
  }
  if (parts[0] === '.sketch' && parts[1] === 'skills' && parts[2] === '.grants') {
    // A grant is the user's approval of a skill's capabilities. Written by the agent,
    // it would approve whatever skill the agent wrote next to it.
    return `${relativePath} records which permissions you approved for a skill, so only you can change it.`
  }
  if (isSecretsFile(relativePath)) {
    return `${relativePath} holds secrets, so the agent may not write it. Change it yourself, or have the agent update a template such as .env.example.`
  }
  return null
}

/** Why the agent may not READ this path (its contents would go to the model), or `null`. */
export function readRefusal(relativePath: string): string | null {
  if (isSecretsFile(relativePath)) {
    return `${relativePath} holds secrets, so Sketch does not send it to the model. Ask the user for the value you need, or read a template such as .env.example.`
  }
  return null
}
