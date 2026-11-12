// Source Control — the real one.
//
// The rows are whatever `git status --porcelain -b` reports for the open project,
// parsed by the engine (packages/core/src/tools/git.ts), and every button performs the
// operation it names (Requirements 14.6, 27.1). THE PANEL DOES NOT PARSE GIT AND DOES
// NOT SPAWN IT: it calls methods on the client seam through the window's one git owner.
//
// What a source-control view is expected to do, and does here: stage and unstage one
// file or all of them, discard a file's edits (a tracked file is restored by git; an
// untracked one goes to the trash), commit — or, with nothing staged, stage everything
// and commit after asking — write the commit message with the connected model, switch
// and create branches, pull, push (publishing a new branch), fetch, show a coloured diff
// for the selected file, and list recent commits.
//
// ── FOUR HONEST NOTHINGS, NOT ONE ───────────────────────────────────────────
//
//   no folder open      — nothing to do until a project is picked
//   not a repository    — the folder is real; git is not initialised in it
//   clean               — a real repository with a branch and no changes
//   an error            — git missing, a refused root, a dead engine: named, with
//                         the reason, never drawn as "no changes" (Req 27.5)
//
// Validates: Requirements 14.6, 27.1, 27.3, 27.5, 13.8

import { useCallback, useEffect, useState } from 'react';
import {
  GitBranch, ChevronDown, ChevronRight, Plus, Minus, Check, Refresh, AlertCircle, Undo, Sparkles,
  ArrowUp, ArrowDown, GitCommit, FileCode, Diff,
} from '../components/Icons';
import { useConfirm } from '../components/ConfirmDialog';
import { ContextMenu, type ContextMenuItem } from '../components/ContextMenu';
import { useGit } from '../git/GitProvider';
import { requestDiff, type DiffKind } from '../editor/DiffView';
import {
  branchLabel,
  changedRows,
  commitGate,
  conflictedRows,
  emptyReason,
  stagedRows,
  trackingLabel,
  untrackedRows,
  type GitRow,
  type GitSection,
} from '../git/gitStatus';
import { useFileActions } from '../editor/useFileActions';
import { toAbsolutePath } from '../editor/paths';
import type { GitCommitSummary } from '../lib/client';
import styles from './GitPanel.module.css';

/** The gutter colour for a porcelain letter. Unknown letters get the muted class. */
function statusClassFor(letter: string): string {
  switch (letter[0]) {
    case 'M':
      return styles.statusM;
    case 'A':
      return styles.statusA;
    case 'D':
      return styles.statusD;
    case 'R':
    case 'C':
      return styles.statusA;
    default:
      return styles.statusU;
  }
}

const EMPTY_STATE: Record<string, { title: string; detail: string }> = {
  'no-project': {
    title: 'No folder open',
    detail: 'Open a project folder to see its source control status.',
  },
  'not-a-repo': {
    title: 'Not a git repository',
    detail:
      'This folder has no .git directory, so there is no branch, no history, and nothing to stage. Run git init in the terminal to start tracking changes.',
  },
  clean: {
    title: 'No changes',
    detail: 'The working tree matches the last commit.',
  },
};

