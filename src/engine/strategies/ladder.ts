/**
 * Ladder: scale into or out of a position across a price range.
 *
 * A single limit order is a bet on one price. A ladder is a bet on a range:
 * scale into a buy as the market falls, or out of a sell as it rises, and let
 * the average be the range instead of the guess. Robinhood has no scaled or
 * multi-level order type, so the package synthesizes one: every rung is priced,
 * sized and given its client order id at init, and the supervisor places them a
 * few per tick.
 *
 * Two decisions are load-bearing. The rungs are computed once, at init, because
 * a ladder whose geometry drifted between advances would place orders the
 * caller never approved. And they go out in small batches rather than one burst,
 * because a policy rejection on the third rung must not take the other
 * forty-seven with it in the same tick.
 */

import { randomUUID } from 'node:crypto';
import type { Job, Strategy, StrategyContext, StrategyStep } from '../job.js';
import { roundToIncrement } from '../../shared/executor.js';
import { isPresent, requireDecimal, requireEnum, requireInt, requireString } from './params.js';

type Distribution = 'even' | 'front' | 'back';

const DISTRIBUTIONS = ['even', 'front', 'back'] as const;

/**
 * One resting order the ladder intends to place.
 *
 * `clientOrderId` is minted at init and never regenerated, so a crash between
 * submitting a rung and recording it resubmits the id Robinhood already knows
 * and is rejected as a duplicate rather than doubling the level.
 */
interface Rung {
  price: string;
  quantity: string;
  clientOrderId: string;
}

interface LadderState {
  side: 'buy' | 'sell';
  /** Total size across all levels, in the base asset, as a decimal string. */
  totalQuantity: string;
  levels: number;
  /** Price of the level nearest the market. */
  startPrice: string;
  /** Price of the level furthest from the market. */
  endPrice: string;
  distribution: Distribution;
  /** How long each rung rests. `gtc` is the ladder's whole premise; `day` expires. */
  timeInForce: 'gtc' | 'day';
  rungs: Rung[];
  /** How many rungs have been submitted so far. */
  placed: number;
  /** 1-based inclusive range submitted on the previous advance, for error text. */
  lastBatch: { from: number; to: number } | null;
}

/**
 * Rungs submitted per advance.
 *
 * Small enough that a rejection is observed after a handful of orders rather
 * than after the whole ladder, large enough that fifty levels are all working
 * within a couple of minutes.
 */
const RUNGS_PER_ADVANCE = 3;

