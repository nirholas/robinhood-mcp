/**
 * MCP-level tests for the risk module.
 *
 * These drive a real McpServer over an in-memory transport, and a real SQLite
 * JobStore, so the kill switch is exercised through the same path an operator
 * hits: schema validation, tool dispatch, a durable write, and an order that
 * actually gets refused. The HTTP client is the only substitution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerRiskTools } from '../src/tools/risk.js';
import { registerOrderTools } from '../src/tools/orders.js';
import { Executor } from '../src/shared/executor.js';
import { SpendLedger, type ExecutionPolicy } from '../src/shared/execution-mode.js';
import { JobStore } from '../src/engine/store.js';
import { KillSwitch } from '../src/shared/kill-switch.js';
import type { RobinhoodCryptoClient } from '../src/shared/client.js';
import type { Credentials } from '../src/shared/config.js';

interface FakeHolding {
  asset_code: string;
  total_quantity: string;
}

class FakeClient {
  posts: Array<{ path: string; body: Record<string, unknown> }> = [];

  /** Asset code to price. An asset absent from this map cannot be quoted. */
  prices: Record<string, number> = { BTC: 50_000, ETH: 2_000 };

  holdings: FakeHolding[] = [
    { asset_code: 'BTC', total_quantity: '0.1' },
    { asset_code: 'ETH', total_quantity: '0.5' },
  ];

  orders: Array<Record<string, unknown>> = [];

  tradingPairs: Array<Record<string, unknown>> = [
    {
      symbol: 'BTC-USD',
      asset_increment: '0.00000001',
      quote_increment: '0.01',
      min_order_size: '0.000001',
    },
    {
      symbol: 'ETH-USD',
      asset_increment: '0.0001',
      quote_increment: '0.01',
      min_order_size: '0.001',
    },
  ];

  async get(path: string, options?: { query?: Record<string, unknown> }): Promise<unknown> {
    if (path.includes('best_bid_ask')) {
      const requested = options?.query?.symbol as string[] | undefined;
      const symbol = requested?.[0] ?? '';
      const asset = symbol.split('-')[0] ?? '';
      const price = this.prices[asset];
      if (price === undefined) return { results: [] };
      return {
        results: [
          {
            symbol,
            ask_inclusive_of_buy_spread: String(price),
            bid_inclusive_of_sell_spread: String(price),
          },
        ],
      };
    }
    return { results: [] };
  }

  async post(path: string, options?: { body?: unknown }): Promise<unknown> {
    const body = (options?.body ?? {}) as Record<string, unknown>;
    this.posts.push({ path, body });
    return { id: `order-${this.posts.length}`, client_order_id: body.client_order_id, state: 'open' };
  }

  async getAllPages(
    path: string,
    options?: { query?: Record<string, unknown> },
  ): Promise<{ results: unknown[]; truncated: boolean }> {
    if (path.includes('holdings')) return { results: this.holdings, truncated: false };
    if (path.includes('trading_pairs')) {
      const requested = options?.query?.symbol as string[] | undefined;
      const symbol = requested?.[0];
      return {
        results: symbol ? this.tradingPairs.filter((p) => p.symbol === symbol) : this.tradingPairs,
        truncated: false,
      };
    }
    if (path.includes('orders')) return { results: this.orders, truncated: false };
    return { results: [], truncated: false };
  }
}

const credentials = { apiVersion: 'v1' } as Credentials;

function policyWith(overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return {
    mode: 'guarded',
    maxOrderUsd: 10_000,
    maxDailyUsd: null,
    symbolAllowlist: null,
    buyOnly: false,
    ...overrides,
  };
}

interface HarnessOptions {
  policy?: Partial<ExecutionPolicy>;
  /** Persist to this file instead of :memory:, so a restart can be simulated. */
  storePath?: string;
  fake?: FakeClient;
}

async function harness(options: HarnessOptions = {}) {
  const policy = policyWith(options.policy);
  const fake = options.fake ?? new FakeClient();
  const store = new JobStore(options.storePath ?? ':memory:');

  // Constructed exactly as the servers and the daemon construct it: the kill
  // switch is an Executor dependency, not something a tool module patches in.
  const executor = new Executor(
    fake as unknown as RobinhoodCryptoClient,
    credentials,
    policy,
    new SpendLedger(policy),
    new KillSwitch(store.database),
  );

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerRiskTools(server, executor, store);
  // Registered alongside so the kill switch can be shown to stop a real order
  // tool, not merely to report itself as engaged.
  registerOrderTools(server, executor);

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { client, fake, executor, store };
}

