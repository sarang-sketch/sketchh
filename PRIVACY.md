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
| Embeddings — **off by default**, and only when a caller passes a provider (§7) | `packages/core/src/context/embedder.ts` | `POST {your baseUrl}/embeddings` |

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

**Editor features that call the same model.** Two editor features send code to the provider you
picked for chat, through the same adapters as above, and only these two:

| Feature | When | What is sent | Source |
|---|---|---|---|
| Autocomplete (status-bar toggle, **off by default**) | each pause in typing while it is on, at most 30 calls a minute | the file's path and language, up to 6,000 characters before the caret and 2,000 after | `packages/core/src/assist/completion.ts` |
| Inline edit (Ctrl+K) | only when you press Generate (or Fix on a problem) | the file's path and language, the selected lines (at most 60,000 characters), up to 8,000 characters before them and 3,000 after, and your instruction | `packages/core/src/assist/inlineEdit.ts` |

Neither writes anything to the project's event log, and an inline edit changes nothing until you
accept its diff. The gutter's change markers (what changed since the last commit) and the
side-by-side diff view run `git show` (HEAD and the index) on this machine and send nothing
anywhere.

### 1a. "Sign in with ChatGPT" — YES, NETWORK EGRESS, to OpenAI only, and only after you sign in

Signing in with a ChatGPT account uses the same sign-in OpenAI's Codex CLI uses (also shipped by
OpenCode and Cline). Every request goes to OpenAI; the endpoint is fixed in code and a settings file
cannot change it.

| What | Where in the source | Destination |
|---|---|---|
| Sign-in page, opened in **your own browser** | `packages/core/src/settings/chatgptAuth.ts` | `https://auth.openai.com/oauth/authorize` |
| The browser's return trip, on this machine only | same file — a listener on `127.0.0.1`/`::1`, ports 1455 or 1457 | `http://localhost:1455/auth/callback` |
| Sign-in completion, token renewal, sign-out revoke | same file | `POST https://auth.openai.com/oauth/token`, `/oauth/revoke` |
| Optional code sign-in (no local port) | same file | `https://auth.openai.com/api/accounts/deviceauth/*` |
| Model requests and the model list | `packages/core/src/providers/chatgpt.ts` | `POST https://chatgpt.com/backend-api/codex/responses`, `GET …/codex/models` |

**What is sent:** the same messages as §1, plus your ChatGPT access token in `Authorization` and your
account id in `ChatGPT-Account-Id`. Usage counts against your ChatGPT plan, under OpenAI's terms.

**Where the sign-in is kept:** `~/.sketch/auth/chatgpt.json`, written atomically with owner-only
permissions — the same arrangement Codex uses (`~/.codex/auth.json`). It is kept by the engine
rather than the OS credential store because OpenAI replaces the refresh token on every renewal, and
the code that renews must be the code that keeps it. Tokens never reach the app window, a log, an
event file or `providers.json`. **Sign out** (Settings → Models) revokes the token at OpenAI and
deletes the file. Each Sketch window runs its own engine, so a renewal, a new sign-in and a sign-out
each briefly hold `chatgpt.json.lock` beside it (a process id, nothing else): two windows never
spend the same refresh token, and a sign-out cannot be undone by a renewal finishing elsewhere.

## 2. The provider connection test — YES, NETWORK EGRESS, and only when you click it

Provider Settings has a per-provider "Test" button. It performs exactly one request:

- `GET {your baseUrl}/models`, or `GET {your baseUrl}/v1/models` for Anthropic-shaped providers
- source: `packages/core/src/settings/connectionTest.ts`
- it carries the key you typed, in a header, for that one call
- it is **never** automatic: no test runs on launch, on save, or on a timer. It has a 5 s timeout
  and an abort signal, so it cannot sit open in the background.
- the key is a function argument for that call. It is not stored, not returned, and every message
  the module produces is passed through the provider redactor before it is rendered.

## 3. Fonts on window load — NO EGRESS. The fonts are in the bundle

**This section used to describe a defect.** Until task 4.5, `packages/desktop/index.html` carried
two `<link rel="preconnect">` hints and a Google Fonts stylesheet, fetched on window load before
you did anything. The CSP blocked the stylesheet and the font files in a packaged build, but **no
CSP directive covers `preconnect`**, so a DNS lookup and a TLS handshake to Google could still
happen — enough to disclose your IP address and the fact that the app started.

**All three tags are deleted.** The two families are now vendored into the package and served from
the app's own bundle:

| File | Size | Licence |
|---|---|---|
| `packages/desktop/src/assets/fonts/inter-latin-variable.woff2` | 48 KB | SIL Open Font License 1.1 — `inter-OFL.txt`, beside it |
| `packages/desktop/src/assets/fonts/jetbrains-mono-latin-variable.woff2` | 40 KB | SIL Open Font License 1.1 — `jetbrains-mono-OFL.txt`, beside it |

They are declared in `packages/desktop/src/styles/fonts.css`, which `global.css` imports, with
relative URLs the bundler resolves inside the application origin (`font-src 'self'`). These are the
latin subsets of the variable builds — one file per family covers weights 100–900, replacing the
four Inter weights and three JetBrains Mono weights the old stylesheet requested. Text outside the
latin range falls through to the platform font stack, which is what the CDN's latin subset did too.

So on launch the window fetches its own HTML, its own bundle, and these two font files. Nothing
else. There is no request to any host, loopback or otherwise, until you start a run or press
**Test** in Provider Settings.

Enforced by `packages/desktop/src/privacy.egress.test.ts`, which fails if any file under
`packages/*/src` or `index.html` names a font CDN, references a non-loopback URL in a subresource
position (an HTML tag attribute, a CSS `url()`, a CSS `@import`, or any URL ending in a
subresource extension), or declares a `preconnect` / `dns-prefetch` / `prefetch` / `preload` hint.
It also asserts the two woff2 files are present, are really woff2, and ship their licence text.
A provider endpoint is deliberately not a finding: it is not a subresource, and §1 documents it.

**Still permissive, same file:** the CSP allows `img-src … https:` and
`connect-src 'self' ws: http: https:`. Nothing in the shipped surface uses that latitude, and the
guard above now fails the build if a source file starts to, but the policy itself would not stop
HTML rendered in the window from fetching a remote image or opening a socket. Tightening it for
production builds is open work.

## 4. Programs you run in the terminal panel — YES, they can go anywhere they like

In the desktop app a terminal tab is a real shell in a pseudo-terminal — the shell you pick from
the **⌄** menu next to **+** (PowerShell, Command Prompt, Git Bash, a WSL distribution, MSYS2,
Cygwin, Nushell; zsh, bash, fish elsewhere) — started by the app's own process
(`packages/desktop/src-tauri/terminal`), in a folder inside your open project, and only after you
allow terminals in that folder (once per folder, or until you restart; Settings → Editor lists the
folders and can forget them). The program is always one the app found installed on this computer;
the window can choose among them but never name another. Outside the desktop app, and for Run panel
scripts, commands run one process per line from the engine (`packages/core/src/tools/terminal.ts`)
with the same folder rule. Like any terminal, whatever you run can reach the network: `git push`,
`npm install`, `curl`, a test suite that calls an API. What those programs contact is their business,
not Sketch's, and the terminal is not a network boundary and does not claim to be. Closing a tab, or
quitting Sketch, ends its shell and what that shell started.

When you enable commands for an agent run, the agent may also start a dev server or watcher **in
the background** (`run_command` with `background: true`). It is the same approval as any other
command, it runs on this computer like one, and every such process is stopped when the run ends.

**Watching the folder.** While a folder is open, the engine watches it for changes
(`packages/core/src/tools/watcher.ts`) so tabs, the Explorer and Source Control update when another
program changes a file. It reports file NAMES to the window, on this computer only; it reads no
file contents and sends nothing anywhere.

**Reveal in File Explorer / Finder** and **Open in External Terminal** start your system's own file
manager or terminal app on a folder inside the project. Nothing leaves the computer.

Source Control's **Pull**, **Push** and **Fetch** buttons run `git` against the repository's own
remote, only when you press them. **Write the commit message with AI** sends the staged diff (or,
with nothing staged, the working-tree diff), truncated to 14,000 characters, plus the last eight
commit subjects, to the model provider you connected — the same egress as §1, made only when you
press that button. Nothing is committed by it.

## 5. Loopback only — leaves the process, not the machine

- **Engine RPC.** The desktop window talks to the engine over stdio in the packaged app. In `npm run
  dev` it talks to a Vite middleware on `127.0.0.1` instead (`src/lib/httpClient.ts`,
  `src/lib/devBridge.ts`), which refuses any cross-origin caller.
- **Local models.** Ollama and LM Studio are HTTP servers on `localhost`. Requests to them are
  network requests to your own machine.

