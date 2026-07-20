import { describe, it, expect } from 'vitest';
import { momentum } from '../src/engine/strategies/momentum.js';
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
  /** Base-asset balance the account reports, for the spot-sell check. */
  held?: string | null;
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
    async holdings(): Promise<Array<Record<string, unknown>>> {
      if (options.held === null) return [];
      return [{ asset_code: 'BTC', quantity_available_for_trading: options.held ?? '100' }];
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
    strategy: 'momentum',
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
  side: 'buy',
  quantity: '1',
  lookback_ticks: 3,
  breakout_pct: 2,
  exit_pct: 5,
  max_duration_minutes: 60,
};

async function momentumState(
  overrides: Record<string, unknown> = {},
  options: FakeContextOptions = {},
): Promise<Record<string, unknown>> {
  const { state } = await momentum.init({ ...PARAMS, ...overrides }, makeContext(options));
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
    const step = await momentum.advance(makeJob({ state: current }), makeContext({ ...options, price }));
    steps.push(step);
    current = step.state;
  }
  return steps;
}

describe('momentum init', () => {
  it('rounds the entry size to the venue increment and starts watching', async () => {
    const state = await momentumState({ quantity: '1.123456789' });
    expect(state.quantity).toBe('1.12345678');
    expect(state.phase).toBe('watching');
    expect(state.prices).toEqual([]);
    expect(state.deadline).toBe(NOW + 60 * 60_000);
  });

  it('rejects a lookback outside the supported window', async () => {
    await expect(momentum.init({ ...PARAMS, lookback_ticks: 2 }, makeContext())).rejects.toThrow(
      /"lookback_ticks" must be an integer between 3 and 500/,
    );
  });

  it('rejects a breakout margin of zero', async () => {
    await expect(momentum.init({ ...PARAMS, breakout_pct: 0 }, makeContext())).rejects.toThrow(
      /"breakout_pct" must be a number between 0.01 and 100/,
    );
  });

  it('rejects an exit that gives back the entire move', async () => {
    await expect(momentum.init({ ...PARAMS, exit_pct: 100 }, makeContext())).rejects.toThrow(
      /exit_pct must be below 100/,
    );
  });

  it('rejects a size below the venue minimum, naming the minimum', async () => {
    await expect(
      momentum.init({ ...PARAMS, quantity: '0.1' }, makeContext({ minOrderSize: 0.5 })),
    ).rejects.toThrow(/quantity 0.10000000 BTC is below the venue minimum of 0.5/);
  });

  it('rejects a size that rounds to zero at the venue increment', async () => {
    await expect(
      momentum.init({ ...PARAMS, quantity: '0.5' }, makeContext({ assetIncrement: '1' })),
    ).rejects.toThrow(/rounds to zero at the venue increment of 1/);
  });

  it('refuses a downside entry the spot account cannot cover, and says it is not a short', async () => {
    await expect(
      momentum.init({ ...PARAMS, side: 'sell', quantity: '5' }, makeContext({ held: '1' })),
    ).rejects.toThrow(/This is not a short: Robinhood crypto cannot open one/);
  });

  it('accepts a downside entry the holding covers', async () => {
    const state = await momentumState({ side: 'sell' }, { held: '3' });
    expect(state.side).toBe('sell');
  });
});

describe('momentum breakout', () => {
  it('samples a bounded window and does not trade before it is full', async () => {
    const steps = await run(await momentumState(), [100, 101, 102]);

    expect(steps.flatMap(submits)).toHaveLength(0);
    expect(logKinds(steps[0] as StrategyStep)).toEqual(['momentum_warmup']);
    expect((steps[2] as StrategyStep).state.prices).toEqual([100, 101, 102]);
  });

  it('never grows the window past lookback_ticks', async () => {
    const steps = await run(await momentumState(), [100, 100, 100, 100, 100, 100]);
    const last = steps[steps.length - 1] as StrategyStep;
    expect((last.state.prices as number[])).toHaveLength(3);
  });

  it('holds while price stays inside the range', async () => {
    const steps = await run(await momentumState(), [100, 101, 102, 103]);
    const step = steps[3] as StrategyStep;

    // 2% above a 102 high is 104.04, and 103 does not reach it.
    expect(submits(step)).toHaveLength(0);
    expect(logKinds(step)).toEqual(['momentum_watching']);
    expect(step.state.phase).toBe('watching');
  });

  it('enters at market when price clears the lookback high by the margin', async () => {
    const steps = await run(await momentumState(), [100, 101, 102, 110]);
    const step = steps[3] as StrategyStep;

    expect(logKinds(step)).toContain('momentum_breakout');
    expect(submits(step)[0]?.order).toEqual({
      symbol: 'BTC-USD',
      side: 'buy',
      type: 'market',
      assetQuantity: '1.00000000',
    });
    expect(step.state.phase).toBe('in_position');
    expect(step.state.entryPrice).toBe('110');
    expect(step.state.peakPrice).toBe('110');
  });

  it('enters on a downside break when the side is a sell', async () => {
    const state = await momentumState({ side: 'sell' }, { held: '3' });
    const steps = await run(state, [100, 99, 98, 90], { held: '3' });
    const step = steps[3] as StrategyStep;

    expect(submits(step)[0]?.order).toMatchObject({ side: 'sell', type: 'market' });
    expect(step.state.phase).toBe('in_position');
  });
});