/** Tool results are a JSON text block; parse it back for assertions. */
function payload(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

function text(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]!.text;
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

/** A filled order in the shape `fillsFromOrders` reads. */
function filledOrder(
  id: string,
  side: 'buy' | 'sell',
  quantity: string,
  price: string,
  at: string,
): Record<string, unknown> {
  return {
    id,
    symbol: 'BTC-USD',
    side,
    state: 'filled',
    filled_asset_quantity: quantity,
    average_price: price,
    updated_at: at,
  };
}

describe('risk module registration', () => {
  it('registers every risk tool', async () => {
    const h = await harness();
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name).filter((n) => n.startsWith('risk_')).sort();

    expect(names).toEqual([
      'risk_check_order',
      'risk_concentration',
      'risk_drawdown',
      'risk_exposure',
      'risk_kill_switch_engage',
      'risk_kill_switch_release',
      'risk_limits_export',
      'risk_position_size',
      'risk_status',
    ]);
  });
});

describe('risk_status', () => {
  let h: Awaited<ReturnType<typeof harness>>;

  beforeEach(async () => {
    h = await harness({ policy: { maxDailyUsd: 500, symbolAllowlist: ['BTC-USD'], buyOnly: true } });
  });

  it('reports the policy, the session spend, and a released kill switch', async () => {
    const body = payload(await h.client.callTool({ name: 'risk_status', arguments: {} }));

    expect(body.kill_switch).toMatchObject({ engaged: false });
    expect(body.policy).toMatchObject({
      mode: 'guarded',
      max_order_usd: 10_000,
      max_daily_usd: 500,
      symbol_allowlist: ['BTC-USD'],
      buy_only: true,
    });
    expect(body.session_spend).toMatchObject({ committed_usd: 0, remaining_usd: 500 });
  });

  it('counts non-terminal jobs by status', async () => {
    const job = h.store.createJob({
      strategy: 'twap',
      symbol: 'BTC-USD',
      state: {},
      params: {},
      nextRunAt: Date.now(),
    });
    h.store.updateJob(job.id, { status: 'running' });
    h.store.createJob({
      strategy: 'dca',
      symbol: 'ETH-USD',
      state: {},
      params: {},
      nextRunAt: Date.now(),
    });

    const body = payload(await h.client.callTool({ name: 'risk_status', arguments: {} }));
    expect(body.jobs).toMatchObject({ running: 1, pending: 1, total_non_terminal: 2 });
  });

  it('reflects spend committed by a placed order', async () => {
    await h.client.callTool({
      name: 'buy_market',
      arguments: { symbol: 'BTC-USD', asset_quantity: '0.001', confirm: true },
    });

    const body = payload(await h.client.callTool({ name: 'risk_status', arguments: {} }));
    // 0.001 BTC at 50,000 = $50.
    expect((body.session_spend as { committed_usd: number }).committed_usd).toBeCloseTo(50);
    expect((body.session_spend as { remaining_usd: number }).remaining_usd).toBeCloseTo(450);
  });
});

