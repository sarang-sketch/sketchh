// "Connect a model" — the first-run setup the research report asks for, in four steps:
// pick a provider → sign in or paste a key → pick a model from the provider's own list
// → a real connection test. No JSON, no model id typed from memory.
//
// "Sign in with ChatGPT" is the shortest path of all: one browser approval, and the
// account's best model is selected and tested automatically. The ENGINE completes
// that sign-in and keeps its tokens (they rotate on every renewal, so they live with
// the code that renews them); this window only ever learns "signed in as …".
//
// THE KEY'S PATH IS THE SAME AS EVERYWHERE ELSE IN THIS APP. It lives in this
// component's state while the wizard is open (it has to: listing models and testing
// need it), goes to the OS credential store when the user finishes, and is dropped.
// It is never put in AppState and never written to providers.json — the save goes
// through the engine's whitelist and byte-level guard like any other.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSketchClient } from '../../lib/ClientProvider'
import type { ChatGPTModelsResult, ProviderModel, ProviderModelsResult } from '../../lib/client'
import type { ProviderDescriptor, ProviderSettingsEntry } from '../../lib/contracts'
import { openExternal } from '../Markdown'
import { useAppDispatch, useAppState } from '../../state/AppState'
import { useKeyStore } from '../../settings/KeyStoreProvider'
import { describeKeyFailure } from '../../settings/keyStore'
import { useProviderConfig } from '../../settings/useProviderConfig'
import { describeContext, describePrice, guideFor, OLLAMA_CONTEXT_NOTE, preferredModel } from '../../settings/providerGuide'
import { challengeFor, exchangeOpenRouterCode, openRouterAuthUrl, randomVerifier } from '../../settings/pkce'
import { stateFromResult, describeTest, isLocalEndpoint, previewEndpoint } from '../../settings/providerRows'
import { CHATGPT_ID, describeAccount, toProviderModels } from '../../settings/chatgpt'
import {
  AlertCircle,
  Check,
  ChevronRight,
  Copy,
  Cpu,
  ExternalLink,
  Globe,
  Key,
  MessageSquare,
  Search,
  X,
  Zap,
} from '../Icons'
import styles from './ConnectWizard.module.css'

type Step = 'pick' | 'oauth' | 'chatgpt' | 'credentials' | 'model' | 'done'

/** What the ChatGPT step is showing. */
type ChatGPTWait =
  | { kind: 'starting' }
  | { kind: 'browser'; authUrl: string }
  | { kind: 'device'; userCode: string; verificationUrl: string }
  | { kind: 'models' }
  | { kind: 'connecting'; model: string }

const GROUP_ORDER: Array<{ group: 'key' | 'local' | 'advanced'; title: string }> = [
  { group: 'key', title: 'Use an API key' },
  { group: 'local', title: 'Run a model on this computer' },
  { group: 'advanced', title: 'Advanced' },
]

/** How long a local model server gets to answer the probe the picker runs when it opens. */
export const LOCAL_PROBE_MS = 1500

/** A local runtime that answered at its default address with at least one model. */
interface DetectedLocal {
  row: ProviderDescriptor
  models: ProviderModel[]
  model: string
}

export function ConnectWizard() {
  const state = useAppState()
  if (!state.connectOpen) return null
  return <WizardBody initialProvider={state.connectProvider} />
}

