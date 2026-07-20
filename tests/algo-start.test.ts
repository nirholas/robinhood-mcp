/**
 * The per-strategy start tools.
 *
 * These exist so a strategy's contract lives in its schema rather than in prose
 * the model has to fetch first. The tests that matter are therefore the ones
 * asserting the schema actually carries the contract: that each tool declares
 * the fields its strategy needs, and that a bad call is refused before a job is
 * created rather than after.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAlgoStartTools } from '../src/tools/algo-start.js';
import { JobStore } from '../src/engine/store.js';
import { Supervisor } from '../src/engine/supervisor.js';
import { ALL_STRATEGIES } from '../src/engine/strategies/index.js';
import { Executor } from '../src/shared/executor.js';
import { SpendLedger, type ExecutionPolicy } from '../src/shared/execution-mode.js';
import type { RobinhoodCryptoClient } from '../src/shared/client.js';
import type { Credentials } from '../src/shared/config.js';

class FakeClient {
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

  async post(): Promise<unknown> {
    return { id: 'order-1', state: 'open' };
  }

  async getAllPages(path: string): Promise<{ results: unknown[]; truncated: boolean }> {
    if (path.includes('trading_pairs')) {
      return {
        results: [{ symbol: 'BTC-USD', asset_increment: '0.000001', min_order_size: '0.000001' }],
        truncated: false,
      };
    }
    if (path.includes('holdings')) {
      return {
        results: [{ asset_code: 'BTC', total_quantity: '1' }],
        truncated: false,
      };
    }
    return { results: [], truncated: false };
  }
}

const credentials = { apiVersion: 'v1' } as Credentials;
const policy: ExecutionPolicy = {
  mode: 'guarded',
  maxOrderUsd: 1_000_000,
  maxDailyUsd: null,
  symbolAllowlist: null,
  buyOnly: false,
};

async function harness() {
  const fake = new FakeClient() as unknown as RobinhoodCryptoClient;
  const executor = new Executor(fake, credentials, policy, new SpendLedger(policy));
  const store = new JobStore(':memory:');
  const supervisor = new Supervisor(store, executor, ALL_STRATEGIES, { log: () => {} });

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerAlgoStartTools(server, { store, supervisor, daemonRunning: () => false });

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);

  return { client, store };
}

function payload(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Record<
    string,
    unknown
  >;
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

/** Every strategy in the catalogue should have a start tool. */
const EXPECTED_TOOLS = [
  'algo_accumulate_start',
  'algo_bracket_start',
  'algo_chase_start',
  'algo_dca_start',
  'algo_grid_start',
  'algo_iceberg_start',
  'algo_ladder_start',
  'algo_mean_reversion_start',
  'algo_momentum_start',
  'algo_oco_start',
  'algo_rebalance_start',
  'algo_trailing_stop_start',
  'algo_twap_start',
];

