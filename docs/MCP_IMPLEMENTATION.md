# MCP in Sketch

Sketch is an MCP client. It starts MCP servers as local processes, lists their tools at the handshake, and exposes those tools to the agent through its own JSON action protocol, so the model does not need native MCP or tool-calling support.

## Two kinds of server

| | Curated catalog | Your servers |
|---|---|---|
| Where | `packages/core/src/mcp/catalog.ts` (15 entries) | `~/.sketch/mcp.json` (all projects), `<project>/.sketch/mcp.json` (this project) |
| Launch | Pinned package versions, argv only | Your command and arguments |
| Capability its tools cost | Per entry (`net:http`, `proc:spawn`, `fs:write:project`, `git:read`) | `proc:spawn`: it is a program running as you |
| Starts when | A run asks for it and the run's grant covers its capability | A chat has "Use in chats" on for it (MCP panel) |
| Trust | Reviewed into the catalog | Global: yours. Project: only after you approve that exact launch |

## Config format

The same `mcpServers` block Claude Desktop, Cursor and Claude Code use, so a config can be pasted into **MCP panel → Your servers → Import JSON**:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": { "EXAMPLE": "value" }
    }
  }
}
```

`command` must be one program; its arguments go in `args`. A `url` (remote) entry is listed and marked unsupported.

## Approval of project servers

A file inside a project can be changed by anyone who can push to that repository. So a project server starts only after you approve it, and the approval is a SHA-256 hash of its name, command, arguments and environment (values included, because a variable such as `NODE_OPTIONS` can run code). The hash is stored in `~/.sketch/mcp-trust.json`, outside every repository. Any change voids it and the panel asks again.

## How a run uses them

1. The window sends the enabled names as `userMcpServers` with the run.
2. The engine reads both files, drops unknown, broken and unapproved servers (each logged), and in Offline Mode starts none.
3. It adds the rest to a per-run copy of the catalog (`McpCatalogRegistry.withUserServers`), launches them through `McpHost`, and grants `proc:spawn` for their tools.
4. Their tools appear to the model as `user-<name>.<tool>` and go through the same dispatcher as every other tool.
5. All servers stop when the run ends. Nothing stays connected between runs.

## Engine methods

`mcp-catalog` (curated catalog and missing credentials), `mcp-servers`, `mcp-server-save`, `mcp-server-remove`, `mcp-server-trust`, `mcp-server-test` (starts the server, lists its tools, stops it).

## Not implemented

- Streamable HTTP and SSE transports (remote servers), and OAuth.
- Resources, prompts and sampling.
- Per-tool allow / ask rules (permissions are per server).
- Long-lived connections and a live status between runs.
- Offline Mode cannot vouch for a program's connections, so it starts none of your servers.

Tests: `packages/core/test/mcp.test.ts`, `user-mcp.test.ts`, `phase7-gate.test.ts`; `packages/desktop/src/panels/McpTools.test.tsx`, `UserMcpServers.test.tsx`.
