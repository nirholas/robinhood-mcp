import { describe, it, expect } from 'vitest';
import { rebalance } from '../src/engine/strategies/rebalance.js';
import type { Job, StrategyAction, StrategyContext, StrategyStep } from '../src/engine/job.js';
import type { Executor } from '../src/shared/executor.js';

/**
 * Strategies are pure step functions, so the whole context can be a plain
 * object. Holdings and prices are the only two readings a rebalance takes, and
 * both are per-symbol here so a single missing quote can be simulated.
 */
interface FakeContextOptions {
  /** Price per symbol. `null` stands for a venue that is not quoting it. */
  prices?: Record<string, number | null>;
  /** Base asset code to quantity held, as the holdings endpoint reports it. */
  holdings?: Record<string, number>;
  /** Symbols with no trading pair upstream. */
  unknownSymbols?: string[];
  assetIncrement?: string | null;
  minOrderSize?: number;
  now?: number;
}

function makeContext(options: FakeContextOptions = {}): StrategyContext {
  const executor = {
    async tradingPair(symbol: string): Promise<Record<string, unknown> | null> {
      if (options.unknownSymbols?.includes(symbol)) return null;
      return {
        asset_increment: options.assetIncrement === undefined ? '0.00000001' : options.assetIncrement,
        min_order_size: options.minOrderSize ?? 0,
      };
    },
    async holdings(): Promise<Array<Record<string, unknown>>> {
      return Object.entries(options.holdings ?? {}).map(([asset_code, quantity]) => ({
        asset_code,
        total_quantity: String(quantity),
      }));
    },
  } as unknown as Executor;

  return {
    executor,
    now: options.now ?? 1_700_000_000_000,
    async price(symbol: string): Promise<number | null> {
      const price = options.prices?.[symbol];
      return price === undefined ? 100 : price;
    },
    async openOrders(): Promise<Array<Record<string, unknown>>> {
      return [];
    },
  };
}

