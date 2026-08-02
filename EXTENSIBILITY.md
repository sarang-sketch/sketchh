# Extensibility

This document is the Phase 12.5 audit for Requirement 26.5. It describes extension points that
production code actually consumes, and names the categories that are still closed. It is not a
promise of a general plugin manager or plugin store; `what-not-we-are-building.md` explicitly keeps
a plugin store out of v1.

## Vocabulary

- **Runtime configuration** — users can supply data without rebuilding Sketch.
- **Filesystem-discovered** — production discovers an artifact from a documented directory/format.
- **Code-pluggable** — production depends on an exported interface that another implementation can
  satisfy, but selecting that implementation still requires host code.
- **Reviewed source catalog** — extension requires a source change so security-sensitive metadata is
  pinned and reviewable. This is controlled extensibility, not runtime plugin loading.
- **Closed** — adding an entry requires changing a fixed union/table and related production logic;
  there is no independent extension contract yet.

A dependency-injection seam used only by tests is not, by itself, an installable extension point.
A static source table is not called runtime-pluggable. Monaco document models are unrelated to AI
model providers despite both using the word “model”.

## Current matrix

| Category | Status | Production extension point | Boundary and evidence |
|---|---|---|---|
| Providers | **Partial: runtime configuration** | `ProviderSettingsEntry` and `ProviderConfig` accept a custom OpenAI-compatible endpoint; `resolveAdapter` creates the canonical `ChatAdapter`. | The two wire kinds and `PROVIDER_CATALOG` are fixed. `ProviderRegistry.register()` extends only the legacy `ProviderAdapter` surface and does not add a canonical provider or Settings row. |
| Agents | **Closed** | None independent of the built-in role table. | `ROLES`, `Role`, and `ROLE_DEFINITIONS` are a fixed thirteen-role contract. Runner injection makes dispatch testable; it does not register an agent. |
| Skills | **Filesystem-discovered** | `loadSkills(dir)` discovers `SKILL.md` and community-format `skill.json` folders and normalizes both to `Skill`. | Local authoring needs no Sketch server. Registry distribution additionally requires pinned bytes, reviewed digest, and a persisted capability grant. |
| Tools | **Reviewed source catalog** | A requested, capability-approved `McpCatalogEntry` launches an MCP server; its descriptors are discovered and dispatched at runtime. | Server admission is the pinned `MCP_CATALOG`. Unknown IDs are refused. Test launch overrides are not production plugins. |
| Models | **Runtime configuration** | `ProviderSettingsEntry.model` / `ProviderConfig.model` is an arbitrary non-secret string sent to the selected endpoint. | There is no model registry, downloader, lifecycle, or fine-tuning system. Availability is the endpoint operator’s responsibility. |
| Memory | **Code-pluggable** | Retrieval and hygiene consume the exported `MemoryStore`; `JsonlMemoryStore` is production and `InMemoryStore` is a test implementation. | A host can compose another implementation, but there is no manifest, discovery directory, or desktop selector for stores. |
| Workflows | **Closed** | None independent of the built-in orchestrator and strategy state machines. | `single`, `plan-then-code`, and `swarm` are fixed. Files under a skill’s `workflows/` folder are skill content, not executable workflow registrations. |
| Themes | **Closed** | None. | Desktop production defines exactly `SKETCH_THEME`; loader doubles in tests do not create a user theme contract. |
| Languages | **Closed** | None. | Monaco grammar imports and `LANGUAGE_BY_EXTENSION` are static and private to the desktop bundle. Unknown extensions honestly use `plaintext`. |
## Supported extension procedures

### Add a custom provider endpoint and model

Use Provider Settings to add a custom OpenAI-compatible endpoint, model id, and label. The persisted
entry is key-free. Selecting it forwards that exact entry to `run`; no first-provider fallback is
allowed. This extends endpoint/model configuration only. A new wire protocol still needs a reviewed
core implementation, redaction tests, settings support, and a catalog entry.

### Author or install a skill

Place either `<skills-dir>/<name>/SKILL.md` or a community-format folder containing `skill.json` in
the configured skills directory. Production loading skips malformed skills with a named diagnostic
without blocking valid neighbors. Registry installation is stricter: content must match the pinned
reviewed digest, and the manifest’s capability grant—not the skill’s declaration—is persisted and
enforced. Training writes a candidate outside the active directory; activation is explicit.

### Supply a memory implementation from a host

Implement every `MemoryStore` method and pass that store to the retrieval/hygiene functions that
accept the interface. Preserve append-only history, validity windows, supersede reasons, and default
exclusion of retracted entries. This is a code-composition contract; no installed application
setting currently selects a third-party store.

### Propose a tool server

Add a reviewed `McpCatalogEntry` with a stable id, exact versioned argv, one real capability,
required environment-variable names, and a caveat where access reaches past the project. Do not add
a runtime command resolver or `@latest`: arbitrary server execution would reverse Requirement 22.2.
The existing MCP host discovers tool descriptors only after the catalog, explicit request,
environment, and capability gates all pass.

## Why the remaining categories are not called plugins

- Adding an agent today means editing the closed role vocabulary, defining a verification signal,
  capability narrowing, grading behavior, and dispatcher tests.
- Adding a workflow means changing a fixed strategy/orchestrator state machine. A markdown file in a
  skill folder does not become executable merely because it is named “workflow”.
- Adding a theme means changing the bundled Monaco setup. There is no persisted theme selection or
  public theme-definition loader.
- Adding a language means bundling its grammar and changing the private extension map. There is no
  public registration API or dynamic grammar loading.

Calling these source edits “pluggable” would make the Requirement 26.5 audit pass by vocabulary
rather than behavior.

## Work required to close Requirement 26.5

1. Reconcile the legacy provider registry with the canonical `ChatAdapter` path, or deliberately
   define custom OpenAI-compatible configuration as the complete provider extension contract.
2. Add production agent and workflow registries whose contributed entries carry verification
   signals, capability limits, deterministic dispatch/merge behavior, and versioned identities.
3. Decide whether tools remain intentionally source-curated or accept externally supplied,
   validated catalogs without weakening pinning, review, argv, or capability gates.
4. Add production desktop registries for theme definitions and language/extension mappings; prove a
   non-built-in entry reaches the actual Monaco loader, not a test double.
5. Add a Phase 12.5 behavioral gate that exercises each resulting production contract. A source-text
   check that only finds interface names is not sufficient.

Until those items are implemented and verified, task 12.5 remains in progress. The audit is
complete enough to name the gaps; the product-wide “every extension point is pluggable” claim is
not yet true.