import { describe, it, expect, beforeEach } from 'vitest';
import { JobStore } from '../src/engine/store.js';
import { Supervisor } from '../src/engine/supervisor.js';
import { JobTransitionError, type Strategy } from '../src/engine/job.js';
import { Executor } from '../src/shared/executor.js';
import { SpendLedger, type ExecutionPolicy } from '../src/shared/execution-mode.js';
import type { RobinhoodCryptoClient } from '../src/shared/client.js';
import type { Credentials } from '../src/shared/config.js';

/** Records every call so tests can assert what did and did not reach the API. */
class FakeClient {
  posts: Array<{ path: string; body: unknown }> = [];
  /** Orders the API will report; drives reconciliation outcomes. */
  upstreamOrders: Array<Record<string, unknown>> = [];
  /** When true, the page walk reports that it did not finish. */
  truncatePageWalk = false;
  failNextPost: Error | null = null;
  price = 100;

  async get(path: string): Promise<unknown> {
    if (path.includes('best_bid_ask')) {
      return {
        results: [
          {
            symbol: 'BTC-USD',
            ask_inclusive_of_buy_spread: String(this.price),
            bid_inclusive_of_sell_spread: String(this.price),
          },
        ],
      };
    }
    return { results: [] };
  }

  async post(path: string, options?: { body?: unknown }): Promise<unknown> {
    if (this.failNextPost) {
      const error = this.failNextPost;
      this.failNextPost = null;
      throw error;
    }
    this.posts.push({ path, body: options?.body });
    const body = options?.body as Record<string, unknown> | undefined;
    return { id: `order-${this.posts.length}`, client_order_id: body?.client_order_id, state: 'open' };
  }

