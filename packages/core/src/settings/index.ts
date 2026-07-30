// Provider settings: the key-free configuration file and the connection test.
//
// Nothing here persists a credential. `providers.json` holds five non-secret
// fields per provider; a key is an argument to `toProviderConfig` and to
// `testProviderConnection`, for that call only (Requirements 17.2, 17.4).

export {
  PROVIDER_SETTINGS_VERSION,
  ProviderSettingsWriteError,
  SecretInSettingsError,
  assertKeyFree,
  checkEndpoint,
  emptyProviderSettings,
  loadProviderSettings,
  providerMatrix,
  providersFilePath,
  resolveProviderConfig,
  sanitizeEntry,
  sanitizeSettings,
  saveProviderSettings,
  serializeProviderSettings,
  toProviderConfig,
} from './providerSettings.js'
export type {
  EndpointCheck,
  ProviderSettingsEntry,
  ProviderSettingsFile,
  ProviderSettingsIO,
} from './providerSettings.js'

export { testProviderConnection } from './connectionTest.js'
export type {
  ProviderTestCode,
  ProviderTestOptions,
  ProviderTestResult,
  ProviderTestTarget,
} from './connectionTest.js'
