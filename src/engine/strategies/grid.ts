/**
 * Grid: buy every step down, sell every step up, and repeat while the market
 * oscillates.
 *
 * A range-bound market pays a directional order nothing, because it ends where
 * it started. A grid monetizes the path instead of the destination: buys rest
 * below the market, sells rest above it, and every round trip between two
 * adjacent levels banks the spacing between them. Robinhood has no grid order
 * type, so the package synthesizes one. The level geometry, the working orders,
 * the inventory and the realized profit all live in persisted job state, so a
 * restart resumes the same grid rather than seeding a second one over the top
 * of the first.
 *
 * Two rules keep a grid from turning into an accident. At most one working
 * order per level, ever, because a grid that re-places a level it already has
 * resting doubles its size at that price on every single tick. And a sell only
 * goes out when grid inventory covers it: this is a spot venue, so a sell that
 * outruns the buys funding it is an attempt to sell coins the account does not
 * hold, and the venue rejects it after the buy side has already been spent.
 */

import { randomUUID } from 'node:crypto';
import type { Job, Strategy, StrategyAction, StrategyContext, StrategyStep } from '../job.js';
import { roundToIncrement } from '../../shared/executor.js';
import { isPresent, optionalDecimal, requireDecimal, requireInt, requireString } from './params.js';

/**
 * One resting order the grid owns.
 *
 * `clientOrderId` is minted before the submit action is returned, so it is on
 * disk before the network call and a crash between the two cannot re-place the
 * same level under a fresh id. `entryPrice` is carried on a sell so the profit
 * of the round trip is known from the order itself rather than re-derived from
 * geometry that may have been resumed from a different job.
 */
interface GridOrder {
  /** Index into `levels`, which is also the identity that prevents doubling. */
  level: number;
  side: 'buy' | 'sell';
  price: string;
  quantity: string;
  /** Price the funding buy filled at. Null on a buy. */
  entryPrice: string | null;
  clientOrderId: string;
  orderId: string | null;
  seenOpen: boolean;
  /** Consecutive advances in which this order was not among the open orders. */
  missedChecks: number;
}

/** A placement the grid intends to make once a level is free and funded. */
interface QueuedPlacement {
  level: number;
  side: 'buy' | 'sell';
  entryPrice: string | null;
}

interface GridState {
  /** Level prices, ascending. Computed once at init so geometry cannot drift. */
  levels: string[];
  quantityPerGrid: string;
  /** Completed round trips after which the grid stops. Always finite. */
  maxCycles: number;
  /** Halt-and-exit floor beneath the grid. Null disables it. */
  stopPrice: string | null;
  /** Epoch ms after which the grid stops regardless of cycles. */
  deadline: number;
  /** False until the first advance that had a usable price to seed against. */
  seeded: boolean;
  working: GridOrder[];
  queue: QueuedPlacement[];
  cyclesDone: number;
  /** Quote-currency profit banked by completed buy-low/sell-high pairs. */
  realizedProfit: string;
  /** Base asset bought by this grid and not yet sold back. */
  inventory: string;
  /** Orders submitted on the previous advance, so a rejection is read once. */
  lastSubmitted: number;
  /** Venue constraints captured at init so sizing stays legal for the whole run. */
  assetIncrement: string | null;
  minOrderSize: number;
}

/**
 * Placements per advance.
 *
 * Small enough that a policy rejection is observed after a handful of orders
 * rather than after fifty, large enough that a full grid is working within a
 * couple of minutes of starting.
 */
const MAX_PLACEMENTS_PER_ADVANCE = 4;

/**
 * How many consecutive absences from the open-orders list mean "no longer open".
 *
 * An order that was seen resting should appear again on the very next advance,
 * so one absence after that is conclusive. An order never seen may simply not
 * have been listed yet, so it waits for a second reading before being treated
 * as an immediate fill.
 */
const ABSENCE_GRACE_CHECKS = 2;

/**
 * Cycle ceiling applied when the caller names none.
 *
 * A grid with no cap is a job that never ends, and this engine has no concept
 * of a job that never ends: every one of them holds a supervisor slot and keeps
 * spending. A hundred round trips is far past the point where a caller should
 * look at the result and decide whether to keep going.
 */
