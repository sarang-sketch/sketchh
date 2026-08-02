# Extensibility

This is the completed Phase 12.5 audit for Requirement 26.5. Every named category has a production-consumed runtime-configuration, filesystem-discovery, or host code-registration contract. These contracts are **not** a plugin store, package installer, or filesystem loader for executable plugins; `what-not-we-are-building.md` keeps a plugin store out of v1.

## Contract vocabulary

- **Runtime configuration:** user data changes behavior without rebuilding Sketch.
- **Filesystem-discovered:** production loads a documented artifact format from disk.
- **Host code-registration:** an embedding host constructs a validated registry and injects it into the production transport/runtime. This requires host code; it is not dynamic package execution.
- Test-only dependency injection, loader doubles, and edits to fixed source tables do not count.

## Production matrix

| Category | Contract consumed by production | Boundary |
|---|---|---|
| Providers | `CanonicalProviderRegistry` registers validated descriptors and fresh `ChatAdapter` factories; RPC run/eval/training and provider catalog resolution use the host registry. | The fake-provider switch wins before custom code. Factories receive call-scoped configuration and are not cached. |
| Agents | `RegisteredAgentRegistry` contributes exact-version descriptors with instructions, verification signals, capability ceilings, and edit/blocking metadata. | Agents run only from an explicit registered workflow, through `runTask`; unavailable verification signals skip before a model call and grants can only narrow capabilities. |
| Skills | Production discovers `SKILL.md` and community-format `skill.json` folders. | Registry installs additionally require reviewed digests and persisted digest-bound grants. |
| Tools | `McpCatalogRegistry` accepts validated host-supplied MCP entries; `McpHost` and RPC catalog/run paths consume them. | Entries require exact package versions, structured argv, known capabilities, valid environment names, explicit request, and a matching run grant. There is no arbitrary wire command resolver. |
| Models | Provider settings accept an arbitrary model identifier and pass it to the selected endpoint. | Sketch does not download, host, or manage model lifecycle. |
| Memory | `MemoryStoreRegistry` selects a host factory through explicit `params.memoryStore`; omission preserves `JsonlMemoryStore`. | Unknown selectors fail closed. Persistence, sharing, and lifetime are the factory owner's responsibility. |
| Workflows | `RegisteredWorkflowRegistry` contributes exact-version executors that invoke registered agents through the production run path. | Selection is explicit, mutually exclusive with built-in strategies, and does not change the built-in `single` default or enable `swarm`. |
| Themes | `EditorExtensionRegistry` registers and activates validated Monaco theme definitions in production `prepareMonaco()`. | Registration is host code; no theme store or executable filesystem loader exists. |
| Languages | `EditorExtensionRegistry` registers extension mappings and new language IDs with declarative Monarch tokenizer rules; production calls Monaco `languages.register` and `setMonarchTokensProvider`. | Regex sources and token rules are validated, then compiled by the runtime wrapper. Conflicting duplicates are refused. |

## Host integration

Construct one immutable core registry with `createEngineExtensionRegistry(...)` and pass it as `extensions` to `ProtocolServer`/`ServerIO` or the Vite `createSketchBridge(...)`. Registration is host-scoped: importing `@sketch/core` changes no global registry, and provider adapters are created fresh per resolution. Desktop editor hosts construct an `EditorExtensionRegistry` and pass it to `prepareMonaco()`.

Equivalent duplicate registrations are idempotent; conflicting registrations fail during host construction. Inputs crossing RPC remain explicit: `workflow`, `memoryStore`, and `mcpServers` do not silently alter defaults.

## Evidence and limits

`packages/core/test/phase12-extensibility-gate.test.ts` behaviorally proves provider-backed RPC, external MCP validation plus local handshake/tool discovery/capability denial, alternate memory hygiene and fail-closed selection, and explicit deterministic workflow/agent execution. `packages/desktop/src/editor/extensionRegistry.test.tsx` proves production Monaco theme/language/tokenizer consumption. Important guards were mutation-tested fail-then-pass, including fake precedence, exact MCP pinning, verification availability, capability intersection, unknown memory refusal, Monaco tokenizer installation, and JSONL secret redaction.

The MCP handshake uses a repository-local script through the existing launch-override test seam. It proves the validated catalog-to-host-to-dispatcher contract, **not** execution or audit evidence for an actual third-party MCP package. No claim here creates a plugin store, native installer evidence, real-provider evidence, or third-party package provenance.