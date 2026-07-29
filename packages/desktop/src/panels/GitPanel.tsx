// Source Control — the real one.
//
// WHAT THIS REPLACED: three module-level fixtures (`MOCK_STAGED`, `MOCK_CHANGES`,
// `MOCK_UNTRACKED`), a hardcoded branch chip reading `feature/new-ui`, and stage,
// unstage and commit buttons with no handlers at all. The rows are now whatever
// `git status --porcelain -b` reports for the open project, parsed by the engine
// (packages/core/src/tools/git.ts), and every button performs the operation it
// names (Requirements 14.6, 27.1).
//
// THE PANEL DOES NOT PARSE GIT AND DOES NOT SPAWN IT. It calls five methods on the
// client seam, so it works under the sidecar and under the browser dev bridge
// alike, and there is exactly one porcelain parser in the product.
//
// ── FOUR HONEST NOTHINGS, NOT ONE ───────────────────────────────────────────
//
// Requirement 27.3 asks for an honest empty state. There are four different
// nothings here and they are different answers:
//
//   no folder open      — nothing to do until a project is picked
//   not a repository    — the folder is real; git is not initialised in it, so
//                         staging and committing are meaningless, not merely empty
//   clean               — a real repository with a branch and no changes
//   an error            — git missing, a refused root, a dead engine: named, with
//                         the reason, never drawn as "no changes" (Req 27.5)
//
// Validates: Requirements 14.6, 27.1, 27.3, 27.5, 13.8

import { useCallback, useEffect, useState } from 'react';
import { GitBranch, ChevronDown, Plus, Minus, Check, Refresh, AlertCircle } from '../components/Icons';
import { useGit } from '../git/GitProvider';
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
    case 'U':
      return styles.statusU;
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
      'This folder has no .git directory, so there is no branch, no history, and nothing to stage. Run git init in it to start tracking changes.',
  },
  clean: {
    title: 'No changes',
    detail: 'The working tree matches the last commit.',
  },
};

export function GitPanel() {
  const git = useGit();
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState<{ path: string; section: GitSection } | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);

  const status = git.status;
  const empty = emptyReason(status, git.root);
  const gate = commitGate(status, message);

  // The selected row's diff. Reloaded whenever the selection changes or the status
  // does, so the pane cannot keep showing a hunk that has since been staged.
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
    // `git.diff` is stable per root; `status` is the reason to re-read.
  }, [selected, status, git]);

  const onCommit = useCallback(async () => {
    if (!gate.ok) return;
    const committed = await git.commit(message);
    // The message is cleared only when the commit actually happened; otherwise the
    // user would have to retype it after a failure they did not cause.
    if (committed) {
      setMessage('');
      setSelected(null);
    }
  }, [gate.ok, git, message]);

  const renderRow = (row: GitRow) => {
    const isStaged = row.section === 'staged';
    const isSelected = selected?.path === row.path && selected.section === row.section;
    return (
      <div
        key={`${row.section}:${row.path}`}
        className={`${styles.fileRow} ${isSelected ? styles.fileRowSelected : ''}`}
        onClick={() => setSelected({ path: row.path, section: row.section })}
        title={row.origPath === undefined ? row.path : `${row.origPath} → ${row.path}`}
      >
        <div className={styles.fileInfo}>
          <span className={`${styles.statusIcon} ${statusClassFor(row.letter)}`}>{row.letter}</span>
          <span className={styles.fileName}>{row.name}</span>
          <span className={styles.filePath}>
            {row.origPath === undefined ? row.dir : `${row.dir} ← ${row.origPath}`}
          </span>
        </div>
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
      </div>
    );
  };

  const section = (title: string, rows: GitRow[]) =>
    rows.length === 0 ? null : (
      <div className={styles.section} key={title}>
        <div className={styles.sectionHeader}>
          <ChevronDown size={14} />
          <span>{title}</span>
          <span className={styles.badge}>{rows.length}</span>
        </div>
        {rows.map(renderRow)}
      </div>
    );

  const branch = branchLabel(status);
  const tracking = trackingLabel(status);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.branchInfo}>
          <GitBranch size={14} />
          {/* No placeholder branch: until a real status arrives there is no name. */}
          <span className={styles.branchName}>{branch ?? 'no branch yet'}</span>
          {tracking !== null && <span className={styles.tracking}>{tracking}</span>}
        </div>
        <button
          className={styles.iconBtn}
          onClick={() => void git.refresh()}
          disabled={git.busy || git.root === null}
          aria-label="Refresh git status"
          title="Refresh git status"
        >
          <Refresh size={14} />
        </button>
      </div>

      {git.error !== null && (
        <div className={styles.error} role="alert">
          <AlertCircle size={14} />
          <span>
            <strong>git</strong> {git.error}
          </span>
        </div>
      )}

      <div className={styles.commitSection}>
        <textarea
          className={styles.commitInput}
          placeholder="Message (Cmd+Enter to commit)"
          aria-label="Commit message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void onCommit();
          }}
        />
        <button
          className={styles.commitBtn}
          onClick={() => void onCommit()}
          // An empty message is refused before anything is spawned, here AND in the
          // engine. The title says which precondition is missing.
          disabled={!gate.ok || git.busy}
          title={gate.ok ? 'Commit staged changes' : gate.reason}
        >
          <Check size={14} /> Commit
        </button>
        {!gate.ok && git.root !== null && <div className={styles.hint}>{gate.reason}</div>}
      </div>

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
            {section('Merge Conflicts', conflictedRows(status))}
            {section('Staged Changes', stagedRows(status))}
            {section('Changes', changedRows(status))}
            {section('Untracked', untrackedRows(status))}
          </>
        )}
      </div>

      {selected !== null && (
        <div className={styles.diffPane}>
          <div className={styles.diffHeader}>
            <span className={styles.diffPath}>
              {selected.path}
              {selected.section === 'staged' ? ' (staged)' : ''}
            </span>
            <button
              className={styles.iconBtn}
              onClick={() => setSelected(null)}
              aria-label="Close diff"
              title="Close diff"
            >
              <Minus size={14} />
            </button>
          </div>
          <pre className={styles.diffBody}>
            {diffBusy
              ? 'Loading diff…'
              : selected.section === 'untracked'
                ? 'Untracked: this file is not in the index yet, so git has no diff for it. Stage it to see one.'
                : diff === null
                  ? 'No diff available.'
                  : diff.trim() === ''
                    ? 'No textual change in this file.'
                    : diff}
          </pre>
        </div>
      )}
    </div>
  );
}
