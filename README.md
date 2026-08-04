# Sketch

A local-first AI engineering environment: one desktop window over one dependency-free engine.
Your keys stay in the OS credential store, your code stays on your disk, and the only thing that
ever leaves the machine is the model call you configured. Nothing else — no account, no server of
ours, no usage tracking. See [PRIVACY.md](PRIVACY.md), which is enforced by tests rather than by
good intentions.

**Status: pre-v1, and honest about it.** The engine, the Code surface, provider settings and
credential storage are real. Several panels are not. [What is real and what is a
seam](#what-is-real-and-what-is-not) is the second section of this file rather than a footnote.

---

## The $0 stack recipe

You can evaluate all of this for zero dollars. There is no paid-only path anywhere in the project,
and no step below asks for a card.

### 1. Run the test suite — no key, no network, no cost

```bash
git clone <this repo> && cd sketch
npm install          # npm registry only, like any project
npm run build
npm test             # offline, no API key, exits 0
```

The suite runs against `FakeChatAdapter`, a scripted in-process model. It is not a mock of a
network call — it is a real `ChatAdapter` implementation with no `fetch` in the file, so the whole
agent loop, plan gate, verify runner, event log and eval harness execute for real against it.

Set `SKETCH_FAKE_PROVIDER=1` and **every** provider resolution returns the fake, whatever the
configuration says. That is the switch to use when you want a guarantee that nothing can dial out:

```bash
# PowerShell:  $env:SKETCH_FAKE_PROVIDER = '1'
SKETCH_FAKE_PROVIDER=1 npm test
```

### 2. Drive the engine yourself — still $0

The engine is a stdio JSON-line CLI. One JSON object per line in, one per line out.

```bash
SKETCH_FAKE_PROVIDER=1 node packages/core/dist/cli.js
{"id":1,"method":"ping","params":{}}
{"id":2,"method":"run","params":{"task":{"id":"t1","prompt":"say hello","verify":[]}}}
```

Protocol frames go to stdout, diagnostics to stderr, and run progress streams as
`{"kind":"event",…}` lines correlated by `runId`. Without `SKETCH_FAKE_PROVIDER=1` a `run` with no
`params.provider` is refused rather than silently degraded.

### 3. Real models for free — local, on your own hardware

Install [Ollama](https://ollama.com) (free, open source, runs on your machine) and pull a small
model:

```bash
ollama pull llama3.2        # ~2 GB, runs on a laptop
```

Then configure it in **Provider Settings**, or write `~/.sketch/providers.json` by hand:

```json
{
  "version": 1,
  "selected": "ollama",
  "providers": [
    { "id": "ollama", "kind": "openai-compatible",
      "baseUrl": "http://localhost:11434/v1", "model": "llama3.2", "label": "Ollama (local)" }
  ]
}
```

No key. No account. Press **Test** in Provider Settings and it checks the endpoint and model
name without needing an internet service. `packages/core/test/phase4-gate.test.ts` covers this
protocol path against a real Ollama when one is already listening, otherwise against an explicitly
labelled loopback stub; it is not real-Ollama evidence.

For an explicitly real local check, build the host sidecar and run:

```bash
npm run build:sidecar -w @sketch/desktop
npm run preflight:ollama -- --model llama3.2
```

That preflight refuses unavailable/non-loopback endpoints and fake fallback, and requires Ollama's
`/api/version` and `/api/tags` responses plus the exact installed model. It still is
not clean-machine proof; [`OFFLINE-PROOF.md`](OFFLINE-PROOF.md) defines the installed-app, UI
review/apply, and process-attributed network evidence required for Requirement 26.2.
[LM Studio](https://lmstudio.ai) works through the same provider adapter on
`http://localhost:1234/v1`, as does `llama.cpp`'s server, but neither satisfies the Ollama-specific
preflight.

**This file never holds a key.** Two independent guards enforce it: a field whitelist, and a
byte-level check of the serialized JSON against the same credential-pattern table the event-log
redactor uses.

### 4. Free hosted tiers, if your machine is too small

Every one of these has a no-cost tier and speaks a shape the adapter layer already handles. Pick
one, get a key, paste it into Provider Settings — it goes into the OS credential store, not into a
file:

| Provider | Why it is on this list |
|---|---|
| **Google AI Studio (Gemini)** | Free tier with a generous request quota; use the OpenAI-compatible endpoint in the catalog so the key travels in a header |
| **GitHub Models** | Free for GitHub accounts, rate-limited; OpenAI-shaped |
| **Groq** | Free tier, OpenAI-shaped, very fast |
| **Cloudflare Workers AI** | Free daily allocation on the Workers free plan |
| **OpenRouter** | Has free-tier model ids; one key covers many models |

Paid providers (OpenAI, Anthropic, Azure) are in the same catalog and work identically. They are
never required — not to run the app, not to run the tests, not to follow any document in this
repository.

### The cost ladder, in order

1. `FakeChatAdapter` — tests and CI. Free, offline, deterministic.
2. Local model via Ollama / LM Studio / llama.cpp — demos and real work. Free, offline, private.
3. A free hosted tier — when local inference is too slow for the task.
4. A paid provider — only when you choose to.

---

## Install and run the app

```bash
npm install
npm run build
npm run dev:desktop      # Vite dev server; the engine runs over a loopback bridge
```

For native packages you also need a Rust toolchain (Tauri 2):

```bash
npm run build:sidecar -w @sketch/desktop
npm run verify:sidecar -w @sketch/desktop
npm run package:windows -w @sketch/desktop  # use macos/linux on those native hosts
```

The native workflow builds NSIS, DMG, and Debian package artifacts on Windows, macOS, and Linux runners.
Every deliverable must be **strictly under 100,000,000 bytes**; the gate and current evidence status
are documented in [PACKAGING.md](PACKAGING.md). A configured workflow is not itself proof that a
platform artifact exists—only its successful native job and uploaded size manifest are.

Requirements: Node 20+, and Rust only for the Tauri build.

---

## What is real and what is not

**Real.** A dependency-free engine (`packages/core` has zero runtime dependencies, enforced by a
test). An append-only JSONL event log every surface is a projection of, with secret redaction on
the write path. A seven-action agent loop whose plan gate is enforced in the engine by asking the
filesystem, not an in-memory flag. A shell-less verify runner. An eval harness, and
capture-a-run-as-an-eval. A skill trainer with a strict improvement gate. Monaco with a single
authoritative file cache. Per-hunk diff review. A real Git panel, Explorer, Terminal and Search.
Provider Settings with a key-free config file and a real connection test. API keys in the OS
credential store through Rust.

**Seam, stub, or absent.** No tool layer yet — `tool` actions emit `tool_denied`. The `ask` action
terminates the run; there is no interactive channel. No cancellation verb on the CLI wire. The
Skills marketplace, Task log and AI Team panels still render fixture data. There is no cost
dashboard. A **stored** key cannot yet reach a run: the Rust side deliberately exposes no command
that reads a key back into the window, so the only key that reaches a model call today is one you
just typed into the settings surface.

**Nothing in this project has ever run against a real hosted provider.** Both adapters are
exercised against the fake and against synthetic responses. That sentence stays here until someone
does it with a key and writes down what happened.

---

## Layout

```
packages/core        the engine — zero runtime dependencies, NodeNext, stdio CLI
packages/desktop     React + Vite window, Tauri 2 shell, Rust credential storage
.kiro/specs/…        the requirements, design and task plan this is built against
```

## Verifying it yourself

```bash
npm run typecheck    # must exit 0
npm run build        # must exit 0
npm test             # must exit 0, offline, with no API key set
```

Guard tests worth knowing about, because they are the ones that make the claims above checkable:

| Claim | Test |
|---|---|
| `packages/core` has no runtime dependencies | `packages/core/test/deps.test.ts` |
| `providers.json` holds no key material | `packages/core/test/providerSettings.test.ts` |
| No usage tracking or crash reporting anywhere, including the lockfile | `packages/core/test/privacy.test.ts` |
| A provider error never carries your key, and neither does the event log | `packages/core/test/privacy.test.ts`, `store.test.ts` |
| Nothing the window loads comes from off this machine | `packages/desktop/src/privacy.egress.test.ts` |
| A local connection test succeeds with no internet | `packages/core/test/phase4-gate.test.ts` |
| No command can read a key back out of the OS store | `packages/desktop/src/lib/security.test.ts` |

## Licence

Apache-2.0 — see [LICENSE](LICENSE). The vendored fonts (Inter, JetBrains Mono) are under the SIL
Open Font License 1.1; their licence texts ship beside them in
`packages/desktop/src/assets/fonts/`.
