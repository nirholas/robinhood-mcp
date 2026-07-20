import { describe, it, expect } from 'vitest';
import { meanReversion } from '../src/engine/strategies/mean-reversion.js';
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
  /** Base-asset balance the account reports, for the spot short-side check. */
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
    strategy: 'mean_reversion',
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
  quantity: '1',
  lookback_ticks: 5,
  entry_z: 2,
  exit_z: 0.5,
  side_mode: 'long_only',
  max_duration_minutes: 60,
};

/** A window with a mean of 100 and a standard deviation of about 1.414. */
const WARMUP = [98, 99, 100, 101, 102];

async function reversionState(
  overrides: Record<string, unknown> = {},
  options: FakeContextOptions = {},
): Promise<Record<string, unknown>> {
  const { state } = await meanReversion.init({ ...PARAMS, ...overrides }, makeContext(options));
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
    const step = await meanReversion.advance(makeJob({ state: current }), makeContext({ ...options, price }));
    steps.push(step);
    current = step.state;
  }
  return steps;
}

describe('mean_reversion init', () => {
  it('is named for the strategy the registry will look up', () => {
    expect(meanReversion.name).toBe('mean_reversion');
  });

  it('rounds the entry size to the venue increment and starts watching', async () => {
    const state = await reversionState({ quantity: '2.123456789' });
    expect(state.quantity).toBe('2.12345678');
    expect(state.phase).toBe('watching');
    expect(state.asset).toBe('BTC');
    expect(state.deadline).toBe(NOW + 60 * 60_000);
  });

  it('rejects an exit deviation at or beyond the entry deviation', async () => {
    await expect(meanReversion.init({ ...PARAMS, exit_z: 2 }, makeContext())).rejects.toThrow(
      /exit_z 2 must be below entry_z 2/,
    );
  });

  it('rejects an unknown side mode', async () => {
    await expect(meanReversion.init({ ...PARAMS, side_mode: 'hedged' }, makeContext())).rejects.toThrow(
      /"side_mode" must be one of: long_only, short_only, both/,
    );
  });

  it('rejects a lookback too short to describe a distribution', async () => {
    await expect(meanReversion.init({ ...PARAMS, lookback_ticks: 4 }, makeContext())).rejects.toThrow(
      /"lookback_ticks" must be an integer between 5 and 500/,
    );
  });

  it('rejects a size below the venue minimum, naming the minimum', async () => {
    await expect(
      meanReversion.init({ ...PARAMS, quantity: '0.1' }, makeContext({ minOrderSize: 0.5 })),
    ).rejects.toThrow(/quantity 0.10000000 BTC is below the venue minimum of 0.5/);
  });

  it('rejects a short-capable job the spot holding cannot cover, and explains why', async () => {
    await expect(
      meanReversion.init({ ...PARAMS, side_mode: 'short_only', quantity: '5' }, makeContext({ held: '1' })),
    ).rejects.toThrow(/Robinhood crypto is spot only: there is no short to open/);

    await expect(
      meanReversion.init({ ...PARAMS, side_mode: 'both', quantity: '5' }, makeContext({ held: '1' })),
    ).rejects.toThrow(/Use side_mode "long_only", or lower quantity to at most 1/);
  });

  it('accepts long_only without any holding at all', async () => {
    const state = await reversionState({}, { held: null });
    expect(state.sideMode).toBe('long_only');
  });
});

describe('mean_reversion signal', () => {
  it('samples a bounded window and trades nothing before it is full', async () => {
    const steps = await run(await reversionState(), WARMUP);

    expect(steps.flatMap(submits)).toHaveLength(0);
    expect(logKinds(steps[0] as StrategyStep)).toEqual(['mean_reversion_warmup']);
    expect((steps[4] as StrategyStep).state.prices).toEqual(WARMUP);
  });

  it('never grows the window past lookback_ticks', async () => {
    const steps = await run(await reversionState(), [...WARMUP, 100, 100, 100]);
    expect((steps[steps.length - 1] as StrategyStep).state.prices).toHaveLength(5);
  });

  it('waits rather than dividing by a flat window', async () => {
    const steps = await run(await reversionState(), [100, 100, 100, 100, 100, 100]);
    const step = steps[5] as StrategyStep;

    expect(logKinds(step)).toEqual(['mean_reversion_flat_window']);
    expect(submits(step)).toHaveLength(0);
  });

  it('holds while the deviation is inside entry_z', async () => {
    const steps = await run(await reversionState(), [...WARMUP, 102]);
    const step = steps[5] as StrategyStep;

    // 2 standard deviations below a mean of 100 is 97.17, and 102 is nowhere near it.
    expect(logKinds(step)).toEqual(['mean_reversion_watching']);
    expect(step.state.phase).toBe('watching');
  });

  it('buys a low deviation on the long side', async () => {
    const steps = await run(await reversionState(), [...WARMUP, 95]);
    const step = steps[5] as StrategyStep;

    expect(logKinds(step)).toContain('mean_reversion_entry');
    expect(submits(step)[0]?.order).toEqual({
      symbol: 'BTC-USD',
      side: 'buy',
      type: 'market',
      assetQuantity: '1.00000000',
    });
    expect(step.state.phase).toBe('in_position');
    expect(step.state.direction).toBe('long');
    expect(step.state.entryPrice).toBe('95');
  });

  it('does not take the short side in long_only mode', async () => {
    const steps = await run(await reversionState(), [...WARMUP, 105]);
    const step = steps[5] as StrategyStep;

    expect(submits(step)).toHaveLength(0);
    expect(step.state.phase).toBe('watching');
  });

  it('sells an existing holding into a high deviation when the short side is allowed', async () => {
    const state = await reversionState({ side_mode: 'both' }, { held: '3' });
    const steps = await run(state, [...WARMUP, 105], { held: '3' });
    const step = steps[5] as StrategyStep;

    expect(submits(step)[0]?.order).toMatchObject({ side: 'sell', type: 'market' });
    expect(step.state.direction).toBe('short');
  });

  it('skips a short entry the holding no longer covers', async () => {
    const state = await reversionState({ side_mode: 'short_only' }, { held: '3' });
    const steps = await run(state, [...WARMUP, 105], { held: '0.1' });
    const step = steps[5] as StrategyStep;

    expect(submits(step)).toHaveLength(0);
    expect(step.state.phase).toBe('watching');
    expect(logKinds(step)).toEqual(['mean_reversion_short_uncovered']);
  });
});

