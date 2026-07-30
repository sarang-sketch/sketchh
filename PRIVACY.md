# Privacy — exactly what leaves this machine

Sketch has no account, no server of ours, and no telemetry. It is **not** a fully offline
application: it is an AI coding tool, and an AI coding tool that uses a hosted model sends your
code to that model. This document names every outbound path in the source, including the ones that
are inconvenient to admit.

Scope: this describes the code in this repository at the commit you are reading. It is enforced by
tests, not by good intentions — see [Enforcement](#enforcement). If you find an outbound path that
is not listed here, that is a bug in this document and we want the report.

---

## 1. Requests to the model provider you configured — YES, THIS IS NETWORK EGRESS

When you run a task against a hosted provider, your prompt leaves the machine. There is no way
around that and no attempt to soften it here.

| What | Where in the source | Destination |
|---|---|---|
| Chat completion, OpenAI-shaped | `packages/core/src/providers/openaiCompatible.ts` | `POST {your baseUrl}/chat/completions` |
| Chat completion, Anthropic-shaped | `packages/core/src/providers/anthropicMessages.ts` | `POST {your baseUrl}/v1/messages` |
| Legacy streaming adapters, not wired into the current agent loop but present in the package | `providers/openai.ts`, `providers/anthropic.ts`, `providers/gemini.ts`, `providers/base.ts`, `providers/openai-compatible.ts` | the same provider endpoints |
| Embeddings — **not reachable from any shipped surface today** (Phase 5 wires `src/context/`) | `packages/core/src/context/embedder.ts` | `POST {your baseUrl}/embeddings` |

**What is in the request body:** the messages the agent built. In practice that means your
instruction plus whatever file contents, diffs, and repository context the run assembled. Assume
anything the agent can read can end up in a request body.

**What is in the request headers:** the API key you configured, as
`Authorization: Bearer …` or `x-api-key: …`.

**One exception to that, and it is a wart:** the legacy Gemini adapter puts the key in the URL
(`?key=…`, `providers/gemini.ts`), so the key can land in an intermediate proxy's access log. Prefer
the Gemini OpenAI-compatible endpoint in the registry, which uses a header.

**The destination is yours, not ours.** `baseUrl` comes from `~/.sketch/providers.json`, which you
control. Point it at `http://localhost:11434/v1` (Ollama) or `http://localhost:1234/v1`
(LM Studio) and no request leaves the machine at all. That path is a first-class supported
configuration, not a curiosity.

## 2. The provider connection test — YES, NETWORK EGRESS, and only when you click it

Provider Settings has a per-provider "Test" button. It performs exactly one request:

- `GET {your baseUrl}/models`, or `GET {your baseUrl}/v1/models` for Anthropic-shaped providers
- source: `packages/core/src/settings/connectionTest.ts`
- it carries the key you typed, in a header, for that one call
- it is **never** automatic: no test runs on launch, on save, or on a timer. It has a 5 s timeout
  and an abort signal, so it cannot sit open in the background.
- the key is a function argument for that call. It is not stored, not returned, and every message
  the module produces is passed through the provider redactor before it is rendered.

## 3. Google Fonts on window load — YES, NETWORK EGRESS, and it should not be there

`packages/desktop/index.html` contains:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter…" rel="stylesheet" />
```

This is contact with a third party that you did not configure, on launch, before you do anything.
It is a defect in a local-first product and it is named here rather than quietly omitted.

What we can say from reading the code, and what we have not measured:

- In a **dev** run (`vite`, no CSP) all three requests happen: two connections plus a stylesheet
  fetch, followed by font files from `fonts.gstatic.com`.
- In a **packaged** build the CSP in `src-tauri/tauri.conf.json` is `style-src 'self' 'unsafe-inline'`
  and `font-src 'self' data:`, so the stylesheet and the font files are blocked. The two
  `preconnect` hints are speculative connections that no CSP directive covers, so they can still
  open a DNS lookup and a TLS connection to Google — which is enough to disclose your IP address
  and the fact that the app started. This is read off the configuration; we have not captured
  packets to confirm the browser engine's behaviour.

Either way it is unwanted. The fix is to self-host the two fonts, or drop them for a system font
stack, and delete all three tags. Until that lands, treat this as the one outbound path Sketch
makes that you did not ask for.

Related, same file: the CSP also allows `img-src … https:` and `connect-src 'self' ws: http: https:`.
Those are permissive enough that any HTML rendered in the window could fetch a remote image or open
a socket. Nothing in the shipped surface does, but the policy would not stop it.

## 4. Programs you run in the terminal panel — YES, they can go anywhere they like

The terminal allowlist is `git`, `npm`, `node`, `cargo`, `python`
(`src-tauri/src/command_policy.rs`). Several of those reach the network by design: `git push`,
`git fetch`, `npm install`, `npm test` on a suite that hits an API. Sketch spawns them with no
shell, in a directory contained in your open project, and only after you confirm the command — but
once `npm install` is running, what it contacts is npm's business, not ours. The allowlist is not a
network boundary and does not claim to be.

## 5. Loopback only — leaves the process, not the machine

- **Engine RPC.** The desktop window talks to the engine over stdio in the packaged app. In `npm run
  dev` it talks to a Vite middleware on `127.0.0.1` instead (`src/lib/httpClient.ts`,
  `src/lib/devBridge.ts`), which refuses any cross-origin caller.
- **Local models.** Ollama and LM Studio are HTTP servers on `localhost`. Requests to them are
  network requests to your own machine.

## 6. Build and install time, not run time

`npm install` fetches from the npm registry and `cargo build` from crates.io, like every other
project. `npm run build:sidecar` is local. None of this happens while the app is running.

---

## What there is none of

- **No telemetry, analytics, usage tracking, crash reporting, or error reporting.** No SDK for any
  of it is installed and none of those strings appears in any source file. A test enforces this.
- **No Sketch account, no Sketch server.** There is no endpoint we own for the app to talk to.
- **No update check.** The Tauri build loads three plugins — shell, fs, dialog — and the updater is
  not one of them (`src-tauri/Cargo.toml`).
- **No CDN for application code.** The bundle is local. The only remote subresource anywhere is the
  font stylesheet in §3.
- **No cloud sync, no remote index, no shared cache.** Embeddings, the event log, and the
  repository index are files on your disk.

## What stays on the machine

- `.sketch/events/<date>.jsonl` — the append-only event log every surface is a projection of.
  Payloads are redacted on the **write** path (`packages/core/src/events/store.ts`), so a key
  cannot reach the log even if a call site forgets.
- `.sketch/index/` — the repository graph and embeddings cache, when Phase 5 lands.
- `~/.sketch/providers.json` — provider ids, endpoints, and model names. **Key-free by test.**
- API keys — in the OS credential store only: Windows Credential Manager, macOS Keychain, or the
  Secret Service on Linux, reached through Rust (`src-tauri/src/os_credentials.rs`). There is no
  command that reads a key back into the window, not even truncated, so a key cannot reach a
  console log, an error boundary, or a crash dump.

## Keys and error messages

Every error thrown out of the provider layer goes through `redact()`
(`packages/core/src/providers/redact.ts`), which strips the configured key value, credential-shaped
headers and query parameters, and well-known key formats (`packages/core/src/secrets/patterns.ts`).
This matters because 401 bodies and proxy errors are exactly the ones that echo your credential
back at you.

## Enforcement

These are tests, and they fail the build:

| Claim | Test |
|---|---|
| No telemetry vocabulary anywhere in `packages/**/src`, or in any manifest | `packages/core/test/privacy.test.ts` |
| A thrown provider error never contains the configured key | `packages/core/test/privacy.test.ts` |
| A key never reaches the event log on disk | `packages/core/test/store.test.ts` |
| `providers.json` matches no secret pattern | `packages/core/test/providerSettings.test.ts` |
| No command returns a key to the window | `packages/desktop/src/lib/security.test.ts` |
| `packages/core` has zero runtime dependencies — nothing can phone home from a transitive dep | `packages/core/test/deps.test.ts` |

## Reporting

If you find an outbound request this document does not name, open an issue. A wrong privacy
document is a security bug.
