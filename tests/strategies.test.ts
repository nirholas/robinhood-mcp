import { describe, it, expect } from 'vitest';
import { trailingStop } from '../src/engine/strategies/trailing-stop.js';
import { bracket } from '../src/engine/strategies/bracket.js';
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

function cancels(step: StrategyStep): Extract<StrategyAction, { type: 'cancel' }>[] {
  return step.actions.filter((a): a is Extract<StrategyAction, { type: 'cancel' }> => a.type === 'cancel');
}

function logKinds(step: StrategyStep): string[] {
  return step.actions.filter((a) => a.type === 'log').map((a) => (a as { kind: string }).kind);
}

describe('trailing_stop init', () => {
  it('requires exactly one trail distance', async () => {
    await expect(
      trailingStop.init({ symbol: 'BTC-USD', side: 'sell', quantity: '1' }, makeContext()),
    ).rejects.toThrow(/exactly one of "trail_percent"/);

    await expect(
      trailingStop.init(
        { symbol: 'BTC-USD', side: 'sell', quantity: '1', trail_percent: 5, trail_amount: '100' },
        makeContext(),
      ),
    ).rejects.toThrow(/exactly one of "trail_percent"/);
  });

  it('rejects a quantity below the venue minimum, with the minimum named', async () => {
    await expect(
      trailingStop.init(
        { symbol: 'BTC-USD', side: 'sell', quantity: '0.0001', trail_percent: 5 },
        makeContext({ minOrderSize: 0.001 }),
      ),
    ).rejects.toThrow(/below the venue minimum of 0.001/);
  });

  it('arms immediately without an activation price, and stays dormant with one', async () => {
    const armed = await trailingStop.init(
      { symbol: 'btc-usd', side: 'sell', quantity: '1', trail_percent: 5 },
      makeContext(),
    );
    expect(armed.symbol).toBe('BTC-USD');
    expect(armed.state.activated).toBe(true);
    expect(armed.state.watermark).toBeNull();

    const dormant = await trailingStop.init(
      { symbol: 'BTC-USD', side: 'sell', quantity: '1', trail_percent: 5, activation_price: '120' },
      makeContext(),
    );
    expect(dormant.state.activated).toBe(false);
  });
});

describe('trailing_stop watermark', () => {
  async function armed(overrides: Record<string, unknown> = {}) {
    const { state } = await trailingStop.init(
      { symbol: 'BTC-USD', side: 'sell', quantity: '1', trail_percent: 5, ...overrides },
      makeContext(),
    );
    return state;
  }

  it('sets the watermark on the first priced tick without trading', async () => {
    const step = await trailingStop.advance(makeJob({ state: await armed() }), makeContext({ price: 100 }));
    expect(step.state.watermark).toBe('100');
    expect(submits(step)).toHaveLength(0);
    expect(step.done).toBeUndefined();
  });

  it('ratchets the watermark up and never back down', async () => {
    let state = await armed();
    state = (await trailingStop.advance(makeJob({ state }), makeContext({ price: 100 }))).state;
    state = (await trailingStop.advance(makeJob({ state }), makeContext({ price: 130 }))).state;
    expect(state.watermark).toBe('130');

    // 126 is a retrace, but not past 130 * 0.95 = 123.5, so the watermark holds.
    const step = await trailingStop.advance(makeJob({ state }), makeContext({ price: 126 }));
    expect(step.state.watermark).toBe('130');
    expect(submits(step)).toHaveLength(0);
  });

  it('survives a restart: the watermark comes back out of persisted JSON', async () => {
    let state = await armed();
    state = (await trailingStop.advance(makeJob({ state }), makeContext({ price: 130 }))).state;

    const step = await trailingStop.advance(makeJob({ state: restart(state) }), makeContext({ price: 120 }));
    expect(step.state.watermark).toBe('130');
  });
});