describe('per-strategy start tools', () => {
  let h: Awaited<ReturnType<typeof harness>>;

  beforeEach(async () => {
    h = await harness();
  });

  it('exposes one start tool per registered strategy', async () => {
    const names = (await h.client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(EXPECTED_TOOLS);
    // If a strategy is added without a start tool, this count diverges.
    expect(names).toHaveLength(ALL_STRATEGIES.length);
  });

  it('declares each strategy contract in the schema, not just in prose', async () => {
    // The whole point of these tools. A required field absent from the schema
    // means the model is back to guessing.
    const { tools } = await h.client.listTools();
    const required = (name: string) => {
      const schema = tools.find((t) => t.name === name)!.inputSchema as {
        required?: string[];
      };
      return schema.required ?? [];
    };

    expect(required('algo_twap_start')).toEqual(
      expect.arrayContaining(['symbol', 'side', 'total_quantity', 'slices', 'duration_minutes']),
    );
    expect(required('algo_iceberg_start')).toEqual(
      expect.arrayContaining(['visible_quantity', 'max_duration_minutes']),
    );
    expect(required('algo_ladder_start')).toEqual(
      expect.arrayContaining(['levels', 'start_price', 'end_price']),
    );
    expect(required('algo_oco_start')).toEqual(
      expect.arrayContaining(['take_profit_price', 'stop_price']),
    );
    expect(required('algo_chase_start')).toEqual(
      expect.arrayContaining(['max_chases', 'offset_bps']),
    );
    expect(required('algo_rebalance_start')).toEqual(
      expect.arrayContaining(['targets', 'tolerance_bps', 'max_legs_per_tick']),
    );
    expect(required('algo_grid_start')).toEqual(
      expect.arrayContaining(['lower_price', 'upper_price', 'grid_levels', 'quantity_per_grid']),
    );
    expect(required('algo_momentum_start')).toEqual(
      expect.arrayContaining(['lookback_ticks', 'breakout_pct', 'exit_pct']),
    );
    expect(required('algo_mean_reversion_start')).toEqual(
      expect.arrayContaining(['entry_z', 'exit_z', 'side_mode']),
    );
    expect(required('algo_accumulate_start')).toEqual(
      expect.arrayContaining(['target_quantity', 'slice_quantity', 'buy_below_pct']),
    );
  });

  it('starts a TWAP and persists the job', async () => {
    const result = await h.client.callTool({
      name: 'algo_twap_start',
      arguments: {
        symbol: 'BTC-USD',
        side: 'buy',
        total_quantity: '0.006',
        slices: 3,
        duration_minutes: 30,
      },
    });

    const body = payload(result);
    expect(body.started).toBe(true);
    expect(body.strategy).toBe('twap');

    const job = h.store.getJob(String(body.job_id));
    expect(job?.strategy).toBe('twap');
    expect(job?.symbol).toBe('BTC-USD');
  });

  it('rejects a missing required field at the schema boundary', async () => {
    // slices omitted: refused before any job row is written.
    const result = await h.client.callTool({
      name: 'algo_twap_start',
      arguments: { symbol: 'BTC-USD', side: 'buy', total_quantity: '0.006', duration_minutes: 30 },
    });

    expect(isError(result)).toBe(true);
    expect(h.store.listJobs({}).length).toBe(0);
  });

  it('rejects an out-of-range value at the schema boundary', async () => {
    const result = await h.client.callTool({
      name: 'algo_twap_start',
      arguments: {
        symbol: 'BTC-USD',
        side: 'buy',
        total_quantity: '0.006',
        slices: 1, // below the minimum of 2
        duration_minutes: 30,
      },
    });

    expect(isError(result)).toBe(true);
    expect(h.store.listJobs({}).length).toBe(0);
  });

  it('rejects a malformed symbol before creating a job', async () => {
    const result = await h.client.callTool({
      name: 'algo_iceberg_start',
      arguments: {
        symbol: 'NOTAPAIR',
        side: 'buy',
        total_quantity: '1',
        visible_quantity: '0.1',
        max_duration_minutes: 60,
      },
    });

    expect(isError(result)).toBe(true);
    expect(h.store.listJobs({}).length).toBe(0);
  });

  it('surfaces a strategy init rejection as a tool error, not a job', async () => {
    // visible_quantity must be below total_quantity: caught in init, which the
    // schema cannot express, so it must still fail cleanly without a job.
    const result = await h.client.callTool({
      name: 'algo_iceberg_start',
      arguments: {
        symbol: 'BTC-USD',
        side: 'buy',
        total_quantity: '0.1',
        visible_quantity: '0.5',
        max_duration_minutes: 60,
      },
    });

    expect(isError(result)).toBe(true);
    expect(h.store.listJobs({}).length).toBe(0);
  });

  it('starts an OCO with both exit legs', async () => {
    const result = await h.client.callTool({
      name: 'algo_oco_start',
      arguments: {
        symbol: 'BTC-USD',
        side: 'sell',
        quantity: '0.01',
        take_profit_price: '55000',
        stop_price: '45000',
      },
    });

    expect(payload(result).strategy).toBe('oco');
  });

  it('starts a chase', async () => {
    const result = await h.client.callTool({
      name: 'algo_chase_start',
      arguments: {
        symbol: 'BTC-USD',
        side: 'buy',
        quantity: '0.01',
        max_chases: 5,
        offset_bps: 10,
      },
    });

    expect(payload(result).strategy).toBe('chase');
  });

  it('starts a dry-run rebalance without placing anything', async () => {
    const result = await h.client.callTool({
      name: 'algo_rebalance_start',
      arguments: {
        targets: { 'BTC-USD': 1 },
        tolerance_bps: 100,
        max_legs_per_tick: 2,
        dry_run: true,
      },
    });

    expect(payload(result).strategy).toBe('rebalance');
  });

  it('warns that no daemon is running', async () => {
    // A job that silently never advances is the worst failure mode here.
    const result = await h.client.callTool({
      name: 'algo_twap_start',
      arguments: {
        symbol: 'BTC-USD',
        side: 'buy',
        total_quantity: '0.006',
        slices: 3,
        duration_minutes: 30,
      },
    });

    expect(String(payload(result).execution_note)).toMatch(/daemon/i);
  });

  it('names the stakes in every start tool description', async () => {
    // Starting a job authorizes a sequence of orders, not one.
    const { tools } = await h.client.listTools();
    for (const tool of tools) {
      expect(tool.description, `${tool.name} description`).toMatch(/REAL MONEY/);
    }
  });
});
