import { describe, it, expect, beforeEach } from 'vitest';
import { Executor, buildOrderBody, roundToIncrement } from '../src/shared/executor.js';
import { SpendLedger, PolicyError, type ExecutionPolicy } from '../src/shared/execution-mode.js';
import type { RobinhoodCryptoClient } from '../src/shared/client.js';
import type { Credentials } from '../src/shared/config.js';

/**
 * Stub client recording every call, so tests can assert that an order was or
 * was not actually sent. A guard that "passes" while still hitting the network
 * is a guard that does nothing.
 */
class FakeClient {
  posts: Array<{ path: string; body: unknown }> = [];
  gets: string[] = [];
  quotePrice: number | null = 50_000;

  async get(path: string): Promise<unknown> {
    this.gets.push(path);
    if (path.includes('best_bid_ask')) {
      if (this.quotePrice === null) return { results: [] };
      return {
        results: [
          {
            symbol: 'BTC-USD',
            ask_inclusive_of_buy_spread: String(this.quotePrice),
            bid_inclusive_of_sell_spread: String(this.quotePrice * 0.999),
          },
        ],
      };
    }
    return { results: [] };
  }

  async post(path: string, options?: { body?: unknown }): Promise<unknown> {
    this.posts.push({ path, body: options?.body });
    return { id: 'order-123', state: 'open' };
  }

  async getAllPages(): Promise<{ results: unknown[]; truncated: boolean }> {
    return { results: [], truncated: false };
  }
}

const credentials = { apiVersion: 'v1' } as Credentials;

