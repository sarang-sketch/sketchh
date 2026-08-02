# What We Are NOT Building

This document exists to keep the team focused. Every item here is a real temptation that would dilute the product. Say no to all of it — at least until v1 ships.

---

## Not a Cloud Service
- No Sketch servers
- No Sketch accounts
- No cloud sync
- No telemetry
- No usage tracking
- No "sign in with Sketch"

> If it requires a Sketch backend, we don't build it.

---

## Not a VS Code Extension
- Sketch is a standalone desktop app
- We do not live inside another editor's lifecycle
- We do not depend on VS Code APIs, themes, or extension marketplace
- We are not a fork of VS Code or any other editor

---

## Not an AI Model Provider
- We do not train models
- We do not host models
- We do not fine-tune models
- We do not own any AI inference infrastructure
- We are purely a client that calls provider APIs

---

## Not a Multi-Model Consensus Engine (v1)
- We do not run the same task on 3 models and "vote" on the result
- We do not compare code diffs across models for consensus
- This idea is expensive, slow, and unproven — defer to v2+ with evidence

---

## Not a 13-Role Agent Hierarchy
- We do not build a CEO agent, a Planner agent, a Research agent, etc. as separate named entities in v1
- The org-chart metaphor is marketing, not architecture
- Sub-agents are an implementation detail for parallel work, not a headline feature

---

## Not an Open Skills Marketplace (v1/v1.5)
- The staged v1-family foundation may ship a curated, pinned, content-hash-verified skill registry and its registry-backed discovery/install surface; this foundation was delivered in the v1.5 implementation phase
- That curated surface is not an open community marketplace or a public skill-publishing pipeline
- The open marketplace is a v2 deliverable and must not ship until content integrity verification and capability scoping are implemented and tested; it must include a review queue whose approvals are bound to the exact reviewed digest
- Installed authority comes from a separately persisted, digest-bound grant that may be narrower than the skill's request; changed bytes invalidate review and authority
- “Signed registry” in this project currently means pinned content-hash integrity, not public-key author identity, native application signing, or release provenance

---

## Not a Cloud IDE
- No browser-based version
- No remote dev environments
- No collaborative multiplayer editing
- No cloud file storage

---

## Not a General-Purpose Chatbot
- Sketch is not a chat interface for general questions
- It is not a replacement for Claude.ai, ChatGPT, or similar
- Every interaction is grounded in a codebase and a task

---

## Not a CI/CD Platform
- We do not replace GitHub Actions, CircleCI, or any pipeline tool
- We trigger and observe CI — we do not own it

---

## Not a Project Management Tool
- No Jira replacement
- No sprint boards
- No ticket management
- Tasks exist only to track what the AI is doing right now

---

## Not Trying to "Beat" Any Single Model
- We do not claim to outperform GPT-4o, Claude, or Gemini on benchmarks
- Benchmark results depend on the underlying model, not us
- We compete on orchestration quality, verify loops, and workflow — not raw model output

---

## Scope Traps to Avoid

| Temptation | Why to avoid it |
|---|---|
| OAuth login for ChatGPT/Claude.ai web | Fragile, may violate ToS, breaks on UI changes |
| Real-time collaborative editing | Massive scope, not core to the mission |
| Mobile app | Wrong form factor for coding |
| Open skill publishing marketplace before the v2 integrity, scope, and review gates | Ecosystem play; unreviewed or over-privileged submissions are a supply-chain risk |
| Custom model fine-tuning | Out of scope entirely |
| Voice input/output | Nice to have, not core |
| Built-in browser | MCP covers this via Playwright |

---

## The Rule
> If a feature doesn't directly help a developer ship better, tested code faster using their own AI keys — it doesn't belong in v1.
