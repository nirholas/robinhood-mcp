import { describe, it, expect } from 'vitest';
import { iceberg } from '../src/engine/strategies/iceberg.js';
import type { Job, StrategyAction, StrategyContext, StrategyStep } from '../src/engine/job.js';
import type { Executor } from '../src/shared/executor.js';

/**
 * Strategies are pure step functions, so the whole context can be a plain
 * object. Nothing here touches the network or the executor's order path: a
 * strategy that needed either would be a strategy that could not be resumed.
 */
interface FakeContextOptions {
  /** Overrides both sides at once. Otherwise `bid`/`ask` answer per side. */
  price?: number | null;
  bid?: number;
  ask?: number;
  openOrders?: Array<Record<string, unknown>>;
  assetIncrement?: string | null;
  minOrderSize?: number | null;
  /** What `getOrder` reports for a resolved slice. */
  order?: Record<string, unknown> | null;
  orderThrows?: boolean;
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
    async getOrder(): Promise<unknown> {
      if (options.orderThrows) throw new Error('upstream unavailable');
      return options.order ?? null;
    },
  } as unknown as Executor;

  return {
    executor,
    now: options.now ?? NOW,
    async price(_symbol: string, side: 'buy' | 'sell'): Promise<number | null> {
      if (options.price !== undefined) return options.price;
      return side === 'buy' ? (options.ask ?? 101) : (options.bid ?? 99);
    },
    async openOrders(): Promise<Array<Record<string, unknown>>> {
      return options.openOrders ?? [];
    },
  };
}

