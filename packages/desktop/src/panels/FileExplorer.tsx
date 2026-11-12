// Explorer — the real file tree, and everything a file tree is expected to do.
//
// The rows derive from two places and no others:
//
//   the rows        one `read_dir` per expanded directory, through the file layer
//   the highlight   `AppState.activeFile` — the Explorer holds NO second opinion
//   the project     `AppState.projectRoot`
//
// The tree is never walked: mounting reads exactly the root; expanding a folder reads
// exactly that folder (an eager walk would descend into `node_modules` and hang the
// window — Requirement 14.4). A refused or unreadable folder is NEVER drawn as an empty
// one (Requirements 27.3, 27.5).
//
// WHAT IT DOES NOW, beyond listing: New File and New Folder (header buttons, the context
// menu, Ctrl+N), Rename (F2), Delete (Del, to the trash), drag a file or folder onto a
// folder to move it, Copy Path, Open in Terminal, and "Ask Sketch" about any file or
// folder. Operations go through `useFileActions`, which goes through the engine; open
// tabs follow a rename and close on a delete. Folders re-read themselves when something
// changes them — an operation here, or a file the agent creates.
//
// Validates: Requirements 14.4, 14.6, 27.1, 27.3, 27.4

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Folder, FolderOpen, FileText, FileCode, FileJson,
  ChevronRight, Refresh, File, AlertCircle, FilePlus, FolderPlus, CollapseAll
} from '../components/Icons';
import { ContextMenu, type ContextMenuItem } from '../components/ContextMenu';
import { listForExplorer } from '../editor/fileIo';
import { diskPathKey, parentKey, useDiskChangeSignal, type DiskChange } from '../editor/diskSync';

/**
 * Two changes as one look, merged the way the disk signal coalesces a burst: paths add
 * up, and a change that does not know its paths (or no change at all, which means
 * "everything") makes it a look at everything.
 */
function mergeDiskChanges(kept: DiskChange | null, next: DiskChange | undefined): DiskChange {
  if (next === undefined) return { paths: null, git: true, reasons: new Set(kept?.reasons ?? []) };
  if (kept === null) return next;
  return {
    paths: kept.paths === null || next.paths === null ? null : new Set([...kept.paths, ...next.paths]),
    git: kept.git || next.git,
    reasons: new Set([...kept.reasons, ...next.reasons]),
  };
}
import { useFileIo } from '../editor/FileIoProvider';
import { basename, canonicalPath, relativeToRoot } from '../editor/paths';

/**
 * True when a failed listing says the folder is simply not there (deleted/renamed) —
 * the wording `describeFileFailure` produces for a not-found error. A refusal or a
 * permission error is NOT this, and is still shown as an error row.
 */
function describesMissingFolder(message: string): boolean {
  return message.toLowerCase().includes('no longer exists on disk');
}
import { useFileActions } from '../editor/useFileActions';
import {
  directoriesToRead,
  flattenTree,
  type DirLoad,
  type TreeRow,
} from '../explorer/fileTree';
import { useOptionalSketchClient, useOptionalSketchEvents } from '../lib/ClientProvider';
import { isComposing } from '../lib/keys';
import { useAppDispatch, useAppState } from '../state/AppState';
import { isMacPlatform } from '../terminal/shellKeys';
import styles from './FileExplorer.module.css';

/** What the operating system calls its file manager, for the menu. */
export function revealLabel(mac: boolean, windows: boolean): string {
  if (mac) return 'Reveal in Finder';
  if (windows) return 'Reveal in File Explorer';
  return 'Open Containing Folder';
}

function isWindowsPlatform(): boolean {
  return typeof navigator !== 'undefined' && /win/i.test(navigator.platform ?? '') && !isMacPlatform();
}

interface TreeCache {
  root: string;
  dirs: Map<string, DirLoad>;
  expanded: Set<string>;
}

function emptyCache(root: string): TreeCache {
  return { root, dirs: new Map(), expanded: new Set() };
}

function withDirs(cache: TreeCache, updates: Array<[string, DirLoad]>): TreeCache {
  const dirs = new Map(cache.dirs);
  for (const [dir, load] of updates) dirs.set(dir, load);
  return { ...cache, dirs };
}