const DEFAULT_MAX_CYCLES = 100;

/** Duration ceiling applied when the caller names none: one week. */
const DEFAULT_MAX_DURATION_MINUTES = 60 * 24 * 7;

export const grid: Strategy = {
  name: 'grid',
  description:
    'Rest buys below and sells above across a price range, replacing each fill with its opposite one level away, banking the spacing on every round trip.',
  defaultIntervalMs: 20_000,

  async init(params, ctx): Promise<{ state: Record<string, unknown>; symbol: string }> {
    const symbol = requireString(params, 'symbol').toUpperCase();
    const lowerPrice = requireDecimal(params, 'lower_price');
    const upperPrice = requireDecimal(params, 'upper_price');
    const gridLevels = requireInt(params, 'grid_levels', { min: 3, max: 50 });
    const quantityRaw = requireDecimal(params, 'quantity_per_grid');
    const stopPrice = optionalDecimal(params, 'stop_price');

    const maxCycles = isPresent(params, 'max_cycles')
      ? requireInt(params, 'max_cycles', { min: 1, max: 10_000 })
      : DEFAULT_MAX_CYCLES;
    const maxDurationMinutes = isPresent(params, 'max_duration_minutes')
      ? requireInt(params, 'max_duration_minutes', { min: 1, max: 60 * 24 * 30 })
      : DEFAULT_MAX_DURATION_MINUTES;

    const lower = Number(lowerPrice);
    const upper = Number(upperPrice);
    if (lower >= upper) {
      throw new Error(
        `lower_price ${lowerPrice} must be below upper_price ${upperPrice}. A grid needs a range to ` +
          'oscillate inside; the two values are probably swapped.',
      );
    }

    // The stop is the floor under the whole structure, so it has to sit below
    // the structure. A stop inside the range would fire on the first buy the
    // grid is designed to make, turning a range trade into an instant exit.
    if (stopPrice !== null && Number(stopPrice) >= lower) {
      throw new Error(
        `stop_price ${stopPrice} must be below lower_price ${lowerPrice}. A stop inside the grid would ` +
          'trigger on the ordinary weakness the grid exists to buy.',
      );
    }

    const pair = await ctx.executor.tradingPair(symbol);
    const assetIncrement = pair?.asset_increment ? String(pair.asset_increment) : null;
    const quoteIncrement = pair?.quote_increment ? String(pair.quote_increment) : null;
    const minOrderSize = Number(pair?.min_order_size ?? pair?.min_order_amount ?? 0);
    const asset = symbol.split('-')[0];

    const quantityPerGrid = roundToIncrement(Number(quantityRaw), assetIncrement ?? undefined);
    if (Number(quantityPerGrid) <= 0) {
      throw new Error(
        `quantity_per_grid ${quantityRaw} rounds to zero at the venue increment of ` +
          `${assetIncrement ?? 'the base asset'}. Increase quantity_per_grid.`,
      );
    }
    if (minOrderSize > 0 && Number(quantityPerGrid) < minOrderSize) {
      throw new Error(
        `quantity_per_grid ${quantityPerGrid} ${asset} is below the venue minimum of ${minOrderSize}. ` +
          'Increase quantity_per_grid: an order the venue rejects can never complete a grid cycle.',
      );
    }

    const levels = buildLevels(lowerPrice, upperPrice, gridLevels, quoteIncrement);

    // Levels that collapse onto the same price are not levels: the grid would
    // buy and sell at one price and bank nothing but fees for the round trip.
    for (let index = 1; index < levels.length; index++) {
      const previous = Number(levels[index - 1]);
      const current = Number(levels[index]);
      if (!(current > previous)) {
        throw new Error(
          `Levels ${index} and ${index + 1} both price at ${levels[index]} once snapped to the venue ` +
            `increment of ${quoteIncrement ?? 'the quote currency'}. Use fewer grid_levels, or widen the ` +
            'range between lower_price and upper_price.',
        );
      }
    }

    // A grid entirely above the market can never trade: every level is a sell,
    // and a spot account with no grid inventory has nothing to sell. Caught here
    // while there is still a caller to read it, rather than as an idle job.
    const price = await ctx.price(symbol, 'buy');
    if (price !== null && price < lower) {
      throw new Error(
        `The current price of ${price} is below lower_price ${lowerPrice}, so every level would be a sell ` +
          'and the grid starts with no inventory to sell. Lower the range so part of it sits below the market.',
      );
    }

    const state: GridState = {
      levels,
      quantityPerGrid,
      maxCycles,
      stopPrice,
      deadline: ctx.now + maxDurationMinutes * 60_000,
      seeded: false,
      working: [],
      queue: [],
      cyclesDone: 0,
      realizedProfit: '0',
      inventory: '0',
      lastSubmitted: 0,
      assetIncrement,
      minOrderSize,
    };

    return { state: state as unknown as Record<string, unknown>, symbol };
  },

  async advance(job: Job, ctx: StrategyContext): Promise<StrategyStep> {
    const state = job.state as unknown as GridState;

    // The supervisor records a rejected submit on the job and clears it on the
    // next advance, so this is the one moment the failure is readable. A grid
    // that placed over a rejection would re-queue the same rejection on every
    // tick for as long as the deadline allows.
    if (state.lastSubmitted > 0 && job.lastError !== null) {
      return {
        state: { ...state, lastSubmitted: 0 } as unknown as Record<string, unknown>,
        actions: [{ type: 'log', kind: 'grid_order_rejected', detail: { error: job.lastError } }],
        done: {
          status: 'failed',
          reason:
            `A grid order was rejected: ${job.lastError}. ${state.working.length} earlier order(s) are ` +
            `resting in the book and were left alone, holding ${state.inventory} of grid inventory. ` +
            'Cancel them manually if the grid is no longer wanted.',
        },
      };
    }

    if (ctx.now >= state.deadline) {
      return stopGrid(state, 'max_duration_minutes elapsed', 'grid_expired');
    }

    // Checked before this advance does anything, so the cycle that reaches the
    // cap is still allowed to log and settle on its own step, and a rejection in
    // that step is read above instead of being buried by a finished job.
    if (state.cyclesDone >= state.maxCycles) {
      return stopGrid(state, `max_cycles (${state.maxCycles}) completed`, 'grid_cycles_complete');
    }

    const price = await ctx.price(job.symbol, 'buy');
    if (price === null) {
      // Every decision below (which levels are buys, whether the stop is
      // breached) is a comparison against the market. Without one there is
      // nothing to compare, and guessing would rest real orders at levels chosen
      // from stale data.
      return {
        state: { ...state, lastSubmitted: 0 } as unknown as Record<string, unknown>,
        actions: [{ type: 'log', kind: 'grid_no_price', detail: { symbol: job.symbol } }],
      };
    }

    // The stop is the one condition that liquidates rather than merely stopping:
    // below the range the grid's thesis is gone, and its inventory was bought on
    // the way down.
    if (state.stopPrice !== null && price <= Number(state.stopPrice)) {
      return breachStop(state, job.symbol, price);
    }

    const actions: StrategyAction[] = [];
    let inventory = Number(state.inventory);
    let realizedProfit = Number(state.realizedProfit);
    let cyclesDone = state.cyclesDone;
    let queue = [...state.queue];
    const working: GridOrder[] = [];

    const open = await ctx.openOrders(job.id);

    for (const order of state.working) {
      const observed = observe(order, open.find((row) => String(row.client_order_id) === order.clientOrderId));

      // One order per level is the whole premise, so a level stays occupied
      // until its order has conclusively left the book.
      if (!isResolved(observed)) {
        working.push(observed);
        continue;
      }

      const filled = await resolvedFill(observed, ctx);

      if (filled <= 0) {
        // It left the book without trading, which means it was cancelled
        // outside this job. The level is still wanted, so it is re-queued: a
        // grid with a hole in it stops trading that step for the rest of its
        // life. The cycle cap and the deadline bound the repetition.
        actions.push({
          type: 'log',
          kind: 'grid_order_vanished',
          detail: { level: observed.level, side: observed.side, price: observed.price },
        });
        queue = enqueue(queue, state.levels.length, {
          level: observed.level,
          side: observed.side,
          entryPrice: observed.entryPrice,
        });
        continue;
      }

      if (observed.side === 'buy') {
        inventory += filled;
        actions.push({
          type: 'log',
          kind: 'grid_buy_filled',
          detail: { level: observed.level, price: observed.price, quantity: filled, inventory },
        });

        // The paired sell goes one level up: that spacing is the profit the grid
        // is being run for. The top level has nothing above it, so a fill there
        // simply holds the inventory until a lower level sells it.
        if (observed.level + 1 < state.levels.length) {
          queue = enqueue(queue, state.levels.length, {
            level: observed.level + 1,
            side: 'sell',
            entryPrice: observed.price,
          });
        } else {
          actions.push({
            type: 'log',
            kind: 'grid_top_level_filled',
            detail: { level: observed.level, price: observed.price },
          });
        }
        continue;
      }

      // A sell closes the round trip the buy opened. Profit is measured against
      // the price its own funding buy filled at, not against the level below it,
      // so a resumed or re-queued pairing cannot mis-report the result.
      inventory = Math.max(0, inventory - filled);
      const entry = Number(observed.entryPrice ?? 0);
      const profit = entry > 0 ? filled * (Number(observed.price) - entry) : 0;
      realizedProfit += profit;
      cyclesDone += 1;
      actions.push({
        type: 'log',
        kind: 'grid_sell_filled',
        detail: {
          level: observed.level,
          price: observed.price,
          entryPrice: observed.entryPrice,
          quantity: filled,
          profit: trim(profit),
          realizedProfit: trim(realizedProfit),
          cyclesDone,
        },
      });

      if (observed.level - 1 >= 0) {
        queue = enqueue(queue, state.levels.length, {
          level: observed.level - 1,
          side: 'buy',
          entryPrice: null,
        });
      }
    }

    // Seeding waits for a price because which levels are buys is defined by
    // where the market is, and at init there may have been no quote to ask.
    let seeded = state.seeded;
    if (!seeded) {
      queue = seedBuys(state.levels, price).reduce(
        (acc, item) => enqueue(acc, state.levels.length, item),
        queue,
      );
      seeded = true;
      actions.push({
        type: 'log',
        kind: 'grid_seeded',
        detail: { price, buyLevels: queue.filter((item) => item.side === 'buy').length },
      });
    }

    const quantity = state.quantityPerGrid;
    const occupied = new Map(working.map((order) => [order.level, order.side] as const));

    // Inventory already promised to a resting sell cannot fund a second one.
    let freeInventory =
      inventory - working.reduce((sum, order) => (order.side === 'sell' ? sum + Number(order.quantity) : sum), 0);

    const submits: GridOrder[] = [];
    const pending: QueuedPlacement[] = [];

    for (const item of queue) {
      // The double-placement guard, and the only thing standing between a grid
      // and twice its intended size at one price. A level already resting the
      // same side does not want a second order: the resting one is already
      // doing the job being asked for, so the request is dropped. A level
      // resting the OPPOSITE side is a different case: that placement is still
      // wanted, it just cannot happen until the level clears, so it waits.
      const resting = occupied.get(item.level);
      if (resting === item.side) continue;
      if (resting !== undefined) {
        pending.push(item);
        continue;
      }

      if (submits.length >= MAX_PLACEMENTS_PER_ADVANCE) {
        pending.push(item);
        continue;
      }

      // Spot venue: a sell is only real if the coins behind it are. An unfunded
      // sell waits in the queue for the buy that pays for it rather than being
      // sent and rejected.
      if (item.side === 'sell' && freeInventory + INVENTORY_EPSILON < Number(quantity)) {
        pending.push(item);
        continue;
      }

      const levelPrice = state.levels[item.level];
      if (levelPrice === undefined) continue;

      const order: GridOrder = {
        level: item.level,
        side: item.side,
        price: levelPrice,
        quantity,
        entryPrice: item.entryPrice,
        clientOrderId: randomUUID(),
        orderId: null,
        seenOpen: false,
        missedChecks: 0,
      };

      if (item.side === 'sell') freeInventory -= Number(quantity);
      occupied.set(item.level, item.side);
      submits.push(order);
      working.push(order);
    }

    return {
      state: {
        ...state,
        seeded,
        working,
        queue: pending,
        cyclesDone,
        realizedProfit: trim(realizedProfit),
        inventory: trim(inventory),
        lastSubmitted: submits.length,
      } as unknown as Record<string, unknown>,
      actions: [
        ...actions,
        ...submits.map((order) => ({
          type: 'submit' as const,
          order: {
            symbol: job.symbol,
            side: order.side,
            type: 'limit' as const,
            assetQuantity: order.quantity,
            limitPrice: order.price,
            timeInForce: 'gtc' as const,
            clientOrderId: order.clientOrderId,
          },
        })),
      ],
    };
  },
};

