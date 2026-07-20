/**
 * Chase: follow the book with a resting limit order until it fills.
 *
 * A market order pays the spread and whatever depth sits above it. A limit
 * order at the touch pays neither, but stops being at the touch the moment the
 * book moves, and then rests forever behind a market that has left. Chasing is
 * the middle: post at the touch, and when the market walks away, cancel and
 * repost where it went. Robinhood has no chase order type, so the package
 * synthesizes one, with the number of reposts bounded by the caller because an
 * unbounded chase is a market order paid for one tick at a time.
 *
 * The caller's `limit_price` is a hard boundary, not a preference: the chase
 * clamps to it and never posts through it, so a runaway market ends with a
 * resting order at the boundary rather than a fill the caller never agreed to.
 */

import { randomUUID } from 'node:crypto';
import type { Job, Strategy, StrategyAction, StrategyContext, StrategyStep } from '../job.js';
import { roundToIncrement } from '../../shared/executor.js';
import { optionalDecimal, requireDecimal, requireEnum, requireInt, requireNumber, requireString } from './params.js';

/**
 * The order currently resting in the book.
 *
 * `cancelRequested` is what makes a repost safe across a restart: while it is
 * set, the replacement has not been sent and must not be sent until the
 * original is confirmed gone, or the same size is live twice.
 */
interface ChaseLeg {
  clientOrderId: string;
  orderId: string | null;
  /** Limit price this leg was posted at, for measuring how far the book moved. */
  price: string;
  seenOpen: boolean;
  /** Consecutive advances in which this leg was not among the open orders. */
  missedChecks: number;
  cancelRequested: boolean;
  /** Advances spent waiting for the cancel to be confirmed. */
  cancelChecks: number;
}

interface ChaseState {
  side: 'buy' | 'sell';
  quantity: string;
  maxChases: number;
  /**
   * Distance from the touch, in basis points. Positive rests behind the touch
   * (passive, cheaper, less likely to fill); negative posts through it
   * (aggressive, marketable on arrival).
   */
  offsetBps: number;
  /** Ceiling for a buy, floor for a sell. Never crossed. Null disables. */
  boundPrice: string | null;
  /** Reposts consumed. The first post is not a chase. */
  chasesUsed: number;
  resting: ChaseLeg | null;
  /** Advances since the last submit, used to read a submit error once. */
  checks: number;
  assetIncrement: string | null;
  quoteIncrement: string | null;
}

/** Same absence semantics as the other multi-leg strategies. */
const ABSENCE_GRACE_CHECKS = 2;

/**
 * How far the book must move before a repost is worth it, in basis points.
 *
 * Every chase costs a cancel and a resubmit, and burns one of the caller's
 * budgeted chases. Reposting for a one-tick flicker spends the whole budget on
 * noise and never gets near a fill.
 */
const REPOST_THRESHOLD_BPS = 2;

/**
 * Advances to wait for a cancel to be confirmed gone before giving up.
 *
 * The job stops rather than reposting into an unconfirmed cancel, because the
 * failure mode of guessing here is holding twice the intended size.
 */
const MAX_CANCEL_CONFIRM_CHECKS = 3;

