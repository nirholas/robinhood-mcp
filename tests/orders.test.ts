/**
 * MCP-level tests for the primitive order tools.
 *
 * These drive a real McpServer over an in-memory transport rather than calling
 * handlers directly, so they cover what an agent actually hits: schema
 * validation, tool discovery, and the serialized result. The network boundary
 * is the only substitution.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerOrderTools } from '../src/tools/orders.js';
import { Executor } from '../src/shared/executor.js';
import { SpendLedger, type ExecutionPolicy } from '../src/shared/execution-mode.js';
import type { RobinhoodCryptoClient } from '../src/shared/client.js';
import type { Credentials } from '../src/shared/config.js';

class FakeClient {
  posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  price = 50_000;

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
    const body = (options?.body ?? {}) as Record<string, unknown>;
    this.posts.push({ path, body });
    return { id: `order-${this.posts.length}`, client_order_id: body.client_order_id, state: 'open' };
  }

  async getAllPages(): Promise<{ results: unknown[]; truncated: boolean }> {
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

async function harness(overrides: Partial<ExecutionPolicy> = {}) {
  const policy = policyWith(overrides);
  const fake = new FakeClient();
  const executor = new Executor(
    fake as unknown as RobinhoodCryptoClient,
    credentials,
    policy,
    new SpendLedger(policy),
  );

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerOrderTools(server, executor);

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { client, fake, executor };
}

/** Tool results are a JSON text block; parse it back for assertions. */
function payload(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

describe('primitive order tools', () => {
  let h: Awaited<ReturnType<typeof harness>>;

  beforeEach(async () => {
    h = await harness();
  });

  it('registers one tool per order type', async () => {
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual([
      'buy_limit',
      'buy_market',
      'place_stop_limit',
      'place_stop_loss',
      'sell_limit',
      'sell_market',
    ]);
  });

  it('does not expose quote_amount on a market order', async () => {
    // The ergonomic point of these tools: the field Robinhood rejects for
    // market orders is absent from the schema, so it cannot be sent at all.
    const { tools } = await h.client.listTools();
    const marketSchema = tools.find((t) => t.name === 'buy_market')!.inputSchema;
    const properties = (marketSchema as { properties: Record<string, unknown> }).properties;

    expect(Object.keys(properties)).toContain('asset_quantity');
    expect(Object.keys(properties)).not.toContain('quote_amount');
  });

  it('previews without placing when confirm is absent', async () => {
    const result = await h.client.callTool({
      name: 'buy_market',
      arguments: { symbol: 'BTC-USD', asset_quantity: '0.001' },
    });

    const body = payload(result);
    expect(body.placed).toBe(false);
    expect(body.preview).toBe(true);
    // 0.001 BTC at 50,000 = $50.
    expect((body.estimate as { notional_usd: number }).notional_usd).toBeCloseTo(50);
    expect(h.fake.posts).toHaveLength(0);
  });

  it('places the order on a confirmed call', async () => {
    const result = await h.client.callTool({
      name: 'buy_market',
      arguments: { symbol: 'BTC-USD', asset_quantity: '0.001', confirm: true },
    });

    expect(payload(result).placed).toBe(true);
    expect(h.fake.posts).toHaveLength(1);
    expect(h.fake.posts[0]!.body).toMatchObject({
      symbol: 'BTC-USD',
      side: 'buy',
      type: 'market',
      market_order_config: { asset_quantity: '0.001' },
    });
  });

  it('routes sell_market through the sell side', async () => {
    await h.client.callTool({
      name: 'sell_market',
      arguments: { symbol: 'BTC-USD', asset_quantity: '0.001', confirm: true },
    });

    expect(h.fake.posts[0]!.body).toMatchObject({ side: 'sell', type: 'market' });
  });

  it('builds a limit order with its limit price and time in force', async () => {
    await h.client.callTool({
      name: 'buy_limit',
      arguments: {
        symbol: 'BTC-USD',
        limit_price: '49000',
        asset_quantity: '0.001',
        confirm: true,
      },
    });

    expect(h.fake.posts[0]!.body).toMatchObject({
      type: 'limit',
      limit_order_config: { asset_quantity: '0.001', limit_price: '49000', time_in_force: 'gtc' },
    });
  });

  it('rejects both sizing denominations at once', async () => {
    const result = await h.client.callTool({
      name: 'buy_limit',
      arguments: {
        symbol: 'BTC-USD',
        limit_price: '49000',
        asset_quantity: '0.001',
        quote_amount: '50',
      },
    });

    expect(isError(result)).toBe(true);
    expect(h.fake.posts).toHaveLength(0);
  });

  it('rejects an order with no size', async () => {
    const result = await h.client.callTool({
      name: 'buy_limit',
      arguments: { symbol: 'BTC-USD', limit_price: '49000' },
    });

    expect(isError(result)).toBe(true);
    expect(h.fake.posts).toHaveLength(0);
  });

  it('rejects a sell stop-limit that can never fill', async () => {
    // limit above stop on a sell: by the time the stop trades, price is already
    // through the limit. Catching this here saves a resting order that is dead
    // on arrival while the user believes they are protected.
    const result = await h.client.callTool({
      name: 'place_stop_limit',
      arguments: {
        symbol: 'BTC-USD',
        side: 'sell',
        stop_price: '48000',
        limit_price: '49000',
        asset_quantity: '0.001',
        confirm: true,
      },
    });

    expect(isError(result)).toBe(true);
    expect(h.fake.posts).toHaveLength(0);
  });

  it('rejects a buy stop-limit that can never fill', async () => {
    const result = await h.client.callTool({
      name: 'place_stop_limit',
      arguments: {
        symbol: 'BTC-USD',
        side: 'buy',
        stop_price: '51000',
        limit_price: '50500',
        asset_quantity: '0.001',
        confirm: true,
      },
    });

    expect(isError(result)).toBe(true);
    expect(h.fake.posts).toHaveLength(0);
  });

  it('accepts a correctly oriented sell stop-limit', async () => {
    await h.client.callTool({
      name: 'place_stop_limit',
      arguments: {
        symbol: 'BTC-USD',
        side: 'sell',
        stop_price: '48000',
        limit_price: '47900',
        asset_quantity: '0.001',
        confirm: true,
      },
    });

    expect(h.fake.posts[0]!.body).toMatchObject({
      type: 'stop_limit',
      stop_limit_order_config: { stop_price: '48000', limit_price: '47900' },
    });
  });

  it('builds a stop-loss order', async () => {
    await h.client.callTool({
      name: 'place_stop_loss',
      arguments: {
        symbol: 'BTC-USD',
        side: 'sell',
        stop_price: '48000',
        asset_quantity: '0.001',
        confirm: true,
      },
    });

    expect(h.fake.posts[0]!.body).toMatchObject({
      type: 'stop_loss',
      stop_loss_order_config: { asset_quantity: '0.001', stop_price: '48000' },
    });
  });

  it('enforces the spend cap on the narrow tools too', async () => {
    // These tools are ergonomics, not a permission boundary.
    const capped = await harness({ maxOrderUsd: 10 });
    const result = await capped.client.callTool({
      name: 'buy_market',
      arguments: { symbol: 'BTC-USD', asset_quantity: '1', confirm: true },
    });

    expect(isError(result)).toBe(true);
    expect(capped.fake.posts).toHaveLength(0);
  });

  it('enforces the symbol allowlist on the narrow tools too', async () => {
    const restricted = await harness({ symbolAllowlist: ['ETH-USD'] });
    const result = await restricted.client.callTool({
      name: 'buy_market',
      arguments: { symbol: 'BTC-USD', asset_quantity: '0.001', confirm: true },
    });

    expect(isError(result)).toBe(true);
    expect(restricted.fake.posts).toHaveLength(0);
  });

  it('enforces buy-only on sell_market', async () => {
    const buyOnly = await harness({ buyOnly: true });
    const result = await buyOnly.client.callTool({
      name: 'sell_market',
      arguments: { symbol: 'BTC-USD', asset_quantity: '0.001', confirm: true },
    });

    expect(isError(result)).toBe(true);
    expect(buyOnly.fake.posts).toHaveLength(0);
  });

  it('places immediately in autonomous mode without confirm', async () => {
    const auto = await harness({ mode: 'autonomous' });
    const result = await auto.client.callTool({
      name: 'buy_market',
      arguments: { symbol: 'BTC-USD', asset_quantity: '0.001' },
    });

    expect(payload(result).placed).toBe(true);
    expect(auto.fake.posts).toHaveLength(1);
  });

  it('rejects a malformed symbol at the schema boundary', async () => {
    const result = await h.client.callTool({
      name: 'buy_market',
      arguments: { symbol: 'NOTAPAIR', asset_quantity: '0.001', confirm: true },
    });

    expect(isError(result)).toBe(true);
    expect(h.fake.posts).toHaveLength(0);
  });
});