export const ladder: Strategy = {
  name: 'ladder',
  description:
    'Scale into or out of a position with resting limit orders spread across a price range, weighted toward either end of it.',
  defaultIntervalMs: 5_000,

  async init(params, ctx): Promise<{ state: Record<string, unknown>; symbol: string }> {
    const symbol = requireString(params, 'symbol').toUpperCase();
    const side = requireEnum(params, 'side', ['buy', 'sell'] as const);
    const totalQuantity = requireDecimal(params, 'total_quantity');
    const levels = requireInt(params, 'levels', { min: 2, max: 50 });
    const startPrice = requireDecimal(params, 'start_price');
    const endPrice = requireDecimal(params, 'end_price');

    // Absent distribution is the unweighted ladder: the case most callers mean,
    // and the only one that needs no explanation.
    const distribution: Distribution = isPresent(params, 'distribution')
      ? requireEnum(params, 'distribution', DISTRIBUTIONS)
      : 'even';

    // A ladder exists to wait, so resting until cancelled is the only default
    // that matches its purpose. `day` is offered for the caller who wants the
    // unfilled rungs to expire with the session rather than outlive their thesis.
    const timeInForce = isPresent(params, 'time_in_force')
      ? requireEnum(params, 'time_in_force', ['gtc', 'day'] as const)
      : 'gtc';

    const start = Number(startPrice);
    const end = Number(endPrice);
    if (start === end) {
      throw new Error(
        `start_price and end_price are both ${startPrice}, which is one price repeated ${levels} times ` +
          'rather than a ladder. Widen the range, or place a single limit order instead.',
      );
    }

    // A ladder runs away from the market: a buy scales down into weakness, a
    // sell scales up into strength. Reversing that turns a patient ladder into a
    // chase, so it is rejected by geometry rather than trusted to the caller.
    const descends = start > end;
    if (side === 'buy' && !descends) {
      throw new Error(
        `A buy ladder must descend: start_price ${startPrice} should be above end_price ${endPrice}, ` +
          'so each level buys lower than the last. The two values are probably swapped.',
      );
    }
    if (side === 'sell' && descends) {
      throw new Error(
        `A sell ladder must ascend: start_price ${startPrice} should be below end_price ${endPrice}, ` +
          'so each level sells higher than the last. The two values are probably swapped.',
      );
    }

    const pair = await ctx.executor.tradingPair(symbol);
    const assetIncrement = pair?.asset_increment ? String(pair.asset_increment) : null;
    const quoteIncrement = pair?.quote_increment ? String(pair.quote_increment) : null;
    const minOrderSize = Number(pair?.min_order_size ?? pair?.min_order_amount ?? 0);

    const rungs = buildRungs({
      totalQuantity,
      levels,
      startPrice,
      endPrice,
      distribution,
      assetIncrement,
      quoteIncrement,
    });

    // Reject the whole ladder now if a single rung is unplaceable. A ladder
    // missing its heaviest levels has a different average price than the one
    // that was asked for, and this is the last moment it is knowable for free.
    const asset = symbol.split('-')[0];
    for (const [index, rung] of rungs.entries()) {
      if (Number(rung.quantity) <= 0) {
        throw new Error(
          `Level ${index + 1} of ${levels} rounds to zero at the venue increment of ` +
            `${assetIncrement ?? 'the base asset'}. Use fewer levels, a larger total_quantity, or ` +
            'distribution "even".',
        );
      }
      if (minOrderSize > 0 && Number(rung.quantity) < minOrderSize) {
        throw new Error(
          `Level ${index + 1} of ${levels} would be ${rung.quantity} ${asset}, below the venue minimum ` +
            `of ${minOrderSize}. Use fewer levels, a larger total_quantity, or distribution "even".`,
        );
      }
    }

    // A ladder that starts through the market is marketable on every level:
    // it fills at the touch instead of resting, which is a market order in
    // expensive clothing. After placement those fills are already done, so the
    // check belongs here while there is still a caller to read it.
    const price = await ctx.price(symbol, side);
    if (price !== null) {
      const marketable = side === 'buy' ? start > price : start < price;
      if (marketable) {
        throw new Error(
          `start_price ${startPrice} is ${side === 'buy' ? 'above' : 'below'} the current price of ` +
            `${price}, so the ladder would fill at the touch instead of resting. Start it at or ` +
            `${side === 'buy' ? 'below' : 'above'} ${price}.`,
        );
      }
    }

    const state: LadderState = {
      side,
      totalQuantity,
      levels,
      startPrice,
      endPrice,
      distribution,
      timeInForce,
      rungs,
      placed: 0,
      lastBatch: null,
    };

    return { state: state as unknown as Record<string, unknown>, symbol };
  },

  async advance(job: Job, ctx: StrategyContext): Promise<StrategyStep> {
    const state = job.state as unknown as LadderState;

    // The supervisor records a rejected submit on the job and clears it on the
    // next advance, so this is the one moment the failure is readable. Stop
    // laddering, but never cancel the rungs already resting: they are live
    // working orders, and pulling them would undo the fills this exists to get.
    if (state.lastBatch !== null && job.lastError !== null) {
      const { from, to } = state.lastBatch;
      const resting = from - 1;
      return {
        state: { ...state, lastBatch: null } as unknown as Record<string, unknown>,
        actions: [{ type: 'log', kind: 'ladder_rung_rejected', detail: { from, to, error: job.lastError } }],
        done: {
          status: 'failed',
          reason:
            `Ladder level${to > from ? `s ${from}-${to}` : ` ${from}`} of ${state.levels} could not be ` +
            `placed: ${job.lastError}. ${resting} earlier level(s) are resting in the book and were left ` +
            'alone; cancel them manually if the ladder is no longer wanted.',
        },
      };
    }

    // Completion waits one advance past the final batch, so a rejection in that
    // batch is still read above instead of being buried by a finished job.
    if (state.placed >= state.levels) {
      return {
        state: { ...state, lastBatch: null } as unknown as Record<string, unknown>,
        actions: [
          {
            type: 'log',
            kind: 'ladder_placed',
            detail: {
              levels: state.levels,
              side: state.side,
              distribution: state.distribution,
              totalQuantity: state.totalQuantity,
            },
          },
        ],
        done: { status: 'completed' },
      };
    }

    const from = state.placed;
    const to = Math.min(state.levels, from + RUNGS_PER_ADVANCE);

    return {
      state: { ...state, placed: to, lastBatch: { from: from + 1, to } } as unknown as Record<string, unknown>,
      actions: state.rungs.slice(from, to).map((rung) => ({
        type: 'submit' as const,
        order: {
          symbol: job.symbol,
          side: state.side,
          type: 'limit' as const,
          assetQuantity: rung.quantity,
          limitPrice: rung.price,
          timeInForce: state.timeInForce,
          clientOrderId: rung.clientOrderId,
        },
      })),
      nextRunAt: ctx.now + ladder.defaultIntervalMs,
    };
  },
};