## 6. Build and install time, not run time

`npm install` fetches from the npm registry and `cargo build` from crates.io, like every other
project. `npm run build:sidecar` is local. None of this happens while the app is running.

## 7. Embeddings — NO EGRESS by default, and the default is worse at its job

The repository index needs vectors. The shipped default computes them **on this machine, with no
network and no dependency**, and it is worth being blunt about what that costs.

**What the local path is.** `HashEmbedder` (`packages/core/src/context/embedder.ts`) is a *hashing
vectoriser*: it hashes tokens with FNV-1a and adds ±1 into buckets. **It is not a semantic embedding
model.** `car` and `automobile` are orthogonal under it. Two texts look similar only when they share
literal tokens.

**Why it is not better.** `packages/core` has zero runtime dependencies, enforced by a test. A real
local embedder needs a tokenizer and an inference runtime — `onnxruntime-node`, `transformers.js`, a
GGUF loader — all native or multi-megabyte, and a native module is the most common reason a
local-first install fails on someone's machine. The alternative, a sidecar process holding a small
model, is deferred: it is a packaging and lifecycle problem, not an embedding one.

**What that means for retrieval quality.** The vector channel adds little when the local path is in
force; retrieval quality offline is essentially the quality of the *lexical* channel, which is why
search is hybrid and never vector-only (§18.2 of the spec). A hosted embedding model is genuinely
better at "find the code that does this", and this document will not pretend otherwise.

**If you configure a provider endpoint,** chunk text leaves the machine exactly as in §1, and:

- vectors are cached at `.sketch/index/embeddings/<ab>/<key>.json`, keyed by
  `sha256(version + provider id + model + dimensions + sha256(chunk))`, so an unchanged chunk is
  never re-fetched — a warm index makes zero requests
- a cache entry holds a hash, a model name, a width and a list of numbers. **No chunk text, no file
  path, no URL, no header, no key.** A test asserts the bytes on disk contain no key material
- a changed chunk, a changed model, a changed provider, or a changed vector width is a different
  key, so a stale vector can never be served for edited code
- if the endpoint is unreachable, slow, or returns something unusable, the run **degrades to the
  local path and says so** — in `EmbedderStatus.reason` and in a `context_loaded` event. It never
  throws, never hangs (the request is raced against a deadline), and never returns empty vectors
- the cache is local only. There is no shared cache and no remote index

---

## What there is none of

- **No telemetry, analytics, usage tracking, crash reporting, or error reporting.** No SDK for any
  of it is installed and none of those strings appears in any source file. A test enforces this.
- **No Sketch account, no Sketch server.** There is no endpoint we own for the app to talk to.
- **No update check.** The Tauri build loads three plugins — shell, fs, dialog — and the updater is
  not one of them (`src-tauri/Cargo.toml`).
- **No CDN for anything.** Application code, fonts, icons, images — all of it is in the bundle.
  There is no remote subresource, and a test fails the build if one appears (§3).
- **No cloud sync, no remote index, no shared cache.** Embeddings, the event log, and the
  repository index are files on your disk.

## What stays on the machine

- `.sketch/events/<date>.jsonl` — the append-only event log every surface is a projection of.
  Payloads are redacted on the **write** path (`packages/core/src/events/store.ts`), so a key
  cannot reach the log even if a call site forgets.
- `.sketch/index/graph.json` — the repository graph: paths, hashes, chunk spans, import edges. No
  file contents.
- `.sketch/index/embeddings/` — cached provider vectors, keyed by content hash plus model plus
  provider. Hashes and numbers only; see §7. The local path writes nothing here.
- `.sketch/snapshots/<id>/` — the original text of each file an agent run or a Replace in Files
  changed, kept so **Undo** can put it back without Git. Your own files' contents, in your own
  project folder; nothing is sent anywhere. Find in Files itself reads files and writes nothing.
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
| No font CDN, no non-loopback subresource, no `preconnect` | `packages/desktop/src/privacy.egress.test.ts` |
| An embedding cache file contains no key material, no chunk text and no URL | `packages/core/test/embeddings.test.ts` |
| Embedding works with no provider and no network, and degrades instead of failing | `packages/core/test/embeddings.test.ts` |
| `packages/core` has zero runtime dependencies — nothing can phone home from a transitive dep | `packages/core/test/deps.test.ts` |

## Reporting

If you find an outbound request this document does not name, open an issue. A wrong privacy
document is a security bug.