export const chase: Strategy = {
  name: 'chase',
  description:
    'Rest a limit order at the touch and repost it as the book moves away, up to a bounded number of chases, never crossing the price ceiling or floor the caller set.',
  defaultIntervalMs: 10_000,

  async init(params, ctx): Promise<{ state: Record<string, unknown>; symbol: string }> {
    const symbol = requireString(params, 'symbol').toUpperCase();
    const side = requireEnum(params, 'side', ['buy', 'sell'] as const);
    const quantity = requireDecimal(params, 'quantity');
    const maxChases = requireInt(params, 'max_chases', { min: 1, max: 100 });
    const offsetBps = requireNumber(params, 'offset_bps', { min: -1_000, max: 1_000 });
    const boundPrice = optionalDecimal(params, 'limit_price');

    const pair = await ctx.executor.tradingPair(symbol);
    const assetIncrement = pair?.asset_increment ? String(pair.asset_increment) : null;
    const quoteIncrement = pair?.quote_increment ? String(pair.quote_increment) : null;
    const minOrderSize = Number(pair?.min_order_size ?? pair?.min_order_amount ?? 0);
    if (minOrderSize > 0 && Number(quantity) < minOrderSize) {
      throw new Error(
        `quantity ${quantity} ${symbol.split('-')[0]} is below the venue minimum of ${minOrderSize}. ` +
          'Increase quantity: every repost would be rejected at this size.',
      );
    }

    // A bound already through the market is not a chase, it is a resting order
    // at one price. Caught here because the caller who inverted a ceiling and a
    // floor would otherwise watch a job that never posts anywhere useful.
    if (boundPrice !== null) {
      const reference = await ctx.price(symbol, side);
      if (reference !== null) {
        const bound = Number(boundPrice);
        const alreadyThrough = side === 'buy' ? bound < reference * 0.5 : bound > reference * 2;
        if (alreadyThrough) {
          throw new Error(
            `limit_price ${boundPrice} is more than a factor of two away from the current ${symbol} ` +
              `price of ${reference} on the wrong side for a ${side}. The chase would clamp to it and ` +
              'never fill. Check whether the ceiling and floor are the right way round.',
          );
        }
      }
    }

    const state: ChaseState = {
      side,
      quantity,
      maxChases,
      offsetBps,
      boundPrice,
      chasesUsed: 0,
      resting: null,
      checks: 0,
      assetIncrement,
      quoteIncrement,
    };

    return { state: state as unknown as Record<string, unknown>, symbol };
  },

  async advance(job: Job, ctx: StrategyContext): Promise<StrategyStep> {
    const state = job.state as unknown as ChaseState;
    const quantity = roundToIncrement(Number(state.quantity), state.assetIncrement ?? undefined);

    if (Number(quantity) <= 0) {
      return {
        state: state as unknown as Record<string, unknown>,
        actions: [{ type: 'log', kind: 'chase_rounded_to_zero', detail: { quantity: state.quantity } }],
        done: { status: 'failed', reason: 'Quantity rounds below the venue increment, so nothing could be posted.' },
      };
    }

    const leg = state.resting;

    // Nothing resting yet: this is the opening post, and it does not consume a
    // chase. Only reposts do.
    if (leg === null) return post(job, ctx, state, quantity, 0, 'chase_posted');

    // A cancel is in flight. Resolve it before anything else: posting a
    // replacement while the original may still be live is the one mistake in a
    // chase that doubles the caller's size.
    if (leg.cancelRequested) return resolveCancel(job, ctx, state, leg, quantity);

    // The supervisor records a rejected submit on the job and clears it on the
    // next advance, so this is the one moment the failure is readable.
    if (state.checks === 0 && job.lastError !== null) {
      return {
        state: state as unknown as Record<string, unknown>,
        actions: [{ type: 'log', kind: 'chase_post_rejected', detail: { error: job.lastError } }],
        done: { status: 'failed', reason: `The chase order was not placed: ${job.lastError}` },
      };
    }

    const open = await ctx.openOrders(job.id);
    const observed = observe(leg, findLeg(open, leg.clientOrderId));
    const next: ChaseState = { ...state, resting: observed, checks: state.checks + 1 };

    // Gone from the book with no cancel of ours in flight: it filled, which is
    // the whole point of the job.
    if (isResolved(observed, ABSENCE_GRACE_CHECKS)) {
      return {
        state: next as unknown as Record<string, unknown>,
        actions: [
          {
            type: 'log',
            kind: 'chase_filled',
            detail: { orderId: observed.orderId, price: observed.price, chasesUsed: state.chasesUsed },
          },
        ],
        done: { status: 'completed', reason: `Filled at a resting limit of ${observed.price}.` },
      };
    }

    const target = await targetPrice(job.symbol, ctx, state);
    if (target === null) {
      // No quote is not a reason to touch a live order. The resting price is
      // still the last price the book agreed with.
      return {
        state: next as unknown as Record<string, unknown>,
        actions: [{ type: 'log', kind: 'chase_no_price', detail: { resting: observed.price } }],
      };
    }

    if (!hasMovedAway(state.side, observed.price, target)) {
      return { state: next as unknown as Record<string, unknown>, actions: [] };
    }

    // The book has moved away and the budget is spent. The order is left
    // resting rather than cancelled: the caller asked to trade this size, and
    // cancelling converts a working order that may still fill on a retrace into
    // a guaranteed miss. It is a plain limit order from here, visible in
    // `get_orders` and cancellable by hand.
    if (state.chasesUsed >= state.maxChases) {
      return {
        state: next as unknown as Record<string, unknown>,
        actions: [
          {
            type: 'log',
            kind: 'chase_exhausted',
            detail: { orderId: observed.orderId, restingPrice: observed.price, target, chasesUsed: state.chasesUsed },
          },
        ],
        done: {
          status: 'completed',
          reason:
            `Used all ${state.maxChases} chases. Order ${observed.orderId ?? observed.clientOrderId} is left ` +
            `resting at ${observed.price} while the book is at ${target}. Cancel it if it is no longer wanted.`,
        },
      };
    }

    if (observed.orderId === null) {
      // No upstream id yet, so there is nothing that can be cancelled, and
      // posting a second order alongside it would double the size.
      return {
        state: next as unknown as Record<string, unknown>,
        actions: [{ type: 'log', kind: 'chase_unidentified', detail: { target } }],
      };
    }

    return {
      state: {
        ...next,
        resting: { ...observed, cancelRequested: true, cancelChecks: 0 },
      } as unknown as Record<string, unknown>,
      actions: [
        {
          type: 'log',
          kind: 'chase_cancelling',
          detail: { orderId: observed.orderId, from: observed.price, to: target },
        },
        { type: 'cancel', orderId: observed.orderId },
      ],
    };
  },
};

