// API Lab — a real HTTP request lab.
//
// Sends with the browser's `fetch` and an AbortController, so the timeout is a
// real abort, not a faked delay. History keeps method + URL + status only, in
// localStorage (max 20): header values and request bodies are never stored,
// and sensitive header names are scrubbed before anything is kept.

import { useState } from 'react'
import { AlertCircle, Send, Trash } from '../components/Icons'
import {
  clearHistory,
  executeRequest,
  MAX_BODY_CHARS,
  pushHistory,
  readHistory,
  rowsToHeaders,
  truncateBody,
  type ApiHistoryEntry,
  type ApiResponse,
  type HeaderRow,
  type HttpMethod,
} from './apiLab'
import styles from './ToolsPanels.module.css'

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const DEFAULT_TIMEOUT_MS = 10_000

export function ApiLab() {
  const [method, setMethod] = useState<HttpMethod>('GET')
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState<HeaderRow[]>([{ key: '', value: '' }])
  const [body, setBody] = useState('')
  const [timeoutMs, setTimeoutMs] = useState(String(DEFAULT_TIMEOUT_MS))
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [response, setResponse] = useState<ApiResponse | null>(null)
  const [history, setHistory] = useState<ApiHistoryEntry[]>(() => readHistory())

  const setHeader = (index: number, patch: Partial<HeaderRow>) => {
    setHeaders((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const send = async () => {
    const trimmedUrl = url.trim()
    if (trimmedUrl === '') {
      setError('Enter a URL to send a request to.')
      return
    }
    let parsedUrl: URL
    try {
      parsedUrl = new URL(trimmedUrl)
    } catch {
      setError(`“${trimmedUrl}” is not a valid URL (include the scheme, e.g. https://).`)
      return
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      setError('Only http:// and https:// URLs are supported.')
      return
    }
    const timeout = Number(timeoutMs)
    if (!Number.isFinite(timeout) || timeout <= 0) {
      setError('Timeout must be a positive number of milliseconds.')
      return
    }
    setError(null)
    setResponse(null)
    setSending(true)
    try {
      const answer = await executeRequest({
        method,
        url: trimmedUrl,
        headers: rowsToHeaders(headers),
        body: method === 'GET' ? undefined : body,
        timeoutMs: timeout,
      })
      setResponse(answer)
      // History stores URL + method + status only — never headers or bodies.
      setHistory(pushHistory({ method, url: trimmedUrl, status: answer.status, at: Date.now() }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(`Request failed: ${message}`)
      setHistory(pushHistory({ method, url: trimmedUrl, status: null, at: Date.now() }))
    } finally {
      setSending(false)
    }
  }

  const truncated = response !== null ? truncateBody(response.body) : null

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <Send size={16} />
          <span>API Lab</span>
        </div>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={() => void send()}
          disabled={sending}
        >
          <Send size={12} />
          <span>{sending ? 'Sending…' : 'Send'}</span>
        </button>
      </div>
      <div className={styles.body}>
        {error !== null && (
          <div className={styles.error} role="alert">
            <AlertCircle size={13} />
            <span>{error}</span>
          </div>
        )}

        <div className={styles.formRow}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="api-lab-method">Method</label>
            <select
              id="api-lab-method"
              className={styles.select}
              value={method}
              onChange={(e) => setMethod(e.target.value as HttpMethod)}
            >
              {METHODS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="api-lab-timeout">Timeout (ms)</label>
            <input
              id="api-lab-timeout"
              className={styles.input}
              value={timeoutMs}
              inputMode="numeric"
              onChange={(e) => setTimeoutMs(e.target.value)}
            />
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="api-lab-url">URL</label>
          <input
            id="api-lab-url"
            className={styles.input}
            value={url}
            placeholder="https://api.example.com/items"
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>

        <h3 className={styles.sectionTitle}>Headers</h3>
        {headers.map((row, i) => (
          <div className={styles.formRow} key={i}>
            <input
              className={styles.input}
              aria-label={`Header ${i + 1} name`}
              placeholder="Name"
              value={row.key}
              onChange={(e) => setHeader(i, { key: e.target.value })}
            />
            <input
              className={styles.input}
              aria-label={`Header ${i + 1} value`}
              placeholder="Value"
              value={row.value}
              onChange={(e) => setHeader(i, { value: e.target.value })}
            />
            <button
              type="button"
              className={styles.button}
              aria-label={`Remove header ${i + 1}`}
              onClick={() => setHeaders((rows) => rows.filter((_, j) => j !== i))}
              disabled={headers.length <= 1}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className={styles.button}
          onClick={() => setHeaders((rows) => [...rows, { key: '', value: '' }])}
        >
          Add header
        </button>

        {method !== 'GET' && (
          <div className={styles.field} style={{ marginTop: 8 }}>
            <label className={styles.label} htmlFor="api-lab-body">Body</label>
            <textarea
              id="api-lab-body"
              className={styles.textarea}
              value={body}
              placeholder='{"key": "value"}'
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
        )}
        <p className={styles.note}>
          Header values and request bodies are sent with the request but never saved:
          history keeps only the method, URL, and status.
        </p>

        {response !== null && (
          <section aria-label="Response">
            <h3 className={styles.sectionTitle}>Response</h3>
            <p className={styles.note} role="status">
              {response.status} {response.statusText} · {response.elapsedMs} ms
            </p>
            {Object.keys(response.headers).length > 0 && (
              <table className={styles.kvTable} aria-label="Response headers">
                <thead>
                  <tr><th>Header</th><th>Value</th></tr>
                </thead>
                <tbody>
                  {Object.entries(response.headers).map(([key, value]) => (
                    <tr key={key}><td>{key}</td><td>{value}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            <pre className={styles.pre}>{truncated?.text ?? ''}</pre>
            {truncated?.truncated === true && (
              <p className={styles.note}>
                Body truncated at {MAX_BODY_CHARS.toLocaleString()} characters for display;
                the full body was {response.body.length.toLocaleString()} characters.
              </p>
            )}
          </section>
        )}

        <section aria-label="Request history">
          <h3 className={styles.sectionTitle}>
            History ({history.length})
            {history.length > 0 && (
              <button
                type="button"
                className={styles.dangerButton}
                style={{ marginLeft: 8 }}
                onClick={() => {
                  clearHistory()
                  setHistory([])
                }}
              >
                <Trash size={12} />
                <span>Clear</span>
              </button>
            )}
          </h3>
          {history.length === 0 ? (
            <p className={styles.note}>No requests yet. History stores method, URL, and status only.</p>
          ) : (
            <ul className={styles.list}>
              {history.map((entry, i) => (
                <li key={`${entry.at}-${i}`} className={styles.row}>
                  <span className={styles.rowTitle}>{entry.method}</span>{' '}
                  <span className={styles.rowMeta}>{entry.url}</span>
                  <p className={styles.rowMeta}>
                    {entry.status === null ? 'failed' : `status ${entry.status}`} ·{' '}
                    {new Date(entry.at).toLocaleString()}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