describe('mean_reversion exit', () => {
  /** A long entered at 95, off a window with a mean of 100. */
  async function inPosition(): Promise<Record<string, unknown>> {
    const steps = await run(await reversionState(), [...WARMUP, 95]);
    return (steps[5] as StrategyStep).state;
  }

  it('holds while the price is still stretched', async () => {
    const steps = await run(await inPosition(), [94]);
    const step = steps[0] as StrategyStep;

    expect(submits(step)).toHaveLength(0);
    expect(logKinds(step)).toEqual(['mean_reversion_holding']);
    expect(step.state.phase).toBe('in_position');
  });

  it('closes the long once price reverts within exit_z of the mean', async () => {
    const steps = await run(await inPosition(), [100]);
    const step = steps[0] as StrategyStep;

    expect(submits(step)[0]?.order).toEqual({
      symbol: 'BTC-USD',
      side: 'sell',
      type: 'market',
      assetQuantity: '1.00000000',
    });
    expect(step.done?.status).toBe('completed');
    expect(step.done?.reason).toMatch(/reverted to .* standard deviations/);
    expect(step.state.phase).toBe('exited');
  });

  it('buys back the short side on reversion', async () => {
    const state = await reversionState({ side_mode: 'short_only' }, { held: '3' });
    const entered = (await run(state, [...WARMUP, 105], { held: '3' }))[5] as StrategyStep;

    const step = (await run(entered.state, [100], { held: '3' }))[0] as StrategyStep;

    expect(submits(step)[0]?.order).toMatchObject({ side: 'buy', type: 'market' });
    expect(step.done?.status).toBe('completed');
  });

  it('resumes mid-position from persisted JSON with its window intact', async () => {
    const state = await inPosition();

    const step = await meanReversion.advance(
      makeJob({ state: restart(state) }),
      makeContext({ price: 100 }),
    );

    expect((step.state.prices as number[])).toHaveLength(5);
    expect(submits(step)).toHaveLength(1);
    expect(step.done?.status).toBe('completed');
  });

  it('fails the job when the entry order was rejected', async () => {
    const step = await meanReversion.advance(
      makeJob({ state: await inPosition(), lastError: 'Sell orders are blocked by ROBINHOOD_CRYPTO_BUY_ONLY=1.' }),
      makeContext({ price: 96 }),
    );

    expect(step.done?.status).toBe('failed');
    expect(step.done?.reason).toMatch(/The mean-reversion entry was not placed/);
    expect(submits(step)).toHaveLength(0);
  });
});

describe('mean_reversion termination', () => {
  it('completes without a trade when the duration elapses while watching', async () => {
    const step = await meanReversion.advance(
      makeJob({ state: await reversionState() }),
      makeContext({ now: NOW + 61 * 60_000 }),
    );

    expect(step.done?.status).toBe('completed');
    expect(step.done?.reason).toMatch(/without a deviation large enough to fade/);
    expect(submits(step)).toHaveLength(0);
  });

  it('closes an open position at the deadline rather than leaving it unmanaged', async () => {
    const steps = await run(await reversionState(), [...WARMUP, 95]);

    const step = await meanReversion.advance(
      makeJob({ state: (steps[5] as StrategyStep).state }),
      makeContext({ now: NOW + 61 * 60_000 }),
    );

    expect(submits(step)[0]?.order).toMatchObject({ side: 'sell', type: 'market' });
    expect(step.done?.reason).toMatch(/closed at market rather than being left open unmanaged/);
    expect(logKinds(step)).toContain('mean_reversion_expired_in_position');
  });

  it('stays finished once it has exited', async () => {
    const entered = (await run(await reversionState(), [...WARMUP, 95]))[5] as StrategyStep;
    const exited = (await run(entered.state, [100]))[0] as StrategyStep;

    const step = await meanReversion.advance(makeJob({ state: exited.state }), makeContext({ price: 90 }));

    expect(step.actions).toEqual([]);
    expect(step.done).toEqual({ status: 'completed' });
  });
});

describe('mean_reversion without a price', () => {
  it('skips the tick rather than sampling a guess into the window', async () => {
    const warm = await run(await reversionState(), WARMUP);
    const before = (warm[4] as StrategyStep).state;

    const step = await meanReversion.advance(makeJob({ state: before }), makeContext({ price: null }));

    expect(step.state.prices).toEqual(WARMUP);
    expect(submits(step)).toHaveLength(0);
    expect(step.done).toBeUndefined();
    expect(logKinds(step)).toEqual(['mean_reversion_no_price']);
  });
});
