/**
 * Mean reversion: fade the extreme, exit at the mean.
 *
 * Momentum trades the break; this trades the snap back. It keeps a bounded
 * window of sampled prices in persisted job state, measures how far the current
 * price sits from that window's mean in standard deviations, and takes the
 * other side once the deviation is large enough to be worth fading. The exit is
 * the same measurement closer to zero, so a trade ends when the reason for
 * taking it has gone rather than at a level picked in advance.
 *
 * The honest part is the short side. Robinhood crypto is spot: there is no
 * borrow and no short position to open. So `short_only` and `both` do not open
 * shorts. They SELL AN EXISTING HOLDING into an extreme high and buy it back
 * when price reverts, which is the same trade expressed on inventory the
 * account already owns. That is a real strategy, not a substitute for one, but
 * it needs the coins to exist: `init` refuses a short-capable job the account
 * cannot cover, and every short entry re-checks the holding before it goes out,
 * because the balance can move between starting the job and taking the trade.
 */

import type { Job, Strategy, StrategyContext, StrategyStep } from '../job.js';
import { roundToIncrement } from '../../shared/executor.js';
import { requireDecimal, requireEnum, requireInt, requireNumber, requireString } from './params.js';

type SideMode = 'long_only' | 'short_only' | 'both';
type Phase = 'watching' | 'in_position' | 'exited';
/** `long` bought a low deviation. `short` sold a holding into a high one. */
type Direction = 'long' | 'short';

const SIDE_MODES = ['long_only', 'short_only', 'both'] as const;

interface MeanReversionState {
  /** Size of the entry, in the base asset, already rounded to the increment. */
  quantity: string;
  lookbackTicks: number;
  entryZ: number;
  exitZ: number;
  sideMode: SideMode;
  /** Epoch ms after which the job closes whatever it holds and stops. */
  deadline: number;
  phase: Phase;
  /**
   * The rolling price window, oldest first, never longer than `lookbackTicks`.
   * Bounded on every push: this is persisted state, and an unbounded window
   * would grow the job row for as long as the job runs.
   */
  prices: number[];
  direction: Direction | null;
  entryPrice: string | null;
  /** Deviation at entry, kept so the event log explains why the trade was taken. */
  entryZScore: number | null;
  /** Advances spent in position, used to read an entry rejection exactly once. */
  ticksInPosition: number;
  /** Base asset code, so the short-side holding check needs no re-parsing. */
  asset: string;
}

