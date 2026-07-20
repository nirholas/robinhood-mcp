import { describe, it, expect } from 'vitest';
import { dca } from '../src/engine/strategies/dca.js';
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
const HOUR_MS = 60 * 60 * 1000;

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
    strategy: 'dca',
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

const QUOTE_PARAMS = {
  symbol: 'BTC-USD',
  side: 'buy',
  quote_amount_per_buy: '200',
  interval_hours: 168,
  occurrences: 4,
};

const ASSET_PARAMS = {
  symbol: 'BTC-USD',
  side: 'buy',
  asset_quantity_per_buy: '0.05',
  interval_hours: 24,
  occurrences: 3,
};

async function dcaState(
  overrides: Record<string, unknown> = {},
  options: FakeContextOptions = {},
): Promise<Record<string, unknown>> {
  const { state } = await dca.init({ ...QUOTE_PARAMS, ...overrides }, makeContext(options));
  return state;
}

describe('dca init', () => {
  it('requires exactly one sizing unit', async () => {
    await expect(
      dca.init({ symbol: 'BTC-USD', side: 'buy', interval_hours: 24, occurrences: 3 }, makeContext()),
    ).rejects.toThrow(/exactly one of "quote_amount_per_buy"/);

    await expect(
      dca.init(
        { ...QUOTE_PARAMS, asset_quantity_per_buy: '0.05' },
        makeContext(),
      ),
    ).rejects.toThrow(/exactly one of "quote_amount_per_buy"/);
  });

  it('rejects an interval fast enough to be a TWAP', async () => {
    await expect(
      dca.init({ ...QUOTE_PARAMS, interval_hours: 0.1 }, makeContext()),
    ).rejects.toThrow(/"interval_hours" must be a number between 0.25 and 8760/);
  });

  it('rejects an occurrence count outside the supported range', async () => {
    await expect(
      dca.init({ ...QUOTE_PARAMS, occurrences: 0 }, makeContext()),
    ).rejects.toThrow(/"occurrences" must be an integer between 1 and 1000/);
  });

  it('rejects an asset size below the venue minimum, with the minimum named', async () => {
    await expect(
      dca.init({ ...ASSET_PARAMS, asset_quantity_per_buy: '0.0001' }, makeContext({ minOrderSize: 0.001 })),
    ).rejects.toThrow(/below the venue minimum of 0.001/);
  });

  it('rejects a quote amount that buys less than the venue minimum at the current price', async () => {
    await expect(
      dca.init({ ...QUOTE_PARAMS, quote_amount_per_buy: '5' }, makeContext({ price: 100, minOrderSize: 0.5 })),
    ).rejects.toThrow(/Raise quote_amount_per_buy to at least 50.00/);
  });

  it('does not block a plan just because the venue could not be priced at init', async () => {
    const { state, symbol } = await dca.init(
      { ...QUOTE_PARAMS, symbol: 'btc-usd' },
      makeContext({ price: null, minOrderSize: 0.5 }),
    );
    expect(symbol).toBe('BTC-USD');
    expect(state.occurrencesDone).toBe(0);
    expect(state.intervalMs).toBe(168 * HOUR_MS);
    expect(state.assetQuantityPerBuy).toBeNull();
  });
});

