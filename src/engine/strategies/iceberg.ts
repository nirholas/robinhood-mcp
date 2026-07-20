/**
 * Iceberg: show a small order while working a large one.
 *
 * Resting 10 BTC on the book tells everyone watching exactly what you intend to
 * do, and the book moves away before the order fills. An iceberg shows only a
 * slice at a time and replaces it after each fill, so the visible order never
 * reveals the size behind it. Robinhood has no reserve or display quantity, so
 * the package synthesizes one: the job holds the total, the fill progress and
 * the working slice in persisted state, and the supervisor places the next
 * slice only after the current one has left the book.
 */

import { randomUUID } from 'node:crypto';
import type { Job, Strategy, StrategyContext, StrategyStep } from '../job.js';
import { roundToIncrement } from '../../shared/executor.js';
import { optionalDecimal, requireDecimal, requireEnum, requireInt, requireString } from './params.js';

/**
 * The one slice currently resting in the book.
 *
 * `clientOrderId` is minted before the submit action is returned, so it is on
 * disk before the network call and a crash between the two cannot re-place the
 * same slice under a new id. `orderId` is learned the first time the slice is
 * seen open, and is the only handle that can cancel it or read its fill.
 */
interface IcebergSlice {
  clientOrderId: string;
  orderId: string | null;
  seenOpen: boolean;
  /** Consecutive advances in which this slice was not among the open orders. */
  missedChecks: number;
  /** Size submitted, so a fill can be credited without re-deriving it. */
  quantity: string;
  /** Price it rests at, recorded so the event log explains each refill. */
  limitPrice: string;
}

interface IcebergState {
  side: 'buy' | 'sell';
  /** Full size to work, in the base asset, as a decimal string. */
  totalQuantity: string;
  /** Size of a single visible slice. */
  visibleQuantity: string;
  /** Fixed price for every slice. Null pegs each refill to the near touch. */
  limitPrice: string | null;
  /** Epoch ms after which the job stops working the remainder. */
  deadline: number;
  filledQuantity: string;
  working: IcebergSlice | null;
  /** Advances spent waiting on the working slice, used to read a submit error once. */
  checks: number;
  /** Venue constraints captured at init so sizing stays legal for the whole run. */
  assetIncrement: string | null;
  minOrderSize: number;
}

/**
 * How many consecutive absences from the open-orders list mean "no longer open".
 *
 * A slice that was seen resting should appear again on the very next advance,
 * so one absence after that is conclusive. A slice that was never seen may
 * simply not have been listed yet, so it waits for a second reading before
 * being treated as an immediate fill.
 */
const ABSENCE_GRACE_CHECKS = 2;

