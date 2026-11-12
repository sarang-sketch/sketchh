// The model picker in the prompt box. Real providers, real models, real status.
//
// WHAT IT SHOWED BEFORE: a hardcoded three-provider list with invented model names,
// costs as dollar signs, an "Anthropic — connected" dot on a machine that had never
// made a request, and a dead "Add Provider" button. None of it came from anywhere.
//
// WHAT IT SHOWS NOW: only providers configured in the KEY-FREE
// `~/.sketch/providers.json`, each with the model actually configured for it, the
// registry's `serverless` flag, and the verdict of the last connection test — where
// "not tested" is its own state and is never drawn as connected (Requirement 27.3).
// The catalog behind the rows is the engine's registry; this file names no provider.
//
// It configures nothing itself. Adding or editing a provider is the Provider
// Settings panel's job, and the footer button opens it rather than pretending.
//
// Validates: Requirements 17.1, 27.1, 27.3, 27.4, 14.6

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check, Search, Settings, Zap } from './Icons';
import { popoverPosition } from './popoverPosition';
import { useAppDispatch, useAppState } from '../state/AppState';
import { describeTest, providerRows } from '../settings/providerRows';
import { useProviderConfig } from '../settings/useProviderConfig';
import { useSketchClient } from '../lib/ClientProvider';
import type { ChatGPTModelInfo } from '../lib/client';
import { CHATGPT_ID } from '../settings/chatgpt';
import styles from './ModelSelector.module.css';