  async getAllPages(): Promise<{ results: unknown[]; truncated: boolean }> {
    return { results: this.upstreamOrders, truncated: this.truncatePageWalk };
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

function harness(strategies: Strategy[] = [], now = () => 1_000) {
  const store = new JobStore(':memory:');
  const client = new FakeClient();
  const executor = new Executor(
    client as unknown as RobinhoodCryptoClient,
    credentials,
    policy,
    new SpendLedger(policy),
  );
  const supervisor = new Supervisor(store, executor, strategies, {
    now,
    log: () => {},
  });
  return { store, client, executor, supervisor };
}

/** Minimal strategy that submits one order then completes. */
const oneShot: Strategy = {
  name: 'one_shot',
  description: 'Submits a single order, then completes.',
  defaultIntervalMs: 1_000,
  async init() {
    return { state: {}, symbol: 'BTC-USD' };
  },
  async advance(job) {
    return {
      state: { advanced: true },
      actions: [
        {
          type: 'submit',
          order: { symbol: job.symbol, side: 'buy', type: 'limit', assetQuantity: '1', limitPrice: '100' },
        },
      ],
      done: { status: 'completed' },
    };
  },
};

describe('JobStore', () => {
  let store: JobStore;
  beforeEach(() => {
    store = new JobStore(':memory:');
  });

  it('round-trips a job through JSON state', () => {
    const job = store.createJob({
      strategy: 'twap',
      symbol: 'btc-usd',
      state: { slicesDone: 0, nested: { a: [1, 2] } },
      params: { slices: 4 },
      nextRunAt: 500,
    });

    const loaded = store.getJob(job.id);
    expect(loaded?.symbol).toBe('BTC-USD');
    expect(loaded?.state).toEqual({ slicesDone: 0, nested: { a: [1, 2] } });
    expect(loaded?.status).toBe('pending');
  });

  it('returns only jobs that are due', () => {
    const early = store.createJob({ strategy: 's', symbol: 'A-USD', state: {}, params: {}, nextRunAt: 100 });
    store.createJob({ strategy: 's', symbol: 'B-USD', state: {}, params: {}, nextRunAt: 9_999 });

    const due = store.dueJobs(500);
    expect(due.map((j) => j.id)).toEqual([early.id]);
  });

  it('refuses to revive a terminal job', () => {
    // A strategy bug must not resurrect a cancelled job and start spending.
    const job = store.createJob({ strategy: 's', symbol: 'A-USD', state: {}, params: {}, nextRunAt: 0 });
    store.updateJob(job.id, { status: 'cancelled' });

    expect(() => store.updateJob(job.id, { status: 'running' })).toThrow(JobTransitionError);
  });

  it('rejects a duplicate client_order_id', () => {
    // The uniqueness constraint is what makes the id a real idempotency key.
    store.reserveIntent({ jobId: null, clientOrderId: 'abc', body: {}, notionalUsd: 1 });
    expect(() =>
      store.reserveIntent({ jobId: null, clientOrderId: 'abc', body: {}, notionalUsd: 1 }),
    ).toThrow();
  });

  it('lists pending intents as the recovery work list', () => {
    store.reserveIntent({ jobId: null, clientOrderId: 'a', body: {}, notionalUsd: 1 });
    store.reserveIntent({ jobId: null, clientOrderId: 'b', body: {}, notionalUsd: 1 });
    store.settleIntent('a', { status: 'submitted', orderId: 'order-1' });

    expect(store.pendingIntents().map((i) => i.clientOrderId)).toEqual(['b']);
  });

  it('rolls back a failed transaction', () => {
    const job = store.createJob({ strategy: 's', symbol: 'A-USD', state: { v: 1 }, params: {}, nextRunAt: 0 });
    expect(() =>
      store.transaction(() => {
        store.updateJob(job.id, { state: { v: 2 } });
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(store.getJob(job.id)?.state).toEqual({ v: 1 });
  });
});

describe('Supervisor', () => {
  it('advances a due job and submits its order', async () => {
    const { store, client, supervisor } = harness([oneShot]);
    store.createJob({ strategy: 'one_shot', symbol: 'BTC-USD', state: {}, params: {}, nextRunAt: 0 });

    const advanced = await supervisor.tick();

    expect(advanced).toBe(1);
    expect(client.posts).toHaveLength(1);
    expect(store.listJobs({ status: 'completed' })).toHaveLength(1);
  });

  it('skips a job that is not yet due', async () => {
    const { store, client, supervisor } = harness([oneShot]);
    store.createJob({ strategy: 'one_shot', symbol: 'BTC-USD', state: {}, params: {}, nextRunAt: 99_999 });

    expect(await supervisor.tick()).toBe(0);
    expect(client.posts).toHaveLength(0);
  });

  it('fails a job whose strategy is unknown instead of throwing', async () => {
    const { store, supervisor } = harness([]);
    const job = store.createJob({ strategy: 'ghost', symbol: 'BTC-USD', state: {}, params: {}, nextRunAt: 0 });

    await supervisor.tick();

    const loaded = store.getJob(job.id);
    expect(loaded?.status).toBe('failed');
    expect(loaded?.lastError).toMatch(/Unknown strategy/);
  });

  it('isolates a throwing strategy to its own job', async () => {
    const exploding: Strategy = {
      name: 'exploding',
      description: 'Throws.',
      defaultIntervalMs: 1_000,
      async init() {
        return { state: {}, symbol: 'BTC-USD' };
      },
      async advance() {
        throw new Error('strategy bug');
      },
    };

    const { store, supervisor } = harness([exploding, oneShot]);
    const bad = store.createJob({ strategy: 'exploding', symbol: 'BTC-USD', state: {}, params: {}, nextRunAt: 0 });
    const good = store.createJob({ strategy: 'one_shot', symbol: 'BTC-USD', state: {}, params: {}, nextRunAt: 0 });

    await supervisor.tick();

    expect(store.getJob(bad.id)?.status).toBe('failed');
    expect(store.getJob(good.id)?.status).toBe('completed');
  });

  it('records an intent before submitting, and settles it after', async () => {
    const { store, supervisor } = harness([oneShot]);
    const job = store.createJob({ strategy: 'one_shot', symbol: 'BTC-USD', state: {}, params: {}, nextRunAt: 0 });

    await supervisor.tick();

    const intents = store.intentsForJob(job.id);
    expect(intents).toHaveLength(1);
    expect(intents[0]?.status).toBe('submitted');
    expect(intents[0]?.orderId).toBe('order-1');
  });

  it('marks the intent failed when submission is rejected', async () => {
    const { store, client, supervisor } = harness([oneShot]);
    client.failNextPost = new Error('rejected by venue');
    const job = store.createJob({ strategy: 'one_shot', symbol: 'BTC-USD', state: {}, params: {}, nextRunAt: 0 });

    await supervisor.tick();

    const intents = store.intentsForJob(job.id);
    expect(intents[0]?.status).toBe('failed');
    expect(intents[0]?.error).toMatch(/rejected by venue/);
  });
});

describe('crash reconciliation', () => {
  it('adopts an order that reached Robinhood before the crash', async () => {
    // The double-fill case: the process died between submit and record.
    const { store, client, supervisor } = harness([oneShot]);
    const job = store.createJob({ strategy: 'one_shot', symbol: 'BTC-USD', state: {}, params: {}, nextRunAt: 0 });
    store.reserveIntent({ jobId: job.id, clientOrderId: 'coid-1', body: {}, notionalUsd: 10 });

    client.upstreamOrders = [{ id: 'upstream-9', client_order_id: 'coid-1', state: 'filled' }];

    const result = await supervisor.reconcile();

    expect(result).toEqual({ adopted: 1, released: 0, unresolved: 0 });
    const intent = store.getIntentByClientOrderId('coid-1');
    expect(intent?.status).toBe('submitted');
    expect(intent?.orderId).toBe('upstream-9');
    // Critically: adopting must not place a second order.
    expect(client.posts).toHaveLength(0);
  });

  it('abandons an order Robinhood never saw', async () => {
    const { store, client, supervisor } = harness([oneShot]);
    const job = store.createJob({ strategy: 'one_shot', symbol: 'BTC-USD', state: {}, params: {}, nextRunAt: 0 });
    store.reserveIntent({ jobId: job.id, clientOrderId: 'coid-2', body: {}, notionalUsd: 10 });

    client.upstreamOrders = [];

    const result = await supervisor.reconcile();

    expect(result).toEqual({ adopted: 0, released: 1, unresolved: 0 });
    expect(store.getIntentByClientOrderId('coid-2')?.status).toBe('abandoned');
  });

  it('leaves an intent pending when the check is inconclusive', async () => {
    // An error must not be read as "not found": that would risk a double-fill.
    const { store, executor, supervisor } = harness([oneShot]);
    store.reserveIntent({ jobId: null, clientOrderId: 'coid-3', body: {}, notionalUsd: 10 });

    executor.findOrderByClientOrderId = async () => {
      throw new Error('network down');
    };

    const result = await supervisor.reconcile();

    expect(result).toEqual({ adopted: 0, released: 0, unresolved: 1 });
    expect(store.getIntentByClientOrderId('coid-3')?.status).toBe('pending');
  });

  it('does not abandon an intent when the search was truncated', async () => {
    // The money-losing bug this guards: a bounded walk that did not reach the
    // order must never be read as proof the order does not exist. Abandoning
    // here lets the strategy re-place the slice under a new client_order_id.
    const { store, client, supervisor } = harness([oneShot]);
    store.reserveIntent({ jobId: null, clientOrderId: 'coid-4', body: {}, notionalUsd: 10 });

    client.upstreamOrders = [];
    client.truncatePageWalk = true;

    const result = await supervisor.reconcile();

    expect(result).toEqual({ adopted: 0, released: 0, unresolved: 1 });
    expect(store.getIntentByClientOrderId('coid-4')?.status).toBe('pending');
  });

  it('still adopts a match found within a truncated page walk', async () => {
    // Truncation only blocks the negative conclusion; a hit is still a hit.
    const { store, client, supervisor } = harness([oneShot]);
    store.reserveIntent({ jobId: null, clientOrderId: 'coid-5', body: {}, notionalUsd: 10 });

    client.upstreamOrders = [{ id: 'upstream-5', client_order_id: 'coid-5', state: 'open' }];
    client.truncatePageWalk = true;

    const result = await supervisor.reconcile();

    expect(result).toEqual({ adopted: 1, released: 0, unresolved: 0 });
    expect(store.getIntentByClientOrderId('coid-5')?.status).toBe('submitted');
  });

  it('retries an unresolved intent on the next reconcile', async () => {
    const { store, client, supervisor } = harness([oneShot]);
    store.reserveIntent({ jobId: null, clientOrderId: 'coid-6', body: {}, notionalUsd: 10 });

    client.truncatePageWalk = true;
    expect((await supervisor.reconcile()).unresolved).toBe(1);

    // The page ceiling stops being a problem; the intent resolves.
    client.truncatePageWalk = false;
    client.upstreamOrders = [{ id: 'upstream-6', client_order_id: 'coid-6', state: 'filled' }];

    expect((await supervisor.reconcile()).adopted).toBe(1);
    expect(store.getIntentByClientOrderId('coid-6')?.status).toBe('submitted');
  });

  it('is a no-op when nothing is unsettled', async () => {
    const { supervisor } = harness([oneShot]);
    expect(await supervisor.reconcile()).toEqual({ adopted: 0, released: 0, unresolved: 0 });
  });
});
