// Explorer — the real file tree.
//
// WHAT THIS REPLACED: `MOCK_TREE`, a 40-line module-level fixture describing somebody
// else's `src/components` folder; `useState(MOCK_TREE)` with a folder toggle that
// deep-copied the fixture through `JSON.parse(JSON.stringify(...))` and mutated the
// copy; a hardcoded `useState('FileExplorer.tsx')` deciding which row looked active;
// and a project name that always read `sketch-desktop`. Nothing on screen came from
// the disk, and clicking a file did nothing but move the highlight.
//
// Everything here now derives from two places and no others:
//
//   the rows        one `read_dir` per expanded directory, through the file layer
//   the highlight   `AppState.activeFile` — the Explorer holds NO second opinion
//   the project     `AppState.projectRoot`
//
// ── LAZY, ONE DIRECTORY AT A TIME ───────────────────────────────────────────
//
// The tree is never walked. Mounting reads exactly the root; expanding a folder reads
// exactly that folder. An eager recursive walk of this repository would descend into
// its own `node_modules` and hang the window, and it would do that work for folders
// the user never opens (Requirement 14.4).
//
// ── THE TREE IS DERIVED STATE ───────────────────────────────────────────────
//
// There is no mutable nested node object. A `Map<dirPath, DirLoad>` holds what each
// `read_dir` answered and a `Set<dirPath>` holds what the user opened; the rows are
// `flattenTree` of those two (see ../explorer/fileTree.ts). This is the same
// discipline as task 3.1: the tree holds names and expansion state, never file text,
// so it cannot become a second file cache competing with `AppState.files`.
//
// ── CLICKING A FILE OPENS IT ────────────────────────────────────────────────
//
// Through `useFileActions.openPath`, which existed with no caller in the shipped app
// until this panel. Nothing else in the product could open a file (Requirement 27.3).
//
// ── THREE DISTINCT NOTHINGS ─────────────────────────────────────────────────
//
//   no project open      — nothing to list until a folder is picked
//   an empty directory   — read successfully, and it has no children
//   a failed read        — named, with the reason, as an alert. A refused or
//                          unreadable folder is NEVER drawn as an empty one
//                          (Requirements 27.3, 27.5)
//
// Validates: Requirements 14.4, 14.6, 27.1, 27.3, 27.4

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Folder, FolderOpen, FileText, FileCode, FileJson,
  ChevronRight, ChevronDown, Plus, Refresh, File, AlertCircle
} from '../components/Icons';
import { listForExplorer } from '../editor/fileIo';
import { useFileIo } from '../editor/FileIoProvider';
import { basename, canonicalPath } from '../editor/paths';
import { useFileActions } from '../editor/useFileActions';
import {
  directoriesToRead,
  flattenTree,
  type DirLoad,
  type TreeRow,
} from '../explorer/fileTree';
import { useAppState } from '../state/AppState';
import styles from './FileExplorer.module.css';

/**
 * Everything the tree knows, tagged with the project it belongs to.
 *
 * The tag is what makes switching projects safe: a listing that arrives after the
 * user opened a different folder is dropped instead of being grafted onto the new
 * tree, and one render never mixes rows from two roots.
 */
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

