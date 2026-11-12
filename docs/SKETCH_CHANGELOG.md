# Changelog

## Unreleased (2026-11-01)

### Added

- **Offline Mode** (Settings → Privacy). One switch keeps the engine on this computer: internet providers, ChatGPT and OpenRouter sign-in, connection tests against them, model downloads, network MCP servers, your own MCP servers, and git push, pull, fetch and clone are refused with a message naming what was refused and how to fix it. Saved in `~/.sketch/privacy.json`; `SKETCH_OFFLINE=1` forces it on. The status bar shows "Offline" while it is on.
- **Network activity list** (Settings → Privacy): every request the engine made since it started, as address and result only.
- **Your data** (Settings → Privacy): where Sketch keeps settings, run logs, chats and keys, and a confirmed "Clear chat history".
- **Local model manager** (Settings → Models → "On this computer"): Ollama status, installed models with size, quantisation, context length and capabilities, load and unload, remove, download with progress, recommendations for this computer's memory and NVIDIA GPU, and "Use for chat". Downloads and removals ask first.
- **Your MCP servers** (MCP panel): add, import (Claude Desktop / Cursor / Claude Code format), test, approve, remove, and "Use in chats". Global servers live in `~/.sketch/mcp.json`; project servers in `<project>/.sketch/mcp.json` and start only after you approve that exact command.
- Engine RPC methods: `privacy-status`, `privacy-set`, `local-models`, `local-model-pull`, `local-model-pull-status`, `local-model-pull-cancel`, `local-model-delete`, `local-model-load`, `mcp-servers`, `mcp-server-save`, `mcp-server-remove`, `mcp-server-trust`, `mcp-server-test`; run parameter `userMcpServers`.
- Documentation: `docs/SKETCH_FEATURE_AUDIT.md` and the other files listed in `docs/IMPLEMENTATION_STATUS.md`.

### Security

- The agent can no longer write `.git/` (hooks and config there run on your next git command), Sketch's own records under `.sketch/`, skill permission grants, `.env` files or private keys.
- The agent can no longer read `.env` files or private keys, and code search no longer returns their lines. Templates such as `.env.example` are unaffected.

### Changed

- The engine and window test configs pin `SKETCH_OFFLINE=0`, so a developer's own Offline Mode setting cannot change test results.
