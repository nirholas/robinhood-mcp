import { describe, it, expect } from 'vitest';
import { oco } from '../src/engine/strategies/oco.js';
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
  minOrderSize?: number | null;
  now?: number;
}

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
    strategy: 'oco',
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

const OCO_PARAMS = {
  symbol: 'BTC-USD',
  side: 'sell',
  quantity: '0.25',
  take_profit_price: '120',
  stop_price: '90',
};

async function ocoState(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { state } = await oco.init({ ...OCO_PARAMS, ...overrides }, makeContext());
  return state;
}

function legs(state: Record<string, unknown>) {
  return {
    takeProfit: state.takeProfit as { clientOrderId: string; orderId: string | null },
    stop: state.stop as { clientOrderId: string; orderId: string | null },
  };
}

/** Drive an OCO to `monitor` with both legs observed resting, as upstream would report them. */
async function monitoring(overrides: Record<string, unknown> = {}) {
  const state = await ocoState(overrides);
  const { takeProfit, stop } = legs(state);
  const open = [
    { id: 'rh-tp', client_order_id: takeProfit.clientOrderId },
    { id: 'rh-stop', client_order_id: stop.clientOrderId },
  ];
  const placed = (await oco.advance(makeJob({ state }), makeContext())).state;
  const seen = await oco.advance(makeJob({ state: placed }), makeContext({ openOrders: open }));
  return { state: seen.state, step: seen, open };
}

