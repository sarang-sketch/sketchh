# What We Are Building

## One-Line Mission
An open-source, local-first desktop IDE that connects to any AI provider and ships code that actually works — tested, verified, and ready.

## The Core Problem We Solve
Every AI coding tool today is good at *generating* code. Almost none are good at *owning the quality of what they generate*. Sketch closes that gap.

> Any model can write code. Sketch makes sure it works.

---

## What Sketch Is

### 1. A Desktop IDE (not a VS Code extension)
- Standalone Tauri + React app
- Built-in Monaco editor
- Works without any other IDE installed
- Cross-platform: Windows, macOS, Linux

### 2. Universal Provider Access
Connect to any AI provider using your own credentials. No Sketch account. No subscriptions.

Supported providers:
- OpenAI (API key)
- Anthropic (API key)
- Google Gemini (API key)
- Groq (API key)
- Grok / xAI (API key)
- Kimi / Moonshot (API key)
- OpenRouter (one key, many models)
- Ollama (local, no key)
- LM Studio (local, no key)
- Azure OpenAI (API key + endpoint)
- Any OpenAI-compatible endpoint (API key + base URL)

Credentials stored in OS credential store (Keychain / Windows Credential Manager / libsecret). Never sent to Sketch servers (there are none).

### 3. The Verify Loop
This is the core differentiator. Every code change must pass before it is marked done:

```
Write → Lint → Type-check → Test → Build
         ↑                              ↓
         └──── Diagnose → Fix ←─────────┘
```

The loop runs autonomously until all checks pass or a human decision is required.

### 4. Smart Context Selection
Instead of sending the whole repo every time:
- File tree + dependency graph indexing
- Semantic search over codebase
- Only relevant files sent to the model
- Faster, cheaper, more accurate

### 5. Planning Before Coding
For non-trivial tasks, Sketch plans first:
- Breaks task into steps
- Identifies files to change
- Estimates scope
- Only then starts implementation

### 6. Persistent Project Memory
Each project remembers:
- Architecture decisions
- Coding standards
- Past bugs and fixes
- Team preferences
- Test history

### 7. MCP Tool Integration
Standard Model Context Protocol tools:
- Filesystem
- Git
- Terminal
- Browser (Playwright)
- GitHub
- Docker
- Databases
- Custom tools

### 8. Cost Dashboard
- Token spend per session
- Cost per provider
- Per-task cost breakdown
- Model comparison

---

## Target Users

| User | Pain point Sketch solves |
|---|---|
| Solo developer | Wants AI help without lock-in to one provider |
| Privacy-conscious dev | Needs local/offline AI, no data leaving machine |
| Cost-conscious dev | Wants to route tasks to cheapest capable model |
| Team lead | Wants reproducible, verifiable AI-assisted output |
| Open-source contributor | Wants a fully open, extensible platform |

---

## Success Looks Like
- A developer can open Sketch, add their API key, and get working, tested code in under 5 minutes
- The verify loop catches and fixes its own mistakes without human intervention
- Works equally well with GPT-4o, Claude, Gemini, and a local Ollama model
- Zero Sketch accounts, zero telemetry, zero subscriptions required
