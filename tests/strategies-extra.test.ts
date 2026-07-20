import { describe, it, expect } from 'vitest';
import { dca } from '../src/engine/strategies/dca.js';
import { ladder } from '../src/engine/strategies/ladder.js';
import { rebalance } from '../src/engine/strategies/rebalance.js';
import type { Job, StrategyAction, StrategyContext, StrategyStep } from '../src/engine/job.js';
import type { Executor } from '../src/shared/executor.js';

/**
 * Strategies are pure step functions, so the whole context is a plain object.
 * Nothing here touches the network or the executor's order path: a strategy that
 * needed either would be a strategy that could not be resumed.
 *
 * This context is per-symbol where the shared one in `strategies.test.ts` is
 * not, because a rebalance prices a whole basket in a single advance and its
 * behaviour is only interesting when the assets disagree.
 */
interface FakeContextOptions {
  /** Price per symbol. A null value is an asset the venue could not quote. */
  prices?: Record<string, number | null>;
  /** Fallback for symbols absent from `prices`. */
  price?: number | null;
  holdings?: Array<Record<string, unknown>>;
  assetIncrement?: string | null;
  quoteIncrement?: string | null;
  minOrderSize?: number | null;
  /** Symbols the venue does not list at all. */
  unknownPairs?: string[];
  now?: number;
}

const NOW = 1_700_000_000_000;

function makeContext(options: FakeContextOptions = {}): StrategyContext {
  const executor = {
    async tradingPair(symbol: string): Promise<Record<string, unknown> | null> {
      if (options.unknownPairs?.includes(symbol)) return null;
      return {
        asset_increment: options.assetIncrement === undefined ? '0.00000001' : options.assetIncrement,
        quote_increment: options.quoteIncrement === undefined ? '0.01' : options.quoteIncrement,
        min_order_size: options.minOrderSize ?? 0,
      };
    },
    async holdings(): Promise<Array<Record<string, unknown>>> {
      return options.holdings ?? [];
    },
  } as unknown as Executor;

  return {
    executor,
    now: options.now ?? NOW,
    async price(symbol: string): Promise<number | null> {
      const perSymbol = options.prices?.[symbol];
      if (perSymbol !== undefined) return perSymbol;
      return options.price === undefined ? 100 : options.price;
    },
    async openOrders(): Promise<Array<Record<string, unknown>>> {
      return [];
    },
  };
}

