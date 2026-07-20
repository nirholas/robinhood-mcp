/**
 * Deferred credential access.
 *
 * MCP clients launch a server and immediately expect it to complete the
 * `initialize` handshake and answer `tools/list`. If the server instead exits
 * because no API key is set, the client reports an opaque startup failure and
 * the user can never see what the server offers before configuring Robinhood.
 *
 * So credentials are resolved on FIRST USE rather than at construction: the
 * server always starts, tool discovery always works, and a call that genuinely
 * needs a key fails with the actionable message from `loadCredentials`.
 */

import { RobinhoodCryptoClient } from './client.js';
import { loadCredentials, type Credentials } from './config.js';

export interface RobinhoodAccess {
  /** The API client, constructed on first use. Throws if credentials are absent. */
  client(): RobinhoodCryptoClient;
  /** The resolved credentials. Throws if credentials are absent. */
  credentials(): Credentials;
  /** Whether credentials resolve, without throwing. For diagnostic tools. */
  isConfigured(): boolean;
}

/**
 * Build an accessor that memoizes credentials and the client after the first
 * successful resolution. A failed resolution is not cached, so setting the
 * environment and retrying works without a restart.
 */
export function createRobinhoodAccess(
  load: () => Credentials = loadCredentials,
): RobinhoodAccess {
  let cached: { client: RobinhoodCryptoClient; credentials: Credentials } | undefined;

  function resolve() {
    if (!cached) {
      const credentials = load();
      cached = { credentials, client: new RobinhoodCryptoClient(credentials) };
    }
    return cached;
  }

  return {
    client: () => resolve().client,
    credentials: () => resolve().credentials,
    isConfigured() {
      try {
        resolve();
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Wrap already-resolved credentials in the accessor shape, for call sites that
 * hold eager credentials and need to hand them to a deferred-access consumer.
 */
export function eagerRobinhoodAccess(
  credentials: Credentials,
  client: RobinhoodCryptoClient = new RobinhoodCryptoClient(credentials),
): RobinhoodAccess {
  return {
    client: () => client,
    credentials: () => credentials,
    isConfigured: () => true,
  };
}
