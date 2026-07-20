import { describe, it, expect } from 'vitest';
import { ladder } from '../src/engine/strategies/ladder.js';
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
    strategy: 'ladder',
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

/** A descending buy ladder, which is the shape the geometry check requires. */
const PARAMS = {
  symbol: 'BTC-USD',
  side: 'buy',
  total_quantity: '3',
  levels: 3,
  start_price: '100',
  end_price: '80',
};

async function ladderState(
  overrides: Record<string, unknown> = {},
  options: FakeContextOptions = {},
): Promise<Record<string, unknown>> {
  const { state } = await ladder.init({ ...PARAMS, ...overrides }, makeContext(options));
  return state;
}

function rungs(state: Record<string, unknown>): Array<{ price: string; quantity: string; clientOrderId: string }> {
  return state.rungs as Array<{ price: string; quantity: string; clientOrderId: string }>;
}

describe('ladder init', () => {
  it('rejects a range that is a single price', async () => {
    await expect(
      ladder.init({ ...PARAMS, end_price: '100' }, makeContext()),
    ).rejects.toThrow(/one price repeated 3 times/);
  });

  it('rejects fewer than two levels', async () => {
    await expect(
      ladder.init({ ...PARAMS, levels: 1 }, makeContext()),
    ).rejects.toThrow(/"levels" must be an integer between 2 and 50/);
  });

  it('rejects an unknown distribution', async () => {
    await expect(
      ladder.init({ ...PARAMS, distribution: 'pyramid' }, makeContext()),
    ).rejects.toThrow(/"distribution" must be one of: even, front, back/);
  });

  it('rejects a buy ladder that climbs, and a sell ladder that falls', async () => {
    await expect(
      ladder.init({ ...PARAMS, start_price: '80', end_price: '100' }, makeContext({ price: 120 })),
    ).rejects.toThrow(/A buy ladder must descend/);

    await expect(
      ladder.init(
        { ...PARAMS, side: 'sell', start_price: '100', end_price: '80' },
        makeContext({ price: 90 }),
      ),
    ).rejects.toThrow(/A sell ladder must ascend/);
  });

  it('rejects a start price that is already through the market', async () => {
    await expect(
      ladder.init(PARAMS, makeContext({ price: 90 })),
    ).rejects.toThrow(/would fill at the touch instead of resting/);
  });

  it('rejects a level below the venue minimum, naming the level and the minimum', async () => {
    await expect(
      ladder.init({ ...PARAMS, levels: 10, total_quantity: '1' }, makeContext({ minOrderSize: 0.5 })),
    ).rejects.toThrow(/Level 1 of 10 would be 0.10000000 BTC, below the venue minimum of 0.5/);
  });

  it('rejects a level that rounds to zero at the venue increment', async () => {
    await expect(
      ladder.init({ ...PARAMS, total_quantity: '0.5', levels: 10 }, makeContext({ assetIncrement: '1' })),
    ).rejects.toThrow(/rounds to zero at the venue increment of 1/);
  });
});