export function ModelSelector() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const client = useSketchClient();
  // Shared with the settings panel, and only when nothing has been read yet, so
  // opening this dropdown cannot discard a connection-test verdict.
  const { loading } = useProviderConfig();

  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState<ReturnType<typeof popoverPosition> | null>(null);
  const id = useId();
  const close = (restoreFocus = false) => { setIsOpen(false); if (restoreFocus) triggerRef.current?.focus(); };

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !dropdownRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  useEffect(() => { setIsOpen(false); }, [state.mode, state.agentView, state.focusMode, state.settingsOpen]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const place = () => {
      if (triggerRef.current) setPosition(popoverPosition(triggerRef.current.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }));
    };
    place();
    const scroll = (event: Event) => { if (!menuRef.current?.contains(event.target as Node)) place(); };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', scroll, true);
    searchRef.current?.focus();
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', scroll, true); };
  }, [isOpen]);

  // Configured providers only: a catalog row with no entry is not something that
  // can be selected, because the engine could not resolve it.
  const rows = providerRows(state.providerCatalog, state.providers).filter(
    (row) => row.entry !== null,
  );
  const active = state.providers.find((p) => p.id === state.selectedProvider) ?? null;
  const activeTest = describeTest(
    active === null ? undefined : state.providerTests[active.id],
  );

  const label = loading
    ? 'Reading providers…'
    : active === null
      ? 'No model configured'
      : `${active.label} · ${state.selectedModel ?? active.model}`;

  const openSettings = () => {
    setIsOpen(false);
    dispatch({ type: 'OPEN_SETTINGS', payload: 'models' });
  };

  const openConnect = () => {
    setIsOpen(false);
    dispatch({ type: 'OPEN_CONNECT' });
  };

  // The choice survives a restart: `selected` in providers.json is the default a new
  // window starts on, and the chosen model becomes that provider's model. Best effort
  // — a failed write leaves this session's choice.
  const choose = (providerId: string, model: string) => {
    dispatch({ type: 'SET_PROVIDER', payload: { provider: providerId, model } });
    close(true);
    const changed = state.providers.some((p) => p.id === providerId && p.model !== model);
    const providers = changed
      ? state.providers.map((p) => (p.id === providerId ? { ...p, model } : p))
      : state.providers;
    void client
      .saveProviderSettings({ settings: { version: 1, providers, selected: providerId } })
      .then((written) => {
        if (changed) {
          dispatch({
            type: 'PROVIDER_SETTINGS_SAVED',
            payload: { providers: written.settings.providers, selected: written.settings.selected, path: written.path },
          });
          dispatch({ type: 'SET_PROVIDER', payload: { provider: providerId, model } });
        }
      })
      .catch(() => {});
  };

  // A ChatGPT account offers several models; list them all, fetched when the menu
  // first opens (a local engine call that reads the account's own catalog).
  const chatgptConfigured = state.providers.some((p) => p.id === CHATGPT_ID);
  const [chatgptModels, setChatgptModels] = useState<ChatGPTModelInfo[] | null>(null);
  useEffect(() => {
    if (!isOpen || !chatgptConfigured || chatgptModels !== null || client.chatgptModels === undefined) return;
    let live = true;
    client
      .chatgptModels()
      .then((result) => {
        if (live && result.ok) setChatgptModels(result.models);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [chatgptConfigured, chatgptModels, client, isOpen]);

  const groups = rows.map((row) => {
    const entry = row.entry!;
    const options = entry.id === CHATGPT_ID && chatgptModels !== null && chatgptModels.length > 0
      ? chatgptModels.map((m) => ({ id: m.id, name: m.name, hint: m.description }))
      : [{ id: entry.model, name: entry.model, hint: undefined as string | undefined }];
    return { row, options: options.filter((option) => `${entry.label} ${option.name} ${option.id}`.toLowerCase().includes(query.trim().toLowerCase())) };
  }).filter((group) => group.options.length > 0);

  return (
    <div className={styles.container} ref={dropdownRef}>
      <button
        type="button"
        ref={triggerRef}
        className={styles.triggerBtn}
        onClick={() => { setQuery(''); setIsOpen(!isOpen); }}
        onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setQuery(''); setIsOpen(true); } }}
        aria-haspopup="dialog"
        aria-controls={isOpen ? id : undefined}
        aria-expanded={isOpen}
        title={active === null ? 'No provider is configured' : activeTest.detail}
      >
        {/* The dot is the last test verdict, not a decoration. Untested is grey. */}
        <div className={`${styles.statusDot} ${styles[activeTest.tone]}`} />
        <span className={styles.selectedName}>{label}</span>
        <ChevronDown size={14} className={styles.chevron} />
      </button>

      {isOpen && createPortal(
        <div id={id} ref={menuRef} className={styles.dropdown} role="dialog" aria-label="Choose a model" data-placement={position?.placement}
          style={{ left: position?.left, top: position?.top, bottom: position?.bottom, width: position?.width, maxHeight: position?.maxHeight, visibility: position ? 'visible' : 'hidden' }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
            const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
            const at = options.indexOf(document.activeElement as HTMLButtonElement);
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && options.length && (at >= 0 || event.key.startsWith('Arrow'))) {
              event.preventDefault();
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
              options[next]?.focus();
            }
            if (event.key === 'Tab') {
              const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input,button'));
              if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); close(true); }
              else if (!event.shiftKey && document.activeElement === controls.at(-1)) close(true);
            }
          }}>
          <div className={styles.search}><Search size={14} /><input ref={searchRef} aria-label="Search models" placeholder="Search your models…" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          <div className={styles.dropdownContent} role="listbox" aria-label="Models">
            {rows.length === 0 ? (
              <div className={styles.notConnected}>
                No model is connected yet.
                <button className={styles.addProviderBtn} onClick={openConnect} style={{ marginTop: 8 }}>
                  <Zap size={14} />
                  Connect a model
                </button>
              </div>
            ) : (
              groups.map(({ row, options }) => {
                const entry = row.entry!;
                const summary = describeTest(state.providerTests[entry.id]);
                const chosen = state.selectedProvider === entry.id;
                const activeModel = chosen ? (state.selectedModel ?? entry.model) : entry.model;
                return (
                  <div key={entry.id} className={styles.providerGroup} role="group" aria-label={entry.label}>
                    <div className={styles.providerHeader}>
                      <div className={`${styles.providerDot} ${styles[summary.tone]}`} />
                      <span>{entry.label}</span>
                      {row.descriptor.serverless && (
                        <span className={styles.badge} title="Serverless inference endpoint">
                          <Zap size={9} /> serverless
                        </span>
                      )}
                    </div>
                    {options.map((option) => {
                      const selected = chosen && activeModel === option.id;
                      return (
                        <button
                          type="button"
                          tabIndex={selected ? 0 : -1}
                          key={option.id}
                          className={`${styles.modelItem} ${selected ? styles.selected : ''}`}
                          role="option"
                          aria-selected={selected}
                          title={option.hint}
                          onClick={() => choose(entry.id, option.id)}
                        >
                          <div className={styles.modelMain}>
                            {selected && <Check size={14} className={styles.checkIcon} />}
                            <span
                              className={styles.modelName}
                              style={{ marginLeft: selected ? 0 : 22 }}
                            >
                              {option.name}
                            </span>
                          </div>
                          <div className={styles.modelMeta}>
                            <span className={styles.cost}>{option.id === entry.model ? summary.label : ''}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                );
              })
            )}
            {rows.length > 0 && groups.length === 0 && <div className={styles.notConnected}>No matching models. Try a provider or model name.</div>}
          </div>

          <div className={styles.dropdownFooter}>
            {rows.length > 0 && (
              <button className={styles.addProviderBtn} onClick={openConnect}>
                <Zap size={14} />
                Connect another model
              </button>
            )}
            <button className={styles.addProviderBtn} onClick={openSettings}>
              <Settings size={14} />
              Model settings
            </button>
          </div>
        </div>, document.body
      )}
    </div>
  );
}

export default ModelSelector;