/**
 * Price and size every rung.
 *
 * Sizes are assigned cumulatively: each rung takes the rounded difference
 * between the running target and what has already been handed out, so rounding
 * losses on early rungs do not compound into a ladder that trades noticeably
 * less than `total_quantity`.
 */
function buildRungs(input: {
  totalQuantity: string;
  levels: number;
  startPrice: string;
  endPrice: string;
  distribution: Distribution;
  assetIncrement: string | null;
  quoteIncrement: string | null;
}): Rung[] {
  const { totalQuantity, levels, startPrice, endPrice, distribution, assetIncrement, quoteIncrement } = input;

  const start = Number(startPrice);
  const end = Number(endPrice);
  const total = Number(totalQuantity);
  const decimals = priceDecimals(startPrice, endPrice);

  const weights = rungWeights(levels, distribution);
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);

  // Size in whole increments rather than in decimals. Rounding to an increment
  // floors, and binary floats land a hair under a step boundary often enough to
  // matter: 1 - 0.66 is 0.33999999999999997, which floors away a whole increment.
  // On an even ladder that shows up as rungs that should be identical differing
  // in the last digit, and a total that quietly comes up short of the caller's.
  const increment = Number(assetIncrement);
  const sizeInSteps = Number.isFinite(increment) && increment > 0;
  const totalSteps = sizeInSteps ? Math.floor(total / increment + STEP_EPSILON) : 0;

  const rungs: Rung[] = [];
  let assignedSteps = 0;
  let assigned = 0;
  let weightSoFar = 0;

  for (let index = 0; index < levels; index++) {
    weightSoFar += weights[index] ?? 0;

    // Each rung takes the difference between the running cumulative target and
    // what has already been handed out, so rounding losses on early rungs do not
    // compound into a ladder that trades noticeably less than `total_quantity`.
    let quantity: string;
    if (sizeInSteps) {
      const cumulative = Math.floor((totalSteps * weightSoFar) / weightTotal + STEP_EPSILON);
      quantity = formatSteps(cumulative - assignedSteps, increment);
      assignedSteps = cumulative;
    } else {
      const target = (total * weightSoFar) / weightTotal;
      quantity = String(target - assigned);
      assigned += Number(quantity);
    }

    // Rungs are evenly spaced in price and weighted only in size. Bending both
    // at once would make `distribution` impossible to reason about.
    const raw = start + ((end - start) * index) / (levels - 1);

    // The two endpoints are used verbatim: rounding them would move the prices
    // the caller explicitly chose. Only interior rungs are snapped to the venue
    // increment, or to the precision of the bounds when it publishes none.
    const price =
      index === 0
        ? startPrice
        : index === levels - 1
          ? endPrice
          : quoteIncrement !== null
            ? roundToIncrement(raw, quoteIncrement)
            : raw.toFixed(decimals);

    rungs.push({ price, quantity, clientOrderId: randomUUID() });
  }

  return rungs;
}

/**
 * Slack allowed when converting a quantity into whole increments.
 *
 * Large enough to absorb the float error of a division that should have been
 * exact (`1 / 0.01` is 99.99999999999999, and flooring that loses a whole
 * increment), far smaller than one increment of any asset Robinhood lists, so
 * it can never round a rung up into size the caller did not ask for.
 */
const STEP_EPSILON = 1e-9;

/** Render a whole number of increments as the decimal string the venue wants. */
function formatSteps(steps: number, increment: number): string {
  return (steps * increment).toFixed(incrementDecimals(increment));
}

/** Decimal places in an increment, including ones JavaScript prints as 1e-8. */
function incrementDecimals(increment: number): number {
  const text = String(increment);
  if (text.includes('e-')) return Number(text.split('e-')[1] ?? 0);
  return text.includes('.') ? (text.split('.')[1]?.length ?? 0) : 0;
}

/**
 * Relative size of each rung.
 *
 * `front` puts the most size closest to `start_price`: the aggressive scale,
 * which commits most of the order at the first price and treats the rest of the
 * range as insurance. `back` is the patient mirror, holding size back for the
 * far end. Both are linear, so the ratio between the two ends is `levels`.
 */
function rungWeights(levels: number, distribution: Distribution): number[] {
  return Array.from({ length: levels }, (_unused, index) => {
    if (distribution === 'front') return levels - index;
    if (distribution === 'back') return index + 1;
    return 1;
  });
}

/**
 * Decimal places for an interior rung price, when the venue publishes no quote
 * increment. Derived from the caller's own bounds, so an interpolated price is
 * never more precise than the range that produced it, which is what keeps float
 * artifacts like 100.00000000000001 out of the order body.
 */
function priceDecimals(...prices: string[]): number {
  const supplied = prices.map((price) => price.split('.')[1]?.length ?? 0);
  return Math.min(8, Math.max(2, ...supplied));
}
