/**
 * MCP-level tests for the trade journal.
 *
 * These drive a real McpServer over an in-memory transport rather than calling
 * handlers directly, so they cover what an agent actually hits: schema
 * validation, tool discovery, and the serialized result. The network boundary
 * is the only substitution; the job store used by the reconciliation test is a
 * real SQLite database on a temporary path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerJournalTools } from '../src/tools/journal.js';
import { JobStore } from '../src/engine/store.js';
import type { RobinhoodCryptoClient } from '../src/shared/client.js';
import type { Credentials } from '../src/shared/config.js';

type Row = Record<string, unknown>;

const API_KEY = 'test-api-key-do-not-leak';

/** A filled order in the shape the API returns, with no executions array. */
function filled(input: {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  at: string;
}): Row {
  return {
    id: input.id,
    symbol: input.symbol,
    side: input.side,
    type: 'limit',
    state: 'filled',
    filled_asset_quantity: String(input.quantity),
    average_price: String(input.price),
    created_at: input.at,
    updated_at: input.at,
  };
}

class FakeClient {
  filledOrders: Row[] = [];
  openOrders: Row[] = [];
  partialOrders: Row[] = [];
  allOrders: Row[] = [];
  quotes: Record<string, { bid: number; ask: number }> = {};
  truncated = false;
  readonly apiVersion = 'v1';

  async get(path: string, options?: { query?: Record<string, unknown> }): Promise<unknown> {
    if (path.includes('best_bid_ask')) {
      const requested = options?.query?.symbol;
      const symbol = String(Array.isArray(requested) ? requested[0] : requested);
      const quote = this.quotes[symbol];
      return {
        results: quote
          ? [
              {
                symbol,
                bid_inclusive_of_sell_spread: String(quote.bid),
                ask_inclusive_of_buy_spread: String(quote.ask),
              },
            ]
          : [],
      };
    }
    if (path.includes('/accounts/')) return { results: [{ account_number: 'ACCT-0001' }] };
    return { results: [] };
  }

  async getAllPages(
    path: string,
    options?: { query?: Record<string, unknown> },
  ): Promise<{ results: Row[]; truncated: boolean }> {
    if (!path.includes('/orders/')) return { results: [], truncated: false };

    const state = options?.query?.state;
    if (state === 'filled') return { results: this.filledOrders, truncated: this.truncated };
    if (state === 'open') return { results: this.openOrders, truncated: false };
    if (state === 'partially_filled' || state === 'pending') {
      return { results: this.partialOrders, truncated: false };
    }
    return { results: this.allOrders, truncated: this.truncated };
  }
}

const credentials = { apiKey: API_KEY, apiVersion: 'v1' } as Credentials;

async function harness() {
  const fake = new FakeClient();
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerJournalTools(server, fake as unknown as RobinhoodCryptoClient, credentials);

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { client, fake };
}

/** Tool results are a JSON text block; parse it back for assertions. */
function payload(result: unknown): Record<string, unknown> {
  return JSON.parse(text(result)) as Record<string, unknown>;
}

function text(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]!.text;
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

/** Two closed round trips on BTC and one still open on ETH. */
function seedHistory(fake: FakeClient): void {
  fake.filledOrders = [
    filled({ id: 'o1', symbol: 'BTC-USD', side: 'buy', quantity: 0.5, price: 40_000, at: '2026-01-01T00:00:00Z' }),
    filled({ id: 'o2', symbol: 'BTC-USD', side: 'sell', quantity: 0.5, price: 44_000, at: '2026-01-03T00:00:00Z' }),
    filled({ id: 'o3', symbol: 'BTC-USD', side: 'buy', quantity: 1, price: 30_000, at: '2026-02-01T00:00:00Z' }),
    filled({ id: 'o4', symbol: 'BTC-USD', side: 'sell', quantity: 1, price: 28_000, at: '2026-02-02T00:00:00Z' }),
    filled({ id: 'o5', symbol: 'ETH-USD', side: 'buy', quantity: 2, price: 2_000, at: '2026-03-01T00:00:00Z' }),
    filled({ id: 'o6', symbol: 'ETH-USD', side: 'sell', quantity: 1, price: 2_500, at: '2026-03-02T00:00:00Z' }),
  ];
}

