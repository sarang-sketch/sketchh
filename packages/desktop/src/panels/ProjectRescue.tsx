// Project Rescue — findings about the open project, from a file tree the
// caller supplies. Props-driven: the client seam has no method that returns
// file sizes or contents (`projectFiles` returns paths only), so the
// coordinator builds the tree (e.g. from the engine's file index plus reads)
// and passes it in. Secret files are named, never quoted.

import { useMemo } from 'react'
import { AlertCircle, Info, Warning } from '../components/Icons'
import { analyzeProject, type RescueFile, type RescueSeverity } from './projectRescue'
import styles from './ToolsPanels.module.css'

export interface ProjectRescueProps {
  files: RescueFile[]
  /** `git status` text when the caller has it (client.gitStatus result). */
  gitStatus?: string
  /** Directory paths known to exist; a file list alone cannot show an empty dir. */
  dirs?: string[]
}

const SEVERITY_ORDER: RescueSeverity[] = ['error', 'warn', 'info']
const SEVERITY_LABEL: Record<RescueSeverity, string> = {
  error: 'Errors',
  warn: 'Warnings',
  info: 'Notes',
}

export function ProjectRescue({ files, gitStatus, dirs }: ProjectRescueProps) {
  const analysis = useMemo(
    () => analyzeProject({ files, ...(gitStatus !== undefined ? { gitStatus } : {}), dirs }),
    [files, gitStatus, dirs],
  )

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <Warning size={16} />
          <span>Project Rescue</span>
        </div>
      </div>
      <div className={styles.body}>
        {files.length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyText}>No files to analyse</div>
            <p className={styles.emptySubtext}>
              The caller has not supplied a project file tree yet. Analysis runs on the
              files passed in — paths, sizes, and contents where available.
            </p>
          </div>
        ) : (
          <>
            <p className={styles.note} role="status">
              {analysis.summary.total === 0
                ? `Checked ${files.length} file(s): no issues found.`
                : `Checked ${files.length} file(s): ${analysis.summary.error} error(s), ${analysis.summary.warn} warning(s), ${analysis.summary.info} note(s).`}
            </p>
            {analysis.summary.total === 0 ? (
              <div className={styles.emptyState}>
                <div className={styles.emptyText}>No issues found</div>
                <p className={styles.emptySubtext}>
                  Nothing in the supplied tree tripped a check. Checks cover lockfiles,
                  files over 1 MB, TODO/FIXME markers, extensionless or binary files,
                  empty src directories, and .env files.
                </p>
              </div>
            ) : (
              SEVERITY_ORDER.map((severity) => {
                const group = analysis.findings.filter((f) => f.severity === severity)
                if (group.length === 0) return null
                return (
                  <section key={severity} aria-label={SEVERITY_LABEL[severity]}>
                    <h3 className={styles.sectionTitle}>
                      {SEVERITY_LABEL[severity]} ({group.length})
                    </h3>
                    <ul className={styles.list}>
                      {group.map((finding, i) => (
                        <li key={`${finding.title}-${i}`} className={rowClass(finding.severity)}>
                          <div className={styles.rowTitle}>
                            {severityIcon(finding.severity)} {finding.title}
                          </div>
                          <p className={styles.rowDetail}>{finding.detail}</p>
                          {finding.file !== undefined && (
                            <p className={styles.rowMeta}>{finding.file}</p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                )
              })
            )}
          </>
        )}
      </div>
    </div>
  )
}

function rowClass(severity: RescueSeverity): string {
  return severity === 'error' ? styles.rowError : severity === 'warn' ? styles.rowWarn : styles.rowInfo
}

function severityIcon(severity: RescueSeverity) {
  return severity === 'error' ? (
    <AlertCircle size={12} />
  ) : severity === 'warn' ? (
    <Warning size={12} />
  ) : (
    <Info size={12} />
  )
}
