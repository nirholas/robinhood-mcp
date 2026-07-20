/**
 * Degraded startup when credentials are absent.
 *
 * An MCP client launches this server as a subprocess and expects the
 * `initialize` handshake to complete. Exiting because no API key is set makes
 * the client report an opaque "server failed to start", hides every tool, and
 * leaves the user with no in-protocol explanation of what to do next.
 *
 * So an unconfigured server still comes up. It registers a single tool that
 * reports exactly what is missing, which turns a dead subprocess into an
 * answerable question the assistant can relay.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolResult } from './format.js';

/**
 * Register the setup-help tool on a server that has no usable credentials.
 *
 * @param server The server to register on.
 * @param reason The error raised while loading credentials.
 */
export function registerUnconfiguredTools(server: McpServer, reason: unknown): void {
  const detail = reason instanceof Error ? reason.message : String(reason);

  server.registerTool(
    'get_setup_status',
    {
      title: 'Get setup status',
      description:
        'Report why this Robinhood server has no working credentials and what to set. Every other tool is unavailable until credentials are configured, so call this first if no trading or market-data tools are listed.',
      inputSchema: {},
    },
    async () =>
      toolResult({
        configured: false,
        detail,
        required_environment: ['ROBINHOOD_CRYPTO_API_KEY', 'ROBINHOOD_CRYPTO_PRIVATE_KEY'],
        how_to_fix: [
          'Create a credential at https://robinhood.com/account/crypto (web classic only).',
          'Run `npx robinhood-keygen` to generate a conforming Ed25519 keypair.',
          'Register the PUBLIC key with Robinhood and set the base64 private seed as ROBINHOOD_CRYPTO_PRIVATE_KEY.',
          'Set ROBINHOOD_CRYPTO_API_KEY to the API key Robinhood issued, then restart this server.',
        ],
      }),
  );
}
