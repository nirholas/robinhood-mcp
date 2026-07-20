/**
 * DCA: buy the same amount on the same cadence, for a set number of buys.
 *
 * "$200 into BTC every week" is the most common thing a person actually wants
 * from an automated account, and it is the one thing Robinhood's API cannot
 * express: there is no recurring order type, so the schedule has to live
 * somewhere durable. The job is that place. The interval and the remaining
 * count are persisted, so a restart resumes the plan on its original cadence
 * rather than starting a fresh one, and an occurrence already bought is never
 * bought twice.
 */

import type { Job, Strategy, StrategyContext, StrategyStep } from '../job.js';
import { roundToIncrement } from '../../shared/executor.js';
import {
  isPresent,
  optionalDecimal,
  requireDecimal,
  requireEnum,
  requireInt,
  requireNumber,
  requireString,
} from './params.js';

interface DcaState {
  side: 'buy' | 'sell';
  /** Quote-currency spend per occurrence. Null when sizing in the base asset. */
  quoteAmountPerBuy: string | null;
  /** Base-asset size per occurrence. Null when sizing in quote currency. */
  assetQuantityPerBuy: string | null;
  intervalMs: number;
  occurrences: number;
  occurrencesDone: number;
  /** Refuse to buy above / sell below this price. Null disables the guard. */
  maxPrice: string | null;
  /** Increment the venue requires, captured at init so sizing stays legal. */
  assetIncrement: string | null;
}

/**
 * How soon to retry a tick that could not be executed.
 *
 * A skipped buy must not cost a whole interval: on a weekly plan that would
 * silently drop the week. The schedule only advances when a buy actually goes
 * out, and everything else comes back on this shorter cadence. It is also the
 * strategy's default interval, so a step that returns no `nextRunAt` retries at
 * the same rate.
 */
const RETRY_MS = 60_000;