/** True when two reads of one folder say the same thing, so a re-read can leave the rows alone. */
function sameListing(a: DirLoad, b: DirLoad): boolean {
  if (a.status !== b.status) return false;
  if (a.status === 'error' && b.status === 'error') return a.message === b.message;
  if (a.status !== 'ready' || b.status !== 'ready') return a.status === b.status;
  if (a.entries.length !== b.entries.length) return false;
  return a.entries.every((entry, i) => {
    const other = b.entries[i]!;
    return entry.path === other.path && entry.name === other.name && entry.isDir === other.isDir;
  });
}

/** What the inline name box is doing, if it is showing. */
type Editing =
  | { kind: 'new-file' | 'new-folder'; dir: string }
  | { kind: 'rename'; path: string; isDir: boolean };

const DRAG_TYPE = 'application/x-sketch-path';

function copy(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => {});
}

export function FileExplorer() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const actions = useFileActions();
  const io = useFileIo();
  const events = useOptionalSketchEvents();
  const client = useOptionalSketchClient();

  const root = state.projectRoot;

  /** Hand a path to the operating system; a refusal is shown, never thrown at the user. */
  const osAction = useCallback(
    async (kind: 'reveal' | 'terminal', path: string) => {
      if (root === null || client === null) return;
      try {
        if (kind === 'reveal') await client.osReveal?.({ root, path });
        else await client.osOpenTerminal?.({ root, path });
      } catch (err) {
        dispatch({
          type: 'SET_EDITOR_NOTICE',
          payload: { level: 'error', message: err instanceof Error ? err.message : String(err) },
        });
      }
    },
    [client, dispatch, root],
  );
  const [cache, setCache] = useState<TreeCache>(() => emptyCache(root ?? ''));
  const [editing, setEditingState] = useState<Editing | null>(null);
  // Mirrors `editing` synchronously: Enter commits and unmounts the box, and the blur
  // that follows must find nothing left to commit instead of creating the file twice.
  const editingRef = useRef<Editing | null>(null);
  const setEditing = useCallback((next: Editing | null) => {
    editingRef.current = next;
    setEditingState(next);
  }, []);
  // The text in the inline name box. Typed, never preset to some file's name.
  const [draft, setDraft] = useState<string>(() => String());
  const [selected, setSelected] = useState<string | null>(null);
  // The project row is a real disclosure: it used to show a chevron and ignore
  // clicks, which is worse than not looking clickable at all.
  const [rootCollapsed, setRootCollapsed] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string | null; isDir: boolean } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const mounted = useRef(true);
  // Set on every mount, not only cleared on unmount: React may unmount and mount a
  // component again with its refs kept (StrictMode does it on purpose in development),
  // and a flag left false would drop every listing — "Reading…" forever.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Reading is driven by what the rows need: the root, plus every expanded directory
  // reachable from it. So a refresh is "forget the listings", and this effect refills them.
  useEffect(() => {
    if (root === null) return;
    if (cache.root !== root) {
      setCache(emptyCache(root));
      return;
    }
    const missing = directoriesToRead(cache).filter((dir) => !cache.dirs.has(dir));
    if (missing.length === 0) return;

    setCache((prev) =>
      prev.root === root
        ? withDirs(prev, missing.map((dir) => [dir, { status: 'loading' }] as [string, DirLoad]))
        : prev,
    );

    for (const dir of missing) {
      void listForExplorer(io, root, dir).then((outcome) => {
        if (!mounted.current) return;
        // A restored project ROOT whose folder has since been deleted or renamed must
        // not leave a dead explorer or a stream of not-found errors: clear it to the
        // welcome / no-folder state with one plain notice (CLEAR_PROJECT_ROOT drops the
        // restored tabs but keeps any unsaved buffer). Only the ROOT itself, and only a
        // genuine not-found — a refused/ permission error on some nested folder is still
        // shown as an error row, as before. Reuses this read; no extra disk call.
        if (!outcome.ok && dir === root && describesMissingFolder(outcome.message)) {
          dispatch({
            type: 'CLEAR_PROJECT_ROOT',
            payload: {
              notice: {
                level: 'info',
                message: `The folder ${basename(root) || root} is no longer available. Open a folder to continue.`,
              },
            },
          });
          return;
        }
        setCache((prev) =>
          prev.root === root
            ? withDirs(prev, [
                [dir, outcome.ok ? { status: 'ready', entries: outcome.entries } : { status: 'error', message: outcome.message }],
              ])
            : prev,
        );
      });
    }
  }, [cache, io, root, dispatch]);

  /** Forget the listing of each changed folder, so the effect above re-reads it. */
  const invalidate = useCallback((dirs: string[]) => {
    const wanted = new Set(dirs.map((d) => canonicalPath(d)));
    setCache((prev) => {
      const next = new Map(prev.dirs);
      let changed = false;
      for (const key of prev.dirs.keys()) {
        if (wanted.has(canonicalPath(key))) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? { ...prev, dirs: next } : prev;
    });
  }, []);

  /** Re-read one folder after a failed listing, without refreshing the whole tree. */
  const retryFolder = useCallback((dir: string) => {
    setCache((prev) => {
      if (!prev.dirs.has(dir)) return prev;
      const dirs = new Map(prev.dirs);
      dirs.delete(dir);
      return { ...prev, dirs };
    });
  }, []);

  // Operations anywhere in the window announce the folders they changed.
  useEffect(() => {
    const onChange = (event: Event) => {
      const dirs = (event as CustomEvent<{ dirs?: string[] }>).detail?.dirs ?? [];
      invalidate(dirs);
    };
    window.addEventListener('sketch:fs-changed', onChange);
    return () => window.removeEventListener('sketch:fs-changed', onChange);
  }, [invalidate]);

  // Something outside this panel may have changed the tree — a terminal command, a
  // branch switch or pull, another program while the window was in the background.
  // Every folder already on screen is re-read IN PLACE: the old rows stay until the
  // new listing arrives and only a listing that actually changed is replaced, so a
  // look that finds nothing new changes nothing on screen.
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const revalidating = useRef(false);
  // A change announced while a look is in flight is kept (merged with any others) and
  // looked at the moment that look ends. Dropped, the last burst of a branch switch or
  // an install went unseen: the folder kept showing what it held when the look began.
  const pendingChange = useRef<DiskChange | null>(null);
  const revalidateRef = useRef<(change?: DiskChange) => Promise<void>>(async () => {});
  const revalidate = useCallback(async (change?: DiskChange) => {
    const snapshot = cacheRef.current;
    if (root === null || snapshot.root !== root) return;
    if (revalidating.current) {
      pendingChange.current = mergeDiskChanges(pendingChange.current, change);
      return;
    }
    // The watcher names what changed: only those files' folders (and a changed folder
    // itself) need reading again. Anything else does not know, so everything is read.
    const affected =
      change !== undefined && change.paths !== null
        ? new Set([...change.paths].flatMap((path) => [path, parentKey(path)]))
        : null;
    const dirs = directoriesToRead(snapshot).filter((dir) => {
      const load = snapshot.dirs.get(dir);
      if (load === undefined || load.status === 'loading') return false;
      return affected === null || affected.has(diskPathKey(dir));
    });
    if (dirs.length === 0) return;
    revalidating.current = true;
    try {
      const outcomes = await Promise.all(dirs.map(async (dir) => [dir, await listForExplorer(io, root, dir)] as const));
      if (!mounted.current) return;
      setCache((prev) => {
        if (prev.root !== root) return prev;
        const updates: Array<[string, DirLoad]> = [];
        for (const [dir, outcome] of outcomes) {
          const current = prev.dirs.get(dir);
          // Unread or being read by the effect above: that read is the newer one.
          if (current === undefined || current.status === 'loading') continue;
          const next: DirLoad = outcome.ok
            ? { status: 'ready', entries: outcome.entries }
            : { status: 'error', message: outcome.message };
          if (!sameListing(current, next)) updates.push([dir, next]);
        }
        return updates.length === 0 ? prev : withDirs(prev, updates);
      });
    } finally {
      revalidating.current = false;
      const next = pendingChange.current;
      pendingChange.current = null;
      if (next !== null && mounted.current) void revalidateRef.current(next);
    }
  }, [io, root]);
  revalidateRef.current = revalidate;
  useDiskChangeSignal((change) => void revalidate(change));

  // A file the agent wrote may be new: re-read its folder once per write.
  const seenEvents = useRef(0);
  useEffect(() => {
    if (root === null) return;
    const fresh = events.slice(seenEvents.current);
    seenEvents.current = events.length;
    const dirs: string[] = [];
    for (const event of fresh) {
      if (event.kind !== 'edit_accepted') continue;
      const raw = event.payload['path'];
      if (typeof raw !== 'string') continue;
      const abs = canonicalPath(/^([A-Za-z]:[/\\]|\/)/.test(raw) ? raw : `${root}/${raw}`);
      dirs.push(abs.slice(0, Math.max(abs.lastIndexOf('/'), 0)) || root);
    }
    if (dirs.length > 0) invalidate(dirs);
  }, [events, invalidate, root]);

  const rows = useMemo(
    () => (root === null || cache.root !== root ? [] : flattenTree(cache)),
    [cache, root],
  );

  const toggleFolder = useCallback((path: string, open?: boolean) => {
    setCache((prev) => {
      const expanded = new Set(prev.expanded);
      const shouldOpen = open ?? !expanded.has(path);
      if (shouldOpen) expanded.add(path);
      else expanded.delete(path);
      return { ...prev, expanded };
    });
  }, []);

  const refresh = useCallback(() => {
    setCache((prev) => ({ root: prev.root, dirs: new Map(), expanded: prev.expanded }));
  }, []);

  const collapseAll = useCallback(() => {
    setCache((prev) => ({ ...prev, expanded: new Set() }));
  }, []);

  /** The cache key for a folder, given any spelling of its path. */
  const keyFor = useCallback(
    (path: string): string => {
      const canonical = canonicalPath(path);
      if (root !== null && canonical === canonicalPath(root)) return cache.root;
      for (const key of cache.dirs.keys()) if (canonicalPath(key) === canonical) return key;
      return path;
    },
    [cache.dirs, cache.root, root],
  );

  // Reveal in Explorer: open every ancestor folder of the path and select it.
  useEffect(() => {
    const onReveal = (event: Event) => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path;
      if (path === undefined || root === null) return;
      const rel = relativeToRoot(root, path);
      const parts = rel.split('/').filter(Boolean);
      setCache((prev) => {
        const expanded = new Set(prev.expanded);
        let at = canonicalPath(prev.root);
        for (const part of parts.slice(0, -1)) {
          at = `${at}/${part}`;
          // Expansion is keyed by the backend's spelling once a listing exists.
          let key = at;
          for (const known of prev.dirs.values()) {
            if (known.status !== 'ready') continue;
            const hit = known.entries.find((e) => e.isDir && canonicalPath(e.path) === at);
            if (hit !== undefined) key = hit.path;
          }
          expanded.add(key);
        }
        return { ...prev, expanded };
      });
      setSelected(path);
    };
    window.addEventListener('sketch:reveal-in-explorer', onReveal);
    return () => window.removeEventListener('sketch:reveal-in-explorer', onReveal);
  }, [root]);

  // Ctrl+N / File → New File… / the palette ask the Explorer to start a new file.
  const startCreate = useCallback(
    (kind: 'new-file' | 'new-folder', dir?: string) => {
      if (root === null) return;
      setRootCollapsed(false);
      const target = dir ?? cache.root;
      if (canonicalPath(target) !== canonicalPath(cache.root)) toggleFolder(keyFor(target), true);
      setEditing({ kind, dir: keyFor(target) });
      setDraft('');
    },
    [cache.root, keyFor, root, toggleFolder],
  );

  useEffect(() => {
    const onNew = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: 'file' | 'folder' }>).detail;
      startCreate(detail?.kind === 'folder' ? 'new-folder' : 'new-file');
    };
    window.addEventListener('sketch:explorer-new', onNew);
    return () => window.removeEventListener('sketch:explorer-new', onNew);
  }, [startCreate]);

  const commit = async () => {
    const current = editingRef.current;
    if (current === null) return;
    const name = draft.trim();
    setEditing(null);
    setDraft('');
    if (name === '') return;
    if (current.kind === 'rename') {
      if (name !== basename(current.path)) {
        const to = await actions.renamePath(current.path, name);
        if (to !== null) setSelected(to);
      }
    } else if (current.kind === 'new-file') {
      // `a/b/c.ts` creates the folders on the way, as in every editor.
      await actions.createFile(current.dir, name);
    } else {
      await actions.createFolder(current.dir, name);
    }
  };

  const cancelEdit = () => {
    setEditing(null);
    setDraft('');
  };

  const getFileIcon = (name: string) => {
    const lower = name.toLowerCase();
    if (/\.(tsx?|jsx?|mjs|cjs)$/.test(lower)) return <FileCode size={14} className={styles.iconTs} />;
    if (/\.(css|scss|less)$/.test(lower)) return <FileCode size={14} className={styles.iconCss} />;
    if (/\.(json|jsonc)$/.test(lower)) return <FileJson size={14} className={styles.iconJson} />;
    if (/\.(md|mdx|txt)$/.test(lower)) return <FileText size={14} className={styles.iconMd} />;
    if (lower.endsWith('.rs')) return <FileCode size={14} className={styles.iconRust} />;
    if (lower.endsWith('.py')) return <FileCode size={14} className={styles.iconPython} />;
    return <File size={14} className={styles.iconDefault} />;
  };

  const guides = (depth: number) =>
    Array.from({ length: depth }, (_unused, level) => (
      <span key={level} className={styles.indentGuide} style={{ left: `${level * 12 + 14}px` }} aria-hidden="true" />
    ));

  const nameInput = (depth: number, kind: Editing['kind'], placeholder: string) => (
    <div className={styles.inputRow} style={{ paddingLeft: `${depth * 12 + 8}px` }}>
      {guides(depth)}
      <span className={styles.fileIconSpacer}>
        {kind === 'new-folder' ? <Folder size={14} className={styles.iconFolder} /> : <File size={14} className={styles.iconDefault} />}
      </span>
      <input
        className={styles.nameInput}
        autoFocus
        value={draft}
        placeholder={placeholder}
        aria-label={placeholder}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => {
          // Select the stem, not the extension, when renaming — as every file manager does.
          if (kind === 'rename') {
            const dot = e.currentTarget.value.lastIndexOf('.');
            e.currentTarget.setSelectionRange(0, dot > 0 ? dot : e.currentTarget.value.length);
          }
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (isComposing(e)) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            void commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelEdit();
          }
        }}
        onBlur={() => void commit()}
      />
    </div>
  );

  const askAbout = (path: string, isDir: boolean) => {
    if (root === null) return;
    const rel = relativeToRoot(root, path) || '.';
    if (state.rightPanelCollapsed) dispatch({ type: 'TOGGLE_RIGHT_PANEL' });
    dispatch({
      type: 'SEED_COMPOSER',
      payload: isDir
        ? { text: `Explain what the \`${rel}\` folder contains and how it fits into the project.`, files: [] }
        : { text: 'Explain what this file does and how it fits into the project.', files: [rel] },
    });
  };

  const menuItems = (path: string | null, isDir: boolean): ContextMenuItem[] => {
    if (root === null) return [];
    const folder = path === null ? cache.root : isDir ? path : path.slice(0, Math.max(path.replace(/\\/g, '/').lastIndexOf('/'), 0));
    const items: ContextMenuItem[] = [
      { id: 'new-file', label: 'New File…', hint: 'Ctrl+N', run: () => startCreate('new-file', folder) },
      { id: 'new-folder', label: 'New Folder…', run: () => startCreate('new-folder', folder) },
    ];
    if (path !== null) {
      items.push(
        'separator',
        ...(isDir ? [] : [{ id: 'open', label: 'Open', run: () => void actions.openPath(path) }]),
        { id: 'rename', label: 'Rename…', hint: 'F2', run: () => { setEditing({ kind: 'rename', path, isDir }); setDraft(basename(path)); } },
        { id: 'delete', label: 'Delete', hint: 'Del', danger: true, run: () => void actions.deletePath(path, isDir) },
        'separator',
        { id: 'copy', label: 'Copy Path', run: () => copy(path) },
        { id: 'copyrel', label: 'Copy Relative Path', run: () => copy(relativeToRoot(root, path)) },
      );
    }
    const osTarget = path ?? root;
    items.push(
      'separator',
      ...(client?.osReveal !== undefined
        ? [{ id: 'reveal', label: revealLabel(isMacPlatform(), isWindowsPlatform()), hint: 'Shift+Alt+R', run: () => void osAction('reveal', osTarget) }]
        : []),
      {
        id: 'terminal',
        label: 'Open in Integrated Terminal',
        run: () => {
          const cwd = canonicalPath(folder) === canonicalPath(root) ? null : folder;
          dispatch({ type: 'TERMINAL_NEW', payload: { cwd } });
        },
      },
      ...(client?.osOpenTerminal !== undefined
        ? [{ id: 'external-terminal', label: 'Open in External Terminal', run: () => void osAction('terminal', folder) }]
        : []),
      { id: 'ask', label: path === null ? 'Ask Sketch About This Project' : `Ask Sketch About This ${isDir ? 'Folder' : 'File'}`, run: () => askAbout(path ?? root, path === null || isDir) },
    );
    if (path === null) {
      items.push('separator', { id: 'refresh', label: 'Refresh', run: refresh }, { id: 'collapse', label: 'Collapse All Folders', run: collapseAll });
    }
    return items;
  };

  const onDrop = async (event: React.DragEvent, folder: string) => {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    const from = event.dataTransfer.getData(DRAG_TYPE);
    if (from === '' || root === null) return;
    const source = canonicalPath(from);
    const target = canonicalPath(folder);
    const parent = source.slice(0, source.lastIndexOf('/'));
    if (source === target || parent === target || target.startsWith(`${source}/`)) return;
    await actions.movePath(from, folder);
  };

  const dropProps = (folder: string) => ({
    onDragOver: (event: React.DragEvent) => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      setDropTarget(folder);
    },
    onDragLeave: () => setDropTarget((current) => (current === folder ? null : current)),
    onDrop: (event: React.DragEvent) => void onDrop(event, folder),
  });

  /**
   * Roving focus for the tree. Every row is tabbable today, which makes Tab walk
   * through the whole project; the arrow keys should move row to row instead.
   */
  const focusSibling = (event: React.KeyboardEvent<HTMLElement>, where: number | 'first' | 'last') => {
    const tree = event.currentTarget.closest('[role="tree"]');
    if (tree === null) return false;
    const rows = Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const at = rows.indexOf(event.currentTarget as HTMLElement);
    const to = where === 'first' ? 0 : where === 'last' ? rows.length - 1 : Math.min(rows.length - 1, Math.max(0, at + where));
    const target = rows[to];
    if (target === undefined) return false;
    event.preventDefault();
    target.focus();
    return true;
  };

  const renderRow = (row: TreeRow) => {
    if (row.kind === 'note') {
      // A failed listing names the folder in its key, so the row can offer the
      // one action that helps: read it again.
      const retryDir = row.tone === 'error' && row.key.endsWith(':error')
        ? row.key.slice(0, -':error'.length)
        : null;
      return (
        <div
          key={row.key}
          className={`${styles.note} ${row.tone === 'error' ? styles.noteError : ''}`}
          style={{ paddingLeft: `${row.depth * 12 + 26}px` }}
          role={row.tone === 'error' ? 'alert' : undefined}
        >
          {guides(row.depth)}
          {row.tone === 'error' && <AlertCircle size={12} className={styles.noteIcon} />}
          <span className={styles.noteText}>{row.text}</span>
          {retryDir !== null && (
            <button type="button" className={styles.noteRetry} onClick={() => retryFolder(retryDir)}>
              Retry
            </button>
          )}
        </div>
      );
    }

    const isFolder = row.kind === 'dir';
    const isActive = !isFolder && canonicalPath(row.path) === state.activeFile;
    const isSelected = selected !== null && canonicalPath(selected) === canonicalPath(row.path);
    const renaming = editing?.kind === 'rename' && canonicalPath(editing.path) === canonicalPath(row.path);
    const creatingHere = (editing?.kind === 'new-file' || editing?.kind === 'new-folder') && isFolder && editing.dir === row.path;

    const activate = () => {
      setSelected(row.path);
      if (isFolder) toggleFolder(row.path);
      else void actions.openPath(row.path);
    };

    if (renaming) {
      return <div key={row.key}>{nameInput(row.depth, 'rename', 'New name')}</div>;
    }

    return (
      <div key={row.key}>
        <div
          className={`${styles.treeNode} ${isActive ? styles.active : ''} ${isSelected && !isActive ? styles.selected : ''} ${dropTarget === row.path ? styles.dropTarget : ''}`}
          style={{ paddingLeft: `${row.depth * 12 + 8}px` }}
          role="treeitem"
          aria-level={row.depth + 1}
          aria-expanded={isFolder ? row.expanded : undefined}
          aria-selected={isFolder ? undefined : isActive}
          tabIndex={0}
          title={row.path}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(DRAG_TYPE, row.path);
            event.dataTransfer.effectAllowed = 'move';
          }}
          {...(isFolder ? dropProps(row.path) : {})}
          onClick={activate}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setSelected(row.path);
            setMenu({ x: event.clientX, y: event.clientY, path: row.path, isDir: isFolder });
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && focusSibling(event, 1)) return;
            if (event.key === 'ArrowUp' && focusSibling(event, -1)) return;
            if (event.key === 'Home' && focusSibling(event, 'first')) return;
            if (event.key === 'End' && focusSibling(event, 'last')) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              activate();
            } else if (event.key === 'F2') {
              event.preventDefault();
              setEditing({ kind: 'rename', path: row.path, isDir: isFolder });
              setDraft(row.name);
            } else if (event.key === 'Delete') {
              event.preventDefault();
              void actions.deletePath(row.path, isFolder);
            } else if (event.key === 'ArrowRight' && isFolder && !row.expanded) {
              event.preventDefault();
              toggleFolder(row.path, true);
            } else if (event.key === 'ArrowLeft' && isFolder && row.expanded) {
              event.preventDefault();
              toggleFolder(row.path, false);
            }
          }}
        >
          {guides(row.depth)}
          {isFolder ? (
            <>
              <div className={`${styles.chevron} ${row.expanded ? styles.open : ''}`}>
                <ChevronRight size={14} />
              </div>
              {row.expanded ? <FolderOpen size={14} className={styles.iconFolder} /> : <Folder size={14} className={styles.iconFolder} />}
            </>
          ) : (
            <div className={styles.fileIconSpacer}>{getFileIcon(row.name)}</div>
          )}
          <span className={styles.nodeName}>{row.name}</span>
          {!isFolder && state.files[canonicalPath(row.path)]?.isDirty && <span className={styles.dirtyDot} aria-label="unsaved changes">●</span>}
        </div>
        {creatingHere && nameInput(row.depth + 1, editing!.kind, editing!.kind === 'new-folder' ? 'Folder name' : 'File name (a/b.ts makes folders)')}
      </div>
    );
  };

  const creatingAtRoot = (editing?.kind === 'new-file' || editing?.kind === 'new-folder') && root !== null && editing.dir === cache.root;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.title}>EXPLORER</span>
        <div className={styles.actions}>
          <button className={styles.actionBtn} onClick={() => startCreate('new-file')} disabled={root === null} title="New File (Ctrl+N)" aria-label="New file">
            <FilePlus size={14} />
          </button>
          <button className={styles.actionBtn} onClick={() => startCreate('new-folder')} disabled={root === null} title="New Folder" aria-label="New folder">
            <FolderPlus size={14} />
          </button>
          <button className={styles.actionBtn} onClick={refresh} disabled={root === null} title="Re-read the folders from disk" aria-label="Refresh the file tree">
            <Refresh size={14} />
          </button>
          <button className={styles.actionBtn} onClick={collapseAll} disabled={root === null} title="Collapse All Folders" aria-label="Collapse all folders">
            <CollapseAll size={14} />
          </button>
        </div>
      </div>

      {root === null ? (
        <div className={styles.emptyState}>
          <FolderOpen size={32} className={styles.emptyIcon} />
          <p className={styles.emptyTitle}>No folder opened</p>
          <p className={styles.emptyHint}>
            Open a folder to browse, edit and ask Sketch about its files.
          </p>
          <div className={styles.emptyActions}>
            <button className={styles.openBtn} onClick={() => void actions.openFolder()}>
              Open Folder
            </button>
            <button
              className={styles.cloneBtn}
              onClick={() => window.dispatchEvent(new CustomEvent('sketch:clone'))}
            >
              Clone Repository
            </button>
          </div>
        </div>
      ) : (
        <div
          className={`${styles.treeContainer} ${dropTarget === cache.root ? styles.dropTarget : ''}`}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, path: null, isDir: true });
          }}
          {...dropProps(cache.root)}
        >
          <button
            type="button"
            className={styles.projectName}
            title={rootCollapsed ? `Expand ${root}` : `Collapse ${root}`}
            aria-expanded={!rootCollapsed}
            onClick={() => setRootCollapsed((collapsed) => !collapsed)}
          >
            <span className={`${styles.rootChevron} ${rootCollapsed ? '' : styles.rootChevronOpen}`}>
              <ChevronRight size={14} />
            </span>
            <span className={styles.rootName}>{basename(root) || root}</span>
          </button>
          {!rootCollapsed && (
            <div className={styles.tree} role="tree" aria-label="Files">
              {creatingAtRoot && nameInput(0, editing!.kind, editing!.kind === 'new-folder' ? 'Folder name' : 'File name (a/b.ts makes folders)')}
              {rows.map(renderRow)}
            </div>
          )}
        </div>
      )}

      {menu !== null && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.path, menu.isDir)} onClose={() => setMenu(null)} label="File actions" />
      )}
    </div>
  );
}
