import { describe, it, expect } from 'vitest';
import { chase } from '../src/engine/strategies/chase.js';
import type { Job, StrategyAction, StrategyContext, StrategyStep } from '../src/engine/job.js';
import type { Executor } from '../src/shared/executor.js';

/**
 * Strategies are pure step functions, so the whole context can be a plain
 * object. Nothing here touches the network or the executor's order path: a
 * strategy that needed either would be a strategy that could not be resumed.
 */
interface FakeContextOptions {
  price?: number | null;
  openOrders?: Array<Record<string, unknown>>;
  assetIncrement?: string | null;
  quoteIncrement?: string | null;
  minOrderSize?: number | null;
  now?: number;
}

function makeContext(options: FakeContextOptions = {}): StrategyContext {
  const executor = {
    async tradingPair(): Promise<Record<string, unknown> | null> {
      return {
        asset_increment: options.assetIncrement === undefined ? '0.00000001' : options.assetIncrement,
        ...(options.quoteIncrement ? { quote_increment: options.quoteIncrement } : {}),
        min_order_size: options.minOrderSize ?? 0,
      };
    },
  } as unknown as Executor;

  return {
    executor,
    now: options.now ?? 1_700_000_000_000,
    async price(): Promise<number | null> {
      return options.price === undefined ? 100 : options.price;
    },
    async openOrders(): Promise<Array<Record<string, unknown>>> {
      return options.openOrders ?? [];
    },
  };
}

