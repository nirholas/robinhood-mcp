/**
 * Accumulate: build a position out of dips, not out of the calendar.
 *
 * DCA buys on a schedule and accepts whatever price the schedule lands on. This
 * buys the same total, but only when the market is weak relative to where it
 * has recently been: it keeps a bounded window of sampled prices in persisted
 * job state, and each advance it buys a slice only if the current price sits a
 * set percentage below that window's average and under an absolute ceiling.
 * When the market is strong it buys nothing and simply waits, which is the
 * whole point of running this instead of a schedule.
 *
 * Two guards make patience safe rather than open-ended. `max_price` is an
 * absolute refusal that no averaging can talk the job out of, and
 * `max_duration_minutes` ends the job with a partial fill rather than leaving a
 * standing bid on the account forever. A run that ends short is reported as
 * short: the strategy declines to chase the remainder at prices it was told not
 * to pay.
 */

import type { Job, Strategy, StrategyContext, StrategyStep } from '../job.js';
import { roundToIncrement } from '../../shared/executor.js';
import { requireDecimal, requireInt, requireNumber, requireString } from './params.js';

interface AccumulateState {
  /** Total size to acquire, in the base asset, as a decimal string. */
  targetQuantity: string;
  /** Absolute ceiling. No slice is ever bought above this, whatever the average. */
  maxPrice: string;
  /** How far under the rolling average a price has to be to count as weakness. */
  buyBelowPct: number;
  /** Size of one opportunistic slice, already rounded to the venue increment. */
  sliceQuantity: string;
  lookbackTicks: number;
  /** Epoch ms after which the job stops, filled or not. */
  deadline: number;
  /**
   * The rolling price window, oldest first, never longer than `lookbackTicks`.
   * Bounded on every push, because this is persisted state and an unbounded
   * window would grow the job row on every tick for as long as it runs.
   */
  prices: number[];
  /** Size bought so far, credited as each slice is submitted. */
  acquiredQuantity: string;
  slicesBought: number;
  /** Venue constraints captured at init so sizing stays legal for the whole run. */
  assetIncrement: string | null;
  minOrderSize: number;
}