export const meanReversion: Strategy = {
  name: 'mean_reversion',
  description:
    'Fade a price that has stretched a set number of standard deviations from its recent mean, and close the trade when it reverts toward that mean.',
  defaultIntervalMs: 30_000,

  async init(params, ctx): Promise<{ state: Record<string, unknown>; symbol: string }> {
    const symbol = requireString(params, 'symbol').toUpperCase();
    const quantityRaw = requireDecimal(params, 'quantity');
    const lookbackTicks = requireInt(params, 'lookback_ticks', { min: 5, max: 500 });
    const entryZ = requireNumber(params, 'entry_z', { min: 0.1, max: 10 });
    const exitZ = requireNumber(params, 'exit_z', { min: 0, max: 10 });
    const sideMode = requireEnum(params, 'side_mode', SIDE_MODES);
    const maxDurationMinutes = requireInt(params, 'max_duration_minutes', { min: 1, max: 60 * 24 * 30 });

    // The exit has to sit closer to the mean than the entry, or the position is
    // already past its own exit the moment it is opened.
    if (exitZ >= entryZ) {
      throw new Error(
        `exit_z ${exitZ} must be below entry_z ${entryZ}. The exit is the deviation the price reverts TO, ` +
          'so an exit at or beyond the entry would close the trade on the tick that opened it.',
      );
    }

    const pair = await ctx.executor.tradingPair(symbol);
    const assetIncrement = pair?.asset_increment ? String(pair.asset_increment) : null;
    const minOrderSize = Number(pair?.min_order_size ?? pair?.min_order_amount ?? 0);
    const asset = symbol.split('-')[0] ?? symbol;

    const quantity = roundToIncrement(Number(quantityRaw), assetIncrement ?? undefined);
    if (Number(quantity) <= 0) {
      throw new Error(
        `quantity ${quantityRaw} rounds to zero at the venue increment of ` +
          `${assetIncrement ?? 'the base asset'}. Increase quantity.`,
      );
    }
    if (minOrderSize > 0 && Number(quantity) < minOrderSize) {
      throw new Error(
        `quantity ${quantity} ${asset} is below the venue minimum of ${minOrderSize}. Increase quantity: ` +
          'an entry the venue rejects means the job can never take the trade it is watching for.',
      );
    }

    // Spot venue: the short side is a sale of inventory, so the inventory has to
    // exist before the job is worth starting. Refused here, in front of the
    // caller, rather than at the extreme when the trade is live.
    if (sideMode !== 'long_only') {
      const held = await heldQuantity(ctx, asset);
      if (held !== null && held < Number(quantity)) {
        throw new Error(
          `side_mode "${sideMode}" needs ${quantity} ${asset} to sell into a high deviation, but the account ` +
            `holds ${held}. Robinhood crypto is spot only: there is no short to open, so the short side ` +
            `sells an existing holding. Use side_mode "long_only", or lower quantity to at most ${held}.`,
        );
      }
    }

    const state: MeanReversionState = {
      quantity,
      lookbackTicks,
      entryZ,
      exitZ,
      sideMode,
      deadline: ctx.now + maxDurationMinutes * 60_000,
      phase: 'watching',
      prices: [],
      direction: null,
      entryPrice: null,
      entryZScore: null,
      ticksInPosition: 0,
      asset,
    };

    return { state: state as unknown as Record<string, unknown>, symbol };
  },

  async advance(job: Job, ctx: StrategyContext): Promise<StrategyStep> {
    const state = job.state as unknown as MeanReversionState;

    if (state.phase === 'exited') {
      return { state: state as unknown as Record<string, unknown>, actions: [], done: { status: 'completed' } };
    }

    // Checked before anything else: a fade left open past its deadline is an
    // unmanaged position, and the whole premise of the trade was that it would
    // be closed on a signal rather than held.
    if (ctx.now >= state.deadline) {
      if (state.phase !== 'in_position') {
        return {
          state: { ...state, phase: 'exited' } as unknown as Record<string, unknown>,
          actions: [{ type: 'log', kind: 'mean_reversion_expired', detail: { samples: state.prices.length } }],
          done: {
            status: 'completed',
            reason: 'max_duration_minutes elapsed without a deviation large enough to fade. No position was taken.',
          },
        };
      }
      return {
        state: { ...state, phase: 'exited' } as unknown as Record<string, unknown>,
        actions: [
          {
            type: 'log',
            kind: 'mean_reversion_expired_in_position',
            detail: { direction: state.direction, entryPrice: state.entryPrice },
          },
          { type: 'submit', order: exitOrder(job.symbol, state) },
        ],
        done: {
          status: 'completed',
          reason:
            `max_duration_minutes elapsed while in position. The ${state.direction} opened at ` +
            `${state.entryPrice} was closed at market rather than being left open unmanaged.`,
        },
      };
    }

    // The entry is a market order, so a rejection means there is no position and
    // the exit logic below would be managing a trade that does not exist.
    if (state.phase === 'in_position' && state.ticksInPosition === 0 && job.lastError !== null) {
      return {
        state: { ...state, phase: 'exited' } as unknown as Record<string, unknown>,
        actions: [{ type: 'log', kind: 'mean_reversion_entry_rejected', detail: { error: job.lastError } }],
        done: { status: 'failed', reason: `The mean-reversion entry was not placed: ${job.lastError}` },
      };
    }

    const quoteSide: 'buy' | 'sell' = state.phase === 'in_position' ? exitSide(state) : 'buy';
    const price = await ctx.price(job.symbol, quoteSide);
    if (price === null) {
      // Both the mean and the deviation are built from sampled prices, so a
      // guessed sample would corrupt every decision this job makes afterwards.
      return {
        state: state as unknown as Record<string, unknown>,
        actions: [
          { type: 'log', kind: 'mean_reversion_no_price', detail: { symbol: job.symbol, phase: state.phase } },
        ],
      };
    }

    const window = state.prices;
    const sampled = { ...state, prices: pushWindow(window, price, state.lookbackTicks) };

    // The statistics are taken from the window as it stood BEFORE this sample,
    // so the current price is measured against history rather than against a
    // mean it has already moved.
    if (window.length < state.lookbackTicks) {
      return {
        state: sampled as unknown as Record<string, unknown>,
        actions: [
          {
            type: 'log',
            kind: 'mean_reversion_warmup',
            detail: { samples: window.length + 1, lookbackTicks: state.lookbackTicks },
          },
        ],
      };
    }

    const mean = average(window);
    const deviation = standardDeviation(window, mean);

    // A flat window has no scale, so every price is either exactly the mean or
    // infinitely far from it. Neither is a signal: wait for the market to move.
    if (deviation <= 0) {
      return {
        state: sampled as unknown as Record<string, unknown>,
        actions: [{ type: 'log', kind: 'mean_reversion_flat_window', detail: { mean, samples: window.length } }],
      };
    }

    const zScore = (price - mean) / deviation;

    if (state.phase === 'in_position') {
      // Reverted enough: a long entered below the mean exits once the deviation
      // has climbed back to within `exit_z` of it, and the short is the mirror.
      const reverted = state.direction === 'long' ? zScore >= -state.exitZ : zScore <= state.exitZ;

      if (!reverted) {
        return {
          state: { ...sampled, ticksInPosition: state.ticksInPosition + 1 } as unknown as Record<string, unknown>,
          actions: [
            {
              type: 'log',
              kind: 'mean_reversion_holding',
              detail: { price, mean, zScore: trim(zScore), direction: state.direction },
            },
          ],
        };
      }

      return {
        state: {
          ...sampled,
          phase: 'exited',
          ticksInPosition: state.ticksInPosition + 1,
        } as unknown as Record<string, unknown>,
        actions: [
          {
            type: 'log',
            kind: 'mean_reversion_exit',
            detail: {
              price,
              mean,
              zScore: trim(zScore),
              entryPrice: state.entryPrice,
              entryZScore: state.entryZScore,
              direction: state.direction,
            },
          },
          { type: 'submit', order: exitOrder(job.symbol, state) },
        ],
        done: {
          status: 'completed',
          reason:
            `Price reverted to ${trim(zScore)} standard deviations from the mean of ${trim(mean)}, so the ` +
            `${state.direction} opened at ${state.entryPrice} was closed.`,
        },
      };
    }

    const wantsLong = zScore <= -state.entryZ && state.sideMode !== 'short_only';
    const wantsShort = zScore >= state.entryZ && state.sideMode !== 'long_only';

    if (!wantsLong && !wantsShort) {
      return {
        state: sampled as unknown as Record<string, unknown>,
        actions: [
          {
            type: 'log',
            kind: 'mean_reversion_watching',
            detail: { price, mean: trim(mean), zScore: trim(zScore), entryZ: state.entryZ },
          },
        ],
      };
    }

    const direction: Direction = wantsLong ? 'long' : 'short';

    // Re-check the holding at the moment of a short entry. It was checked at
    // init, but a balance can be spent by anything else touching the account
    // between then and now, and a sale that exceeds the holding is rejected
    // after the signal has already passed.
    if (direction === 'short') {
      const held = await heldQuantity(ctx, state.asset);
      if (held !== null && held < Number(state.quantity)) {
        return {
          state: sampled as unknown as Record<string, unknown>,
          actions: [
            {
              type: 'log',
              kind: 'mean_reversion_short_uncovered',
              detail: { held, quantity: state.quantity, asset: state.asset, zScore: trim(zScore) },
            },
          ],
        };
      }
    }

    // Market, not limit: the signal is the deviation itself, and it decays. A
    // resting limit order would still be waiting once the price it was fading
    // has reverted on its own.
    const side: 'buy' | 'sell' = direction === 'long' ? 'buy' : 'sell';

    return {
      state: {
        ...sampled,
        phase: 'in_position',
        direction,
        entryPrice: String(price),
        entryZScore: Number(trim(zScore)),
        ticksInPosition: 0,
      } as unknown as Record<string, unknown>,
      actions: [
        {
          type: 'log',
          kind: 'mean_reversion_entry',
          detail: { price, mean: trim(mean), zScore: trim(zScore), direction, side },
        },
        {
          type: 'submit',
          order: { symbol: job.symbol, side, type: 'market', assetQuantity: state.quantity },
        },
      ],
    };
  },
};

