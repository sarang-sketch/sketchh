// Public surface of the stdio JSON-line protocol.
//
// `src/cli.ts` is the executable; everything it does lives here so the dispatch
// is testable without spawning a process.

export {
  parseRequest,
  encodeFrame,
  isEventFrame,
  isResponseFrame,
  ERROR_CODES,
} from './frames.js'
export type {
  FrameId,
  Frame,
  RequestFrame,
  ResponseFrame,
  ResponseOkFrame,
  ResponseErrorFrame,
  EventFrame,
  ErrorCode,
  ParseResult,
} from './frames.js'

export {
  ProtocolServer,
  createServer,
  main,
  // Shared transport seams. The stdio server and the Vite dev bridge build their
  // handler context and scrub their frames through these same three functions.
  createMethodContext,
  sanitizeFrame,
  collectParamSecrets,
} from './server.js'
export type { ServerIO, MethodContextIO } from './server.js'

export {
  METHODS,
  METHOD_NAMES,
  InvalidParamsError,
  NotImplementedError,
} from './methods.js'
export type { MethodContext, MethodHandler } from './methods.js'

export { StreamingEventStore } from './streaming-store.js'
export type { EventSink } from './streaming-store.js'

export { ENGINE_NAME, ENGINE_VERSION, PROTOCOL_VERSION } from './version.js'
