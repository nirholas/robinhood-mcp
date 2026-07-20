/**
 * TWAP: slice one large order into evenly spaced smaller ones.
 *
 * Buying $5,000 of an asset in a single market order pays the whole spread and
 * whatever depth sits above it. Spreading the same size over an hour averages
 * the entry and leaves less signal in the book. Robinhood has no native TWAP,
 * so the package synthesizes one: the job persists the schedule, and the
 * supervisor places one slice per due tick.
 */

import type { Job, Strategy, StrategyContext, StrategyStep } from '../job.js';
import { roundToIncrement } from '../../shared/executor.js';
import { requireDecimal, requireEnum, requireInt, requireString } from './params.js';

interface TwapState {
  side: 'buy' | 'sell';
  /** Total size in the base asset, as a decimal string. */
  totalQuantity: string;
  slices: number;
  slicesDone: number;
  intervalMs: number;
  /** Refuse to buy above / sell below this price. Null disables. */
  limitPrice: string | null;
  filledQuantity: string;
  /** Increment the venue requires, captured at init so sizing stays legal. */
  assetIncrement: string | null;
}

export const twap: Strategy = {
  name: 'twap',
  description:
    'Split an order into evenly spaced slices over a duration, to average the entry price instead of paying one spread.',
  defaultIntervalMs: 60_000,

  async init(params, ctx): Promise<{ state: Record<string, unknown>; symbol: string }> {
    const symbol = requireString(params, 'symbol').toUpperCase();
    const side = requireEnum(params, 'side', ['buy', 'sell'] as const);
    const totalQuantity = requireDecimal(params, 'total_quantity');
    const slices = requireInt(params, 'slices', { min: 2, max: 500 });
    const durationMs = requireInt(params, 'duration_minutes', { min: 1, max: 60 * 24 * 7 }) * 60_000;

    const limitPriceRaw = params.limit_price;
    const limitPrice = limitPriceRaw === undefined || limitPriceRaw === null
      ? null
      : String(limitPriceRaw);

    // Reject a schedule whose slices are below the venue minimum now, rather
    // than discovering it slice by slice at execution time.
    const pair = await ctx.executor.tradingPair(symbol);
    const assetIncrement = pair?.asset_increment ? String(pair.asset_increment) : null;
    const minOrderSize = Number(pair?.min_order_size ?? pair?.min_order_amount ?? 0);

    const perSlice = Number(totalQuantity) / slices;
    if (!Number.isFinite(perSlice) || perSlice <= 0) {
      throw new Error('total_quantity divided by slices is not a usable size.');
    }
    if (minOrderSize > 0 && perSlice < minOrderSize) {
      throw new Error(
        `Each slice would be ${perSlice} ${symbol.split('-')[0]}, below the venue minimum of ` +
          `${minOrderSize}. Use fewer slices or a larger total_quantity.`,
      );
    }

    const state: TwapState = {
      side,
      totalQuantity,
      slices,
      slicesDone: 0,
      intervalMs: Math.max(1_000, Math.floor(durationMs / slices)),
      limitPrice,
      filledQuantity: '0',
      assetIncrement,
    };

    return { state: state as unknown as Record<string, unknown>, symbol };
  },

  async advance(job: Job, ctx: StrategyContext): Promise<StrategyStep> {
    const state = job.state as unknown as TwapState;

    if (state.slicesDone >= state.slices) {
      return {
        state: state as unknown as Record<string, unknown>,
        actions: [],
        done: { status: 'completed' },
      };
    }

    // Size the remainder across the remaining slices, so rounding losses on
    // earlier slices do not silently shrink the total.
    const remaining = Number(state.totalQuantity) - Number(state.filledQuantity);
    const slicesLeft = state.slices - state.slicesDone;
    const rawSlice = remaining / slicesLeft;
    const sliceQuantity = roundToIncrement(rawSlice, state.assetIncrement ?? undefined);

    if (Number(sliceQuantity) <= 0) {
      return {
        state: state as unknown as Record<string, unknown>,
        actions: [{ type: 'log', kind: 'twap_rounded_to_zero', detail: { rawSlice } }],
        done: { status: 'completed', reason: 'Remaining size rounds below the venue increment.' },
      };
    }

    // A limit price makes the slice a protective limit order; without one it is
    // a market slice, which is the point of a TWAP but has no price guard.
    if (state.limitPrice !== null) {
      const price = await ctx.price(job.symbol, state.side);
      if (price !== null) {
        const limit = Number(state.limitPrice);
        const wouldViolate = state.side === 'buy' ? price > limit : price < limit;
        if (wouldViolate) {
          // Skip, do not consume a slice: the schedule waits for a better price.
          return {
            state: state as unknown as Record<string, unknown>,
            actions: [
              {
                type: 'log',
                kind: 'twap_slice_skipped',
                detail: { price, limit, side: state.side },
              },
            ],
            nextRunAt: ctx.now + state.intervalMs,
          };
        }
      }
    }

    const next: TwapState = {
      ...state,
      slicesDone: state.slicesDone + 1,
      filledQuantity: String(Number(state.filledQuantity) + Number(sliceQuantity)),
    };

    const isLast = next.slicesDone >= next.slices;

    return {
      state: next as unknown as Record<string, unknown>,
      actions: [
        {
          type: 'submit',
          order: {
            symbol: job.symbol,
            side: state.side,
            type: state.limitPrice === null ? 'market' : 'limit',
            assetQuantity: sliceQuantity,
            ...(state.limitPrice === null ? {} : { limitPrice: state.limitPrice }),
          },
        },
      ],
      nextRunAt: ctx.now + state.intervalMs,
      ...(isLast ? { done: { status: 'completed' as const } } : {}),
    };
  },
};
