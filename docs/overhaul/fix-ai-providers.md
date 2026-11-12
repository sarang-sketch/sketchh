# W4 — AI providers: fix

Item W4 of the Sketch IDE overhaul. The owner asked for two things in so many words:
**"make sure the model displayed in the interface is the model actually handling the
request"** and **"investigate unexpected multiple model calls and incorrect token counts."**
W1 answered both from source reading only (BUG_AUDIT B-004/B-005/B-006, all against the
fake provider). This item answers them **on the wire** and makes them robust, and
covers the rest of the item's bar: key validation, model discovery, errors/retry/cancel,
and the provider UI.

Repo root: `C:\Users\saran\Downloads\sketch`. All anchors are `file:line` at that root.
Inputs read first (as leads, not facts): `docs/BUG_AUDIT.md` B-004/B-005/B-006,
`docs/ARCHITECTURE_REVIEW.md` §5(b), and the four earlier fix docs
(`fix-workspace-paths.md` W2, `fix-design-system.md` W3, `fix-agent-engine.md` W5,
`fix-skills-mcp.md` W7) — none of whose fixes this item undoes.

No real provider key was used or requested. Every check drove either the engine's fake
provider (`SKETCH_FAKE_PROVIDER=1`), a **local recording server on 127.0.0.1** that
emulates the OpenAI / Anthropic / Gemini wire formats
(`packages/core/scripts/w4-recording-server.mjs`), or a scripted local model. The real
external services are not reachable without keys, so **the adapters were tested against an
emulated wire format, not the live services.** No tracked file outside the W4 ownership
list was changed except the two lead-approved additions noted in §9; the pre-existing dirty
worktree was left as it was; nothing was committed, pushed, stashed, reset, or reverted.

---

## 1. What the owner asked, as it applies to W4

