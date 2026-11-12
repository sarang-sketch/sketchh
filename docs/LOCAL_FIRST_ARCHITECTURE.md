# Local-first architecture

Sketch runs on your computer and needs no account, no subscription, no API key and no Sketch server. This page lists what that rests on and where the internet is still involved.

## The principles, and where each is enforced

| Principle | How | Where |
|---|---|---|
| No paid API required | Local runtimes (Ollama, LM Studio, llama.cpp) and any OpenAI-compatible endpoint are first-class providers; keys are optional | `packages/core/src/providers/registry.ts` |
| Any model can drive the agent | The agent speaks a JSON action protocol, so it needs no native tool calling | `packages/core/src/loop/actions.ts` |
| Local model management | Ollama status, models, downloads, recommendations by memory | `packages/core/src/local/`, Settings → Models |
| Nothing leaves without your choice | The engine contacts only the provider you selected; Offline Mode makes "this computer only" a guarantee for the engine | `packages/core/src/privacy/offline.ts` |
| No telemetry | There is no usage reporting; tests fail if the engine reaches a non-loopback host during the suite | `packages/core/test/setup/noEgress.ts`, `PRIVACY.md` |
| Your data stays in files you can read | JSONL logs and memory in each project's `.sketch/`; settings in `~/.sketch/`; keys in the OS credential store | `docs/SKETCH_ARCHITECTURE.md` |
| Local MCP and skills | MCP servers run as local processes; skills are folders on disk | `packages/core/src/mcp/`, `packages/core/src/skills/` |

## Running fully offline

Once Ollama and a model are installed, everything in the editor works with the network unplugged: chats, the agent, edits, the terminal, git (except push, pull, fetch and clone), search, memory and architecture views. Turn on Offline Mode (`docs/OFFLINE_MODE.md`) to have the engine refuse anything that would reach the internet.

## Where the internet is still involved

| When | What connects | Avoid it by |
|---|---|---|
| You pick an internet provider | The engine, to that provider | Using a local model, or Offline Mode |
| Downloading a model | Ollama, to ollama.com | Downloading once, ahead of time |
| An MCP server from the catalog that needs the network (GitHub, Slack...) | That server process | Not enabling it; Offline Mode will not start it |
| `npx` starting an MCP server for the first time | npm, to fetch the package | Installing the package ahead of time |
| git push, pull, fetch, clone | git, to the remote | Offline Mode refuses these |
| Commands you or the agent run (`npm install`...) | That program | Offline Mode does not cover separate programs; the Privacy page says so |

## Optional external providers

Internet providers are separate adapters selected per run. Their keys are stored in the OS credential store, sent only to that provider, and scrubbed from every log line and event. Removing them changes nothing else.
