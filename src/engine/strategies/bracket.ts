/**
 * Bracket: one entry, then a take-profit and a stop-loss that cancel each other.
 *
 * Entering a position without both exits already decided is how a small loss
 * becomes a large one. Robinhood has neither bracket nor OCO orders, so the
 * package synthesizes both: the job places the entry, waits for it to fill,
 * places the two protective legs, and cancels the survivor when one of them
 * fills. The phase and the client order ids live in persisted state, so a
 * restart between any two of those steps resumes rather than re-enters.
 */

import { randomUUID } from 'node:crypto';
import type { Job, Strategy, StrategyContext, StrategyStep } from '../job.js';
import { roundToIncrement } from '../../shared/executor.js';
import {
  optionalDecimal,
  requireDecimal,
  requireEnum,
  requireString,
} from './params.js';

type BracketPhase = 'entry' | 'entry_fill' | 'exits' | 'monitor';

/**
 * One order this job owns.
 *
 * `clientOrderId` is minted at init and never regenerated, so a resubmit after
 * a crash carries the id Robinhood already knows and is rejected as a duplicate
 * rather than filled twice. `orderId` is learned later, the first time the
 * order is seen open, and is the only handle that can cancel it.
 */
interface BracketLeg {
  clientOrderId: string;
  orderId: string | null;
  seenOpen: boolean;
  /** Consecutive advances in which this leg was not among the open orders. */
  missedChecks: number;
}

interface BracketState {
  phase: BracketPhase;
  side: 'buy' | 'sell';
  /** Exit side, the opposite of the entry. Stored so state reads on its own. */
  exitSide: 'buy' | 'sell';
  quantity: string;
  entryType: 'market' | 'limit';
  entryPrice: string | null;
  takeProfitPrice: string;
  stopLossPrice: string;
  entry: BracketLeg;
  takeProfit: BracketLeg;
  stopLoss: BracketLeg;
  /** Advances spent in the current waiting phase, used to check submit errors once. */
  checks: number;
  assetIncrement: string | null;
}

/**
 * How many consecutive absences from the open-orders list mean "no longer open".
 *
 * A resting limit order should appear on the very next advance, so one absence
 * after it was seen is conclusive. An order that was never seen open may simply
 * not have been listed yet, so that case waits for a second reading before
 * concluding it filled immediately.
 */
const ABSENCE_GRACE_CHECKS = 2;