/** A unified diff, one line per row, coloured by what the line is. Text nodes only. */
function DiffText({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  return (
    <>
      {lines.map((line, index) => {
        const cls = line.startsWith('+++') || line.startsWith('---')
          ? styles.diffMeta
          : line.startsWith('+')
            ? styles.diffAdd
            : line.startsWith('-')
              ? styles.diffDel
              : line.startsWith('@@')
                ? styles.diffHunk
                : line.startsWith('diff ') || line.startsWith('index ')
                  ? styles.diffMeta
                  : undefined;
        return (
          <div key={index} className={cls}>
            {line === '' ? ' ' : line}
          </div>
        );
      })}
    </>
  );
}

export function GitPanel() {
  const git = useGit();
  const fileActions = useFileActions();
  const confirm = useConfirm();
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState<{ path: string; section: GitSection } | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [branchMenu, setBranchMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [newBranch, setNewBranch] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<GitCommitSummary[] | null>(null);
  const [drafting, setDrafting] = useState(false);

  const status = git.status;
  const empty = emptyReason(status, git.root);
  const staged = status === null ? [] : stagedRows(status);
  const changed = status === null ? [] : changedRows(status);
  const untracked = status === null ? [] : untrackedRows(status);
  const conflicted = status === null ? [] : conflictedRows(status);
  const nothingStaged = staged.length === 0 && (changed.length > 0 || untracked.length > 0);
  // "Commit" with nothing staged stages everything first (after asking), as editors do.
  const gate = nothingStaged && message.trim() !== '' && conflicted.length === 0
    ? { ok: true, reason: '' }
    : commitGate(status, message);

  // The selected row's diff, reloaded whenever the selection or the status changes.
  useEffect(() => {
    if (selected === null) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setDiffBusy(true);
    void git
      .diff({ path: selected.path, staged: selected.section === 'staged' })
      .then((text) => {
        if (!cancelled) setDiff(text);
      })
      .finally(() => {
        if (!cancelled) setDiffBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, status, git]);

  // Recent commits, re-read when the branch or the commit count could have changed. A
  // commit always empties what was staged (or, with `-a`, what was modified), so those
  // counts are part of the key: without them a commit on a branch with no upstream that
  // left other changes behind changed nothing here, and the list stayed stale.
  const head = `${status?.branch ?? ''}:${status?.ahead ?? 0}:${status?.behind ?? 0}:${status?.clean ?? ''}:${status?.staged.length ?? 0}:${status?.unstaged.length ?? 0}`;
  useEffect(() => {
    if (git.root === null || status === null || !status.isRepo) {
      setHistory(null);
      return;
    }
    let cancelled = false;
    void git.log(15).then((commits) => {
      if (!cancelled) setHistory(commits);
    });
    return () => {
      cancelled = true;
    };
    // `git.log` is stable per root; `head` is the reason to re-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [git.root, head]);

  const onCommit = useCallback(async () => {
    if (!gate.ok) return;
    if (nothingStaged) {
      const choice = await confirm({
        title: 'Stage all changes and commit?',
        message: 'Nothing is staged. Sketch can stage every change (including new files) and commit them together.',
        buttons: [
          { id: 'yes', label: 'Stage All and Commit', kind: 'primary' },
          { id: 'cancel', label: 'Cancel' },
        ],
        cancelId: 'cancel',
      });
      if (choice !== 'yes') return;
      await git.stage([...changed, ...untracked].map((r) => r.path));
    }
    const committed = await git.commit(message);
    // Cleared only when the commit happened, so a failure never loses the message.
    if (committed) {
      setMessage('');
      setSelected(null);
    }
  }, [changed, confirm, gate.ok, git, message, nothingStaged, untracked]);

  const discard = async (rows: GitRow[]) => {
    if (rows.length === 0) return;
    const tracked = rows.filter((r) => r.section === 'changes');
    const fresh = rows.filter((r) => r.section === 'untracked');
    const one = rows.length === 1 ? rows[0]!.name : `${rows.length} files`;
    const choice = await confirm({
      title: `Discard changes to ${one}?`,
      message:
        fresh.length > 0
          ? 'Edits to tracked files are thrown away, and new files are moved to the trash. Staged changes are kept.'
          : 'Your edits are thrown away and the file goes back to its last staged or committed version. This cannot be undone.',
      buttons: [
        { id: 'discard', label: 'Discard', kind: 'danger' },
        { id: 'cancel', label: 'Cancel' },
      ],
      cancelId: 'cancel',
    });
    if (choice !== 'discard') return;
    if (tracked.length > 0) {
      await git.discard(tracked.map((r) => r.path));
      // An open buffer of a discarded file now disagrees with the disk: reload it.
      if (git.root !== null) {
        for (const row of tracked) void fileActions.reloadFromDisk(toAbsolutePath(git.root, row.path));
      }
    }
    if (fresh.length > 0 && git.root !== null) {
      for (const row of fresh) {
        // Each goes through the Explorer's delete, which asks once more and uses the trash.
        // eslint-disable-next-line no-await-in-loop
        await fileActions.deletePath(toAbsolutePath(git.root, row.path), false);
      }
      void git.refresh();
    }
  };

  const openBranchMenu = async (event: React.MouseEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const result = await git.branches();
    const items: ContextMenuItem[] = [
      { id: 'new', label: '+ Create New Branch…', run: () => setNewBranch('') },
      'separator',
      ...(result?.branches ?? []).map((b) => ({
        id: `b:${b.name}`,
        label: `${b.current ? '● ' : ''}${b.name}`,
        ...(b.upstream !== null ? { hint: b.upstream } : {}),
        disabled: b.current,
        run: () => void git.switchBranch(b.name),
      })),
    ];
    if (result === null) items.push({ id: 'none', label: 'Branches could not be listed', disabled: true, run: () => {} });
    setBranchMenu({ x: rect.left, y: rect.bottom + 2, items });
  };

  const draft = async () => {
    setDrafting(true);
    try {
      const text = await git.suggestMessage();
      if (text !== null) setMessage(text);
    } finally {
      setDrafting(false);
    }
  };

  /** The side-by-side comparison for a row, in the editor. Conflicts open as files instead. */
  const diffKindOf = (row: GitRow): DiffKind | null =>
    row.section === 'conflicted' ? null : row.section === 'staged' ? 'staged' : row.letter === 'D' ? 'deleted' : 'changes';
  const openChanges = (row: GitRow) => {
    const kind = diffKindOf(row);
    if (git.root === null || kind === null) return;
    requestDiff({ path: toAbsolutePath(git.root, row.path), kind });
  };

  const renderRow = (row: GitRow) => {
    const isStaged = row.section === 'staged';
    const isSelected = selected?.path === row.path && selected.section === row.section;
    const canDiscard = row.section === 'changes' || row.section === 'untracked';
    const canCompare = diffKindOf(row) !== null;
    return (
      <div
        key={`${row.section}:${row.path}`}
        className={`${styles.fileRow} ${isSelected ? styles.fileRowSelected : ''}`}
        onClick={() => setSelected({ path: row.path, section: row.section })}
        onDoubleClick={() => {
          if (canCompare) openChanges(row);
          else if (git.root !== null) void fileActions.openPath(toAbsolutePath(git.root, row.path));
        }}
        title={
          row.origPath === undefined
            ? `${row.path} — double-click to ${canCompare ? 'compare side by side' : 'open'}`
            : `${row.origPath} → ${row.path}`
        }
      >
        <div className={styles.fileInfo}>
          <span className={`${styles.statusIcon} ${statusClassFor(row.letter)}`}>{row.letter}</span>
          <span className={styles.fileName}>{row.name}</span>
          <span className={styles.filePath}>
            {row.origPath === undefined ? row.dir : `${row.dir} ← ${row.origPath}`}
          </span>
        </div>
        <div className={styles.rowActions}>
          {canCompare && (
            <button
              className={styles.actionBtn}
              aria-label={`Open changes to ${row.path}`}
              title="Open changes side by side"
              onClick={(event) => {
                event.stopPropagation();
                openChanges(row);
              }}
            >
              <Diff size={13} />
            </button>
          )}
          {!(row.letter === 'D' && row.section !== 'staged') && (
            <button
              className={styles.actionBtn}
              aria-label={`Open ${row.path}`}
              title="Open file"
              onClick={(event) => {
                event.stopPropagation();
                if (git.root !== null) void fileActions.openPath(toAbsolutePath(git.root, row.path));
              }}
            >
              <FileCode size={13} />
            </button>
          )}
          {canDiscard && (
            <button
              className={styles.actionBtn}
              disabled={git.busy}
              aria-label={`Discard changes to ${row.path}`}
              title={row.section === 'untracked' ? 'Delete this new file (to the trash)' : 'Discard changes'}
              onClick={(event) => {
                event.stopPropagation();
                void discard([row]);
              }}
            >
              <Undo size={13} />
            </button>
          )}
          {row.section !== 'conflicted' && (
            <button
              className={styles.actionBtn}
              disabled={git.busy}
              aria-label={`${isStaged ? 'Unstage' : 'Stage'} ${row.path}`}
              title={`${isStaged ? 'Unstage' : 'Stage'} ${row.path}`}
              onClick={(event) => {
                // The row itself opens the diff; the button must not do both.
                event.stopPropagation();
                void (isStaged ? git.unstage([row.path]) : git.stage([row.path]));
              }}
            >
              {isStaged ? <Minus size={14} /> : <Plus size={14} />}
            </button>
          )}
        </div>
      </div>
    );
  };

  const section = (title: string, rows: GitRow[], actions?: { stageAll?: boolean; unstageAll?: boolean; discardAll?: boolean }) => {
    if (rows.length === 0) return null;
    const isCollapsed = collapsed.has(title);
    return (
      <div className={styles.section} key={title}>
        <div className={styles.sectionHeader}>
          <button
            type="button"
            className={styles.sectionToggle}
            onClick={() =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(title)) next.delete(title);
                else next.add(title);
                return next;
              })
            }
          >
            {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            <span>{title}</span>
          </button>
          <div className={styles.sectionActions}>
            {actions?.discardAll && (
              <button className={styles.actionBtn} disabled={git.busy} onClick={() => void discard(rows)} title="Discard all changes in this section" aria-label={`Discard all ${title}`}>
                <Undo size={13} />
              </button>
            )}
            {actions?.stageAll && (
              <button className={styles.actionBtn} disabled={git.busy} onClick={() => void git.stage(rows.map((r) => r.path))} title="Stage all" aria-label={`Stage all ${title}`}>
                <Plus size={14} />
              </button>
            )}
            {actions?.unstageAll && (
              <button className={styles.actionBtn} disabled={git.busy} onClick={() => void git.unstage(rows.map((r) => r.path))} title="Unstage all" aria-label="Unstage all">
                <Minus size={14} />
              </button>
            )}
            <span className={styles.badge}>{rows.length}</span>
          </div>
        </div>
        {!isCollapsed && rows.map(renderRow)}
      </div>
    );
  };

  const branch = branchLabel(status);
  const tracking = trackingLabel(status);
  const isRepo = status?.isRepo === true;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <button
          type="button"
          className={styles.branchInfo}
          onClick={(e) => void openBranchMenu(e)}
          disabled={!isRepo || git.busy}
          title="Switch or create a branch"
        >
          <GitBranch size={14} />
          {/* No placeholder branch: until a real status arrives there is no name. */}
          <span className={styles.branchName}>{branch ?? 'no branch yet'}</span>
          {isRepo && <ChevronDown size={12} />}
          {tracking !== null && <span className={styles.tracking}>{tracking}</span>}
        </button>
        <div className={styles.headerActions}>
          <button
            className={styles.iconBtn}
            onClick={() => void git.sync('pull')}
            disabled={!isRepo || git.busy || status?.upstream === null}
            aria-label="Pull"
            title={status?.upstream === null ? 'No upstream to pull from yet' : `Pull${status && status.behind > 0 ? ` (${status.behind} behind)` : ''} — fast-forward only`}
          >
            <ArrowDown size={14} />
            {status !== null && status.behind > 0 && <span className={styles.count}>{status.behind}</span>}
          </button>
          <button
            className={styles.iconBtn}
            onClick={() => void git.sync('push')}
            disabled={!isRepo || git.busy || branch === null || status?.detached === true}
            aria-label="Push"
            title={status?.upstream === null ? 'Publish this branch (push and set its upstream)' : `Push${status && status.ahead > 0 ? ` (${status.ahead} ahead)` : ''}`}
          >
            <ArrowUp size={14} />
            {status !== null && status.ahead > 0 && <span className={styles.count}>{status.ahead}</span>}
          </button>
          <button
            className={styles.iconBtn}
            onClick={() => void (isRepo ? git.sync('fetch').then(() => git.refresh()) : git.refresh())}
            disabled={git.busy || git.root === null}
            aria-label="Refresh git status"
            title={isRepo ? 'Fetch and refresh' : 'Refresh git status'}
          >
            <Refresh size={14} />
          </button>
        </div>
      </div>

      {newBranch !== null && (
        <form
          className={styles.newBranch}
          onSubmit={(e) => {
            e.preventDefault();
            const name = newBranch.trim();
            setNewBranch(null);
            if (name !== '') void git.switchBranch(name, true);
          }}
        >
          <input
            autoFocus
            className={styles.newBranchInput}
            placeholder="New branch name, e.g. feature/login"
            aria-label="New branch name"
            value={newBranch}
            onChange={(e) => setNewBranch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setNewBranch(null);
            }}
            onBlur={() => setNewBranch(null)}
          />
        </form>
      )}

      {branchMenu !== null && (
        <ContextMenu x={branchMenu.x} y={branchMenu.y} items={branchMenu.items} onClose={() => setBranchMenu(null)} label="Branches" />
      )}

      {git.error !== null && (
        <div className={styles.error} role="alert">
          <AlertCircle size={14} />
          <span>
            <strong>git</strong> {git.error}
          </span>
        </div>
      )}
      {git.error === null && git.lastSync !== null && Date.now() - git.lastSync.at < 60_000 && (
        <div className={styles.syncNote}>
          <Check size={12} /> {git.lastSync.op === 'push' ? 'Pushed' : git.lastSync.op === 'pull' ? 'Pulled' : 'Fetched'}.
        </div>
      )}

      {isRepo && (
        <div className={styles.commitSection}>
          <div className={styles.commitBox}>
            <textarea
              className={styles.commitInput}
              placeholder="Message (Ctrl+Enter to commit)"
              aria-label="Commit message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void onCommit();
              }}
            />
            <button
              type="button"
              className={styles.draftBtn}
              onClick={() => void draft()}
              disabled={drafting || git.busy || (staged.length === 0 && changed.length === 0)}
              title="Write the message with AI, from the staged changes"
              aria-label="Write the commit message with AI"
            >
              <Sparkles size={13} className={drafting ? styles.spin : undefined} />
            </button>
          </div>
          <button
            className={styles.commitBtn}
            onClick={() => void onCommit()}
            // An empty message is refused before anything is spawned, here AND in the engine.
            disabled={!gate.ok || git.busy}
            title={gate.ok ? (nothingStaged ? 'Stage all changes and commit' : 'Commit staged changes') : gate.reason}
          >
            <Check size={14} /> {nothingStaged ? 'Commit All' : 'Commit'}
          </button>
          {!gate.ok && git.root !== null && <div className={styles.hint}>{gate.reason}</div>}
        </div>
      )}

      <div className={styles.changesList}>
        {empty !== null ? (
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>{EMPTY_STATE[empty]!.title}</div>
            <div className={styles.emptyDetail}>{EMPTY_STATE[empty]!.detail}</div>
          </div>
        ) : status === null ? (
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>{git.busy ? 'Reading git status…' : 'No status yet'}</div>
          </div>
        ) : (
          <>
            {section('Merge Conflicts', conflicted)}
            {section('Staged Changes', staged, { unstageAll: true })}
            {section('Changes', changed, { stageAll: true, discardAll: true })}
            {section('Untracked', untracked, { stageAll: true })}
          </>
        )}

        {history !== null && history.length > 0 && (
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <button
                type="button"
                className={styles.sectionToggle}
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has('history')) next.delete('history');
                    else next.add('history');
                    return next;
                  })
                }
              >
                {collapsed.has('history') ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                <span>Recent Commits</span>
              </button>
            </div>
            {!collapsed.has('history') &&
              history.map((commit) => (
                <div key={commit.hash} className={styles.commitRow} title={`${commit.hash} · ${commit.author} · ${commit.when}`}>
                  <GitCommit size={12} className={styles.commitIcon} />
                  <span className={styles.commitSubject}>{commit.subject}</span>
                  <span className={styles.commitWhen}>{commit.when}</span>
                </div>
              ))}
          </div>
        )}
      </div>

      {selected !== null && (
        <div className={styles.diffPane}>
          <div className={styles.diffHeader}>
            <span className={styles.diffPath}>
              {selected.path}
              {selected.section === 'staged' ? ' (staged)' : ''}
            </span>
            {(() => {
              const row = [...staged, ...changed, ...untracked].find(
                (r) => r.path === selected.path && r.section === selected.section,
              );
              return row !== undefined && diffKindOf(row) !== null ? (
                <button
                  className={styles.iconBtn}
                  onClick={() => openChanges(row)}
                  aria-label="Open side by side"
                  title="Open side by side in the editor"
                >
                  <Diff size={14} />
                </button>
              ) : null;
            })()}
            <button className={styles.iconBtn} onClick={() => setSelected(null)} aria-label="Close diff" title="Close diff">
              <Minus size={14} />
            </button>
          </div>
          <pre className={styles.diffBody}>
            {diffBusy ? (
              'Loading diff…'
            ) : selected.section === 'untracked' ? (
              'Untracked: this file is not in the index yet, so git has no diff for it. Stage it to see one.'
            ) : diff === null ? (
              'No diff available.'
            ) : diff.trim() === '' ? (
              'No textual change in this file.'
            ) : (
              <DiffText text={diff} />
            )}
          </pre>
        </div>
      )}
    </div>
  );
}