function makeJob(overrides: Partial<Job> & { state: Record<string, unknown> }): Job {
  return {
    id: 'job-1',
    strategy: 'rebalance',
    symbol: 'PORTFOLIO',
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

interface Leg {
  symbol: string;
  side: 'buy' | 'sell' | null;
  status: string;
  deltaUsd: string;
  attempts: number;
  reason: string | null;
  executedQuantity: string | null;
}

function legs(state: Record<string, unknown>): Leg[] {
  return state.legs as unknown as Leg[];
}

function leg(state: Record<string, unknown>, symbol: string): Leg {
  const found = legs(state).find((row) => row.symbol === symbol);
  if (!found) throw new Error(`No leg for ${symbol}`);
  return found;
}

const TARGETS = { 'BTC-USD': 0.5, 'ETH-USD': 0.5 };

/**
 * A portfolio that is 75/25 against a 50/50 target: $7,500 of BTC and $2,500 of
 * ETH, so the plan should sell $2,500 of BTC and buy $2,500 of ETH.
 */
const DRIFTED = {
  prices: { 'BTC-USD': 100, 'ETH-USD': 100 },
  holdings: { BTC: 75, ETH: 25 },
};

async function planned(
  params: Record<string, unknown> = {},
  options: FakeContextOptions = DRIFTED,
): Promise<Record<string, unknown>> {
  const { state } = await rebalance.init(
    { targets: TARGETS, tolerance_bps: 100, max_legs_per_tick: 1, ...params },
    makeContext(options),
  );
  return state;
}

describe('rebalance init', () => {
  it('rejects weights that do not sum to 1, and says which way they are off', async () => {
    await expect(
      rebalance.init(
        { targets: { 'BTC-USD': 0.5, 'ETH-USD': 0.3 }, tolerance_bps: 100, max_legs_per_tick: 2 },
        makeContext(DRIFTED),
      ),
    ).rejects.toThrow(/sum to 0.8000, not 1.0/);

    await expect(
      rebalance.init(
        { targets: { 'BTC-USD': 0.8, 'ETH-USD': 0.8 }, tolerance_bps: 100, max_legs_per_tick: 2 },
        makeContext(DRIFTED),
      ),
    ).rejects.toThrow(/more than the portfolio is worth/);
  });

  it('rejects a percentage where a fraction belongs', async () => {
    await expect(
      rebalance.init(
        { targets: { 'BTC-USD': 60, 'ETH-USD': 40 }, tolerance_bps: 100, max_legs_per_tick: 2 },
        makeContext(DRIFTED),
      ),
    ).rejects.toThrow(/for 60% pass 0.6/);
  });

  it('rejects an asset code used where a trading pair symbol belongs', async () => {
    await expect(
      rebalance.init(
        { targets: { BTC: 0.5, ETH: 0.5 }, tolerance_bps: 100, max_legs_per_tick: 2 },
        makeContext(DRIFTED),
      ),
    ).rejects.toThrow(/"BTC-USD" rather than "BTC"/);
  });

  it('rejects targets that are not an object at all', async () => {
    await expect(
      rebalance.init({ targets: ['BTC-USD'], tolerance_bps: 100, max_legs_per_tick: 2 }, makeContext(DRIFTED)),
    ).rejects.toThrow(/"targets" must be an object mapping trading pair symbols to weights/);
  });

  it('rejects tolerance_bps and max_legs_per_tick outside their ranges, by name', async () => {
    await expect(
      rebalance.init({ targets: TARGETS, tolerance_bps: 0, max_legs_per_tick: 2 }, makeContext(DRIFTED)),
    ).rejects.toThrow(/"tolerance_bps" must be an integer between 1 and 5000/);

    await expect(
      rebalance.init({ targets: TARGETS, tolerance_bps: 100, max_legs_per_tick: 99 }, makeContext(DRIFTED)),
    ).rejects.toThrow(/"max_legs_per_tick" must be an integer between 1 and 10/);
  });

  it('rejects a non-boolean dry_run', async () => {
    await expect(
      rebalance.init(
        { targets: TARGETS, tolerance_bps: 100, max_legs_per_tick: 2, dry_run: 'yes' },
        makeContext(DRIFTED),
      ),
    ).rejects.toThrow(/"dry_run" must be a boolean/);
  });

  it('rejects a symbol Robinhood does not trade', async () => {
    await expect(
      rebalance.init(
        { targets: TARGETS, tolerance_bps: 100, max_legs_per_tick: 2 },
        makeContext({ ...DRIFTED, unknownSymbols: ['ETH-USD'] }),
      ),
    ).rejects.toThrow(/not a tradable pair/);
  });

  it('fails closed when any leg cannot be priced, instead of planning around it', async () => {
    await expect(
      rebalance.init(
        { targets: TARGETS, tolerance_bps: 100, max_legs_per_tick: 2 },
        makeContext({ ...DRIFTED, prices: { 'BTC-USD': 100, 'ETH-USD': null } }),
      ),
    ).rejects.toThrow(/No usable price for ETH-USD/);
  });

  it('refuses to rebalance a portfolio worth nothing', async () => {
    await expect(
      rebalance.init(
        { targets: TARGETS, tolerance_bps: 100, max_legs_per_tick: 2 },
        makeContext({ prices: { 'BTC-USD': 100, 'ETH-USD': 100 }, holdings: {} }),
      ),
    ).rejects.toThrow(/worth 0 in this account/);
  });

  it('plans one sell and one buy from the drift, and reports the portfolio total', async () => {
    const state = await planned();

    expect(state.portfolioUsd).toBe('10000');
    expect(leg(state, 'BTC-USD')).toMatchObject({ side: 'sell', status: 'pending', deltaUsd: '2500' });
    expect(leg(state, 'ETH-USD')).toMatchObject({ side: 'buy', status: 'pending', deltaUsd: '2500' });
  });

  it('marks legs inside the tolerance band as needing no trade', async () => {
    // A $100 drift on a $10,000 portfolio is 100 bps, and the band is 200.
    const state = await planned(
      { tolerance_bps: 200 },
      { prices: { 'BTC-USD': 100, 'ETH-USD': 100 }, holdings: { BTC: 51, ETH: 49 } },
    );

    for (const row of legs(state)) {
      expect(row.status).toBe('within_tolerance');
      expect(row.side).toBeNull();
      expect(row.reason).toMatch(/inside the 200 bps band/);
    }
  });

  it('records held assets outside the targets rather than trading them', async () => {
    const state = await planned({}, { ...DRIFTED, holdings: { BTC: 75, ETH: 25, DOGE: 1_000 } });

    expect(state.ignoredAssets).toEqual(['DOGE']);
    expect(legs(state).map((row) => row.symbol)).toEqual(['BTC-USD', 'ETH-USD']);
  });
});

describe('rebalance execution', () => {
  it('sends the sell first and holds the buy back until the next tick', async () => {
    const state = await planned();

    const first = await rebalance.advance(makeJob({ state }), makeContext(DRIFTED));

    expect(submits(first)).toHaveLength(1);
    expect(submits(first)[0]?.order).toMatchObject({
      symbol: 'BTC-USD',
      side: 'sell',
      type: 'market',
      assetQuantity: '25.00000000',
    });
    expect(first.done).toBeUndefined();
    expect(leg(first.state, 'BTC-USD').status).toBe('submitted');
    expect(leg(first.state, 'ETH-USD').status).toBe('pending');

    const second = await rebalance.advance(makeJob({ state: first.state }), makeContext(DRIFTED));

    expect(submits(second)[0]?.order).toMatchObject({ symbol: 'ETH-USD', side: 'buy' });
    expect(second.done?.status).toBe('completed');
    expect(second.done?.reason).toMatch(/Traded 2 leg\(s\)/);
  });

  it('never mixes a buy into a tick that still has sells to do', async () => {
    const threeWay = await rebalance.init(
      {
        targets: { 'BTC-USD': 0.34, 'ETH-USD': 0.33, 'SOL-USD': 0.33 },
        tolerance_bps: 10,
        max_legs_per_tick: 10,
      },
      makeContext({
        prices: { 'BTC-USD': 100, 'ETH-USD': 100, 'SOL-USD': 100 },
        holdings: { BTC: 60, ETH: 30, SOL: 10 },
      }),
    );
    expect(threeWay.state.portfolioUsd).toBe('10000');

    const step = await rebalance.advance(
      makeJob({ state: threeWay.state }),
      makeContext({
        prices: { 'BTC-USD': 100, 'ETH-USD': 100, 'SOL-USD': 100 },
        holdings: { BTC: 60, ETH: 30, SOL: 10 },
      }),
    );

    // BTC is the only overweight leg, so it goes alone even though the tick
    // could carry ten.
    expect(submits(step).map((s) => s.order.symbol)).toEqual(['BTC-USD']);
    expect(submits(step)[0]?.order.side).toBe('sell');
  });

  it('sizes at the price of the tick it executes on, not the mark from plan time', async () => {
    const state = await planned();

    // BTC doubled between planning and execution, so the same $2,500
    // correction is half the quantity.
    const step = await rebalance.advance(
      makeJob({ state }),
      makeContext({ ...DRIFTED, prices: { 'BTC-USD': 200, 'ETH-USD': 100 } }),
    );

    expect(submits(step)[0]?.order.assetQuantity).toBe('12.50000000');
  });

  it('never sells more of an asset than the plan saw in the account', async () => {
    // ETH is worth nothing here, so the plan wants the whole BTC position sold
    // down; the sell is still capped at what is held.
    const state = await planned(
      { tolerance_bps: 10 },
      { prices: { 'BTC-USD': 100, 'ETH-USD': 100 }, holdings: { BTC: 10, ETH: 0 } },
    );

    const step = await rebalance.advance(
      makeJob({ state }),
      makeContext({ ...DRIFTED, prices: { 'BTC-USD': 1, 'ETH-USD': 100 } }),
    );

    expect(Number(submits(step)[0]?.order.assetQuantity)).toBeLessThanOrEqual(10);
  });

  it('sizes and logs every leg without trading when dry_run is set', async () => {
    const state = await planned({ dry_run: true, max_legs_per_tick: 10 });

    const first = await rebalance.advance(makeJob({ state }), makeContext(DRIFTED));
    expect(submits(first)).toHaveLength(0);
    expect(logKinds(first)).toContain('rebalance_dry_run_leg');

    const second = await rebalance.advance(makeJob({ state: first.state }), makeContext(DRIFTED));
    expect(second.done?.status).toBe('completed');
    expect(second.done?.reason).toMatch(/Dry run/);
    expect(leg(second.state, 'BTC-USD').executedQuantity).toBe('25.00000000');
  });

  it('completes with nothing to do when every leg is already within tolerance', async () => {
    const state = await planned(
      { tolerance_bps: 500 },
      { prices: { 'BTC-USD': 100, 'ETH-USD': 100 }, holdings: { BTC: 51, ETH: 49 } },
    );

    const step = await rebalance.advance(makeJob({ state }), makeContext(DRIFTED));

    expect(submits(step)).toHaveLength(0);
    expect(step.done?.status).toBe('completed');
    expect(step.done?.reason).toMatch(/2 already inside the 500 bps band/);
    expect(logKinds(step)).toContain('rebalance_complete');
  });
});

describe('rebalance safety', () => {
  it('retries an unpriceable leg, then abandons it with the reason recorded', async () => {
    const state = await planned({ max_legs_per_tick: 10 });
    const blind = { ...DRIFTED, prices: { 'BTC-USD': null, 'ETH-USD': 100 } };

    let current = state;
    for (const attempts of [1, 2]) {
      const step = await rebalance.advance(makeJob({ state: current }), makeContext(blind));
      expect(submits(step)).toHaveLength(0);
      expect(logKinds(step)).toContain('rebalance_leg_unpriced');
      expect(leg(step.state, 'BTC-USD')).toMatchObject({ status: 'pending', attempts });
      expect(step.done).toBeUndefined();
      current = step.state;
    }

    const abandoned = await rebalance.advance(makeJob({ state: current }), makeContext(blind));

    // No size was ever guessed for the leg that could not be priced.
    expect(submits(abandoned)).toHaveLength(0);
    expect(leg(abandoned.state, 'BTC-USD')).toMatchObject({ status: 'skipped', attempts: 3 });
    expect(leg(abandoned.state, 'BTC-USD').reason).toMatch(/No usable price after 3 attempts/);
    expect(abandoned.done).toBeUndefined();

    // With the sell abandoned, the buy leg is finally the only one left.
    const buy = await rebalance.advance(makeJob({ state: abandoned.state }), makeContext(blind));
    expect(submits(buy)[0]?.order).toMatchObject({ symbol: 'ETH-USD', side: 'buy' });
    expect(buy.done?.status).toBe('completed');
    expect(buy.done?.reason).toMatch(/skipped 1: BTC-USD/);
  });

  it('skips a correction that is below the venue minimum rather than sending it', async () => {
    const state = await planned({ max_legs_per_tick: 10 }, { ...DRIFTED, minOrderSize: 100 });

    const step = await rebalance.advance(
      makeJob({ state }),
      makeContext({ ...DRIFTED, minOrderSize: 100 }),
    );

    expect(submits(step)).toHaveLength(0);
    expect(logKinds(step)).toContain('rebalance_leg_below_minimum');
    expect(leg(step.state, 'BTC-USD').reason).toMatch(/below the venue minimum of 100/);
  });

  it('stops the whole rebalance when a submitted leg was rejected', async () => {
    const state = await planned();
    const submitted = (await rebalance.advance(makeJob({ state }), makeContext(DRIFTED))).state;

    const step = await rebalance.advance(
      makeJob({ state: submitted, lastError: 'Sell orders are blocked by ROBINHOOD_CRYPTO_BUY_ONLY=1.' }),
      makeContext(DRIFTED),
    );

    expect(submits(step)).toHaveLength(0);
    expect(step.done?.status).toBe('failed');
    expect(step.done?.reason).toMatch(/A leg in batch \[BTC-USD\] was rejected/);
    expect(step.done?.reason).toMatch(/start a new rebalance/);
  });

  it('ignores a stale error once the batch that could have caused it is empty', async () => {
    const state = await planned({ dry_run: true, max_legs_per_tick: 10 });

    // A dry run submits nothing, so an error on the job cannot belong to it.
    const step = await rebalance.advance(
      makeJob({ state, lastError: 'unrelated' }),
      makeContext(DRIFTED),
    );

    expect(logKinds(step)).toContain('rebalance_dry_run_leg');
    expect(step.done).toBeUndefined();
  });

  it('resumes a half-executed plan from persisted JSON without repeating the sell', async () => {
    const state = await planned();
    const afterSell = (await rebalance.advance(makeJob({ state }), makeContext(DRIFTED))).state;

    const step = await rebalance.advance(makeJob({ state: restart(afterSell) }), makeContext(DRIFTED));

    expect(submits(step).map((s) => s.order.symbol)).toEqual(['ETH-USD']);
    expect(step.done?.status).toBe('completed');
  });

  it('terminates: every advance either finishes or moves a leg forward', async () => {
    const state = await planned({ max_legs_per_tick: 1 });

    let current = state;
    let advances = 0;
    let done: StrategyStep['done'];
    while (!done && advances < 20) {
      const step = await rebalance.advance(makeJob({ state: current }), makeContext(DRIFTED));
      current = step.state;
      done = step.done;
      advances++;
    }

    expect(done?.status).toBe('completed');
    expect(advances).toBe(2);
  });
});
