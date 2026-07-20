/**
 * OCO: two resting exits, and the first one to fill cancels the other.
 *
 * A position guarded by a take-profit and a stop is only guarded if exactly one
 * of them can ever execute. Left unmanaged, the second leg outlives the trade
 * and opens a fresh position in the wrong direction hours later. Robinhood has
 * no OCO order type, so the package synthesizes one: both legs are placed up
 * front, the job polls them every tick, and the survivor is cancelled the
 * moment the other leaves the book.
 *
 * Unlike `bracket`, this strategy has no entry leg. It attaches to a position
 * that already exists, which is also why it never places anything on the
 * position's own side.
 *
 * The window between one leg filling and the other being cancelled is real
 * exposure: for that fraction of a tick both legs are live and both can fill.
 * That case is detected rather than assumed away, and it ends the job loudly.
 */

import { randomUUID } from 'node:crypto';
import type { Job, Strategy, StrategyContext, StrategyStep } from '../job.js';
import { roundToIncrement } from '../../shared/executor.js';
import { optionalDecimal, requireDecimal, requireEnum, requireString } from './params.js';

type OcoPhase = 'place' | 'monitor' | 'cancelling';

/**
 * One resting leg.
 *
 * `clientOrderId` is minted at init and never regenerated, so a resubmit after
 * a crash carries the id Robinhood already knows and is refused as a duplicate
 * rather than filled twice. `orderId` is learned the first time the leg is seen
 * open, and is the only handle that can cancel it.
 */
interface OcoLeg {
  clientOrderId: string;
  orderId: string | null;
  seenOpen: boolean;
  /** Consecutive advances in which this leg was not among the open orders. */
  missedChecks: number;
}

interface OcoState {
  phase: OcoPhase;
  /** Side of both legs. `sell` exits a long, `buy` covers a short. */
  side: 'buy' | 'sell';
  quantity: string;
  takeProfitPrice: string;
  stopPrice: string;
  /** Present makes the stop leg a stop_limit instead of a stop_loss. */
  stopLimitPrice: string | null;
  takeProfit: OcoLeg;
  stop: OcoLeg;
  /** Which leg left the book first. Set when the OCO fires. */
  filledBy: 'take_profit' | 'stop' | null;
  /** Cancels issued for the survivor, bounding the retry. */
  cancelAttempts: number;
  /** Advances spent in the current phase, used to read a submit error once. */
  checks: number;
  assetIncrement: string | null;
}

/**
 * How many consecutive absences from the open-orders list mean "no longer open".
 *
 * A leg that was seen resting should appear again on the very next advance, so
 * one absence after that is conclusive. A leg that was never seen may simply
 * not have been listed yet, so that case waits for a second reading. A stop
 * that triggers on placement is exactly that case, which is why the grace
 * exists at all.
 */
const ABSENCE_GRACE_CHECKS = 2;

/**
 * Cancels issued for the survivor before the job gives up on it.
 *
 * A cancel that never lands leaves a live exit order with nothing watching it,
 * which is the failure the operator most needs told about. Retrying forever
 * would hide it behind a job that looks healthy.
 */
const MAX_CANCEL_ATTEMPTS = 3;

