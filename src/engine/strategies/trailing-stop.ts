/**
 * Trailing stop: a stop price that follows the market in your favour and never
 * moves back.
 *
 * A fixed `stop_loss` gives up everything the position gains after it is
 * placed. A trailing stop keeps the same downside distance while the trade
 * runs, so a position that doubles protects the double rather than the entry.
 * Robinhood has no trailing order type, so the package synthesizes one: the
 * watermark lives in persisted job state and the supervisor re-evaluates it
 * every tick, which is why the trail survives a restart instead of dying with
 * the tool call that created it.
 */

import type { Job, Strategy, StrategyContext, StrategyStep } from '../job.js';
import { roundToIncrement } from '../../shared/executor.js';
import {
  isPresent,
  optionalDecimal,
  requireDecimal,
  requireEnum,
  requireNumber,
  requireString,
} from './params.js';

interface TrailingStopState {
  /** Side of the protective order. `sell` trails a long, `buy` trails a short. */
  side: 'buy' | 'sell';
  /** Full size to exit with, in the base asset, as a decimal string. */
  quantity: string;
  /** Trail distance as a percentage of the watermark. Null when using an amount. */
  trailPercent: number | null;
  /** Trail distance in quote currency. Null when using a percentage. */
  trailAmount: string | null;
  /** Do not arm the trail until price first reaches this. Null arms immediately. */
  activationPrice: string | null;
  activated: boolean;
  /**
   * Best price seen since the trail armed: the high for a sell, the low for a
   * buy. Null until the first usable quote arrives.
   */
  watermark: string | null;
  /** Increment the venue requires, captured at init so sizing stays legal. */
  assetIncrement: string | null;
}

export const trailingStop: Strategy = {
  name: 'trailing_stop',
  description:
    'Follow the market with a stop that ratchets in your favour and never retreats, exiting the full size when price retraces past the trail.',
  defaultIntervalMs: 15_000,

  async init(params, ctx): Promise<{ state: Record<string, unknown>; symbol: string }> {
    const symbol = requireString(params, 'symbol').toUpperCase();
    const side = requireEnum(params, 'side', ['buy', 'sell'] as const);
    const quantity = requireDecimal(params, 'quantity');

    // Exactly one distance: accepting both invites a silent disagreement about
    // which one is actually protecting the position.
    const hasPercent = isPresent(params, 'trail_percent');
    const hasAmount = isPresent(params, 'trail_amount');
    if (hasPercent === hasAmount) {
      throw new Error(
        'Specify exactly one of "trail_percent" (e.g. 5 for 5%) or "trail_amount" ' +
          '(e.g. "250" in quote currency), not both and not neither.',
      );
    }
    const trailPercent = hasPercent ? requireNumber(params, 'trail_percent', { min: 0.01, max: 99 }) : null;
    const trailAmount = hasAmount ? requireDecimal(params, 'trail_amount') : null;

    const activationPrice = optionalDecimal(params, 'activation_price');

    // Reject a size the venue will refuse now, rather than at the one moment
    // the stop is supposed to fire.
    const pair = await ctx.executor.tradingPair(symbol);
    const assetIncrement = pair?.asset_increment ? String(pair.asset_increment) : null;
    const minOrderSize = Number(pair?.min_order_size ?? pair?.min_order_amount ?? 0);
    if (minOrderSize > 0 && Number(quantity) < minOrderSize) {
      throw new Error(
        `quantity ${quantity} ${symbol.split('-')[0]} is below the venue minimum of ` +
          `${minOrderSize}. Increase quantity or trail a larger position.`,
      );
    }

    const state: TrailingStopState = {
      side,
      quantity,
      trailPercent,
      trailAmount,
      activationPrice,
      activated: activationPrice === null,
      watermark: null,
      assetIncrement,
    };

    return { state: state as unknown as Record<string, unknown>, symbol };
  },

  async advance(job: Job, ctx: StrategyContext): Promise<StrategyStep> {
    const state = job.state as unknown as TrailingStopState;
    const price = await ctx.price(job.symbol, state.side);

    // A missing quote is not a retracement. Triggering on absent data would
    // dump the position on an outage, which is the opposite of protection.
    if (price === null) {
      return {
        state: state as unknown as Record<string, unknown>,
        actions: [
          { type: 'log', kind: 'trailing_stop_no_price', detail: { symbol: job.symbol, side: state.side } },
        ],
      };
    }

    if (!state.activated) {
      const activation = Number(state.activationPrice);
      const reached = state.side === 'sell' ? price >= activation : price <= activation;
      if (!reached) {
        return {
          state: state as unknown as Record<string, unknown>,
          actions: [
            { type: 'log', kind: 'trailing_stop_dormant', detail: { price, activation, side: state.side } },
          ],
        };
      }
      // Arm from the activation tick, so the trail measures from where the
      // position actually started being protected.
      return {
        state: { ...state, activated: true, watermark: String(price) } as unknown as Record<string, unknown>,
        actions: [{ type: 'log', kind: 'trailing_stop_activated', detail: { price, activation } }],
      };
    }

    if (state.watermark === null) {
      return {
        state: { ...state, watermark: String(price) } as unknown as Record<string, unknown>,
        actions: [{ type: 'log', kind: 'trailing_stop_armed', detail: { watermark: price } }],
      };
    }

    const previous = Number(state.watermark);
    const improved = state.side === 'sell' ? price > previous : price < previous;
    const watermark = improved ? price : previous;
    const stopPrice = trailStop(watermark, state);
    const retraced = state.side === 'sell' ? price <= stopPrice : price >= stopPrice;

    if (!retraced) {
      return {
        state: { ...state, watermark: String(watermark) } as unknown as Record<string, unknown>,
        actions: improved
          ? [{ type: 'log', kind: 'trailing_stop_watermark', detail: { watermark, stopPrice } }]
          : [],
      };
    }

    const quantity = roundToIncrement(Number(state.quantity), state.assetIncrement ?? undefined);
    if (Number(quantity) <= 0) {
      return {
        state: { ...state, watermark: String(watermark) } as unknown as Record<string, unknown>,
        actions: [{ type: 'log', kind: 'trailing_stop_rounded_to_zero', detail: { quantity: state.quantity } }],
        done: { status: 'failed', reason: 'Quantity rounds below the venue increment, so no exit could be placed.' },
      };
    }

    // Market, not limit: the trail already chose the price. A limit exit here
    // could sit unfilled through exactly the move it exists to escape.
    return {
      state: { ...state, watermark: String(watermark) } as unknown as Record<string, unknown>,
      actions: [
        { type: 'log', kind: 'trailing_stop_triggered', detail: { price, watermark, stopPrice } },
        {
          type: 'submit',
          order: { symbol: job.symbol, side: state.side, type: 'market', assetQuantity: quantity },
        },
      ],
      done: { status: 'completed' },
    };
  },
};

/** The stop implied by a watermark, on whichever side of it protects the position. */
function trailStop(watermark: number, state: TrailingStopState): number {
  const distance =
    state.trailPercent !== null ? watermark * (state.trailPercent / 100) : Number(state.trailAmount);
  return state.side === 'sell' ? watermark - distance : watermark + distance;
}