export const bracket: Strategy = {
  name: 'bracket',
  description:
    'Enter a position and attach a take-profit and a stop-loss that cancel one another, so the trade is never left without both exits.',
  defaultIntervalMs: 15_000,

  async init(params, ctx): Promise<{ state: Record<string, unknown>; symbol: string }> {
    const symbol = requireString(params, 'symbol').toUpperCase();
    const side = requireEnum(params, 'side', ['buy', 'sell'] as const);
    const quantity = requireDecimal(params, 'quantity');
    const entryType = requireEnum(params, 'entry_type', ['market', 'limit'] as const);
    const entryPrice = optionalDecimal(params, 'entry_price');
    const takeProfitPrice = requireDecimal(params, 'take_profit_price');
    const stopLossPrice = requireDecimal(params, 'stop_loss_price');

    if (entryType === 'limit' && entryPrice === null) {
      throw new Error('"entry_price" is required when entry_type is "limit". Use entry_type "market" to enter at the touch.');
    }

    // A swapped take-profit and stop-loss is the one input mistake that turns a
    // protective order into an immediate loss, so it is rejected by geometry
    // rather than trusted to the caller.
    const takeProfit = Number(takeProfitPrice);
    const stopLoss = Number(stopLossPrice);
    const profitIsAbove = side === 'buy';
    if (profitIsAbove ? takeProfit <= stopLoss : takeProfit >= stopLoss) {
      throw new Error(
        `For a ${side} entry, take_profit_price must be ${profitIsAbove ? 'above' : 'below'} ` +
          `stop_loss_price. Got take_profit_price ${takeProfitPrice} and stop_loss_price ${stopLossPrice}; ` +
          'the two values are probably swapped.',
      );
    }
    if (entryPrice !== null) {
      const entry = Number(entryPrice);
      const bracketed = profitIsAbove ? entry < takeProfit && entry > stopLoss : entry > takeProfit && entry < stopLoss;
      if (!bracketed) {
        throw new Error(
          `entry_price ${entryPrice} must sit between stop_loss_price ${stopLossPrice} and ` +
            `take_profit_price ${takeProfitPrice}, otherwise one exit is already through the money at entry.`,
        );
      }
    }

    const pair = await ctx.executor.tradingPair(symbol);
    const assetIncrement = pair?.asset_increment ? String(pair.asset_increment) : null;
    const minOrderSize = Number(pair?.min_order_size ?? pair?.min_order_amount ?? 0);
    if (minOrderSize > 0 && Number(quantity) < minOrderSize) {
      throw new Error(
        `quantity ${quantity} ${symbol.split('-')[0]} is below the venue minimum of ${minOrderSize}. ` +
          'Increase quantity: a bracket whose exits are unplaceable is worse than no bracket.',
      );
    }

    const state: BracketState = {
      phase: 'entry',
      side,
      exitSide: side === 'buy' ? 'sell' : 'buy',
      quantity,
      entryType,
      entryPrice,
      takeProfitPrice,
      stopLossPrice,
      entry: newLeg(),
      takeProfit: newLeg(),
      stopLoss: newLeg(),
      checks: 0,
      assetIncrement,
    };

    return { state: state as unknown as Record<string, unknown>, symbol };
  },

  async advance(job: Job, ctx: StrategyContext): Promise<StrategyStep> {
    const state = job.state as unknown as BracketState;
    const quantity = roundToIncrement(Number(state.quantity), state.assetIncrement ?? undefined);

    if (Number(quantity) <= 0) {
      return {
        state: state as unknown as Record<string, unknown>,
        actions: [{ type: 'log', kind: 'bracket_rounded_to_zero', detail: { quantity: state.quantity } }],
        done: { status: 'failed', reason: 'Quantity rounds below the venue increment, so no leg could be placed.' },
      };
    }

    switch (state.phase) {
      case 'entry':
        return {
          state: { ...state, phase: 'entry_fill', checks: 0 } as unknown as Record<string, unknown>,
          actions: [
            {
              type: 'submit',
              order: {
                symbol: job.symbol,
                side: state.side,
                type: state.entryType,
                assetQuantity: quantity,
                clientOrderId: state.entry.clientOrderId,
                ...(state.entryType === 'limit' ? { limitPrice: state.entryPrice ?? undefined } : {}),
              },
            },
          ],
        };

      case 'entry_fill': {
        // The supervisor records a rejected submit on the job and clears it on
        // the next advance, so this is the one moment the failure is readable.
        // Placing exits for a position that was never opened would itself open
        // one, in the wrong direction.
        if (state.checks === 0 && job.lastError !== null) {
          return {
            state: state as unknown as Record<string, unknown>,
            actions: [{ type: 'log', kind: 'bracket_entry_rejected', detail: { error: job.lastError } }],
            done: { status: 'failed', reason: `Entry order was not placed: ${job.lastError}` },
          };
        }

        const open = await ctx.openOrders(job.id);
        const entry = observe(state.entry, findLeg(open, state.entry.clientOrderId));
        // A market entry never rests in the book, so its absence is immediate
        // and expected; a limit entry gets the full grace before that call.
        const grace = state.entryType === 'market' ? 1 : ABSENCE_GRACE_CHECKS;

        if (!isResolved(entry, grace)) {
          return {
            state: { ...state, entry, checks: state.checks + 1 } as unknown as Record<string, unknown>,
            actions: [],
          };
        }

        return {
          state: { ...state, entry, phase: 'exits', checks: 0 } as unknown as Record<string, unknown>,
          actions: [{ type: 'log', kind: 'bracket_entry_filled', detail: { orderId: entry.orderId } }],
        };
      }

      case 'exits':
        return {
          state: { ...state, phase: 'monitor', checks: 0 } as unknown as Record<string, unknown>,
          actions: [
            {
              type: 'submit',
              order: {
                symbol: job.symbol,
                side: state.exitSide,
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
                side: state.exitSide,
                type: 'stop_loss',
                assetQuantity: quantity,
                stopPrice: state.stopLossPrice,
                clientOrderId: state.stopLoss.clientOrderId,
              },
            },
          ],
        };

      case 'monitor': {
        // Half a bracket is a live position with one missing exit. Surface it
        // instead of managing an OCO between a real leg and one that does not
        // exist, which would cancel the only protection left.
        if (state.checks === 0 && job.lastError !== null) {
          return {
            state: state as unknown as Record<string, unknown>,
            actions: [{ type: 'log', kind: 'bracket_exit_rejected', detail: { error: job.lastError } }],
            done: {
              status: 'failed',
              reason:
                `An exit leg was not placed: ${job.lastError}. The entry is filled, so review open ` +
                'orders and place the missing leg before leaving the position unattended.',
            },
          };
        }

        const open = await ctx.openOrders(job.id);
        const takeProfit = observe(state.takeProfit, findLeg(open, state.takeProfit.clientOrderId));
        const stopLoss = observe(state.stopLoss, findLeg(open, state.stopLoss.clientOrderId));
        const next = { ...state, takeProfit, stopLoss, checks: state.checks + 1 };

        const takeProfitGone = isResolved(takeProfit, ABSENCE_GRACE_CHECKS);
        const stopLossGone = isResolved(stopLoss, ABSENCE_GRACE_CHECKS);

        if (!takeProfitGone && !stopLossGone) {
          return { state: next as unknown as Record<string, unknown>, actions: [] };
        }

        if (takeProfitGone && stopLossGone) {
          return {
            state: next as unknown as Record<string, unknown>,
            actions: [
              {
                type: 'log',
                kind: 'bracket_exits_closed',
                detail: { takeProfitSeen: takeProfit.seenOpen, stopLossSeen: stopLoss.seenOpen },
              },
            ],
            done: { status: 'completed' },
          };
        }

        // This is the OCO: one leg filled, so the other must not be left live
        // to open an opposite position later.
        const filled = takeProfitGone ? takeProfit : stopLoss;
        const survivor = takeProfitGone ? stopLoss : takeProfit;
        const filledBy = takeProfitGone ? 'take_profit' : 'stop_loss';

        if (survivor.orderId === null) {
          // No id yet means it has never been listed open, so there is nothing
          // that can be cancelled by id. Keep watching rather than complete on
          // an assumption about an order that may still be resting.
          return {
            state: next as unknown as Record<string, unknown>,
            actions: [{ type: 'log', kind: 'bracket_survivor_unidentified', detail: { filledBy } }],
          };
        }

        return {
          state: next as unknown as Record<string, unknown>,
          actions: [
            {
              type: 'log',
              kind: 'bracket_exit_filled',
              detail: { filledBy, orderId: filled.orderId, cancelling: survivor.orderId },
            },
            { type: 'cancel', orderId: survivor.orderId },
          ],
          done: { status: 'completed' },
        };
      }
    }
  },
};

function newLeg(): BracketLeg {
  return { clientOrderId: randomUUID(), orderId: null, seenOpen: false, missedChecks: 0 };
}

function findLeg(
  orders: Array<Record<string, unknown>>,
  clientOrderId: string,
): Record<string, unknown> | undefined {
  return orders.find((order) => String(order.client_order_id) === clientOrderId);
}

/** Fold one open-orders reading into a leg, learning its upstream id if present. */
function observe(leg: BracketLeg, open: Record<string, unknown> | undefined): BracketLeg {
  if (!open) return { ...leg, missedChecks: leg.missedChecks + 1 };
  return {
    ...leg,
    orderId: typeof open.id === 'string' ? open.id : leg.orderId,
    seenOpen: true,
    missedChecks: 0,
  };
}

/** A leg is resolved once it has left the open book: filled, or cancelled upstream. */
function isResolved(leg: BracketLeg, graceChecks: number): boolean {
  return leg.seenOpen ? leg.missedChecks > 0 : leg.missedChecks >= graceChecks;
}