/**
 * Decide what happened to a cancel we asked for, and only then repost.
 *
 * A cancel is rejected when the order is no longer cancellable, and a resting
 * limit order stops being cancellable by filling. That rejection is therefore
 * the signal that the chase is over, and taking it as such is what keeps the
 * replacement from being a second fill.
 */
async function resolveCancel(
  job: Job,
  ctx: StrategyContext,
  state: ChaseState,
  leg: ChaseLeg,
  quantity: string,
): Promise<StrategyStep> {
  if (leg.cancelChecks === 0 && job.lastError !== null) {
    return {
      state: { ...state, resting: { ...leg, cancelRequested: false } } as unknown as Record<string, unknown>,
      actions: [
        {
          type: 'log',
          kind: 'chase_cancel_rejected',
          detail: { orderId: leg.orderId, price: leg.price, error: job.lastError },
        },
      ],
      done: {
        status: 'completed',
        reason:
          `The cancel of order ${leg.orderId} was refused (${job.lastError}), which means it left the book ` +
          `first. Treating it as filled at ${leg.price} and not reposting, since a replacement would double the size.`,
      },
    };
  }

  const open = await ctx.openOrders(job.id);
  const observed = observe(leg, findLeg(open, leg.clientOrderId));

  if (isResolved(observed, ABSENCE_GRACE_CHECKS)) {
    // The cancel landed. Nothing of ours is live, so a replacement is safe.
    return post(job, ctx, { ...state, resting: null }, quantity, 1, 'chase_reposted');
  }

  if (observed.cancelChecks >= MAX_CANCEL_CONFIRM_CHECKS) {
    return {
      state: { ...state, resting: observed } as unknown as Record<string, unknown>,
      actions: [
        {
          type: 'log',
          kind: 'chase_cancel_unconfirmed',
          detail: { orderId: observed.orderId, attempts: observed.cancelChecks },
        },
      ],
      done: {
        status: 'failed',
        reason:
          `Order ${observed.orderId} is still open ${observed.cancelChecks} advances after it was cancelled. ` +
          'Stopping without reposting: a replacement placed while it is live would hold twice the intended size.',
      },
    };
  }

  return {
    state: {
      ...state,
      resting: { ...observed, cancelChecks: observed.cancelChecks + 1 },
    } as unknown as Record<string, unknown>,
    actions: [],
  };
}

/**
 * Post a limit order at the current target price.
 *
 * A fresh `clientOrderId` is minted per post because each post is a distinct
 * order at a distinct price. It is persisted with the step before the submit
 * runs, so a crash between the two resolves through reconciliation rather than
 * through a second order.
 */
