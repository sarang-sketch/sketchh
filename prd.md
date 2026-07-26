# Product Requirements Document (PRD)

**Product**: Sketch  
**Version**: 1.0  
**Status**: Draft

---

## Problem Statement

Developers using AI coding tools today face three unsolved problems:

1. **Lock-in** — tools are tied to one provider, one subscription, one account
2. **Privacy** — code is sent to third-party servers without control
3. **Quality** — AI generates code but doesn't verify it works

Sketch solves all three.

---

## Target Users

### Primary: The Independent Developer
- Works solo or in small teams
- Uses multiple AI providers depending on cost and task
- Values privacy — doesn't want code leaving their machine
- Frustrated by subscriptions and accounts for every tool

### Secondary: The Privacy-Conscious Developer
- Works in regulated industries (finance, health, legal)
- Needs air-gapped or fully local AI
- Cannot use cloud-based coding assistants

### Tertiary: The Cost-Optimiser
- Routes cheap tasks to fast/cheap models (Groq, Gemini Flash)
- Routes hard tasks to powerful models (Claude, GPT-4o)
- Wants visibility into token spend per task

---

## User Goals

| Goal | How Sketch addresses it |
|---|---|
| Write code faster | AI handles boilerplate, scaffolding, and repetitive changes |
| Ship code that works | Verify loop catches and fixes errors before marking done |
| Use any AI provider | Universal provider adapter, BYO API key |
| Keep code private | Local-first, no Sketch servers, optional fully offline |
| Understand what AI changed | Diff view, task log, git integration |
| Not pay for another subscription | Free and open source, user pays only their AI provider |

---

## Core Features (v1)

### F1 — Provider Management
- Add any supported provider via API key or base URL
- Credentials stored in OS keychain
- Switch active provider per session or per task
- View available models per provider
- Test connection before saving

### F2 — Project Workspace
- Open any local folder as a project
- File explorer with tree view
- Monaco editor with syntax highlighting
- Integrated terminal
- Git status and diff view

### F3 — AI Chat + Task Execution
- Natural language task input
- AI reads relevant files (not whole repo)
- AI proposes a plan before making changes
- User can approve or edit plan
- AI applies changes as file diffs
- User sees exactly what changed

### F4 — Verify Loop
- After every AI change, automatically run:
  - Lint (ESLint, Ruff, etc. — detected from project config)
  - Type-check (tsc, mypy, etc.)
  - Tests (Jest, pytest, etc.)
  - Build (if applicable)
- On failure: AI diagnoses and fixes, re-runs checks
- Max retry limit configurable (default: 3)
- User notified if loop cannot resolve

### F5 — Context Engine
- Index project files on open
- Re-index on file change
- Semantic search to find relevant files
- Dependency graph to pull related files
- Only relevant files sent to model (not whole repo)

### F6 — Project Memory
- Per-project SQLite database
- Stores: decisions, standards, past bugs, test history
- Loaded into context at session start
- User can view and edit memory entries

### F7 — Cost Dashboard
- Token usage per session
- Estimated cost per provider's pricing
- Per-task cost breakdown
- Total spend over time

### F8 — MCP Tools (v1 set)
- Filesystem (read/write/delete)
- Terminal (run commands)
- Git (commit, diff, branch, status)
- Browser via Playwright (optional, user-installed)

---

## Non-Functional Requirements

| Requirement | Target |
|---|---|
| Startup time | < 3 seconds on modern hardware |
| Indexing speed | < 10 seconds for a 10,000-file repo |
| Memory usage | < 500 MB idle |
| Offline capability | Full functionality with local models (Ollama) |
| Platform support | Windows 10+, macOS 12+, Linux (Ubuntu 20.04+) |
| Installer size | < 100 MB |

---

## Out of Scope for v1

See [what-not-we-are-building.md](what-not-we-are-building.md) for the full list.

Key exclusions:
- No Sketch cloud backend
- No multi-model consensus
- No skills marketplace
- No collaborative editing
- No mobile app

---

## Success Metrics

| Metric | Target at 3 months post-launch |
|---|---|
| GitHub stars | 1,000+ |
| Active installs | 500+ |
| Verify loop success rate | > 70% of tasks pass without human intervention |
| Provider coverage | 10+ providers working reliably |
| Community contributions | 20+ PRs merged |

---

## Milestones

| Milestone | Deliverable |
|---|---|
| M1 | Provider adapter layer + BYO-key config working |
| M2 | Repo indexer + context selection working |
| M3 | Verify loop (lint → typecheck → test → build) working |
| M4 | Tauri desktop app shell with Monaco editor |
| M5 — v1.0 | All F1–F8 features integrated and tested |