/**
 * Slack when comparing inventory against an order size.
 *
 * Inventory is accumulated by repeated float addition of fill quantities, so a
 * balance that is exactly one order size can read a hair under it. Far smaller
 * than any increment Robinhood lists, so it cannot fund a sell that inventory
 * does not actually cover.
 */
const INVENTORY_EPSILON = 1e-12;

/** Stop working the grid, pulling every resting order but holding inventory. */
function stopGrid(state: GridState, reason: string, kind: string): StrategyStep {
  return {
    state: { ...state, lastSubmitted: 0 } as unknown as Record<string, unknown>,
    actions: [
      {
        type: 'log',
        kind,
        detail: {
          cyclesDone: state.cyclesDone,
          realizedProfit: state.realizedProfit,
          inventory: state.inventory,
          cancelled: state.working.length,
        },
      },
      ...state.working
        .filter((order): order is GridOrder & { orderId: string } => order.orderId !== null)
        .map((order) => ({ type: 'cancel' as const, orderId: order.orderId })),
    ],
    done: {
      status: 'completed',
      reason:
        `${reason} after ${state.cyclesDone} cycle(s) for ${state.realizedProfit} realized. ` +
        `Resting orders were cancelled; ${state.inventory} of grid inventory is still held and was not ` +
        'sold, since liquidating it was not asked for.',
    },
  };
}

