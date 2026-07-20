/**
 * The trade journal: what actually happened, reconstructed from order history.
 *
 * Robinhood exposes orders, not a journal. An order is a request; a journal is a
 * record of executions grouped the way a trader thinks about them. The gap
 * matters because one order can fill at many prices, several orders can make up
 * one position, and the thing a trader wants to review is the round trip, not
 * the request that started it.
 *
 * Everything here is derived from filled orders the API returns, so it is only
 * as complete as that history. Deposits, withdrawals, transfers in from another
 * venue, staking, and airdrops are invisible to this endpoint and therefore
 * invisible here. Every tool that could be mistaken for an account-level truth
 * says so in its own output rather than relying on the reader knowing.
 *
 * This module is read-only. It takes the client directly rather than an
 * Executor, which is what keeps it available on the read-only server: that
 * server builds no Executor precisely so it contains no path that can place an
 * order.
 */

import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RobinhoodCryptoClient } from '../shared/client.js';
import { jobDatabasePath, type Credentials } from '../shared/config.js';
import { endpointsFor, requiresAccountNumber } from '../shared/endpoints.js';
import { toolResult, toolError } from '../shared/format.js';
import { fillsFromOrders } from '../analytics/cost-basis.js';
import { JobStore } from '../engine/store.js';
import type { OrderIntentRecord } from '../engine/job.js';

const symbolSchema = z
  .string()
  .regex(/^[A-Za-z0-9]+-[A-Za-z0-9]+$/, 'Symbol must be a trading pair like BTC-USD.')
  .transform((s) => s.toUpperCase());

const isoTimestamp = z
  .string()
  .describe('ISO 8601 timestamp, e.g. 2026-01-01T00:00:00Z. Compared in UTC.');

/**
 * Page budget for history walks. The client's default of 20 is tuned for
 * polling one order; a journal wants the whole tape, and a truncated tape is
 * reported rather than silently trimmed.
 */
const HISTORY_MAX_PAGES = 60;

/**
 * Position is closed when the residual is this small relative to the largest
 * position the trade ever held. An absolute epsilon cannot work across assets
 * whose quantities differ by ten orders of magnitude (1 BTC vs 1e6 SHIB), and
 * float arithmetic over many fills never returns exactly zero.
 */
const CLOSE_TOLERANCE_RATIO = 1e-9;

/** One execution, keyed to the pair it traded on rather than the bare asset. */
interface JournalFill {
  symbol: string;
  assetCode: string;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  notional: number;
  /** Epoch ms, or null when the API row carried no parseable timestamp. */
  timestamp: number | null;
  orderId: string;
}

/** A position from flat to flat. The unit a trader reviews. */
interface RoundTrip {
  symbol: string;
  openedAt: number;
  closedAt: number | null;
  quantityBought: number;
  quantitySold: number;
  buyNotional: number;
  sellNotional: number;
  /** Null while the trade is still open: an open trade has realized nothing. */
  realizedPnl: number | null;
  fillCount: number;
  /** True when a sell drove the position short, i.e. the history is missing buys. */
  incompleteHistory: boolean;
}