function makeJob(overrides: Partial<Job> & { state: Record<string, unknown> }): Job {
  return {
    id: 'job-1',
    strategy: 'test',
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

function logKinds(step: StrategyStep): string[] {
  return step.actions.filter((a) => a.type === 'log').map((a) => (a as { kind: string }).kind);
}

function logDetail(step: StrategyStep, kind: string): Record<string, unknown> | undefined {
  const found = step.actions.find((a) => a.type === 'log' && (a as { kind: string }).kind === kind);
  return found === undefined ? undefined : ((found as { detail?: Record<string, unknown> }).detail ?? {});
}

const DCA_PARAMS = {
  symbol: 'BTC-USD',
  side: 'buy',
  quote_amount_per_buy: '200',
  interval_hours: 168,
  occurrences: 4,
};

async function dcaState(overrides: Record<string, unknown> = {}, ctx = makeContext()) {
  const { state } = await dca.init({ ...DCA_PARAMS, ...overrides }, ctx);
  return state;
}

describe('dca init', () => {
  it('requires exactly one sizing unit', async () => {
    await expect(
      dca.init({ ...DCA_PARAMS, quote_amount_per_buy: undefined }, makeContext()),
    ).rejects.toThrow(/exactly one of "quote_amount_per_buy"/);

    await expect(
      dca.init({ ...DCA_PARAMS, asset_quantity_per_buy: '0.01' }, makeContext()),
    ).rejects.toThrow(/exactly one of "quote_amount_per_buy"/);
  });

  it('rejects a cadence fast enough to be a TWAP instead', async () => {
    await expect(
      dca.init({ ...DCA_PARAMS, interval_hours: 0.05 }, makeContext()),
    ).rejects.toThrow(/"interval_hours" must be a number between 0.25 and/);
  });

  it('converts the quote amount at the live price to check the venue minimum', async () => {
    // $200 at $100,000 is 0.002 BTC, under a 0.01 minimum. The remediation has
    // to name the amount that would work, which is the minimum times the price.
    await expect(
      dca.init(DCA_PARAMS, makeContext({ price: 100_000, minOrderSize: 0.01 })),
    ).rejects.toThrow(/Raise quote_amount_per_buy to at least 1000.00/);

    // The same $200 at $100 is 2 BTC, comfortably above it.
    const state = await dcaState({}, makeContext({ price: 100, minOrderSize: 0.01 }));
    expect(state.occurrencesDone).toBe(0);
    expect(state.quoteAmountPerBuy).toBe('200');
    expect(state.assetQuantityPerBuy).toBeNull();
  });

  it('does not block a plan just because the venue could not be quoted at init', async () => {
    const state = await dcaState({}, makeContext({ price: null, minOrderSize: 0.01 }));
    expect(state.quoteAmountPerBuy).toBe('200');
  });

  it('checks an asset-denominated size against the minimum directly', async () => {
    await expect(
      dca.init(
        { ...DCA_PARAMS, quote_amount_per_buy: undefined, asset_quantity_per_buy: '0.0001' },
        makeContext({ minOrderSize: 0.01 }),
      ),
    ).rejects.toThrow(/below the venue minimum of 0.01/);
  });

  it('stores the interval in milliseconds so the cadence survives a restart', async () => {
    const state = await dcaState();
    expect(state.intervalMs).toBe(168 * 60 * 60 * 1000);
    expect(restart(state).intervalMs).toBe(168 * 60 * 60 * 1000);
  });
});

describe('dca execution', () => {
  it('buys the quote amount at the live price and schedules the next interval', async () => {
    const state = await dcaState();
    const step = await dca.advance(makeJob({ state }), makeContext({ price: 250 }));

    expect(submits(step)).toHaveLength(1);
    expect(submits(step)[0]?.order).toMatchObject({
      symbol: 'BTC-USD',
      side: 'buy',
      type: 'limit',
      quoteAmount: '200',
      limitPrice: '250',
    });
    expect(step.state.occurrencesDone).toBe(1);
    expect(step.nextRunAt).toBe(NOW + 168 * 60 * 60 * 1000);
    expect(step.done).toBeUndefined();
  });

  it('sizes an asset-denominated buy in the base asset, at market', async () => {
    const state = await dcaState({ quote_amount_per_buy: undefined, asset_quantity_per_buy: '0.005' });
    const step = await dca.advance(makeJob({ state }), makeContext());

    expect(submits(step)[0]?.order).toMatchObject({
      type: 'market',
      assetQuantity: '0.00500000',
    });
    expect(submits(step)[0]?.order.quoteAmount).toBeUndefined();
  });

  it('completes on the last occurrence and never buys past the count', async () => {
    let state = await dcaState({ occurrences: 2 });

    const first = await dca.advance(makeJob({ state }), makeContext());
    expect(first.done).toBeUndefined();
    state = first.state;

    const second = await dca.advance(makeJob({ state }), makeContext());
    expect(second.done).toEqual({ status: 'completed' });
    expect(submits(second)).toHaveLength(1);
    state = second.state;

    // A supervisor that advances a finished job once more must not buy again.
    const extra = await dca.advance(makeJob({ state: restart(state) }), makeContext());
    expect(submits(extra)).toHaveLength(0);
    expect(extra.done).toEqual({ status: 'completed' });
  });

  it('resumes the count out of persisted JSON after a restart', async () => {
    const state = await dcaState({ occurrences: 4 });
    const afterOne = (await dca.advance(makeJob({ state }), makeContext())).state;

    const step = await dca.advance(makeJob({ state: restart(afterOne) }), makeContext());
    expect(step.state.occurrencesDone).toBe(2);
  });
});

describe('dca skips', () => {
  it('skips a tick with no price without consuming an occurrence', async () => {
    const state = await dcaState();
    const step = await dca.advance(makeJob({ state }), makeContext({ price: null }));

    expect(submits(step)).toHaveLength(0);
    expect(logKinds(step)).toEqual(['dca_no_price']);
    expect(step.state.occurrencesDone).toBe(0);
    expect(step.done).toBeUndefined();

    // The occurrence is still owed, and the next priced tick pays it.
    const retry = await dca.advance(makeJob({ state: step.state }), makeContext({ price: 100 }));
    expect(submits(retry)).toHaveLength(1);
    expect(retry.state.occurrencesDone).toBe(1);
  });

  it('skips above max_price without consuming an occurrence', async () => {
    const state = await dcaState({ max_price: '150' });

    const skipped = await dca.advance(makeJob({ state }), makeContext({ price: 200 }));
    expect(submits(skipped)).toHaveLength(0);
    expect(logKinds(skipped)).toEqual(['dca_buy_skipped']);
    expect(logDetail(skipped, 'dca_buy_skipped')).toMatchObject({ price: 200, maxPrice: 150 });
    expect(skipped.state.occurrencesDone).toBe(0);

    const bought = await dca.advance(makeJob({ state }), makeContext({ price: 140 }));
    expect(submits(bought)).toHaveLength(1);
    expect(bought.state.occurrencesDone).toBe(1);
  });

  it('reads max_price as a floor on the sell side', async () => {
    const state = await dcaState({ side: 'sell', max_price: '150' });

    const skipped = await dca.advance(makeJob({ state }), makeContext({ price: 140 }));
    expect(submits(skipped)).toHaveLength(0);
    expect(skipped.state.occurrencesDone).toBe(0);

    const sold = await dca.advance(makeJob({ state }), makeContext({ price: 160 }));
    expect(submits(sold)).toHaveLength(1);
  });

  it('will not skip forever: a ceiling never met leaves the count untouched', async () => {
    const state = await dcaState({ max_price: '10' });
    let current = state;
    for (let tick = 0; tick < 5; tick++) {
      current = (await dca.advance(makeJob({ state: current }), makeContext({ price: 500 }))).state;
    }
    expect(current.occurrencesDone).toBe(0);
  });
});

const LADDER_PARAMS = {
  symbol: 'BTC-USD',
  side: 'buy',
  total_quantity: '1',
  levels: 5,
  start_price: '100',
  end_price: '90',
};

async function ladderState(overrides: Record<string, unknown> = {}, ctx = makeContext()) {
  const { state } = await ladder.init({ ...LADDER_PARAMS, ...overrides }, ctx);
  return state;
}

function rungs(state: Record<string, unknown>): Array<{ price: string; quantity: string; clientOrderId: string }> {
  return state.rungs as Array<{ price: string; quantity: string; clientOrderId: string }>;
}

/** Drain every batch the ladder places, the way the supervisor would over ticks. */
async function drain(state: Record<string, unknown>): Promise<StrategyStep[]> {
  const steps: StrategyStep[] = [];
  let current = state;
  for (let tick = 0; tick < 40; tick++) {
    const step = await ladder.advance(makeJob({ state: restart(current) }), makeContext());
    steps.push(step);
    if (step.done) break;
    current = step.state;
  }
  return steps;
}

describe('ladder init', () => {
  it('spaces prices evenly from start to end, endpoints verbatim', async () => {
    const state = await ladderState();
    expect(rungs(state).map((rung) => rung.price)).toEqual(['100', '97.50', '95.00', '92.50', '90']);
  });

  it('spaces an ascending sell ladder the same way', async () => {
    const state = await ladderState({
      side: 'sell',
      start_price: '100',
      end_price: '120',
      levels: 3,
    });
    expect(rungs(state).map((rung) => rung.price)).toEqual(['100', '110.00', '120']);
  });

  it('sizes every level at total_quantity / levels', async () => {
    const state = await ladderState();
    const quantities = rungs(state).map((rung) => rung.quantity);
    expect(quantities).toEqual([
      '0.20000000',
      '0.20000000',
      '0.20000000',
      '0.20000000',
      '0.20000000',
    ]);

    // The ladder must place the whole total, not a rounded-down approximation.
    const placed = quantities.reduce((sum, quantity) => sum + Number(quantity), 0);
    expect(placed).toBeCloseTo(1, 8);
  });

  it('assigns sizes cumulatively so rounding dust does not shrink the total', async () => {
    // 1 / 3 does not divide into the increment, so a naive per-level round would
    // place 0.99 and quietly lose the remainder.
    const state = await ladderState({ levels: 3, total_quantity: '1', end_price: '94' }, makeContext({ assetIncrement: '0.01' }));
    const quantities = rungs(state).map((rung) => rung.quantity);
    const placed = quantities.reduce((sum, quantity) => sum + Number(quantity), 0);
    expect(placed).toBeCloseTo(1, 8);
  });

  it('rejects a ladder whose per-level size is below the venue minimum, naming the level', async () => {
    await expect(
      ladder.init(LADDER_PARAMS, makeContext({ minOrderSize: 0.5 })),
    ).rejects.toThrow(/Level 1 of 5 would be 0.20000000 BTC, below the venue minimum of 0.5/);
  });

  it('rejects a ladder whose per-level size rounds to zero', async () => {
    await expect(
      ladder.init({ ...LADDER_PARAMS, total_quantity: '0.001', levels: 50 }, makeContext({ assetIncrement: '0.01' })),
    ).rejects.toThrow(/rounds to zero at the venue increment/);
  });

  it('rejects a reversed range on either side', async () => {
    await expect(
      ladder.init({ ...LADDER_PARAMS, start_price: '90', end_price: '100' }, makeContext()),
    ).rejects.toThrow(/A buy ladder must descend/);

    await expect(
      ladder.init(
        { ...LADDER_PARAMS, side: 'sell', start_price: '120', end_price: '110' },
        makeContext({ price: 130 }),
      ),
    ).rejects.toThrow(/A sell ladder must ascend/);
  });

  it('rejects a single price repeated', async () => {
    await expect(
      ladder.init({ ...LADDER_PARAMS, start_price: '100', end_price: '100' }, makeContext()),
    ).rejects.toThrow(/rather than a ladder/);
  });

  it('rejects a ladder that would fill at the touch instead of resting', async () => {
    // Market is 90, so a buy ladder starting at 100 is marketable on every rung.
    await expect(
      ladder.init(LADDER_PARAMS, makeContext({ price: 90 })),
    ).rejects.toThrow(/would fill at the touch instead of resting/);
  });

  it('mints one client order id per rung so a restart cannot double-place', async () => {
    const state = await ladderState();
    const ids = rungs(state).map((rung) => rung.clientOrderId);
    expect(new Set(ids).size).toBe(5);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('ladder placement', () => {
  it('places every rung as a resting limit order, then completes', async () => {
    const state = await ladderState();
    const steps = await drain(state);
    const placed = steps.flatMap((step) => submits(step));

    expect(placed).toHaveLength(5);
    expect(steps.at(-1)?.done).toEqual({ status: 'completed' });

    for (const [index, action] of placed.entries()) {
      expect(action.order).toMatchObject({
        symbol: 'BTC-USD',
        side: 'buy',
        type: 'limit',
        timeInForce: 'gtc',
        assetQuantity: rungs(state)[index]?.quantity,
        limitPrice: rungs(state)[index]?.price,
        clientOrderId: rungs(state)[index]?.clientOrderId,
      });
    }
  });

  it('carries an explicit time_in_force onto every rung', async () => {
    const state = await ladderState({ time_in_force: 'day' });
    const placed = (await drain(state)).flatMap((step) => submits(step));
    expect(placed).toHaveLength(5);
    for (const action of placed) expect(action.order.timeInForce).toBe('day');
  });

  it('stops laddering when a rung is rejected, and leaves the resting ones alone', async () => {
    const state = await ladderState();
    const first = await ladder.advance(makeJob({ state }), makeContext());

    const step = await ladder.advance(
      makeJob({ state: first.state, lastError: 'Order value $900.00 exceeds ROBINHOOD_CRYPTO_MAX_ORDER_USD' }),
      makeContext(),
    );

    expect(step.done?.status).toBe('failed');
    expect(step.done?.reason).toMatch(/could not be placed/);
    expect(submits(step)).toHaveLength(0);
  });

  it('weights size toward the near end with distribution "front"', async () => {
    const state = await ladderState({ distribution: 'front', levels: 3 });
    const quantities = rungs(state).map((rung) => Number(rung.quantity));

    expect(quantities[0]).toBeGreaterThan(quantities[1] ?? 0);
    expect(quantities[1]).toBeGreaterThan(quantities[2] ?? 0);
    expect(quantities.reduce((sum, quantity) => sum + quantity, 0)).toBeCloseTo(1, 8);
  });

  it('weights size toward the far end with distribution "back"', async () => {
    const state = await ladderState({ distribution: 'back', levels: 3 });
    const quantities = rungs(state).map((rung) => Number(rung.quantity));

    expect(quantities[0]).toBeLessThan(quantities[1] ?? 0);
    expect(quantities[1]).toBeLessThan(quantities[2] ?? 0);
  });
});


/**
 * Weights are fractions of 1, keyed by trading pair rather than asset code, and
 * the tolerance is in basis points of the whole portfolio.
 */
const REBALANCE_PARAMS = {
  targets: { 'BTC-USD': 0.5, 'ETH-USD': 0.5 },
  tolerance_bps: 500,
  max_legs_per_tick: 5,
};

/** A basket sitting exactly on target: 100 USD of each side. */
const BALANCED = {
  holdings: [holding('BTC', '1'), holding('ETH', '100')],
  prices: { 'BTC-USD': 100, 'ETH-USD': 1 },
};

/** BTC 150 against ETH 50: a 25 point drift each way on a 200 USD portfolio. */
const DRIFTED = {
  holdings: [holding('BTC', '1'), holding('ETH', '50')],
  prices: { 'BTC-USD': 150, 'ETH-USD': 1 },
};

async function rebalanceState(overrides: Record<string, unknown> = {}, ctx = makeContext(DRIFTED)) {
  const { state } = await rebalance.init({ ...REBALANCE_PARAMS, ...overrides }, ctx);
  return state;
}

function holding(assetCode: string, quantity: string): Record<string, unknown> {
  return { asset_code: assetCode, total_quantity: quantity };
}

function legs(state: Record<string, unknown>): Array<Record<string, unknown>> {
  return state.legs as Array<Record<string, unknown>>;
}

function leg(state: Record<string, unknown>, symbol: string): Record<string, unknown> {
  return legs(state).find((row) => row.symbol === symbol) ?? {};
}

describe('rebalance init', () => {
  it('requires targets to be a symbol-to-weight object', async () => {
    await expect(
      rebalance.init({ ...REBALANCE_PARAMS, targets: 'BTC-USD' }, makeContext(DRIFTED)),
    ).rejects.toThrow(/"targets" must be an object mapping trading pair symbols/);
  });

  it('requires pair symbols, not bare asset codes', async () => {
    await expect(
      rebalance.init({ ...REBALANCE_PARAMS, targets: { BTC: 0.5, ETH: 0.5 } }, makeContext(DRIFTED)),
    ).rejects.toThrow(/Use the pair, not the asset code/);
  });

  it('requires weights that are fractions of 1 and sum to 1', async () => {
    await expect(
      rebalance.init({ ...REBALANCE_PARAMS, targets: { 'BTC-USD': 50, 'ETH-USD': 50 } }, makeContext(DRIFTED)),
    ).rejects.toThrow(/must be a number between 0 and 1/);

    await expect(
      rebalance.init({ ...REBALANCE_PARAMS, targets: { 'BTC-USD': 0.5, 'ETH-USD': 0.3 } }, makeContext(DRIFTED)),
    ).rejects.toThrow(/sum to 0.8000, not 1.0/);
  });

  it('rejects a symbol the venue does not list, before anything is sold to fund it', async () => {
    await expect(
      rebalance.init(
        { ...REBALANCE_PARAMS, targets: { 'BTC-USD': 0.5, 'DOGE-USD': 0.5 } },
        makeContext({ ...DRIFTED, unknownPairs: ['DOGE-USD'] }),
      ),
    ).rejects.toThrow(/not a tradable pair on Robinhood Crypto/);
  });

  it('rejects a portfolio that is worth nothing', async () => {
    await expect(
      rebalance.init(REBALANCE_PARAMS, makeContext({ holdings: [] })),
    ).rejects.toThrow(/worth 0 in this account/);
  });

  it('freezes the plan at init: one leg per target, valued once', async () => {
    const state = await rebalanceState();

    expect(state.portfolioUsd).toBe('200');
    expect(leg(state, 'BTC-USD')).toMatchObject({ side: 'sell', status: 'pending', deltaUsd: '50' });
    expect(leg(state, 'ETH-USD')).toMatchObject({ side: 'buy', status: 'pending', deltaUsd: '50' });
  });

  it('leaves held assets outside the targets alone, and records them', async () => {
    const state = await rebalanceState(
      {},
      makeContext({
        holdings: [...DRIFTED.holdings, holding('DOGE', '1000')],
        prices: DRIFTED.prices,
      }),
    );

    expect(state.ignoredAssets).toEqual(['DOGE']);
    expect(legs(state).map((row) => row.symbol)).toEqual(['BTC-USD', 'ETH-USD']);
  });
});

describe('rebalance tolerance band', () => {
  it('trades nothing when every leg is inside the band', async () => {
    const state = await rebalanceState({}, makeContext(BALANCED));

    expect(legs(state).every((row) => row.status === 'within_tolerance')).toBe(true);

    const step = await rebalance.advance(makeJob({ state }), makeContext(BALANCED));
    expect(submits(step)).toHaveLength(0);
    expect(step.done?.status).toBe('completed');
    expect(step.done?.reason).toMatch(/2 already inside the 500 bps band/);
  });

  it('keeps a drift smaller than the band inside it', async () => {
    // 104 against 100 is a 1.96% drift, under a 500 bps band.
    const nearlyBalanced = {
      holdings: BALANCED.holdings,
      prices: { 'BTC-USD': 104, 'ETH-USD': 1 },
    };
    const state = await rebalanceState({}, makeContext(nearlyBalanced));

    expect(legs(state).every((row) => row.status === 'within_tolerance')).toBe(true);
    expect(submits(await rebalance.advance(makeJob({ state }), makeContext(nearlyBalanced)))).toHaveLength(0);
  });

  it('widening the band leaves the same drift untraded', async () => {
    // 3000 bps of a 200 USD portfolio is 60 USD, wider than the 50 USD drift.
    const state = await rebalanceState({ tolerance_bps: 3000 });

    expect(legs(state).every((row) => row.status === 'within_tolerance')).toBe(true);
    expect(submits(await rebalance.advance(makeJob({ state }), makeContext(DRIFTED)))).toHaveLength(0);
  });

  it('corrects in the right direction on each side of the target', async () => {
    const state = await rebalanceState();

    // BTC is 75% of the basket against a 50% target, so it sells; ETH is 25%
    // against the same target, so it buys.
    expect(leg(state, 'BTC-USD').side).toBe('sell');
    expect(leg(state, 'ETH-USD').side).toBe('buy');
  });
});

describe('rebalance execution', () => {
  it('sells first, and never alongside a buy in the same tick', async () => {
    const state = await rebalanceState();

    const first = await rebalance.advance(makeJob({ state }), makeContext(DRIFTED));
    expect(submits(first)).toHaveLength(1);
    expect(submits(first)[0]?.order).toMatchObject({
      symbol: 'BTC-USD',
      side: 'sell',
      type: 'market',
    });
    // 50 USD at 150 is a third of a coin.
    expect(Number(submits(first)[0]?.order.assetQuantity)).toBeCloseTo(50 / 150, 6);
    expect(first.done).toBeUndefined();

    const second = await rebalance.advance(makeJob({ state: restart(first.state) }), makeContext(DRIFTED));
    expect(submits(second)).toHaveLength(1);
    expect(submits(second)[0]?.order).toMatchObject({ symbol: 'ETH-USD', side: 'buy' });
    expect(Number(submits(second)[0]?.order.assetQuantity)).toBeCloseTo(50, 6);
    expect(second.done?.status).toBe('completed');
  });

  it('sizes a leg at the price of the tick it executes on, not the plan mark', async () => {
    const state = await rebalanceState();

    // The mark was 150; by execution BTC is 200, so the same 50 USD correction
    // is a smaller quantity.
    const step = await rebalance.advance(
      makeJob({ state }),
      makeContext({ ...DRIFTED, prices: { 'BTC-USD': 200, 'ETH-USD': 1 } }),
    );

    expect(Number(submits(step)[0]?.order.assetQuantity)).toBeCloseTo(50 / 200, 6);
  });

  it('never sells more of an asset than the plan saw in the account', async () => {
    // A 0.1 BTC holding worth 1000 USD against a 10 USD ETH position: the sell
    // leg is capped by the balance, not by the drift.
    const state = await rebalanceState(
      {},
      makeContext({
        holdings: [holding('BTC', '0.1'), holding('ETH', '10')],
        prices: { 'BTC-USD': 10_000, 'ETH-USD': 1 },
      }),
    );

    const step = await rebalance.advance(
      makeJob({ state }),
      makeContext({ prices: { 'BTC-USD': 10_000, 'ETH-USD': 1 } }),
    );

    expect(Number(submits(step)[0]?.order.assetQuantity)).toBeLessThanOrEqual(0.1);
  });

  it('respects max_legs_per_tick', async () => {
    // Three overweight sells, one leg per tick.
    const threeWay = {
      holdings: [holding('BTC', '1'), holding('ETH', '1'), holding('SOL', '1')],
      prices: { 'BTC-USD': 100, 'ETH-USD': 100, 'SOL-USD': 100 },
    };
    const state = await rebalanceState(
      {
        targets: { 'BTC-USD': 0.2, 'ETH-USD': 0.2, 'SOL-USD': 0.6 },
        max_legs_per_tick: 1,
      },
      makeContext(threeWay),
    );

    const step = await rebalance.advance(makeJob({ state }), makeContext(threeWay));
    expect(submits(step)).toHaveLength(1);
    expect(submits(step)[0]?.order.side).toBe('sell');
  });

  it('stops the whole rebalance when a leg is rejected, rather than buying against proceeds that never arrived', async () => {
    const state = await rebalanceState();
    const first = await rebalance.advance(makeJob({ state }), makeContext(DRIFTED));

    const step = await rebalance.advance(
      makeJob({ state: first.state, lastError: 'Sell orders are blocked by ROBINHOOD_CRYPTO_BUY_ONLY=1.' }),
      makeContext(DRIFTED),
    );

    expect(step.done?.status).toBe('failed');
    expect(step.done?.reason).toMatch(/was rejected/);
    expect(submits(step)).toHaveLength(0);
    expect(logKinds(step)).toContain('rebalance_leg_rejected');
  });

  it('sizes every leg but sends nothing on a dry run', async () => {
    const state = await rebalanceState({ dry_run: true });

    // Sells still go before buys on a dry run, so the plan takes the same two
    // ticks it would have taken live.
    const first = await rebalance.advance(makeJob({ state }), makeContext(DRIFTED));
    expect(submits(first)).toHaveLength(0);
    expect(logKinds(first)).toContain('rebalance_dry_run_leg');

    const second = await rebalance.advance(makeJob({ state: first.state }), makeContext(DRIFTED));
    expect(submits(second)).toHaveLength(0);
    expect(second.done?.reason).toMatch(/Dry run/);
  });

  it('rejects a non-boolean dry_run', async () => {
    await expect(rebalanceState({ dry_run: 'yes' })).rejects.toThrow(/"dry_run" must be a boolean/);
  });

  it('resumes from persisted JSON after a restart', async () => {
    const state = await rebalanceState();
    const first = await rebalance.advance(makeJob({ state }), makeContext(DRIFTED));

    // The sell is already recorded as submitted, so a restart picks up the buy.
    const resumed = await rebalance.advance(makeJob({ state: restart(first.state) }), makeContext(DRIFTED));
    expect(submits(resumed)).toHaveLength(1);
    expect(submits(resumed)[0]?.order.symbol).toBe('ETH-USD');
  });
});

describe('rebalance unpriced and untradeable legs', () => {
  it('refuses to plan at all when one target cannot be priced', async () => {
    // The portfolio total is a sum over every target, so one missing quote
    // mis-sizes every other leg. There is no partial plan worth building.
    await expect(
      rebalance.init(
        { ...REBALANCE_PARAMS, targets: { 'BTC-USD': 0.4, 'ETH-USD': 0.3, 'SOL-USD': 0.3 } },
        makeContext({
          holdings: [holding('BTC', '1'), holding('ETH', '60'), holding('SOL', '10')],
          prices: { 'BTC-USD': 100, 'ETH-USD': 1, 'SOL-USD': null },
        }),
      ),
    ).rejects.toThrow(/No usable price for SOL-USD/);
  });

  it('retries a leg that cannot be priced at execution, then abandons it', async () => {
    const state = await rebalanceState();
    const blind = () => makeContext({ ...DRIFTED, prices: { 'BTC-USD': null, 'ETH-USD': null } });

    let current = state;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const step = await rebalance.advance(makeJob({ state: current }), blind());
      expect(submits(step)).toHaveLength(0);
      expect(logDetail(step, 'rebalance_leg_unpriced')).toMatchObject({ attempts: attempt, abandoned: false });
      expect(step.done).toBeUndefined();
      current = step.state;
    }

    // The third attempt abandons the leg rather than retrying forever, which is
    // what makes the job terminate.
    const final = await rebalance.advance(makeJob({ state: current }), blind());
    expect(logDetail(final, 'rebalance_leg_unpriced')).toMatchObject({ attempts: 3, abandoned: true });
    expect(submits(final)).toHaveLength(0);
  });

  it('never trades an asset it could not price', async () => {
    const state = await rebalanceState();
    const step = await rebalance.advance(
      makeJob({ state }),
      makeContext({ ...DRIFTED, prices: { 'BTC-USD': null, 'ETH-USD': 1 } }),
    );

    for (const action of submits(step)) expect(action.order.symbol).not.toBe('BTC-USD');
  });

  it('skips a correction below the venue minimum instead of sending an order that would be refused', async () => {
    const state = await rebalanceState({}, makeContext({ ...DRIFTED, minOrderSize: 10 }));
    const step = await rebalance.advance(
      makeJob({ state }),
      makeContext({ ...DRIFTED, minOrderSize: 10 }),
    );

    // The BTC sell is a third of a coin, under the 10 minimum.
    expect(submits(step)).toHaveLength(0);
    expect(logDetail(step, 'rebalance_leg_below_minimum')).toMatchObject({
      symbol: 'BTC-USD',
      side: 'sell',
      minOrderSize: 10,
    });
    expect(leg(step.state, 'BTC-USD').status).toBe('skipped');
  });

  it('reports what it skipped and why when it completes', async () => {
    const state = await rebalanceState({}, makeContext({ ...DRIFTED, minOrderSize: 10 }));
    const context = makeContext({ ...DRIFTED, minOrderSize: 10 });

    const first = await rebalance.advance(makeJob({ state }), context);
    const second = await rebalance.advance(makeJob({ state: first.state }), context);

    expect(second.done?.status).toBe('completed');
    expect(second.done?.reason).toMatch(/below the venue minimum/);
    expect(logKinds(second)).toContain('rebalance_complete');
  });
});
