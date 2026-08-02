import { CanonicalProviderRegistry, type ProviderRegistration } from '../providers/registry.js'
import { McpCatalogRegistry, type McpCatalogEntry } from '../mcp/catalog.js'
import { MemoryStoreRegistry, type MemoryStoreRegistration } from '../memory/registry.js'
import {
  RegisteredAgentRegistry,
  RegisteredWorkflowRegistry,
  type RegisteredAgentDescriptor,
  type RegisteredWorkflow,
} from '../strategy/extensions.js'

export interface EngineExtensionRegistry {
  readonly providers: CanonicalProviderRegistry
  readonly mcp: McpCatalogRegistry
  readonly memoryStores: MemoryStoreRegistry
  readonly agents: RegisteredAgentRegistry
  readonly workflows: RegisteredWorkflowRegistry
}

/** Backward-compatible concise name for the host registry. */
export type ExtensionBundle = EngineExtensionRegistry

export interface EngineExtensionRegistryOptions {
  providers?: readonly ProviderRegistration[]
  mcp?: readonly McpCatalogEntry[]
  memoryStores?: readonly MemoryStoreRegistration[]
  agents?: readonly RegisteredAgentDescriptor[]
  workflows?: readonly RegisteredWorkflow[]
}

/** Backward-compatible concise name for registry construction options. */
export type ExtensionBundleOptions = EngineExtensionRegistryOptions

/** Build one immutable registry for a host. Nothing is registered at module scope. */
export function createEngineExtensionRegistry(
  options: EngineExtensionRegistryOptions = {},
): EngineExtensionRegistry {
  return Object.freeze({
    providers: new CanonicalProviderRegistry(options.providers),
    mcp: new McpCatalogRegistry(options.mcp),
    memoryStores: new MemoryStoreRegistry(options.memoryStores),
    agents: new RegisteredAgentRegistry(options.agents),
    workflows: new RegisteredWorkflowRegistry(options.workflows),
  })
}

/** Existing API name retained. */
export const createExtensionBundle = createEngineExtensionRegistry

export type { ProviderFactory, ProviderRegistration } from '../providers/registry.js'
export type { McpCatalogEntry } from '../mcp/catalog.js'
export type { MemoryStoreFactory, MemoryStoreRegistration } from '../memory/registry.js'
export type {
  RegisteredAgentDescriptor,
  RegisteredAgentExecution,
  RegisteredAgentGrade,
  RegisteredAgentOptions,
  RegisteredWorkflow,
  RegisteredWorkflowContext,
  RegisteredWorkflowDescriptor,
  RegisteredWorkflowExecutor,
} from '../strategy/extensions.js'
