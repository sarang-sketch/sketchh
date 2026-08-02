// The curated MCP tool layer: hand-rolled JSON-RPC over stdio, pinned servers, and a
// hang that cannot wedge a run.
//
// Authorisation is NOT here. Every tool this module produces is a `ToolDescriptor`
// declaring the capability it costs, and `capabilities.ToolDispatcher` is the one place
// that decides whether a call may proceed. This module makes tools available; it never
// makes them permitted.

export {
  MCP_CLIENT_INFO,
  MCP_PROTOCOL_VERSION,
  decode,
  encode,
  readCallResult,
  readToolList,
  takeLines,
} from './protocol.js'
export type {
  IncomingFrame,
  JsonRpcError,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpCallOutcome,
  McpToolInfo,
} from './protocol.js'

export {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_STDERR_BYTES,
  McpServer,
  framePayload,
} from './client.js'
export type { McpCallResult, McpServerSpec, UnavailableReason } from './client.js'

export { MCP_CATALOG, catalogIds, findCatalogEntry, missingEnv } from './catalog.js'
export type { McpCatalogEntry, McpLaunch } from './catalog.js'

export { McpHost } from './host.js'
export type { McpHostOptions, McpOpenResult } from './host.js'