export const accumulate: Strategy = {
  name: 'accumulate',
  description:
    'Buy toward a target size only on weakness, taking a slice whenever price trades a set percentage below its recent average and under a hard ceiling.',
  defaultIntervalMs: 60_000,

  async init(params, ctx): Promise<{ state: Record<string, unknown>; symbol: string }> {
    const symbol = requireString(params, 'symbol').toUpperCase();
    const targetQuantity = requireDecimal(params, 'target_quantity');
    const maxPrice = requireDecimal(params, 'max_price');
    const buyBelowPct = requireNumber(params, 'buy_below_pct', { min: 0.01, max: 99 });
    const sliceRaw = requireDecimal(params, 'slice_quantity');
    const lookbackTicks = requireInt(params, 'lookback_ticks', { min: 3, max: 500 });
    const maxDurationMinutes = requireInt(params, 'max_duration_minutes', { min: 1, max: 60 * 24 * 30 });

    const pair = await ctx.executor.tradingPair(symbol);
    const assetIncrement = pair?.asset_increment ? String(pair.asset_increment) : null;
    const minOrderSize = Number(pair?.min_order_size ?? pair?.min_order_amount ?? 0);
    const asset = symbol.split('-')[0] ?? symbol;

    const sliceQuantity = roundToIncrement(Number(sliceRaw), assetIncrement ?? undefined);
    if (Number(sliceQuantity) <= 0) {
      throw new Error(
        `slice_quantity ${sliceRaw} rounds to zero at the venue increment of ` +
          `${assetIncrement ?? 'the base asset'}. Increase slice_quantity.`,
      );
    }
    if (minOrderSize > 0 && Number(sliceQuantity) < minOrderSize) {
      throw new Error(
        `slice_quantity ${sliceQuantity} ${asset} is below the venue minimum of ${minOrderSize}. Increase ` +
          'slice_quantity: a slice the venue rejects can never accumulate anything.',
      );
    }

    // A slice as large as the target is a single conditional buy, and every dip
    // after the first one would be ignored. That is a different order type, and
    // the caller should know they asked for it.
    if (Number(sliceQuantity) > Number(targetQuantity)) {
      throw new Error(
        `slice_quantity ${sliceQuantity} exceeds target_quantity ${targetQuantity}, so the first dip would ` +
          'buy the whole position. Lower slice_quantity, or raise target_quantity.',
      );
    }

    const state: AccumulateState = {
      targetQuantity,
      maxPrice,
      buyBelowPct,
      sliceQuantity,
      lookbackTicks,
      deadline: ctx.now + maxDurationMinutes * 60_000,
      prices: [],
      acquiredQuantity: '0',
      slicesBought: 0,
      assetIncrement,
      minOrderSize,
    };

    return { state: state as unknown as Record<string, unknown>, symbol };
  },

  async advance(job: Job, ctx: StrategyContext): Promise<StrategyStep> {
    const state = job.state as unknown as AccumulateState;

    const remaining = Number(state.targetQuantity) - Number(state.acquiredQuantity);

    if (remaining <= 0) {
      return {
        state: state as unknown as Record<string, unknown>,
        actions: [
          {
            type: 'log',
            kind: 'accumulate_target_reached',
            detail: { acquiredQuantity: state.acquiredQuantity, slicesBought: state.slicesBought },
          },
        ],
        done: { status: 'completed' },
      };
    }

    // The deadline ends the job whether or not the target was met. An
    // accumulation with no end is a standing bid nobody is watching, and the
    // partial result is the honest one to report.
    if (ctx.now >= state.deadline) {
      return {
        state: state as unknown as Record<string, unknown>,
        actions: [
          {
            type: 'log',
            kind: 'accumulate_expired',
            detail: {
              acquiredQuantity: state.acquiredQuantity,
              targetQuantity: state.targetQuantity,
              slicesBought: state.slicesBought,
            },
          },
        ],
        done: {
          status: 'completed',
          reason:
            `max_duration_minutes elapsed with ${state.acquiredQuantity} of ${state.targetQuantity} ` +
            `accumulated across ${state.slicesBought} slice(s). The remainder was not chased: price never ` +
            `traded ${state.buyBelowPct}% below its recent average while under max_price ${state.maxPrice}.`,
        },
      };
    }

    const price = await ctx.price(job.symbol, 'buy');
    if (price === null) {
      // Weakness is defined against sampled history, so a guessed sample would
      // move the very average the next buy decision is measured against.
      return {
        state: state as unknown as Record<string, unknown>,
        actions: [{ type: 'log', kind: 'accumulate_no_price', detail: { symbol: job.symbol } }],
      };
    }

    const window = state.prices;
    const sampled = { ...state, prices: pushWindow(window, price, state.lookbackTicks) };

    // The average is taken from the window as it stood BEFORE this sample: a
    // price compared against an average it is already part of is compared
    // partly against itself, which shrinks every dip it is meant to detect.
    if (window.length < state.lookbackTicks) {
      return {
        state: sampled as unknown as Record<string, unknown>,
        actions: [
          {
            type: 'log',
            kind: 'accumulate_warmup',
            detail: { samples: window.length + 1, lookbackTicks: state.lookbackTicks },
          },
        ],
      };
    }

    // The absolute ceiling is checked before the relative one. A market can be
    // far below its own recent average and still be above the highest price the
    // caller was ever willing to pay.
    if (price > Number(state.maxPrice)) {
      return {
        state: sampled as unknown as Record<string, unknown>,
        actions: [
          {
            type: 'log',
            kind: 'accumulate_above_max_price',
            detail: { price, maxPrice: state.maxPrice },
          },
        ],
      };
    }

    const average = mean(window);
    const trigger = average * (1 - state.buyBelowPct / 100);
    if (price > trigger) {
      return {
        state: sampled as unknown as Record<string, unknown>,
        actions: [
          {
            type: 'log',
            kind: 'accumulate_not_weak_enough',
            detail: { price, average: trim(average), trigger: trim(trigger), buyBelowPct: state.buyBelowPct },
          },
        ],
      };
    }

    // Never overshoot the target on the final slice: the caller asked for a
    // size, not for a size rounded up by whatever the last slice happened to be.
    const rawSlice = Math.min(Number(state.sliceQuantity), remaining);
    const sliceQuantity = roundToIncrement(rawSlice, state.assetIncrement ?? undefined);

    if (Number(sliceQuantity) <= 0) {
      return {
        state: sampled as unknown as Record<string, unknown>,
        actions: [
          {
            type: 'log',
            kind: 'accumulate_remainder_rounds_to_zero',
            detail: { remaining, acquiredQuantity: state.acquiredQuantity },
          },
        ],
        done: {
          status: 'completed',
          reason:
            `Accumulated ${state.acquiredQuantity} of ${state.targetQuantity}. The remaining ${remaining} ` +
            'rounds below the venue increment and cannot be bought as a further slice.',
        },
      };
    }

    // A real remainder that is still too small to trade. Stop deliberately
    // rather than submitting an order the venue is certain to reject.
    if (state.minOrderSize > 0 && Number(sliceQuantity) < state.minOrderSize) {
      return {
        state: sampled as unknown as Record<string, unknown>,
        actions: [
          {
            type: 'log',
            kind: 'accumulate_remainder_below_minimum',
            detail: { remainder: sliceQuantity, minOrderSize: state.minOrderSize },
          },
        ],
        done: {
          status: 'completed',
          reason:
            `Accumulated ${state.acquiredQuantity} of ${state.targetQuantity}. The remaining ${sliceQuantity} ` +
            `is below the venue minimum of ${state.minOrderSize} and cannot be bought as a further slice.`,
        },
      };
    }

    const acquiredQuantity = trim(Number(state.acquiredQuantity) + Number(sliceQuantity));
    const filled = Number(acquiredQuantity) >= Number(state.targetQuantity);

    // A limit at the current price, not a market order: the dip being bought is
    // the whole reason for the trade, so the fill has to happen at the price the
    // decision was made on, not at whatever the book moves to next.
    return {
      state: {
        ...sampled,
        acquiredQuantity,
        slicesBought: state.slicesBought + 1,
      } as unknown as Record<string, unknown>,
      actions: [
        {
          type: 'log',
          kind: 'accumulate_dip_bought',
          detail: {
            price,
            average: trim(average),
            trigger: trim(trigger),
            quantity: sliceQuantity,
            acquiredQuantity,
          },
        },
        {
          type: 'submit',
          order: {
            symbol: job.symbol,
            side: 'buy',
            type: 'limit',
            assetQuantity: sliceQuantity,
            limitPrice: formatPrice(price),
            timeInForce: 'gtc',
          },
        },
      ],
      ...(filled ? { done: { status: 'completed' as const } } : {}),
    };
  },
};

/**
 * Append one sample, dropping the oldest once the window is full.
 *
 * The window is persisted state, so its length is a storage decision as much as
 * a signal one: unbounded growth would inflate the job row on every tick.
 */
function pushWindow(prices: number[], price: number, limit: number): number[] {
  const next = [...prices, price];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Trim float noise from an accumulated quantity or a derived statistic. */
function trim(value: number): string {
  return String(Number(value.toFixed(8)));
}

/** Trim float noise from a derived price, which the venue rejects as precision. */
function formatPrice(value: number): string {
  return String(Number(value.toFixed(8)));
}