export function FileExplorer() {
  const state = useAppState();
  const actions = useFileActions();
  const io = useFileIo();

  const root = state.projectRoot;
  const [cache, setCache] = useState<TreeCache>(() => emptyCache(root ?? ''));
  // A listing that resolves after this panel is gone has nothing to update.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  // Reading is driven by what the rows need, not by what a click handler remembers:
  // the root, plus every expanded directory reachable from it. So a refresh is
  // "forget the listings", and the cascade that refills them is this one effect.
  useEffect(() => {
    if (root === null) return;
    if (cache.root !== root) {
      // A new project. Nothing from the previous one survives.
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
        setCache((prev) =>
          prev.root === root
            ? withDirs(prev, [
                [
                  dir,
                  outcome.ok
                    ? { status: 'ready', entries: outcome.entries }
                    : { status: 'error', message: outcome.message },
                ],
              ])
            : prev,
        );
      });
    }
  }, [cache, io, root]);

  const rows = useMemo(
    () => (root === null || cache.root !== root ? [] : flattenTree(cache)),
    [cache, root],
  );

  const toggleFolder = useCallback((path: string) => {
    setCache((prev) => {
      const expanded = new Set(prev.expanded);
      // Collapsing keeps what was read, so re-opening is instant and offline. Taking
      // a fresh look is the Refresh button, which is a different intent.
      if (expanded.has(path)) expanded.delete(path);
      else expanded.add(path);
      return { ...prev, expanded };
    });
  }, []);

  const refresh = useCallback(() => {
    // Drop every listing and keep the expansion. The effect above re-reads the root
    // first, then each expanded folder as its parent comes back.
    setCache((prev) => ({ root: prev.root, dirs: new Map(), expanded: prev.expanded }));
  }, []);

  const getFileIcon = (name: string) => {
    if (name.endsWith('.tsx') || name.endsWith('.ts')) return <FileCode size={14} className={styles.iconTs} />;
    if (name.endsWith('.css')) return <FileCode size={14} className={styles.iconCss} />;
    if (name.endsWith('.json')) return <FileJson size={14} className={styles.iconJson} />;
    if (name.endsWith('.md')) return <FileText size={14} className={styles.iconMd} />;
    if (name.endsWith('.rs')) return <FileCode size={14} className={styles.iconRust} />;
    if (name.endsWith('.py')) return <FileCode size={14} className={styles.iconPython} />;
    return <File size={14} className={styles.iconDefault} />;
  };

  /** The dashed guides for a row's ancestors. Absolute inside the row, so consecutive rows line up. */
  const guides = (depth: number) =>
    Array.from({ length: depth }, (_unused, level) => (
      <span
        key={level}
        className={styles.indentGuide}
        style={{ left: `${level * 12 + 14}px` }}
        aria-hidden="true"
      />
    ));

  const renderRow = (row: TreeRow) => {
    if (row.kind === 'note') {
      return (
        <div
          key={row.key}
          className={`${styles.note} ${row.tone === 'error' ? styles.noteError : ''}`}
          style={{ paddingLeft: `${row.depth * 12 + 26}px` }}
          // A failed read is an alert, not a quieter shade of empty.
          role={row.tone === 'error' ? 'alert' : undefined}
        >
          {guides(row.depth)}
          {row.tone === 'error' && <AlertCircle size={12} />}
          <span className={styles.noteText}>{row.text}</span>
        </div>
      );
    }

    const isFolder = row.kind === 'dir';
    // The one source of truth for the highlight. `read_dir` spells paths the OS way;
    // `activeFile` is canonical, so the comparison happens in canonical form.
    const isActive = !isFolder && canonicalPath(row.path) === state.activeFile;
    const activate = () => {
      if (isFolder) toggleFolder(row.path);
      else void actions.openPath(row.path);
    };

    return (
      <div
        key={row.key}
        className={`${styles.treeNode} ${isActive ? styles.active : ''}`}
        style={{ paddingLeft: `${row.depth * 12 + 8}px` }}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-expanded={isFolder ? row.expanded : undefined}
        aria-selected={isFolder ? undefined : isActive}
        tabIndex={0}
        title={row.path}
        onClick={activate}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          activate();
        }}
      >
        {guides(row.depth)}
        {isFolder ? (
          <>
            <div className={`${styles.chevron} ${row.expanded ? styles.open : ''}`}>
              <ChevronRight size={14} />
            </div>
            {row.expanded ? (
              <FolderOpen size={14} className={styles.iconFolder} />
            ) : (
              <Folder size={14} className={styles.iconFolder} />
            )}
          </>
        ) : (
          <div className={styles.fileIconSpacer}>{getFileIcon(row.name)}</div>
        )}
        <span className={styles.nodeName}>{row.name}</span>
      </div>
    );
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.title}>EXPLORER</span>
        <div className={styles.actions}>
          {/* Kept, and disabled, because there is no create-file path yet. A button
              that silently does nothing is the thing this panel was full of. */}
          <button
            className={styles.actionBtn}
            disabled
            title="New file: not implemented yet"
            aria-label="New file: not implemented yet"
          >
            <Plus size={14} />
          </button>
          <button
            className={styles.actionBtn}
            onClick={refresh}
            disabled={root === null}
            title="Re-read the folders from disk"
            aria-label="Refresh the file tree"
          >
            <Refresh size={14} />
          </button>
        </div>
      </div>

      {root === null ? (
        <div className={styles.emptyState}>
          <FolderOpen size={32} className={styles.emptyIcon} />
          <p>No folder opened</p>
          {/* The real OS picker, through the same action the welcome screen uses. */}
          <button className={styles.openBtn} onClick={() => void actions.openFolder()}>
            Open Folder
          </button>
        </div>
      ) : (
        <div className={styles.treeContainer}>
          <div className={styles.projectName} title={root}>
            <ChevronDown size={14} />
            <span>{basename(root) || root}</span>
          </div>
          <div className={styles.tree} role="tree" aria-label="Files">
            {rows.map(renderRow)}
          </div>
        </div>
      )}
    </div>
  );
}
