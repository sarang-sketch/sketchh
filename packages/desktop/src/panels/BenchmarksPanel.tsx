// Benchmarks reads the latest validated artifact. It NEVER runs a benchmark on mount.
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Clock, Refresh } from '../components/Icons'
import { useSketchClient } from '../lib/ClientProvider'
import type { BenchmarkReportResult } from '../lib/client'
import { useAppState } from '../state/AppState'
import styles from './BenchmarksPanel.module.css'

export function BenchmarksPanel() {
  const { projectRoot } = useAppState()
  const client = useSketchClient()
  const [result, setResult] = useState<BenchmarkReportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)

  const refresh = useCallback(async (root: string) => {
    const read = client.benchmarkReport
    if (read === undefined) return
    const ticket = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const answer = await read.call(client, { root })
      if (ticket === generation.current) setResult(answer)
    } catch (err) {
      if (ticket === generation.current) {
        setResult(null)
        setError(`The benchmark artifact could not be read: ${message(err)}`)
      }
    } finally {
      if (ticket === generation.current) setLoading(false)
    }
  }, [client])

  useEffect(() => {
    if (projectRoot === null) {
      setResult(null)
      setError(null)
      return
    }
    void refresh(projectRoot)
  }, [projectRoot, refresh])

  if (projectRoot === null) return <Frame><Empty title="No folder opened" detail="Benchmark reports live under the open project's .sketch/bench directory." /></Frame>
  if (client.benchmarkReport === undefined) return <Frame><Empty title="No engine behind this transport" detail={`The ${client.transport} transport cannot read benchmark artifacts. No sample result is shown.`} /></Frame>

  const report = result?.report ?? null
  return <Frame action={<button className={styles.refresh} onClick={() => void refresh(projectRoot)} disabled={loading}><Refresh size={12} />{loading ? 'Reading…' : 'Refresh'}</button>}>
    {error !== null && <div className={styles.error} role="alert"><AlertCircle size={13} />{error}</div>}
    {result !== null && report === null && <Empty title="No benchmark report yet" detail={result.note} />}
    {report !== null && <Report result={result!} />}
  </Frame>
}

function Report({ result }: { result: BenchmarkReportResult }) {
  const report = result.report!
  const metrics = report.metrics
  const label = `${report.model} + ${report.harness.id === 'sketch' ? 'Sketch' : 'naive'}`
  return <>
    <div className={styles.identity}>
      <strong>{label}</strong>
      <span>{report.provider} · harness {report.harness.id}@{report.harness.version}</span>
      <span>{new Date(report.createdAt).toLocaleString()}</span>
    </div>
    <p className={styles.note}>{result.note}</p>
    <div className={styles.metrics} aria-label="Benchmark metrics">
      <Metric label="Task completion" value={percent(metrics.taskCompletionRate)} />
      <Metric label="Build success" value={nullablePercent(metrics.buildSuccessRate)} />
      <Metric label="Test pass" value={nullablePercent(metrics.testPassRate)} />
      <Metric label="Manual edits" value={metrics.totalManualEdits === null ? 'not observed' : String(metrics.totalManualEdits)} />
      <Metric label="Mean time to completion" value={metrics.timeToCompletionMs === null ? 'no completion' : `${Math.round(metrics.timeToCompletionMs)} ms`} />
      <Metric label="Cost" value={metrics.totalCostUsd === null ? 'unknown' : `$${metrics.totalCostUsd.toFixed(6)}`} />
      <Metric label="pass@1" value={percent(metrics.passAt1)} />
      <Metric label={`pass@${report.budget.k}`} value={percent(metrics.passAtK)} />
    </div>
    <h3 className={styles.heading}>Fixed budget</h3>
    <p className={styles.detail}>{report.budget.k} attempts/case · {report.budget.maxCalls} calls · {report.budget.maxTokens} tokens · {report.budget.attemptTimeoutMs} ms/attempt · {report.budget.suiteTimeoutMs} ms/suite</p>
    <h3 className={styles.heading}>Pass distribution</h3>
    <ul className={styles.distribution} aria-label="Pass distribution">
      {metrics.passDistribution.map(bucket => <li key={bucket.passes}><span>{bucket.passes} of {report.budget.k} passes</span><strong>{bucket.cases} case(s)</strong></li>)}
    </ul>
    <p className={styles.path}>Artifact: {result.path}</p>
    <p className={styles.disclaimer}>Benchmark inputs are reported as model + harness. Compare the same model as “M + Sketch” versus “M + naive”; this panel never claims Sketch beats a model.</p>
  </>
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className={styles.metric}><span>{label}</span><strong>{value}</strong></div>
}

function Frame({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return <div className={styles.container}><div className={styles.header}><span><Clock size={15} /> Benchmarks</span>{action}</div><div className={styles.body}>{children}</div></div>
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return <div className={styles.empty}><strong>{title}</strong><p>{detail}</p></div>
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`
const nullablePercent = (value: number | null) => value === null ? 'not measured' : percent(value)
const message = (err: unknown) => err instanceof Error ? err.message : String(err)