/**
 * The stop path: pull every resting order and sell what the grid accumulated.
 *
 * This is the one exit that liquidates. Below the range the grid's premise has
 * failed, and its inventory is exactly the coins it bought on the way down, so
 * leaving them held would be leaving the losing side of the trade open with no
 * job watching it.
 */
function breachStop(state: GridState, symbol: string, price: number): StrategyStep {
  const actions: StrategyAction[] = [
    {
      type: 'log',
      kind: 'grid_stop_breached',
      detail: {
        price,
        stopPrice: state.stopPrice,
        inventory: state.inventory,
        realizedProfit: state.realizedProfit,
        cyclesDone: state.cyclesDone,
      },
    },
    ...state.working
      .filter((order): order is GridOrder & { orderId: string } => order.orderId !== null)
      .map((order) => ({ type: 'cancel' as const, orderId: order.orderId })),
  ];

  const exitQuantity = roundToIncrement(Number(state.inventory), state.assetIncrement ?? undefined);
  const sellable = Number(exitQuantity) > 0 && (state.minOrderSize <= 0 || Number(exitQuantity) >= state.minOrderSize);

  if (sellable) {
    // Market, not limit: the stop already decided the price matters less than
    // being out. A limit exit here could rest through the move it exists to escape.
    actions.push({
      type: 'submit',
      order: { symbol, side: 'sell', type: 'market', assetQuantity: exitQuantity },
    });
  } else if (Number(state.inventory) > 0) {
    actions.push({
      type: 'log',
      kind: 'grid_stop_inventory_below_minimum',
      detail: { inventory: state.inventory, minOrderSize: state.minOrderSize },
    });
  }

  return {
    state: { ...state, lastSubmitted: 0 } as unknown as Record<string, unknown>,
    actions,
    done: {
      status: 'completed',
      reason:
        `stop_price ${state.stopPrice} was breached at ${price} after ${state.cyclesDone} cycle(s) for ` +
        `${state.realizedProfit} realized. Resting orders were cancelled and ` +
        (sellable
          ? `${exitQuantity} of grid inventory was sold at market.`
          : `${state.inventory} of grid inventory was left held: it is below the venue minimum of ` +
            `${state.minOrderSize} and cannot be sold as its own order.`),
    },
  };
}

