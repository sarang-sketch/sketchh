// W4 recording server — a local, dependency-free model endpoint on 127.0.0.1.
//
// It emulates the three wire formats Sketch's adapters speak, streamed and not, so
// the provider layer can be driven and COUNTED without a real key and without a
// network call leaving the machine:
//
//   * the OpenAI-compatible wire  — POST {base}/chat/completions  and  GET {base}/models
//   * the Anthropic-messages wire — POST {base}/v1/messages       and  GET {base}/v1/models
//   * the Gemini native wire      — POST {base}/v1beta/models/<model>:generateContent
//       and :streamGenerateContent  (Sketch resolves the `gemini` provider through the
//       OpenAI-compatible path at /v1beta/openai, so the native Gemini routes here are
//       for completeness; the adapter the loop uses hits /chat/completions.)
//
// WHY IT EXISTS: invariant 2 says "every model call is accounted for." The only way
// to prove that is to count calls ON THE WIRE and compare them with the engine's
// llm_response events and the receipt. So this server logs EVERY request it sees —
// path, the requested model (body.model), whether the caller asked to stream, and a
// timestamp — and `requests()` hands that log back to the driver.
//
// It returns scripted replies with KNOWN usage numbers, so the token comparison is
// exact. One scripted reply names a DIFFERENT model than the request (a router like
// OpenRouter's `auto` does this), so "the model that answered" can be told apart from
// "the model requested." And it can be told to answer with a specific error — 401,
// 403, 404, 429 (with Retry-After), 500, a slow reply (for timeout/cancel), or a
// malformed body — so the error mapping can be checked against the wire too.
//
// No dependencies: node:http only. No key is read, stored, or logged.

import { createServer } from 'node:http'

/** The usage numbers every scripted non-error reply carries, so counts are exact. */
export const SCRIPTED_USAGE = { prompt_tokens: 42, completion_tokens: 17 }

/**
 * Build (but do not start) a recording server.
 *
 * @param {object} [options]
 * @param {string} [options.reply]  the assistant text for a successful reply.
 * @param {string} [options.answeredModel]  the model to NAME in the response body;
 *   when it differs from the request's model, that is the "a router answered with a
 *   different model" case. Defaults to echoing the request's model.
 * @param {Array<string|object>} [options.script]  per-call replies (advances each
 *   call); a string is the assistant text, an object is a directive:
 *     { status, retryAfter?, body? }  → answer that HTTP status (error path);
 *     { text, model? }               → a reply naming `model` (router alias);
 *     { slowMs }                      → hold the socket this long then reply (timeout/cancel);
 *     { malformed: true }            → answer 200 with a body that is not valid JSON.
 */