describe('risk_exposure', () => {
  it('values every holding live and reports its share', async () => {
    const h = await harness();
    const body = payload(await h.client.callTool({ name: 'risk_exposure', arguments: {} }));

    // 0.1 BTC at 50,000 = 5,000. 0.5 ETH at 2,000 = 1,000. Total 6,000.
    expect(body.total_exposure_usd).toBeCloseTo(6_000);
    expect(body.complete).toBe(true);

    const positions = body.positions as Array<Record<string, number | string>>;
    expect(positions[0]).toMatchObject({ asset: 'BTC', value_usd: 5_000 });
    expect(positions[0]!.share_percent as number).toBeCloseTo((5_000 / 6_000) * 100);
    expect(positions[1]!.share_percent as number).toBeCloseTo((1_000 / 6_000) * 100);
  });

  it('reports an unquotable asset as unpriceable rather than as zero', async () => {
    const fake = new FakeClient();
    fake.holdings.push({ asset_code: 'DOGE', total_quantity: '1000' });
    const h = await harness({ fake });

    const body = payload(await h.client.callTool({ name: 'risk_exposure', arguments: {} }));

    expect(body.complete).toBe(false);
    expect(body.unpriceable_assets).toEqual(['DOGE']);
    const doge = (body.positions as Array<Record<string, unknown>>).find((p) => p.asset === 'DOGE');
    expect(doge).toMatchObject({ value_usd: null, share_percent: null });
    expect(String(body.warning)).toContain('lower bound');
  });

  it('reports an empty account without inventing a position', async () => {
    const fake = new FakeClient();
    fake.holdings = [];
    const h = await harness({ fake });

    const body = payload(await h.client.callTool({ name: 'risk_exposure', arguments: {} }));
    expect(body.positions).toEqual([]);
    expect(body.total_exposure_usd).toBe(0);
  });
});

describe('risk_concentration', () => {
  it('flags a position above the default 25 percent threshold', async () => {
    const h = await harness();
    const body = payload(await h.client.callTool({ name: 'risk_concentration', arguments: {} }));

    expect(body.threshold_percent).toBe(25);
    const breaches = body.breaches as Array<Record<string, unknown>>;
    // BTC is 83% of the book, ETH is 17%.
    expect(breaches.map((b) => b.asset)).toEqual(['BTC']);
    expect((body.within_threshold as Array<Record<string, unknown>>).map((r) => r.asset)).toEqual([
      'ETH',
    ]);
  });

  it('honours a caller-supplied threshold', async () => {
    const h = await harness();
    const body = payload(
      await h.client.callTool({
        name: 'risk_concentration',
        arguments: { threshold_percent: 90 },
      }),
    );

    expect(body.breaches).toEqual([]);
    expect(String(body.verdict)).toContain('No position exceeds 90%');
  });

  it('fails closed when a holding cannot be priced', async () => {
    const fake = new FakeClient();
    fake.holdings.push({ asset_code: 'DOGE', total_quantity: '1000' });
    const h = await harness({ fake });

    const result = await h.client.callTool({ name: 'risk_concentration', arguments: {} });

    expect(isError(result)).toBe(true);
    expect(text(result)).toContain('DOGE');
    expect(text(result)).toContain('allow_incomplete');
  });

  it('answers against the priced subset when explicitly allowed to', async () => {
    const fake = new FakeClient();
    fake.holdings.push({ asset_code: 'DOGE', total_quantity: '1000' });
    const h = await harness({ fake });

    const result = await h.client.callTool({
      name: 'risk_concentration',
      arguments: { allow_incomplete: true },
    });

    expect(isError(result)).toBe(false);
    const body = payload(result);
    expect(body.complete).toBe(false);
    expect((body.breaches as Array<Record<string, unknown>>).map((b) => b.asset)).toEqual(['BTC']);
  });
});

