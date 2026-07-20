/**
 * Momentum: enter on a breakout, leave on the reversal.
 *
 * A breakout is only tradeable if something is watching when it happens, and a
 * single tool call is watching for exactly as long as it takes to return. This
 * strategy is the watcher: it samples the price on every advance, keeps a
 * bounded window of those samples in persisted job state, and enters when the
 * market takes out the extreme of that window by a margin the caller sets. Once
 * in, it tracks the best price the move reaches and exits when price gives back
 * a set fraction of it, so the exit follows the trade rather than a level
 * guessed before the trade existed.
 *
 * Robinhood crypto is a spot venue, which shapes what `side` can mean. `buy` is
 * the ordinary long: buy the upside break, sell to close. `sell` is not a short.
 * It is a momentum exit from coins the account already holds: sell the downside
 * break, and buy back when the fall reverses. `init` therefore checks the
 * holding exists before accepting a `sell` job, because a strategy that cannot
 * place its own entry is a job that will only ever fail.
 */

import type { Job, Strategy, StrategyContext, StrategyStep } from '../job.js';
import { roundToIncrement } from '../../shared/executor.js';
import { requireDecimal, requireEnum, requireInt, requireNumber, requireString } from './params.js';

type Phase = 'watching' | 'in_position' | 'exited';

interface MomentumState {
  /** Direction of the entry. `buy` breaks out upward, `sell` breaks down. */
  side: 'buy' | 'sell';
  /** Size of the entry, in the base asset, already rounded to the increment. */
  quantity: string;
  /** Samples kept in the rolling window. Also the samples needed to arm. */
  lookbackTicks: number;
  breakoutPct: number;
  exitPct: number;
  /** Epoch ms after which the job exits whatever it holds and stops. */
  deadline: number;
  phase: Phase;
  /**
   * The rolling price window, oldest first, never longer than `lookbackTicks`.
   * Bounded on every push, because this is persisted state and an unbounded
   * window would grow a job's row without limit for as long as it runs.
   */
  prices: number[];
  /** Price the entry was sent at. Null until the entry goes out. */
  entryPrice: string | null;
  /** Best price reached since entry: the high on a long, the low on a short. */
  peakPrice: string | null;
  /** Advances spent in position, used to read an entry rejection exactly once. */
  ticksInPosition: number;
}

