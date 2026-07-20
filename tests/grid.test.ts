import { describe, it, expect } from 'vitest';
import { grid } from '../src/engine/strategies/grid.js';
import type { Job, StrategyAction, StrategyContext, StrategyStep } from '../src/engine/job.js';
import type { Executor } from '../src/shared/executor.js';

/**
 * Strategies are pure step functions, so the whole context can be a plain
 * object. Nothing here touches the network or the executor's order path: a
 * strategy that needed either would be a strategy that could not be resumed.
 */
interface FakeContextOptions {
  price?: number | null;
  assetIncrement?: string | null;
  quoteIncrement?: string | null;
  minOrderSize?: number | null;
  now?: number;
  /** Rows the supervisor would report as this job's open orders. */
  openOrders?: Array<Record<string, unknown>>;
  /** Fill quantity per upstream order id, as `getOrder` would report it. */
  fills?: Record<string, string>;
}

const NOW = 1_700_000_000_000;

function makeContext(options: FakeContextOptions = {}): StrategyContext {
  const executor = {
    async tradingPair(): Promise<Record<string, unknown> | null> {
      return {
        asset_increment: options.assetIncrement === undefined ? '0.00000001' : options.assetIncrement,
        quote_increment: options.quoteIncrement === undefined ? '0.01' : options.quoteIncrement,
        min_order_size: options.minOrderSize ?? 0,
      };
    },
    async getOrder(orderId: string): Promise<Record<string, unknown>> {
      return { id: orderId, filled_asset_quantity: options.fills?.[orderId] ?? '0' };
    },
  } as unknown as Executor;

  return {
    executor,
    now: options.now ?? NOW,
    async price(): Promise<number | null> {
      return options.price === undefined ? 160 : options.price;
    },
    async openOrders(): Promise<Array<Record<string, unknown>>> {
      return options.openOrders ?? [];
    },
  };
}