describe('trailing_stop trigger', () => {
  it('exits the full size at market when price retraces past the percent trail', async () => {
    const { state: initial } = await trailingStop.init(
      { symbol: 'BTC-USD', side: 'sell', quantity: '0.5', trail_percent: 5 },
      makeContext(),
    );
    const armed = (await trailingStop.advance(makeJob({ state: initial }), makeContext({ price: 100 }))).state;

    // 100 * 0.95 = 95, and the trail triggers at the stop, not only below it.
    const step = await trailingStop.advance(makeJob({ state: armed }), makeContext({ price: 95 }));

    expect(step.done).toEqual({ status: 'completed' });
    expect(logKinds(step)).toContain('trailing_stop_triggered');
    expect(submits(step)).toHaveLength(1);
    expect(submits(step)[0]?.order).toMatchObject({
      symbol: 'BTC-USD',
      side: 'sell',
      type: 'market',
      assetQuantity: '0.50000000',
    });
  });

  it('uses an absolute trail distance when trail_amount is given', async () => {
    const { state: initial } = await trailingStop.init(
      { symbol: 'BTC-USD', side: 'sell', quantity: '1', trail_amount: '10' },
      makeContext(),
    );
    const armed = (await trailingStop.advance(makeJob({ state: initial }), makeContext({ price: 100 }))).state;

    const held = await trailingStop.advance(makeJob({ state: armed }), makeContext({ price: 91 }));
    expect(held.done).toBeUndefined();

    const fired = await trailingStop.advance(makeJob({ state: armed }), makeContext({ price: 89 }));
    expect(fired.done).toEqual({ status: 'completed' });
    expect(submits(fired)).toHaveLength(1);
  });

  it('trails a short in the other direction: the watermark is the low', async () => {
    const { state: initial } = await trailingStop.init(
      { symbol: 'BTC-USD', side: 'buy', quantity: '1', trail_percent: 10 },
      makeContext(),
    );
    let state = (await trailingStop.advance(makeJob({ state: initial }), makeContext({ price: 100 }))).state;
    state = (await trailingStop.advance(makeJob({ state }), makeContext({ price: 80 }))).state;
    expect(state.watermark).toBe('80');

    const held = await trailingStop.advance(makeJob({ state }), makeContext({ price: 87 }));
    expect(held.done).toBeUndefined();

    // 80 * 1.1 = 88.
    const fired = await trailingStop.advance(makeJob({ state }), makeContext({ price: 88 }));
    expect(fired.done).toEqual({ status: 'completed' });
    expect(submits(fired)[0]?.order.side).toBe('buy');
  });
});

describe('trailing_stop safety', () => {
  it('never triggers on a missing price', async () => {
    const { state: initial } = await trailingStop.init(
      { symbol: 'BTC-USD', side: 'sell', quantity: '1', trail_percent: 5 },
      makeContext(),
    );
    const armed = (await trailingStop.advance(makeJob({ state: initial }), makeContext({ price: 200 }))).state;

    const step = await trailingStop.advance(makeJob({ state: armed }), makeContext({ price: null }));

    // An outage is not a retracement: no order, no completion, watermark intact.
    expect(submits(step)).toHaveLength(0);
    expect(step.done).toBeUndefined();
    expect(logKinds(step)).toEqual(['trailing_stop_no_price']);
    expect(step.state.watermark).toBe('200');
  });

  it('does not arm, or trade, before the activation price is reached', async () => {
    const { state } = await trailingStop.init(
      { symbol: 'BTC-USD', side: 'sell', quantity: '1', trail_percent: 5, activation_price: '120' },
      makeContext(),
    );

    // Well below the trail's stop had it been armed at 100, and still nothing.
    const dormant = await trailingStop.advance(makeJob({ state }), makeContext({ price: 60 }));
    expect(submits(dormant)).toHaveLength(0);
    expect(dormant.state.watermark).toBeNull();
    expect(dormant.state.activated).toBe(false);
    expect(logKinds(dormant)).toEqual(['trailing_stop_dormant']);

    const active = await trailingStop.advance(makeJob({ state }), makeContext({ price: 125 }));
    expect(active.state.activated).toBe(true);
    expect(active.state.watermark).toBe('125');
    expect(submits(active)).toHaveLength(0);
  });
});