export function makeRecordingServer(options = {}) {
  const requests = []
  const script = Array.isArray(options.script) ? options.script : null
  const defaultReply = options.reply ?? 'OK'
  let turn = 0
  // The model to NAME in the response, mutable so a driver can change what "answered"
  // between calls. Starts at the configured value (or echoes the request when null).
  let answeredModel = options.answeredModel ?? null

  const record = (req, model, stream) => {
    requests.push({ path: new URL(req.url, 'http://x').pathname, model: model ?? null, stream: !!stream, ts: Date.now() })
  }

  const directiveFor = () => {
    if (script === null) return { text: defaultReply }
    const item = script[Math.min(turn, script.length - 1)]
    turn += 1
    if (typeof item === 'string') return { text: item }
    return item ?? { text: defaultReply }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const path = url.pathname

    // GET model lists — model discovery.
    if (req.method === 'GET' && (path.endsWith('/models') || path.endsWith('/v1/models'))) {
      record(req, null, false)
      const isAnthropic = path.endsWith('/v1/models')
      const list = isAnthropic
        ? { data: [{ id: 'claude-3-5-sonnet-20241022', type: 'model' }, { id: 'claude-3-5-haiku-20241022', type: 'model' }] }
        : { object: 'list', data: [{ id: 'model-a', object: 'model' }, { id: 'model-b', object: 'model' }] }
      return json(res, 200, list)
    }

    if (req.method !== 'POST') return json(res, 404, { error: { message: 'not found' } })

    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      let parsed = {}
      try { parsed = raw === '' ? {} : JSON.parse(raw) } catch { parsed = {} }
      const geminiModel = geminiModelFromPath(path)
      const requestedModel = typeof parsed.model === 'string' ? parsed.model : geminiModel
      const stream = parsed.stream === true || path.includes(':streamGenerateContent')
      record(req, requestedModel, stream)

      const directive = directiveFor()

      // Error directive — the error-mapping path.
      if (typeof directive.status === 'number') {
        const headers = { 'Content-Type': 'application/json' }
        if (directive.retryAfter !== undefined) headers['Retry-After'] = String(directive.retryAfter)
        const body = directive.body ?? JSON.stringify({ error: { message: `scripted ${directive.status}`, type: `e_${directive.status}` } })
        res.writeHead(directive.status, headers).end(body)
        return
      }

      // Slow directive — hold then reply, so a timeout or a cancel can be observed.
      if (typeof directive.slowMs === 'number') {
        const timer = setTimeout(() => finishReply(), directive.slowMs)
        req.on('aborted', () => clearTimeout(timer))
        res.on('close', () => clearTimeout(timer))
        return
      }

      // Malformed directive — valid HTTP 200, invalid JSON body.
      if (directive.malformed === true) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{ this is not json ')
        return
      }

      return finishReply()

      function finishReply() {
        const text = directive.text ?? defaultReply
        const answered = directive.model ?? answeredModel ?? requestedModel ?? 'model-a'
        if (path.includes('generateContent')) return geminiReply(res, text, answered, stream)
        if (path.endsWith('/v1/messages')) return anthropicReply(res, text, answered, stream)
        return openaiReply(res, text, answered, stream)
      }
    })
  })

  return {
    server,
    /** The in-order log of every request the server saw. */
    requests: () => requests.map((r) => ({ ...r })),
    /** How many POST completion requests (not model-list GETs) were seen. */
    completionCount: () => requests.filter((r) => r.path.includes('completion') || r.path.includes('messages') || r.path.includes('generateContent')).length,
    /** Change the model the server NAMES as having answered, for subsequent calls. */
    setAnsweredModel: (model) => { answeredModel = model },
    reset: () => { requests.length = 0; turn = 0 },
  }
}

export function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj))
}

function geminiModelFromPath(path) {
  const m = path.match(/\/models\/([^:]+):/)
  return m ? m[1] : undefined
}

// ── OpenAI-compatible replies ────────────────────────────────────────────────

function openaiReply(res, text, model, stream) {
  if (!stream) {
    return json(res, 200, {
      id: 'chatcmpl-rec',
      object: 'chat.completion',
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: SCRIPTED_USAGE.prompt_tokens, completion_tokens: SCRIPTED_USAGE.completion_tokens, total_tokens: SCRIPTED_USAGE.prompt_tokens + SCRIPTED_USAGE.completion_tokens },
    })
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  const first = { id: 'chatcmpl-rec', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }
  const last = { id: 'chatcmpl-rec', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: SCRIPTED_USAGE.prompt_tokens, completion_tokens: SCRIPTED_USAGE.completion_tokens } }
  res.write(`data: ${JSON.stringify(first)}\n\n`)
  res.write(`data: ${JSON.stringify(last)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

// ── Anthropic-messages replies ───────────────────────────────────────────────

function anthropicReply(res, text, model, stream) {
  if (!stream) {
    return json(res, 200, {
      id: 'msg_rec',
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
      usage: { input_tokens: SCRIPTED_USAGE.prompt_tokens, output_tokens: SCRIPTED_USAGE.completion_tokens },
    })
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  send('message_start', { type: 'message_start', message: { id: 'msg_rec', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: SCRIPTED_USAGE.prompt_tokens, output_tokens: 0 } } })
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
  send('content_block_stop', { type: 'content_block_stop', index: 0 })
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: SCRIPTED_USAGE.completion_tokens } })
  send('message_stop', { type: 'message_stop' })
  res.end()
}

// ── Gemini native replies ────────────────────────────────────────────────────

function geminiReply(res, text, model, stream) {
  const payload = {
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: SCRIPTED_USAGE.prompt_tokens, candidatesTokenCount: SCRIPTED_USAGE.completion_tokens },
    modelVersion: model,
  }
  if (!stream) return json(res, 200, payload)
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
  res.end()
}