function WizardBody({ initialProvider }: { initialProvider: string | null }) {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const client = useSketchClient()
  const keyStore = useKeyStore()
  const { loading } = useProviderConfig()

  const [step, setStep] = useState<Step>('pick')
  const [descriptor, setDescriptor] = useState<ProviderDescriptor | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [useEnvKey, setUseEnvKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [models, setModels] = useState<ProviderModel[]>([])
  const [listing, setListing] = useState<ProviderModelsResult | null>(null)
  const [model, setModel] = useState('')
  const [filter, setFilter] = useState('')
  const [doneNote, setDoneNote] = useState<string | null>(null)
  const [testLabel, setTestLabel] = useState<{ ok: boolean; text: string } | null>(null)
  const oauthId = useRef<string | null>(null)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const chatgptLoginId = useRef<string | null>(null)
  const [chatgptWait, setChatgptWait] = useState<ChatGPTWait>({ kind: 'starting' })
  const [chatgptAccount, setChatgptAccount] = useState<{ email?: string; plan?: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const cancelChatGPT = useCallback(() => {
    if (chatgptLoginId.current !== null) void client.chatgptLoginCancel?.({ id: chatgptLoginId.current })
    chatgptLoginId.current = null
  }, [client])

  const close = useCallback(() => {
    if (oauthId.current !== null) void client.oauthCancel?.({ id: oauthId.current })
    oauthId.current = null
    cancelChatGPT()
    setApiKey('')
    dispatch({ type: 'CLOSE_CONNECT' })
  }, [cancelChatGPT, client, dispatch])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const catalog = state.providerCatalog
  const envKeyName = descriptor ? state.providerEnvKeys[descriptor.id] : undefined

  const choose = useCallback(
    (row: ProviderDescriptor) => {
      setDescriptor(row)
      const existing = state.providers.find((p) => p.id === row.id)
      setBaseUrl(existing?.baseUrl ?? row.defaultBaseUrl)
      setApiKey('')
      setUseEnvKey(state.providerEnvKeys[row.id] !== undefined)
      setModels([])
      setListing(null)
      setModel(existing?.model ?? '')
      setProblem(null)
      setStep('credentials')
    },
    [state.providerEnvKeys, state.providers],
  )

  const listModels = useCallback(
    async (row: ProviderDescriptor, url: string, key: string) => {
      if (client.providerModels === undefined) {
        setProblem(`The ${client.transport} transport cannot list models. Enter the model name below.`)
        setStep('model')
        return
      }
      setBusy(true)
      setProblem(null)
      try {
        const result = await client.providerModels({
          provider: { id: row.id, kind: row.kind, baseUrl: url, ...(key.trim() !== '' ? { apiKey: key.trim() } : {}) },
          timeoutMs: 12_000,
        })
        setListing(result)
        if (!result.ok) {
          const local = isLocalEndpoint(url)
          setProblem(
            result.code === 'unauthorized'
              ? 'That key was not accepted. Check it was copied completely, or create a new one.'
              : local && (result.code === 'unreachable' || result.code === 'timeout')
                ? `Nothing is answering at ${url}. ${guideFor(row.id).localHelp ?? 'Start the local server and try again.'}`
                : result.message,
          )
          return
        }
        setModels(result.models)
        const current = state.providers.find((p) => p.id === row.id)?.model
        setModel(current && result.models.some((m) => m.id === current) ? current : preferredModel(row.id, result.models) ?? '')
        setStep('model')
      } catch (err) {
        setProblem(`Could not list models: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setBusy(false)
      }
    },
    [client, state.providers],
  )

  const signInWithOpenRouter = useCallback(async () => {
    const row = catalog.find((p) => p.id === 'openrouter')
    if (row === undefined) return
    if (client.oauthStart === undefined || client.oauthWait === undefined) {
      setProblem('Sign-in needs the engine. Paste an OpenRouter key instead.')
      choose(row)
      return
    }
    setDescriptor(row)
    setBaseUrl(row.defaultBaseUrl)
    setProblem(null)
    setStep('oauth')
    try {
      const verifier = randomVerifier()
      const challenge = await challengeFor(verifier)
      const started = await client.oauthStart({ timeoutMs: 300_000 })
      oauthId.current = started.id
      const url = openRouterAuthUrl(started.callbackUrl, challenge)
      setAuthUrl(url)
      await openExternal(url)
      const outcome = await client.oauthWait({ id: started.id })
      if (oauthId.current !== started.id) return // cancelled or superseded
      oauthId.current = null
      if (!outcome.ok) {
        setProblem(outcome.error === 'cancelled' ? null : `Sign-in did not complete: ${outcome.error}`)
        setStep('pick')
        return
      }
      const key = await exchangeOpenRouterCode(outcome.code, verifier)
      setApiKey(key)
      setUseEnvKey(false)
      await listModels(row, row.defaultBaseUrl, key)
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
      setStep('pick')
    }
  }, [catalog, choose, client, listModels])

  /**
   * Save, select and test one provider. Takes its inputs explicitly so a flow that
   * has just learned them (the ChatGPT sign-in) need not wait for React state.
   * Resolves true when setup reached the done step.
   */
  const finishWith = useCallback(
    async (inputs: { row: ProviderDescriptor; url: string; modelId: string; key: string; envKey: boolean; notes?: string[] }): Promise<boolean> => {
      const { row, url, modelId, key, envKey } = inputs
      if (modelId.trim() === '') return false
      const endpoint = previewEndpoint(url)
      if (!endpoint.ok) {
        setProblem(endpoint.reason ?? 'The endpoint is not usable.')
        return false
      }
      setBusy(true)
      setProblem(null)
      const notes: string[] = [...(inputs.notes ?? [])]
      try {
        // 1. The key, to the OS credential store — never to providers.json.
        const typed = key.trim()
        if (typed !== '' && !envKey) {
          try {
            const store = await keyStore.save(row.id, typed)
            notes.push(`Your key is stored in ${store}.`)
          } catch (err) {
            notes.push(describeKeyFailure('save', row.id, err))
          }
        } else if (envKey && state.providerEnvKeys[row.id]) {
          notes.push(`Using ${state.providerEnvKeys[row.id]} from your environment.`)
        }

        // 2. The key-free entry, selected as the default.
        const entry: ProviderSettingsEntry = {
          id: row.id,
          kind: row.kind,
          baseUrl: endpoint.resolvedUrl,
          model: modelId.trim(),
          label: row.id === CHATGPT_ID ? 'ChatGPT' : row.name,
        }
        const providers = [...state.providers.filter((p) => p.id !== entry.id), entry]
        const written = await client.saveProviderSettings({ settings: { version: 1, providers, selected: entry.id } })
        dispatch({
          type: 'PROVIDER_SETTINGS_SAVED',
          payload: { providers: written.settings.providers, selected: written.settings.selected, path: written.path },
        })
        if (!written.settings.providers.some((p) => p.id === entry.id)) {
          setProblem('The engine refused this configuration. Check the endpoint and the model name.')
          return false
        }
        dispatch({ type: 'SET_PROVIDER', payload: { provider: entry.id, model: entry.model } })
        setModel(entry.model)

        // 3. A real connection test with the same credential a run will use.
        dispatch({ type: 'PROVIDER_TEST_STARTED', payload: entry.id })
        try {
          const result = await client.testProvider({
            provider: {
              id: entry.id,
              kind: entry.kind,
              baseUrl: entry.baseUrl,
              model: entry.model,
              ...(typed !== '' && !envKey ? { apiKey: typed } : {}),
            },
            timeoutMs: entry.id === CHATGPT_ID ? 45_000 : 10_000,
          })
          const settled = stateFromResult(result, Date.now())
          dispatch({ type: 'PROVIDER_TEST_SETTLED', payload: { id: entry.id, state: settled } })
          const summary = describeTest(settled)
          setTestLabel({ ok: result.ok, text: `${summary.label}: ${summary.detail}` })
        } catch (err) {
          setTestLabel({ ok: false, text: `The connection test could not run: ${err instanceof Error ? err.message : String(err)}` })
        }
        setDoneNote(notes.join(' '))
        setStep('done')
        return true
      } catch (err) {
        setProblem(`Could not save: ${err instanceof Error ? err.message : String(err)}`)
        return false
      } finally {
        setApiKey('')
        setBusy(false)
      }
    },
    [client, dispatch, keyStore, state.providerEnvKeys, state.providers],
  )

  // ── a model server already running on this computer ──────────────────────
  //
  // When the picker opens, ask each local runtime the catalog knows (Ollama, LM Studio,
  // llama.cpp) for its models at its default address, with a short timeout. One that
  // answers is offered first: the free, private choice, connected in one click. The
  // probe only reaches this computer and carries no key.
  const [detected, setDetected] = useState<DetectedLocal[]>([])
  const configuredIds = useRef(new Set<string>())
  configuredIds.current = new Set(state.providers.map((p) => p.id))
  useEffect(() => {
    if (client.providerModels === undefined) return
    const rows = catalog.filter(
      (row) =>
        guideFor(row.id).group === 'local' &&
        !row.needsKey &&
        isLocalEndpoint(row.defaultBaseUrl) &&
        !configuredIds.current.has(row.id),
    )
    if (rows.length === 0) return
    let live = true
    void Promise.all(
      rows.map(async (row): Promise<DetectedLocal | null> => {
        try {
          const result = await client.providerModels?.({
            provider: { id: row.id, kind: row.kind, baseUrl: row.defaultBaseUrl },
            timeoutMs: LOCAL_PROBE_MS,
          })
          if (result === undefined || !result.ok || result.models.length === 0) return null
          const model = preferredModel(row.id, result.models)
          return model === null ? null : { row, models: result.models, model }
        } catch {
          return null
        }
      }),
    ).then((found) => {
      if (live) setDetected(found.filter((entry): entry is DetectedLocal => entry !== null))
    })
    return () => {
      live = false
    }
  }, [catalog, client])

  const connectDetected = useCallback(
    async (found: DetectedLocal) => {
      setDescriptor(found.row)
      setBaseUrl(found.row.defaultBaseUrl)
      setModels(found.models)
      setModel(found.model)
      const connected = await finishWith({
        row: found.row,
        url: found.row.defaultBaseUrl,
        modelId: found.model,
        key: '',
        envKey: false,
        notes: [
          'It runs on this computer: free, and nothing leaves the machine.',
          ...(found.row.id === 'ollama' ? [OLLAMA_CONTEXT_NOTE] : []),
        ],
      })
      if (!connected) setStep('pick')
    },
    [finishWith],
  )

  const finish = useCallback(async () => {
    if (descriptor === null || model.trim() === '') return
    await finishWith({
      row: descriptor,
      url: baseUrl,
      modelId: model,
      key: apiKey,
      envKey: useEnvKey,
      ...(descriptor.id === 'ollama' ? { notes: [OLLAMA_CONTEXT_NOTE] } : {}),
    })
  }, [apiKey, baseUrl, descriptor, finishWith, model, useEnvKey])

  // ── changing the model after connecting ──────────────────────────────────
  //
  // This used to run the whole connect — save AND a live connection test of up to 45
  // seconds — on every change of the select, so arrowing through the list fired one
  // network test per model passed over, all racing each other. Now a change only
  // records the choice (debounced; saves run one at a time and always write the LATEST
  // choice, so they cannot land out of order), and testing is an explicit button.
  const latestProviders = useRef(state.providers)
  latestProviders.current = state.providers
  const wantedModel = useRef<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveChain = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => () => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
  }, [])

  const switchModel = useCallback(
    (row: ProviderDescriptor, modelId: string) => {
      wantedModel.current = modelId
      setModel(modelId)
      setTestLabel(null)
      if (saveTimer.current !== null) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null
        saveChain.current = saveChain.current.then(async () => {
          const wanted = wantedModel.current
          const current = latestProviders.current.find((p) => p.id === row.id)
          if (wanted === null || current === undefined || current.model === wanted) return
          const providers = latestProviders.current.map((p) => (p.id === row.id ? { ...p, model: wanted } : p))
          try {
            const written = await client.saveProviderSettings({ settings: { version: 1, providers, selected: row.id } })
            latestProviders.current = written.settings.providers
            dispatch({
              type: 'PROVIDER_SETTINGS_SAVED',
              payload: { providers: written.settings.providers, selected: written.settings.selected, path: written.path },
            })
            dispatch({ type: 'SET_PROVIDER', payload: { provider: row.id, model: wanted } })
          } catch (err) {
            setProblem(`Could not save the model: ${err instanceof Error ? err.message : String(err)}`)
          }
        })
      }, 250)
    },
    [client, dispatch],
  )

  const [retesting, setRetesting] = useState(false)
  const retest = useCallback(
    async (row: ProviderDescriptor) => {
      const entry = latestProviders.current.find((p) => p.id === row.id)
      if (entry === undefined) return
      setRetesting(true)
      dispatch({ type: 'PROVIDER_TEST_STARTED', payload: entry.id })
      try {
        const result = await client.testProvider({
          provider: { id: entry.id, kind: entry.kind, baseUrl: entry.baseUrl, model: wantedModel.current ?? entry.model },
          timeoutMs: entry.id === CHATGPT_ID ? 45_000 : 10_000,
        })
        const settled = stateFromResult(result, Date.now())
        dispatch({ type: 'PROVIDER_TEST_SETTLED', payload: { id: entry.id, state: settled } })
        const summary = describeTest(settled)
        setTestLabel({ ok: result.ok, text: `${summary.label}: ${summary.detail}` })
      } catch (err) {
        setTestLabel({ ok: false, text: `The connection test could not run: ${err instanceof Error ? err.message : String(err)}` })
      } finally {
        setRetesting(false)
      }
    },
    [client, dispatch],
  )

  /**
   * After a ChatGPT sign-in (or when one already exists): fetch what the account can
   * use and connect its best model straight away — or, when only the model is being
   * changed, show the list.
   */
  const connectChatGPT = useCallback(
    async (row: ProviderDescriptor, account: { email?: string; plan?: string } | null, pickOnly: boolean) => {
      setChatgptWait({ kind: 'models' })
      let listed: ChatGPTModelsResult | null = null
      try {
        listed = (await client.chatgptModels?.()) ?? null
      } catch (err) {
        setProblem(`Signed in, but the model list could not be read: ${err instanceof Error ? err.message : String(err)}`)
      }
      const list = listed !== null && listed.ok ? toProviderModels(listed.models) : []
      setModels(list)
      setListing(null)
      const current = state.providers.find((p) => p.id === CHATGPT_ID)?.model
      const chosen =
        current !== undefined && list.some((m) => m.id === current)
          ? current
          : listed?.defaultModel !== undefined && listed.defaultModel !== ''
            ? listed.defaultModel
            : (list[0]?.id ?? '')
      setModel(chosen)
      if (pickOnly || chosen === '') {
        setStep('model')
        return
      }
      const chosenName = list.find((m) => m.id === chosen)?.name ?? chosen
      setChatgptWait({ kind: 'connecting', model: chosenName })
      const connected = await finishWith({
        row,
        url: row.defaultBaseUrl,
        modelId: chosen,
        key: '',
        envKey: false,
        notes: [
          `${describeAccount(account ?? undefined)}.`,
          `Using ${chosenName}; switch any time from the model picker.`,
          'Sketch keeps this sign-in on your computer and renews it automatically.',
        ],
      })
      // A refused save leaves its reason on screen; give the person their choices back.
      if (!connected) setStep('pick')
    },
    [client, finishWith, state.providers],
  )

  const signInWithChatGPT = useCallback(
    async (mode: 'browser' | 'device', pickOnly = false) => {
      const row = catalog.find((p) => p.id === CHATGPT_ID)
      if (row === undefined) return
      if (client.chatgptLoginStart === undefined || client.chatgptLoginWait === undefined) {
        setProblem('Signing in with ChatGPT needs the Sketch engine, which this window cannot reach.')
        return
      }
      cancelChatGPT()
      setDescriptor(row)
      setBaseUrl(row.defaultBaseUrl)
      setProblem(null)
      setCopied(false)
      setStep('chatgpt')
      setChatgptWait({ kind: 'starting' })
      try {
        // Already signed in (a second window, or the provider was removed): no browser needed.
        const status = await client.chatgptStatus?.().catch(() => null)
        if (status?.signedIn === true && mode === 'browser') {
          const account = {
            ...(status.email !== undefined ? { email: status.email } : {}),
            ...(status.plan !== undefined ? { plan: status.plan } : {}),
          }
          setChatgptAccount(account)
          await connectChatGPT(row, account, pickOnly)
          return
        }

        let started = await client.chatgptLoginStart({ mode })
        if (!started.ok && started.code === 'port-busy' && mode === 'browser') {
          // Another program holds both callback ports: the code sign-in needs none.
          setProblem(`${started.error} Showing a sign-in code instead.`)
          started = await client.chatgptLoginStart({ mode: 'device' })
        }
        if (!started.ok) {
          setProblem(started.error)
          setStep('pick')
          return
        }
        chatgptLoginId.current = started.id
        if (started.mode === 'browser') {
          setChatgptWait({ kind: 'browser', authUrl: started.authUrl })
          await openExternal(started.authUrl)
        } else {
          setChatgptWait({ kind: 'device', userCode: started.userCode, verificationUrl: started.verificationUrl })
          await openExternal(started.verificationUrl)
        }
        const outcome = await client.chatgptLoginWait({ id: started.id })
        if (chatgptLoginId.current !== started.id) return // cancelled or superseded
        chatgptLoginId.current = null
        if (!outcome.ok) {
          if (outcome.code !== 'cancelled') setProblem(outcome.error)
          setStep('pick')
          return
        }
        setProblem(null)
        setChatgptAccount(outcome.account)
        await connectChatGPT(row, outcome.account, pickOnly)
      } catch (err) {
        setProblem(err instanceof Error ? err.message : String(err))
        setStep('pick')
      }
    },
    [cancelChatGPT, catalog, client, connectChatGPT],
  )

  // Opened for a specific provider (e.g. from its Settings row): skip the picker.
  // ChatGPT has no form: sign in, or — when it is already connected — pick a model.
  const openedFor = useRef(false)
  useEffect(() => {
    if (initialProvider === null || descriptor !== null || openedFor.current) return
    if (initialProvider === CHATGPT_ID) {
      if (!catalog.some((p) => p.id === CHATGPT_ID)) return
      openedFor.current = true
      void signInWithChatGPT('browser', state.providers.some((p) => p.id === CHATGPT_ID))
      return
    }
    const row = catalog.find((p) => p.id === initialProvider)
    if (row !== undefined) {
      openedFor.current = true
      choose(row)
    }
  }, [catalog, choose, descriptor, initialProvider, signInWithChatGPT, state.providers])

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const list = needle === '' ? models : models.filter((m) => m.id.toLowerCase().includes(needle) || (m.name ?? '').toLowerCase().includes(needle))
    return list.slice(0, 300)
  }, [filter, models])

  const guide = descriptor ? guideFor(descriptor.id) : null
  const local = descriptor ? !descriptor.needsKey && isLocalEndpoint(baseUrl) : false
  // A custom or self-hosted endpoint may or may not want a key: offer the field, but
  // only REQUIRE it for providers the registry says always need one.
  const keyOptional = descriptor ? !descriptor.needsKey : true
  const needsEndpoint = descriptor !== null && (descriptor.defaultBaseUrl === '' || descriptor.id === 'custom' || !descriptor.needsKey)

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="Connect a model">
        <div className={styles.header}>
          <div>
            <div className={styles.title}>Connect a model</div>
            <div className={styles.subtitle}>
              {step === 'pick' && 'Choose how Sketch should reach an AI model. You can add more later.'}
              {step === 'oauth' && 'Finish signing in in your browser.'}
              {step === 'chatgpt' && 'Sign in with your ChatGPT account.'}
              {step === 'credentials' && descriptor?.name}
              {step === 'model' && `${descriptor?.name} — choose a model`}
              {step === 'done' && 'All set.'}
            </div>
          </div>
          <button className={styles.close} onClick={close} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className={styles.body}>
          {problem !== null && (
            <div className={styles.problem} role="alert">
              <AlertCircle size={14} />
              <span>{problem}</span>
            </div>
          )}

          {step === 'pick' && (
            <>
              {loading && catalog.length === 0 ? (
                <div className={styles.muted}>Reading providers…</div>
              ) : (
                <>
                  {detected.map((found) => {
                    const pick = found.models.find((m) => m.id === found.model)
                    const runtime = found.row.name.replace(/\s*\(local\)$/i, '')
                    return (
                      <button
                        key={found.row.id}
                        className={styles.hero}
                        onClick={() => void connectDetected(found)}
                        disabled={busy}
                      >
                        <div className={styles.heroIcon}>
                          <Cpu size={20} />
                        </div>
                        <div className={styles.heroText}>
                          <div className={styles.heroTitle}>
                            {runtime} is running on this computer <span className={styles.badge}>Free · private</span>
                          </div>
                          <div className={styles.heroDetail}>
                            Use {pick?.name ?? found.model} in one click. No key, no account, and nothing leaves the
                            machine.
                          </div>
                        </div>
                        <ChevronRight size={16} />
                      </button>
                    )
                  })}

                  {catalog.some((p) => p.id === CHATGPT_ID) && (
                    <button
                      className={`${styles.hero} ${styles.heroChatgpt}`}
                      onClick={() => void signInWithChatGPT('browser')}
                      disabled={busy}
                    >
                      <div className={`${styles.heroIcon} ${styles.heroIconChatgpt}`}>
                        <MessageSquare size={20} />
                      </div>
                      <div className={styles.heroText}>
                        <div className={styles.heroTitle}>
                          Sign in with ChatGPT <span className={styles.badge}>No API key</span>
                        </div>
                        <div className={styles.heroDetail}>{guideFor(CHATGPT_ID).tagline}</div>
                      </div>
                      <ChevronRight size={16} />
                    </button>
                  )}

                  <button className={styles.hero} onClick={() => void signInWithOpenRouter()} disabled={busy}>
                    <div className={styles.heroIcon}>
                      <Globe size={20} />
                    </div>
                    <div className={styles.heroText}>
                      <div className={styles.heroTitle}>
                        Sign in with OpenRouter <span className={styles.badge}>Free models</span>
                      </div>
                      <div className={styles.heroDetail}>{guideFor('openrouter').tagline} No key to copy.</div>
                    </div>
                    <ChevronRight size={16} />
                  </button>

                  {GROUP_ORDER.map(({ group, title }) => {
                    const rows = catalog.filter((row) => guideFor(row.id).group === group || (group === 'key' && row.id === 'openrouter'))
                    if (rows.length === 0) return null
                    return (
                      <div key={group} className={styles.group}>
                        <div className={styles.groupTitle}>{title}</div>
                        <div className={styles.grid}>
                          {rows.map((row) => {
                            const g = guideFor(row.id)
                            const configured = state.providers.some((p) => p.id === row.id)
                            return (
                              <button key={row.id} className={styles.card} onClick={() => choose(row)}>
                                <div className={styles.cardHead}>
                                  <span className={styles.cardName}>{row.name}</span>
                                  {configured ? (
                                    <span className={styles.badgeOk}>
                                      <Check size={10} /> connected
                                    </span>
                                  ) : (
                                    g.badge && <span className={styles.badgeSoft}>{g.badge}</span>
                                  )}
                                </div>
                                <div className={styles.cardDetail}>{g.tagline}</div>
                                {state.providerEnvKeys[row.id] && (
                                  <div className={styles.cardEnv}>
                                    <Key size={10} /> {state.providerEnvKeys[row.id]} found
                                  </div>
                                )}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </>
              )}
            </>
          )}

          {step === 'oauth' && (
            <div className={styles.waiting}>
              <span className={styles.spinner} aria-hidden />
              <div>
                <div className={styles.waitingTitle}>Waiting for OpenRouter…</div>
                <div className={styles.muted}>
                  Approve Sketch in the browser tab that just opened. Your key is created in your own OpenRouter account
                  and stored in this computer's credential store.
                </div>
                {authUrl && (
                  <button className={styles.linkBtn} onClick={() => void openExternal(authUrl)}>
                    <ExternalLink size={12} /> Open the sign-in page again
                  </button>
                )}
              </div>
              <button
                className={styles.secondary}
                onClick={() => {
                  if (oauthId.current !== null) void client.oauthCancel?.({ id: oauthId.current })
                  oauthId.current = null
                  setStep('pick')
                }}
              >
                Cancel
              </button>
            </div>
          )}

          {step === 'chatgpt' && (
            <div className={styles.form}>
              {chatgptWait.kind === 'device' ? (
                <div className={styles.deviceBox}>
                  <div className={styles.waitingTitle}>Enter this code on the OpenAI page</div>
                  <div className={styles.muted}>
                    A browser tab opened at {new URL(chatgptWait.verificationUrl).host}. Sign in to ChatGPT there and type
                    this one-time code. Only use it for the sign-in you just started in Sketch.
                  </div>
                  <div className={styles.codeRow}>
                    <code className={styles.userCode} aria-label="Sign-in code">
                      {chatgptWait.userCode}
                    </code>
                    <button
                      className={styles.secondary}
                      onClick={() => {
                        void navigator.clipboard?.writeText(chatgptWait.userCode).then(
                          () => setCopied(true),
                          () => setCopied(false),
                        )
                      }}
                    >
                      {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <button className={styles.linkBtn} onClick={() => void openExternal(chatgptWait.verificationUrl)}>
                    <ExternalLink size={12} /> Open the code page again
                  </button>
                  <div className={styles.waitingInline}>
                    <span className={styles.spinner} aria-hidden /> Waiting for you to approve…
                  </div>
                </div>
              ) : (
                <div className={styles.waiting}>
                  <span className={styles.spinner} aria-hidden />
                  <div>
                    <div className={styles.waitingTitle}>
                      {chatgptWait.kind === 'connecting'
                        ? `Connecting ${chatgptWait.model} and checking that it answers…`
                        : chatgptWait.kind === 'models'
                          ? chatgptAccount !== null
                            ? `${describeAccount(chatgptAccount)} — getting your models…`
                            : 'Getting your ChatGPT models…'
                          : chatgptWait.kind === 'starting'
                            ? 'Opening the ChatGPT sign-in…'
                            : 'Waiting for ChatGPT…'}
                    </div>
                    {chatgptWait.kind === 'connecting' && chatgptAccount !== null && (
                      <div className={styles.muted}>{describeAccount(chatgptAccount)}.</div>
                    )}
                    {chatgptWait.kind === 'browser' && (
                      <>
                        <div className={styles.muted}>
                          Sign in to your ChatGPT account in the browser tab that just opened, then come back here. Sketch never
                          sees your password, and nothing is billed per token — usage counts against your ChatGPT plan.
                        </div>
                        <div className={styles.linkRow}>
                          <button className={styles.linkBtn} onClick={() => void openExternal(chatgptWait.authUrl)}>
                            <ExternalLink size={12} /> Open the sign-in page again
                          </button>
                          <button className={styles.linkBtn} onClick={() => void signInWithChatGPT('device')}>
                            <Key size={12} /> Sign in with a code instead
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
              {chatgptWait.kind !== 'models' && chatgptWait.kind !== 'connecting' && (
                <div className={styles.actions}>
                  <button
                    className={styles.secondary}
                    onClick={() => {
                      cancelChatGPT()
                      setStep('pick')
                    }}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}

          {step === 'credentials' && descriptor && guide && (
            <div className={styles.form}>
              <p className={styles.lead}>{guide.tagline}</p>

              {needsEndpoint && (
                <label className={styles.field}>
                  <span>Endpoint</span>
                  <input
                    className={styles.input}
                    value={baseUrl}
                    placeholder="https://…/v1"
                    onChange={(e) => setBaseUrl(e.target.value)}
                    aria-label="Endpoint"
                  />
                </label>
              )}

              {local ? (
                <div className={styles.muted}>No key or account needed. {guide.localHelp}</div>
              ) : (
                <>
                  {envKeyName && (
                    <label className={styles.check}>
                      <input type="checkbox" checked={useEnvKey} onChange={(e) => setUseEnvKey(e.target.checked)} />
                      Use <code>{envKeyName}</code> from my environment
                    </label>
                  )}
                  {!useEnvKey && (
                    <label className={styles.field}>
                      <span>API key{keyOptional ? ' (leave empty if this endpoint needs none)' : ''}</span>
                      <input
                        className={styles.input}
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        value={apiKey}
                        placeholder={guide.keyHint ?? 'Paste your key'}
                        onChange={(e) => setApiKey(e.target.value)}
                        aria-label={`API key for ${descriptor.name}`}
                      />
                    </label>
                  )}
                  {guide.keyUrl && (
                    <button className={styles.linkBtn} onClick={() => void openExternal(guide.keyUrl!)}>
                      <ExternalLink size={12} /> Get a {descriptor.name} key
                    </button>
                  )}
                  <div className={styles.fine}>
                    The key goes to your operating system's credential store when you finish — never into a settings file,
                    and never to any Sketch server (there is none).
                  </div>
                </>
              )}

              <div className={styles.actions}>
                <button className={styles.secondary} onClick={() => setStep('pick')}>
                  Back
                </button>
                <button
                  className={styles.primary}
                  disabled={busy || baseUrl.trim() === '' || (!keyOptional && !useEnvKey && apiKey.trim() === '')}
                  onClick={() => void listModels(descriptor, baseUrl.trim(), useEnvKey ? '' : apiKey)}
                >
                  {busy ? 'Checking…' : local ? 'Find models' : 'Continue'}
                </button>
              </div>
            </div>
          )}

          {step === 'model' && descriptor && (
            <div className={styles.form}>
              {models.length > 0 ? (
                <>
                  <div className={styles.searchRow}>
                    <Search size={13} />
                    <input
                      className={styles.searchInput}
                      placeholder={`Search ${models.length} models`}
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      aria-label="Search models"
                    />
                  </div>
                  <div className={styles.modelList} role="listbox" aria-label="Models">
                    {filtered.map((m) => {
                      const price = describePrice(m)
                      const ctx = describeContext(m)
                      return (
                        <button
                          key={m.id}
                          role="option"
                          aria-selected={m.id === model}
                          className={`${styles.modelRow} ${m.id === model ? styles.modelSelected : ''}`}
                          onClick={() => setModel(m.id)}
                        >
                          <span className={styles.modelId}>{m.name ?? m.id}</span>
                          {m.name && <span className={styles.modelSub}>{m.id}</span>}
                          <span className={styles.modelMeta}>
                            {m.free && <span className={styles.badgeFree}>free</span>}
                            {!m.free && price && <span>{price}</span>}
                            {ctx && <span>{ctx}</span>}
                          </span>
                        </button>
                      )
                    })}
                    {filtered.length === 0 && <div className={styles.muted}>No model matches “{filter}”.</div>}
                  </div>
                </>
              ) : (
                <div className={styles.muted}>
                  {listing?.code === 'unlisted' ? listing.message : 'Enter the model (or deployment) name to use.'}
                </div>
              )}
              <label className={styles.field}>
                <span>Model</span>
                <input className={styles.input} value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model id" />
              </label>
              <div className={styles.actions}>
                <button
                  className={styles.secondary}
                  onClick={() =>
                    setStep(descriptor.id === CHATGPT_ID || (descriptor.id === 'openrouter' && apiKey !== '') ? 'pick' : 'credentials')
                  }
                >
                  Back
                </button>
                <button className={styles.primary} disabled={busy || model.trim() === ''} onClick={() => void finish()}>
                  {busy ? 'Connecting…' : 'Finish setup'}
                </button>
              </div>
            </div>
          )}

          {step === 'done' && descriptor && (
            <div className={styles.form}>
              <div className={styles.doneHead}>
                <div className={styles.doneIcon}>
                  <Zap size={18} />
                </div>
                <div>
                  <div className={styles.waitingTitle}>
                    Connected to {descriptor.id === CHATGPT_ID ? 'ChatGPT' : descriptor.name} ·{' '}
                    {models.find((m) => m.id === model)?.name ?? model}
                  </div>
                  {doneNote && <div className={styles.muted}>{doneNote}</div>}
                </div>
              </div>
              {testLabel && (
                <div className={testLabel.ok ? styles.testOk : styles.testBad}>
                  {testLabel.ok ? <Check size={13} /> : <AlertCircle size={13} />} {testLabel.text}
                </div>
              )}
              {descriptor.id === CHATGPT_ID && models.length > 1 && (
                <>
                  <label className={styles.field}>
                    <span>Model</span>
                    <select
                      className={styles.input}
                      value={model}
                      aria-label="ChatGPT model"
                      onChange={(e) => switchModel(descriptor, e.target.value)}
                    >
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name ?? m.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  {testLabel === null && (
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={retesting}
                      onClick={() => void retest(descriptor)}
                    >
                      {retesting ? 'Testing…' : 'Test this model'}
                    </button>
                  )}
                </>
              )}
              <div className={styles.group}>
                <div className={styles.groupTitle}>How should Sketch apply code changes?</div>
                <label className={styles.radio}>
                  <input
                    type="radio"
                    name="apply"
                    checked={state.agentPrefs.autoApply}
                    onChange={() => dispatch({ type: 'SET_AGENT_PREFS', payload: { autoApply: true } })}
                  />
                  <span>
                    <strong>Apply automatically</strong> — the agent edits, checks its work, and every run has an Undo button.
                  </span>
                </label>
                <label className={styles.radio}>
                  <input
                    type="radio"
                    name="apply"
                    checked={!state.agentPrefs.autoApply}
                    onChange={() => dispatch({ type: 'SET_AGENT_PREFS', payload: { autoApply: false } })}
                  />
                  <span>
                    <strong>Ask me first</strong> — nothing is written until you accept the proposed changes.
                  </span>
                </label>
              </div>
              <div className={styles.actions}>
                <button className={styles.secondary} onClick={() => { setDescriptor(null); setStep('pick') }}>
                  <Cpu size={12} /> Add another
                </button>
                <button className={styles.primary} onClick={close}>
                  Start coding
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default ConnectWizard