export const iceberg: Strategy = {
  name: 'iceberg',
  description:
    'Work a large order behind a small visible slice, replacing the slice after each fill so the book never shows the full size.',
  defaultIntervalMs: 15_000,

  async init(params, ctx): Promise<{ state: Record<string, unknown>; symbol: string }> {
    const symbol = requireString(params, 'symbol').toUpperCase();
    const side = requireEnum(params, 'side', ['buy', 'sell'] as const);
    const totalQuantity = requireDecimal(params, 'total_quantity');
    const visibleQuantity = requireDecimal(params, 'visible_quantity');
    const limitPrice = optionalDecimal(params, 'limit_price');
    const durationMinutes = requireInt(params, 'max_duration_minutes', { min: 1, max: 60 * 24 * 7 });

    // A visible slice as large as the total hides nothing, and the extra
    // machinery only adds latency to what is really a single limit order.
    if (Number(visibleQuantity) >= Number(totalQuantity)) {
      throw new Error(
        `visible_quantity ${visibleQuantity} must be smaller than total_quantity ${totalQuantity}, ` +
          'otherwise the whole size is shown at once. Lower visible_quantity, or place a single limit order instead.',
      );
    }

    // Reject a slice size the venue will refuse now, rather than discovering it
    // on the first refill with the total already committed.
    const pair = await ctx.executor.tradingPair(symbol);
    const assetIncrement = pair?.asset_increment ? String(pair.asset_increment) : null;
    const minOrderSize = Number(pair?.min_order_size ?? pair?.min_order_amount ?? 0);
    if (minOrderSize > 0 && Number(visibleQuantity) < minOrderSize) {
      throw new Error(
        `visible_quantity ${visibleQuantity} ${symbol.split('-')[0]} is below the venue minimum of ` +
          `${minOrderSize}. Increase visible_quantity: a slice the venue rejects can never refill.`,
      );
    }

    const state: IcebergState = {
      side,
      totalQuantity,
      visibleQuantity,
      limitPrice,
      deadline: ctx.now + durationMinutes * 60_000,
      filledQuantity: '0',
      working: null,
      checks: 0,
      assetIncrement,
      minOrderSize,
    };

    return { state: state as unknown as Record<string, unknown>, symbol };
  },

  async advance(job: Job, ctx: StrategyContext): Promise<StrategyStep> {
    const state = job.state as unknown as IcebergState;

    // The duration is a hard instruction, so it is checked before anything
    // else. A slice left resting past it would keep working the order with no
    // job watching it, which is the one outcome the deadline exists to prevent.
    if (ctx.now >= state.deadline) {
      const actions: StrategyStep['actions'] = [
        {
          type: 'log',
          kind: 'iceberg_expired',
          detail: {
            filledQuantity: state.filledQuantity,
            totalQuantity: state.totalQuantity,
            workingOrderId: state.working?.orderId ?? null,
            workingClientOrderId: state.working?.clientOrderId ?? null,
          },
        },
      ];
      if (state.working?.orderId) {
        actions.push({ type: 'cancel', orderId: state.working.orderId });
      }
      return {
        state: state as unknown as Record<string, unknown>,
        actions,
        done: {
          status: 'completed',
          reason:
            `max_duration_minutes elapsed with ${state.filledQuantity} of ${state.totalQuantity} filled` +
            (state.working?.orderId ? '. The resting slice was cancelled.' : '.'),
        },
      };
    }

    const actions: StrategyStep['actions'] = [];
    let current = state;

    if (state.working !== null) {
      // The supervisor records a rejected submit on the job and clears it on the
      // next advance, so this is the one moment it is readable. Placing another
      // slice over a rejection would just queue up the same rejection again.
      if (state.checks === 0 && job.lastError !== null) {
        return {
          state: state as unknown as Record<string, unknown>,
          actions: [{ type: 'log', kind: 'iceberg_slice_rejected', detail: { error: job.lastError } }],
          done: { status: 'failed', reason: `Iceberg slice was not placed: ${job.lastError}` },
        };
      }

      const open = await ctx.openOrders(job.id);
      const working = observe(state.working, findSlice(open, state.working.clientOrderId));

      // One slice at a time is the whole point: refilling while the previous
      // slice is still live would show twice the intended size.
      if (!isResolved(working)) {
        return {
          state: { ...state, working, checks: state.checks + 1 } as unknown as Record<string, unknown>,
          actions: [],
        };
      }

      const filled = await creditedFill(working, ctx);
      current = {
        ...state,
        working: null,
        filledQuantity: String(Number(state.filledQuantity) + Number(filled)),
        checks: 0,
      };
      actions.push({
        type: 'log',
        kind: 'iceberg_slice_filled',
        detail: { orderId: working.orderId, quantity: filled, filledQuantity: current.filledQuantity },
      });
    }

    const remaining = Number(current.totalQuantity) - Number(current.filledQuantity);
    const rawSlice = Math.min(Number(current.visibleQuantity), remaining);
    const sliceQuantity = roundToIncrement(rawSlice, current.assetIncrement ?? undefined);

    if (Number(sliceQuantity) <= 0) {
      return {
        state: current as unknown as Record<string, unknown>,
        actions: [...actions, { type: 'log', kind: 'iceberg_filled', detail: { filledQuantity: current.filledQuantity } }],
        done: { status: 'completed' },
      };
    }

    // The final remainder can be real size that is still too small to trade.
    // Stop on it deliberately instead of submitting an order the venue rejects.
    if (current.minOrderSize > 0 && Number(sliceQuantity) < current.minOrderSize) {
      return {
        state: current as unknown as Record<string, unknown>,
        actions: [
          ...actions,
          {
            type: 'log',
            kind: 'iceberg_remainder_below_minimum',
            detail: { remainder: sliceQuantity, minOrderSize: current.minOrderSize },
          },
        ],
        done: {
          status: 'completed',
          reason:
            `Filled ${current.filledQuantity} of ${current.totalQuantity}. The remaining ${sliceQuantity} is ` +
            `below the venue minimum of ${current.minOrderSize} and cannot be worked as a further slice.`,
        },
      };
    }

    let slicePrice = current.limitPrice;
    if (slicePrice === null) {
      // Peg to the passive side of the book: `ctx.price` reports the execution
      // side, so a resting buy wants the bid, which is the sell-side price.
      // Pegging to our own execution side would cross the spread and fill
      // immediately, which is a market order wearing a limit order's name.
      const peg = await ctx.price(job.symbol, current.side === 'buy' ? 'sell' : 'buy');
      if (peg === null) {
        // No quote means no price to rest at. Waiting costs one interval;
        // guessing a price would put real size in the book at an unknown level.
        return {
          state: current as unknown as Record<string, unknown>,
          actions: [...actions, { type: 'log', kind: 'iceberg_no_price', detail: { symbol: job.symbol } }],
        };
      }
      slicePrice = formatPrice(peg);
    }

    const working: IcebergSlice = {
      clientOrderId: randomUUID(),
      orderId: null,
      seenOpen: false,
      missedChecks: 0,
      quantity: sliceQuantity,
      limitPrice: slicePrice,
    };

    return {
      state: { ...current, working, checks: 0 } as unknown as Record<string, unknown>,
      actions: [
        ...actions,
        {
          type: 'submit',
          order: {
            symbol: job.symbol,
            side: current.side,
            type: 'limit',
            assetQuantity: sliceQuantity,
            limitPrice: slicePrice,
            clientOrderId: working.clientOrderId,
          },
        },
      ],
    };
  },
};