/**
 * Price every level, ascending.
 *
 * The two bounds are used verbatim, because rounding them would move the prices
 * the caller explicitly chose. Only interior levels are snapped to the venue
 * increment, which is also what keeps float artifacts like 100.00000000000001
 * out of an order body.
 */
function buildLevels(
  lowerPrice: string,
  upperPrice: string,
  count: number,
  quoteIncrement: string | null,
): string[] {
  const lower = Number(lowerPrice);
  const upper = Number(upperPrice);
  const decimals = priceDecimals(lowerPrice, upperPrice);

  return Array.from({ length: count }, (_unused, index) => {
    if (index === 0) return lowerPrice;
    if (index === count - 1) return upperPrice;
    const raw = lower + ((upper - lower) * index) / (count - 1);
    return quoteIncrement !== null ? roundToIncrement(raw, quoteIncrement) : raw.toFixed(decimals);
  });
}

/**
 * Decimal places for an interior level when the venue publishes no quote
 * increment. Derived from the caller's own bounds, so an interpolated price is
 * never more precise than the range that produced it.
 */
function priceDecimals(...prices: string[]): number {
  const supplied = prices.map((price) => price.split('.')[1]?.length ?? 0);
  return Math.min(8, Math.max(2, ...supplied));
}

/** The opening buys: every level below the market, nearest to it first. */
function seedBuys(levels: string[], price: number): QueuedPlacement[] {
  return levels
    .map((value, level) => ({ level, price: Number(value) }))
    .filter((entry) => entry.price < price)
    .sort((a, b) => b.price - a.price)
    .map((entry) => ({ level: entry.level, side: 'buy' as const, entryPrice: null }));
}

