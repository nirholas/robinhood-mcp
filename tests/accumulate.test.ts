import { describe, it, expect } from 'vitest';
import { accumulate } from '../src/engine/strategies/accumulate.js';
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
  minOrderSize?: number | null;
  now?: number;
}

const NOW = 1_700_000_000_000;

function makeContext(options: FakeContextOptions = {}): StrategyContext {
  const executor = {
    async tradingPair(): Promise<Record<string, unknown> | null> {
      return {
        asset_increment: options.assetIncrement === undefined ? '0.00000001' : options.assetIncrement,
        min_order_size: options.minOrderSize ?? 0,
      };
    },
  } as unknown as Executor;

  return {
    executor,
    now: options.now ?? NOW,
    async price(): Promise<number | null> {
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
    strategy: 'accumulate',
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

const PARAMS = {
  symbol: 'BTC-USD',
  target_quantity: '3',
  max_price: '110',
  buy_below_pct: 2,
  slice_quantity: '1',
  lookback_ticks: 3,
  max_duration_minutes: 60,
};

/** Three flat samples, giving a rolling average of 100 and a trigger of 98. */
const WARMUP = [100, 100, 100];

async function accumulateState(
  overrides: Record<string, unknown> = {},
  options: FakeContextOptions = {},
): Promise<Record<string, unknown>> {
  const { state } = await accumulate.init({ ...PARAMS, ...overrides }, makeContext(options));
  return state;
}

/** Feed a series of prices through the strategy, returning every step taken. */
async function run(
  state: Record<string, unknown>,
  prices: Array<number | null>,
  options: FakeContextOptions = {},
): Promise<StrategyStep[]> {
  const steps: StrategyStep[] = [];
  let current = state;
  for (const price of prices) {
    const step = await accumulate.advance(makeJob({ state: current }), makeContext({ ...options, price }));
    steps.push(step);
    current = step.state;
  }
  return steps;
}

describe('accumulate init', () => {
  it('rounds the slice to the venue increment and starts empty', async () => {
    const state = await accumulateState({ slice_quantity: '0.123456789' });
    expect(state.sliceQuantity).toBe('0.12345678');
    expect(state.acquiredQuantity).toBe('0');
    expect(state.slicesBought).toBe(0);
    expect(state.deadline).toBe(NOW + 60 * 60_000);
  });

  it('rejects a buy-below percentage of zero', async () => {
    await expect(accumulate.init({ ...PARAMS, buy_below_pct: 0 }, makeContext())).rejects.toThrow(
      /"buy_below_pct" must be a number between 0.01 and 99/,
    );
  });

  it('rejects a lookback too short to average anything', async () => {
    await expect(accumulate.init({ ...PARAMS, lookback_ticks: 2 }, makeContext())).rejects.toThrow(
      /"lookback_ticks" must be an integer between 3 and 500/,
    );
  });

  it('rejects a missing price ceiling', async () => {
    const { max_price: _dropped, ...withoutCeiling } = PARAMS;
    await expect(accumulate.init(withoutCeiling, makeContext())).rejects.toThrow(
      /"max_price" must be a positive decimal string/,
    );
  });

  it('rejects a slice larger than the target, which would buy it all at once', async () => {
    await expect(
      accumulate.init({ ...PARAMS, slice_quantity: '5' }, makeContext()),
    ).rejects.toThrow(/slice_quantity 5.00000000 exceeds target_quantity 3/);
  });

  it('rejects a slice below the venue minimum, naming the minimum', async () => {
    await expect(
      accumulate.init({ ...PARAMS, slice_quantity: '0.1' }, makeContext({ minOrderSize: 0.5 })),
    ).rejects.toThrow(/slice_quantity 0.10000000 BTC is below the venue minimum of 0.5/);
  });

  it('rejects a slice that rounds to zero at the venue increment', async () => {
    await expect(
      accumulate.init({ ...PARAMS, slice_quantity: '0.5' }, makeContext({ assetIncrement: '1' })),
    ).rejects.toThrow(/rounds to zero at the venue increment of 1/);
  });
});

describe('accumulate opportunism', () => {
  it('samples a bounded window and buys nothing before it is full', async () => {
    const steps = await run(await accumulateState(), WARMUP);

    expect(steps.flatMap(submits)).toHaveLength(0);
    expect(logKinds(steps[0] as StrategyStep)).toEqual(['accumulate_warmup']);
    expect((steps[2] as StrategyStep).state.prices).toEqual(WARMUP);
  });

  it('never grows the window past lookback_ticks', async () => {
    const steps = await run(await accumulateState(), [...WARMUP, 101, 102, 103]);
    expect((steps[steps.length - 1] as StrategyStep).state.prices).toEqual([101, 102, 103]);
  });

  it('waits through strength instead of buying on a schedule', async () => {
    const steps = await run(await accumulateState(), [...WARMUP, 99]);
    const step = steps[3] as StrategyStep;

    // 2% below a 100 average is 98, and 99 is not weak enough.
    expect(submits(step)).toHaveLength(0);
    expect(logKinds(step)).toEqual(['accumulate_not_weak_enough']);
  });

  it('buys a slice as a limit at the dip it decided on', async () => {
    const steps = await run(await accumulateState(), [...WARMUP, 97]);
    const step = steps[3] as StrategyStep;

    expect(logKinds(step)).toContain('accumulate_dip_bought');
    expect(submits(step)[0]?.order).toEqual({
      symbol: 'BTC-USD',
      side: 'buy',
      type: 'limit',
      assetQuantity: '1.00000000',
      limitPrice: '97',
      timeInForce: 'gtc',
    });
    expect(step.state.acquiredQuantity).toBe('1');
    expect(step.state.slicesBought).toBe(1);
    expect(step.done).toBeUndefined();
  });

  it('refuses a dip that is still above max_price, whatever the average says', async () => {
    // The window averages 200, so 150 is a 25% dip, but the ceiling is 110.
    const steps = await run(await accumulateState(), [200, 200, 200, 150]);
    const step = steps[3] as StrategyStep;

    expect(submits(step)).toHaveLength(0);
    expect(logKinds(step)).toEqual(['accumulate_above_max_price']);
  });

  it('resumes mid-accumulation from persisted JSON', async () => {
    const bought = (await run(await accumulateState(), [...WARMUP, 97]))[3] as StrategyStep;

    const step = await accumulate.advance(
      makeJob({ state: restart(bought.state) }),
      makeContext({ price: 90 }),
    );

    expect(step.state.acquiredQuantity).toBe('2');
    expect(step.state.slicesBought).toBe(2);
    expect(submits(step)).toHaveLength(1);
  });
});

describe('accumulate termination', () => {
  it('completes on the slice that reaches the target, without overshooting it', async () => {
    const state = await accumulateState({ target_quantity: '1.5' });
    const steps = await run(state, [...WARMUP, 97, 96]);

    const last = steps[4] as StrategyStep;
    expect(submits(last)[0]?.order.assetQuantity).toBe('0.50000000');
    expect(last.state.acquiredQuantity).toBe('1.5');
    expect(last.done).toEqual({ status: 'completed' });
  });

  it('stops when the remainder is real but below the venue minimum', async () => {
    const state = await accumulateState({ target_quantity: '1.4' }, { minOrderSize: 0.5 });
    const steps = await run(state, [...WARMUP, 97, 96], { minOrderSize: 0.5 });

    const last = steps[4] as StrategyStep;
    expect(submits(last)).toHaveLength(0);
    expect(last.done?.status).toBe('completed');
    expect(last.done?.reason).toMatch(/Accumulated 1 of 1.4.*below the venue minimum of 0.5/s);
    expect(logKinds(last)).toContain('accumulate_remainder_below_minimum');
  });

  it('stops when the remainder rounds below the venue increment', async () => {
    const state = await accumulateState({ target_quantity: '1.5' }, { assetIncrement: '1' });
    const steps = await run(state, [...WARMUP, 97, 96], { assetIncrement: '1' });

    const last = steps[4] as StrategyStep;
    expect(submits(last)).toHaveLength(0);
    expect(last.done?.reason).toMatch(/rounds below the venue increment/);
    expect(logKinds(last)).toContain('accumulate_remainder_rounds_to_zero');
  });

  it('ends short rather than chasing when the duration elapses', async () => {
    const bought = (await run(await accumulateState(), [...WARMUP, 97]))[3] as StrategyStep;

    const step = await accumulate.advance(
      makeJob({ state: bought.state }),
      makeContext({ now: NOW + 61 * 60_000 }),
    );

    expect(submits(step)).toHaveLength(0);
    expect(step.done?.status).toBe('completed');
    expect(step.done?.reason).toMatch(/max_duration_minutes elapsed with 1 of 3 accumulated across 1 slice/);
    expect(step.done?.reason).toMatch(/The remainder was not chased/);
    expect(logKinds(step)).toEqual(['accumulate_expired']);
  });

  it('stays finished once the target has been met', async () => {
    const state = await accumulateState({ target_quantity: '1' });
    const done = (await run(state, [...WARMUP, 97]))[3] as StrategyStep;

    const step = await accumulate.advance(makeJob({ state: done.state }), makeContext({ price: 90 }));

    expect(submits(step)).toHaveLength(0);
    expect(step.done).toEqual({ status: 'completed' });
    expect(logKinds(step)).toEqual(['accumulate_target_reached']);
  });
});

describe('accumulate without a price', () => {
  it('skips the tick rather than sampling a guess into the average', async () => {
    const warm = await run(await accumulateState(), WARMUP);
    const before = (warm[2] as StrategyStep).state;

    const step = await accumulate.advance(makeJob({ state: before }), makeContext({ price: null }));

    expect(step.state.prices).toEqual(WARMUP);
    expect(submits(step)).toHaveLength(0);
    expect(step.done).toBeUndefined();
    expect(logKinds(step)).toEqual(['accumulate_no_price']);
  });
});
