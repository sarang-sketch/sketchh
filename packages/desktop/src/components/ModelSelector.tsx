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

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check, Settings, Zap } from './Icons';
import { useAppDispatch, useAppState } from '../state/AppState';
import { describeTest, providerRows } from '../settings/providerRows';
import { useProviderConfig } from '../settings/useProviderConfig';
import styles from './ModelSelector.module.css';

export function ModelSelector() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  // Shared with the settings panel, and only when nothing has been read yet, so
  // opening this dropdown cannot discard a connection-test verdict.
  const { loading } = useProviderConfig();

  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

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
    dispatch({ type: 'SET_ACTIVE_PANEL', payload: 'settings' });
  };

  return (
    <div className={styles.container} ref={dropdownRef}>
      <button
        className={styles.triggerBtn}
        onClick={() => setIsOpen(!isOpen)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        title={active === null ? 'No provider is configured' : activeTest.detail}
      >
        {/* The dot is the last test verdict, not a decoration. Untested is grey. */}
        <div className={`${styles.statusDot} ${styles[activeTest.tone]}`} />
        <span className={styles.selectedName}>{label}</span>
        <ChevronDown size={14} className={styles.chevron} />
      </button>

      {isOpen && (
        <div className={styles.dropdown}>
          <div className={styles.dropdownContent} role="listbox">
            {rows.length === 0 ? (
              <div className={styles.notConnected}>
                No provider is configured, so no model can be called.
              </div>
            ) : (
              rows.map((row) => {
                const entry = row.entry!;
                const summary = describeTest(state.providerTests[entry.id]);
                const chosen = state.selectedProvider === entry.id;
                return (
                  <div key={entry.id} className={styles.providerGroup}>
                    <div className={styles.providerHeader}>
                      <div className={`${styles.providerDot} ${styles[summary.tone]}`} />
                      <span>{entry.label}</span>
                      {row.descriptor.serverless && (
                        <span className={styles.badge} title="Serverless inference endpoint">
                          <Zap size={9} /> serverless
                        </span>
                      )}
                    </div>
                    <div
                      className={`${styles.modelItem} ${chosen ? styles.selected : ''}`}
                      role="option"
                      aria-selected={chosen}
                      onClick={() => {
                        dispatch({
                          type: 'SET_PROVIDER',
                          payload: { provider: entry.id, model: entry.model },
                        });
                        setIsOpen(false);
                      }}
                    >
                      <div className={styles.modelMain}>
                        {chosen && <Check size={14} className={styles.checkIcon} />}
                        <span
                          className={styles.modelName}
                          style={{ marginLeft: chosen ? 0 : 22 }}
                        >
                          {entry.model}
                        </span>
                      </div>
                      <div className={styles.modelMeta}>
                        <span className={styles.cost}>{summary.label}</span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className={styles.dropdownFooter}>
            <button className={styles.addProviderBtn} onClick={openSettings}>
              <Settings size={14} />
              Provider settings
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default ModelSelector;