export const oco: Strategy = {
  name: 'oco',
  description:
    'Rest a take-profit and a stop against an existing position and cancel whichever survives, so one exit can never fire after the other has already closed the trade.',
  defaultIntervalMs: 15_000,

  async init(params, ctx): Promise<{ state: Record<string, unknown>; symbol: string }> {
    const symbol = requireString(params, 'symbol').toUpperCase();
    const side = requireEnum(params, 'side', ['buy', 'sell'] as const);
    const quantity = requireDecimal(params, 'quantity');
    const takeProfitPrice = requireDecimal(params, 'take_profit_price');
    const stopPrice = requireDecimal(params, 'stop_price');
    const stopLimitPrice = optionalDecimal(params, 'stop_limit_price');

    // A swapped take-profit and stop is the one input mistake that turns a pair
    // of protective orders into an instant round trip through the spread, so it
    // is rejected by geometry rather than trusted to the caller.
    const takeProfit = Number(takeProfitPrice);
    const stop = Number(stopPrice);
    const profitIsAbove = side === 'sell';
    if (profitIsAbove ? takeProfit <= stop : takeProfit >= stop) {
      throw new Error(
        `For a ${side} exit, take_profit_price must be ${profitIsAbove ? 'above' : 'below'} ` +
          `stop_price. Got take_profit_price ${takeProfitPrice} and stop_price ${stopPrice}; ` +
          'the two values are probably swapped.',
      );
    }

    // A stop-limit whose limit sits on the far side of its own trigger can
    // never fill after triggering, which reads as a stop that silently did
    // nothing while the market ran away.
    if (stopLimitPrice !== null) {
      const stopLimit = Number(stopLimitPrice);
      const unreachable = side === 'sell' ? stopLimit > stop : stopLimit < stop;
      if (unreachable) {
        throw new Error(
          `stop_limit_price ${stopLimitPrice} is on the wrong side of stop_price ${stopPrice} for a ` +
            `${side} stop: once triggered the limit could never be marketable. Set stop_limit_price ` +
            `${side === 'sell' ? 'at or below' : 'at or above'} stop_price, or omit it for a plain stop.`,
        );
      }
    }

    // Reject a size the venue will refuse now, while there is still a caller to
    // read the message. An OCO whose legs are unplaceable is worse than none:
    // it looks like protection and is not.
    const pair = await ctx.executor.tradingPair(symbol);
    const assetIncrement = pair?.asset_increment ? String(pair.asset_increment) : null;
    const minOrderSize = Number(pair?.min_order_size ?? pair?.min_order_amount ?? 0);
    if (minOrderSize > 0 && Number(quantity) < minOrderSize) {
      throw new Error(
        `quantity ${quantity} ${symbol.split('-')[0]} is below the venue minimum of ${minOrderSize}. ` +
          'Increase quantity: neither leg could be placed at this size.',
      );
    }

    const state: OcoState = {
      phase: 'place',
      side,
      quantity,
      takeProfitPrice,
      stopPrice,
      stopLimitPrice,
      takeProfit: newLeg(),
      stop: newLeg(),
      filledBy: null,
      cancelAttempts: 0,
      checks: 0,
      assetIncrement,
    };

    return { state: state as unknown as Record<string, unknown>, symbol };
  },

  async advance(job: Job, ctx: StrategyContext): Promise<StrategyStep> {
    const state = job.state as unknown as OcoState;
    const quantity = roundToIncrement(Number(state.quantity), state.assetIncrement ?? undefined);

    if (Number(quantity) <= 0) {
      return {
        state: state as unknown as Record<string, unknown>,
        actions: [{ type: 'log', kind: 'oco_rounded_to_zero', detail: { quantity: state.quantity } }],
        done: { status: 'failed', reason: 'Quantity rounds below the venue increment, so no leg could be placed.' },
      };
    }

    switch (state.phase) {
      case 'place':
        return {
          state: { ...state, phase: 'monitor', checks: 0 } as unknown as Record<string, unknown>,
          actions: [
            {
              type: 'submit',
              order: {
                symbol: job.symbol,
                side: state.side,
                type: 'limit',
                assetQuantity: quantity,
                limitPrice: state.takeProfitPrice,
                clientOrderId: state.takeProfit.clientOrderId,
              },
            },
            {
              type: 'submit',
              order: {
                symbol: job.symbol,
                side: state.side,
                type: state.stopLimitPrice === null ? 'stop_loss' : 'stop_limit',
                assetQuantity: quantity,
                stopPrice: state.stopPrice,
                ...(state.stopLimitPrice === null ? {} : { limitPrice: state.stopLimitPrice }),
                clientOrderId: state.stop.clientOrderId,
              },
            },
          ],
        };

      case 'monitor': {
        // The supervisor records a rejected submit on the job and clears it on
        // the next advance, so this is the one moment the failure is readable.
        // A half-placed OCO is a single unpaired exit against a live position:
        // surface it instead of managing a pair where one side does not exist.
        if (state.checks === 0 && job.lastError !== null) {
          return {
            state: state as unknown as Record<string, unknown>,
            actions: [{ type: 'log', kind: 'oco_leg_rejected', detail: { error: job.lastError } }],
            done: {
              status: 'failed',
              reason:
                `An OCO leg was not placed: ${job.lastError}. Review open orders: the other leg may be ` +
                'resting alone, with nothing left to cancel it.',
            },
          };
        }

        const open = await ctx.openOrders(job.id);
        const takeProfit = observe(state.takeProfit, findLeg(open, state.takeProfit.clientOrderId));
        const stop = observe(state.stop, findLeg(open, state.stop.clientOrderId));
        const next = { ...state, takeProfit, stop, checks: state.checks + 1 };

        const takeProfitGone = isResolved(takeProfit, ABSENCE_GRACE_CHECKS);
        const stopGone = isResolved(stop, ABSENCE_GRACE_CHECKS);

        if (!takeProfitGone && !stopGone) {
          return { state: next as unknown as Record<string, unknown>, actions: [] };
        }

        // Both legs left the book without this job cancelling either one. At
        // least one filled and the other filled too or was cancelled elsewhere,
        // and either way the position is not what the caller expects. This is
        // the exposure window the strategy exists to bound, so it ends the job
        // as failed: `completed` would file a double fill under "worked as
        // designed" in the job list, where nobody would look at it again.
        if (takeProfitGone && stopGone) {
          return {
            state: next as unknown as Record<string, unknown>,
            actions: [
              {
                type: 'log',
                kind: 'oco_double_fill',
                detail: {
                  takeProfitOrderId: takeProfit.orderId,
                  stopOrderId: stop.orderId,
                  takeProfitSeenOpen: takeProfit.seenOpen,
                  stopSeenOpen: stop.seenOpen,
                },
              },
            ],
            done: {
              status: 'failed',
              reason:
                'Both OCO legs left the book in the same reading, before either could be cancelled. ' +
                `Assume ${state.quantity} was exited twice on the ${state.side} side and reconcile the ` +
                'position: the second fill opened an unintended one in the opposite direction.',
            },
          };
        }

        const survivor = takeProfitGone ? stop : takeProfit;
        const filledBy = takeProfitGone ? 'take_profit' : 'stop';

        if (survivor.orderId === null) {
          // Never listed open, so there is no id that can be cancelled. Keep
          // watching rather than completing on an assumption about an order
          // that may still be resting with nothing paired against it.
          return {
            state: next as unknown as Record<string, unknown>,
            actions: [{ type: 'log', kind: 'oco_survivor_unidentified', detail: { filledBy } }],
          };
        }

        // The OCO fires. It does not complete here: a cancel can be rejected,
        // and finishing on the assumption that it landed is how a live exit
        // order is left behind with no job watching it.
        return {
          state: {
            ...next,
            phase: 'cancelling',
            filledBy,
            cancelAttempts: 1,
          } as unknown as Record<string, unknown>,
          actions: [
            {
              type: 'log',
              kind: 'oco_leg_filled',
              detail: { filledBy, cancelling: survivor.orderId },
            },
            { type: 'cancel', orderId: survivor.orderId },
          ],
        };
      }

      case 'cancelling': {
        const survivorIsStop = state.filledBy === 'take_profit';
        const survivor = survivorIsStop ? state.stop : state.takeProfit;
        const survivorName = survivorIsStop ? 'stop' : 'take_profit';

        // A rejected cancel means the order was no longer cancellable, and an
        // exit order stops being cancellable by filling. This is the second
        // double-fill detector, and the one that catches the fill that happened
        // inside the exposure window rather than before it.
        if (state.cancelAttempts > 0 && job.lastError !== null) {
          return {
            state: state as unknown as Record<string, unknown>,
            actions: [
              {
                type: 'log',
                kind: 'oco_double_fill',
                detail: { filledBy: state.filledBy, survivor: survivorName, error: job.lastError },
              },
            ],
            done: {
              status: 'failed',
              reason:
                `The ${state.filledBy} leg filled and the resting ${survivorName} leg could not be ` +
                `cancelled: ${job.lastError}. It most likely filled inside the same window, so assume ` +
                `${state.quantity} was exited twice and reconcile the position.`,
            },
          };
        }

        const open = await ctx.openOrders(job.id);
        const observed = observe(survivor, findLeg(open, survivor.clientOrderId));
        const next = {
          ...state,
          ...(survivorIsStop ? { stop: observed } : { takeProfit: observed }),
        };

        if (isResolved(observed, ABSENCE_GRACE_CHECKS)) {
          return {
            state: next as unknown as Record<string, unknown>,
            actions: [
              {
                type: 'log',
                kind: 'oco_cancel_confirmed',
                detail: { filledBy: state.filledBy, cancelled: observed.orderId },
              },
            ],
            done: {
              status: 'completed',
              reason: `The ${state.filledBy} leg filled and the resting ${survivorName} leg was cancelled.`,
            },
          };
        }

        if (state.cancelAttempts >= MAX_CANCEL_ATTEMPTS) {
          return {
            state: next as unknown as Record<string, unknown>,
            actions: [
              {
                type: 'log',
                kind: 'oco_cancel_unconfirmed',
                detail: { orderId: observed.orderId, attempts: state.cancelAttempts },
              },
            ],
            done: {
              status: 'failed',
              reason:
                `The ${state.filledBy} leg filled but order ${observed.orderId} is still open after ` +
                `${state.cancelAttempts} cancel attempts. Cancel it by hand: it can still fire against a ` +
                'position that is already closed.',
            },
          };
        }

        return {
          state: {
            ...next,
            cancelAttempts: state.cancelAttempts + 1,
          } as unknown as Record<string, unknown>,
          actions: [{ type: 'cancel', orderId: observed.orderId as string }],
        };
      }
    }
  },
};

function newLeg(): OcoLeg {
  return { clientOrderId: randomUUID(), orderId: null, seenOpen: false, missedChecks: 0 };
}

function findLeg(
  orders: Array<Record<string, unknown>>,
  clientOrderId: string,
): Record<string, unknown> | undefined {
  return orders.find((order) => String(order.client_order_id) === clientOrderId);
}

/** Fold one open-orders reading into a leg, learning its upstream id if present. */
function observe(leg: OcoLeg, open: Record<string, unknown> | undefined): OcoLeg {
  if (!open) return { ...leg, missedChecks: leg.missedChecks + 1 };
  return {
    ...leg,
    orderId: typeof open.id === 'string' ? open.id : leg.orderId,
    seenOpen: true,
    missedChecks: 0,
  };
}

/** A leg is resolved once it has left the open book: filled, or cancelled upstream. */
function isResolved(leg: OcoLeg, graceChecks: number): boolean {
  return leg.seenOpen ? leg.missedChecks > 0 : leg.missedChecks >= graceChecks;
}
