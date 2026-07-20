/**
 * Read-only MCP server for the Robinhood Crypto Trading API.
 *
 * Exposes quotes, holdings, account details, and order history. It builds no
 * Executor and no job store, so there is no code path here that can place an
 * order: it is safe to attach to a general-purpose assistant. Order placement
 * lives in `robinhood-mcp-trading`.
 *
 * Requesting a mutating module here is a startup error rather than a silent
 * omission, so an operator cannot believe they enabled execution when they did not.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RobinhoodCryptoClient } from './shared/client.js';
import { loadCredentials, type Credentials } from './shared/config.js';
import { registerUnconfiguredTools } from './shared/unconfigured.js';
import { applyModules } from './tools/registry.js';
import { VERSION } from './version.js';

export function createDataServer(): McpServer {
  const server = new McpServer({ name: 'robinhood-mcp', version: VERSION });

  // Come up even without credentials: an MCP client needs the initialize
  // handshake to succeed, and a dead subprocess explains nothing to the user.
  let credentials: Credentials;
  try {
    credentials = loadCredentials();
  } catch (error) {
    registerUnconfiguredTools(server, error);
    console.error(`[robinhood-mcp] starting unconfigured: ${
      error instanceof Error ? error.message : error
    }`);
    return server;
  }

  const client = new RobinhoodCryptoClient(credentials);

  const loaded = applyModules(
    { server, client, credentials },
    { allowMutating: false, requested: process.env.ROBINHOOD_MCP_MODULES },
  );

  console.error(`[robinhood-mcp] modules loaded: ${loaded.map((m) => m.name).join(', ')}`);

  return server;
}

export async function main(): Promise<void> {
  try {
    const server = createDataServer();
    await server.connect(new StdioServerTransport());
  } catch (error) {
    // stderr only: stdout is the MCP transport and must stay clean JSON-RPC.
    console.error(`[robinhood-mcp] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
