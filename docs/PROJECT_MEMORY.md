# Project memory and context

What the agent knows about a project beyond the files it reads in a run, and where that knowledge lives.

## Instructions

`AGENTS.md` and `CLAUDE.md` at the project root are read for every run (`packages/core/src/skills/loader.ts`, `loadProjectContext`). `SKETCH.md`, global instructions in the home folder, and per-directory rules are **not supported yet** (roadmap M7).

## Project memory

An append-only store under `<project>/.sketch/memory/` (`packages/core/src/memory/store.ts`). The only write operations in that file are `mkdir` and `appendFile`; a test reads the source to keep it that way. Correcting an entry appends a "supersede" record with a reason instead of rewriting a line, so the history stays readable.

| Action | Where |
|---|---|
| List, search | Memory panel; RPC `memory-list`, `memory-search` |
| Remember something | Memory panel; RPC `memory-remember` |
| Supersede with a reason | Memory panel; RPC `memory-supersede` (a reason is required) |
| Write what a run established | Opt-in per run (`rememberRun`) |
| Clear all memory | **Not supported yet** |

Entries carry a kind (for example `decision`) and a validity window that superseding closes.

## Retrieval

Before a run, the engine can pack relevant context under a token budget (`context/assembly.ts`): memory entries, matching code chunks and repository-graph neighbours. Search is hybrid (`context/hybrid-search.ts`): a lexical channel plus vectors.

**Be aware:** the default vectors come from a hashing embedder (`context/embedder.ts`), which is not a semantic model: "car" and "automobile" do not match. A provider's embedding model can be used as a cached fallback. Local semantic embeddings through Ollama (`nomic-embed-text`) are on the roadmap (M9); the model manager can already download that model.

## Indexing and ignore rules

The walker (`context/walker.ts`) lists indexable files, honours `.gitignore`, skips `node_modules`, `.git`, build folders and virtual environments, and stops at 20,000 files with a reported "truncated" flag rather than exhausting memory. `.env` files are not indexed, and the agent cannot read them (`tools/protectedPaths.ts`).

## Architecture views

Live Architecture shows seven views derived from the persisted repository graph, with Mermaid source for each (`context/architecture.ts`, `desk/panels/LiveArchitecture.tsx`). Relationships come from static analysis of imports and declarations, not from a model.

## Conversation context

Each conversation sends its earlier turns with the next request (`historyFrom` in `desk/lib/AgentSession.tsx`); the engine keeps the newest turns. Older turns are dropped, not summarised. Conversations are saved in the window's local storage, at most 60 conversations of 200 messages each, with credential-shaped text scrubbed first; Settings → Privacy → Clear chat history removes them.

Tests: `memory`, `memory-recall`, `memory-ingest`, `hybrid-search`, `embeddings`, `walker`, `assembly`, `architecture`, `MemoryPanel`, `LiveArchitecture`.