const BRACKET_PARAMS = {
  symbol: 'BTC-USD',
  side: 'buy',
  quantity: '0.25',
  entry_type: 'market',
  take_profit_price: '120',
  stop_loss_price: '90',
};

async function bracketState(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { state } = await bracket.init({ ...BRACKET_PARAMS, ...overrides }, makeContext());
  return state;
}

function legs(state: Record<string, unknown>) {
  return {
    entry: state.entry as { clientOrderId: string },
    takeProfit: state.takeProfit as { clientOrderId: string },
    stopLoss: state.stopLoss as { clientOrderId: string },
  };
}

describe('bracket init', () => {
  it('requires an entry price for a limit entry', async () => {
    await expect(
      bracket.init({ ...BRACKET_PARAMS, entry_type: 'limit' }, makeContext()),
    ).rejects.toThrow(/"entry_price" is required when entry_type is "limit"/);
  });

  it('rejects a swapped take-profit and stop-loss', async () => {
    await expect(
      bracket.init(
        { ...BRACKET_PARAMS, take_profit_price: '90', stop_loss_price: '120' },
        makeContext(),
      ),
    ).rejects.toThrow(/probably swapped/);
  });

  it('rejects an entry price that is not between the two exits', async () => {
    await expect(
      bracket.init(
        { ...BRACKET_PARAMS, entry_type: 'limit', entry_price: '130' },
        makeContext(),
      ),
    ).rejects.toThrow(/must sit between stop_loss_price/);
  });

  it('mints distinct client order ids up front so a restart cannot double-place', async () => {
    const state = await bracketState();
    const { entry, takeProfit, stopLoss } = legs(state);
    const ids = [entry.clientOrderId, takeProfit.clientOrderId, stopLoss.clientOrderId];
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.phase).toBe('entry');
    expect(state.exitSide).toBe('sell');
  });
});

