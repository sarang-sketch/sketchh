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
  backupCorruptConfig,
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

// What a provider serves, asked of the provider. Powers the model picker.
export { listProviderModels, parseModelList } from './models.js'
export type {
  ProviderModel,
  ProviderModelsOptions,
  ProviderModelsResult,
  ProviderModelsTarget,
} from './models.js'

// Conventional environment variables as a key fallback (headless / CI).
export { PROVIDER_ENV_KEYS, apiKeyFromEnv, envKeyPresence, envNamesFor, sketchEnvName } from './envKeys.js'

// The loopback listener of a desktop OAuth sign-in. Never holds a credential.
export { cancelLoopback, openLoopbackCount, renderCallbackPage, startLoopback, waitLoopback } from './oauthLoopback.js'
export type { LoopbackOutcome, LoopbackStart } from './oauthLoopback.js'

// "Sign in with ChatGPT": a ChatGPT plan as the model, no API key.
export {
  CHATGPT_CALLBACK_PATH,
  CHATGPT_CALLBACK_PORTS,
  CHATGPT_CLIENT_ID,
  CHATGPT_CODEX_BASE_URL,
  CHATGPT_ISSUER,
  CHATGPT_ORIGINATOR,
  CHATGPT_PROVIDER_ID,
  ChatGPTAuthError,
  accountClaims,
  cancelChatGPTLogin,
  chatgptAuthPath,
  chatgptAuthorizeUrl,
  chatgptEndpoints,
  chatgptLogout,
  chatgptStatus,
  decodeJwtClaims,
  exchangeChatGPTCode,
  generatePkce,
  getChatGPTAccess,
  openChatGPTLoginCount,
  readChatGPTCredential,
  startChatGPTBrowserLogin,
  startChatGPTDeviceLogin,
  waitChatGPTLogin,
  writeChatGPTCredential,
} from './chatgptAuth.js'
export type {
  ChatGPTAccess,
  ChatGPTAccountSummary,
  ChatGPTAuthCode,
  ChatGPTBrowserLogin,
  ChatGPTCredential,
  ChatGPTDeviceLogin,
  ChatGPTEndpoints,
  ChatGPTLoginOutcome,
  ChatGPTStatus,
} from './chatgptAuth.js'
