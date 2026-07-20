/**
 * Library entry point.
 *
 * The signed client is usable on its own, without MCP, for anyone who wants a
 * correct Robinhood Crypto Trading API client in Node.
 */

export { RobinhoodCryptoClient, RobinhoodApiError } from './shared/client.js';
export {
  buildAuthHeaders,
  buildSignatureMessage,
  privateKeyFromBase64Seed,
  publicKeyBase64,
  publicKeyFromBase64,
  currentTimestampSeconds,
  InvalidPrivateKeyError,
  TIMESTAMP_VALIDITY_SECONDS,
} from './shared/signer.js';
export {
  loadCredentials,
  configuredPublicKey,
  MissingCredentialsError,
  DEFAULT_BASE_URL,
  type Credentials,
  type ApiVersion,
} from './shared/config.js';
export { endpointsFor, requiresAccountNumber, type EndpointSet } from './shared/endpoints.js';
export {
  loadExecutionPolicy,
  assertTradingEnabled,
  SpendLedger,
  PolicyError,
  TradingDisabledError,
  DEFAULT_MAX_ORDER_USD,
  type ExecutionPolicy,
  type ExecutionMode,
} from './shared/execution-mode.js';
export {
  Executor,
  buildOrderBody,
  roundToIncrement,
  type OrderRequest,
  type PricedOrder,
  type SubmitResult,
} from './shared/executor.js';
export { selectModules, type ToolModule, type ModuleContext } from './tools/module.js';
export { createDataServer, main as runDataServer } from './data-server.js';
export { createTradingServer, main as runTradingServer } from './trading-server.js';
export { VERSION } from './version.js';