describe('risk_drawdown', () => {
  it('finds the peak-to-trough decline in total P&L', async () => {
    const fake = new FakeClient();
    // Buy 1 BTC at 10k, then mark it up and back down through later trades.
    fake.orders = [
      filledOrder('o1', 'buy', '1', '10000', '2026-01-01T00:00:00Z'),
      filledOrder('o2', 'buy', '0.0001', '20000', '2026-01-02T00:00:00Z'),
      filledOrder('o3', 'buy', '0.0001', '12000', '2026-01-03T00:00:00Z'),
    ];
    fake.prices = { BTC: 20_000, ETH: 2_000 };
    const h = await harness({ fake });

    const body = payload(await h.client.callTool({ name: 'risk_drawdown', arguments: {} }));

    // Curve: 0 at the first buy, then +10,000 with the 1 BTC lot marked at 20k,
    // then +1,999.20 at the 12k mark (the 1 BTC lot is up 2,000 and the small
    // 20k lot is down 0.80), then back up on the live mark at 20k.
    expect(body.max_drawdown_usd as number).toBeCloseTo(8_000.8, 2);
    expect((body.peak as { pnl_usd: number }).pnl_usd).toBeCloseTo(10_000, 2);
    expect((body.trough as { pnl_usd: number }).pnl_usd).toBeCloseTo(1_999.2, 2);
    expect(body.marked_to_live_price).toBe(true);
    expect(body.realized_pnl_usd).toBe(0);
  });

  it('reports no drawdown when the curve only rises', async () => {
    const fake = new FakeClient();
    fake.orders = [
      filledOrder('o1', 'buy', '1', '10000', '2026-01-01T00:00:00Z'),
      filledOrder('o2', 'buy', '0.0001', '11000', '2026-01-02T00:00:00Z'),
    ];
    fake.prices = { BTC: 12_000, ETH: 2_000 };
    const h = await harness({ fake });

    const body = payload(await h.client.callTool({ name: 'risk_drawdown', arguments: {} }));
    expect(body.max_drawdown_usd).toBe(0);
  });

  it('refuses to build a curve from a single fill', async () => {
    const fake = new FakeClient();
    fake.orders = [filledOrder('o1', 'buy', '1', '10000', '2026-01-01T00:00:00Z')];
    const h = await harness({ fake });

    const body = payload(await h.client.callTool({ name: 'risk_drawdown', arguments: {} }));
    expect(body.fills).toBe(1);
    expect(String(body.message)).toContain('one point is not one');
  });

  it('stops the curve at the last fill when an open position cannot be priced', async () => {
    const fake = new FakeClient();
    fake.orders = [
      filledOrder('o1', 'buy', '1', '10000', '2026-01-01T00:00:00Z'),
      filledOrder('o2', 'buy', '0.0001', '11000', '2026-01-02T00:00:00Z'),
    ];
    // Nothing is quotable, so no honest live mark can be added.
    fake.prices = {};
    const h = await harness({ fake });

    const body = payload(await h.client.callTool({ name: 'risk_drawdown', arguments: {} }));

    expect(body.marked_to_live_price).toBe(false);
    expect(body.unpriceable_assets).toEqual(['BTC']);
    expect(String(body.warning)).toContain('not counted');
  });
});

describe('risk_check_order', () => {
  it('allows an order inside every limit without placing it', async () => {
    const h = await harness();
    const body = payload(
      await h.client.callTool({
        name: 'risk_check_order',
        arguments: { symbol: 'BTC-USD', side: 'buy', type: 'market', asset_quantity: '0.001' },
      }),
    );

    expect(body.allowed).toBe(true);
    expect((body.estimate as { notional_usd: number }).notional_usd).toBeCloseTo(50);
    expect(body.confirmation_required).toBe(true);
    expect(h.fake.posts).toHaveLength(0);
  });

  it('names the per-order ceiling as the rejecting control', async () => {
    const h = await harness({ policy: { maxOrderUsd: 10 } });
    const body = payload(
      await h.client.callTool({
        name: 'risk_check_order',
        arguments: { symbol: 'BTC-USD', side: 'buy', type: 'market', asset_quantity: '1' },
      }),
    );

    expect(body.allowed).toBe(false);
    expect(body.rejected_by).toBe('max_order_usd');
    expect(String(body.reason)).toContain('ROBINHOOD_CRYPTO_MAX_ORDER_USD');
    expect(h.fake.posts).toHaveLength(0);
  });

  it('names the allowlist as the rejecting control', async () => {
    const h = await harness({ policy: { symbolAllowlist: ['ETH-USD'] } });
    const body = payload(
      await h.client.callTool({
        name: 'risk_check_order',
        arguments: { symbol: 'BTC-USD', side: 'buy', type: 'market', asset_quantity: '0.001' },
      }),
    );

    expect(body.allowed).toBe(false);
    expect(body.rejected_by).toBe('symbol_allowlist');
  });

  it('names buy-only as the rejecting control', async () => {
    const h = await harness({ policy: { buyOnly: true } });
    const body = payload(
      await h.client.callTool({
        name: 'risk_check_order',
        arguments: { symbol: 'BTC-USD', side: 'sell', type: 'market', asset_quantity: '0.001' },
      }),
    );

    expect(body.allowed).toBe(false);
    expect(body.rejected_by).toBe('buy_only');
  });

  it('names the daily cap as the rejecting control', async () => {
    const h = await harness({ policy: { maxDailyUsd: 10 } });
    const body = payload(
      await h.client.callTool({
        name: 'risk_check_order',
        arguments: { symbol: 'BTC-USD', side: 'buy', type: 'market', asset_quantity: '0.001' },
      }),
    );

    expect(body.allowed).toBe(false);
    expect(body.rejected_by).toBe('max_daily_usd');
  });

  it('refuses an order whose value cannot be determined', async () => {
    const fake = new FakeClient();
    fake.prices = {};
    const h = await harness({ fake });

    const body = payload(
      await h.client.callTool({
        name: 'risk_check_order',
        arguments: { symbol: 'BTC-USD', side: 'buy', type: 'market', asset_quantity: '0.001' },
      }),
    );

    expect(body.allowed).toBe(false);
    expect(body.rejected_by).toBe('unpriceable_order');
  });

  it('rejects a check with both sizing denominations', async () => {
    const h = await harness();
    const result = await h.client.callTool({
      name: 'risk_check_order',
      arguments: {
        symbol: 'BTC-USD',
        side: 'buy',
        type: 'limit',
        asset_quantity: '0.001',
        quote_amount: '50',
        limit_price: '49000',
      },
    });

    expect(isError(result)).toBe(true);
  });

  it('does not commit spend, so a passing check does not consume the daily cap', async () => {
    const h = await harness({ policy: { maxDailyUsd: 100 } });

    await h.client.callTool({
      name: 'risk_check_order',
      arguments: { symbol: 'BTC-USD', side: 'buy', type: 'market', asset_quantity: '0.001' },
    });

    const status = payload(await h.client.callTool({ name: 'risk_status', arguments: {} }));
    expect((status.session_spend as { committed_usd: number }).committed_usd).toBe(0);
  });
});