async function post(
  job: Job,
  ctx: StrategyContext,
  state: ChaseState,
  quantity: string,
  chaseCost: number,
  kind: string,
): Promise<StrategyStep> {
  const target = await targetPrice(job.symbol, ctx, state);
  if (target === null) {
    // Without a quote there is no price to post at, and guessing one is how a
    // chase fills at a number nobody chose. Wait for the next tick.
    return {
      state: state as unknown as Record<string, unknown>,
      actions: [{ type: 'log', kind: 'chase_no_price', detail: { pending: true } }],
    };
  }

  const leg: ChaseLeg = {
    clientOrderId: randomUUID(),
    orderId: null,
    price: target,
    seenOpen: false,
    missedChecks: 0,
    cancelRequested: false,
    cancelChecks: 0,
  };

  const actions: StrategyAction[] = [
    {
      type: 'log',
      kind,
      detail: { price: target, chasesUsed: state.chasesUsed + chaseCost, maxChases: state.maxChases },
    },
    {
      type: 'submit',
      order: {
        symbol: job.symbol,
        side: state.side,
        type: 'limit',
        assetQuantity: quantity,
        limitPrice: target,
        clientOrderId: leg.clientOrderId,
      },
    },
  ];

  return {
    state: {
      ...state,
      resting: leg,
      chasesUsed: state.chasesUsed + chaseCost,
      checks: 0,
    } as unknown as Record<string, unknown>,
    actions,
  };
}

/**
 * Where the next post belongs: the touch, moved by the offset, then clamped.
 *
 * The clamp is applied last so rounding can never push the price through the
 * caller's ceiling or floor. Rounding itself is down, which costs at most one
 * quote increment and errs toward the passive side for a buy.
 */
async function targetPrice(
  symbol: string,
  ctx: StrategyContext,
  state: ChaseState,
): Promise<string | null> {
  const reference = await ctx.price(symbol, state.side);
  if (reference === null || !Number.isFinite(reference) || reference <= 0) return null;

  const factor = state.side === 'buy' ? 1 - state.offsetBps / 10_000 : 1 + state.offsetBps / 10_000;
  const raw = reference * factor;
  if (!Number.isFinite(raw) || raw <= 0) return null;

  // Trim binary float dust before rounding. A limit price of 109.94500000000001
  // is not a price any venue accepts, and it is what a bps multiplication
  // produces about half the time.
  const cleaned = Number(raw.toPrecision(12));
  const rounded = Number(roundToIncrement(cleaned, state.quoteIncrement ?? undefined));
  if (!Number.isFinite(rounded) || rounded <= 0) return null;

  if (state.boundPrice !== null) {
    const bound = Number(state.boundPrice);
    const through = state.side === 'buy' ? rounded > bound : rounded < bound;
    if (through) return state.boundPrice;
  }

  return String(rounded);
}

/**
 * Has the book left the resting order behind?
 *
 * Only movement away matters. A market that comes toward a resting order is
 * about to fill it, and repricing into that is chasing a fill that was already
 * coming, at a worse price.
 */
function hasMovedAway(side: 'buy' | 'sell', restingPrice: string, target: string): boolean {
  const resting = Number(restingPrice);
  const next = Number(target);
  if (!Number.isFinite(resting) || resting <= 0 || !Number.isFinite(next)) return false;

  const movedAwayBps = ((side === 'buy' ? next - resting : resting - next) / resting) * 10_000;
  return movedAwayBps >= REPOST_THRESHOLD_BPS;
}

function findLeg(
  orders: Array<Record<string, unknown>>,
  clientOrderId: string,
): Record<string, unknown> | undefined {
  return orders.find((order) => String(order.client_order_id) === clientOrderId);
}

/** Fold one open-orders reading into the resting leg, learning its id if present. */
function observe(leg: ChaseLeg, open: Record<string, unknown> | undefined): ChaseLeg {
  if (!open) return { ...leg, missedChecks: leg.missedChecks + 1 };
  return {
    ...leg,
    orderId: typeof open.id === 'string' ? open.id : leg.orderId,
    seenOpen: true,
    missedChecks: 0,
  };
}

/** Resolved once the order has left the open book: filled, or cancelled upstream. */
function isResolved(leg: ChaseLeg, graceChecks: number): boolean {
  return leg.seenOpen ? leg.missedChecks > 0 : leg.missedChecks >= graceChecks;
}