function findSlice(
  orders: Array<Record<string, unknown>>,
  clientOrderId: string,
): Record<string, unknown> | undefined {
  return orders.find((order) => String(order.client_order_id) === clientOrderId);
}

/** Fold one open-orders reading into the slice, learning its upstream id if present. */
function observe(slice: IcebergSlice, open: Record<string, unknown> | undefined): IcebergSlice {
  if (!open) return { ...slice, missedChecks: slice.missedChecks + 1 };
  return {
    ...slice,
    orderId: typeof open.id === 'string' ? open.id : slice.orderId,
    seenOpen: true,
    missedChecks: 0,
  };
}

/** A slice is resolved once it has left the open book: filled, or cancelled upstream. */
function isResolved(slice: IcebergSlice): boolean {
  return slice.seenOpen ? slice.missedChecks > 0 : slice.missedChecks >= ABSENCE_GRACE_CHECKS;
}

/**
 * How much of a resolved slice actually traded.
 *
 * A slice can leave the open book without filling completely: someone can
 * cancel it upstream, or it can partially fill and be pulled. Crediting the
 * submitted size in that case would under-work the total. When the true fill
 * cannot be read the submitted size is credited instead, because over-crediting
 * ends the job early and under-crediting would buy more than the caller asked
 * for, and only one of those two errors costs money.
 */
async function creditedFill(slice: IcebergSlice, ctx: StrategyContext): Promise<string> {
  if (slice.orderId === null) return slice.quantity;

  try {
    const order = (await ctx.executor.getOrder(slice.orderId)) as Record<string, unknown> | null;
    const filled = Number(order?.filled_asset_quantity ?? order?.cumulative_quantity);
    if (Number.isFinite(filled) && filled >= 0) return String(filled);
  } catch {
    // A failed lookup is an outage, not a fill report. Fall through.
  }
  return slice.quantity;
}

/** Trim float noise from a derived price, which Robinhood rejects as precision. */
function formatPrice(value: number): string {
  return String(Number(value.toFixed(8)));
}