describe('kill switch', () => {
  let h: Awaited<ReturnType<typeof harness>>;

  beforeEach(async () => {
    h = await harness();
  });

  it('requires a reason to engage', async () => {
    const result = await h.client.callTool({
      name: 'risk_kill_switch_engage',
      arguments: {},
    });

    expect(isError(result)).toBe(true);
  });

  it('blocks a real order tool once engaged', async () => {
    await h.client.callTool({
      name: 'risk_kill_switch_engage',
      arguments: { reason: 'Prices look wrong.' },
    });

    const result = await h.client.callTool({
      name: 'buy_market',
      arguments: { symbol: 'BTC-USD', asset_quantity: '0.001', confirm: true },
    });

    expect(isError(result)).toBe(true);
    expect(text(result)).toContain('HALTED');
    // The proof that it is enforced rather than advisory: nothing was sent.
    expect(h.fake.posts).toHaveLength(0);
  });

  it('blocks an order placed straight through the executor', async () => {
    // Strategies call the Executor directly rather than through a tool, so the
    // halt has to hold at that layer too.
    await h.client.callTool({
      name: 'risk_kill_switch_engage',
      arguments: { reason: 'Stop everything.' },
    });

    await expect(
      h.executor.submitOrder(
        { symbol: 'BTC-USD', side: 'buy', type: 'market', assetQuantity: '0.001' },
        true,
      ),
    ).rejects.toThrow(/HALTED/);
    expect(h.fake.posts).toHaveLength(0);
  });

  it('reports itself as the rejecting control in a dry run', async () => {
    await h.client.callTool({
      name: 'risk_kill_switch_engage',
      arguments: { reason: 'Manual halt.' },
    });

    const body = payload(
      await h.client.callTool({
        name: 'risk_check_order',
        arguments: { symbol: 'BTC-USD', side: 'buy', type: 'market', asset_quantity: '0.001' },
      }),
    );

    expect(body.allowed).toBe(false);
    expect(body.rejected_by).toBe('kill_switch');
    expect(String(body.reason)).toContain('Manual halt.');
  });

  it('shows up in risk_status with its reason', async () => {
    await h.client.callTool({
      name: 'risk_kill_switch_engage',
      arguments: { reason: 'Runaway strategy.' },
    });

    const body = payload(await h.client.callTool({ name: 'risk_status', arguments: {} }));
    expect(body.kill_switch).toMatchObject({ engaged: true, reason: 'Runaway strategy.' });
  });

  it('is idempotent and keeps the original reason', async () => {
    await h.client.callTool({
      name: 'risk_kill_switch_engage',
      arguments: { reason: 'First reason.' },
    });
    const body = payload(
      await h.client.callTool({
        name: 'risk_kill_switch_engage',
        arguments: { reason: 'Second reason.' },
      }),
    );

    expect(body.already_engaged).toBe(true);
    expect(body.reason).toBe('First reason.');
  });

  it('pauses running jobs and resumes exactly those on release', async () => {
    const running = h.store.createJob({
      strategy: 'twap',
      symbol: 'BTC-USD',
      state: {},
      params: {},
      nextRunAt: Date.now(),
    });
    h.store.updateJob(running.id, { status: 'running' });

    // Paused by an operator beforehand, for an unrelated reason.
    const alreadyPaused = h.store.createJob({
      strategy: 'dca',
      symbol: 'ETH-USD',
      state: {},
      params: {},
      nextRunAt: Date.now(),
    });
    h.store.updateJob(alreadyPaused.id, { status: 'running' });
    h.store.updateJob(alreadyPaused.id, { status: 'paused' });

    const engaged = payload(
      await h.client.callTool({
        name: 'risk_kill_switch_engage',
        arguments: { reason: 'Halt for maintenance.' },
      }),
    );

    expect(engaged.paused_jobs).toEqual([running.id]);
    expect(h.store.getJob(running.id)!.status).toBe('paused');

    const released = payload(
      await h.client.callTool({
        name: 'risk_kill_switch_release',
        arguments: { confirm: true },
      }),
    );

    expect(released.resumed_jobs).toEqual([running.id]);
    expect(h.store.getJob(running.id)!.status).toBe('running');
    // The operator's own pause is not undone by an unrelated release.
    expect(h.store.getJob(alreadyPaused.id)!.status).toBe('paused');
  });

  it('reports pending jobs it cannot pause, rather than claiming it did', async () => {
    const pending = h.store.createJob({
      strategy: 'twap',
      symbol: 'BTC-USD',
      state: {},
      params: {},
      nextRunAt: Date.now(),
    });

    const body = payload(
      await h.client.callTool({
        name: 'risk_kill_switch_engage',
        arguments: { reason: 'Halt.' },
      }),
    );

    expect(body.pending_jobs_not_paused).toEqual([pending.id]);
    expect(body.paused_jobs).toEqual([]);
  });

  it('does not resume a job cancelled while the halt was on', async () => {
    const job = h.store.createJob({
      strategy: 'twap',
      symbol: 'BTC-USD',
      state: {},
      params: {},
      nextRunAt: Date.now(),
    });
    h.store.updateJob(job.id, { status: 'running' });

    await h.client.callTool({
      name: 'risk_kill_switch_engage',
      arguments: { reason: 'Halt.' },
    });
    h.store.updateJob(job.id, { status: 'cancelled' });

    const body = payload(
      await h.client.callTool({
        name: 'risk_kill_switch_release',
        arguments: { confirm: true },
      }),
    );

    expect(body.resumed_jobs).toEqual([]);
    expect((body.not_resumed as Array<{ job_id: string }>)[0]!.job_id).toBe(job.id);
    expect(h.store.getJob(job.id)!.status).toBe('cancelled');
  });

  it('refuses to release without confirm', async () => {
    await h.client.callTool({
      name: 'risk_kill_switch_engage',
      arguments: { reason: 'Halt.' },
    });

    const result = await h.client.callTool({
      name: 'risk_kill_switch_release',
      arguments: { confirm: false },
    });

    expect(isError(result)).toBe(true);

    // Still halted.
    const blocked = await h.client.callTool({
      name: 'buy_market',
      arguments: { symbol: 'BTC-USD', asset_quantity: '0.001', confirm: true },
    });
    expect(isError(blocked)).toBe(true);
    expect(h.fake.posts).toHaveLength(0);
  });

  it('lets orders through again after a confirmed release', async () => {
    await h.client.callTool({
      name: 'risk_kill_switch_engage',
      arguments: { reason: 'Halt.' },
    });
    await h.client.callTool({
      name: 'risk_kill_switch_release',
      arguments: { confirm: true },
    });

    const result = await h.client.callTool({
      name: 'buy_market',
      arguments: { symbol: 'BTC-USD', asset_quantity: '0.001', confirm: true },
    });

    expect(payload(result).placed).toBe(true);
    expect(h.fake.posts).toHaveLength(1);
  });

  it('reports a release that was never needed without pretending otherwise', async () => {
    const body = payload(
      await h.client.callTool({
        name: 'risk_kill_switch_release',
        arguments: { confirm: true },
      }),
    );

    expect(body.already_released).toBe(true);
  });
});

