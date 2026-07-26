// Public surface of the event store.
//
// src/index.ts is wired by the orchestrator after this batch; import from
// '../events/index.js' in the meantime.

export { newRunId, newEventId } from "./ids.js";
export { REDACTED, TRUNCATED, sanitizePayload, secretsFromEnv } from "./redact.js";
export { MemoryEventStore, JsonlEventStore } from "./store.js";
export type {
  EventStore,
  EventInput,
  EventStoreOptions,
  JsonlEventStoreOptions,
  ReadResult,
} from "./store.js";