function makeJob(overrides: Partial<Job> & { state: Record<string, unknown> }): Job {
  return {
    id: 'job-1',
    strategy: 'grid',
    symbol: 'BTC-USD',
    status: 'running',
    params: {},
    nextRunAt: 0,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** Round-trip through JSON, the way the store persists and reloads a job. */
function restart(state: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
}

function submits(step: StrategyStep): Extract<StrategyAction, { type: 'submit' }>[] {
  return step.actions.filter((a): a is Extract<StrategyAction, { type: 'submit' }> => a.type === 'submit');
}

function cancels(step: StrategyStep): Extract<StrategyAction, { type: 'cancel' }>[] {
  return step.actions.filter((a): a is Extract<StrategyAction, { type: 'cancel' }> => a.type === 'cancel');
}

function logKinds(step: StrategyStep): string[] {
  return step.actions.filter((a) => a.type === 'log').map((a) => (a as { kind: string }).kind);
}

interface WorkingOrder {
  level: number;
  side: 'buy' | 'sell';
  price: string;
  quantity: string;
  entryPrice: string | null;
  clientOrderId: string;
  orderId: string | null;
}

function working(state: Record<string, unknown>): WorkingOrder[] {
  return state.working as WorkingOrder[];
}

/** Three levels at 100 / 150 / 200, with the market sitting above all of them. */
const PARAMS = {
  symbol: 'BTC-USD',
  lower_price: '100',
  upper_price: '200',
  grid_levels: 3,
  quantity_per_grid: '1',
};

async function gridState(
  overrides: Record<string, unknown> = {},
  options: FakeContextOptions = {},
): Promise<Record<string, unknown>> {
  const { state } = await grid.init({ ...PARAMS, ...overrides }, makeContext(options));
  return state;
}

/** The open-orders row the supervisor would return for a working order. */
function openRow(order: WorkingOrder, id: string): Record<string, unknown> {
  return { id, client_order_id: order.clientOrderId, state: 'open' };
}

describe('grid init', () => {
  it('prices levels evenly, using the bounds verbatim', async () => {
    const state = await gridState();
    expect(state.levels).toEqual(['100', '150.00', '200']);
  });

  it('rejects a range that is inverted', async () => {
    await expect(
      grid.init({ ...PARAMS, lower_price: '200', upper_price: '100' }, makeContext()),
    ).rejects.toThrow(/lower_price 200 must be below upper_price 100/);
  });

  it('rejects fewer than three levels', async () => {
    await expect(grid.init({ ...PARAMS, grid_levels: 2 }, makeContext())).rejects.toThrow(
      /"grid_levels" must be an integer between 3 and 50/,
    );
  });

  it('rejects a stop price inside the grid', async () => {
    await expect(
      grid.init({ ...PARAMS, stop_price: '120' }, makeContext()),
    ).rejects.toThrow(/stop_price 120 must be below lower_price 100/);
  });

  it('rejects levels that collapse onto one price at the venue increment', async () => {
    await expect(
      grid.init(
        { ...PARAMS, lower_price: '100', upper_price: '100.02', grid_levels: 10 },
        makeContext({ quoteIncrement: '0.01' }),
      ),
    ).rejects.toThrow(/both price at/);
  });

  it('rejects a per-grid quantity below the venue minimum, naming the minimum', async () => {
    await expect(
      grid.init({ ...PARAMS, quantity_per_grid: '0.1' }, makeContext({ minOrderSize: 0.5 })),
    ).rejects.toThrow(/quantity_per_grid 0.10000000 BTC is below the venue minimum of 0.5/);
  });

  it('rejects a per-grid quantity that rounds to zero at the venue increment', async () => {
    await expect(
      grid.init({ ...PARAMS, quantity_per_grid: '0.5' }, makeContext({ assetIncrement: '1' })),
    ).rejects.toThrow(/rounds to zero at the venue increment of 1/);
  });

  it('rejects a grid entirely above the market, which could only ever sell', async () => {
    await expect(grid.init(PARAMS, makeContext({ price: 50 }))).rejects.toThrow(
      /every level would be a sell and the grid starts with no inventory/,
    );
  });

  it('caps cycles and duration even when the caller names neither', async () => {
    const state = await gridState();
    expect(state.maxCycles).toBe(100);
    expect(state.deadline).toBe(NOW + 7 * 24 * 60 * 60 * 1000);
  });
});

describe('grid seeding and placement', () => {
  it('seeds a buy at every level below the market, nearest first', async () => {
    const step = await grid.advance(makeJob({ state: await gridState() }), makeContext());

    expect(logKinds(step)).toContain('grid_seeded');
    expect(submits(step).map((s) => s.order.limitPrice)).toEqual(['150.00', '100']);
    expect(submits(step).every((s) => s.order.side === 'buy')).toBe(true);
    expect(submits(step)[0]?.order).toMatchObject({
      symbol: 'BTC-USD',
      type: 'limit',
      assetQuantity: '1.00000000',
      timeInForce: 'gtc',
    });
  });

  it('places no sell while the grid holds no inventory to sell', async () => {
    // The market sits below the top level, so level 2 is a sell the grid cannot fund.
    const step = await grid.advance(makeJob({ state: await gridState() }), makeContext({ price: 160 }));
    expect(submits(step).some((s) => s.order.side === 'sell')).toBe(false);
  });

  it('never places a second order at a level that already has one resting', async () => {
    const first = await grid.advance(makeJob({ state: await gridState() }), makeContext());
    const rows = working(first.state).map((order, index) => openRow(order, `rh-${index}`));

    const second = await grid.advance(
      makeJob({ state: first.state }),
      makeContext({ openOrders: rows }),
    );

    expect(submits(second)).toHaveLength(0);
    expect(working(second.state)).toHaveLength(2);
    expect(working(second.state).map((order) => order.orderId)).toEqual(['rh-0', 'rh-1']);
  });

  it('spreads placement across advances rather than sending the whole grid at once', async () => {
    const state = await gridState({ grid_levels: 11, upper_price: '200' }, { price: 250 });

    const first = await grid.advance(makeJob({ state }), makeContext({ price: 250 }));
    expect(submits(first)).toHaveLength(4);
    expect((first.state.queue as unknown[]).length).toBe(7);

    const second = await grid.advance(makeJob({ state: first.state }), makeContext({ price: 250 }));
    expect(submits(second)).toHaveLength(4);
  });
});

describe('grid fills', () => {
  /** Run the grid until both seeded buys are resting with known upstream ids. */
  async function resting(): Promise<{ state: Record<string, unknown>; rows: Array<Record<string, unknown>> }> {
    const first = await grid.advance(makeJob({ state: await gridState() }), makeContext());
    const rows = working(first.state).map((order, index) => openRow(order, `rh-${index}`));
    const second = await grid.advance(makeJob({ state: first.state }), makeContext({ openOrders: rows }));
    return { state: second.state, rows };
  }

  it('credits a buy fill to inventory and pairs it with a sell one level up', async () => {
    const { state, rows } = await resting();

    // The 150 buy (rh-0) leaves the book; the 100 buy is still resting.
    const step = await grid.advance(
      makeJob({ state }),
      makeContext({ price: 150, openOrders: [rows[1] as Record<string, unknown>], fills: { 'rh-0': '1' } }),
    );

    expect(logKinds(step)).toContain('grid_buy_filled');
    expect(step.state.inventory).toBe('1');
    const sell = submits(step).find((s) => s.order.side === 'sell');
    expect(sell?.order).toMatchObject({ side: 'sell', limitPrice: '200', assetQuantity: '1.00000000' });
    expect(working(step.state).find((order) => order.level === 2)?.entryPrice).toBe('150.00');
  });

  it('banks the spacing when the paired sell fills, and re-queues the buy one level down', async () => {
    const { state, rows } = await resting();
    const filled = await grid.advance(
      makeJob({ state }),
      makeContext({ price: 150, openOrders: [rows[1] as Record<string, unknown>], fills: { 'rh-0': '1' } }),
    );

    // The new sell at 200 rests, then fills.
    const sellOrder = working(filled.state).find((order) => order.level === 2) as WorkingOrder;
    const seen = await grid.advance(
      makeJob({ state: filled.state }),
      makeContext({ price: 200, openOrders: [rows[1] as Record<string, unknown>, openRow(sellOrder, 'rh-sell')] }),
    );
    const step = await grid.advance(
      makeJob({ state: seen.state }),
      makeContext({
        price: 200,
        openOrders: [rows[1] as Record<string, unknown>],
        fills: { 'rh-sell': '1' },
      }),
    );

    expect(logKinds(step)).toContain('grid_sell_filled');
    // Bought at 150.00, sold at 200, one unit: 50 of realized grid profit.
    expect(step.state.realizedProfit).toBe('50');
    expect(step.state.cyclesDone).toBe(1);
    expect(step.state.inventory).toBe('0');
    // The buy one level down goes back out, restoring the level the sell vacated.
    expect(submits(step).map((s) => s.order).filter((o) => o.side === 'buy')).toHaveLength(1);
    expect(submits(step)[0]?.order.limitPrice).toBe('150.00');
  });

  it('re-queues an order that left the book without trading', async () => {
    const { state, rows } = await resting();

    const step = await grid.advance(
      makeJob({ state }),
      makeContext({ openOrders: [rows[1] as Record<string, unknown>], fills: { 'rh-0': '0' } }),
    );

    expect(logKinds(step)).toContain('grid_order_vanished');
    expect(step.state.inventory).toBe('0');
    expect(submits(step).map((s) => s.order.limitPrice)).toEqual(['150.00']);
  });

  it('resumes from persisted JSON without re-placing a resting level', async () => {
    const { state, rows } = await resting();

    const step = await grid.advance(makeJob({ state: restart(state) }), makeContext({ openOrders: rows }));

    expect(submits(step)).toHaveLength(0);
    expect(working(step.state)).toHaveLength(2);
    expect(step.state.seeded).toBe(true);
  });
});

describe('grid termination', () => {
  it('stops on the deadline, cancelling resting orders and keeping inventory', async () => {
    const first = await grid.advance(makeJob({ state: await gridState() }), makeContext());
    const rows = working(first.state).map((order, index) => openRow(order, `rh-${index}`));
    const seen = await grid.advance(makeJob({ state: first.state }), makeContext({ openOrders: rows }));

    const step = await grid.advance(
      makeJob({ state: seen.state }),
      makeContext({ now: NOW + 8 * 24 * 60 * 60 * 1000 }),
    );

    expect(step.done?.status).toBe('completed');
    expect(step.done?.reason).toMatch(/max_duration_minutes elapsed/);
    expect(cancels(step).map((c) => c.orderId)).toEqual(['rh-0', 'rh-1']);
    expect(logKinds(step)).toContain('grid_expired');
  });

  it('stops once the cycle cap is reached', async () => {
    const state = await gridState({ max_cycles: 2 });
    const step = await grid.advance(makeJob({ state: { ...state, cyclesDone: 2 } }), makeContext());

    expect(step.done?.status).toBe('completed');
    expect(step.done?.reason).toMatch(/max_cycles \(2\) completed/);
    expect(logKinds(step)).toContain('grid_cycles_complete');
    expect(submits(step)).toHaveLength(0);
  });

  it('halts and liquidates when the stop price is breached', async () => {
    const state = await gridState({ stop_price: '90' });
    const first = await grid.advance(makeJob({ state }), makeContext());
    const rows = working(first.state).map((order, index) => openRow(order, `rh-${index}`));
    const seen = await grid.advance(makeJob({ state: first.state }), makeContext({ openOrders: rows }));

    const step = await grid.advance(
      makeJob({ state: { ...seen.state, inventory: '2' } }),
      makeContext({ price: 85 }),
    );

    expect(step.done?.status).toBe('completed');
    expect(step.done?.reason).toMatch(/stop_price 90 was breached at 85/);
    expect(cancels(step)).toHaveLength(2);
    expect(submits(step)[0]?.order).toMatchObject({ side: 'sell', type: 'market', assetQuantity: '2.00000000' });
    expect(logKinds(step)).toContain('grid_stop_breached');
  });

  it('leaves inventory below the venue minimum unsold at the stop, and says so', async () => {
    const state = await gridState({ stop_price: '90', quantity_per_grid: '1' }, { minOrderSize: 0.5 });
    const step = await grid.advance(
      makeJob({ state: { ...state, inventory: '0.1' } }),
      makeContext({ price: 85, minOrderSize: 0.5 }),
    );

    expect(submits(step)).toHaveLength(0);
    expect(step.done?.reason).toMatch(/below the venue minimum of 0.5/);
    expect(logKinds(step)).toContain('grid_stop_inventory_below_minimum');
  });

  it('stops on a rejected order and leaves the resting ones alone', async () => {
    const first = await grid.advance(makeJob({ state: await gridState() }), makeContext());

    const step = await grid.advance(
      makeJob({ state: first.state, lastError: 'Sell orders are blocked by ROBINHOOD_CRYPTO_BUY_ONLY=1.' }),
      makeContext(),
    );

    expect(step.done?.status).toBe('failed');
    expect(step.done?.reason).toMatch(/A grid order was rejected/);
    // Cancelling here would undo fills the grid may already have collected.
    expect(cancels(step)).toHaveLength(0);
    expect(logKinds(step)).toContain('grid_order_rejected');
  });
});

describe('grid without a price', () => {
  it('skips the tick rather than guessing where the market is', async () => {
    const state = await gridState();
    const step = await grid.advance(makeJob({ state }), makeContext({ price: null }));

    expect(submits(step)).toHaveLength(0);
    expect(cancels(step)).toHaveLength(0);
    expect(step.done).toBeUndefined();
    expect(step.state.seeded).toBe(false);
    expect(logKinds(step)).toEqual(['grid_no_price']);
  });

  it('still initialises when the venue publishes no quote, deferring the seed', async () => {
    const state = await gridState({}, { price: null });
    expect(state.seeded).toBe(false);

    const step = await grid.advance(makeJob({ state }), makeContext({ price: 160 }));
    expect(submits(step)).toHaveLength(2);
  });
});