function makeJob(overrides: Partial<Job> & { state: Record<string, unknown> }): Job {
  return {
    id: 'job-1',
    strategy: 'iceberg',
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

const PARAMS = {
  symbol: 'BTC-USD',
  side: 'buy',
  total_quantity: '1',
  visible_quantity: '0.25',
  max_duration_minutes: 60,
};

async function icebergState(
  overrides: Record<string, unknown> = {},
  options: FakeContextOptions = {},
): Promise<Record<string, unknown>> {
  const { state } = await iceberg.init({ ...PARAMS, ...overrides }, makeContext(options));
  return state;
}

function working(state: Record<string, unknown>) {
  return state.working as { clientOrderId: string; orderId: string | null; quantity: string } | null;
}

describe('iceberg init', () => {
  it('rejects a visible slice that is not smaller than the total', async () => {
    await expect(
      iceberg.init({ ...PARAMS, visible_quantity: '1' }, makeContext()),
    ).rejects.toThrow(/must be smaller than total_quantity/);
  });

  it('rejects a visible slice below the venue minimum, with the minimum named', async () => {
    await expect(
      iceberg.init({ ...PARAMS, visible_quantity: '0.0001' }, makeContext({ minOrderSize: 0.001 })),
    ).rejects.toThrow(/below the venue minimum of 0.001/);
  });

  it('requires a duration', async () => {
    await expect(
      iceberg.init({ ...PARAMS, max_duration_minutes: undefined }, makeContext()),
    ).rejects.toThrow(/"max_duration_minutes" must be an integer/);
  });

  it('normalizes the symbol and starts with nothing working', async () => {
    const { state, symbol } = await iceberg.init({ ...PARAMS, symbol: 'btc-usd' }, makeContext());
    expect(symbol).toBe('BTC-USD');
    expect(state.working).toBeNull();
    expect(state.filledQuantity).toBe('0');
    expect(state.deadline).toBe(NOW + 60 * 60_000);
    expect(state.limitPrice).toBeNull();
  });
});

describe('iceberg slicing', () => {
  it('shows one slice, pegged to the passive side of the book', async () => {
    const state = await icebergState();
    const step = await iceberg.advance(makeJob({ state }), makeContext({ bid: 99, ask: 101 }));

    // A resting buy wants the bid. Pegging to the ask would cross the spread,
    // which is a market order wearing a limit order's name.
    expect(submits(step)).toHaveLength(1);
    expect(submits(step)[0]?.order).toMatchObject({
      symbol: 'BTC-USD',
      side: 'buy',
      type: 'limit',
      assetQuantity: '0.25000000',
      limitPrice: '99',
    });
    expect(working(step.state)?.quantity).toBe('0.25000000');
    expect(working(step.state)?.clientOrderId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses a fixed limit price for every slice when one was given', async () => {
    const state = await icebergState({ limit_price: '95' });
    const step = await iceberg.advance(makeJob({ state }), makeContext({ bid: 99 }));
    expect(submits(step)[0]?.order).toMatchObject({ type: 'limit', limitPrice: '95' });
  });

  it('never shows a second slice while the first is still resting', async () => {
    const state = await icebergState();
    const placed = (await iceberg.advance(makeJob({ state }), makeContext())).state;
    const open = [{ id: 'rh-1', client_order_id: working(placed)?.clientOrderId }];

    const step = await iceberg.advance(makeJob({ state: placed }), makeContext({ openOrders: open }));

    expect(submits(step)).toHaveLength(0);
    expect(working(step.state)?.orderId).toBe('rh-1');
    expect(step.state.checks).toBe(1);
    expect(step.done).toBeUndefined();
  });

  it('refills only after the working slice has left the book, crediting the real fill', async () => {
    const state = await icebergState();
    const placed = (await iceberg.advance(makeJob({ state }), makeContext())).state;
    const open = [{ id: 'rh-1', client_order_id: working(placed)?.clientOrderId }];
    const seen = (await iceberg.advance(makeJob({ state: placed }), makeContext({ openOrders: open }))).state;

    const step = await iceberg.advance(
      makeJob({ state: seen }),
      makeContext({ openOrders: [], order: { filled_asset_quantity: '0.25' } }),
    );

    expect(logKinds(step)).toContain('iceberg_slice_filled');
    expect(step.state.filledQuantity).toBe('0.25');
    expect(submits(step)).toHaveLength(1);
    expect(working(step.state)?.clientOrderId).not.toBe(working(placed)?.clientOrderId);
  });

  it('credits a partial fill rather than the size that was submitted', async () => {
    const state = await icebergState();
    const placed = (await iceberg.advance(makeJob({ state }), makeContext())).state;
    const open = [{ id: 'rh-1', client_order_id: working(placed)?.clientOrderId }];
    const seen = (await iceberg.advance(makeJob({ state: placed }), makeContext({ openOrders: open }))).state;

    // Cancelled upstream after filling 0.1 of 0.25.
    const step = await iceberg.advance(
      makeJob({ state: seen }),
      makeContext({ openOrders: [], order: { filled_asset_quantity: '0.1' } }),
    );

    expect(step.state.filledQuantity).toBe('0.1');
  });

  it('credits the submitted size when the fill cannot be read', async () => {
    const state = await icebergState();
    const placed = (await iceberg.advance(makeJob({ state }), makeContext())).state;
    const open = [{ id: 'rh-1', client_order_id: working(placed)?.clientOrderId }];
    const seen = (await iceberg.advance(makeJob({ state: placed }), makeContext({ openOrders: open }))).state;

    const step = await iceberg.advance(
      makeJob({ state: seen }),
      makeContext({ openOrders: [], orderThrows: true }),
    );

    // Over-crediting stops the job early; under-crediting would buy more than
    // was asked for. Only one of those two errors costs money.
    expect(step.state.filledQuantity).toBe('0.25');
  });

  it('survives a restart: the working slice comes back out of persisted JSON', async () => {
    const state = await icebergState();
    const placed = (await iceberg.advance(makeJob({ state }), makeContext())).state;
    const open = [{ id: 'rh-1', client_order_id: working(placed)?.clientOrderId }];
    const seen = (await iceberg.advance(makeJob({ state: placed }), makeContext({ openOrders: open }))).state;

    const step = await iceberg.advance(
      makeJob({ state: restart(seen) }),
      makeContext({ openOrders: [], order: { filled_asset_quantity: '0.25' } }),
    );

    expect(step.state.filledQuantity).toBe('0.25');
    expect(submits(step)).toHaveLength(1);
  });

  it('completes once the total is filled', async () => {
    const state = await icebergState();
    const step = await iceberg.advance(
      makeJob({ state: { ...state, filledQuantity: '1' } }),
      makeContext(),
    );

    expect(submits(step)).toHaveLength(0);
    expect(step.done).toEqual({ status: 'completed' });
    expect(logKinds(step)).toContain('iceberg_filled');
  });

  it('stops on a remainder that is real size but below the venue minimum', async () => {
    const state = await icebergState({ visible_quantity: '0.3' }, { minOrderSize: 0.05 });
    const step = await iceberg.advance(
      makeJob({ state: { ...state, filledQuantity: '0.99' } }),
      makeContext({ minOrderSize: 0.05 }),
    );

    expect(submits(step)).toHaveLength(0);
    expect(step.done?.status).toBe('completed');
    expect(step.done?.reason).toMatch(/below the venue minimum of 0.05/);
    expect(logKinds(step)).toContain('iceberg_remainder_below_minimum');
  });
});

describe('iceberg safety', () => {
  it('waits rather than resting size at a guessed price when there is no quote', async () => {
    const state = await icebergState();
    const step = await iceberg.advance(makeJob({ state }), makeContext({ price: null }));

    expect(submits(step)).toHaveLength(0);
    expect(step.done).toBeUndefined();
    expect(logKinds(step)).toEqual(['iceberg_no_price']);
    expect(step.state.working).toBeNull();
  });

  it('fails the job when a slice was rejected, instead of queueing the same rejection', async () => {
    const state = await icebergState();
    const placed = (await iceberg.advance(makeJob({ state }), makeContext())).state;

    const step = await iceberg.advance(
      makeJob({ state: placed, lastError: 'Order value $900.00 exceeds ROBINHOOD_CRYPTO_MAX_ORDER_USD' }),
      makeContext(),
    );

    expect(step.done?.status).toBe('failed');
    expect(step.done?.reason).toMatch(/Iceberg slice was not placed/);
    expect(submits(step)).toHaveLength(0);
  });

  it('cancels the resting slice and completes when the duration elapses', async () => {
    const state = await icebergState();
    const placed = (await iceberg.advance(makeJob({ state }), makeContext())).state;
    const open = [{ id: 'rh-1', client_order_id: working(placed)?.clientOrderId }];
    const seen = (await iceberg.advance(makeJob({ state: placed }), makeContext({ openOrders: open }))).state;

    const expired = NOW + 60 * 60_000 + 1;
    const step = await iceberg.advance(makeJob({ state: seen }), makeContext({ now: expired }));

    expect(cancels(step)).toEqual([{ type: 'cancel', orderId: 'rh-1' }]);
    expect(step.done?.status).toBe('completed');
    expect(step.done?.reason).toMatch(/max_duration_minutes elapsed with 0 of 1 filled/);
    expect(logKinds(step)).toContain('iceberg_expired');
  });

  it('expires without a cancel when no slice is resting', async () => {
    const state = await icebergState();
    const step = await iceberg.advance(
      makeJob({ state }),
      makeContext({ now: NOW + 60 * 60_000 + 1 }),
    );

    expect(cancels(step)).toHaveLength(0);
    expect(submits(step)).toHaveLength(0);
    expect(step.done?.status).toBe('completed');
  });
});
