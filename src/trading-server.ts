/**
 * Trading MCP server for the Robinhood Crypto Trading API.
 *
 * A superset of the read-only server: every data tool plus `place_order` and
 * `cancel_order`. Refuses to start unless ROBINHOOD_CRYPTO_ENABLE_TRADING=1,
 * so it can never be launched by accident.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RobinhoodCryptoClient } from './shared/client.js';
import { loadCredentials } from './shared/config.js';
import { loadTradingGuards } from './shared/guards.js';
import { registerDataTools } from './register-data.js';
import { registerTradingTools } from './register-trading.js';
import { VERSION } from './version.js';

export function createTradingServer(): McpServer {
  const credentials = loadCredentials();
  // Throws unless the operator explicitly opted in.
  const guards = loadTradingGuards();
  const client = new RobinhoodCryptoClient(credentials);

  const server = new McpServer({
    name: 'robinhood-mcp-trading',
    version: VERSION,
  });

  registerDataTools(server, client, credentials);
  registerTradingTools(server, client, credentials, guards);
  return server;
}

export async function main(): Promise<void> {
  try {
    const server = createTradingServer();
    await server.connect(new StdioServerTransport());
    console.error(
      '[robinhood-mcp-trading] Trading enabled. Orders place real money against a live account.',
    );
  } catch (error) {
    console.error(`[robinhood-mcp-trading] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