describe('journal tools', () => {
  let h: Awaited<ReturnType<typeof harness>>;

  beforeEach(async () => {
    h = await harness();
    seedHistory(h.fake);
  });

  it('registers the journal surface', async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'journal_daily_summary',
      'journal_export_csv',
      'journal_fills',
      'journal_open_orders',
      'journal_performance',
      'journal_reconcile',
      'journal_trade_history',
    ]);
  });

  describe('journal_fills', () => {
    it('lists every execution newest first', async () => {
      const body = payload(await h.client.callTool({ name: 'journal_fills', arguments: {} }));
      const fills = body.fills as Array<Record<string, unknown>>;

      expect(fills).toHaveLength(6);
      expect(fills[0]!.order_id).toBe('o6');
      expect(fills[0]!.notional).toBe(2_500);
      expect((body.pagination as Record<string, unknown>).total_matching).toBe(6);
    });

    it('filters by symbol', async () => {
      const body = payload(
        await h.client.callTool({ name: 'journal_fills', arguments: { symbol: 'ETH-USD' } }),
      );
      const fills = body.fills as Array<Record<string, unknown>>;

      // The fake ignores the upstream symbol filter, so this also proves the
      // client-side pass is not relying on the API to do the filtering.
      expect(fills.every((f) => f.symbol === 'ETH-USD')).toBe(true);
      expect(fills).toHaveLength(2);
    });

    it('filters by date range', async () => {
      const body = payload(
        await h.client.callTool({
          name: 'journal_fills',
          arguments: { start: '2026-02-01T00:00:00Z', end: '2026-02-28T00:00:00Z' },
        }),
      );

      expect((body.fills as unknown[]).map((f) => (f as Row).order_id)).toEqual(['o4', 'o3']);
    });

    it('paginates with limit and offset', async () => {
      const body = payload(
        await h.client.callTool({ name: 'journal_fills', arguments: { limit: 2, offset: 2 } }),
      );

      expect(body.fills).toHaveLength(2);
      expect((body.pagination as Record<string, unknown>).has_more).toBe(true);
    });

    it('rejects an unparseable date rather than ignoring it', async () => {
      const result = await h.client.callTool({
        name: 'journal_fills',
        arguments: { start: 'last tuesday' },
      });

      expect(isError(result)).toBe(true);
      expect(text(result)).toContain('last tuesday');
    });

    it('excludes undated fills from a date-bounded query and says so', async () => {
      // An order with no parseable timestamp must not be silently placed inside
      // a window the caller asked for precisely because the window matters.
      h.fake.filledOrders.push({
        id: 'o7',
        symbol: 'BTC-USD',
        side: 'buy',
        state: 'filled',
        filled_asset_quantity: '1',
        average_price: '1000',
      });

      const bounded = payload(
        await h.client.callTool({
          name: 'journal_fills',
          arguments: { start: '2020-01-01T00:00:00Z' },
        }),
      );

      expect((bounded.fills as unknown[]).map((f) => (f as Row).order_id)).not.toContain('o7');
      expect(JSON.stringify(bounded.warnings)).toContain('no parseable timestamp');
    });

    it('reports truncated history as a lower bound', async () => {
      h.fake.truncated = true;
      const body = payload(await h.client.callTool({ name: 'journal_fills', arguments: {} }));

      expect(JSON.stringify(body.warnings)).toContain('truncated');
    });
  });

  describe('journal_trade_history', () => {
    it('groups fills into round trips with holding period and P&L', async () => {
      const body = payload(
        await h.client.callTool({ name: 'journal_trade_history', arguments: {} }),
      );
      const trades = body.trades as Array<Record<string, unknown>>;

      // Two closed BTC round trips plus the open ETH position.
      expect(trades).toHaveLength(3);

      const btcWin = trades.find((t) => t.symbol === 'BTC-USD' && t.realized_pnl === 2_000)!;
      expect(btcWin.status).toBe('closed');
      expect(btcWin.holding_hours).toBe(48);
      expect(btcWin.return_percent).toBeCloseTo(10);
      expect(btcWin.fills).toBe(2);
    });

    it('reports an open position with a null P&L rather than a mark to market', async () => {
      const body = payload(
        await h.client.callTool({ name: 'journal_trade_history', arguments: { symbol: 'ETH-USD' } }),
      );
      const trades = body.trades as Array<Record<string, unknown>>;

      expect(trades).toHaveLength(1);
      expect(trades[0]!.status).toBe('open');
      expect(trades[0]!.realized_pnl).toBeNull();
      expect(trades[0]!.holding_hours).toBeNull();
    });

    it('omits the open position when asked', async () => {
      const body = payload(
        await h.client.callTool({ name: 'journal_trade_history', arguments: { include_open: false } }),
      );

      expect(body.trades).toHaveLength(2);
    });

    it('flags a trade whose opening buys predate the history', async () => {
      h.fake.filledOrders = [
        filled({ id: 's1', symbol: 'SOL-USD', side: 'sell', quantity: 10, price: 200, at: '2026-01-05T00:00:00Z' }),
      ];

      const body = payload(
        await h.client.callTool({ name: 'journal_trade_history', arguments: {} }),
      );
      const trades = body.trades as Array<Record<string, unknown>>;

      expect(trades[0]!.incomplete_history).toBe(true);
      expect(String(trades[0]!.warning)).toContain('overstates');
    });
  });

  describe('journal_performance', () => {
    it('aggregates closed round trips overall and per symbol', async () => {
      const body = payload(await h.client.callTool({ name: 'journal_performance', arguments: {} }));
      const overall = body.overall as Record<string, number | null>;

      expect(overall.total_trades).toBe(2);
      expect(overall.wins).toBe(1);
      expect(overall.losses).toBe(1);
      expect(overall.win_rate_percent).toBe(50);
      expect(overall.net_realized_pnl).toBe(0);
      expect(overall.average_win).toBe(2_000);
      expect(overall.average_loss).toBe(2_000);
      expect(overall.profit_factor).toBe(1);
      expect(overall.largest_win).toBe(2_000);
      expect(overall.largest_loss).toBe(-2_000);
      expect(body.open_trades).toBe(1);
      expect(body.by_symbol).toHaveLength(1);
      expect((body.by_symbol as Row[])[0]!.symbol).toBe('BTC-USD');
    });

    it('states that the numbers exclude external transfers', async () => {
      const body = payload(await h.client.callTool({ name: 'journal_performance', arguments: {} }));
      expect(String(body.scope)).toContain('transfers');
    });

    it('reports no measurable performance rather than a zero when nothing closed', async () => {
      h.fake.filledOrders = [
        filled({ id: 'b1', symbol: 'BTC-USD', side: 'buy', quantity: 1, price: 40_000, at: '2026-01-01T00:00:00Z' }),
      ];

      const body = payload(await h.client.callTool({ name: 'journal_performance', arguments: {} }));

      expect(body.overall).toBeNull();
      expect(body.open_trades).toBe(1);
      expect(String(body.message)).toContain('returned to flat');
    });

    it('reports a null profit factor when nothing has lost yet', async () => {
      h.fake.filledOrders = h.fake.filledOrders.slice(0, 2);
      const body = payload(await h.client.callTool({ name: 'journal_performance', arguments: {} }));

      expect((body.overall as Record<string, unknown>).profit_factor).toBeNull();
    });
  });

  describe('journal_daily_summary', () => {
    it('reports volume, counts and realized P&L per UTC day', async () => {
      const body = payload(
        await h.client.callTool({ name: 'journal_daily_summary', arguments: {} }),
      );
      const days = body.days as Array<Record<string, unknown>>;

      const opened = days.find((d) => d.date === '2026-01-01')!;
      expect(opened.volume_usd).toBe(20_000);
      expect(opened.buys).toBe(1);
      expect(opened.net_realized_pnl).toBe(0);

      const closed = days.find((d) => d.date === '2026-01-03')!;
      expect(closed.volume_usd).toBe(22_000);
      expect(closed.sells).toBe(1);
      expect(closed.net_realized_pnl).toBe(2_000);
      expect(closed.trades_closed).toBe(1);

      // Newest first, and days without activity are omitted entirely.
      expect(days[0]!.date).toBe('2026-03-02');
      expect(days).toHaveLength(6);
    });
  });

  describe('journal_open_orders', () => {
    beforeEach(() => {
      const hoursAgo = (h2: number) => new Date(Date.now() - h2 * 3_600_000).toISOString();
      h.fake.quotes = { 'BTC-USD': { bid: 49_900, ask: 50_000 } };
      h.fake.openOrders = [
        {
          id: 'open-stale',
          symbol: 'BTC-USD',
          side: 'buy',
          type: 'limit',
          state: 'open',
          created_at: hoursAgo(72),
          asset_quantity: '0.5',
          limit_order_config: { limit_price: '30000' },
        },
        {
          id: 'open-fresh',
          symbol: 'BTC-USD',
          side: 'buy',
          type: 'limit',
          state: 'open',
          created_at: hoursAgo(1),
          asset_quantity: '0.1',
          limit_order_config: { limit_price: '49950' },
        },
      ];
    });

    it('flags an old order resting far from the market as stale', async () => {
      const body = payload(await h.client.callTool({ name: 'journal_open_orders', arguments: {} }));
      const orders = body.open_orders as Array<Record<string, unknown>>;

      const stale = orders.find((o) => o.order_id === 'open-stale')!;
      expect(stale.stale).toBe(true);
      expect(stale.age_hours).toBeCloseTo(72, 0);
      // A buy is measured against the ask, the side it has to cross.
      expect(stale.market_price).toBe(50_000);
      expect(stale.distance_percent).toBeCloseTo(-40);
      expect(stale.marketable).toBe(false);

      const fresh = orders.find((o) => o.order_id === 'open-fresh')!;
      expect(fresh.stale).toBe(false);

      expect((body.summary as Record<string, unknown>).stale).toBe(1);
    });

    it('merges the partially filled state, which Robinhood reports separately', async () => {
      h.fake.partialOrders = [
        {
          id: 'open-partial',
          symbol: 'BTC-USD',
          side: 'sell',
          type: 'limit',
          state: 'partially_filled',
          created_at: new Date().toISOString(),
          asset_quantity: '1',
          filled_asset_quantity: '0.25',
          limit_order_config: { limit_price: '51000' },
        },
      ];

      const body = payload(await h.client.callTool({ name: 'journal_open_orders', arguments: {} }));
      const orders = body.open_orders as Array<Record<string, unknown>>;
      const partial = orders.find((o) => o.order_id === 'open-partial')!;

      expect(partial.filled_quantity).toBe(0.25);
      // A sell is measured against the bid.
      expect(partial.market_price).toBe(49_900);
    });

    it('reports stale as unknown when the price or market cannot be resolved', async () => {
      h.fake.quotes = {};
      const body = payload(await h.client.callTool({ name: 'journal_open_orders', arguments: {} }));
      const orders = body.open_orders as Array<Record<string, unknown>>;

      expect(orders.every((o) => o.stale === null)).toBe(true);
      expect(String(orders[0]!.note)).toContain('could not be quoted');
      expect((body.summary as Record<string, unknown>).undetermined).toBe(2);
    });

    it('returns an empty result with an explanation when nothing is working', async () => {
      h.fake.openOrders = [];
      const body = payload(await h.client.callTool({ name: 'journal_open_orders', arguments: {} }));

      expect(body.open_orders).toEqual([]);
      expect(String(body.message)).toContain('No working orders');
    });
  });

  describe('journal_export_csv', () => {
    it('exports fills with a header row', async () => {
      const body = payload(
        await h.client.callTool({ name: 'journal_export_csv', arguments: { format: 'fills' } }),
      );
      const lines = String(body.csv).split('\r\n');

      expect(lines[0]).toBe('time,symbol,side,quantity,price,notional,order_id');
      expect(body.row_count).toBe(6);
      expect(lines[1]).toContain('ETH-USD');
      expect(String(body.filename_suggestion)).toMatch(/^robinhood-fills-\d{4}-\d{2}-\d{2}\.csv$/);
    });

    it('exports trades with a status column', async () => {
      const body = payload(
        await h.client.callTool({ name: 'journal_export_csv', arguments: { format: 'trades' } }),
      );
      const lines = String(body.csv).split('\r\n');

      expect(lines[0]).toContain('realized_pnl');
      expect(lines.some((line) => line.endsWith(',open'))).toBe(true);
      expect(body.row_count).toBe(3);
    });

    it('quotes fields containing commas, quotes and newlines', async () => {
      h.fake.filledOrders = [
        filled({
          id: 'weird,id "quoted"\nsecond line',
          symbol: 'BTC-USD',
          side: 'buy',
          quantity: 1,
          price: 100,
          at: '2026-01-01T00:00:00Z',
        }),
      ];

      const csv = String(
        payload(
          await h.client.callTool({ name: 'journal_export_csv', arguments: { format: 'fills' } }),
        ).csv,
      );

      // Internal quotes doubled, whole field wrapped, newline preserved inside.
      expect(csv).toContain('"weird,id ""quoted""\nsecond line"');
    });

    it('neutralises a field that a spreadsheet would execute as a formula', async () => {
      h.fake.filledOrders = [
        filled({
          id: '=HYPERLINK("http://evil","click")',
          symbol: 'BTC-USD',
          side: 'buy',
          quantity: 1,
          price: 100,
          at: '2026-01-01T00:00:00Z',
        }),
      ];

      const csv = String(
        payload(
          await h.client.callTool({ name: 'journal_export_csv', arguments: { format: 'fills' } }),
        ).csv,
      );

      expect(csv).toContain('"\'=HYPERLINK(');
    });

    it('leaves negative numbers alone despite the leading hyphen', async () => {
      h.fake.filledOrders = h.fake.filledOrders.slice(0, 4);
      const csv = String(
        payload(
          await h.client.callTool({ name: 'journal_export_csv', arguments: { format: 'trades' } }),
        ).csv,
      );

      expect(csv).toContain(',-2000,');
      expect(csv).not.toContain("'-2000");
    });
  });

  describe('journal_reconcile', () => {
    let directory: string;

    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), 'rh-journal-'));
    });

    afterEach(() => {
      rmSync(directory, { recursive: true, force: true });
    });

    it('says clearly that there is nothing to audit when no database exists', async () => {
      const body = payload(
        await h.client.callTool({
          name: 'journal_reconcile',
          arguments: { database_path: join(directory, 'absent.db') },
        }),
      );

      expect(body.reconciled).toBe(false);
      expect(String(body.reason)).toContain('No local job database');
      expect(String(body.remediation)).toContain('robinhood-mcp-trading');
    });

    it('classifies each intent against what Robinhood reports', async () => {
      const path = join(directory, 'jobs.db');
      const store = new JobStore(path);
      const job = store.createJob({
        strategy: 'twap',
        symbol: 'BTC-USD',
        state: {},
        params: {},
        nextRunAt: Date.now(),
      });

      store.reserveIntent({ jobId: job.id, clientOrderId: 'coid-matched', body: {}, notionalUsd: 10 });
      store.settleIntent('coid-matched', { status: 'submitted', orderId: 'rh-1' });

      store.reserveIntent({ jobId: job.id, clientOrderId: 'coid-never-sent', body: {}, notionalUsd: 10 });

      store.reserveIntent({ jobId: job.id, clientOrderId: 'coid-thought-failed', body: {}, notionalUsd: 10 });
      store.settleIntent('coid-thought-failed', { status: 'failed', error: 'timeout' });

      store.reserveIntent({ jobId: job.id, clientOrderId: 'coid-crashed', body: {}, notionalUsd: 10 });
      store.close();

      h.fake.allOrders = [
        { id: 'rh-1', client_order_id: 'coid-matched', state: 'filled' },
        { id: 'rh-2', client_order_id: 'coid-thought-failed', state: 'open' },
        { id: 'rh-3', client_order_id: 'coid-crashed', state: 'open' },
        { id: 'rh-4', client_order_id: 'placed-in-the-app', state: 'filled' },
      ];

      const body = payload(
        await h.client.callTool({
          name: 'journal_reconcile',
          arguments: { database_path: path, include_matched: true },
        }),
      );

      expect(body.reconciled).toBe(true);
      expect(body.intents_examined).toBe(4);

      const verdicts = Object.fromEntries(
        (body.discrepancies as Array<Record<string, unknown>>).map((row) => [
          row.client_order_id,
          row,
        ]),
      );

      expect(verdicts['coid-never-sent']!.verdict).toBe('reserved_never_sent');
      expect(verdicts['coid-never-sent']!.severity).toBe('info');

      // The dangerous one: real exposure the toolkit is not tracking.
      expect(verdicts['coid-thought-failed']!.verdict).toBe('live_despite_recorded_failure');
      expect(verdicts['coid-thought-failed']!.severity).toBe('critical');

      expect(verdicts['coid-crashed']!.verdict).toBe('submitted_but_unsettled');
      expect(String(verdicts['coid-crashed']!.detail)).toContain('do not resubmit');

      expect(verdicts['coid-matched']).toBeUndefined();
      expect((body.matched as Array<Record<string, unknown>>)[0]!.client_order_id).toBe('coid-matched');

      expect(body.unrecorded_upstream_orders).toBe(1);
    });

    it('refuses to call an intent missing when the search was truncated', async () => {
      const path = join(directory, 'jobs.db');
      const store = new JobStore(path);
      const job = store.createJob({
        strategy: 'twap',
        symbol: 'BTC-USD',
        state: {},
        params: {},
        nextRunAt: Date.now(),
      });
      store.reserveIntent({ jobId: job.id, clientOrderId: 'coid-unknown', body: {}, notionalUsd: 5 });
      store.close();

      h.fake.allOrders = [];
      h.fake.truncated = true;

      const body = payload(
        await h.client.callTool({ name: 'journal_reconcile', arguments: { database_path: path } }),
      );
      const rows = body.discrepancies as Array<Record<string, unknown>>;

      expect(rows[0]!.verdict).toBe('unresolved');
      expect(String(rows[0]!.detail)).toContain('Absence is unproven');
      expect(String(body.warning)).toContain('page limit');
    });

    it('declares the coverage gap in the store API rather than implying completeness', async () => {
      const path = join(directory, 'jobs.db');
      new JobStore(path).close();

      const body = payload(
        await h.client.callTool({ name: 'journal_reconcile', arguments: { database_path: path } }),
      );

      expect(body.intents_examined).toBe(0);
      expect(String(body.message)).toContain('nothing to reconcile');
    });
  });

  it('never emits credential material in any journal tool result', async () => {
    const { tools } = await h.client.listTools();
    for (const tool of tools) {
      const args = tool.name === 'journal_export_csv' ? { format: 'fills' } : {};
      const result = await h.client.callTool({ name: tool.name, arguments: args });
      expect(text(result)).not.toContain(API_KEY);
    }
  });
});
