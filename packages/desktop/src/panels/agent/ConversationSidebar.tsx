import { useMemo, useRef, useState } from 'react';
import { useAppState, useAppDispatch } from '../../state/AppState';
import type { AppState } from '../../state/AppState';
import {
  Plus, Folder, FileText, Puzzle, Settings, Activity, MessageSquare, Search, Trash, X, Key, Pencil, Copy, Layers, Server, Database, ChevronDown, Download, Upload
} from '../../components/Icons';
import { conversationToMarkdown } from '../../conversationMarkdown';
import { conversationToJson, parseImportedConversation } from '../../conversationImport';
import { getExtras, listArchivedConversations, orderConversations } from '../../state/conversationExtras';
import { isComposing } from '../../lib/keys';
import { useOptionalAgentSession } from '../../lib/AgentSession';
import { isActivationKey } from '../../lib/keys';
import { useFileActions } from '../../editor/useFileActions';
import { canonicalPath, basename } from '../../editor/paths';
import { SketchMark } from '../../components/SketchMark';
import { useConfirm } from '../../components/ConfirmDialog';
import styles from './ConversationSidebar.module.css';

/** "now", "5m", "3h", "2d", or a date — for the Recents list. */
function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const ConversationSidebar: React.FC = () => {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const session = useOptionalAgentSession();
  const fileActions = useFileActions();
  const confirm = useConfirm();
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState('');

  // Deleting a conversation cannot be undone, so it goes behind a clear destructive
  // confirmation (ConfirmDialog, danger button) rather than removing on the first click.
  const deleteConversation = async (c: AppState['conversations'][number]) => {
    const choice = await confirm({
      title: 'Delete this conversation?',
      message: `"${c.title}" and its messages will be removed. This cannot be undone.`,
      buttons: [
        { id: 'delete', label: 'Delete', kind: 'danger' },
        { id: 'cancel', label: 'Cancel', kind: 'secondary' },
      ],
      cancelId: 'cancel',
    });
    if (choice === 'delete') dispatch({ type: 'DELETE_CONVERSATION', payload: c.id });
  };

  // Copy the conversation as a Markdown transcript to the clipboard (W9 invariant 8a).
  // A real, key-free export using the clipboard — no native file permission, no new dep.
  // It only reads the conversation; it never changes selection, the root, or the title.
  const [copied, setCopied] = useState<string | null>(null);
  const copyAsMarkdown = async (c: AppState['conversations'][number]) => {
    const md = conversationToMarkdown(c);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(md);
      } else {
        throw new Error('clipboard unavailable');
      }
      setCopied(c.id);
      window.setTimeout(() => setCopied((id) => (id === c.id ? null : id)), 1600);
    } catch {
      // No clipboard access (e.g. an insecure context): tell the user plainly rather
      // than failing silently. The editor notice is the window's shared info channel.
      dispatch({
        type: 'SET_EDITOR_NOTICE',
        payload: { level: 'error', message: 'Could not copy to the clipboard. Your browser or window blocked clipboard access.' },
      });
    }
  };

  // Download the conversation as a file (Markdown or JSON), not just to the
  // clipboard: the JSON file is what "Import chat" reads back. A blob download
  // needs no native file permission and no new dependency.
  const downloadConversation = (c: AppState['conversations'][number], format: 'md' | 'json') => {
    const slug = c.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'conversation';
    const text = format === 'md' ? conversationToMarkdown(c) : conversationToJson(c);
    const blob = new Blob([text], { type: format === 'md' ? 'text/markdown' : 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug}.${format}`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Import a conversation from a JSON export file. The file is read locally and
  // parsed with the same validator the export writes; an invalid file is reported
  // in the editor notice rather than half-imported.
  const importRef = useRef<HTMLInputElement | null>(null);
  const importConversation = async (file: File) => {
    try {
      const parsed = parseImportedConversation(JSON.parse(await file.text()));
      if (!parsed.ok) {
        dispatch({ type: 'SET_EDITOR_NOTICE', payload: { level: 'error', message: `Could not import that chat: ${parsed.reason}` } });
        return;
      }
      dispatch({ type: 'IMPORT_CONVERSATION', payload: parsed.conversation });
      dispatch({ type: 'SET_AGENT_VIEW', payload: 'new_task' });
    } catch {
      dispatch({ type: 'SET_EDITOR_NOTICE', payload: { level: 'error', message: 'Could not import that chat: the file is not valid JSON.' } });
    }
  };
  // also blur the field, so a synchronously-updated ref (`editRef`) records whether the
  // edit is still open and whether it was cancelled, so the follow-on blur commits exactly
  // once (Enter) or not at all (Escape). React state alone would lag the blur that fires in
  // the same tick.
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const editRef = useRef<{ id: string; cancelled: boolean } | null>(null);

  const beginRename = (c: AppState['conversations'][number]) => {
    editRef.current = { id: c.id, cancelled: false };
    setEditing({ id: c.id, value: c.title });
  };

  const commitRename = () => {
    const open = editRef.current;
    editRef.current = null; // close first, so a same-tick blur is a no-op
    if (open === null || open.cancelled) {
      setEditing(null);
      return;
    }
    const value = editing?.value ?? '';
    if (editing !== null) dispatch({ type: 'RENAME_CONVERSATION', payload: { id: editing.id, title: value } });
    setEditing(null);
  };

  const cancelRename = () => {
    if (editRef.current !== null) editRef.current = { ...editRef.current, cancelled: true };
    setEditing(null);
  };

  const handleViewSelect = (view: AppState['agentView']) => {
    dispatch({ type: 'SET_AGENT_VIEW', payload: view });
  };

  const handleNewTask = () => {
    dispatch({ type: 'SET_AGENT_VIEW', payload: 'new_task' });
    dispatch({ type: 'NEW_CONVERSATION' });
  };

  // Click and keyboard open a conversation the same way.
  //
  // Selecting a conversation is NOT an "open folder" action, so it NEVER moves the
  // workspace root (the editor / explorer / command_policy boundary). The root changes
  // only by an explicit Open Folder / recent / confirmed prompt (Req 15.6, BUG_AUDIT
  // B-001; W2 invariants 1-2). Earlier this silently dispatched SET_PROJECT_ROOT to the
  // conversation's (often NESTED) root, closing every buffer and making files ABOVE that
  // root unreachable — the "different workspace boundary" symptom.
  //
  // The behaviour now, by where the conversation ran relative to the open workspace:
  //   - inside / equal: just select it. The open folder, buffers and terminal cwd are
  //     untouched; follow-up runs use the conversation's own root (AgentSession), and the
  //     chat shows a small "Runs in <relative path>" line (AgentChat). `../index.mjs` in
  //     the editor keeps working because the editor boundary is still the workspace.
  //   - outside (another folder, or a PARENT of the open one): select it read-only; the
  //     chat shows "open that folder to continue" with a guarded Open-folder button, and
  //     the composer blocks send so a run never executes against the wrong root.
  //   - no folder open yet: adopt the conversation's root as the workspace (nothing to
  //     lose), through the guarded flow, then select.
  const open = (c: AppState['conversations'][number]) => {
    const noFolderOpen = state.projectRoot === null;
    const target = c.root ? canonicalPath(c.root) : null;

    if (noFolderOpen && target !== null) {
      // Adopt the conversation's folder as the workspace; nothing is open to prompt about.
      void fileActions.openFolderPath(target).then((switched) => {
        if (!switched) return;
        dispatch({ type: 'SET_CONVERSATION', payload: c.id });
        dispatch({ type: 'SET_AGENT_VIEW', payload: 'new_task' });
      });
      return;
    }

    // Folder already open (or the conversation carries no root): select only. The root is
    // never moved here; AgentChat/Composer handle inside vs outside.
    dispatch({ type: 'SET_CONVERSATION', payload: c.id });
    dispatch({ type: 'SET_AGENT_VIEW', payload: 'new_task' });
  };

  const now = Date.now();
  // Pinned first, archived excluded from the main list (see conversationExtras).
  const recents = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const pool =
      needle === ''
        ? state.conversations
        : state.conversations.filter(
            (c) => c.title.toLowerCase().includes(needle) || c.messages.some((m) => m.content.toLowerCase().includes(needle)),
          );
    return orderConversations(pool, state.conversationExtras);
  }, [filter, state.conversations, state.conversationExtras]);
  const archived = useMemo(
    () => listArchivedConversations(state.conversations, state.conversationExtras),
    [state.conversations, state.conversationExtras],
  );
  const activeExtras =
    state.activeConversationId !== null ? getExtras(state.conversationExtras, state.activeConversationId) : null;
  const activeModel = activeExtras?.model ?? null;

  const busyId = session?.activeRunId ?? null;
  const connected = state.providers.length > 0;

  return (
    <div className={styles.container}>
      <button className={styles.workspaceButton} onClick={() => void fileActions.openFolder()} title={state.projectRoot ?? 'Choose a project folder'}>
        <span className={styles.workspaceIcon}><Folder size={17} /></span>
        <span className={styles.workspaceText}><strong>{state.projectRoot ? basename(state.projectRoot) : 'Your workspace'}</strong><small>{state.projectRoot ? 'Project folder' : 'Choose a project to begin'}</small></span>
        <ChevronDown size={13} />
      </button>
      <div className={styles.newTaskSection}>
        <button className={styles.newTaskBtn} onClick={handleNewTask}>
          <Plus size={14} />
          <span>New task</span>
        </button>
      </div>

      <nav className={styles.menuNav} aria-label="Cowork navigation">
        {([
          { view: 'projects', label: 'Projects', icon: Folder },
          { view: 'workflows', label: 'Workflows', icon: Layers },
          { view: 'artifacts', label: 'Runs', icon: FileText },
          { view: 'customize', label: 'Skills', icon: Puzzle },
          { view: 'tools', label: 'Tools & MCP', icon: Server },
          { view: 'memory', label: 'Memory', icon: Database },
          { view: 'timeline', label: 'Timeline', icon: Activity },
          { view: 'console', label: 'Agent Console', icon: MessageSquare },
        ] as const).map(({ view, label, icon: Icon }) => (
          <button key={view} className={`${styles.menuItem} ${state.agentView === view ? styles.activeMenuItem : ''}`} aria-current={state.agentView === view ? 'page' : undefined} onClick={() => handleViewSelect(view)}>
            <Icon size={15} /><span>{label}</span>
          </button>
        ))}
      </nav>

      <div className={styles.recentsSection}>
        <div className={styles.recentsHeader}>
          <span>Recents</span>
          <button
            className={styles.filterBtn}
            title="Import a chat from a JSON export file"
            aria-label="Import chat"
            onClick={() => importRef.current?.click()}
          >
            <Upload size={13} />
          </button>
          <input
            ref={importRef}
            type="file"
            accept=".json,application/json"
            aria-label="Choose a chat export file to import"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void importConversation(file);
            }}
          />
          <button
            className={styles.filterBtn}
            title={filterOpen ? 'Close search' : 'Search conversations'}
            aria-label={filterOpen ? 'Close search' : 'Search conversations'}
            onClick={() => {
              setFilterOpen(!filterOpen);
              setFilter('');
            }}
          >
            {filterOpen ? <X size={13} /> : <Search size={13} />}
          </button>
        </div>
        {filterOpen && (
          <input
            className={styles.filterInput}
            autoFocus
            placeholder="Search conversations"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Search conversations"
          />
        )}

        {state.activeConversationId !== null && state.providers.length > 0 && (
          <label className={styles.recentMeta} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '4px 0' }}>
            <span>Model for this chat</span>
            <select
              className={styles.filterInput}
              style={{ flex: 1, minWidth: 0 }}
              aria-label="Model for this chat"
              value={activeModel ?? ''}
              onChange={(e) => {
                const value = e.target.value;
                dispatch({
                  type: 'SET_CONVERSATION_MODEL',
                  payload: { id: state.activeConversationId!, model: value === '' ? null : value },
                });
              }}
            >
              <option value="">Use global model</option>
              {state.providers.map((provider) => (
                <option key={provider.id} value={provider.model}>
                  {provider.label} — {provider.model}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className={styles.recentsList}>
          {recents.length === 0 && (
            <div className={styles.recentsEmpty}>
              {state.conversations.length === 0 ? 'Your conversations will appear here.' : 'No conversation matches.'}
            </div>
          )}
          {recents.map((c) => {
            const active = c.id === state.activeConversationId;
            const running = active && busyId !== null;
            return (
              <div
                key={c.id}
                className={`${styles.recentItem} ${active ? styles.activeRecent : ''}`}
                role="button"
                tabIndex={0}
                title={c.root ? `${c.title}\n${c.root}` : c.title}
                onClick={() => open(c)}
                onKeyDown={(e) => {
                  if (!isActivationKey(e)) return;
                  e.preventDefault();
                  open(c);
                }}
              >
                {editing?.id === c.id ? (
                  <input
                    className={styles.recentRenameInput}
                    autoFocus
                    aria-label={`Rename conversation ${c.title}`}
                    value={editing.value}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setEditing({ id: c.id, value: e.target.value })}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (isComposing(e)) return;
                      e.stopPropagation();
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        (e.currentTarget as HTMLInputElement).blur(); // blur commits via the ref
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelRename();
                      }
                    }}
                  />
                ) : (
                  <span className={styles.recentTitle}>{c.title}</span>
                )}
                <span className={styles.recentMeta}>{running ? '●' : ago(c.updatedAt ?? c.createdAt, now)}</span>
                {editing?.id !== c.id && (
                  <button
                    className={styles.recentRename}
                    aria-label={`Rename conversation ${c.title}`}
                    title="Rename"
                    onClick={(e) => {
                      e.stopPropagation();
                      beginRename(c);
                    }}
                  >
                    <Pencil size={12} />
                  </button>
                )}
                {editing?.id !== c.id && (
                  <button
                    className={styles.recentRename}
                    aria-label={`Download conversation ${c.title} as Markdown`}
                    title="Download as Markdown"
                    onClick={(e) => {
                      e.stopPropagation();
                      downloadConversation(c, 'md');
                    }}
                  >
                    <FileText size={12} />
                  </button>
                )}
                {editing?.id !== c.id && (
                  <button
                    className={styles.recentRename}
                    aria-label={`Download conversation ${c.title} as JSON`}
                    title="Download as JSON (can be imported back)"
                    onClick={(e) => {
                      e.stopPropagation();
                      downloadConversation(c, 'json');
                    }}
                  >
                    <Download size={12} />
                  </button>
                )}
                {editing?.id !== c.id && (
                  <button
                    className={styles.recentRename}
                    aria-label={`Copy conversation ${c.title} as Markdown`}
                    title={copied === c.id ? 'Copied' : 'Copy as Markdown'}
                    onClick={(e) => {
                      e.stopPropagation();
                      void copyAsMarkdown(c);
                    }}
                  >
                    <Copy size={12} />
                  </button>
                )}
                {editing?.id !== c.id && (
                  <button
                    className={styles.recentRename}
                    aria-label={`${getExtras(state.conversationExtras, c.id).pinned ? 'Unpin' : 'Pin'} conversation ${c.title}`}
                    title={getExtras(state.conversationExtras, c.id).pinned ? 'Unpin (pinned chats sort first)' : 'Pin (sorts first)'}
                    onClick={(e) => {
                      e.stopPropagation();
                      dispatch({
                        type: getExtras(state.conversationExtras, c.id).pinned ? 'UNPIN_CONVERSATION' : 'PIN_CONVERSATION',
                        payload: c.id,
                      });
                    }}
                  >
                    {getExtras(state.conversationExtras, c.id).pinned ? '📌' : '📍'}
                  </button>
                )}
                {editing?.id !== c.id && (
                  <button
                    className={styles.recentRename}
                    aria-label={`Archive conversation ${c.title}`}
                    title="Archive (leaves the main list)"
                    onClick={(e) => {
                      e.stopPropagation();
                      dispatch({ type: 'ARCHIVE_CONVERSATION', payload: c.id });
                    }}
                  >
                    🗄️
                  </button>
                )}
                <button
                  className={styles.recentDelete}
                  aria-label={`Delete conversation ${c.title}`}
                  title="Delete"
                  disabled={running}
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteConversation(c);
                  }}
                >
                  <Trash size={12} />
                </button>
              </div>
            );
          })}
        </div>
        {archived.length > 0 && (
          <div className={styles.recentsList} aria-label="Archived conversations">
            <div className={styles.recentsHeader}>
              <span>Archived</span>
            </div>
            {archived.map((c) => (
              <div key={c.id} className={styles.recentItem} role="button" tabIndex={0} title={c.title} onClick={() => open(c)}>
                <span className={styles.recentTitle}>{c.title}</span>
                <span className={styles.recentMeta}>{ago(c.updatedAt ?? c.createdAt, now)}</span>
                <button
                  className={styles.recentRename}
                  aria-label={`Restore conversation ${c.title} from archive`}
                  title="Restore to Recents"
                  onClick={(e) => {
                    e.stopPropagation();
                    dispatch({ type: 'UNARCHIVE_CONVERSATION', payload: c.id });
                  }}
                >
                  ↩
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={styles.bottomFooter}>
        {!connected && state.providerSettingsPath !== null && (
          <button className={styles.connectBtn} onClick={() => dispatch({ type: 'OPEN_CONNECT' })}>
            <Key size={13} />
            <span>Connect a model</span>
          </button>
        )}
        <button className={styles.userBadge} onClick={() => dispatch({ type: 'OPEN_SETTINGS' })} title="Settings (Ctrl+,)">
          <SketchMark size={24} />
          <span className={styles.userNameText}>Settings</span>
          <Settings size={13} className={styles.chevronIcon} />
        </button>
      </div>
    </div>
  );
};
