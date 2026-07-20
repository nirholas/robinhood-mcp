/**
 * The kill switch as an Executor dependency.
 *
 * These tests exist because of a specific bug. The switch was first enforced by
 * a tool module shadowing `Executor.submitOrder` at registration time, which
 * looked airtight from inside an MCP session. But `robinhood-mcp-daemon` builds
 * its own Executor and loads no tool modules, so the one process that runs
 * unattended and advances jobs on a timer never had the guard installed. An
 * operator throwing the switch would watch orders keep going out.
 *
 * The cases below pin the property that fixes it: a halt is honoured by any
 * Executor constructed with a KillSwitch, whatever registered tools it has, and
 * it is read from disk rather than from process memory so one process can stop
 * another.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Executor } from '../src/shared/executor.js';
import { KillSwitch, RELEASED } from '../src/shared/kill-switch.js';
import { SpendLedger, PolicyError, type ExecutionPolicy } from '../src/shared/execution-mode.js';
import { JobStore } from '../src/engine/store.js';
import { Supervisor } from '../src/engine/supervisor.js';
import type { Strategy } from '../src/engine/job.js';
import type { RobinhoodCryptoClient } from '../src/shared/client.js';
import type { Credentials } from '../src/shared/config.js';

class FakeClient {
  posts: Array<{ path: string }> = [];

  async get(path: string): Promise<unknown> {
    if (path.includes('best_bid_ask')) {
      return {
        results: [
          {
            symbol: 'BTC-USD',
            ask_inclusive_of_buy_spread: '100',
            bid_inclusive_of_sell_spread: '100',
          },
        ],
      };
    }
    return { results: [] };
  }

  async post(path: string): Promise<unknown> {
    this.posts.push({ path });
    return { id: `order-${this.posts.length}`, state: 'open' };
  }

  async getAllPages(): Promise<{ results: unknown[]; truncated: boolean }> {
    return { results: [], truncated: false };
  }
}

const credentials = { apiVersion: 'v1' } as Credentials;
const policy: ExecutionPolicy = {
  mode: 'autonomous',
  maxOrderUsd: 10_000,
  maxDailyUsd: null,
  symbolAllowlist: null,
  buyOnly: false,
};

function buildExecutor(store: JobStore, fake = new FakeClient()) {
  return {
    fake,
    executor: new Executor(
      fake as unknown as RobinhoodCryptoClient,
      credentials,
      policy,
      new SpendLedger(policy),
      new KillSwitch(store.database),
    ),
  };
}

const order = {
  symbol: 'BTC-USD',
  side: 'buy' as const,
  type: 'market' as const,
  assetQuantity: '0.1',
};

function engage(store: JobStore, reason: string) {
  new KillSwitch(store.database).write({
    ...RELEASED,
    engaged: true,
    reason,
    engagedAt: Date.now(),
  });
}

describe('kill switch enforcement', () => {
  it('blocks a submit with no tool module registered anywhere', async () => {
    // The daemon's exact shape: an Executor and a store, no MCP server.
    const store = new JobStore(':memory:');
    const { executor, fake } = buildExecutor(store);

    engage(store, 'testing the unattended path');

    await expect(executor.submitOrder(order, true)).rejects.toThrow(PolicyError);
    expect(fake.posts).toHaveLength(0);
  });

  it('blocks the pre-trade check too, so a caller cannot pre-clear an order', async () => {
    const store = new JobStore(':memory:');
    const { executor } = buildExecutor(store);
    const priced = await executor.price(order);

    engage(store, 'halt');

    expect(() => executor.assertAllowed(priced)).toThrow(PolicyError);
  });

  it('allows orders again once released', async () => {
    const store = new JobStore(':memory:');
    const { executor, fake } = buildExecutor(store);

    engage(store, 'halt');
    await expect(executor.submitOrder(order, true)).rejects.toThrow(PolicyError);

    new KillSwitch(store.database).write({ ...RELEASED, releasedAt: Date.now() });

    await executor.submitOrder(order, true);
    expect(fake.posts).toHaveLength(1);
  });

  it('stops a running strategy mid-flight', async () => {
    // The scenario that motivated the fix: a TWAP already slicing when the
    // operator hits stop must not place its next slice.
    const store = new JobStore(':memory:');
    const { executor, fake } = buildExecutor(store);

    const everyTick: Strategy = {
      name: 'every_tick',
      description: 'Submits one order on every advance, for testing the halt.',
      defaultIntervalMs: 1,
      async init() {
        return { state: {}, symbol: 'BTC-USD' };
      },
      async advance() {
        return { state: {}, actions: [{ type: 'submit', order }] };
      },
    };

    const supervisor = new Supervisor(store, executor, [everyTick], { log: () => {} });
    const job = store.createJob({
      strategy: 'every_tick',
      symbol: 'BTC-USD',
      state: {},
      params: {},
      nextRunAt: 0,
    });

    await supervisor.advanceJob(job);
    expect(fake.posts).toHaveLength(1);

    engage(store, 'stop everything');

    await supervisor.advanceJob(store.getJob(job.id)!);
    // Still one: the second slice was refused, not placed.
    expect(fake.posts).toHaveLength(1);
  });

  it('lets one process halt another through the shared database', async () => {
    // An operator engages from an MCP session; the daemon is a separate process
    // holding a separate handle to the same file. State must cross that gap.
    const dir = mkdtempSync(join(tmpdir(), 'rh-kill-'));
    const path = join(dir, 'jobs.db');

    const daemonStore = new JobStore(path);
    const { executor, fake } = buildExecutor(daemonStore);

    const operatorStore = new JobStore(path);
    engage(operatorStore, 'engaged from a different connection');

    await expect(executor.submitOrder(order, true)).rejects.toThrow(PolicyError);
    expect(fake.posts).toHaveLength(0);
  });

  it('is not cached, so a halt takes effect on the very next order', async () => {
    const store = new JobStore(':memory:');
    const { executor, fake } = buildExecutor(store);

    await executor.submitOrder(order, true);
    expect(fake.posts).toHaveLength(1);

    engage(store, 'halt after a successful order');

    await expect(executor.submitOrder(order, true)).rejects.toThrow(PolicyError);
    expect(fake.posts).toHaveLength(1);
  });

  it('names the reason in the refusal', async () => {
    const store = new JobStore(':memory:');
    const { executor } = buildExecutor(store);

    engage(store, 'suspected runaway strategy');

    await expect(executor.submitOrder(order, true)).rejects.toThrow(/suspected runaway strategy/);
  });

  it('fails closed when the persisted row is corrupt', async () => {
    // A safety control that cannot be read must not read as "off".
    const store = new JobStore(':memory:');
    const { executor } = buildExecutor(store);

    store.database
      .prepare(
        `INSERT INTO risk_controls (key, value, updated_at) VALUES ('kill_switch', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run('{not valid json', Date.now());

    await expect(executor.submitOrder(order, true)).rejects.toThrow(PolicyError);
  });

  it('does nothing when no kill switch is configured', async () => {
    // The read-only server builds no store; an absent switch must not throw.
    const fake = new FakeClient();
    const executor = new Executor(
      fake as unknown as RobinhoodCryptoClient,
      credentials,
      policy,
      new SpendLedger(policy),
    );

    await executor.submitOrder(order, true);
    expect(fake.posts).toHaveLength(1);
  });
});