const policy = (overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy => ({
  mode: 'guarded',
  maxOrderUsd: 100,
  maxDailyUsd: null,
  symbolAllowlist: null,
  buyOnly: false,
  ...overrides,
});

function makeExecutor(overrides: Partial<ExecutionPolicy> = {}) {
  const client = new FakeClient();
  const p = policy(overrides);
  const executor = new Executor(
    client as unknown as RobinhoodCryptoClient,
    credentials,
    p,
    new SpendLedger(p),
  );
  return { client, executor };
}

describe('guarded mode', () => {
  it('previews without sending anything', async () => {
    const { client, executor } = makeExecutor();
    const result = await executor.submitOrder(
      { symbol: 'BTC-USD', side: 'buy', type: 'limit', assetQuantity: '0.001', limitPrice: '50000' },
      false,
    );

    expect(result.placed).toBe(false);
    expect(result.preview?.notionalUsd).toBe(50);
    expect(client.posts).toHaveLength(0);
  });

  it('executes when confirmed', async () => {
    const { client, executor } = makeExecutor();
    const result = await executor.submitOrder(
      { symbol: 'BTC-USD', side: 'buy', type: 'limit', assetQuantity: '0.001', limitPrice: '50000' },
      true,
    );

    expect(result.placed).toBe(true);
    expect(client.posts).toHaveLength(1);
  });
});

describe('autonomous mode', () => {
  it('executes without confirmation', async () => {
    const { client, executor } = makeExecutor({ mode: 'autonomous' });
    const result = await executor.submitOrder(
      { symbol: 'BTC-USD', side: 'buy', type: 'limit', assetQuantity: '0.001', limitPrice: '50000' },
      false,
    );

    expect(result.placed).toBe(true);
    expect(client.posts).toHaveLength(1);
  });

  it('still enforces the spend cap', async () => {
    // The whole point: removing the human must not remove the ceiling.
    const { client, executor } = makeExecutor({ mode: 'autonomous', maxOrderUsd: 10 });
    await expect(
      executor.submitOrder(
        { symbol: 'BTC-USD', side: 'buy', type: 'limit', assetQuantity: '1', limitPrice: '50000' },
        false,
      ),
    ).rejects.toThrow(PolicyError);
    expect(client.posts).toHaveLength(0);
  });
});

describe('policy enforcement', () => {
  it('blocks an order above the per-order cap before any network call', async () => {
    const { client, executor } = makeExecutor({ maxOrderUsd: 25 });
    await expect(
      executor.submitOrder(
        { symbol: 'BTC-USD', side: 'buy', type: 'limit', assetQuantity: '0.001', limitPrice: '50000' },
        true,
      ),
    ).rejects.toThrow(/exceeds ROBINHOOD_CRYPTO_MAX_ORDER_USD/);
    expect(client.posts).toHaveLength(0);
  });

  it('refuses a market order when no price is available', async () => {
    // Fails closed: an unknown notional must never be treated as zero.
    const { client, executor } = makeExecutor();
    client.quotePrice = null;

    await expect(
      executor.submitOrder(
        { symbol: 'BTC-USD', side: 'buy', type: 'market', assetQuantity: '0.001' },
        true,
      ),
    ).rejects.toThrow(/Cannot determine the USD value/);
    expect(client.posts).toHaveLength(0);
  });

  it('prices a market order from the live quote', async () => {
    const { executor } = makeExecutor({ maxOrderUsd: 1_000 });
    const priced = await executor.price({
      symbol: 'BTC-USD',
      side: 'buy',
      type: 'market',
      assetQuantity: '0.01',
    });

    expect(priced.notionalUsd).toBe(500);
    expect(priced.pricedFrom).toBe('live best bid/ask');
  });

  it('enforces the symbol allowlist', async () => {
    const { client, executor } = makeExecutor({ symbolAllowlist: ['ETH-USD'] });
    await expect(
      executor.submitOrder(
        { symbol: 'BTC-USD', side: 'buy', type: 'limit', assetQuantity: '0.0001', limitPrice: '50000' },
        true,
      ),
    ).rejects.toThrow(/not in ROBINHOOD_CRYPTO_SYMBOL_ALLOWLIST/);
    expect(client.posts).toHaveLength(0);
  });

  it('blocks sells in buy-only mode', async () => {
    const { executor } = makeExecutor({ buyOnly: true });
    await expect(
      executor.submitOrder(
        { symbol: 'BTC-USD', side: 'sell', type: 'limit', assetQuantity: '0.0001', limitPrice: '50000' },
        true,
      ),
    ).rejects.toThrow(/ROBINHOOD_CRYPTO_BUY_ONLY/);
  });

  it('accumulates spend across orders and stops at the daily cap', async () => {
    const { client, executor } = makeExecutor({ mode: 'autonomous', maxDailyUsd: 120 });
    const order = {
      symbol: 'BTC-USD',
      side: 'buy' as const,
      type: 'limit' as const,
      assetQuantity: '0.001',
      limitPrice: '50000',
    };

    await executor.submitOrder(order, true); // $50
    await executor.submitOrder(order, true); // $100 cumulative
    await expect(executor.submitOrder(order, true)).rejects.toThrow(/MAX_DAILY_USD/);

    expect(client.posts).toHaveLength(2);
    expect(executor.spendLedger.spentUsd).toBe(100);
  });

  it('does not count a previewed order against the ledger', async () => {
    const { executor } = makeExecutor({ maxDailyUsd: 100 });
    await executor.submitOrder(
      { symbol: 'BTC-USD', side: 'buy', type: 'limit', assetQuantity: '0.001', limitPrice: '50000' },
      false,
    );
    expect(executor.spendLedger.spentUsd).toBe(0);
  });
});

describe('buildOrderBody', () => {
  it('nests the config matching the order type', () => {
    const body = buildOrderBody({
      symbol: 'BTC-USD',
      side: 'buy',
      type: 'stop_limit',
      assetQuantity: '0.5',
      limitPrice: '100',
      stopPrice: '95',
      timeInForce: 'day',
    });

    expect(body.stop_limit_order_config).toEqual({
      asset_quantity: '0.5',
      limit_price: '100',
      stop_price: '95',
      time_in_force: 'day',
    });
  });

  it('generates a client_order_id for idempotency when none is given', () => {
    const body = buildOrderBody({ symbol: 'BTC-USD', side: 'buy', type: 'market', assetQuantity: '1' });
    expect(body.client_order_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('preserves a caller-supplied client_order_id so retries stay idempotent', () => {
    const id = '131de903-5a9c-4260-abc1-28d562a5dcf0';
    const body = buildOrderBody({
      symbol: 'BTC-USD',
      side: 'buy',
      type: 'market',
      assetQuantity: '1',
      clientOrderId: id,
    });
    expect(body.client_order_id).toBe(id);
  });
});

describe('roundToIncrement', () => {
  it('rounds down so a computed size never exceeds intent', () => {
    expect(roundToIncrement(0.123456789, '0.00000001')).toBe('0.12345678');
    expect(roundToIncrement(1.99, '0.01')).toBe('1.99');
    expect(roundToIncrement(1.999, '0.01')).toBe('1.99');
  });

  it('handles whole-number increments, still rounding down', () => {
    expect(roundToIncrement(7.9, '1')).toBe('7');
    expect(roundToIncrement(7.0, '1')).toBe('7');
  });

  it('passes the quantity through when the increment is unusable', () => {
    expect(roundToIncrement(1.5, undefined)).toBe('1.5');
    expect(roundToIncrement(1.5, '0')).toBe('1.5');
  });
});