describe('kill switch persistence', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'robinhood-risk-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('survives a restart of the server and the store', async () => {
    const path = join(directory, 'jobs.sqlite');

    const first = await harness({ storePath: path });
    await first.client.callTool({
      name: 'risk_kill_switch_engage',
      arguments: { reason: 'Halt before restart.' },
    });
    first.store.close();

    // A completely fresh process would build all of this from scratch: new
    // store, new executor, new server. Only the database file carries over.
    const second = await harness({ storePath: path });

    const status = payload(await second.client.callTool({ name: 'risk_status', arguments: {} }));
    expect(status.kill_switch).toMatchObject({
      engaged: true,
      reason: 'Halt before restart.',
    });

    const blocked = await second.client.callTool({
      name: 'buy_market',
      arguments: { symbol: 'BTC-USD', asset_quantity: '0.001', confirm: true },
    });
    expect(isError(blocked)).toBe(true);
    expect(second.fake.posts).toHaveLength(0);

    second.store.close();
  });

  it('carries a release across a restart too', async () => {
    const path = join(directory, 'jobs.sqlite');

    const first = await harness({ storePath: path });
    await first.client.callTool({
      name: 'risk_kill_switch_engage',
      arguments: { reason: 'Halt.' },
    });
    await first.client.callTool({
      name: 'risk_kill_switch_release',
      arguments: { confirm: true },
    });
    first.store.close();

    const second = await harness({ storePath: path });
    const result = await second.client.callTool({
      name: 'buy_market',
      arguments: { symbol: 'BTC-USD', asset_quantity: '0.001', confirm: true },
    });

    expect(payload(result).placed).toBe(true);
    second.store.close();
  });
});