describe('momentum exit', () => {
  /** A long entered at 110 off a 100/101/102 window. */
  async function inPosition(): Promise<Record<string, unknown>> {
    const steps = await run(await momentumState(), [100, 101, 102, 110]);
    return (steps[3] as StrategyStep).state;
  }

  it('ratchets the peak upward and holds through it', async () => {
    const steps = await run(await inPosition(), [120, 118]);

    expect((steps[0] as StrategyStep).state.peakPrice).toBe('120');
    expect(logKinds(steps[0] as StrategyStep)).toContain('momentum_peak');
    // 5% off a 120 peak is 114, and 118 has not reached it.
    expect((steps[1] as StrategyStep).state.peakPrice).toBe('120');
    expect(steps.flatMap(submits)).toHaveLength(0);
  });

  it('closes the position when price retraces the exit percentage from the peak', async () => {
    const steps = await run(await inPosition(), [120, 113]);
    const step = steps[1] as StrategyStep;

    expect(submits(step)[0]?.order).toEqual({
      symbol: 'BTC-USD',
      side: 'sell',
      type: 'market',
      assetQuantity: '1.00000000',
    });
    expect(step.done).toEqual({
      status: 'completed',
      reason: 'Price retraced 5% from a peak of 120 to 113, so the position opened at 110 was closed.',
    });
    expect(step.state.phase).toBe('exited');
  });

  it('resumes mid-position from persisted JSON with its peak intact', async () => {
    const held = (await run(await inPosition(), [120]))[0] as StrategyStep;

    const step = await momentum.advance(
      makeJob({ state: restart(held.state) }),
      makeContext({ price: 113 }),
    );

    expect(step.state.peakPrice).toBe('120');
    expect(submits(step)).toHaveLength(1);
    expect(step.done?.status).toBe('completed');
  });

  it('fails the job when the entry order was rejected', async () => {
    const state = await inPosition();

    const step = await momentum.advance(
      makeJob({ state, lastError: 'Order value $1000.00 exceeds ROBINHOOD_CRYPTO_MAX_ORDER_USD ($100.00).' }),
      makeContext({ price: 111 }),
    );

    expect(step.done?.status).toBe('failed');
    expect(step.done?.reason).toMatch(/The breakout entry was not placed/);
    expect(submits(step)).toHaveLength(0);
  });
});

describe('momentum termination', () => {
  it('completes without a trade when the duration elapses while watching', async () => {
    const step = await momentum.advance(
      makeJob({ state: await momentumState() }),
      makeContext({ now: NOW + 61 * 60_000 }),
    );

    expect(step.done).toEqual({
      status: 'completed',
      reason: 'max_duration_minutes elapsed without a breakout. No position was taken.',
    });
    expect(submits(step)).toHaveLength(0);
    expect(logKinds(step)).toEqual(['momentum_expired']);
  });

  it('closes an open position at the deadline rather than leaving it unmanaged', async () => {
    const steps = await run(await momentumState(), [100, 101, 102, 110]);

    const step = await momentum.advance(
      makeJob({ state: (steps[3] as StrategyStep).state }),
      makeContext({ now: NOW + 61 * 60_000 }),
    );

    expect(submits(step)[0]?.order).toMatchObject({ side: 'sell', type: 'market' });
    expect(step.done?.reason).toMatch(/closed at market rather than being left open unmanaged/);
    expect(logKinds(step)).toContain('momentum_expired_in_position');
  });

  it('stays finished once it has exited', async () => {
    const steps = await run(await momentumState(), [100, 101, 102, 110]);
    const exited = (await run((steps[3] as StrategyStep).state, [120, 113]))[1] as StrategyStep;

    const step = await momentum.advance(makeJob({ state: exited.state }), makeContext({ price: 130 }));

    expect(step.actions).toEqual([]);
    expect(step.done).toEqual({ status: 'completed' });
  });
});

describe('momentum without a price', () => {
  it('skips the tick rather than sampling a guess', async () => {
    const warm = await run(await momentumState(), [100, 101, 102]);
    const before = (warm[2] as StrategyStep).state;

    const step = await momentum.advance(makeJob({ state: before }), makeContext({ price: null }));

    expect(step.state.prices).toEqual([100, 101, 102]);
    expect(submits(step)).toHaveLength(0);
    expect(step.done).toBeUndefined();
    expect(logKinds(step)).toEqual(['momentum_no_price']);
  });
});