describe('dca execution', () => {
  it('buys a quote amount as a bounded limit order at the execution price', async () => {
    const state = await dcaState();
    const step = await dca.advance(makeJob({ state }), makeContext({ price: 100 }));

    // Robinhood accepts quote_amount on a limit order but not on a market one.
    expect(submits(step)[0]?.order).toMatchObject({
      symbol: 'BTC-USD',
      side: 'buy',
      type: 'limit',
      quoteAmount: '200',
      limitPrice: '100',
    });
    expect(step.state.occurrencesDone).toBe(1);
    expect(step.nextRunAt).toBe(NOW + 168 * HOUR_MS);
    expect(step.done).toBeUndefined();
  });

  it('buys an asset quantity at market, rounded to the venue increment', async () => {
    const state = (await dca.init(ASSET_PARAMS, makeContext())).state;
    const step = await dca.advance(makeJob({ state }), makeContext());

    expect(submits(step)[0]?.order).toMatchObject({
      side: 'buy',
      type: 'market',
      assetQuantity: '0.05000000',
    });
    expect(submits(step)[0]?.order.quoteAmount).toBeUndefined();
    expect(step.nextRunAt).toBe(NOW + 24 * HOUR_MS);
  });

  it('does not need a quote at all for an unguarded asset-sized buy', async () => {
    const state = (await dca.init(ASSET_PARAMS, makeContext())).state;
    const step = await dca.advance(makeJob({ state }), makeContext({ price: null }));

    expect(submits(step)).toHaveLength(1);
    expect(step.state.occurrencesDone).toBe(1);
  });

  it('trims float noise out of a derived limit price', async () => {
    const state = await dcaState();
    const step = await dca.advance(makeJob({ state }), makeContext({ price: 100.123456789123 }));
    expect(submits(step)[0]?.order.limitPrice).toBe('100.12345679');
  });

  it('completes on the final occurrence, in the same step that submits it', async () => {
    const state = await dcaState({ occurrences: 2 });
    const first = (await dca.advance(makeJob({ state }), makeContext())).state;
    const step = await dca.advance(makeJob({ state: first }), makeContext());

    expect(submits(step)).toHaveLength(1);
    expect(step.state.occurrencesDone).toBe(2);
    expect(step.done).toEqual({ status: 'completed' });
  });

  it('resumes the plan from persisted JSON rather than starting it over', async () => {
    const state = await dcaState({ occurrences: 3 });
    const afterOne = (await dca.advance(makeJob({ state }), makeContext())).state;

    const step = await dca.advance(makeJob({ state: restart(afterOne) }), makeContext());

    expect(step.state.occurrencesDone).toBe(2);
    expect(step.done).toBeUndefined();
  });

  it('never buys again once the count is spent', async () => {
    const state = await dcaState({ occurrences: 1 });
    const step = await dca.advance(
      makeJob({ state: { ...state, occurrencesDone: 1 } }),
      makeContext(),
    );

    expect(submits(step)).toHaveLength(0);
    expect(step.done).toEqual({ status: 'completed' });
  });
});

describe('dca price guard', () => {
  it('skips a buy above max_price without consuming an occurrence', async () => {
    const state = await dcaState({ max_price: '95' });
    const step = await dca.advance(makeJob({ state }), makeContext({ price: 100 }));

    expect(submits(step)).toHaveLength(0);
    expect(step.state.occurrencesDone).toBe(0);
    expect(step.done).toBeUndefined();
    expect(logKinds(step)).toEqual(['dca_buy_skipped']);
    // No nextRunAt override: the plan retries on the short default cadence
    // rather than losing the whole interval.
    expect(step.nextRunAt).toBeUndefined();
  });

  it('buys once price comes back under the ceiling', async () => {
    const state = await dcaState({ max_price: '95' });
    const step = await dca.advance(makeJob({ state }), makeContext({ price: 94 }));

    expect(submits(step)).toHaveLength(1);
    expect(step.state.occurrencesDone).toBe(1);
  });

  it('mirrors the guard for a sell: it skips below the price, not above it', async () => {
    const state = await dcaState({ side: 'sell', max_price: '105' });

    const skipped = await dca.advance(makeJob({ state }), makeContext({ price: 100 }));
    expect(submits(skipped)).toHaveLength(0);
    expect(logKinds(skipped)).toEqual(['dca_buy_skipped']);

    const sold = await dca.advance(makeJob({ state }), makeContext({ price: 110 }));
    expect(submits(sold)[0]?.order).toMatchObject({ side: 'sell', type: 'limit' });
  });

  it('does not consume an occurrence when there is no price to check the guard against', async () => {
    const state = await dcaState({ max_price: '95' });
    const step = await dca.advance(makeJob({ state }), makeContext({ price: null }));

    expect(submits(step)).toHaveLength(0);
    expect(step.state.occurrencesDone).toBe(0);
    expect(logKinds(step)).toEqual(['dca_no_price']);
  });

  it('does not consume an occurrence when a quote buy cannot be priced', async () => {
    const state = await dcaState();
    const step = await dca.advance(makeJob({ state }), makeContext({ price: 0 }));

    expect(submits(step)).toHaveLength(0);
    expect(step.state.occurrencesDone).toBe(0);
    expect(logKinds(step)).toEqual(['dca_no_price']);
  });
});