describe('risk_position_size', () => {
  it('sizes from live equity and rounds to the venue increment', async () => {
    const h = await harness();
    const body = payload(
      await h.client.callTool({
        name: 'risk_position_size',
        arguments: { symbol: 'BTC-USD', risk_percent: 1, stop_distance_percent: 5 },
      }),
    );

    // Equity 6,000. Risk 1% = $60. Stop 5% of 50,000 = $2,500 away.
    // 60 / 2500 = 0.024 BTC, notional 0.024 * 50,000 = $1,200.
    expect(Number(body.quantity)).toBeCloseTo(0.024, 8);
    expect(body.notional_usd as number).toBeCloseTo(1_200);
    expect(body.risk_usd as number).toBeCloseTo(60);
    expect(body.account_value_usd as number).toBeCloseTo(6_000);
    expect(body.stop_price as number).toBeCloseTo(47_500);
    expect((body.venue as { asset_increment: string }).asset_increment).toBe('0.00000001');
  });

  it('accepts an absolute stop and an equity override', async () => {
    const h = await harness();
    const body = payload(
      await h.client.callTool({
        name: 'risk_position_size',
        arguments: {
          symbol: 'BTC-USD',
          risk_percent: 2,
          stop_price: 45_000,
          account_value_usd: 10_000,
        },
      }),
    );

    // Risk $200 with a $5,000 stop distance = 0.04 BTC.
    expect(Number(body.quantity)).toBeCloseTo(0.04, 8);
    expect(body.account_value_source).toBe('caller-supplied account_value_usd');
  });

  it('rejects both stop forms at once', async () => {
    const h = await harness();
    const result = await h.client.callTool({
      name: 'risk_position_size',
      arguments: {
        symbol: 'BTC-USD',
        risk_percent: 1,
        stop_price: 45_000,
        stop_distance_percent: 5,
      },
    });

    expect(isError(result)).toBe(true);
  });

  it('rejects a call with no stop at all', async () => {
    const h = await harness();
    const result = await h.client.callTool({
      name: 'risk_position_size',
      arguments: { symbol: 'BTC-USD', risk_percent: 1 },
    });

    expect(isError(result)).toBe(true);
  });

  it('fails closed when equity cannot be determined', async () => {
    const fake = new FakeClient();
    fake.holdings.push({ asset_code: 'DOGE', total_quantity: '1000' });
    const h = await harness({ fake });

    const result = await h.client.callTool({
      name: 'risk_position_size',
      arguments: { symbol: 'BTC-USD', risk_percent: 1, stop_distance_percent: 5 },
    });

    expect(isError(result)).toBe(true);
    expect(text(result)).toContain('DOGE');
    expect(text(result)).toContain('account_value_usd');
  });

  it('fails closed when the symbol cannot be priced', async () => {
    const fake = new FakeClient();
    fake.prices = {};
    const h = await harness({ fake });

    const result = await h.client.callTool({
      name: 'risk_position_size',
      arguments: {
        symbol: 'BTC-USD',
        risk_percent: 1,
        stop_distance_percent: 5,
        account_value_usd: 10_000,
      },
    });

    expect(isError(result)).toBe(true);
    expect(text(result)).toContain('No live price');
  });

  it('fails closed when the venue increment is unknown', async () => {
    const fake = new FakeClient();
    fake.tradingPairs = [];
    const h = await harness({ fake });

    const result = await h.client.callTool({
      name: 'risk_position_size',
      arguments: {
        symbol: 'BTC-USD',
        risk_percent: 1,
        stop_distance_percent: 5,
        account_value_usd: 10_000,
      },
    });

    expect(isError(result)).toBe(true);
    expect(text(result)).toContain('increment');
  });

  it('refuses a size that rounds below one increment', async () => {
    const h = await harness();
    const result = await h.client.callTool({
      name: 'risk_position_size',
      arguments: {
        symbol: 'ETH-USD',
        risk_percent: 0.0001,
        stop_distance_percent: 50,
        account_value_usd: 1,
      },
    });

    expect(isError(result)).toBe(true);
    expect(text(result)).toContain('increment');
  });

  it('flags a size that would breach the per-order ceiling', async () => {
    const h = await harness({ policy: { maxOrderUsd: 100 } });
    const body = payload(
      await h.client.callTool({
        name: 'risk_position_size',
        arguments: { symbol: 'BTC-USD', risk_percent: 1, stop_distance_percent: 5 },
      }),
    );

    expect(body.exceeds_max_order_usd).toBe(true);
  });
});