export function registerJournalTools(
  server: McpServer,
  client: RobinhoodCryptoClient,
  credentials: Credentials,
): void {
  const endpoints = endpointsFor(credentials.apiVersion);

  let cachedAccountNumber: string | undefined;
  async function accountScope(): Promise<Record<string, string | undefined>> {
    if (!requiresAccountNumber(credentials.apiVersion)) return {};
    if (!cachedAccountNumber) {
      const accounts = await client.get<{ results?: Array<{ account_number?: string }> }>(
        endpoints.accounts,
      );
      const resolved = accounts?.results?.[0]?.account_number;
      if (!resolved) throw new Error('Could not resolve account_number, which API v2 requires.');
      cachedAccountNumber = resolved;
    }
    return { account_number: cachedAccountNumber };
  }

  /** Filled orders, the single source every derived number here comes from. */
  async function filledOrders(
    symbol?: string,
    createdAtStart?: string,
  ): Promise<{ orders: Array<Record<string, unknown>>; truncated: boolean }> {
    const { results, truncated } = await client.getAllPages<Record<string, unknown>>(
      endpoints.orders,
      {
        query: {
          state: 'filled',
          ...(symbol ? { symbol } : {}),
          ...(createdAtStart ? { created_at_start: createdAtStart } : {}),
          ...(await accountScope()),
        },
      },
      HISTORY_MAX_PAGES,
    );
    return { orders: results, truncated };
  }

  /**
   * Currently working orders.
   *
   * Robinhood reports a partly-filled order under its own state rather than
   * under `open`, and renamed that state between versions, so a single query
   * misses live exposure. Both are fetched and merged by id.
   */
  async function workingOrders(): Promise<{
    orders: Array<Record<string, unknown>>;
    truncated: boolean;
  }> {
    const partial = credentials.apiVersion === 'v2' ? 'pending' : 'partially_filled';
    const scope = await accountScope();

    const byId = new Map<string, Record<string, unknown>>();
    let truncated = false;

    for (const state of ['open', partial]) {
      const page = await client.getAllPages<Record<string, unknown>>(endpoints.orders, {
        query: { state, ...scope },
      });
      truncated ||= page.truncated;
      for (const order of page.results) byId.set(String(order.id ?? Math.random()), order);
    }

    return { orders: [...byId.values()], truncated };
  }

  /** Raw quote row, so a caller needing both sides makes one request not two. */
  async function rawQuote(symbol: string): Promise<Record<string, unknown> | null> {
    const quote = await client.get<{ results?: Array<Record<string, unknown>> }>(
      endpoints.bestBidAsk,
      { query: { symbol: [symbol.toUpperCase()] } },
    );
    return quote?.results?.[0] ?? null;
  }

  /**
   * Fills with their trading pair restored.
   *
   * The shared extractor is reused rather than reimplemented: it already reads
   * Robinhood's inconsistent field names defensively and skips rows it cannot
   * parse instead of guessing. It collapses a pair to its base asset, which a
   * journal needs back, so the pair is rejoined from the order it came from.
   * A fill whose order cannot be found is dropped rather than assigned an
   * assumed quote currency.
   */
  function journalFills(orders: Array<Record<string, unknown>>): JournalFill[] {
    const symbolByOrder = new Map<string, string>();
    for (const order of orders) {
      const id = String(order.id ?? '');
      const symbol = String(order.symbol ?? '');
      if (id && symbol) symbolByOrder.set(id, symbol.toUpperCase());
    }

    const rows: JournalFill[] = [];
    for (const fill of fillsFromOrders(orders)) {
      const symbol = symbolByOrder.get(fill.orderId);
      if (!symbol) continue;
      rows.push({
        symbol,
        assetCode: fill.assetCode,
        side: fill.side,
        quantity: fill.quantity,
        price: fill.price,
        notional: fill.quantity * fill.price,
        // The extractor uses 0 as its "no parseable timestamp" sentinel. Carry
        // that through as null so an undated fill is never rendered as 1970.
        timestamp: fill.timestamp > 0 ? fill.timestamp : null,
        orderId: fill.orderId,
      });
    }

    return rows.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  }

  /**
   * Load fills, apply the shared filters, and report what was dropped.
   *
   * Undated fills are excluded from any date-bounded query rather than assumed
   * to be in range: including them would put unknown-date executions inside a
   * window the user asked for precisely because the window matters.
   */
  async function loadFills(filter: {
    symbol?: string;
    start?: string;
    end?: string;
  }): Promise<{
    fills: JournalFill[];
    truncated: boolean;
    undatedExcluded: number;
    undatedTotal: number;
  }> {
    const startMs = parseBound(filter.start, 'start');
    const endMs = parseBound(filter.end, 'end');
    if (startMs !== null && endMs !== null && endMs < startMs) {
      throw new Error(`end (${filter.end}) is before start (${filter.start}).`);
    }

    const { orders, truncated } = await filledOrders(filter.symbol, filter.start);

    // Filter by symbol locally as well as upstream. It is passed as a query
    // parameter too, but every number below is grouped by pair, so a stray row
    // from another pair would not just be extra output: it would open a round
    // trip that never existed.
    const wanted = filter.symbol?.toUpperCase();
    const all = journalFills(orders).filter((fill) => !wanted || fill.symbol === wanted);
    const undatedTotal = all.filter((f) => f.timestamp === null).length;

    const dateFiltered = startMs === null && endMs === null;
    const fills = all.filter((fill) => {
      if (dateFiltered) return true;
      if (fill.timestamp === null) return false;
      if (startMs !== null && fill.timestamp < startMs) return false;
      if (endMs !== null && fill.timestamp > endMs) return false;
      return true;
    });

    return {
      fills,
      truncated,
      undatedExcluded: dateFiltered ? 0 : undatedTotal,
      undatedTotal,
    };
  }

  server.registerTool(
    'journal_fills',
    {
      title: 'List executions',
      description:
        'List every execution in the account: time, pair, side, quantity, price, and notional, oldest or newest first. This is the raw tape, one row per fill rather than one row per order, because a single order can execute at many prices and the average hides that. Derived from filled orders returned by the API, so transfers in from another venue, staking rewards and airdrops do not appear. Use journal_trade_history when you want positions rather than executions.',
      inputSchema: {
        symbol: symbolSchema.optional().describe('Limit to one trading pair. Omit for all pairs.'),
        start: isoTimestamp.optional().describe('Only fills at or after this time.'),
        end: isoTimestamp.optional().describe('Only fills at or before this time.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .default(100)
          .describe('Maximum rows to return. Page with offset for more.'),
        offset: z.number().int().min(0).optional().default(0),
        order: z
          .enum(['newest_first', 'oldest_first'])
          .optional()
          .default('newest_first')
          .describe('Sort direction by execution time.'),
      },
    },
    async ({ symbol, start, end, limit, offset, order }) => {
      try {
        const { fills, truncated, undatedExcluded, undatedTotal } = await loadFills({
          symbol,
          start,
          end,
        });

        const sorted = order === 'newest_first' ? [...fills].reverse() : fills;
        const page = sorted.slice(offset, offset + limit);

        return toolResult({
          fills: page.map(renderFill),
          pagination: {
            returned: page.length,
            offset,
            limit,
            total_matching: fills.length,
            has_more: offset + page.length < fills.length,
          },
          ...warnings({ truncated, undatedExcluded, undatedTotal }),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'journal_trade_history',
    {
      title: 'List round-trip trades',
      description:
        'Group executions into round-trip trades: a position from the first fill that opened it to the fill that closed it flat, with holding period and realized P&L for the whole trade. This is the unit a trader reviews, and it is deliberately not the same as a tax lot. get_realized_pnl matches individual FIFO lots for reporting; this matches whole positions for reviewing decisions, so one trade here can span several lots and several orders. A position still open reports a null P&L rather than a mark-to-market guess.',
      inputSchema: {
        symbol: symbolSchema.optional(),
        start: isoTimestamp.optional().describe('Only trades opened at or after this time.'),
        end: isoTimestamp.optional().describe('Only fills at or before this time.'),
        include_open: z
          .boolean()
          .optional()
          .default(true)
          .describe('Include the position that is still open, if any.'),
        limit: z.number().int().positive().max(500).optional().default(100),
        offset: z.number().int().min(0).optional().default(0),
      },
    },
    async ({ symbol, start, end, include_open, limit, offset }) => {
      try {
        const { fills, truncated, undatedExcluded, undatedTotal } = await loadFills({
          symbol,
          start,
          end,
        });

        const all = buildRoundTrips(fills);
        const trades = include_open ? all : all.filter((t) => t.closedAt !== null);
        const newestFirst = [...trades].sort(
          (a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt),
        );
        const page = newestFirst.slice(offset, offset + limit);

        return toolResult({
          trades: page.map(renderTrade),
          pagination: {
            returned: page.length,
            offset,
            limit,
            total_matching: trades.length,
            has_more: offset + page.length < trades.length,
          },
          method:
            'A trade opens when the position in a pair leaves flat and closes when it returns to flat. P&L is total sale proceeds minus total purchase cost within that trade, before fees.',
          ...warnings({ truncated, undatedExcluded, undatedTotal }),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'journal_performance',
    {
      title: 'Summarize trading performance',
      description:
        'Aggregate performance over closed round-trip trades: total trades, win rate, average win, average loss, profit factor, largest win and largest loss, broken out per pair and overall. DERIVED FROM ROBINHOOD ORDER HISTORY ONLY. It excludes external transfers, deposits and withdrawals, assets moved in from another venue, staking rewards and airdrops, and it is before fees and taxes, so it is not a statement of account performance. It measures the trades this account executed, which is the question "am I trading well" actually asks.',
      inputSchema: {
        symbol: symbolSchema.optional(),
        start: isoTimestamp.optional(),
        end: isoTimestamp.optional(),
      },
    },
    async ({ symbol, start, end }) => {
      try {
        const { fills, truncated, undatedExcluded, undatedTotal } = await loadFills({
          symbol,
          start,
          end,
        });

        const trades = buildRoundTrips(fills);
        const closed = trades.filter(
          (t): t is RoundTrip & { realizedPnl: number } => t.realizedPnl !== null,
        );

        if (!closed.length) {
          return toolResult({
            overall: null,
            by_symbol: [],
            open_trades: trades.filter((t) => t.closedAt === null).length,
            message:
              'No round trip closed in the available history. Performance can only be measured on positions that returned to flat, not on positions still open.',
            ...warnings({ truncated, undatedExcluded, undatedTotal }),
          });
        }

        const symbols = [...new Set(closed.map((t) => t.symbol))].sort();

        return toolResult({
          overall: performanceOf(closed),
          by_symbol: symbols.map((s) => ({
            symbol: s,
            ...performanceOf(closed.filter((t) => t.symbol === s)),
          })),
          open_trades: trades.filter((t) => t.closedAt === null).length,
          scope:
            'Closed round trips from Robinhood order history only. Excludes external transfers, deposits, withdrawals, staking and airdrops. Before fees and taxes.',
          ...warnings({ truncated, undatedExcluded, undatedTotal }),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'journal_daily_summary',
    {
      title: 'Summarize activity by day',
      description:
        'Per-day traded volume, buy and sell counts, and net realized P&L, in UTC days. Realized P&L is attributed to the day a round trip closed, not spread across the days it was held, so a day with a large number is the day a position was exited. Days with no activity are omitted rather than emitted as zeroes.',
      inputSchema: {
        symbol: symbolSchema.optional(),
        start: isoTimestamp.optional(),
        end: isoTimestamp.optional(),
        limit: z
          .number()
          .int()
          .positive()
          .max(400)
          .optional()
          .default(90)
          .describe('Maximum days to return, most recent first.'),
      },
    },
    async ({ symbol, start, end, limit }) => {
      try {
        const { fills, truncated, undatedExcluded, undatedTotal } = await loadFills({
          symbol,
          start,
          end,
        });

        const days = new Map<
          string,
          { volume: number; buys: number; sells: number; realized: number; closed: number }
        >();
        const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
        const bucket = (key: string) => {
          const existing = days.get(key);
          if (existing) return existing;
          const created = { volume: 0, buys: 0, sells: 0, realized: 0, closed: 0 };
          days.set(key, created);
          return created;
        };

        let undatedFills = 0;
        for (const fill of fills) {
          if (fill.timestamp === null) {
            undatedFills++;
            continue;
          }
          const day = bucket(dayOf(fill.timestamp));
          day.volume += fill.notional;
          if (fill.side === 'buy') day.buys++;
          else day.sells++;
        }

        for (const trade of buildRoundTrips(fills)) {
          if (trade.closedAt === null || trade.realizedPnl === null) continue;
          const day = bucket(dayOf(trade.closedAt));
          day.realized += trade.realizedPnl;
          day.closed++;
        }

        const rows = [...days.entries()]
          .sort((a, b) => (a[0] < b[0] ? 1 : -1))
          .slice(0, limit)
          .map(([date, d]) => ({
            date,
            volume_usd: d.volume,
            fills: d.buys + d.sells,
            buys: d.buys,
            sells: d.sells,
            trades_closed: d.closed,
            net_realized_pnl: d.realized,
          }));

        return toolResult({
          days: rows,
          totals: {
            days_with_activity: days.size,
            volume_usd: sum(rows.map((r) => r.volume_usd)),
            net_realized_pnl: sum(rows.map((r) => r.net_realized_pnl)),
          },
          timezone: 'UTC. A day runs 00:00:00Z to 23:59:59Z.',
          ...(undatedFills
            ? {
                undated_fills: undatedFills,
                undated_note:
                  'These executions carried no parseable timestamp and are counted in no day.',
              }
            : {}),
          ...warnings({ truncated, undatedExcluded, undatedTotal }),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'journal_open_orders',
    {
      title: 'Review working orders',
      description:
        'List every order currently working, with its age, its resting price, how far that price sits from the live market, and whether it looks stale. A stale order is one that is both old and far from the market: it is not protecting anything and not going to fill, but it is still capital the account cannot use. Distance is measured against the side the order would actually cross, so a buy is compared to the ask. An order whose price or market cannot be resolved is reported with stale=null rather than a guess.',
      inputSchema: {
        symbol: symbolSchema.optional().describe('Limit to one trading pair.'),
        stale_after_hours: z
          .number()
          .positive()
          .optional()
          .default(24)
          .describe('An order must be at least this old to count as stale.'),
        stale_distance_percent: z
          .number()
          .positive()
          .optional()
          .default(5)
          .describe('And at least this far from the market, in percent.'),
      },
    },
    async ({ symbol, stale_after_hours, stale_distance_percent }) => {
      try {
        const { orders, truncated } = await workingOrders();
        const filtered = symbol
          ? orders.filter((o) => String(o.symbol ?? '').toUpperCase() === symbol)
          : orders;

        if (!filtered.length) {
          return toolResult({
            open_orders: [],
            message: symbol
              ? `No working orders on ${symbol}.`
              : 'No working orders in this account.',
          });
        }

        // One quote per distinct pair, not one per order: a laddered strategy
        // can leave dozens of orders resting on the same symbol.
        const marks = new Map<string, { bid: number | null; ask: number | null }>();
        for (const pair of new Set(filtered.map((o) => String(o.symbol ?? '').toUpperCase()))) {
          if (!pair) continue;
          const row = await rawQuote(pair);
          marks.set(pair, {
            bid: row
              ? firstNumber(row, ['bid_inclusive_of_sell_spread', 'bid', 'bid_price', 'price'])
              : null,
            ask: row
              ? firstNumber(row, ['ask_inclusive_of_buy_spread', 'ask', 'ask_price', 'price'])
              : null,
          });
        }

        const now = Date.now();
        const rows = filtered.map((order) =>
          describeWorkingOrder(order, marks, now, {
            staleAfterHours: stale_after_hours,
            staleDistancePercent: stale_distance_percent,
          }),
        );

        return toolResult({
          open_orders: rows.sort((a, b) => (b.age_hours ?? 0) - (a.age_hours ?? 0)),
          summary: {
            working: rows.length,
            stale: rows.filter((r) => r.stale === true).length,
            undetermined: rows.filter((r) => r.stale === null).length,
            marketable_now: rows.filter((r) => r.marketable === true).length,
          },
          stale_rule: `Older than ${stale_after_hours}h and further than ${stale_distance_percent}% from the crossing side of the market.`,
          ...(truncated
            ? {
                warning:
                  'The working-order list was truncated by the page limit, so some orders are not shown.',
              }
            : {}),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'journal_export_csv',
    {
      title: 'Export the journal as CSV',
      description:
        'Render fills or round-trip trades as RFC 4180 CSV text for the user to save to a file. Fields containing a comma, a quote or a newline are quoted and internal quotes doubled, and a field that would otherwise be read as a spreadsheet formula is neutralised. This tool returns the CSV as text; it writes nothing to disk, so the caller is responsible for saving it.',
      inputSchema: {
        format: z
          .enum(['fills', 'trades'])
          .describe('fills for one row per execution, trades for one row per round trip.'),
        symbol: symbolSchema.optional(),
        start: isoTimestamp.optional(),
        end: isoTimestamp.optional(),
        limit: z
          .number()
          .int()
          .positive()
          .max(10_000)
          .optional()
          .default(2_000)
          .describe('Maximum rows, most recent first.'),
      },
    },
    async ({ format, symbol, start, end, limit }) => {
      try {
        const { fills, truncated, undatedExcluded, undatedTotal } = await loadFills({
          symbol,
          start,
          end,
        });

        const csv =
          format === 'fills'
            ? toCsv(
                ['time', 'symbol', 'side', 'quantity', 'price', 'notional', 'order_id'],
                [...fills]
                  .reverse()
                  .slice(0, limit)
                  .map((f) => [
                    f.timestamp === null ? '' : new Date(f.timestamp).toISOString(),
                    f.symbol,
                    f.side,
                    f.quantity,
                    f.price,
                    f.notional,
                    f.orderId,
                  ]),
              )
            : toCsv(
                [
                  'opened_at',
                  'closed_at',
                  'symbol',
                  'quantity_bought',
                  'quantity_sold',
                  'buy_notional',
                  'sell_notional',
                  'realized_pnl',
                  'holding_hours',
                  'fills',
                  'status',
                ],
                buildRoundTrips(fills)
                  .sort((a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt))
                  .slice(0, limit)
                  .map((t) => [
                    new Date(t.openedAt).toISOString(),
                    t.closedAt === null ? '' : new Date(t.closedAt).toISOString(),
                    t.symbol,
                    t.quantityBought,
                    t.quantitySold,
                    t.buyNotional,
                    t.sellNotional,
                    t.realizedPnl ?? '',
                    t.closedAt === null ? '' : (t.closedAt - t.openedAt) / 3_600_000,
                    t.fillCount,
                    t.closedAt === null ? 'open' : 'closed',
                  ]),
              );

        const rowCount = csv ? csv.split('\r\n').length - 1 : 0;

        return toolResult({
          format,
          row_count: rowCount,
          filename_suggestion: `robinhood-${format}-${new Date().toISOString().slice(0, 10)}.csv`,
          csv,
          ...warnings({ truncated, undatedExcluded, undatedTotal }),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'journal_reconcile',
    {
      title: 'Reconcile local intents against Robinhood',
      description:
        'Compare what this toolkit recorded that it submitted against what Robinhood actually reports, and list every disagreement. This is the audit an operator runs after a crash, a restart or an unexplained position. An intent is written to the local job database BEFORE the order is sent, so a crash in between leaves a record with no order, and the opposite (an order that exists while the local record says it failed) is the dangerous case worth finding. Absence is never inferred from an incomplete search: if the order history could not be walked far enough back, the verdict is "unresolved", not "missing".',
      inputSchema: {
        database_path: z
          .string()
          .optional()
          .describe('Job database to audit. Defaults to ROBINHOOD_MCP_DB or ~/.robinhood-mcp/jobs.db.'),
        include_matched: z
          .boolean()
          .optional()
          .default(false)
          .describe('Also list the intents that agree with Robinhood, not just the discrepancies.'),
      },
    },
    async ({ database_path, include_matched }) => {
      try {
        const path = database_path?.trim() || jobDatabasePath();

        // Never open a database that is not there. `node:sqlite` would create
        // an empty one, and a freshly created file reports zero intents, which
        // reads exactly like "everything reconciles" when the truth is "the
        // audit had nothing to audit".
        if (!existsSync(path)) {
          return toolResult({
            reconciled: false,
            database_path: path,
            reason:
              'No local job database exists at this path, so there is nothing recorded to compare against Robinhood.',
            remediation:
              'Durable jobs and order intents are written only by robinhood-mcp-trading. If you expected records here, point database_path at the ROBINHOOD_MCP_DB used by that server.',
          });
        }

        const store = new JobStore(path);
        let intents: OrderIntentRecord[];
        let jobCount: number;
        try {
          intents = collectIntents(store);
          jobCount = store.listJobs().length;
        } finally {
          // Close on every path: holding the handle open would keep a lock the
          // trading server needs, and this tool is read-only.
          store.close();
        }

        if (!intents.length) {
          return toolResult({
            reconciled: true,
            database_path: path,
            jobs_in_store: jobCount,
            intents_examined: 0,
            discrepancies: [],
            message: 'The local job database records no order intents, so there is nothing to reconcile.',
          });
        }

        // Bound the upstream walk by the oldest intent under audit, widened for
        // clock skew between this machine and Robinhood's stamping of
        // created_at. An unbounded walk is the entire account history.
        const oldest = Math.min(...intents.map((i) => i.createdAt));
        const since = new Date(oldest - 15 * 60_000).toISOString();

        const { results, truncated } = await client.getAllPages<Record<string, unknown>>(
          endpoints.orders,
          { query: { created_at_start: since, ...(await accountScope()) } },
          HISTORY_MAX_PAGES,
        );

        const byClientOrderId = new Map<string, Record<string, unknown>>();
        const byOrderId = new Map<string, Record<string, unknown>>();
        for (const order of results) {
          const clientId = order.client_order_id;
          if (typeof clientId === 'string' && clientId) byClientOrderId.set(clientId, order);
          const id = order.id;
          if (typeof id === 'string' && id) byOrderId.set(id, order);
        }

        const rows = intents.map((intent) =>
          reconcileIntent(intent, byClientOrderId, byOrderId, truncated),
        );
        const discrepancies = rows.filter((r) => r.verdict !== 'matched');

        // Orders Robinhood knows about that carry no local record at all. Not
        // necessarily wrong (the app, the website and place_order all produce
        // them) but it is the other half of an honest audit.
        const knownClientIds = new Set(intents.map((i) => i.clientOrderId));
        const unrecorded = results.filter((order) => {
          const clientId = order.client_order_id;
          return typeof clientId === 'string' && clientId.length > 0 && !knownClientIds.has(clientId);
        });

        return toolResult({
          reconciled: true,
          database_path: path,
          jobs_in_store: jobCount,
          intents_examined: intents.length,
          orders_compared: results.length,
          search_from: since,
          discrepancies,
          ...(include_matched ? { matched: rows.filter((r) => r.verdict === 'matched') } : {}),
          unrecorded_upstream_orders: unrecorded.length,
          unrecorded_note:
            'Orders Robinhood reports with a client_order_id this database never recorded. Expected for orders placed from the Robinhood app or website, or by another installation.',
          coverage:
            'Intents are enumerated from the unsettled queue plus every job in this database. An intent that was settled and never belonged to a job is not reachable through the store API and is not covered here.',
          ...(truncated
            ? {
                warning:
                  'The upstream order walk hit its page limit, so absence could not be proven. Intents that were not found are reported as unresolved rather than missing.',
              }
            : {}),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

/**
 * Every intent the store API can reach.
 *
 * `JobStore` exposes the unsettled queue and per-job lookup, but no "all
 * intents" query. Both sources are unioned by client_order_id, and the gap
 * (a settled intent with no job) is declared in the tool result rather than
 * papered over, because a reconciliation that silently omits rows is worse
 * than one that says what it did not check.
 */
function collectIntents(store: JobStore): OrderIntentRecord[] {
  const byClientOrderId = new Map<string, OrderIntentRecord>();
  for (const intent of store.pendingIntents()) {
    byClientOrderId.set(intent.clientOrderId, intent);
  }
  for (const job of store.listJobs()) {
    for (const intent of store.intentsForJob(job.id)) {
      byClientOrderId.set(intent.clientOrderId, intent);
    }
  }
  return [...byClientOrderId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

interface ReconcileRow {
  client_order_id: string;
  job_id: string | null;
  local_status: string;
  recorded_order_id: string | null;
  upstream_order_id: string | null;
  upstream_state: string | null;
  verdict: string;
  detail: string;
  severity: 'none' | 'info' | 'warning' | 'critical';
}

/**
 * Decide whether one local record agrees with Robinhood.
 *
 * The severities are not decoration. An intent believed failed while the order
 * is live upstream is the case that leaves an operator holding unhedged risk
 * they do not know about, so it outranks the merely untidy cases.
 */
function reconcileIntent(
  intent: OrderIntentRecord,
  byClientOrderId: Map<string, Record<string, unknown>>,
  byOrderId: Map<string, Record<string, unknown>>,
  searchTruncated: boolean,
): ReconcileRow {
  const upstream =
    byClientOrderId.get(intent.clientOrderId) ??
    (intent.orderId ? byOrderId.get(intent.orderId) : undefined);

  const base = {
    client_order_id: intent.clientOrderId,
    job_id: intent.jobId,
    local_status: intent.status,
    recorded_order_id: intent.orderId,
    upstream_order_id: upstream ? String(upstream.id ?? '') || null : null,
    upstream_state: upstream ? (String(upstream.state ?? '') || null) : null,
  };

  if (upstream) {
    switch (intent.status) {
      case 'submitted':
        return {
          ...base,
          verdict: 'matched',
          detail: 'Recorded as submitted and present upstream.',
          severity: 'none',
        };
      case 'pending':
        return {
          ...base,
          verdict: 'submitted_but_unsettled',
          detail:
            'The order reached Robinhood but the local record was never updated, which is what a crash between sending and recording looks like. The order is real: do not resubmit it. Restarting the trading server adopts it automatically.',
          severity: 'warning',
        };
      case 'failed':
        return {
          ...base,
          verdict: 'live_despite_recorded_failure',
          detail:
            'The local record says this order failed, but Robinhood has it. Real exposure exists that this toolkit is not tracking. Check the position and cancel the order if it was not wanted.',
          severity: 'critical',
        };
      default:
        return {
          ...base,
          verdict: 'live_despite_abandonment',
          detail:
            'The local record abandoned this order as never sent, but Robinhood has it. Real exposure exists that this toolkit is not tracking.',
          severity: 'critical',
        };
    }
  }

  // Not found upstream. Whether that means "does not exist" depends entirely on
  // whether the search was complete, so a truncated walk never yields a
  // negative verdict.
  if (searchTruncated) {
    return {
      ...base,
      verdict: 'unresolved',
      detail:
        'Not found in the order history that could be walked, and that walk was truncated. Absence is unproven: treat this as unknown, not as missing.',
      severity: 'warning',
    };
  }

  switch (intent.status) {
    case 'pending':
      return {
        ...base,
        verdict: 'reserved_never_sent',
        detail:
          'Reserved locally and conclusively absent upstream, so the request never reached Robinhood. Safe to retry with the same client_order_id.',
        severity: 'info',
      };
    case 'submitted':
      return {
        ...base,
        verdict: 'recorded_submitted_but_absent',
        detail:
          'The local record claims Robinhood accepted this order, but the order history does not contain it. Either the history does not reach back far enough or the record is wrong. Verify manually before acting on it.',
        severity: 'critical',
      };
    default:
      return {
        ...base,
        verdict: 'matched',
        detail: `Recorded as ${intent.status} and absent upstream, which agrees.`,
        severity: 'none',
      };
  }
}

/** Walk fills chronologically and cut a trade each time the position goes flat. */
function buildRoundTrips(fills: JournalFill[]): RoundTrip[] {
  const bySymbol = new Map<string, JournalFill[]>();
  for (const fill of fills) {
    // An undated fill cannot be placed in the sequence, and a wrong sequence
    // produces a wrong trade rather than a missing one.
    if (fill.timestamp === null) continue;
    const list = bySymbol.get(fill.symbol);
    if (list) list.push(fill);
    else bySymbol.set(fill.symbol, [fill]);
  }

  const trades: RoundTrip[] = [];

  for (const [symbol, rows] of bySymbol) {
    const ordered = [...rows].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

    let open: RoundTrip | null = null;
    let position = 0;
    let peak = 0;

    for (const fill of ordered) {
      if (!open) {
        open = {
          symbol,
          openedAt: fill.timestamp ?? 0,
          closedAt: null,
          quantityBought: 0,
          quantitySold: 0,
          buyNotional: 0,
          sellNotional: 0,
          realizedPnl: null,
          fillCount: 0,
          incompleteHistory: false,
        };
        position = 0;
        peak = 0;
      }

      open.fillCount++;
      if (fill.side === 'buy') {
        open.quantityBought += fill.quantity;
        open.buyNotional += fill.notional;
        position += fill.quantity;
      } else {
        open.quantitySold += fill.quantity;
        open.sellNotional += fill.notional;
        position -= fill.quantity;
      }

      peak = Math.max(peak, Math.abs(position));

      // A negative position on a spot account means the buys that created the
      // inventory predate the history the API returned. Flag it: the P&L for
      // this trade is missing a cost, so it will read as a phantom gain.
      if (position < -tolerance(peak)) open.incompleteHistory = true;

      if (Math.abs(position) <= tolerance(peak)) {
        open.closedAt = fill.timestamp ?? 0;
        open.realizedPnl = open.sellNotional - open.buyNotional;
        trades.push(open);
        open = null;
      }
    }

    if (open) trades.push(open);
  }

  return trades.sort((a, b) => a.openedAt - b.openedAt);
}

function tolerance(peak: number): number {
  return Math.max(peak * CLOSE_TOLERANCE_RATIO, Number.EPSILON);
}

function performanceOf(trades: Array<RoundTrip & { realizedPnl: number }>) {
  const wins = trades.filter((t) => t.realizedPnl > 0);
  const losses = trades.filter((t) => t.realizedPnl < 0);
  const grossProfit = sum(wins.map((t) => t.realizedPnl));
  const grossLoss = Math.abs(sum(losses.map((t) => t.realizedPnl)));
  const held = trades
    .filter((t) => t.closedAt !== null)
    .map((t) => (t.closedAt as number) - t.openedAt);

  return {
    total_trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: trades.length - wins.length - losses.length,
    win_rate_percent: (wins.length / trades.length) * 100,
    net_realized_pnl: grossProfit - grossLoss,
    average_win: wins.length ? grossProfit / wins.length : 0,
    average_loss: losses.length ? grossLoss / losses.length : 0,
    // Undefined rather than infinite when nothing has lost yet. Reporting 0 or
    // Infinity both read as a real measurement of a ratio that has none.
    profit_factor: grossLoss === 0 ? null : grossProfit / grossLoss,
    largest_win: wins.length ? Math.max(...wins.map((t) => t.realizedPnl)) : null,
    largest_loss: losses.length ? Math.min(...losses.map((t) => t.realizedPnl)) : null,
    average_holding_hours: held.length ? sum(held) / held.length / 3_600_000 : null,
    volume_usd: sum(trades.map((t) => t.buyNotional + t.sellNotional)),
    trades_with_incomplete_history: trades.filter((t) => t.incompleteHistory).length,
  };
}

function renderFill(fill: JournalFill) {
  return {
    time: fill.timestamp === null ? null : new Date(fill.timestamp).toISOString(),
    symbol: fill.symbol,
    side: fill.side,
    quantity: fill.quantity,
    price: fill.price,
    notional: fill.notional,
    order_id: fill.orderId,
  };
}

function renderTrade(trade: RoundTrip) {
  return {
    symbol: trade.symbol,
    status: trade.closedAt === null ? 'open' : 'closed',
    opened_at: new Date(trade.openedAt).toISOString(),
    closed_at: trade.closedAt === null ? null : new Date(trade.closedAt).toISOString(),
    holding_hours: trade.closedAt === null ? null : (trade.closedAt - trade.openedAt) / 3_600_000,
    quantity_bought: trade.quantityBought,
    quantity_sold: trade.quantitySold,
    buy_notional: trade.buyNotional,
    sell_notional: trade.sellNotional,
    realized_pnl: trade.realizedPnl,
    return_percent:
      trade.realizedPnl === null || trade.buyNotional === 0
        ? null
        : (trade.realizedPnl / trade.buyNotional) * 100,
    fills: trade.fillCount,
    ...(trade.incompleteHistory
      ? {
          incomplete_history: true,
          warning:
            'This position went short during the trade, which on a spot account means the opening buys are older than the history the API returned. Its P&L is missing a cost and overstates the gain.',
        }
      : {}),
  };
}

interface WorkingOrderRow {
  order_id: string;
  symbol: string;
  side: string;
  type: string;
  state: string;
  created_at: string | null;
  age_hours: number | null;
  quantity: number | null;
  filled_quantity: number | null;
  resting_price: number | null;
  price_field: string | null;
  market_price: number | null;
  distance_percent: number | null;
  marketable: boolean | null;
  stale: boolean | null;
  note?: string;
}

function describeWorkingOrder(
  order: Record<string, unknown>,
  marks: Map<string, { bid: number | null; ask: number | null }>,
  now: number,
  thresholds: { staleAfterHours: number; staleDistancePercent: number },
): WorkingOrderRow {
  const symbol = String(order.symbol ?? '').toUpperCase();
  const side = String(order.side ?? '').toLowerCase();
  const createdMs = Date.parse(String(order.created_at ?? ''));
  const ageHours = Number.isFinite(createdMs) ? (now - createdMs) / 3_600_000 : null;

  const resting = restingPrice(order);
  const mark = marks.get(symbol);
  // Compare against the side the order has to cross: a resting buy only fills
  // by lifting the ask, so measuring it against the bid flatters it.
  const reference = side === 'buy' ? (mark?.ask ?? null) : (mark?.bid ?? null);

  const distance =
    resting.price === null || reference === null || reference === 0
      ? null
      : ((resting.price - reference) / reference) * 100;

  const marketable =
    resting.price === null || reference === null
      ? null
      : side === 'buy'
        ? resting.price >= reference
        : resting.price <= reference;

  const undetermined = ageHours === null || distance === null;
  const stale = undetermined
    ? null
    : (ageHours as number) >= thresholds.staleAfterHours &&
      Math.abs(distance as number) >= thresholds.staleDistancePercent;

  return {
    order_id: String(order.id ?? ''),
    symbol,
    side,
    type: String(order.type ?? ''),
    state: String(order.state ?? ''),
    created_at: Number.isFinite(createdMs) ? new Date(createdMs).toISOString() : null,
    age_hours: ageHours,
    quantity: numberOrNull(order.asset_quantity),
    filled_quantity: numberOrNull(order.filled_asset_quantity),
    resting_price: resting.price,
    price_field: resting.field,
    market_price: reference,
    distance_percent: distance,
    marketable,
    stale,
    ...(undetermined
      ? {
          note:
            resting.price === null
              ? 'This order carries no resting price (a working market order), so distance and staleness cannot be judged.'
              : reference === null
                ? 'The pair could not be quoted, so distance and staleness cannot be judged.'
                : 'The order carries no parseable creation time, so its age cannot be judged.',
        }
      : {}),
  };
}

/**
 * The price an order is actually resting at.
 *
 * Robinhood nests it under a per-type config object, so the type determines
 * where to look. A stop-limit has two prices: the limit is the one the order
 * would fill at, so distance is measured against that.
 */
function restingPrice(order: Record<string, unknown>): { price: number | null; field: string | null } {
  const configs: Array<[string, string]> = [
    ['limit_order_config', 'limit_price'],
    ['stop_limit_order_config', 'limit_price'],
    ['stop_loss_order_config', 'stop_price'],
  ];

  for (const [configKey, priceKey] of configs) {
    const config = order[configKey];
    if (!config || typeof config !== 'object') continue;
    const value = Number((config as Record<string, unknown>)[priceKey]);
    if (Number.isFinite(value) && value > 0) return { price: value, field: `${configKey}.${priceKey}` };
  }

  return { price: null, field: null };
}

/** Shared truncation and undated-fill disclosure, so every tool says it the same way. */
function warnings(input: { truncated: boolean; undatedExcluded: number; undatedTotal: number }) {
  const notes: string[] = [];
  if (input.truncated) {
    notes.push(
      `Order history was truncated at ${HISTORY_MAX_PAGES} pages, so the oldest activity is missing and every derived total is a lower bound.`,
    );
  }
  if (input.undatedExcluded > 0) {
    notes.push(
      `${input.undatedExcluded} execution(s) carried no parseable timestamp and were excluded from the date filter rather than assumed to be in range.`,
    );
  } else if (input.undatedTotal > 0) {
    notes.push(
      `${input.undatedTotal} execution(s) carried no parseable timestamp. They are included in totals but cannot be placed on a timeline.`,
    );
  }
  return notes.length ? { warnings: notes } : {};
}

/** @throws {Error} With the offending value, so the caller can fix it directly. */
function parseBound(value: string | undefined, label: string): number | null {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Could not parse ${label} as a timestamp: "${value}". Use ISO 8601, e.g. 2026-01-01T00:00:00Z.`);
  }
  return parsed;
}

/**
 * RFC 4180 cell.
 *
 * The leading-quote guard is not part of RFC 4180: a cell beginning with =, +,
 * - or @ is executed as a formula by Excel, Sheets and LibreOffice when the file
 * is opened. Symbols and states come from an upstream API, so neutralising them
 * here costs nothing and closes a real injection path into the user's machine.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);

  const formulaRisk = /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text);
  const body = formulaRisk ? `'${text}` : text;

  return /[",\r\n]/.test(body) ? `"${body.replace(/"/g, '""')}"` : body;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

const sum = (values: number[]) => values.reduce((total, v) => total + v, 0);

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstNumber(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = Number(row[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}
