// UI Doctor — real accessibility checks against the live page.
//
// Runs against `document` (the IDE's own page) by default, or a supplied root
// for embedding. Every result comes from querying that DOM and from computed
// styles; there is no score and no axe dependency. Contrast is a luminance
// estimate and is labelled as one.

import { useCallback, useState } from 'react'
import { AlertCircle, Check, Info, Refresh, Warning } from '../components/Icons'
import { runUiChecks, type UiCheckResult, type UiCheckSeverity } from './uiDoctor'
import styles from './ToolsPanels.module.css'

export interface UiDoctorProps {
  /** Root to check; defaults to the current document. */
  root?: Document | HTMLElement
}

export function UiDoctor({ root }: UiDoctorProps) {
  const [results, setResults] = useState<UiCheckResult[] | null>(null)
  const [ranAt, setRanAt] = useState<number | null>(null)

  const run = useCallback(() => {
    setResults(runUiChecks(root ?? document))
    setRanAt(Date.now())
  }, [root])

  const errors = results?.filter((r) => r.severity === 'error').length ?? 0
  const warns = results?.filter((r) => r.severity === 'warn').length ?? 0
  const passes = results?.filter((r) => r.severity === 'pass').length ?? 0

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <Check size={16} />
          <span>UI Doctor</span>
        </div>
        <button type="button" className={styles.button} onClick={run}>
          <Refresh size={12} />
          <span>{results === null ? 'Run checks' : 'Re-check'}</span>
        </button>
      </div>
      <div className={styles.body}>
        {results === null ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyText}>No checks run yet</div>
            <p className={styles.emptySubtext}>
              Checks the live page for images without alt text, buttons without an
              accessible name, inputs without a label, a missing document title or
              page language, and low-contrast text (an estimate from computed styles).
            </p>
          </div>
        ) : (
          <>
            <p className={styles.note} role="status">
              {errors} error(s), {warns} warning(s), {passes} check(s) passed
              {ranAt !== null ? ` · checked at ${new Date(ranAt).toLocaleTimeString()}` : ''}.
              Contrast figures are estimates — computed colour against the nearest
              solid background; background images and gradients are not accounted for.
            </p>
            {results.length === 0 ? (
              <div className={styles.emptyState}>
                <div className={styles.emptyText}>No results</div>
              </div>
            ) : (
              <ul className={styles.list} aria-label="UI check results">
                {results.map((result, i) => (
                  <li key={`${result.id}-${i}`} className={rowClass(result.severity)}>
                    <div className={styles.rowTitle}>
                      {severityIcon(result.severity)} {result.label}{' '}
                      <span className={badgeClass(result.severity)}>{result.severity}</span>
                    </div>
                    <p className={styles.rowDetail}>{result.detail}</p>
                    {result.selector !== undefined && (
                      <p className={styles.rowMeta}>{result.selector}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function rowClass(severity: UiCheckSeverity): string {
  return severity === 'error'
    ? styles.rowError
    : severity === 'warn'
      ? styles.rowWarn
      : styles.rowPass
}

function badgeClass(severity: UiCheckSeverity): string {
  return severity === 'error'
    ? styles.badgeError
    : severity === 'warn'
      ? styles.badgeWarn
      : styles.badgePass
}

function severityIcon(severity: UiCheckSeverity) {
  return severity === 'error' ? (
    <AlertCircle size={12} />
  ) : severity === 'warn' ? (
    <Warning size={12} />
  ) : (
    <Info size={12} />
  )
}
