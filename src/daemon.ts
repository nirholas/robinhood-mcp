/**
 * The always-on execution daemon.
 *
 * An MCP server only runs while a client holds it open, so a TWAP started
 * through MCP advances only while that conversation is alive. This daemon is
 * the answer: a standalone process that owns the same job database and keeps
 * advancing jobs whether or not any agent is connected.
 *
 * Run it under a supervisor that restarts it (systemd, launchd, pm2, a
 * container). Restarts are safe by design: reconciliation runs before any job
 * advances.
 *
 * Credentials stay on this machine. The daemon talks only to Robinhood.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { RobinhoodCryptoClient } from './shared/client.js';
import { loadCredentials, jobDatabasePath } from './shared/config.js';
import { assertTradingEnabled, loadExecutionPolicy, SpendLedger } from './shared/execution-mode.js';
import { Executor } from './shared/executor.js';
import { JobStore } from './engine/store.js';
import { Supervisor } from './engine/supervisor.js';
import { ALL_STRATEGIES } from './engine/strategies/index.js';
import { VERSION } from './version.js';

export interface DaemonHandle {
  store: JobStore;
  supervisor: Supervisor;
  stop(): void;
}

export async function startDaemon(): Promise<DaemonHandle> {
  const credentials = loadCredentials();
  // The daemon exists to place orders, so the opt-in is mandatory here.
  assertTradingEnabled();

  const policy = loadExecutionPolicy();
  const client = new RobinhoodCryptoClient(credentials);
  const executor = new Executor(client, credentials, policy, new SpendLedger(policy));

  const dbPath = jobDatabasePath();
  ensureParentDirectory(dbPath);

  const store = new JobStore(dbPath);
  const supervisor = new Supervisor(store, executor, ALL_STRATEGIES, {
    intervalMs: Number(process.env.ROBINHOOD_MCP_TICK_MS ?? 5_000),
  });

  console.error(`[daemon] robinhood-mcp ${VERSION}`);
  console.error(`[daemon] jobs: ${dbPath}`);
  console.error(`[daemon] mode: ${policy.mode}, max order $${policy.maxOrderUsd}`);
  console.error(`[daemon] strategies: ${ALL_STRATEGIES.map((s) => s.name).join(', ')}`);

  await supervisor.start();

  const active = store.listJobs({ status: 'running' }).length + store.listJobs({ status: 'pending' }).length;
  console.error(`[daemon] supervising ${active} active job(s)`);

  return {
    store,
    supervisor,
    stop() {
      supervisor.stop();
      store.close();
    },
  };
}

export async function main(): Promise<void> {
  let handle: DaemonHandle;
  try {
    handle = await startDaemon();
  } catch (error) {
    console.error(`[daemon] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  // Shut down cleanly so SQLite is not left mid-write.
  const shutdown = (signal: string) => {
    console.error(`[daemon] ${signal}, shutting down`);
    handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Hold the process open; the supervisor's timer is unref'd on purpose.
  await new Promise<void>(() => {});
}

function ensureParentDirectory(filePath: string): void {
  const parent = dirname(filePath);
  if (parent && parent !== '.') mkdirSync(parent, { recursive: true });
}