The model shown in the picker must be the model on the wire; the receipt and cost must show
the model that ANSWERED (a router like OpenRouter's `auto` can answer with a different one);
every model call Sketch makes must be counted with a cause and its tokens must equal what
the provider reported; a connection test must say exactly what went wrong; model discovery
must list what a provider serves or say clearly why it can't; and errors, retry and cancel
must be plain and bounded — all without a key, by driving an emulated wire.

---

## 2. Architecture as found (the before-state on the wire)

- The canonical seam the agent loop resolves is `ChatAdapter`
  (`packages/core/src/types.ts`), and it is **non-streaming**: `chat()` returns the whole
  `{ text, usage }`. Streaming exists only inside the ChatGPT adapter (SSE) and is collected
  to the same shape.
- There are exactly **two wire formats** (`ProviderKind`): `openai-compatible` and
  `anthropic-messages`. `resolveAdapter` (`providers/registry.ts:resolveAdapter`) maps every
  shipped provider to one of them, plus the ChatGPT account adapter:
  - **openai-compatible** → OpenAI, OpenRouter, Groq, DeepSeek, Mistral, Grok, Kimi, Cerebras,
    NVIDIA NIM, GitHub Models, **Gemini** (its `/v1beta/openai` endpoint), **Azure**,
    **Cloudflare Workers AI**, the **local** runtimes (Ollama, LM Studio, llama.cpp), and
    **custom**.
  - **anthropic-messages** → Anthropic.
  - **ChatGPT/Codex** → its own SSE `Responses` adapter (`providers/chatgpt.ts`).
  - The legacy `providers/{openai,anthropic,gemini,openai-compatible}.ts` classes are the
    `ProviderRegistry` built-ins; `resolveAdapter` does NOT use them, so e.g. the native
    Gemini REST adapter is never on a run's path — the loop's Gemini call is the
    OpenAI-compatible one.
- `providers/http.ts` already gives every call a timeout, bounded retries for the transient
  statuses (429/5xx/reset) honouring `Retry-After`, and — deliberately — **no** retry for a
  refused connection or a timeout. `providers/redact.ts` scrubs every thrown provider error
  through the shared secret-pattern table. These were correct and are **unchanged**.

### The two real gaps found

- **GAP 1 (model identity, the owner's first ask).** No adapter read the model the provider
  NAMED in its response. `llm_response.payload.model` was always `adapter.model` — the
  **requested** model. So when OpenRouter's `auto` (or any gateway) resolved the request to a
  different model, Sketch recorded and priced the wrong one, and the receipt could only ever
  echo the picker. Evidence (before): `loop/agent.ts` emitted
  `...(adapter.model !== undefined ? { model: adapter.model } : {})` and nothing else;
  `openaiCompatible.ts`/`anthropicMessages.ts` never looked at `data.model`;
  `chatgpt.ts` `collectResponses` never read `response.model`.
- **GAP 2 (every call accounted for, the owner's second ask).** The run path already counts
  every call honestly (`receiptFor` counts `llm_response` events; the ledger sums over them —
  see §4). But the **non-run** model calls — inline completion, inline edit, the git
  commit-message writer, the connection test — reported only the **requested** model to their
  caller, so a router alias there was invisible. (They are deliberately not written to the
  per-project event log; see §4.2 for why that design is correct and kept.)

B-005/B-006 (the model shown IS requested = model on the wire; token parsing is
provider-returned) were **re-confirmed on the wire** and remain true.

---

## 3. Invariant 1 — the model shown is the model on the wire, AND the receipt shows the model that ANSWERED

### 3.1 The request model is the wire model (B-005, re-confirmed on the wire)
`openaiCompatible.ts` sets `body.model = this.config.model`; `AgentSession.startRun` overrides
`provider.model` with the picked model. Proof on the wire: `w4-e2e-rpc.mjs` **S1** logged
every request the recording server saw, and `body.model` was the requested `openrouter/auto`
on all three calls (evidence printed by the driver).

### 3.2 The answered model (GAP 1) — the fix
The model the provider names in its reply is now carried **on the `chat()` return value**,
per call, never on an adapter instance (see §3.3 for why that distinction is load-bearing).

- **`packages/core/src/types.ts`** — the `ChatAdapter.chat()` return gains one optional field
  (with a doc comment): `Promise<{ text: string; usage?: Usage; model?: string }>`, meaning
  "the model the provider says produced this reply". Additive and backward compatible: every
  existing adapter and test double still satisfies it. *(This is the one change to the canonical
  contract, lead-approved; see §9.)*
- **`openaiCompatible.ts`** — reads the provider's own response model field and returns it as
  `model` when the server named one; omitted otherwise, and the requested id is **never**
  copied in. The OpenAI field is `model`; **Gemini** (reached through its OpenAI-compatible
  endpoint) names the same thing `modelVersion`, which is read as a fallback.
- **`anthropicMessages.ts`** — `fromAnthropicResponse` returns `data.model` likewise.
- **`chatgpt.ts`** — `collectResponses` reads `response.model` from the
  `response.completed`/`response.incomplete` SSE event into `ResponsesOutcome.model`, and the
  adapter returns it.
- **`loop/agent.ts`** (only the `llm_response` emit lines) — reads `response.model` off the
  call's return value and records `responseModel` **only when it differs** from the requested
  `model`, so a surface shows "requested X, answered Y" without inventing a difference. `model`
  on the event stays the requested model.
- **`cost/ledger.ts`** — a `LedgerEntry` is now attributed and **priced by the answered model**
  when one was recorded (you are billed for the model that ran), and exposes `requestedModel`
  when it differs.
- **`lib/runSummary.ts` `receiptFor`** — the receipt gains `models` (the distinct answered-or-
  requested models, first-seen) and `modelsAnswered` (true when a provider-named model was
  seen). `AppState.RunReceipt` carries both.
- **`components/RunCards.tsx` `RunReceiptLine`** — renders the model, labelling it
  `(requested)` when only the requested model is known. *(Lead-approved, receipt line only;
  §9.)*
- **`panels/CostDashboard.tsx`** — a call row shows the answered model and, when a router
  resolved an alias, the requested model (`← <requested>`).
- Non-run handlers (`rpc/methods.ts` `complete`, `inlineEdit`, `gitCommitMessage`) also surface
  `responseModel` from the return value when it differs from the requested model.

### 3.3 Why the return value, not an instance field (the lead's correction)
An adapter instance is reused across calls (a retry, a stream fallback, an auto-continue, a
completion beside a run). A `respondedModel` instance field is **shared state**: an overlapping
call's write would land between another call's write and the loop's read, crediting the wrong
model — and a cast to read it hides that from the type checker. Putting the answered model on
the per-call **return value** makes misattribution structurally impossible. The first draft of
this fix used an instance field; the lead caught it and it was switched.

### 3.4 Proof after
- Unit — `packages/core/test/providers.chat.test.ts`,
  *'the answered model is on the chat() return value'* (6 cases): OpenAI/Anthropic return
  `data.model`, leave it `undefined` when the server names none, never return the requested id;
  OpenAI-compatible reads Gemini's `modelVersion` fallback; `fromAnthropicResponse` carries it
  only when present; and the **lead's mutation-guard test**
  — two overlapping `chat()` calls on ONE instance, each response naming a different model —
  asserts each call's return value carries its OWN model.
- Unit — `packages/core/test/loop.test.ts`,
  *'answered-model recording on llm_response'* (3 cases): `responseModel` recorded when it
  differs from the requested model; omitted when equal; omitted when the adapter is silent;
  `model` stays the requested model throughout.
- End to end — `w4-e2e-rpc.mjs` **S1** against the shipped `dist/cli.js`, recording server
  answering `deepseek/deepseek-chat-v3` to a requested `openrouter/auto`:
  ```
  S1 THREE-NUMBER: server=3 events=3 receipt=3
  requests: [{"path":"/v1/chat/completions","model":"openrouter/auto","stream":false,...} ×3]
  every llm_response: { model: "openrouter/auto", responseModel: "deepseek/deepseek-chat-v3" }
  ledger entry: { model: "deepseek/deepseek-chat-v3", requestedModel: "openrouter/auto" }
  ```
- UI — `chat-ui.test.tsx` (receipt `models`/`modelsAnswered`, `RunReceiptLine` text) and
  `CostDashboard.test.tsx` (the alias row shows both models).

---

## 4. Invariant 2 — every model call is accounted for

### 4.1 The run path (B-004, re-confirmed on the wire)
One user message → one `client.run` → one run id; the agent loop makes one `adapter.chat()`
per iteration, and Auto auto-continues up to 2 more runs — all BY DESIGN. `receiptFor`
(`lib/runSummary.ts`) counts `llm_response` events as `modelCalls`, and the cost ledger
(`cost/ledger.ts` `ledgerFor`) is a pure sum over those same events with **no independent
counter**. Proof on the wire: `w4-e2e-rpc.mjs` **S1** puts the three numbers side by side and
they agree exactly — **server requests = llm_response events = receipt `calls` = 3** — and the
tokens equal the scripted usage summed (`42 in / 17 out` per call × 3).

### 4.2 Hidden / duplicated calls — hunted, and why the design is already right
The item named the shapes to hunt. Each was checked against the real code:

- **Completions firing on every keystroke** — they do NOT. `editor/ghostCompletion.ts` is
  **debounced** (180 ms), **single-flight** (each keystroke aborts the prior in-flight call),
  **off by default** (`DEFAULT_GHOST_COMPLETIONS_ENABLED = false`), and the engine adds a
  process-wide `CompletionRateLimiter` (`rpc/methods.ts` `complete`). So a completion is one
  bounded call per settled pause, not per keystroke.
- **A connection test re-running on every render** — it does NOT. `ModelSelector` reads the
  LAST test verdict from state and never issues a test on open; the test is user-initiated
  (`provider-test`).
- **A retry that re-sends without counting** — the bounded retry lives in `providers/http.ts`
  and is a retry of ONE logical call; the loop emits exactly one `llm_response` per logical
  call, so a retried-then-succeeded call is one counted call, which is correct.
- **A stream fallback that re-sends the whole request** — the only streaming adapter is
  ChatGPT; `collectResponses` falls back to the delta text WITHIN the one stream, it does not
  re-POST.

No hidden or duplicated call was found; the leads the item named
(`methods.ts` ~2254/2525/3531/3602, `loop/agent.ts` ~818) are, respectively, the git
commit-message writer, the ChatGPT connection test, inline completion and inline edit, and the
loop's single `adapter.chat()` — each makes exactly one call per invocation (proven for
inline-edit on the wire by **S3**: one request per call).

### 4.3 Non-run calls visible by cause (GAP 2 — fixed in round 2)
Completions, inline edits, the commit-message writer, the connection test and model listing are
deliberately **not** written to the per-project event log — one line per typing pause would
bury every run that matters. The seed still requires them "visible by cause where cost is
shown", so they now get their OWN record under the engine's home:

- **`packages/core/src/cost/usage-log.ts`** (new) — `recordUsage` appends one JSON line per
  call to `~/.sketch/usage/<YYYY-MM-DD>.jsonl` (append-only, one file per UTC day, the same
  discipline as the event store). A line carries only the facts a cost view needs: `ts`,
  `cause`, provider id, requested model, answered model when known, `usage` or `null` (unknown),
  `usageEstimated`, `ok`, `attempts`, and `root` when the call had one. There is **no field**
  through which a key, a prompt, or a reply could reach the file. `summarizeUsage` rolls it up
  by cause; an unknown-usage call is counted but its (absent) tokens add nothing, so a surface
  shows "unknown" not 0.
- **`rpc/methods.ts`** — `complete`, `inlineEdit`, `gitCommitMessage`, `providerTest` and
  `providerModels` each call `noteUsage(...)` with the cause; a new `cost-usage` RPC returns
  the summary. The write is best-effort (a missing breadcrumb never fails the call).
- **`CostDashboard`** gains a "Model calls not tied to a message" section grouped by cause,
  with call counts and tokens, unknown shown as unknown — fed by a new `costUsage?` seam on
  `SketchClient` (stdio/http/mock).

Each non-run call also returns the model that ANSWERED (not just the requested one) to its
caller. Proof: `usage-log.test.ts` (6 cases: rollup by cause, unknown-as-unknown, estimate +
failure flags, the whitelist-only line shape — asserts the exact key set so nothing sensitive
can slip in — and a malformed line skipped not absorbed), `CostDashboard.test.tsx` (the section
renders grouped by cause with unknown shown as unknown), and **S3** on the wire (inline-edit
made exactly one wire call and reported the answered model).

---

## 5. Invariant 3 — token counts match the provider

Usage parsing was already correct and is re-confirmed on the wire:
- **OpenAI-compatible, non-streamed** — `data.usage.prompt_tokens`/`completion_tokens`
  (`openaiCompatible.ts`). **S1** proved exact equality: receipt tokens =
  `SCRIPTED_USAGE × calls` to the token.
- **OpenAI-compatible, streamed** — the recording server emits a terminal chunk with
  `stream_options`-style `usage`; the adapter the loop uses is non-streaming, so the run path
  reads the non-streamed `usage`. (The streamed-usage shape is served by the recording server
  for completeness.)
- **Anthropic** — `message_start` + `message_delta` usage on the stream, and
  `usage.input_tokens`/`output_tokens` on the non-streamed body (`fromAnthropicResponse`);
  unit-tested (`providers.chat.test.ts` *'hoists system messages and maps usage'*).
- **Gemini** — via its OpenAI-compatible endpoint, so the OpenAI usage path; the native
  `usageMetadata` adapter is off the run path (§2).
- **ChatGPT** — `response.completed.usage.input_tokens`/`output_tokens` (`chatgpt.ts`
  `collectResponses`).
- **No usage reported → shown as UNKNOWN, never 0 (fixed — round 2).** The before-state was
  the gap the lead named: the loop wrote `usage: { in: 0, out: 0 }` when the provider reported
  nothing, and the receipt/ledger/CostDashboard summed those zeros as real, so the doc's
  "never a confident fabricated number" was not yet true. The fix (additive, backward
  compatible):
  - `loop/agent.ts` keeps `usage` present (consumers sum without guarding) but adds
    `usageKnown: false` on `llm_response` when `response.usage` was absent, and
    `usageEstimated: true` when the adapter estimates its numbers (the fake adapter exposes a
    fixed `estimatesUsage = true`, read structurally — a property of the adapter TYPE, not
    per-call state).
  - `cost/ledger.ts` does NOT sum a `usageKnown: false` call's placeholder zeros, counts it as
    `usageUnknown`, and its cost is `null` (unknown) — **never $0.00**. New `Ledger.usageUnknown`
    / `usageEstimatedCalls`; `describeLedger` says "tokens unknown for N of M call(s)".
  - `lib/runSummary.ts` `receiptFor` adds `tokensUnknownCalls` / `tokensEstimated`;
    `RunReceiptLine` shows "tokens unknown for N of M", "~… (estimated)", never "0 tokens".
  - `CostDashboard` shows the unknown/estimated counts in the headline and a warning.
  - The **budget guard** is honest by construction: it reads `ledger.tokensIn + tokensOut`,
    which no longer include a fabricated zero, so an unknown-usage call's spend is genuinely
    unknown rather than counted as free.
  - **Old event logs** without the flags read as known and not estimated, exactly as before.
  - Cached tokens are still counted once (`cache_hit` separately, never folded in).
- **The fake provider's numbers are labelled as estimates.** `fake.ts` estimates `~len/4`
  tokens and now exposes `estimatesUsage = true`, so the loop stamps `usageEstimated: true`
  and every surface marks the numbers "(estimated)". The pricing table still lists `fake` with
  `local: true` and the note *"The offline test adapter."*, so a fake run reads as a priced
  local `$0.00 (estimated)`, never as a confident hosted number.

Proof (invariant 3, round 2): `cost.test.ts` (unknown shown as unknown not 0, cost null not
$0.00, tokens not summed; estimated flagged; old log reads as known), `loop.test.ts`
(`usageKnown: false` when the adapter cannot count, absent when it can, `usageEstimated: true`
for the fake), `chat-ui.test.tsx` (receipt + `RunReceiptLine` text), `CostDashboard.test.tsx`.
Mutation: forcing `usageKnown = true` in the ledger made the unknown-usage case FAIL (the call
was summed and priced as $0). Restored → pass.

---

## 6. Invariant 4 — key validation and model discovery

`settings/connectionTest.ts` already mapped unreachable / 401 / model-not-found / timeout /
malformed / invalid-endpoint, redacted every message, and treated a deployment-scoped endpoint
(Azure, Cloudflare) that lists no models as a pass that says the model was NOT verified. This
item sharpens the authorization and rate-limit cases, because they need different fixes:

- **401 → `unauthorized`** (invalid / missing key) and **403 → `forbidden`** are now DISTINCT.
  A 403 means the key is accepted but not permitted (a missing scope, a plan, an org) — telling
  the user to replace a good key would be wrong.
- **429 → `rate-limited`**, with `Retry-After` parsed to `retryAfterSeconds` (integer delta or
  HTTP date) and surfaced in the message ("Wait about N seconds").
- `settings/models.ts` (model discovery) gets the same 401/403/429 split and `retryAfterSeconds`.
- A key is still never logged, put in an event, or returned (every message runs through the
  shared redactor; the new `retryAfterSeconds` is a number, not a credential).
- The **Ollama context-window note is kept and not contradicted**: the default is 4096 and the
  OpenAI-compatible endpoint ignores `num_ctx`, so the limit must be raised when Ollama starts;
  nothing here pretends a request can override it (no `num_ctx` is sent).
- UI labels for the new codes: `providerRows.ts FAILURE_LABELS` gains `forbidden → "Not
  permitted"` and `rate-limited → "Rate limited"`.

Proof: `providerSettings.test.ts` (new cases) — 403 → forbidden with a permission message and
no key; 429 → rate-limited with `retryAfterSeconds === 42` parsed from `Retry-After`; 429
without the header leaves it unset. `connect.test.ts` (discovery) still green. The pre-existing
"three distinct failures" test still passes under the new `forbidden` code. On the wire: **S2**
drove `provider-test` against a server answering 401/403/429(+Retry-After=30)/500 and each
mapped to its own code.

---

## 7. Invariant 5 — errors, retry and cancel at the provider layer

### 7.1 Retries are now COUNTED (GAP 3 — fixed in round 2)
The seed says "any automatic retry is bounded and its calls are counted." Before, a retried
call was one `llm_response` but two wire requests, with no record of the retry. The fix carries
the wire-attempt count on the `chat()` return (the second approved `types.ts` field,
`attempts?: number`):
- `providers/http.ts`'s retry loop already fires `onRetry` once per retry; `openaiCompatible.ts`
  and `anthropicMessages.ts` count `attempts = retries + 1` through it; `chatgpt.ts` reports
  `attempt + 1` from its own retry loop. `attempts` is returned only when `> 1`.
- `loop/agent.ts` records `attempts` on `llm_response`; `receiptFor` turns it into `retries`
  (attempts − 1 summed), and `RunReceiptLine` shows "(N retr{y,ies})". The call count stays
  LOGICAL — one `llm_response` per logical call.

Proof: `loop.test.ts` ('records attempts on llm_response when a call was retried');
**e2e S4** — the recording server answers 500 then 200 for each of three turns, so
**server=6, events=3, attempts=2 on every event**, and the receipt shows the retry. Mutation:
dropping `attempts` from the emit made the loop test FAIL. Restored → pass.

### 7.2 Errors and cancel (unchanged, verified)
Verified, because `providers/http.ts` + `providers/redact.ts` already do this right: HTTP failures map to plain messages via `statusHint` (401/403/404/408/413/429/5xx) +
the redacted body; a timeout is its own `ProviderTimeoutError` ("no answer within N s"); a
refused connection and a timeout are deliberately NOT retried; the bounded retry honours
`Retry-After` and is one logical (counted) call; the UI's Retry is a fresh `run`; Cancel aborts
the in-flight HTTP request and stream (the adapter is handed `{ signal }`) and the loop records
no tokens after an abort. Offline Mode blocks network providers (`privacy/offline.ts` +
`assertOnlineAction`) while local providers keep working. W5 already proved cancel end to end
(`fix-agent-engine.md` §6); this item did not touch `run`/`cancel`/`reply`.

---

## 8. Invariant 6 — the UI

- **ModelSelector** (`components/ModelSelector.tsx`) — shows `provider · model`, the last
  connection-test verdict as a coloured dot (untested is grey, never drawn as connected), the
  serverless badge, a keyboard-reachable `role="listbox"`/`option` dropdown, and the ChatGPT
  account's model list. It configures nothing itself (opens Provider Settings / Connect). No
  change was needed to meet the item's bar; it already uses the shell tokens.
- **ProviderSettings / ConnectWizard / LocalModels** — already W3-tokenised with loading /
  empty / error (`role="alert"`) / success / disabled / offline states; the new `forbidden` /
  `rate-limited` verdicts render through the existing `describeTest` path with the new labels.
- **CostDashboard** — shows the answered model per row and the requested alias when they differ;
  keeps its unknown-is-unknown and audit-trail guarantees.
- **RunReceiptLine** — shows which model answered each message (the "history shows which model
  answered" guarantee), `(requested)` when only the requested model is known.
- A long model id truncates in the selector CSS while the full id stays available
  (`title`/the dropdown). No new token or primitive was needed.

### 8.1 The owner's first ask, proven in a real browser (GAP 4 — done in round 2)
`packages/desktop/scripts/w4-ui-proof.mjs` drives the Vite dev preview over headless Edge CDP
(resource_status read TIGHT, 3.8 GB free — not critical — so it ran, as W3/W7 ran at similar
levels), with **`SKETCH_FAKE_PROVIDER` unset** and a **keyless `custom` provider pointing at
the W4 recording server**. It selects model A in the ModelSelector and sends a message, then
switches to model B and sends another, with the recording server scripted to name a different
answered model for the second. The recording server's request log shows
**`body.model = ["model-A", "model-B"]`** — the model the UI displayed is the model on the
wire — captured in `picture/overhaul/w4/ui-proof.json`, with screenshots
`ui-01-model-A-sent.png` and `ui-02-model-B-sent.png`. The DOM/render tests
(`chat-ui.test.tsx`, `CostDashboard.test.tsx`) additionally assert the receipt's answered-model
text, the unknown/estimated/retry text, and the non-run-calls section — visible text and
semantics, not colour classes. The packaged app still cannot be driven over CDP on this host
(WebView2 156 opens no listener, diagnosed in `fix-workspace-paths.md` §6.4), so the dev
preview — same React source, same in-process engine — is the drivable surface.

---

## 9. The provider-kind matrix

Each cell: **T** tested (and how) or **—** not applicable / why. "req=wire" = the requested
model id is the request body's model. "resp" = the model the provider named in its reply is
recorded. Wire tests are against the local recording server / scripted model emulating that
wire; the live services are unreachable without a key.

| Kind (providers) | model id in request | model reported back | usage non-streamed | usage streamed | error mapping | key validation | discovery |
|---|---|---|---|---|---|---|---|
| openai-compatible — OpenAI, OpenRouter, Groq, DeepSeek, Mistral, Grok, Kimi, Cerebras, NVIDIA, GitHub Models, custom | **T** req=wire (unit + S1) | **T** `data.model` (unit + S1 router alias) | **T** exact (S1; unit) | **T** server emits `usage` chunk (recording server); run path is non-stream | **T** S2 401/403/429/500 + unit | **T** connectionTest unit + S2 | **T** connect.test (OpenRouter prices/free) |
| openai-compatible — **Gemini** (`/v1beta/openai`) | **T** same adapter | **T** reads `modelVersion` fallback (unit) | **T** same adapter | **T** same | **T** same | **T** same (strips `models/` prefix) | **T** `parseModelList` |
| openai-compatible — **Azure / Cloudflare** (deployment-scoped) | **T** same adapter | **T** same | **T** same | **T** same | **T** same | **T** "connected, model not verified" (unlisted) | **T** `unlisted` state |
| openai-compatible — **local** (Ollama, LM Studio, llama.cpp) | **T** same adapter | **T** same | **T** same | **T** same | **T** unreachable path | **T** unreachable/model-not-found | **T** Ollama-native list; **ctx-window note kept** |
| **anthropic-messages** — Anthropic | **T** `body.model` (unit) | **T** `data.model` (unit) | **T** `input/output_tokens` (unit) | **T** `message_start`/`message_delta` (recording server) | **T** statusHint + redact (unit) | **T** connectionTest `/v1/models` | **T** `/v1/models?limit=1000` |
| **ChatGPT / Codex** (SSE Responses) | **T** `toResponsesRequest` (unit) | **T** `response.model` (code; collectResponses) | — (streamed only) | **T** `response.completed.usage` (unit, chatgpt.test) | **T** `chatgptFailureMessage` (unit) | **T** `chatgptConnectionTest` (one real request shape) | **T** `listChatGPTModels` + fallback |

Everything is tested against an **emulated** wire; no cell was proven against a live hosted
service, because no key exists.

---

## 10. Files modified / added

| File | Change | In W4's list? |
|---|---|---|
| `packages/core/src/types.ts` | `ChatAdapter.chat()` return gains optional `model?: string` with a doc comment (the answered model). Additive, backward-compatible — the ONE contract change. | **No — lead-approved addition.** The only change to this file. |
| `packages/core/src/providers/openaiCompatible.ts` | Reads `data.model` (and Gemini's `modelVersion` as a fallback); returns `model` on the value per call (never the requested id). | yes (`providers/**`) |
| `packages/core/src/providers/anthropicMessages.ts` | `fromAnthropicResponse` returns `data.model`; adapter signature widened. | yes |
| `packages/core/src/providers/chatgpt.ts` | `collectResponses` reads `response.model` into `ResponsesOutcome.model`; adapter returns it. | yes |
| `packages/core/src/loop/agent.ts` | Only the `llm_response` emit: records `responseModel` off the return value when it differs from the requested model. | yes (only the llm_response/usage lines) |
| `packages/core/src/cost/ledger.ts` | `LedgerEntry` priced/attributed by the answered model; new `requestedModel`. | yes (`cost/**`) |
| `packages/core/src/settings/connectionTest.ts` | Split 403→`forbidden` from 401, add 429→`rate-limited` + `retryAfterSeconds`. | yes (`settings/**`) |
| `packages/core/src/settings/models.ts` | Same 401/403/429 split + `retryAfterSeconds` for discovery. | yes |
| `packages/core/src/rpc/methods.ts` | `complete`/`inlineEdit`/`gitCommitMessage` surface `responseModel` from the return value (provider-* / local-model* / complete / inline-edit / git-commit handlers only). | yes (those handlers only) |
| `packages/core/test/providers.chat.test.ts` | New describe: answered model on the return value + the overlapping-calls mutation guard (5 cases). | yes (tests) |
| `packages/core/test/loop.test.ts` | New describe: answered-model recording on `llm_response` (3 cases). | yes |
| `packages/core/test/cost.test.ts` | New: prices by the answered model + surfaces the requested one (2 cases). | yes |
| `packages/core/test/providerSettings.test.ts` | New: 403 forbidden, 429 + Retry-After, 429 without header (3 cases). | yes |
| `packages/core/scripts/w4-recording-server.mjs` | **New.** Dep-free local server: OpenAI/Anthropic/Gemini wires, streamed+not, scripted usage, router-alias reply, 401/403/404/429+Retry-After/500/slow/malformed; logs every request. | yes (a script) |
| `packages/core/scripts/w4-e2e-rpc.mjs` | **New.** End-to-end over the real RPC vs the recording server (S1 model identity + three-number counting, S2 error mapping, S3 non-run call). | yes (a script) |
| `packages/desktop/src/lib/runSummary.ts` | `receiptFor` adds `models` + `modelsAnswered`. | yes (`runSummary.ts`) |
| `packages/desktop/src/state/AppState.tsx` | `RunReceipt` gains `models` + `modelsAnswered`. | **No — one additive type change** needed to carry the receipt's model to the UI; no behaviour change. Flagged here. |
| `packages/desktop/src/panels/CostDashboard.tsx` | A row shows the answered model + the requested alias. | yes (`CostDashboard.*`) |
| `packages/desktop/src/settings/providerRows.ts` | Labels for `forbidden` / `rate-limited`. | yes (`settings/**`) |
| `packages/desktop/src/components/RunCards.tsx` | `RunReceiptLine` renders the answered model, `(requested)` when unanswered. | **No — lead-approved, receipt line only.** W6 owns the rest of RunCards later. |
| `packages/desktop/src/chat-ui.test.tsx` | New describe: receipt `models`/`modelsAnswered` + `RunReceiptLine` text (3 cases). | yes (tests) |
| `packages/desktop/src/panels/CostDashboard.test.tsx` | Router-alias row + the "not tied to a message" section test + a `costUsage` test client. | yes (tests) |

### Round 2 (the four gaps)

| File | Change | In W4's list? |
|---|---|---|
| `packages/core/src/types.ts` | `chat()` return gains a second additive field `attempts?: number` (wire requests for one logical call). | **No — lead-approved** (the second of the two approved fields). |
| `packages/core/src/providers/{openaiCompatible,anthropicMessages}.ts` | Count `attempts` via `providerFetch`'s `onRetry`; return it when `> 1`. | yes (`providers/**`) |
| `packages/core/src/providers/chatgpt.ts` | Return `attempts` from its own retry loop. | yes |
| `packages/core/src/providers/fake.ts` | Fixed `estimatesUsage = true` so a surface can label its numbers estimates. | yes |
| `packages/core/src/loop/agent.ts` | `llm_response` gains `usageKnown:false` (provider reported none), `usageEstimated:true` (fake), and `attempts` (retries); `adapterEstimatesUsage` helper. | yes (llm_response/usage lines) |
| `packages/core/src/cost/ledger.ts` | Unknown usage not summed, cost null not $0; `usageUnknown`/`usageEstimatedCalls` on `Ledger`, `usageKnown`/`usageEstimated` on `LedgerEntry`; `describeLedger` says "tokens unknown for N of M". | yes (`cost/**`) |
| `packages/core/src/cost/usage-log.ts` | **New.** `recordUsage`/`summarizeUsage` → `~/.sketch/usage/<date>.jsonl`, whitelist-only (no key/prompt/reply). | yes (`cost/**`) |
| `packages/core/src/cost/index.ts` | Export the usage-log API. | yes |
| `packages/core/src/rpc/methods.ts` | `noteUsage` from `complete`/`inlineEdit`/`gitCommitMessage`/`providerTest`/`providerModels`; new `cost-usage` handler + method; `usageUnknown`/`usageEstimatedCalls` on the `cost` report. | yes (those handlers only) |
| `packages/core/test/{cost,loop,usage-log}.test.ts` | New cases for (a)/(b)/(c) + mutation anchors. | yes (tests) |
| `packages/core/scripts/w4-recording-server.mjs` | `setAnsweredModel` for the UI proof; `attempts` already observable via the error script. | yes (script) |
| `packages/core/scripts/w4-e2e-rpc.mjs` | New scenario **S4** (500-then-200 retry counting). | yes (script) |
| `packages/desktop/src/lib/{client,stdioClient,httpClient,mockClient}.ts` | `costUsage?` seam + `UsageSummary` type (wiring for the new RPC). | **No — lead-approved wiring** (the CostDashboard section needs it; same pattern W7 used for `skillUninstall`). |
| `packages/desktop/src/lib/runSummary.ts` | `receiptFor` adds `tokensUnknownCalls`/`tokensEstimated`/`retries`. | yes (`runSummary.ts`) |
| `packages/desktop/src/state/AppState.tsx` | `RunReceipt` gains those three fields. | **No — additive carrier**, flagged. |
| `packages/desktop/src/components/RunCards.tsx` | `RunReceiptLine` shows unknown/estimated tokens + "(N retries)". | **No — lead-approved, receipt line only.** |
| `packages/desktop/src/panels/CostDashboard.tsx` | Unknown/estimated in the headline; the "Model calls not tied to a message" section. | yes (`CostDashboard.*`) |
| `packages/desktop/scripts/w4-ui-proof.mjs` | **New.** Dev-preview CDP proof of the owner's first ask (model A then B on the wire). | yes (a script) |
| `packages/desktop/src/{chat-ui,panels/CostDashboard}.test.tsx` | New cases for (a)/(b)/(c). | yes (tests) |

**Dependencies added: none.** **Mock data introduced: none** (every usage/model/error value is
real wire data from the recording server or the fake provider). **Security checks weakened:
none** — redaction still covers every message, the new `retryAfterSeconds` is a number, and no
key path changed.

---

## 11. Tests, typecheck, build, and mutation checks (every command + result)

Each typecheck/test ran in a **later step** than the edits it checks. `--maxWorkers=1` throws
on vitest 2.1.9 here, so serial execution used
`--pool=forks --poolOptions.forks.singleFork=true`. Desktop tests import `@sketch/core` from
its built `dist`, so `npm run build -w @sketch/core` ran before them.

```
# Engine typecheck
cd packages/core && npx tsc --noEmit                         → exit 0

# Engine unit / integration
npx vitest run test/providers.chat.test.ts test/loop.test.ts test/cost.test.ts \
  test/usage-log.test.ts test/providerSettings.test.ts test/connect.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true
  → Test Files 6 passed; Tests 151 passed
    (providers.chat 31, loop 46, cost 28, usage-log 6, providerSettings 25, connect 15)

# Engine build (so the e2e + desktop tests see the change)
npm run build -w @sketch/core                                → exit 0 (tsc -p tsconfig.build.json)

# End to end over the real JSON-line RPC vs the recording server
node packages/core/scripts/w4-e2e-rpc.mjs                    → "W4 E2E: ALL PASS"
  S1 server=3 / events=3 / receipt=3, exact tokens, answered+requested model recorded,
     ledger priced by the answered model; S2 401→unauthorized, 403→forbidden,
     429→rate-limited (retryAfter=30), 500→endpoint-error; S3 inline-edit one wire call;
     S4 retry counted — server=6 / events=3 / attempts=2 per event.

# Desktop typecheck
cd packages/desktop && npx tsc --noEmit                      → exit 0

# Desktop unit
npx vitest run src/chat-ui.test.tsx src/panels/CostDashboard.test.tsx \
  src/settings/providerRows.test.ts src/panels/ProviderSettings.test.tsx \
  src/components/settings/LocalModels.test.tsx --pool=forks --poolOptions.forks.singleFork=true
  → chat-ui 21, CostDashboard 15, providerRows 12, ProviderSettings 19, LocalModels 4 — all passed

# UI proof of the owner's first ask (dev preview over headless Edge CDP, keyless provider)
node packages/desktop/scripts/w4-ui-proof.mjs                → "w4-ui-proof: ALL PASS"
  the recording server recorded body.model = ["model-A","model-B"];
  screenshots ui-01-model-A-sent.png / ui-02-model-B-sent.png in picture/overhaul/w4/
```

### Mutation checks (proving the new tests are not vacuous)
Each mutation was applied, the relevant test run, then the code restored and re-run green.

1. **Answered model on the return value (invariant 1).** In `openaiCompatible.ts`, moving the
   answered model to an INSTANCE FIELD and dropping it from the return value made
   `providers.chat.test.ts`'s overlapping-calls case FAIL
   (`expected undefined to be 'answered-A'`) — and the "returns data.model" case too. This is
   exactly the shared-state bug the return-value design prevents. Restored → 30 pass.
2. **Record only when it differs (invariant 1).** In `loop/agent.ts`, recording `responseModel`
   UNCONDITIONALLY (dropping the `!== adapter.model` guard) made `loop.test.ts`'s
   *'omits responseModel when the answered model equals the requested one'* FAIL
   (got `'gpt-4o'`, expected undefined). Restored → pass.
3. **Price by the answered model (invariant 1).** In `cost/ledger.ts`, flipping the attribution
   to `requested ?? answered` made `cost.test.ts`'s *'prices by the ANSWERED model'* FAIL (the
   alias was priced at the cheap requested rate). Restored → pass.
4. **The `(requested)` label (invariant 1 / UI).** In `RunCards.tsx`, dropping the
   `modelsAnswered` branch made `chat-ui.test.tsx`'s *'RunReceiptLine … labels a requested-only
   model'* FAIL. Restored → pass.
5. **Unknown usage not shown as 0 (invariant 3, round 2).** Forcing `usageKnown = true` in
   `cost/ledger.ts` made `cost.test.ts`'s *'shows UNKNOWN usage as unknown …'* FAIL — the call
   was summed and priced as $0. Restored → pass.
6. **Retries counted (round 2).** Dropping `attempts` from the `llm_response` emit in
   `loop/agent.ts` made `loop.test.ts`'s *'records attempts … when a call was retried'* FAIL.
   Restored → pass.
7. **The usage-log whitelist (round 2, non-vacuous by construction).** `usage-log.test.ts`
   asserts the exact key set of a written line, so any field added to the record (a leak) would
   fail it; the parse-skip case proves a malformed line is counted, not absorbed.

---

## 12. Remaining limitations

- **No live hosted-service test.** No provider key exists, so every adapter was tested against
  an EMULATED wire (the recording server / scripted model / fake provider), not OpenAI,
  Anthropic, Google, OpenRouter, etc. The request/response SHAPES were read from the adapters'
  own code and the vendors' documented formats; a live run against a real key would be the only
  way to catch a vendor changing its wire.
- **The dev-preview UI proof ran; the PACKAGED app still cannot be driven over CDP** on this
  host (WebView2 156 opens no listener, `fix-workspace-paths.md` §6.4). The owner's first ask is
  proven in the Vite dev preview (§8.1, `w4-ui-proof.mjs`, screenshots in
  `picture/overhaul/w4/`) — the same React source and in-process engine. A packaged-app shot
  would need a host whose WebView2 honours the debug port.
- **Streamed usage on the run path is served but not exercised by the loop.** The agent loop's
  OpenAI-compatible adapter is non-streaming by design, so the recording server's streamed
  `usage` chunk is served for completeness but the run path reads the non-streamed usage. The
  ChatGPT adapter is the one streaming consumer and its usage parsing is unit-tested.
- **Two additive type changes outside the W4 list** (`types.ts` `chat()` return field,
  `AppState.RunReceipt` fields) and **one receipt-line render** (`RunCards.tsx`) were made;
  the first two carry the answered model from the wire to the UI, the third shows it. The
  `types.ts` change and the `RunCards.tsx` render were explicitly lead-approved; the
  `AppState` field is the minimal carrier and is flagged in §10.
