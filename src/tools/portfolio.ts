/**
 * Portfolio analytics tools.
 *
 * Everything here is derived from order history rather than fetched: Robinhood
 * reports holdings and current value, but never what you paid, what you have
 * realized, or which lots are open. These tools close that gap.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RobinhoodCryptoClient } from '../shared/client.js';
import type { Credentials } from '../shared/config.js';
import { endpointsFor, requiresAccountNumber } from '../shared/endpoints.js';
import { toolResult, toolError } from '../shared/format.js';
import {
  computeCostBasis,
  fillsFromOrders,
  summarizePositions,
} from '../analytics/cost-basis.js';
import { estimateSlippage, maxDrawdown, realizedVolatility, sizeByRisk } from '../analytics/sizing.js';

const symbolSchema = z
  .string()
  .regex(/^[A-Za-z0-9]+-[A-Za-z0-9]+$/, 'Symbol must be a trading pair like BTC-USD.')
  .transform((s) => s.toUpperCase());

export function registerPortfolioTools(
  server: McpServer,
  client: RobinhoodCryptoClient,
  credentials: Credentials,
): void {
  // These tools only read, so they take the client directly rather than the
  // Executor. That keeps them available on the read-only server, which builds
  // no Executor precisely so it has no code path that can place an order.
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

  /** Filled orders, used by every derived number here. */
  async function filledOrders(symbol?: string): Promise<Array<Record<string, unknown>>> {
    const { results } = await client.getAllPages<Record<string, unknown>>(endpoints.orders, {
      query: { state: 'filled', ...(symbol ? { symbol } : {}), ...(await accountScope()) },
    });
    return results;
  }

  async function holdings(): Promise<Array<Record<string, unknown>>> {
    const { results } = await client.getAllPages<Record<string, unknown>>(endpoints.holdings, {
      query: await accountScope(),
    });
    return results;
  }

  /** Raw quote row, so callers needing both sides make one request not two. */
  async function rawQuote(symbol: string): Promise<Record<string, unknown> | null> {
    const quote = await client.get<{ results?: Array<Record<string, unknown>> }>(
      endpoints.bestBidAsk,
      { query: { symbol: [symbol.toUpperCase()] } },
    );
    return quote?.results?.[0] ?? null;
  }

  /** Execution-side price, or null when the asset cannot be quoted. */
  async function referencePrice(symbol: string, side: 'buy' | 'sell'): Promise<number | null> {
    const row = await rawQuote(symbol);
    if (!row) return null;
    const keys =
      side === 'buy'
        ? ['ask_inclusive_of_buy_spread', 'ask', 'ask_price', 'price']
        : ['bid_inclusive_of_sell_spread', 'bid', 'bid_price', 'price'];
    return firstNumber(row, keys);
  }

  /** Current prices for a set of assets, skipping any that cannot be quoted. */
  async function priceMap(assetCodes: string[]): Promise<Record<string, number>> {
    const prices: Record<string, number> = {};
    for (const assetCode of assetCodes) {
      const price = await referencePrice(`${assetCode}-USD`, 'sell');
      if (price !== null) prices[assetCode] = price;
    }
    return prices;
  }

  server.registerTool(
    'get_cost_basis',
    {
      title: 'Get cost basis',
      description:
        'Compute FIFO cost basis, open tax lots, and realized P&L from filled order history. Robinhood does not report any of this: it tells you what you hold and what it is worth now, not what you paid. Use this for "what is my average cost" and "how much have I actually made".',
      inputSchema: {
        symbol: symbolSchema.optional().describe('Limit to one trading pair. Omit for all assets.'),
        include_lots: z
          .boolean()
          .optional()
          .default(false)
          .describe('Include every open lot individually, not just the per-asset summary.'),
      },
    },
    async ({ symbol, include_lots }) => {
      try {
        const orders = await filledOrders(symbol);
        const fills = fillsFromOrders(orders);

        if (!fills.length) {
          return toolResult({
            positions: [],
            message:
              'No filled orders found in the available history, so there is nothing to compute a basis from.',
          });
        }

        const result = computeCostBasis(fills);
        const assets = [...new Set(result.openLots.map((lot) => lot.assetCode))];
        const positions = summarizePositions(result, await priceMap(assets));

        return toolResult({
          positions,
          totals: {
            cost_basis: sum(positions.map((p) => p.costBasis)),
            market_value: sum(positions.map((p) => p.marketValue ?? 0)),
            unrealized_pnl: sum(positions.map((p) => p.unrealizedPnl ?? 0)),
            realized_pnl: sum(positions.map((p) => p.realizedPnl)),
          },
          ...(include_lots ? { open_lots: result.openLots } : {}),
          ...(result.unmatchedSells.length
            ? {
                unmatched_sells: result.unmatchedSells,
                warning:
                  'Some sells had no matching buy in the available history, so realized P&L for those assets is incomplete. This usually means the order history does not reach back far enough.',
              }
            : {}),
          method: 'FIFO over filled order history. A calculation, not tax advice.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_realized_pnl',
    {
      title: 'Get realized P&L',
      description:
        'List every closed disposal with proceeds, cost basis, gain or loss, and whether the holding period exceeded one year. Use this for tax preparation and for answering "what did I actually realize this year".',
      inputSchema: {
        symbol: symbolSchema.optional(),
        year: z
          .number()
          .int()
          .min(2009)
          .max(2100)
          .optional()
          .describe('Limit to disposals in this calendar year (UTC).'),
      },
    },
    async ({ symbol, year }) => {
      try {
        const fills = fillsFromOrders(await filledOrders(symbol));
        const { disposals, unmatchedSells } = computeCostBasis(fills);

        const filtered =
          year === undefined
            ? disposals
            : disposals.filter((d) => new Date(d.disposedAt).getUTCFullYear() === year);

        return toolResult({
          disposals: filtered.map((d) => ({
            asset: d.assetCode,
            quantity: d.quantity,
            proceeds: d.proceeds,
            cost_basis: d.costBasis,
            realized_pnl: d.realizedPnl,
            term: d.longTerm ? 'long' : 'short',
            acquired_at: new Date(d.acquiredAt).toISOString(),
            disposed_at: new Date(d.disposedAt).toISOString(),
          })),
          totals: {
            realized_pnl: sum(filtered.map((d) => d.realizedPnl)),
            short_term: sum(filtered.filter((d) => !d.longTerm).map((d) => d.realizedPnl)),
            long_term: sum(filtered.filter((d) => d.longTerm).map((d) => d.realizedPnl)),
            proceeds: sum(filtered.map((d) => d.proceeds)),
          },
          ...(unmatchedSells.length ? { unmatched_sells: unmatchedSells } : {}),
          method: 'FIFO. A calculation over available order history, not tax advice.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_allocation',
    {
      title: 'Get portfolio allocation',
      description:
        'Current portfolio weights by asset, with each position valued at its live price. Use this before rebalancing, or to answer "how concentrated am I".',
      inputSchema: {},
    },
    async () => {
      try {
        const rows0 = await holdings();
        if (!rows0.length) {
          return toolResult({ allocation: [], message: 'No holdings found in this account.' });
        }

        const rows: Array<{ asset: string; quantity: number; value: number | null }> = [];
        for (const holding of rows0) {
          const asset = String(holding.asset_code ?? '');
          const quantity = Number(holding.total_quantity ?? holding.quantity ?? 0);
          if (!asset || !Number.isFinite(quantity) || quantity <= 0) continue;

          const price = await referencePrice(`${asset}-USD`, 'sell');
          rows.push({ asset, quantity, value: price === null ? null : quantity * price });
        }

        const total = sum(rows.map((r) => r.value ?? 0));
        const unpriced = rows.filter((r) => r.value === null).map((r) => r.asset);

        return toolResult({
          total_value_usd: total,
          allocation: rows
            .map((r) => ({
              asset: r.asset,
              quantity: r.quantity,
              value_usd: r.value,
              // Weights are computed over priced assets only, so they still sum
              // to 100 rather than being silently diluted by an unpriced row.
              weight_percent: r.value === null || total === 0 ? null : (r.value / total) * 100,
            }))
            .sort((a, b) => (b.value_usd ?? 0) - (a.value_usd ?? 0)),
          ...(unpriced.length
            ? {
                unpriced_assets: unpriced,
                warning:
                  'These assets could not be quoted, so they are excluded from the total and from every weight.',
              }
            : {}),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'size_position_by_risk',
    {
      title: 'Size a position by risk',
      description:
        'Compute how much to buy so that hitting your stop loses a chosen percentage of the account, rather than picking a size first and accepting whatever loss follows. Returns the quantity, notional, and the exact dollar amount at risk.',
      inputSchema: {
        account_value_usd: z.number().positive().describe('Capital the risk is measured against.'),
        risk_percent: z
          .number()
          .positive()
          .max(100)
          .describe('Percent of the account to lose if the stop is hit, e.g. 1.'),
        entry_price: z.number().positive(),
        stop_price: z.number().positive(),
      },
    },
    async ({ account_value_usd, risk_percent, entry_price, stop_price }) => {
      try {
        const result = sizeByRisk({
          accountValueUsd: account_value_usd,
          riskPercent: risk_percent,
          entryPrice: entry_price,
          stopPrice: stop_price,
        });

        return toolResult({
          quantity: result.quantity,
          notional_usd: result.notionalUsd,
          risk_usd: result.riskUsd,
          stop_distance_percent: result.stopDistancePercent,
          note: 'Check this notional against get_execution_policy: an order above the per-order ceiling is rejected.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'estimate_slippage',
    {
      title: 'Estimate slippage',
      description:
        'Estimate what crossing the spread costs for a given size, using the live quote. Robinhood publishes no order book depth, so this models the quoted spread only and is a floor on true cost, not a simulation.',
      inputSchema: {
        symbol: symbolSchema,
        side: z.enum(['buy', 'sell']),
        quantity: z.number().positive().describe('Size in the base asset.'),
      },
    },
    async ({ symbol, side, quantity }) => {
      try {
        const quote = await rawQuote(symbol);
        if (!quote) throw new Error(`No quote available for ${symbol}.`);

        const bid = firstNumber(quote, ['bid_inclusive_of_sell_spread', 'bid', 'bid_price', 'price']);
        const ask = firstNumber(quote, ['ask_inclusive_of_buy_spread', 'ask', 'ask_price', 'price']);
        if (bid === null || ask === null) {
          throw new Error(`Quote for ${symbol} did not contain a usable bid and ask.`);
        }

        return toolResult({ symbol, side, quantity, ...estimateSlippage({ bid, ask, side, quantity }) });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'analyze_trade_history',
    {
      title: 'Analyze trade history',
      description:
        'Summarize trading performance from filled orders: win rate, average win and loss, profit factor, best and worst trades, and the largest drawdown in realized P&L. Use this to answer "am I actually any good at this".',
      inputSchema: {
        symbol: symbolSchema.optional(),
      },
    },
    async ({ symbol }) => {
      try {
        const fills = fillsFromOrders(await filledOrders(symbol));
        const { disposals } = computeCostBasis(fills);

        if (!disposals.length) {
          return toolResult({
            message:
              'No closed positions in the available history. Performance can only be measured on round trips, not on open positions.',
            open_trades: fills.filter((f) => f.side === 'buy').length,
          });
        }

        const wins = disposals.filter((d) => d.realizedPnl > 0);
        const losses = disposals.filter((d) => d.realizedPnl < 0);
        const grossProfit = sum(wins.map((d) => d.realizedPnl));
        const grossLoss = Math.abs(sum(losses.map((d) => d.realizedPnl)));

        // Running realized equity, for the drawdown of actual outcomes.
        let running = 0;
        const equityCurve = [...disposals]
          .sort((a, b) => a.disposedAt - b.disposedAt)
          .map((d) => (running += d.realizedPnl));

        return toolResult({
          closed_trades: disposals.length,
          win_rate_percent: (wins.length / disposals.length) * 100,
          total_realized_pnl: grossProfit - grossLoss,
          average_win: wins.length ? grossProfit / wins.length : 0,
          average_loss: losses.length ? grossLoss / losses.length : 0,
          // Infinite when there are no losses yet: reported as null, not a
          // divide-by-zero, so the caller can say "no losses" rather than "0".
          profit_factor: grossLoss === 0 ? null : grossProfit / grossLoss,
          best_trade: maxBy(disposals, (d) => d.realizedPnl),
          worst_trade: maxBy(disposals, (d) => -d.realizedPnl),
          realized_drawdown: maxDrawdown(equityCurve.map((v) => v + Math.abs(Math.min(...equityCurve, 0)) + 1)),
          long_term_trades: disposals.filter((d) => d.longTerm).length,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_volatility',
    {
      title: 'Get realized volatility',
      description:
        'Annualized realized volatility for an asset, computed from prices you supply. Robinhood publishes no historical candles, so this cannot fetch its own series: pass one from your own records or another data source.',
      inputSchema: {
        prices: z
          .array(z.number().positive())
          .min(3)
          .describe('Price series in chronological order. At least 3 points.'),
        periods_per_year: z
          .number()
          .positive()
          .optional()
          .default(365)
          .describe('365 for daily prices, 8760 for hourly.'),
      },
    },
    async ({ prices, periods_per_year }) => {
      try {
        const result = realizedVolatility(prices, periods_per_year);
        if (!result) {
          throw new Error('Need at least 3 usable prices to compute a volatility.');
        }

        return toolResult({
          annualized_volatility_percent: result.volatility * 100,
          samples: result.samples,
          note: 'Computed from the supplied series with log returns and sample variance.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

const sum = (values: number[]) => values.reduce((total, v) => total + v, 0);

function maxBy<T>(items: T[], score: (item: T) => number): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const item of items) {
    const value = score(item);
    if (value > bestScore) {
      bestScore = value;
      best = item;
    }
  }
  return best;
}

function firstNumber(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = Number(row[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}