/**
 * Add a placement unless the same level and side is already waiting.
 *
 * The queue is persisted state, so it is bounded by construction: two entries
 * per level is every level wanting both a buy and a sell at once, which is
 * already more than the grid can ever need.
 */
function enqueue(queue: QueuedPlacement[], levelCount: number, item: QueuedPlacement): QueuedPlacement[] {
  if (queue.some((existing) => existing.level === item.level && existing.side === item.side)) return queue;
  if (queue.length >= levelCount * 2) return queue;
  return [...queue, item];
}

/** Fold one open-orders reading into an order, learning its upstream id if present. */
function observe(order: GridOrder, open: Record<string, unknown> | undefined): GridOrder {
  if (!open) return { ...order, missedChecks: order.missedChecks + 1 };
  return {
    ...order,
    orderId: typeof open.id === 'string' ? open.id : order.orderId,
    seenOpen: true,
    missedChecks: 0,
  };
}

/** An order is resolved once it has left the open book: filled, or cancelled upstream. */
function isResolved(order: GridOrder): boolean {
  return order.seenOpen ? order.missedChecks > 0 : order.missedChecks >= ABSENCE_GRACE_CHECKS;
}

/**
 * How much of a resolved order actually traded.
 *
 * An order can leave the open book without filling: someone can cancel it
 * upstream, or it can partially fill and be pulled. Reading the true fill is
 * what keeps inventory honest, and inventory is what decides whether a sell may
 * be placed at all. When the lookup fails the submitted size is credited, which
 * the inventory guard on the sell side then re-checks before any order goes out.
 */
async function resolvedFill(order: GridOrder, ctx: StrategyContext): Promise<number> {
  if (order.orderId === null) return Number(order.quantity);

  try {
    const upstream = (await ctx.executor.getOrder(order.orderId)) as Record<string, unknown> | null;
    const filled = Number(upstream?.filled_asset_quantity ?? upstream?.cumulative_quantity);
    if (Number.isFinite(filled) && filled >= 0) return filled;
  } catch {
    // A failed lookup is an outage, not a fill report. Fall through.
  }
  return Number(order.quantity);
}

/** Trim float noise from an accumulated quantity or amount. */
function trim(value: number): string {
  return String(Number(value.toFixed(8)));
}