describe('risk_limits_export', () => {
  it('names the environment variable behind every limit', async () => {
    const h = await harness({ policy: { maxDailyUsd: 250, symbolAllowlist: ['BTC-USD'] } });
    const body = payload(await h.client.callTool({ name: 'risk_limits_export', arguments: {} }));

    const limits = body.limits as Array<{ control: string; env: string | null; value: unknown }>;
    const byControl = new Map(limits.map((l) => [l.control, l]));

    expect(byControl.get('max_order_usd')!.env).toBe('ROBINHOOD_CRYPTO_MAX_ORDER_USD');
    expect(byControl.get('max_daily_usd')!.value).toBe(250);
    expect(byControl.get('symbol_allowlist')!.value).toEqual(['BTC-USD']);
    expect(byControl.get('buy_only')!.env).toBe('ROBINHOOD_CRYPTO_BUY_ONLY');
    expect(byControl.get('execution_mode')!.env).toBe('ROBINHOOD_CRYPTO_AUTONOMOUS');
    // The kill switch is the one control with no env var, because it is set at
    // runtime; the export has to say so rather than omit it.
    expect(byControl.get('kill_switch')!.env).toBeNull();
    expect(byControl.get('kill_switch')!.value).toBe('released');
  });

  it('reports the kill switch reason once engaged', async () => {
    const h = await harness();
    await h.client.callTool({
      name: 'risk_kill_switch_engage',
      arguments: { reason: 'Halted for review.' },
    });

    const body = payload(await h.client.callTool({ name: 'risk_limits_export', arguments: {} }));
    const limits = body.limits as Array<{ control: string; value: unknown }>;
    const killSwitch = limits.find((l) => l.control === 'kill_switch')!;

    expect(String(killSwitch.value)).toContain('Halted for review.');
  });
});