describe('oco init', () => {
  it('rejects a swapped take-profit and stop', async () => {
    await expect(
      oco.init({ ...OCO_PARAMS, take_profit_price: '90', stop_price: '120' }, makeContext()),
    ).rejects.toThrow(/probably swapped/);
  });

  it('checks the geometry the other way round for a buy exit', async () => {
    await expect(
      oco.init({ ...OCO_PARAMS, side: 'buy' }, makeContext()),
    ).rejects.toThrow(/take_profit_price must be below stop_price/);

    const covered = await oco.init(
      { ...OCO_PARAMS, side: 'buy', take_profit_price: '90', stop_price: '120' },
      makeContext(),
    );
    expect(covered.state.side).toBe('buy');
  });

  it('rejects a stop-limit whose limit could never be marketable', async () => {
    await expect(
      oco.init({ ...OCO_PARAMS, stop_limit_price: '95' }, makeContext()),
    ).rejects.toThrow(/wrong side of stop_price/);

    const valid = await oco.init({ ...OCO_PARAMS, stop_limit_price: '89' }, makeContext());
    expect(valid.state.stopLimitPrice).toBe('89');
  });

  it('rejects a quantity below the venue minimum, with the minimum named', async () => {
    await expect(
      oco.init({ ...OCO_PARAMS, quantity: '0.0001' }, makeContext({ minOrderSize: 0.001 })),
    ).rejects.toThrow(/below the venue minimum of 0.001/);
  });

  it('rejects a missing take_profit_price by name', async () => {
    const { take_profit_price: _omitted, ...withoutTakeProfit } = OCO_PARAMS;
    await expect(oco.init(withoutTakeProfit, makeContext())).rejects.toThrow(
      /"take_profit_price" must be a positive decimal/,
    );
  });

  it('mints distinct client order ids up front so a restart cannot double-place', async () => {
    const state = await ocoState();
    const { takeProfit, stop } = legs(state);
    expect(takeProfit.clientOrderId).not.toBe(stop.clientOrderId);
    for (const id of [takeProfit.clientOrderId, stop.clientOrderId]) {
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(state.phase).toBe('place');
    expect(state.filledBy).toBeNull();
  });
});

describe('oco placement', () => {
  it('places both legs on the same side, with their reserved client order ids', async () => {
    const state = await ocoState();
    const step = await oco.advance(makeJob({ state }), makeContext());
    const placed = submits(step);

    expect(step.state.phase).toBe('monitor');
    expect(placed).toHaveLength(2);
    expect(placed[0]?.order).toMatchObject({
      symbol: 'BTC-USD',
      side: 'sell',
      type: 'limit',
      limitPrice: '120',
      assetQuantity: '0.25000000',
      clientOrderId: legs(state).takeProfit.clientOrderId,
    });
    expect(placed[1]?.order).toMatchObject({
      side: 'sell',
      type: 'stop_loss',
      stopPrice: '90',
      clientOrderId: legs(state).stop.clientOrderId,
    });
  });

  it('places a stop_limit when stop_limit_price is supplied', async () => {
    const state = await ocoState({ stop_limit_price: '89' });
    const step = await oco.advance(makeJob({ state }), makeContext());

    expect(submits(step)[1]?.order).toMatchObject({
      type: 'stop_limit',
      stopPrice: '90',
      limitPrice: '89',
    });
  });

  it('fails loudly when a leg was rejected, rather than managing half a pair', async () => {
    const state = await ocoState();
    const placed = (await oco.advance(makeJob({ state }), makeContext())).state;

    const step = await oco.advance(
      makeJob({ state: placed, lastError: 'Sell orders are blocked by ROBINHOOD_CRYPTO_BUY_ONLY=1.' }),
      makeContext(),
    );

    expect(step.done?.status).toBe('failed');
    expect(step.done?.reason).toMatch(/An OCO leg was not placed/);
    expect(cancels(step)).toHaveLength(0);
    expect(logKinds(step)).toContain('oco_leg_rejected');
  });
});

describe('oco firing', () => {
  it('does nothing while both legs rest, and learns their upstream ids', async () => {
    const { step } = await monitoring();

    expect(step.actions).toHaveLength(0);
    expect(step.done).toBeUndefined();
    expect(legs(step.state).takeProfit.orderId).toBe('rh-tp');
    expect(legs(step.state).stop.orderId).toBe('rh-stop');
  });

  it('cancels the stop when the take-profit fills, without completing yet', async () => {
    const { state, open } = await monitoring();
    const stopOnly = open.filter((order) => order.id === 'rh-stop');

    const step = await oco.advance(makeJob({ state }), makeContext({ openOrders: stopOnly }));

    expect(cancels(step)).toEqual([{ type: 'cancel', orderId: 'rh-stop' }]);
    expect(logKinds(step)).toContain('oco_leg_filled');
    // Not done: a cancel can be refused, and finishing here would leave a live
    // exit order with no job watching it.
    expect(step.done).toBeUndefined();
    expect(step.state.phase).toBe('cancelling');
    expect(step.state.filledBy).toBe('take_profit');
  });

  it('cancels the take-profit when the stop fills', async () => {
    const { state, open } = await monitoring();
    const takeProfitOnly = open.filter((order) => order.id === 'rh-tp');

    const step = await oco.advance(makeJob({ state }), makeContext({ openOrders: takeProfitOnly }));

    expect(cancels(step)).toEqual([{ type: 'cancel', orderId: 'rh-tp' }]);
    expect(step.state.filledBy).toBe('stop');
  });

  it('completes once the cancelled survivor has left the book', async () => {
    const { state, open } = await monitoring();
    const fired = (
      await oco.advance(makeJob({ state }), makeContext({ openOrders: open.filter((o) => o.id === 'rh-stop') }))
    ).state;

    const step = await oco.advance(makeJob({ state: fired }), makeContext({ openOrders: [] }));

    expect(step.done?.status).toBe('completed');
    expect(step.done?.reason).toMatch(/take_profit leg filled and the resting stop leg was cancelled/);
    expect(logKinds(step)).toContain('oco_cancel_confirmed');
  });

  it('keeps watching rather than cancelling a survivor with no usable id', async () => {
    const state = await ocoState();
    const { takeProfit, stop } = legs(state);
    const placed = (await oco.advance(makeJob({ state }), makeContext())).state;
    const both = [
      { id: 'rh-tp', client_order_id: takeProfit.clientOrderId },
      { client_order_id: stop.clientOrderId },
    ];

    const seen = (await oco.advance(makeJob({ state: placed }), makeContext({ openOrders: both }))).state;
    expect(legs(seen).stop.orderId).toBeNull();

    const step = await oco.advance(
      makeJob({ state: seen }),
      makeContext({ openOrders: both.filter((order) => order.id === undefined) }),
    );

    expect(cancels(step)).toHaveLength(0);
    expect(step.done).toBeUndefined();
    expect(logKinds(step)).toContain('oco_survivor_unidentified');
  });

  it('retries a cancel that has not landed, then gives up loudly', async () => {
    const { state, open } = await monitoring();
    const stopOnly = open.filter((order) => order.id === 'rh-stop');
    let current = (await oco.advance(makeJob({ state }), makeContext({ openOrders: stopOnly }))).state;

    // The survivor is still open on every reading, so the cancel is re-issued.
    for (const attempt of [2, 3]) {
      const step = await oco.advance(makeJob({ state: current }), makeContext({ openOrders: stopOnly }));
      expect(cancels(step)).toEqual([{ type: 'cancel', orderId: 'rh-stop' }]);
      expect(step.state.cancelAttempts).toBe(attempt);
      expect(step.done).toBeUndefined();
      current = step.state;
    }

    const step = await oco.advance(makeJob({ state: current }), makeContext({ openOrders: stopOnly }));
    expect(step.done?.status).toBe('failed');
    expect(step.done?.reason).toMatch(/still open after 3 cancel attempts/);
    expect(logKinds(step)).toContain('oco_cancel_unconfirmed');
  });
});

describe('oco double fill', () => {
  it('detects both legs leaving the book in the same reading and fails with the exposure named', async () => {
    const { state } = await monitoring();

    const step = await oco.advance(makeJob({ state }), makeContext({ openOrders: [] }));

    expect(step.done?.status).toBe('failed');
    expect(step.done?.reason).toMatch(/Both OCO legs left the book in the same reading/);
    expect(step.done?.reason).toMatch(/exited twice/);
    expect(logKinds(step)).toContain('oco_double_fill');
    // Nothing to cancel: both are already gone. Silence here is the bug.
    expect(cancels(step)).toHaveLength(0);
  });

  it('treats a refused cancel as the survivor having filled too', async () => {
    const { state, open } = await monitoring();
    const fired = (
      await oco.advance(makeJob({ state }), makeContext({ openOrders: open.filter((o) => o.id === 'rh-stop') }))
    ).state;

    const step = await oco.advance(
      makeJob({ state: fired, lastError: 'Order rh-stop is not cancellable.' }),
      makeContext({ openOrders: [] }),
    );

    expect(step.done?.status).toBe('failed');
    expect(step.done?.reason).toMatch(/could not be cancelled/);
    expect(step.done?.reason).toMatch(/exited twice/);
    expect(logKinds(step)).toContain('oco_double_fill');
  });
});

describe('oco resumption', () => {
  it('cancels after a restart, using the order id recovered from persisted state', async () => {
    const { state, open } = await monitoring();
    const stopOnly = open.filter((order) => order.id === 'rh-stop');

    const step = await oco.advance(makeJob({ state: restart(state) }), makeContext({ openOrders: stopOnly }));

    expect(cancels(step)).toEqual([{ type: 'cancel', orderId: 'rh-stop' }]);
  });

  it('resumes mid-cancel and still completes, with no second placement', async () => {
    const { state, open } = await monitoring();
    const fired = (
      await oco.advance(makeJob({ state }), makeContext({ openOrders: open.filter((o) => o.id === 'rh-stop') }))
    ).state;

    const step = await oco.advance(makeJob({ state: restart(fired) }), makeContext({ openOrders: [] }));

    expect(submits(step)).toHaveLength(0);
    expect(step.done?.status).toBe('completed');
  });

  it('fails instead of placing legs it could never size', async () => {
    const state = await ocoState();
    const step = await oco.advance(
      makeJob({ state: { ...state, quantity: '0.0000000001' } }),
      makeContext(),
    );

    expect(submits(step)).toHaveLength(0);
    expect(step.done?.status).toBe('failed');
    expect(logKinds(step)).toContain('oco_rounded_to_zero');
  });
});
