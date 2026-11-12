// Provider Settings — the real surface (Requirements 17.1, 17.2, 27.1).
//
// WHAT IT LISTS: the engine's own provider registry (`PROVIDER_CATALOG` in
// packages/core/src/providers/registry.ts), fetched over the client seam. Not a list
// retyped in the UI — if a provider is added to the registry it appears here with no
// change to this file. The `serverless` flag from the registry is surfaced, because
// it changes the cost and latency story.
//
// WHAT IT SAVES: five non-secret fields per provider, to `~/.sketch/providers.json`.
// NO API KEY IS PERSISTED THERE, EVER (Requirement 17.2). The key box is local
// component state: it is never dispatched into AppState and never included in a save
// payload.
//
// WHERE A KEY GOES INSTEAD: the operating system's credential store, through the
// `KeyStore` seam (settings/keyStore.ts → Rust → Credential Manager / Keychain /
// Secret Service). The panel can save a key, see WHETHER one is stored, and remove it.
// It cannot read one back, because no command exists that returns a key value — so a
// connection test needs the key typed for that test, and the panel says so rather than
// pretending it remembered (Requirements 17.3, 17.4).
//
// THE CONNECTION TEST IS A REAL NETWORK CALL, so:
//   * it runs on an explicit click and NEVER on mount — the only thing that happens
//     automatically is reading the registry and the local config file;
//   * it is cancellable, with an AbortController per test;
//   * a stale response is discarded by test id, so an old verdict cannot overwrite a
//     newer one.
//
// THREE HONEST NOTHINGS: nothing configured; configured but never tested; tested and
// failed, with the specific reason (unreachable host / rejected key / unknown model),
// never a single generic "connection failed" (Requirements 27.3, 27.5).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, Plus, Refresh, Server, Zap } from '../components/Icons';
import { useSketchClient } from '../lib/ClientProvider';
import { useAppDispatch, useAppState } from '../state/AppState';
import type { ProviderSettingsEntry } from '../lib/contracts';
import {
  describeTest,
  draftBlocker,
  draftFor,
  entryFromDraft,
  isLocalEndpoint,
  keyRequired,
  previewEndpoint,
  providerRows,
  refusedEntries,
  stateFromResult,
  type ProviderDraft,
} from '../settings/providerRows';
import { useKeyStore } from '../settings/KeyStoreProvider';
import { useProviderConfig } from '../settings/useProviderConfig';
import { resolveApiKeyForRun } from '../lib/secrets';
import type { ChatGPTStatus } from '../lib/client';
import { CHATGPT_ID, describeAccount } from '../settings/chatgpt';
import {
  describeKeyFailure,
  describeKeyState,
  readKeyStates,
  type KeyState,
} from '../settings/keyStore';
import styles from './ProviderSettings.module.css';

/** Test ceiling. Long enough for a cold local model list, short enough to bail. */
const TEST_TIMEOUT_MS = 5000;
/** A ChatGPT test is one real reply from a reasoning model. */
const CHATGPT_TEST_TIMEOUT_MS = 45_000;

