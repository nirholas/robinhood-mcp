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
import { assertTradingEnabled, loadExecutionPolicy, SpendLedger } from './shared/execution-mode.js';
import { Executor } from './shared/executor.js';
import { registerDataTools } from './register-data.js';
import { registerTradingTools } from './register-trading.js';
import { registerAlgoTools } from './tools/algo.js';
import { JobStore } from './engine/store.js';
import { Supervisor } from './engine/supervisor.js';
import { ALL_STRATEGIES } from './engine/strategies/index.js';
import { jobDatabasePath } from './shared/config.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { VERSION } from './version.js';

export function createTradingServer(): McpServer {
  const credentials = loadCredentials();
  // Throws unless the operator explicitly opted in.
  assertTradingEnabled();

  const policy = loadExecutionPolicy();
  const client = new RobinhoodCryptoClient(credentials);
  const executor = new Executor(client, credentials, policy, new SpendLedger(policy));

  const server = new McpServer({
    name: 'robinhood-mcp-trading',
    version: VERSION,
  });

  registerDataTools(server, client, credentials);
  registerTradingTools(server, executor);

  // Durable execution jobs. The same database backs the standalone daemon, so
  // a job started here keeps running under `robinhood-mcp-daemon` after this
  // conversation ends.
  const dbPath = jobDatabasePath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const store = new JobStore(dbPath);
  const supervisor = new Supervisor(store, executor, ALL_STRATEGIES);

  registerAlgoTools(server, store, supervisor, () => supervisorRunning);

  // Advance jobs while this server is connected. The daemon is what keeps them
  // moving when it is not.
  let supervisorRunning = false;
  void supervisor.start().then(
    () => {
      supervisorRunning = true;
    },
    (error: unknown) => {
      console.error(
        `[robinhood-mcp-trading] supervisor failed to start: ${error instanceof Error ? error.message : error}`,
      );
    },
  );
  return server;
}

export async function main(): Promise<void> {
  try {
    const server = createTradingServer();
    await server.connect(new StdioServerTransport());
    const mode = loadExecutionPolicy().mode;
    console.error(
      `[robinhood-mcp-trading] Trading enabled in ${mode} mode. ` +
        'Orders place real money against a live account.',
    );
  } catch (error) {
    console.error(`[robinhood-mcp-trading] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

