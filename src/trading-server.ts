/**
 * Trading MCP server for the Robinhood Crypto Trading API.
 *
 * A superset of the read-only server: every read tool plus order placement and
 * the durable execution engine. Refuses to start unless
 * ROBINHOOD_CRYPTO_ENABLE_TRADING=1, so it can never be launched by accident.
 *
 * Which tools appear is chosen by ROBINHOOD_MCP_MODULES; see tools/registry.ts.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { RobinhoodCryptoClient } from './shared/client.js';
import { jobDatabasePath, loadCredentials } from './shared/config.js';
import { assertTradingEnabled, loadExecutionPolicy, SpendLedger } from './shared/execution-mode.js';
import { Executor } from './shared/executor.js';
import { KillSwitch } from './shared/kill-switch.js';
import { JobStore } from './engine/store.js';
import { Supervisor } from './engine/supervisor.js';
import { ALL_STRATEGIES } from './engine/strategies/index.js';
import { applyModules } from './tools/registry.js';
import { VERSION } from './version.js';

export function createTradingServer(): McpServer {
  const credentials = loadCredentials();
  // Throws unless the operator explicitly opted in.
  assertTradingEnabled();

  const policy = loadExecutionPolicy();
  const client = new RobinhoodCryptoClient(credentials);

  // Durable execution jobs. The same database backs the standalone daemon, so
  // a job started here keeps running under `robinhood-mcp-daemon` after this
  // conversation ends, and both read the same kill switch.
  const dbPath = jobDatabasePath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const store = new JobStore(dbPath);

  const executor = new Executor(
    client,
    credentials,
    policy,
    new SpendLedger(policy),
    new KillSwitch(store.database),
  );

  const server = new McpServer({ name: 'robinhood-mcp-trading', version: VERSION });

  const supervisor = new Supervisor(store, executor, ALL_STRATEGIES);

  let supervisorRunning = false;

  const loaded = applyModules(
    {
      server,
      client,
      credentials,
      executor,
      engine: { store, supervisor, daemonRunning: () => supervisorRunning },
    },
    { allowMutating: true, requested: process.env.ROBINHOOD_MCP_MODULES },
  );

  // Advance jobs while this server is connected. The daemon is what keeps them
  // moving when it is not.
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

  console.error(`[robinhood-mcp-trading] modules loaded: ${loaded.map((m) => m.name).join(', ')}`);

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