/** The side that closes the position: a long sells back, a short buys back. */
function exitSide(state: MeanReversionState): 'buy' | 'sell' {
  return state.direction === 'long' ? 'sell' : 'buy';
}

function exitOrder(symbol: string, state: MeanReversionState) {
  return {
    symbol,
    side: exitSide(state),
    type: 'market' as const,
    assetQuantity: state.quantity,
  };
}

/**
 * Append one sample, dropping the oldest once the window is full.
 *
 * The window is persisted state, so its length is a storage decision as much as
 * a statistical one: unbounded growth would inflate the job row on every tick.
 */
function pushWindow(prices: number[], price: number, limit: number): number[] {
  const next = [...prices, price];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Population standard deviation, not the sample estimator.
 *
 * The window is the entire population being described: it is the whole of what
 * the strategy has decided to remember, not a sample drawn from a larger set.
 */
function standardDeviation(values: number[], mean: number): number {
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * How much of an asset the account holds, or null when it cannot be read.
 *
 * Null is deliberately not zero: an outage must not block a trade whose holding
 * is fine, and a genuinely uncovered sale is rejected by the venue anyway.
 */
async function heldQuantity(ctx: StrategyContext, asset: string): Promise<number | null> {
  try {
    const holdings = await ctx.executor.holdings([asset]);
    const row = holdings.find((holding) => String(holding.asset_code ?? '').toUpperCase() === asset);
    if (!row) return 0;
    const quantity = Number(
      row.quantity_available_for_trading ?? row.total_quantity ?? row.quantity ?? 0,
    );
    return Number.isFinite(quantity) ? quantity : null;
  } catch {
    return null;
  }
}

/** Trim float noise from a derived statistic before it reaches the event log. */
function trim(value: number): string {
  return String(Number(value.toFixed(6)));
}