export const dca: Strategy = {
  name: 'dca',
  description:
    'Buy a fixed amount on a fixed interval for a set number of occurrences, averaging the entry across time instead of timing it.',
  defaultIntervalMs: RETRY_MS,

  async init(params, ctx): Promise<{ state: Record<string, unknown>; symbol: string }> {
    const symbol = requireString(params, 'symbol').toUpperCase();
    const side = requireEnum(params, 'side', ['buy', 'sell'] as const);

    // Exactly one sizing unit: accepting both invites a silent disagreement
    // about how much a single occurrence is actually worth.
    const hasQuote = isPresent(params, 'quote_amount_per_buy');
    const hasAsset = isPresent(params, 'asset_quantity_per_buy');
    if (hasQuote === hasAsset) {
      throw new Error(
        'Specify exactly one of "quote_amount_per_buy" (e.g. "200" in quote currency) or ' +
          '"asset_quantity_per_buy" (e.g. "0.005" in the base asset), not both and not neither.',
      );
    }
    const quoteAmountPerBuy = hasQuote ? requireDecimal(params, 'quote_amount_per_buy') : null;
    const assetQuantityPerBuy = hasAsset ? requireDecimal(params, 'asset_quantity_per_buy') : null;

    // Quarter-hour floor: anything faster is not dollar-cost averaging, it is a
    // TWAP, and `twap` already sizes and schedules that case properly.
    const intervalHours = requireNumber(params, 'interval_hours', { min: 0.25, max: 24 * 365 });
    const occurrences = requireInt(params, 'occurrences', { min: 1, max: 1000 });
    const maxPrice = optionalDecimal(params, 'max_price');

    const pair = await ctx.executor.tradingPair(symbol);
    const assetIncrement = pair?.asset_increment ? String(pair.asset_increment) : null;
    const minOrderSize = Number(pair?.min_order_size ?? pair?.min_order_amount ?? 0);
    const asset = symbol.split('-')[0];

    if (assetQuantityPerBuy !== null) {
      if (minOrderSize > 0 && Number(assetQuantityPerBuy) < minOrderSize) {
        throw new Error(
          `asset_quantity_per_buy ${assetQuantityPerBuy} ${asset} is below the venue minimum of ` +
            `${minOrderSize}. Increase it, or lengthen interval_hours and buy less often.`,
        );
      }
    } else if (minOrderSize > 0) {
      // A quote amount only becomes a size at the current price, so the check
      // needs one. A plan whose every buy would be rejected as too small should
      // never reach the supervisor, and at today's price that is knowable here.
      // No quote means no check: an outage at init must not block a plan whose
      // buys are individually validated by the executor anyway.
      const price = await ctx.price(symbol, side);
      if (price !== null && price > 0) {
        const quantity = Number(
          roundToIncrement(Number(quoteAmountPerBuy) / price, assetIncrement ?? undefined),
        );
        if (quantity < minOrderSize) {
          throw new Error(
            `quote_amount_per_buy ${quoteAmountPerBuy} buys ${quantity} ${asset} at the current price ` +
              `of ${price}, below the venue minimum of ${minOrderSize}. Raise quote_amount_per_buy to ` +
              `at least ${(minOrderSize * price).toFixed(2)}.`,
          );
        }
      }
    }

    const state: DcaState = {
      side,
      quoteAmountPerBuy,
      assetQuantityPerBuy,
      intervalMs: Math.round(intervalHours * 60 * 60 * 1000),
      occurrences,
      occurrencesDone: 0,
      maxPrice,
      assetIncrement,
    };

    return { state: state as unknown as Record<string, unknown>, symbol };
  },

  async advance(job: Job, ctx: StrategyContext): Promise<StrategyStep> {
    const state = job.state as unknown as DcaState;

    if (state.occurrencesDone >= state.occurrences) {
      return {
        state: state as unknown as Record<string, unknown>,
        actions: [],
        done: { status: 'completed' },
      };
    }

    // A quote-denominated buy needs a price to become a limit order, and the
    // ceiling needs one to be enforced. Only a bare asset-sized buy with no
    // ceiling can execute without a quote, which is why the price is fetched
    // once here and each branch decides for itself whether it can proceed.
    const needsPrice = state.quoteAmountPerBuy !== null || state.maxPrice !== null;
    const price = needsPrice ? await ctx.price(job.symbol, state.side) : null;

    if (needsPrice && (price === null || price <= 0)) {
      // An occurrence that could not be priced is not an occurrence that was
      // bought. Do not consume one: retry shortly instead.
      return {
        state: state as unknown as Record<string, unknown>,
        actions: [{ type: 'log', kind: 'dca_no_price', detail: { symbol: job.symbol, side: state.side } }],
      };
    }

    if (state.maxPrice !== null && price !== null) {
      // Same geometry as the TWAP price guard: a buy skips above the ceiling and
      // a sell skips below it, so one parameter reads correctly on both sides.
      const limit = Number(state.maxPrice);
      const wouldViolate = state.side === 'buy' ? price > limit : price < limit;
      if (wouldViolate) {
        // Skipping does not consume an occurrence. The plan still owes the
        // caller the full count; it simply declines to pay this price for it.
        return {
          state: state as unknown as Record<string, unknown>,
          actions: [
            { type: 'log', kind: 'dca_buy_skipped', detail: { price, maxPrice: limit, side: state.side } },
          ],
        };
      }
    }

    const next: DcaState = { ...state, occurrencesDone: state.occurrencesDone + 1 };
    const isLast = next.occurrencesDone >= next.occurrences;
    const step = {
      state: next as unknown as Record<string, unknown>,
      nextRunAt: ctx.now + state.intervalMs,
      ...(isLast ? { done: { status: 'completed' as const } } : {}),
    };

    if (state.quoteAmountPerBuy !== null && price !== null) {
      // Robinhood accepts `quote_amount` on a limit order but not on a market
      // one, so a dollar-denominated buy is a limit at the current execution
      // price: marketable enough to fill on schedule, and still bounded, which
      // a market order never is.
      return {
        ...step,
        actions: [
          {
            type: 'submit',
            order: {
              symbol: job.symbol,
              side: state.side,
              type: 'limit',
              quoteAmount: state.quoteAmountPerBuy,
              limitPrice: formatPrice(price),
            },
          },
        ],
      };
    }

    const quantity = roundToIncrement(Number(state.assetQuantityPerBuy), state.assetIncrement ?? undefined);
    if (Number(quantity) <= 0) {
      return {
        state: state as unknown as Record<string, unknown>,
        actions: [
          {
            type: 'log',
            kind: 'dca_rounded_to_zero',
            detail: { assetQuantityPerBuy: state.assetQuantityPerBuy },
          },
        ],
        done: {
          status: 'failed',
          reason: 'asset_quantity_per_buy rounds below the venue increment, so no buy could be placed.',
        },
      };
    }

    // An asset-denominated buy is a market order: the size is already fixed, so
    // the only thing left to decide is whether it executes, and on a schedule it
    // must.
    return {
      ...step,
      actions: [
        {
          type: 'submit',
          order: { symbol: job.symbol, side: state.side, type: 'market', assetQuantity: quantity },
        },
      ],
    };
  },
};

/** Trim float noise from a derived price, which the venue rejects as precision. */
function formatPrice(value: number): string {
  return String(Number(value.toFixed(8)));
}
