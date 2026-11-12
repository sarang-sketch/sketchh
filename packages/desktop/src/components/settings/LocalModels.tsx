// Settings → Models → "On this computer": the local model manager.
//
// Everything on screen comes from the engine's `local-models` (which asks Ollama and
// this machine). Downloading and removing ask first and show the size, and the engine
// refuses them without that confirmation. "Use for chat" writes the same key-free
// provider entry the Connect window writes for a local server.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSketchClient } from '../../lib/ClientProvider'
import type { LocalModelInfo, LocalModelPull, LocalModelsResult, LocalModelSuggestion } from '../../lib/client'
import type { ProviderSettingsEntry } from '../../lib/contracts'
import { useAppDispatch, useAppState } from '../../state/AppState'
import { useConfirm } from '../ConfirmDialog'
import { openExternal } from '../Markdown'
import { Cpu, Download, ExternalLink, Refresh, Trash } from '../Icons'
import styles from './SettingsDialog.module.css'
import own from './LocalModels.module.css'

const OLLAMA_DOWNLOAD = 'https://ollama.com/download'
const POLL_MS = 1000

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.max(0, Math.round(bytes / 1e3))} KB`
}

export function formatContext(tokens: number | null): string | null {
  if (tokens === null || tokens <= 0) return null
  return tokens >= 1024 ? `${Math.round(tokens / 1024)}K context` : `${tokens} context`
}

const gib = (bytes: number) => `${Math.round(bytes / 1024 ** 3)} GB`

export function LocalModels() {
  const client = useSketchClient()
  const state = useAppState()
  const dispatch = useAppDispatch()
  const confirm = useConfirm()
  const configured = state.providers.find((p) => p.id === 'ollama') ?? null
  const baseUrl = configured?.baseUrl || undefined
  const [result, setResult] = useState<LocalModelsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [busyModel, setBusyModel] = useState<string | null>(null)
  const [pulls, setPulls] = useState<Record<string, LocalModelPull>>({})
  const [custom, setCustom] = useState('')
  const timers = useRef(new Map<string, ReturnType<typeof setInterval>>())
  const supported = client.localModels !== undefined

  const refresh = useCallback(async () => {
    if (client.localModels === undefined) return
    setLoading(true)
    try {
      setResult(await client.localModels(baseUrl !== undefined ? { baseUrl } : {}))
      setProblem(null)
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [baseUrl, client])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const running = timers.current
    return () => {
      for (const timer of running.values()) clearInterval(timer)
      running.clear()
    }
  }, [])

  const watch = useCallback(
    (pull: LocalModelPull) => {
      setPulls((all) => ({ ...all, [pull.model]: pull }))
      if (pull.state !== 'running' || client.localModelPullStatus === undefined || timers.current.has(pull.id)) return
      const timer = setInterval(() => {
        void client.localModelPullStatus!(pull.id).then(
          (next) => {
            setPulls((all) => ({ ...all, [next.model]: next }))
            if (next.state !== 'running') {
              clearInterval(timer)
              timers.current.delete(pull.id)
              if (next.state === 'done') void refresh()
            }
          },
          (err) => {
            clearInterval(timer)
            timers.current.delete(pull.id)
            setProblem(err instanceof Error ? err.message : String(err))
          },
        )
      }, POLL_MS)
      timers.current.set(pull.id, timer)
    },
    [client, refresh],
  )

  const download = async (model: string, size?: number, needs?: number) => {
    if (client.localModelPull === undefined) return
    const answer = await confirm({
      title: `Download ${model}?`,
      message:
        size !== undefined
          ? `${formatBytes(size)} from ollama.com, through Ollama.${needs !== undefined ? ` It needs about ${gib(needs)} of memory to run.` : ''}`
          : 'Ollama shows the size as it downloads. You can cancel at any time and resume later.',
      buttons: [
        { id: 'download', label: 'Download', kind: 'primary' },
        { id: 'cancel', label: 'Cancel', kind: 'secondary' },
      ],
      cancelId: 'cancel',
    })
    if (answer !== 'download') return
    try {
      watch(await client.localModelPull({ model, confirmed: true, ...(baseUrl !== undefined ? { baseUrl } : {}) }))
      setProblem(null)
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    }
  }

  const act = async (model: string, action: () => Promise<unknown>) => {
    setBusyModel(model)
    try {
      await action()
      setProblem(null)
      await refresh()
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyModel(null)
    }
  }

  const remove = async (model: LocalModelInfo) => {
    if (client.localModelDelete === undefined) return
    const answer = await confirm({
      title: `Remove ${model.name}?`,
      message: `This deletes its ${formatBytes(model.size)} of files. You can download it again later.`,
      buttons: [
        { id: 'remove', label: 'Remove', kind: 'danger' },
        { id: 'cancel', label: 'Cancel', kind: 'secondary' },
      ],
      cancelId: 'cancel',
    })
    if (answer !== 'remove') return
    await act(model.name, () => client.localModelDelete!({ model: model.name, confirmed: true, ...(baseUrl !== undefined ? { baseUrl } : {}) }))
  }

  const useForChat = async (model: LocalModelInfo) => {
    const server = result?.server.baseUrl ?? 'http://localhost:11434'
    const entry: ProviderSettingsEntry = { id: 'ollama', kind: 'openai-compatible', baseUrl: `${server}/v1`, model: model.name, label: 'Ollama (local)' }
    await act(model.name, async () => {
      const providers = [...state.providers.filter((p) => p.id !== 'ollama'), entry]
      const written = await client.saveProviderSettings({ settings: { version: 1, providers, selected: 'ollama' } })
      dispatch({
        type: 'PROVIDER_SETTINGS_SAVED',
        payload: { providers: written.settings.providers, selected: written.settings.selected, path: written.path },
      })
      dispatch({ type: 'SET_PROVIDER', payload: { provider: 'ollama', model: model.name } })
    })
  }

  if (!supported) return null

  const server = result?.server
  const hardware = result?.hardware
  const inUse = state.selectedProvider === 'ollama' ? (state.selectedModel ?? configured?.model ?? null) : null

  return (
    <section className={own.wrap} aria-label="Models on this computer">
      <div className={own.head}>
        <div>
          <h3 className={own.h3}>On this computer</h3>
          <p className={styles.optionDetail}>Free and private: models that run here, through Ollama. Nothing leaves the machine.</p>
        </div>
        <button className={styles.secondary} onClick={() => void refresh()} disabled={loading}>
          <Refresh size={12} /> {loading ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      {server !== undefined && (
        <p className={own.status} role="status">
          {server.reachable ? (
            <>
              <span className={own.dotOk} /> Ollama {server.version ?? ''} is running at <code>{server.baseUrl}</code>
            </>
          ) : result?.install.found ? (
            <>
              <span className={own.dotWarn} /> Ollama is installed but not running. Start it from your apps menu, or run{' '}
              <code>ollama serve</code>, then press Refresh.
            </>
          ) : (
            <>
              <span className={own.dotWarn} /> Ollama is not installed.{' '}
              <button className={own.link} onClick={() => void openExternal(OLLAMA_DOWNLOAD)}>
                Get Ollama <ExternalLink size={11} />
              </button>{' '}
              It is free. Install it, then press Refresh.
            </>
          )}
        </p>
      )}

      {hardware !== undefined && (
        <p className={own.machine}>
          <Cpu size={12} /> {gib(hardware.totalMemory)} memory ({gib(hardware.freeMemory)} free) · {hardware.cpuCount} CPU threads ·{' '}
          {hardware.gpus.length > 0
            ? hardware.gpus.map((g) => `${g.name} ${gib(g.memoryTotal)}`).join(', ')
            : 'no NVIDIA GPU found (other GPUs are not detected)'}
        </p>
      )}

      {problem !== null && (
        <p className={own.error} role="alert">
          {problem}
        </p>
      )}

      {result !== null && server?.reachable === true && (
        <>
          <h4 className={own.h4}>Installed ({result.models.length})</h4>
          {result.models.length === 0 && <p className={own.empty}>No models yet. Download one below.</p>}
          <ul className={own.list}>
            {result.models.map((model) => {
              const chat = model.capabilities === null || model.capabilities.includes('completion')
              const facts = [
                formatBytes(model.size),
                model.parameterSize,
                model.quantization,
                formatContext(model.contextLength),
                model.capabilities !== null ? model.capabilities.join(', ') : null,
              ].filter((fact): fact is string => typeof fact === 'string' && fact !== '')
              return (
                <li key={model.name} className={own.row}>
                  <div className={own.rowText}>
                    <div className={own.name}>
                      {model.name}
                      {model.loaded && <span className={own.badge}>Loaded</span>}
                      {inUse === model.name && <span className={own.badge}>In use</span>}
                    </div>
                    <div className={own.facts}>{facts.join(' · ')}</div>
                  </div>
                  <div className={own.actions}>
                    {chat && inUse !== model.name && (
                      <button className={styles.secondary} disabled={busyModel !== null} onClick={() => void useForChat(model)}>
                        Use for chat
                      </button>
                    )}
                    <button
                      className={styles.secondary}
                      disabled={busyModel !== null || client.localModelLoad === undefined}
                      onClick={() =>
                        void act(model.name, () =>
                          client.localModelLoad!({ model: model.name, unload: model.loaded, ...(baseUrl !== undefined ? { baseUrl } : {}) }),
                        )
                      }
                    >
                      {busyModel === model.name ? 'Working…' : model.loaded ? 'Unload' : 'Load'}
                    </button>
                    <button
                      className={styles.secondary}
                      aria-label={`Remove ${model.name}`}
                      disabled={busyModel !== null}
                      onClick={() => void remove(model)}
                    >
                      <Trash size={12} />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>

          <h4 className={own.h4}>Recommended for this computer</h4>
          <ul className={own.list}>
            {result.recommendations.map((row) => (
              <Suggestion key={row.name} row={row} pull={pulls[row.name]} onDownload={() => void download(row.name, row.size, row.memoryNeeded)} onCancel={(id) => void client.localModelPullCancel?.(id)} />
            ))}
          </ul>
          <p className={own.fine}>
            Sizes are from ollama.com. Memory needed is an estimate: 1.5 x the download, plus 4 GB for the system. Sketch's agent does
            not need a model with native tool calling.
          </p>

          <form
            className={own.custom}
            onSubmit={(e) => {
              e.preventDefault()
              const name = custom.trim()
              if (name !== '') void download(name)
            }}
          >
            <input
              className={own.input}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="Another model from ollama.com/library, e.g. llama3.2:3b"
              aria-label="Model to download"
            />
            <button className={styles.secondary} type="submit" disabled={custom.trim() === ''}>
              <Download size={12} /> Download
            </button>
          </form>
          {custom.trim() !== '' && pulls[custom.trim()] !== undefined && <Progress pull={pulls[custom.trim()]!} onCancel={(id) => void client.localModelPullCancel?.(id)} />}
        </>
      )}
    </section>
  )
}

function Progress({ pull, onCancel }: { pull: LocalModelPull; onCancel(id: string): void }) {
  const percent = pull.total > 0 ? Math.min(100, Math.round((pull.completed / pull.total) * 100)) : null
  return (
    <div className={own.progress} role="status" aria-label={`Download of ${pull.model}`}>
      {pull.state === 'running' && (
        <>
          <progress max={100} value={percent ?? undefined} />
          <span>
            {pull.status}
            {percent !== null ? ` · ${percent}% of ${formatBytes(pull.total)}` : ''}
          </span>
          <button className={own.link} onClick={() => onCancel(pull.id)}>
            Cancel
          </button>
        </>
      )}
      {pull.state === 'done' && <span>Downloaded.</span>}
      {pull.state === 'cancelled' && <span>Cancelled. Downloading again resumes where it stopped.</span>}
      {pull.state === 'failed' && <span className={own.errorText}>{pull.error ?? 'The download failed.'}</span>}
    </div>
  )
}

function Suggestion({
  row,
  pull,
  onDownload,
  onCancel,
}: {
  row: LocalModelSuggestion
  pull: LocalModelPull | undefined
  onDownload(): void
  onCancel(id: string): void
}) {
  const fit = row.fit === 'fits' ? 'Fits this computer' : row.fit === 'tight' ? 'Tight: may be slow or fail' : 'Too big for this computer'
  return (
    <li className={`${own.row} ${row.fit === 'too-big' ? own.dim : ''}`}>
      <div className={own.rowText}>
        <div className={own.name}>
          {row.name}
          {row.best && <span className={own.badge}>Best fit</span>}
          {row.purpose === 'embedding' && <span className={own.badge}>Embeddings</span>}
        </div>
        <div className={own.facts}>
          {formatBytes(row.size)} download · needs about {gib(row.memoryNeeded)} memory · {formatContext(row.contextTokens)} · {fit}
        </div>
        <div className={own.facts}>{row.note}</div>
        {pull !== undefined && <Progress pull={pull} onCancel={onCancel} />}
      </div>
      <div className={own.actions}>
        {row.installed ? (
          <span className={own.installed}>Installed</span>
        ) : (
          <button className={styles.secondary} disabled={pull?.state === 'running'} onClick={onDownload}>
            <Download size={12} /> Download
          </button>
        )}
      </div>
    </li>
  )
}

export default LocalModels