export function ProviderSettings() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const client = useSketchClient();
  const keyStore = useKeyStore();

  /**
   * Whether a ChatGPT account is signed in, and as whom. A local file read in the
   * engine — never a token, never a network call.
   */
  const [chatgpt, setChatgpt] = useState<ChatGPTStatus | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const refreshChatgpt = useCallback(async () => {
    if (client.chatgptStatus === undefined) return;
    try {
      setChatgpt(await client.chatgptStatus());
    } catch {
      setChatgpt(null);
    }
  }, [client]);
  useEffect(() => {
    void refreshChatgpt();
  }, [refreshChatgpt, state.providers]);

  // The read lives in `useProviderConfig` because the model picker needs the same
  // one. Loading on mount is a file read, not a network call.
  const { loading, reload } = useProviderConfig();
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  /** Catalog row being edited; separate because a custom draft has an editable id. */
  const [editingId, setEditingId] = useState<string | null>(null);
  /**
   * The key currently in the box. Local, transient, never put in AppState and never
   * part of a `providers.json` payload. It goes exactly two places: into a connection
   * test for that one call, and — if the user asks — into the OS credential store.
   * Cleared as soon as either settles.
   */
  const [testKey, setTestKey] = useState('');
  const [saving, setSaving] = useState(false);
  /**
   * Per-provider key presence, as the OS credential store reported it. NOT keys —
   * `KeyState` has no field that could hold one (settings/keyStore.ts).
   */
  const [keyStates, setKeyStates] = useState<Record<string, KeyState>>({});

  /** One controller per in-flight test, so Cancel has something to abort. */
  const inFlight = useRef<Map<string, AbortController>>(new Map());

  // Abort anything still running when the panel goes away.
  useEffect(
    () => () => {
      for (const controller of inFlight.current.values()) controller.abort();
      inFlight.current.clear();
    },
    [],
  );

  const rows = useMemo(
    () => providerRows(state.providerCatalog, state.providers),
    [state.providerCatalog, state.providers],
  );

  /** The ids to ask the credential store about. Sorted and joined so the effect below
   * re-runs when the SET changes rather than on every render. */
  const keyIds = useMemo(
    () => rows.map((row) => row.descriptor.id).sort().join(','),
    [rows],
  );

  /**
   * Read key PRESENCE for the rows on screen. This is a local call to the OS
   * credential store, not a network call, so it may happen on mount — the rule the
   * connection test obeys (nothing automatic ever leaves the machine) is not weakened
   * by asking the local keychain whether a key exists.
   */
  useEffect(() => {
    if (keyIds === '') return;
    let live = true;
    void readKeyStates(keyStore, keyIds.split(',')).then((states) => {
      if (live) setKeyStates(states);
    });
    return () => {
      live = false;
    };
  }, [keyIds, keyStore]);

  const saveKey = useCallback(
    async (providerId: string, apiKey: string) => {
      const value = apiKey.trim();
      if (value === '') return;
      setKeyStates((current) => ({ ...current, [providerId]: { status: 'saving' } }));
      try {
        const store = await keyStore.save(providerId, value);
        setKeyStates((current) => ({ ...current, [providerId]: { status: 'stored', store } }));
        // The key has been handed to the OS. This window keeps no copy of it.
        setTestKey('');
      } catch (err) {
        const reason = describeKeyFailure('save', providerId, err);
        setKeyStates((current) => ({ ...current, [providerId]: { status: 'unknown', reason } }));
        dispatch({ type: 'PROVIDER_SETTINGS_NOTICE', payload: reason });
      }
    },
    [dispatch, keyStore],
  );

  const removeKey = useCallback(
    async (providerId: string) => {
      setKeyStates((current) => ({ ...current, [providerId]: { status: 'removing' } }));
      try {
        const store = await keyStore.remove(providerId);
        setKeyStates((current) => ({ ...current, [providerId]: { status: 'absent', store } }));
      } catch (err) {
        const reason = describeKeyFailure('remove', providerId, err);
        setKeyStates((current) => ({ ...current, [providerId]: { status: 'unknown', reason } }));
        dispatch({ type: 'PROVIDER_SETTINGS_NOTICE', payload: reason });
      }
    },
    [dispatch, keyStore],
  );

  const persist = useCallback(
    async (providers: ProviderSettingsEntry[], selected: string | null) => {
      setSaving(true);
      try {
        const written = await client.saveProviderSettings({
          settings: { version: 1, providers, selected },
        });
        dispatch({
          type: 'PROVIDER_SETTINGS_SAVED',
          payload: {
            providers: written.settings.providers,
            selected: written.settings.selected,
            path: written.path,
          },
        });
        // The engine is the authority on what is savable. Anything it dropped is
        // reported rather than silently disappearing from the form.
        const refused = refusedEntries(providers, written.settings.providers);
        if (refused.length > 0) {
          dispatch({
            type: 'PROVIDER_SETTINGS_NOTICE',
            payload: `The engine refused this configuration: ${refused.join(', ')}. Check the endpoint URL and the model name.`,
          });
        } else {
          setDraft(null);
          setEditingId(null);
        }
      } catch (err) {
        dispatch({
          type: 'PROVIDER_SETTINGS_NOTICE',
          payload: `Provider settings were not saved: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      } finally {
        setSaving(false);
      }
    },
    [client, dispatch],
  );

  const saveDraft = useCallback(async () => {
    if (draft === null) return;
    if (draftBlocker(draft) !== null) return;
    const entry = entryFromDraft(draft);
    const originalId = editingId ?? entry.id;
    const others = state.providers.filter((p) => p.id !== originalId && p.id !== entry.id);
    const selected = state.selectedProvider === originalId
      ? entry.id
      : (state.selectedProvider ?? entry.id);
    await persist([...others, entry], selected);
  }, [draft, editingId, persist, state.providers, state.selectedProvider]);

  const removeProvider = useCallback(
    async (id: string) => {
      const remaining = state.providers.filter((p) => p.id !== id);
      await persist(remaining, state.selectedProvider === id ? null : state.selectedProvider);
    },
    [persist, state.providers, state.selectedProvider],
  );

  /** Sign out of ChatGPT: the engine revokes and forgets the sign-in, then the entry goes. */
  const signOutChatgpt = useCallback(async () => {
    setSigningOut(true);
    try {
      await client.chatgptLogout?.();
    } catch (err) {
      dispatch({
        type: 'PROVIDER_SETTINGS_NOTICE',
        payload: `Could not sign out of ChatGPT: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setSigningOut(false);
    }
    if (state.providers.some((p) => p.id === CHATGPT_ID)) await removeProvider(CHATGPT_ID);
    await refreshChatgpt();
  }, [client, dispatch, refreshChatgpt, removeProvider, state.providers]);

  const runTest = useCallback(
    async (entry: ProviderSettingsEntry, apiKey: string) => {
      const previous = inFlight.current.get(entry.id);
      if (previous) previous.abort();
      const controller = new AbortController();
      inFlight.current.set(entry.id, controller);

      dispatch({ type: 'PROVIDER_TEST_STARTED', payload: entry.id });
      try {
        // A typed key is tested as typed. With the box empty, the test uses the key the
        // OS credential store holds — the same one a run will use — instead of making
        // the user paste it again. No stored key: the engine falls back to the
        // provider's environment variable, if one is set.
        const typed = apiKey.trim();
        const stored = typed === '' ? await resolveApiKeyForRun(entry.id) : null;
        const key = typed !== '' ? typed : stored ?? '';
        const result = await client.testProvider(
          {
            provider: {
              id: entry.id,
              kind: entry.kind,
              baseUrl: entry.baseUrl,
              model: entry.model,
              // Supplied for this call only. Nothing persists it.
              ...(key === '' ? {} : { apiKey: key }),
            },
            // A ChatGPT account is tested with one real (tiny) reply, which takes longer
            // than listing a local server's models.
            timeoutMs: entry.id === CHATGPT_ID ? CHATGPT_TEST_TIMEOUT_MS : TEST_TIMEOUT_MS,
          },
          { signal: controller.signal },
        );
        // A response for a test that has since been superseded is dropped.
        if (inFlight.current.get(entry.id) !== controller) return;
        dispatch({
          type: 'PROVIDER_TEST_SETTLED',
          payload: { id: entry.id, state: stateFromResult(result, Date.now()) },
        });
      } catch (err) {
        if (inFlight.current.get(entry.id) !== controller) return;
        const cancelled = err instanceof Error && err.name === 'AbortError';
        dispatch({
          type: 'PROVIDER_TEST_SETTLED',
          payload: {
            id: entry.id,
            state: cancelled
              ? { status: 'cancelled', at: Date.now() }
              : {
                  status: 'failed',
                  code: 'endpoint-error',
                  message: `The test could not be run: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                  at: Date.now(),
                },
          },
        });
      } finally {
        if (inFlight.current.get(entry.id) === controller) inFlight.current.delete(entry.id);
        setTestKey('');
      }
    },
    [client, dispatch],
  );

  const cancelTest = useCallback((id: string) => {
    inFlight.current.get(id)?.abort();
  }, []);

  const configuredCount = state.providers.length;

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <span className={styles.toolbarTitle}>Providers</span>
        <button
          className={styles.iconBtn}
          onClick={() => void reload()}
          aria-label="Reload provider settings"
          title="Reload provider settings"
        >
          <Refresh size={14} />
        </button>
      </div>

      {state.providerSettingsNotice && (
        <div className={styles.notice} role="alert">
          <AlertCircle size={13} />
          <span>{state.providerSettingsNotice}</span>
        </div>
      )}

      {loading ? (
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>Reading providers…</div>
        </div>
      ) : (
        <>
          {configuredCount === 0 && (
            <div className={styles.empty}>
              <div className={styles.emptyTitle}>No provider configured</div>
              <div className={styles.emptyDetail}>
                Nothing has been set up yet, so no model can be called. Add one below — a local
                Ollama or llama.cpp endpoint needs no key and no account.
              </div>
            </div>
          )}

          <div className={styles.list}>
            {rows.map((row) => {
              const summary = describeTest(state.providerTests[row.descriptor.id]);
              const entry = row.entry;
              const editing = draft !== null && editingId === row.descriptor.id;
              // Deployment metadata is the registry's, and the $0-local claim is
              // read off the endpoint that will actually be called. Neither is
              // stored in providers.json, so neither can go stale there.
              const effectiveUrl = entry?.baseUrl ?? row.descriptor.defaultBaseUrl;
              const isServerless = row.descriptor.serverless;
              const isLocal = isLocalEndpoint(effectiveUrl);
              const needsKey = keyRequired(row.descriptor, effectiveUrl);
              const toggleDraft = () => {
                if (editing) {
                  setDraft(null);
                  setEditingId(null);
                } else {
                  setDraft(draftFor(row.descriptor, entry));
                  setEditingId(row.descriptor.id);
                }
              };
              return (
                <div key={row.descriptor.id} className={styles.row} data-provider={row.descriptor.id}>
                  <div className={styles.rowHead}>
                    <span className={styles.name}>{row.descriptor.name}</span>
                    {isServerless && (
                      <span className={styles.tag} title="Serverless inference endpoint: per-token cost, cold starts">
                        <Zap size={10} /> serverless
                      </span>
                    )}
                    {/* A connection status belongs only to a row that HAS a
                        connection to describe. An unconfigured provider is not
                        "untested", it is unconfigured, and the row says that
                        below (Requirement 27.3). */}
                    {row.descriptor.id === CHATGPT_ID ? (
                      <span className={styles.tagQuiet} title="Signs in with a ChatGPT account; no API key, no per-token bill">
                        ChatGPT account
                      </span>
                    ) : isLocal ? (
                      <span
                        className={styles.tagQuiet}
                        title="The endpoint is on this machine: no account, no key, no provider spend"
                      >
                        $0 local
                      </span>
                    ) : (
                      !needsKey && (
                        <span className={styles.tagQuiet} title="Accepts unauthenticated requests">
                          no key needed
                        </span>
                      )
                    )}
                    {entry && (
                      <span className={`${styles.status} ${styles[summary.tone]}`}>
                        {summary.label}
                      </span>
                    )}
                  </div>

                  {entry ? (
                    <>
                      <div className={styles.meta}>
                        <span className={styles.metaUrl}>{entry.baseUrl}</span>
                        <span className={styles.metaModel}>{entry.model}</span>
                      </div>
                      <div className={styles.detail}>{summary.detail}</div>
                      {entry.id === CHATGPT_ID && chatgpt !== null && (
                        <div className={styles.detail}>
                          {chatgpt.signedIn
                            ? `${describeAccount(chatgpt)}. Renewed automatically; usage counts against your ChatGPT plan.`
                            : chatgpt.needsSignIn
                              ? 'Your ChatGPT sign-in has ended. Sign in again to keep using it.'
                              : 'Not signed in to ChatGPT on this computer.'}
                        </div>
                      )}
                      {state.providerEnvKeys[entry.id] && (
                        <div className={styles.detail}>
                          A key is also available from the environment ({state.providerEnvKeys[entry.id]}); it is used when no key is stored.
                        </div>
                      )}
                      <div className={styles.actions}>
                        <button
                          className={styles.actionBtn}
                          onClick={() => dispatch({ type: 'OPEN_CONNECT', payload: entry.id })}
                        >
                          Change model
                        </button>
                        {summary.tone === 'busy' ? (
                          <button
                            className={styles.actionBtn}
                            onClick={() => cancelTest(entry.id)}
                          >
                            Cancel test
                          </button>
                        ) : (
                          <button
                            className={styles.actionBtn}
                            onClick={() => void runTest(entry, testKey)}
                          >
                            Test connection
                          </button>
                        )}
                        {entry.id === CHATGPT_ID ? (
                          <>
                            {chatgpt !== null && !chatgpt.signedIn && (
                              <button
                                className={styles.actionBtn}
                                onClick={() => dispatch({ type: 'OPEN_CONNECT', payload: CHATGPT_ID })}
                              >
                                Sign in again
                              </button>
                            )}
                            <button
                              className={styles.actionBtn}
                              onClick={() => void signOutChatgpt()}
                              disabled={saving || signingOut}
                            >
                              {signingOut ? 'Signing out…' : 'Sign out'}
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className={styles.actionBtn}
                              onClick={toggleDraft}
                            >
                              {editing ? 'Close' : 'Edit'}
                            </button>
                            <button
                              className={styles.actionBtn}
                              onClick={() => void removeProvider(entry.id)}
                              disabled={saving}
                            >
                              Remove
                            </button>
                          </>
                        )}
                        {state.selectedProvider === entry.id ? (
                          <span className={styles.selected}>
                            <Check size={12} /> default
                          </span>
                        ) : (
                          <button
                            className={styles.actionBtn}
                            onClick={() => {
                              dispatch({
                                type: 'SET_PROVIDER',
                                payload: { provider: entry.id, model: entry.model },
                              });
                              // Remembered in providers.json, so the next window starts here.
                              void persist(state.providers, entry.id);
                            }}
                          >
                            Use by default
                          </button>
                        )}
                      </div>
                    </>
                  ) : row.descriptor.id === CHATGPT_ID ? (
                    <div className={styles.actions}>
                      <span className={styles.unconfigured}>
                        {chatgpt?.signedIn ? describeAccount(chatgpt) : 'Not signed in'}
                      </span>
                      <button
                        className={styles.actionBtn}
                        aria-label={`Add ${row.descriptor.name}`}
                        onClick={() => dispatch({ type: 'OPEN_CONNECT', payload: CHATGPT_ID })}
                      >
                        <Plus size={12} /> {chatgpt?.signedIn ? 'Connect' : 'Sign in with ChatGPT'}
                      </button>
                      {chatgpt?.signedIn && (
                        <button className={styles.actionBtn} onClick={() => void signOutChatgpt()} disabled={signingOut}>
                          Sign out
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className={styles.actions}>
                      <span className={styles.unconfigured}>Not configured</span>
                      <button
                        className={styles.actionBtn}
                        // The visible word is just "Add"; every row has one, so the
                        // accessible name has to carry which provider it adds.
                        aria-label={`${editing ? 'Close' : 'Add'} ${row.descriptor.name}`}
                        onClick={toggleDraft}
                      >
                        <Plus size={12} /> {editing ? 'Close' : 'Add'}
                      </button>
                    </div>
                  )}

                  {editing && draft && (
                    <ProviderForm
                      draft={draft}
                      // Read off the endpoint as it is typed, so a custom row
                      // pointed at a hosted service gets a key box for its test.
                      needsKey={keyRequired(row.descriptor, draft.baseUrl)}
                      saving={saving}
                      testKey={testKey}
                      keyState={keyStates[row.descriptor.id]}
                      onTestKey={setTestKey}
                      onSaveKey={() => void saveKey(row.descriptor.id, testKey)}
                      onRemoveKey={() => void removeKey(row.descriptor.id)}
                      onChange={setDraft}
                      onSave={() => void saveDraft()}
                    />
                  )}
                </div>
              );
            })}
          </div>

          <div className={styles.footer}>
            <div className={styles.footerLine}>
              <Server size={12} />
              <span>
                {state.providerSettingsPath
                  ? `Configuration: ${state.providerSettingsPath}`
                  : 'Configuration file not located yet'}
              </span>
            </div>
            <div className={styles.footerNote}>
              This file holds the endpoint and model only. API keys are never written to it: a saved
              key lives in the operating system credential store, and is supplied to a request one
              call at a time.
            </div>
          </div>
        </>
      )}
    </div>
  );
}

interface FormProps {
  draft: ProviderDraft;
  needsKey: boolean;
  saving: boolean;
  testKey: string;
  /** What the OS credential store said. Undefined until it has been asked. */
  keyState: KeyState | undefined;
  onTestKey: (value: string) => void;
  onSaveKey: () => void;
  onRemoveKey: () => void;
  onChange: (draft: ProviderDraft) => void;
  onSave: () => void;
}

/** The add/edit form. The endpoint preview shows the URL that will be called. */
function ProviderForm({
  draft,
  needsKey,
  saving,
  testKey,
  keyState,
  onTestKey,
  onSaveKey,
  onRemoveKey,
  onChange,
  onSave,
}: FormProps) {
  const endpoint = previewEndpoint(draft.baseUrl);
  const blocker = draftBlocker(draft);
  /** A store operation is in flight: both key buttons wait for it. */
  const busyKey = keyState?.status === 'saving' || keyState?.status === 'removing';

  return (
    <div className={styles.form}>
      <label className={styles.field}>
        <span>Endpoint</span>
        <input
          className={styles.input}
          value={draft.baseUrl}
          placeholder="http://localhost:11434/v1"
          aria-label={`Endpoint for ${draft.id}`}
          onChange={(e) => onChange({ ...draft, baseUrl: e.target.value })}
        />
      </label>
      <div className={endpoint.ok ? styles.resolved : styles.resolvedBad}>
        {endpoint.ok ? `Will call ${endpoint.resolvedUrl}` : endpoint.reason}
      </div>

      <label className={styles.field}>
        <span>Model</span>
        <input
          className={styles.input}
          value={draft.model}
          placeholder="llama3"
          aria-label={`Model for ${draft.id}`}
          onChange={(e) => onChange({ ...draft, model: e.target.value })}
        />
      </label>

      <label className={styles.field}>
        <span>Label</span>
        <input
          className={styles.input}
          value={draft.label}
          aria-label={`Label for ${draft.id}`}
          onChange={(e) => onChange({ ...draft, label: e.target.value })}
        />
      </label>

      {needsKey && (
        <label className={styles.field}>
          <span>API key</span>
          <input
            className={styles.input}
            type="password"
            value={testKey}
            aria-label={`API key for ${draft.id}`}
            placeholder="used for the next request, and saved only if you ask"
            onChange={(e) => onTestKey(e.target.value)}
          />
        </label>
      )}
      {needsKey && (
        <>
          <div className={styles.actions}>
            <button
              className={styles.actionBtn}
              aria-label={`Save the API key for ${draft.id} to the operating system credential store`}
              disabled={testKey.trim() === '' || busyKey}
              onClick={onSaveKey}
            >
              Save key to OS store
            </button>
            {keyState?.status === 'stored' && (
              <button
                className={styles.actionBtn}
                aria-label={`Remove the stored API key for ${draft.id}`}
                disabled={busyKey}
                onClick={onRemoveKey}
              >
                Remove stored key
              </button>
            )}
          </div>
          {/* One sentence about the store, and it never claims more than the store
              said. `unknown` stays `unknown` — see settings/keyStore.ts. */}
          <div className={styles.keyNote}>{describeKeyState(keyState)}</div>
          <div className={styles.keyNote}>
            The key is never written to providers.json. Saving puts it in the operating
            system credential store, and nothing reads it back into this window.
          </div>
        </>
      )}

      <div className={styles.formActions}>
        <button className={styles.saveBtn} onClick={onSave} disabled={blocker !== null || saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {/* Said once. When the blocker IS the endpoint problem, the line under the
            endpoint box already says it, and repeating it verbatim reads like two
            different problems. */}
        {blocker !== null && blocker !== endpoint.reason && (
          <span className={styles.blocker}>{blocker}</span>
        )}
      </div>
    </div>
  );
}

export default ProviderSettings;