export const momentum: Strategy = {
  name: 'momentum',
  description:
    'Enter when price breaks out of its recent range by a set margin, then exit when it retraces a set fraction of the move it reached.',
  defaultIntervalMs: 30_000,

  async init(params, ctx): Promise<{ state: Record<string, unknown>; symbol: string }> {
    const symbol = requireString(params, 'symbol').toUpperCase();
    const side = requireEnum(params, 'side', ['buy', 'sell'] as const);
    const quantityRaw = requireDecimal(params, 'quantity');
    const lookbackTicks = requireInt(params, 'lookback_ticks', { min: 3, max: 500 });
    const breakoutPct = requireNumber(params, 'breakout_pct', { min: 0.01, max: 100 });
    const exitPct = requireNumber(params, 'exit_pct', { min: 0.01, max: 100 });
    const maxDurationMinutes = requireInt(params, 'max_duration_minutes', { min: 1, max: 60 * 24 * 30 });

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
          'an entry the venue rejects means the job can never take the breakout it is watching for.',
      );
    }

    // The exit is a retrace of the move, so a 100% retrace is the entry price
    // itself and anything near it exits on noise before the trade can work.
    if (exitPct >= 100) {
      throw new Error('exit_pct must be below 100: a 100% retrace is the entire move, so the exit could never bank any of it.');
    }

    // Spot venue: a `sell` entry sells coins that must already be there. Checked
    // here rather than at the breakout, when the opportunity is live and there
    // is nobody to read a failure.
    if (side === 'sell') {
      const held = await heldQuantity(ctx, asset);
      if (held !== null && held < Number(quantity)) {
        throw new Error(
          `side "sell" on a spot venue sells an existing holding, but the account holds ${held} ${asset} ` +
            `and quantity is ${quantity}. Lower quantity to at most ${held}, or use side "buy" to trade the ` +
            'upside break instead. This is not a short: Robinhood crypto cannot open one.',
        );
      }
    }

    const state: MomentumState = {
      side,
      quantity,
      lookbackTicks,
      breakoutPct,
      exitPct,
      deadline: ctx.now + maxDurationMinutes * 60_000,
      phase: 'watching',
      prices: [],
      entryPrice: null,
      peakPrice: null,
      ticksInPosition: 0,
    };

    return { state: state as unknown as Record<string, unknown>, symbol };
  },

  async advance(job: Job, ctx: StrategyContext): Promise<StrategyStep> {
    const state = job.state as unknown as MomentumState;

    if (state.phase === 'exited') {
      return { state: state as unknown as Record<string, unknown>, actions: [], done: { status: 'completed' } };
    }

    // The deadline is a hard instruction and is checked before anything else. A
    // position left open past it would be an unmanaged trade with no job
    // watching it, which is the one outcome the duration exists to prevent.
    if (ctx.now >= state.deadline) {
      if (state.phase !== 'in_position') {
        return {
          state: { ...state, phase: 'exited' } as unknown as Record<string, unknown>,
          actions: [{ type: 'log', kind: 'momentum_expired', detail: { samples: state.prices.length } }],
          done: {
            status: 'completed',
            reason: `max_duration_minutes elapsed without a breakout. No position was taken.`,
          },
        };
      }
      return {
        state: { ...state, phase: 'exited' } as unknown as Record<string, unknown>,
        actions: [
          {
            type: 'log',
            kind: 'momentum_expired_in_position',
            detail: { entryPrice: state.entryPrice, peakPrice: state.peakPrice },
          },
          { type: 'submit', order: exitOrder(job.symbol, state) },
        ],
        done: {
          status: 'completed',
          reason:
            `max_duration_minutes elapsed while in position. The position opened at ${state.entryPrice} was ` +
            'closed at market rather than being left open unmanaged.',
        },
      };
    }

    // The entry is a market order, so a rejection means there is no position.
    // Reading it on the first advance after entry is the one moment it is
    // visible, and continuing would have the job manage a trade it never made.
    if (state.phase === 'in_position' && state.ticksInPosition === 0 && job.lastError !== null) {
      return {
        state: { ...state, phase: 'exited' } as unknown as Record<string, unknown>,
        actions: [{ type: 'log', kind: 'momentum_entry_rejected', detail: { error: job.lastError } }],
        done: { status: 'failed', reason: `The breakout entry was not placed: ${job.lastError}` },
      };
    }

    const price = await ctx.price(job.symbol, state.phase === 'in_position' ? exitSide(state) : state.side);
    if (price === null) {
      // A missing quote is not a breakout and not a reversal. Sampling a guess
      // would poison the window that every later decision is measured against,
      // so the tick is skipped whole.
      return {
        state: state as unknown as Record<string, unknown>,
        actions: [{ type: 'log', kind: 'momentum_no_price', detail: { symbol: job.symbol, phase: state.phase } }],
      };
    }

    if (state.phase === 'in_position') {
      // The peak is the best the trade has been, and it only ratchets: an exit
      // measured from anything else would move against the position each time
      // price ticked the wrong way.
      const previousPeak = Number(state.peakPrice);
      const improved = state.side === 'buy' ? price > previousPeak : price < previousPeak;
      const peak = improved ? price : previousPeak;
      const trigger = state.side === 'buy' ? peak * (1 - state.exitPct / 100) : peak * (1 + state.exitPct / 100);
      const retraced = state.side === 'buy' ? price <= trigger : price >= trigger;

      const carried = {
        ...state,
        prices: pushWindow(state.prices, price, state.lookbackTicks),
        peakPrice: String(peak),
        ticksInPosition: state.ticksInPosition + 1,
      };

      if (!retraced) {
        return {
          state: carried as unknown as Record<string, unknown>,
          actions: improved
            ? [{ type: 'log', kind: 'momentum_peak', detail: { peak, trigger } }]
            : [],
        };
      }

      return {
        state: { ...carried, phase: 'exited' } as unknown as Record<string, unknown>,
        actions: [
          {
            type: 'log',
            kind: 'momentum_exit',
            detail: { price, peak, trigger, entryPrice: state.entryPrice },
          },
          { type: 'submit', order: exitOrder(job.symbol, state) },
        ],
        done: {
          status: 'completed',
          reason:
            `Price retraced ${state.exitPct}% from a peak of ${peak} to ${price}, so the position opened at ` +
            `${state.entryPrice} was closed.`,
        },
      };
    }

    // The breakout is measured against the window as it stood BEFORE this
    // sample. Including the current price would compare it against itself, and
    // the extreme could never be exceeded.
    const window = state.prices;
    if (window.length < state.lookbackTicks) {
      return {
        state: { ...state, prices: pushWindow(window, price, state.lookbackTicks) } as unknown as Record<string, unknown>,
        actions: [
          {
            type: 'log',
            kind: 'momentum_warmup',
            detail: { samples: window.length + 1, lookbackTicks: state.lookbackTicks },
          },
        ],
      };
    }

    const high = Math.max(...window);
    const low = Math.min(...window);
    const trigger = state.side === 'buy' ? high * (1 + state.breakoutPct / 100) : low * (1 - state.breakoutPct / 100);
    const broke = state.side === 'buy' ? price >= trigger : price <= trigger;

    const sampled = { ...state, prices: pushWindow(window, price, state.lookbackTicks) };

    if (!broke) {
      return {
        state: sampled as unknown as Record<string, unknown>,
        actions: [{ type: 'log', kind: 'momentum_watching', detail: { price, high, low, trigger } }],
      };
    }

    // Market, not limit: a breakout entry that rests unfilled watches the move
    // it was supposed to be part of, which is worse than paying the spread.
    return {
      state: {
        ...sampled,
        phase: 'in_position',
        entryPrice: String(price),
        peakPrice: String(price),
        ticksInPosition: 0,
      } as unknown as Record<string, unknown>,
      actions: [
        { type: 'log', kind: 'momentum_breakout', detail: { price, high, low, trigger, side: state.side } },
        {
          type: 'submit',
          order: { symbol: job.symbol, side: state.side, type: 'market', assetQuantity: state.quantity },
        },
      ],
    };
  },
};

/** The side that closes the position: the mirror of the side that opened it. */
function exitSide(state: MomentumState): 'buy' | 'sell' {
  return state.side === 'buy' ? 'sell' : 'buy';
}

function exitOrder(symbol: string, state: MomentumState) {
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
 * The window lives in persisted job state, so its length is a storage decision
 * as much as a signal one: unbounded growth would inflate the job row on every
 * tick for as long as the job runs.
 */
function pushWindow(prices: number[], price: number, limit: number): number[] {
  const next = [...prices, price];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/**
 * How much of an asset the account holds, or null when it cannot be read.
 *
 * Null is deliberately not zero: an outage at init must not reject a job whose
 * holding is fine, and the venue rejects a genuinely uncovered sell anyway.
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
