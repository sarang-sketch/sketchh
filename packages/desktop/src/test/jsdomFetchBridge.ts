// TEST ENVIRONMENT ONLY. Loaded by vitest.config.ts as a setup file; it is not part
// of the app bundle and nothing shipped imports it.
//
// THE PROBLEM IT SOLVES. Under jsdom, two globals come from two different realms:
// `fetch` is Node's (jsdom does not implement it) while `AbortController` is jsdom's.
// Node's fetch validates `init.signal` with an instanceof check against Node's own
// `AbortSignal`, so an ordinary `fetch(url, { signal: new AbortController().signal })`
// is rejected with "Expected signal (AbortSignal {}) to be an instance of
// AbortSignal" before a socket is ever opened.
//
// That mismatch is an artifact of the harness, not of the code under test. In
// production the engine runs in Node — the Tauri sidecar and the Vite dev bridge —
// where both globals come from one realm, and the browser bundle never runs the
// engine at all. So the fix belongs HERE and not as defensive plumbing inside
// packages/core.
//
// IT IS A FALLBACK, NOT A REPLACEMENT. Every call is attempted with the signal
// exactly as given, so a signal Node's fetch does accept keeps REAL cancellation —
// the socket is torn down, which is what the event-stream tests depend on. Only after
// fetch has refused the signal (which it does before opening a connection) is the
// request retried without it, with the abort honoured here instead.
//
// WHAT IT DOES NOT DO: it fakes no request, no response, no status and no body. Every
// call goes over a real socket to whatever the test started.
//
// THE COST OF THE FALLBACK PATH, STATED: a request retried without a signal is not
// torn down on abort. The caller stops waiting at once and a late response is dropped,
// which is what it would have observed anyway. A test that needs to see a
// server-side cancellation must not rely on this path.

const nativeFetch = globalThis.fetch

function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

/** The specific pre-flight refusal above, and nothing else. */
function isCrossRealmSignalRefusal(err: unknown): boolean {
  return (
    err instanceof TypeError &&
    /signal/i.test(err.message) &&
    /instance of AbortSignal/i.test(err.message)
  )
}

/** Run without the signal, and honour the abort locally. */
function withoutSignal(
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  const { signal: _crossRealm, ...rest } = init
  const inflight = nativeFetch(input, rest)

  return new Promise<Response>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    inflight.then(
      (response) => {
        signal.removeEventListener('abort', onAbort)
        resolve(response)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

const bridgedFetch: typeof fetch = (input, init) => {
  const signal = init?.signal
  if (!signal) return nativeFetch(input, init)

  return nativeFetch(input, init).catch((err: unknown) => {
    if (!isCrossRealmSignalRefusal(err)) throw err
    return withoutSignal(input, init as RequestInit, signal)
  })
}

globalThis.fetch = bridgedFetch