describe('bracket phases', () => {
  it('submits the entry with its reserved client order id and moves to entry_fill', async () => {
    const state = await bracketState();
    const step = await bracket.advance(makeJob({ state }), makeContext());

    expect(step.state.phase).toBe('entry_fill');
    expect(submits(step)).toHaveLength(1);
    expect(submits(step)[0]?.order).toMatchObject({
      side: 'buy',
      type: 'market',
      assetQuantity: '0.25000000',
      clientOrderId: legs(state).entry.clientOrderId,
    });
  });

  it('carries the limit price on a limit entry', async () => {
    const state = await bracketState({ entry_type: 'limit', entry_price: '100' });
    const step = await bracket.advance(makeJob({ state }), makeContext());
    expect(submits(step)[0]?.order).toMatchObject({ type: 'limit', limitPrice: '100' });
  });

  it('fails the job when the entry submit was rejected, instead of placing exits', async () => {
    const state = await bracketState();
    const submitted = (await bracket.advance(makeJob({ state }), makeContext())).state;

    const step = await bracket.advance(
      makeJob({ state: submitted, lastError: 'Order value $900.00 exceeds ROBINHOOD_CRYPTO_MAX_ORDER_USD' }),
      makeContext(),
    );

    expect(step.done?.status).toBe('failed');
    expect(step.done?.reason).toMatch(/Entry order was not placed/);
    expect(submits(step)).toHaveLength(0);
  });

  it('waits while a limit entry is still resting in the book', async () => {
    const state = await bracketState({ entry_type: 'limit', entry_price: '100' });
    const submitted = (await bracket.advance(makeJob({ state }), makeContext())).state;
    const open = [{ id: 'rh-entry', client_order_id: legs(state).entry.clientOrderId }];

    const step = await bracket.advance(makeJob({ state: submitted }), makeContext({ openOrders: open }));

    expect(step.state.phase).toBe('entry_fill');
    expect(submits(step)).toHaveLength(0);
    expect((step.state.entry as { seenOpen: boolean; orderId: string }).seenOpen).toBe(true);
    expect((step.state.entry as { orderId: string }).orderId).toBe('rh-entry');
  });

  it('treats a market entry that never rests as filled on the first check', async () => {
    const state = await bracketState();
    const submitted = (await bracket.advance(makeJob({ state }), makeContext())).state;

    const step = await bracket.advance(makeJob({ state: submitted }), makeContext({ openOrders: [] }));

    expect(step.state.phase).toBe('exits');
    expect(logKinds(step)).toContain('bracket_entry_filled');
  });

  it('gives an unseen limit entry a second reading before calling it filled', async () => {
    const state = await bracketState({ entry_type: 'limit', entry_price: '100' });
    let current = (await bracket.advance(makeJob({ state }), makeContext())).state;

    current = (await bracket.advance(makeJob({ state: current }), makeContext({ openOrders: [] }))).state;
    expect(current.phase).toBe('entry_fill');

    const step = await bracket.advance(makeJob({ state: current }), makeContext({ openOrders: [] }));
    expect(step.state.phase).toBe('exits');
  });

  it('places both exits, on the opposite side, once the entry is filled', async () => {
    const state = await bracketState();
    const filled = { ...state, phase: 'exits' };

    const step = await bracket.advance(makeJob({ state: filled }), makeContext());
    const placed = submits(step);

    expect(step.state.phase).toBe('monitor');
    expect(placed).toHaveLength(2);
    expect(placed[0]?.order).toMatchObject({
      side: 'sell',
      type: 'limit',
      limitPrice: '120',
      clientOrderId: legs(state).takeProfit.clientOrderId,
    });
    expect(placed[1]?.order).toMatchObject({
      side: 'sell',
      type: 'stop_loss',
      stopPrice: '90',
      clientOrderId: legs(state).stopLoss.clientOrderId,
    });
  });

  it('fails loudly when an exit leg was rejected, rather than managing a half bracket', async () => {
    const state = await bracketState();
    const monitoring = (await bracket.advance(makeJob({ state: { ...state, phase: 'exits' } }), makeContext())).state;

    const step = await bracket.advance(
      makeJob({ state: monitoring, lastError: 'Sell orders are blocked by ROBINHOOD_CRYPTO_BUY_ONLY=1.' }),
      makeContext(),
    );

    expect(step.done?.status).toBe('failed');
    expect(step.done?.reason).toMatch(/An exit leg was not placed/);
    expect(cancels(step)).toHaveLength(0);
  });
});

