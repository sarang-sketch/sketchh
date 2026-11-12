// What this computer can run: memory, NVIDIA GPU memory when `nvidia-smi` is there,
// whether the `ollama` program is installed, and which coding models fit.
//
// ── THE RECOMMENDATION RULE, STATED ──────────────────────────────────────────
//
// A model needs about 1.5 x its download size in memory while it runs (weights plus
// the context cache), and the operating system, Sketch and a browser need about 4 GB
// more. So a model "fits" when `1.5 x size + 4 GB <= total memory`, or when a GPU's memory holds
// `1.2 x size`. It is "tight" within 25% over that line, and "too big" beyond it.
// The single "best" pick is the largest coding model that fits, capped at 10 GB
// unless a GPU holds it (a bigger model on a CPU is too slow to start with).
// The rule is an estimate and the panel says so; the sizes come from ollama.com's
// library pages (checked 2026-11-01), not from a guess.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cpus, freemem, platform, totalmem } from 'node:os'
import { join } from 'node:path'

const GB = 1024 ** 3

export interface GpuInfo {
  name: string
  /** Bytes. */
  memoryTotal: number
  memoryUsed: number
}

export interface Hardware {
  totalMemory: number
  freeMemory: number
  cpuCount: number
  platform: string
  /** NVIDIA GPUs `nvidia-smi` reported. Empty when it is not installed; other GPUs are not detected. */
  gpus: GpuInfo[]
}

function run(file: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolveRun) => {
    try {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
        resolveRun(err ? null : stdout)
      })
    } catch {
      resolveRun(null)
    }
  })
}

/** Parse `nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv,noheader,nounits` (MiB). */
export function parseNvidiaSmi(output: string): GpuInfo[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.split(',').map((part) => part.trim()))
    .filter((parts) => parts.length >= 3 && parts[0] !== '' && Number.isFinite(Number(parts[1])))
    .map(([name, total, used]) => ({
      name: name!,
      memoryTotal: Number(total) * 1024 * 1024,
      memoryUsed: (Number(used) || 0) * 1024 * 1024,
    }))
}

export async function readHardware(): Promise<Hardware> {
  const smi = await run('nvidia-smi', ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader,nounits'], 3_000)
  return {
    totalMemory: totalmem(),
    freeMemory: freemem(),
    cpuCount: cpus().length,
    platform: platform(),
    gpus: smi === null ? [] : parseNvidiaSmi(smi),
  }
}

export interface OllamaInstall {
  /** The `ollama` program was found (on PATH, or in its default Windows folder). */
  found: boolean
  /** Its version line, when it ran. */
  version?: string
  path?: string
}

/** Whether Ollama is installed, separately from whether its server answers. */
export async function findOllama(env: NodeJS.ProcessEnv = process.env): Promise<OllamaInstall> {
  const candidates = ['ollama']
  if (platform() === 'win32' && env['LOCALAPPDATA']) {
    candidates.push(join(env['LOCALAPPDATA'], 'Programs', 'Ollama', 'ollama.exe'))
  }
  if (platform() === 'darwin') candidates.push('/Applications/Ollama.app/Contents/Resources/ollama')
  for (const candidate of candidates) {
    if (candidate !== 'ollama' && !existsSync(candidate)) continue
    const out = await run(candidate, ['--version'], 4_000)
    if (out === null) continue
    const line = out.split(/\r?\n/).find((l) => /version/i.test(l))?.trim()
    return { found: true, ...(line !== undefined ? { version: line } : {}), path: candidate }
  }
  return { found: false }
}

// ── recommendations ──────────────────────────────────────────────────────────

export interface ModelSuggestion {
  name: string
  /** Download size in bytes, from the model's ollama.com library page. */
  size: number
  /** Context window the library page lists, in tokens. */
  contextTokens: number
  purpose: 'coding' | 'embedding'
  note: string
}

/** Checked against ollama.com/library on 2026-11-01. Sizes are the default (Q4) downloads. */
export const SUGGESTED_MODELS: readonly ModelSuggestion[] = [
  { name: 'qwen2.5-coder:1.5b', size: 986e6, contextTokens: 32_768, purpose: 'coding', note: 'Smallest useful coding model; fine for completions and small edits.' },
  { name: 'qwen2.5-coder:3b', size: 1.9e9, contextTokens: 32_768, purpose: 'coding', note: 'Light machines: quick answers, simple tasks.' },
  { name: 'qwen2.5-coder:7b', size: 4.7e9, contextTokens: 32_768, purpose: 'coding', note: 'The usual choice for 16 GB of memory.' },
  { name: 'qwen2.5-coder:14b', size: 9.0e9, contextTokens: 32_768, purpose: 'coding', note: 'Better reasoning over larger changes.' },
  { name: 'qwen3-coder:30b', size: 19e9, contextTokens: 262_144, purpose: 'coding', note: 'Agentic coding with a very long context; needs a large machine.' },
  { name: 'qwen2.5-coder:32b', size: 20e9, contextTokens: 32_768, purpose: 'coding', note: 'Strongest of the Qwen 2.5 coders; needs a large machine.' },
  { name: 'nomic-embed-text', size: 274e6, contextTokens: 2_048, purpose: 'embedding', note: 'Embeddings for semantic search. Not a chat model.' },
]

export type Fit = 'fits' | 'tight' | 'too-big'

/** Memory the rule above says a model of `size` bytes needs. */
export function memoryNeeded(size: number): number {
  return Math.ceil(1.5 * size + 4 * GB)
}

export function fitFor(size: number, hardware: Pick<Hardware, 'totalMemory' | 'gpus'>): Fit {
  const gpu = Math.max(0, ...hardware.gpus.map((g) => g.memoryTotal))
  if (gpu >= 1.2 * size) return 'fits'
  const need = memoryNeeded(size)
  if (need <= hardware.totalMemory) return 'fits'
  if (need <= hardware.totalMemory * 1.25) return 'tight'
  return 'too-big'
}

export interface Recommendation extends ModelSuggestion {
  fit: Fit
  memoryNeeded: number
  installed: boolean
  /** The single coding model this machine should start with. */
  best: boolean
}

export function recommend(hardware: Pick<Hardware, 'totalMemory' | 'gpus'>, installed: readonly string[]): Recommendation[] {
  const have = new Set(installed.map((name) => (name.includes(':') ? name : `${name}:latest`)))
  const isInstalled = (name: string) => have.has(name) || have.has(`${name}:latest`)
  const rows = SUGGESTED_MODELS.map((model) => ({
    ...model,
    fit: fitFor(model.size, hardware),
    memoryNeeded: memoryNeeded(model.size),
    installed: isInstalled(model.name),
    best: false,
  }))
  // Without a GPU that holds it, a model over 10 GB answers at a few words a second on
  // a CPU, which is not a good first experience; the best pick stops there.
  const gpu = Math.max(0, ...hardware.gpus.map((g) => g.memoryTotal))
  const coding = rows.filter(
    (row) => row.purpose === 'coding' && row.fit === 'fits' && (row.size <= 10e9 || gpu >= 1.2 * row.size),
  )
  const best = coding.reduce<Recommendation | null>((top, row) => (top === null || row.size > top.size ? row : top), null)
  if (best !== null) best.best = true
  return rows
}