function makeJob(overrides: Partial<Job> & { state: Record<string, unknown> }): Job {
  return {
    id: 'job-1',
    strategy: 'chase',
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

function resting(state: Record<string, unknown>) {
  return state.resting as {
    clientOrderId: string;
    orderId: string | null;
    price: string;
    cancelRequested: boolean;
    cancelChecks: number;
  } | null;
}

const CHASE_PARAMS = {
  symbol: 'BTC-USD',
  side: 'buy',
  quantity: '0.5',
  max_chases: 3,
  offset_bps: 5,
};

async function chaseState(
  overrides: Record<string, unknown> = {},
  options: FakeContextOptions = {},
): Promise<Record<string, unknown>> {
  const { state } = await chase.init({ ...CHASE_PARAMS, ...overrides }, makeContext(options));
  return state;
}

/** Post the opening order and report it back as resting in the book. */
async function posted(overrides: Record<string, unknown> = {}, price = 100) {
  const state = await chaseState(overrides, { price });
  const first = await chase.advance(makeJob({ state }), makeContext({ price }));
  const leg = resting(first.state);
  const open = [{ id: 'rh-1', client_order_id: leg?.clientOrderId }];
  const seen = await chase.advance(makeJob({ state: first.state }), makeContext({ price, openOrders: open }));
  return { state: seen.state, step: seen, open, firstStep: first };
}

describe('chase init', () => {
  it('rejects a max_chases outside the supported range, by name', async () => {
    await expect(chase.init({ ...CHASE_PARAMS, max_chases: 0 }, makeContext())).rejects.toThrow(
      /"max_chases" must be an integer between 1 and 100/,
    );
  });

  it('rejects an offset that is not a number, by name', async () => {
    await expect(chase.init({ ...CHASE_PARAMS, offset_bps: 'tight' }, makeContext())).rejects.toThrow(
      /"offset_bps" must be a number between -1000 and 1000/,
    );
  });

  it('rejects a quantity below the venue minimum, with the minimum named', async () => {
    await expect(
      chase.init({ ...CHASE_PARAMS, quantity: '0.0001' }, makeContext({ minOrderSize: 0.001 })),
    ).rejects.toThrow(/below the venue minimum of 0.001/);
  });

  it('rejects a ceiling that is nowhere near the market, since it could never fill', async () => {
    await expect(
      chase.init({ ...CHASE_PARAMS, limit_price: '10' }, makeContext({ price: 100 })),
    ).rejects.toThrow(/never fill/);
  });

  it('normalizes the symbol and starts with nothing resting', async () => {
    const { state, symbol } = await chase.init(
      { ...CHASE_PARAMS, symbol: 'btc-usd' },
      makeContext(),
    );
    expect(symbol).toBe('BTC-USD');
    expect(state.resting).toBeNull();
    expect(state.chasesUsed).toBe(0);
  });
});

describe('chase posting', () => {
  it('posts a limit inside the touch by the offset, and does not spend a chase on it', async () => {
    const state = await chaseState();
    const step = await chase.advance(makeJob({ state }), makeContext({ price: 100 }));

    expect(submits(step)).toHaveLength(1);
    expect(submits(step)[0]?.order).toMatchObject({
      symbol: 'BTC-USD',
      side: 'buy',
      type: 'limit',
      assetQuantity: '0.50000000',
      limitPrice: '99.95',
    });
    expect(step.state.chasesUsed).toBe(0);
    expect(resting(step.state)?.clientOrderId).toMatch(/^[0-9a-f-]{36}$/);
    expect(logKinds(step)).toContain('chase_posted');
  });

  it('posts a sell on the other side of the touch', async () => {
    const state = await chaseState({ side: 'sell' });
    const step = await chase.advance(makeJob({ state }), makeContext({ price: 100 }));
    expect(submits(step)[0]?.order).toMatchObject({ side: 'sell', limitPrice: '100.05' });
  });

  it('waits instead of guessing a price when the venue is not quoting', async () => {
    const state = await chaseState();
    const step = await chase.advance(makeJob({ state }), makeContext({ price: null }));

    expect(submits(step)).toHaveLength(0);
    expect(step.state.resting).toBeNull();
    expect(step.done).toBeUndefined();
    expect(logKinds(step)).toEqual(['chase_no_price']);
  });

  it('fails when the post was rejected upstream', async () => {
    const state = await chaseState();
    const placed = (await chase.advance(makeJob({ state }), makeContext())).state;

    const step = await chase.advance(
      makeJob({ state: placed, lastError: 'Order value $900.00 exceeds ROBINHOOD_CRYPTO_MAX_ORDER_USD' }),
      makeContext(),
    );

    expect(step.done?.status).toBe('failed');
    expect(step.done?.reason).toMatch(/The chase order was not placed/);
  });
});

describe('chase following the book', () => {
  it('holds still while the book has not moved away', async () => {
    const { state, open } = await posted();

    const step = await chase.advance(makeJob({ state }), makeContext({ price: 100, openOrders: open }));

    expect(step.actions).toHaveLength(0);
    expect(step.done).toBeUndefined();
  });

  it('holds still when the market comes toward the resting order', async () => {
    const { state, open } = await posted();

    // The ask fell, so the resting bid is now more aggressive than it needs to
    // be and is about to fill. Repricing into that would only pay more.
    const step = await chase.advance(makeJob({ state }), makeContext({ price: 98, openOrders: open }));

    expect(cancels(step)).toHaveLength(0);
    expect(step.actions).toHaveLength(0);
  });

  it('cancels first, and does not post the replacement in the same step', async () => {
    const { state, open } = await posted();

    const step = await chase.advance(makeJob({ state }), makeContext({ price: 101, openOrders: open }));

    expect(cancels(step)).toEqual([{ type: 'cancel', orderId: 'rh-1' }]);
    // Submitting alongside the cancel is how a chase ends up holding twice the size.
    expect(submits(step)).toHaveLength(0);
    expect(resting(step.state)?.cancelRequested).toBe(true);
    expect(step.state.chasesUsed).toBe(0);
  });

  it('reposts at the new price once the cancel is confirmed, spending one chase', async () => {
    const { state, open } = await posted();
    const cancelling = (await chase.advance(makeJob({ state }), makeContext({ price: 101, openOrders: open })))
      .state;
    const firstId = resting(cancelling)?.clientOrderId;

    const step = await chase.advance(makeJob({ state: cancelling }), makeContext({ price: 101, openOrders: [] }));

    expect(submits(step)).toHaveLength(1);
    expect(submits(step)[0]?.order).toMatchObject({ limitPrice: '100.9495', side: 'buy' });
    expect(step.state.chasesUsed).toBe(1);
    // A new order is a new id, so a resubmit after a crash cannot revive the old one.
    expect(resting(step.state)?.clientOrderId).not.toBe(firstId);
    expect(logKinds(step)).toContain('chase_reposted');
  });

  it('waits for the cancel to be confirmed before reposting, then gives up rather than doubling size', async () => {
    const { state, open } = await posted();
    let current = (await chase.advance(makeJob({ state }), makeContext({ price: 101, openOrders: open }))).state;

    for (const attempt of [1, 2, 3]) {
      const step = await chase.advance(makeJob({ state: current }), makeContext({ price: 101, openOrders: open }));
      expect(submits(step)).toHaveLength(0);
      expect(resting(step.state)?.cancelChecks).toBe(attempt);
      current = step.state;
    }

    const step = await chase.advance(makeJob({ state: current }), makeContext({ price: 101, openOrders: open }));
    expect(step.done?.status).toBe('failed');
    expect(step.done?.reason).toMatch(/would hold twice the intended size/);
    expect(submits(step)).toHaveLength(0);
  });

  it('treats a refused cancel as a fill and never reposts behind it', async () => {
    const { state, open } = await posted();
    const cancelling = (await chase.advance(makeJob({ state }), makeContext({ price: 101, openOrders: open })))
      .state;

    const step = await chase.advance(
      makeJob({ state: cancelling, lastError: 'Order rh-1 is not cancellable.' }),
      makeContext({ price: 101, openOrders: [] }),
    );

    expect(submits(step)).toHaveLength(0);
    expect(step.done?.status).toBe('completed');
    expect(step.done?.reason).toMatch(/left the book first/);
    expect(logKinds(step)).toContain('chase_cancel_rejected');
  });

  it('completes when the resting order leaves the book on its own', async () => {
    const { state } = await posted();

    const step = await chase.advance(makeJob({ state }), makeContext({ price: 100, openOrders: [] }));

    expect(step.done?.status).toBe('completed');
    expect(step.done?.reason).toMatch(/Filled at a resting limit of 99.95/);
    expect(logKinds(step)).toContain('chase_filled');
  });

  it('will not cancel an order whose upstream id it has never seen', async () => {
    const state = await chaseState();
    const placed = (await chase.advance(makeJob({ state }), makeContext({ price: 100 }))).state;
    const leg = resting(placed);
    const openWithoutId = [{ client_order_id: leg?.clientOrderId }];

    const step = await chase.advance(
      makeJob({ state: placed }),
      makeContext({ price: 101, openOrders: openWithoutId }),
    );

    expect(cancels(step)).toHaveLength(0);
    expect(logKinds(step)).toContain('chase_unidentified');
  });
});

describe('chase bounds', () => {
  it('clamps to the caller ceiling and never posts through it', async () => {
    const state = await chaseState({ limit_price: '100' }, { price: 100 });

    // The ask is well above the ceiling, so the post sits at the ceiling exactly.
    const step = await chase.advance(makeJob({ state }), makeContext({ price: 140 }));

    expect(submits(step)[0]?.order).toMatchObject({ limitPrice: '100' });
  });

  it('holds at the ceiling without burning chases while the market runs away', async () => {
    const state = await chaseState({ limit_price: '100' }, { price: 100 });
    const placed = (await chase.advance(makeJob({ state }), makeContext({ price: 140 }))).state;
    const leg = resting(placed);
    const open = [{ id: 'rh-1', client_order_id: leg?.clientOrderId }];
    const seen = (await chase.advance(makeJob({ state: placed }), makeContext({ price: 140, openOrders: open })))
      .state;

    const step = await chase.advance(makeJob({ state: seen }), makeContext({ price: 200, openOrders: open }));

    expect(cancels(step)).toHaveLength(0);
    expect(step.state.chasesUsed).toBe(0);
    expect(resting(step.state)?.price).toBe('100');
  });

  it('clamps a sell to the caller floor', async () => {
    const state = await chaseState({ side: 'sell', limit_price: '100' }, { price: 100 });

    const step = await chase.advance(makeJob({ state }), makeContext({ price: 80 }));

    expect(submits(step)[0]?.order).toMatchObject({ side: 'sell', limitPrice: '100' });
  });

  it('leaves the last order resting when the chase budget is spent', async () => {
    const { state, open } = await posted({ max_chases: 1 });
    const cancelling = (await chase.advance(makeJob({ state }), makeContext({ price: 101, openOrders: open })))
      .state;
    const reposted = (await chase.advance(makeJob({ state: cancelling }), makeContext({ price: 101, openOrders: [] })))
      .state;
    expect(reposted.chasesUsed).toBe(1);

    const secondOpen = [{ id: 'rh-2', client_order_id: resting(reposted)?.clientOrderId }];
    const seen = (
      await chase.advance(makeJob({ state: reposted }), makeContext({ price: 101, openOrders: secondOpen }))
    ).state;

    const step = await chase.advance(makeJob({ state: seen }), makeContext({ price: 110, openOrders: secondOpen }));

    expect(step.done?.status).toBe('completed');
    expect(step.done?.reason).toMatch(/Used all 1 chases/);
    expect(step.done?.reason).toMatch(/left resting/);
    // The order stays live on purpose: cancelling turns a working order into a
    // guaranteed miss.
    expect(cancels(step)).toHaveLength(0);
    expect(logKinds(step)).toContain('chase_exhausted');
  });
});

describe('chase resumption', () => {
  it('resumes a resting order out of persisted JSON and keeps following it', async () => {
    const { state, open } = await posted();

    const step = await chase.advance(makeJob({ state: restart(state) }), makeContext({ price: 101, openOrders: open }));

    expect(cancels(step)).toEqual([{ type: 'cancel', orderId: 'rh-1' }]);
    expect(resting(step.state)?.price).toBe('99.95');
  });

  it('resumes mid-cancel without placing a duplicate', async () => {
    const { state, open } = await posted();
    const cancelling = (await chase.advance(makeJob({ state }), makeContext({ price: 101, openOrders: open })))
      .state;

    const step = await chase.advance(
      makeJob({ state: restart(cancelling) }),
      makeContext({ price: 101, openOrders: open }),
    );

    expect(submits(step)).toHaveLength(0);
    expect(resting(step.state)?.cancelRequested).toBe(true);
  });

  it('respects a quote increment when it rounds the target price', async () => {
    const state = await chaseState({}, { price: 100, quoteIncrement: '0.01' });
    const step = await chase.advance(makeJob({ state }), makeContext({ price: 100 }));

    expect(submits(step)[0]?.order).toMatchObject({ limitPrice: '99.95' });
    expect(state.quoteIncrement).toBe('0.01');
  });
});