describe('bracket OCO', () => {
  /** Drive a bracket to `monitor` with both exits observed open, as upstream would report them. */
  async function monitoring(overrides: Record<string, unknown> = {}) {
    const state = await bracketState(overrides);
    const { takeProfit, stopLoss } = legs(state);
    const open = [
      { id: 'rh-tp', client_order_id: takeProfit.clientOrderId },
      { id: 'rh-sl', client_order_id: stopLoss.clientOrderId },
    ];
    const placed = (await bracket.advance(makeJob({ state: { ...state, phase: 'exits' } }), makeContext())).state;
    const seen = await bracket.advance(makeJob({ state: placed }), makeContext({ openOrders: open }));
    return { state: seen.state, step: seen, open, ids: { takeProfit, stopLoss } };
  }

  it('does nothing while both exits are open', async () => {
    const { step } = await monitoring();
    expect(step.actions).toHaveLength(0);
    expect(step.done).toBeUndefined();
    expect((step.state.takeProfit as { orderId: string }).orderId).toBe('rh-tp');
    expect((step.state.stopLoss as { orderId: string }).orderId).toBe('rh-sl');
  });

  it('cancels the stop-loss when the take-profit fills', async () => {
    const { state, open } = await monitoring();
    const stopLossOnly = open.filter((order) => order.id === 'rh-sl');

    const step = await bracket.advance(makeJob({ state }), makeContext({ openOrders: stopLossOnly }));

    expect(cancels(step)).toEqual([{ type: 'cancel', orderId: 'rh-sl' }]);
    expect(step.done).toEqual({ status: 'completed' });
    expect(logKinds(step)).toContain('bracket_exit_filled');
  });

  it('cancels the take-profit when the stop-loss fills', async () => {
    const { state, open } = await monitoring();
    const takeProfitOnly = open.filter((order) => order.id === 'rh-tp');

    const step = await bracket.advance(makeJob({ state }), makeContext({ openOrders: takeProfitOnly }));

    expect(cancels(step)).toEqual([{ type: 'cancel', orderId: 'rh-tp' }]);
    expect(step.done).toEqual({ status: 'completed' });
  });

  it('cancels after a restart, using the order id recovered from persisted state', async () => {
    const { state, open } = await monitoring();
    const stopLossOnly = open.filter((order) => order.id === 'rh-sl');

    const step = await bracket.advance(makeJob({ state: restart(state) }), makeContext({ openOrders: stopLossOnly }));

    expect(cancels(step)).toEqual([{ type: 'cancel', orderId: 'rh-sl' }]);
  });

  it('completes without a cancel when both exits are already gone', async () => {
    const { state } = await monitoring();

    const step = await bracket.advance(makeJob({ state }), makeContext({ openOrders: [] }));

    expect(cancels(step)).toHaveLength(0);
    expect(step.done).toEqual({ status: 'completed' });
    expect(logKinds(step)).toContain('bracket_exits_closed');
  });

  it('keeps watching rather than cancelling a survivor whose upstream id is unusable', async () => {
    // The stop-loss is listed open but the row carries no usable id, so there
    // is nothing that can be cancelled. Completing here would leave a live exit
    // order behind with no job watching it.
    const state = await bracketState();
    const { takeProfit, stopLoss } = legs(state);
    const placed = (await bracket.advance(makeJob({ state: { ...state, phase: 'exits' } }), makeContext())).state;
    const both = [
      { id: 'rh-tp', client_order_id: takeProfit.clientOrderId },
      { client_order_id: stopLoss.clientOrderId },
    ];

    const seen = (await bracket.advance(makeJob({ state: placed }), makeContext({ openOrders: both }))).state;
    expect((seen.stopLoss as { seenOpen: boolean; orderId: string | null }).orderId).toBeNull();

    const step = await bracket.advance(
      makeJob({ state: seen }),
      makeContext({ openOrders: both.filter((order) => order.id === undefined) }),
    );

    expect(cancels(step)).toHaveLength(0);
    expect(step.done).toBeUndefined();
    expect(logKinds(step)).toContain('bracket_survivor_unidentified');
  });

  it('treats an exit that is never listed open as filled, and cancels the one that is', async () => {
    // A stop that triggers on placement fills before it can ever be seen
    // resting, so absence across the grace window is a fill, not a gap.
    const state = await bracketState();
    const { takeProfit } = legs(state);
    const placed = (await bracket.advance(makeJob({ state: { ...state, phase: 'exits' } }), makeContext())).state;
    const open = [{ id: 'rh-tp', client_order_id: takeProfit.clientOrderId }];

    const first = (await bracket.advance(makeJob({ state: placed }), makeContext({ openOrders: open }))).state;
    const step = await bracket.advance(makeJob({ state: first }), makeContext({ openOrders: open }));

    expect(cancels(step)).toEqual([{ type: 'cancel', orderId: 'rh-tp' }]);
    expect(step.done).toEqual({ status: 'completed' });
  });
});