describe('ladder geometry', () => {
  it('spaces rungs evenly across the range, using the endpoints verbatim', async () => {
    const state = await ladderState();
    expect(rungs(state).map((rung) => rung.price)).toEqual(['100', '90.00', '80']);
  });

  it('splits size evenly by default', async () => {
    const state = await ladderState();
    expect(rungs(state).map((rung) => rung.quantity)).toEqual(['1.00000000', '1.00000000', '1.00000000']);
  });

  it('front-loads size toward start_price', async () => {
    const state = await ladderState({ distribution: 'front' });
    expect(rungs(state).map((rung) => rung.quantity)).toEqual(['1.50000000', '1.00000000', '0.50000000']);
  });

  it('back-loads size toward end_price', async () => {
    const state = await ladderState({ distribution: 'back' });
    expect(rungs(state).map((rung) => rung.quantity)).toEqual(['0.50000000', '1.00000000', '1.50000000']);
  });

  it('places the full total across the rungs despite rounding', async () => {
    const state = await ladderState({ total_quantity: '1', levels: 7, distribution: 'front' }, { assetIncrement: '0.01' });
    const total = rungs(state).reduce((sum, rung) => sum + Number(rung.quantity), 0);
    expect(total).toBeGreaterThan(0.98);
    expect(total).toBeLessThanOrEqual(1);
  });

  it('mints one distinct client order id per rung, so a resubmit cannot double a level', async () => {
    const state = await ladderState({ levels: 5, total_quantity: '5' });
    const ids = rungs(state).map((rung) => rung.clientOrderId);
    expect(new Set(ids).size).toBe(5);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('ladder placement', () => {
  it('places a few rungs per advance rather than the whole ladder at once', async () => {
    const state = await ladderState({ levels: 5, total_quantity: '5' });

    const first = await ladder.advance(makeJob({ state }), makeContext());
    expect(submits(first)).toHaveLength(3);
    expect(first.state.placed).toBe(3);
    expect(first.state.lastBatch).toEqual({ from: 1, to: 3 });
    expect(first.done).toBeUndefined();

    const second = await ladder.advance(makeJob({ state: first.state }), makeContext());
    expect(submits(second)).toHaveLength(2);
    expect(second.state.placed).toBe(5);
    expect(second.done).toBeUndefined();
  });

  it('submits each rung as a resting limit order carrying its reserved id', async () => {
    const state = await ladderState();
    const step = await ladder.advance(makeJob({ state }), makeContext());

    expect(submits(step)[0]?.order).toMatchObject({
      symbol: 'BTC-USD',
      side: 'buy',
      type: 'limit',
      assetQuantity: '1.00000000',
      limitPrice: '100',
      timeInForce: 'gtc',
      clientOrderId: rungs(state)[0]?.clientOrderId,
    });
    expect(submits(step)[2]?.order).toMatchObject({ limitPrice: '80' });
  });

  it('honours a day time_in_force when asked for one', async () => {
    const state = await ladderState({ time_in_force: 'day' });
    const step = await ladder.advance(makeJob({ state }), makeContext());
    expect(submits(step)[0]?.order).toMatchObject({ timeInForce: 'day' });
  });

  it('completes one advance after the final batch, not in the same step', async () => {
    const state = await ladderState();
    const placed = (await ladder.advance(makeJob({ state }), makeContext())).state;
    expect(placed.placed).toBe(3);

    const step = await ladder.advance(makeJob({ state: placed }), makeContext());
    expect(submits(step)).toHaveLength(0);
    expect(step.done).toEqual({ status: 'completed' });
    expect(logKinds(step)).toContain('ladder_placed');
  });

  it('resumes mid-ladder from persisted JSON without re-placing a rung', async () => {
    const state = await ladderState({ levels: 5, total_quantity: '5' });
    const placed = (await ladder.advance(makeJob({ state }), makeContext())).state;

    const step = await ladder.advance(makeJob({ state: restart(placed) }), makeContext());

    expect(submits(step)).toHaveLength(2);
    expect(submits(step)[0]?.order.clientOrderId).toBe(rungs(state)[3]?.clientOrderId);
  });
});

describe('ladder rejection', () => {
  it('stops laddering on a rejected rung, names the levels, and leaves the resting ones alone', async () => {
    const state = await ladderState({ levels: 5, total_quantity: '5' });
    const first = (await ladder.advance(makeJob({ state }), makeContext())).state;
    const second = (await ladder.advance(makeJob({ state: first }), makeContext())).state;

    const step = await ladder.advance(
      makeJob({ state: second, lastError: 'Sell orders are blocked by ROBINHOOD_CRYPTO_BUY_ONLY=1.' }),
      makeContext(),
    );

    expect(step.done?.status).toBe('failed');
    expect(step.done?.reason).toMatch(/Ladder levels 4-5 of 5 could not be placed/);
    expect(step.done?.reason).toMatch(/3 earlier level\(s\) are resting/);
    // Cancelling here would undo the fills the ladder exists to collect.
    expect(cancels(step)).toHaveLength(0);
    expect(logKinds(step)).toContain('ladder_rung_rejected');
  });

  it('does not read a stale error before any rung has been placed', async () => {
    const state = await ladderState();
    const step = await ladder.advance(
      makeJob({ state, lastError: 'unrelated earlier failure' }),
      makeContext(),
    );

    expect(step.done).toBeUndefined();
    expect(submits(step)).toHaveLength(3);
  });
});
