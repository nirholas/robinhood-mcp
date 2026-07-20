import { describe, it, expect } from 'vitest';
import {
  computeCostBasis,
  summarizePositions,
  fillsFromOrders,
  type Fill,
} from '../src/analytics/cost-basis.js';
import {
  sizeByRisk,
  estimateSlippage,
  realizedVolatility,
  maxDrawdown,
} from '../src/analytics/sizing.js';

const DAY = 24 * 60 * 60 * 1000;
const fill = (over: Partial<Fill> & Pick<Fill, 'side' | 'quantity' | 'price'>): Fill => ({
  assetCode: 'BTC',
  timestamp: 0,
  orderId: 'o1',
  ...over,
});

describe('FIFO cost basis', () => {
  it('matches the oldest lot first', () => {
    const { disposals, openLots } = computeCostBasis([
      fill({ side: 'buy', quantity: 1, price: 100, timestamp: 1 * DAY, orderId: 'buy-1' }),
      fill({ side: 'buy', quantity: 1, price: 200, timestamp: 2 * DAY, orderId: 'buy-2' }),
      fill({ side: 'sell', quantity: 1, price: 300, timestamp: 3 * DAY, orderId: 'sell-1' }),
    ]);

    // FIFO sells the $100 lot, not the $200 one: gain is 200, not 100.
    expect(disposals).toHaveLength(1);
    expect(disposals[0]?.costBasis).toBe(100);
    expect(disposals[0]?.realizedPnl).toBe(200);
    expect(disposals[0]?.buyOrderId).toBe('buy-1');

    expect(openLots).toHaveLength(1);
    expect(openLots[0]?.price).toBe(200);
  });

  it('splits a sell across several lots', () => {
    const { disposals, openLots } = computeCostBasis([
      fill({ side: 'buy', quantity: 1, price: 100, timestamp: 1 * DAY, orderId: 'b1' }),
      fill({ side: 'buy', quantity: 1, price: 200, timestamp: 2 * DAY, orderId: 'b2' }),
      fill({ side: 'sell', quantity: 1.5, price: 300, timestamp: 3 * DAY, orderId: 's1' }),
    ]);

    expect(disposals).toHaveLength(2);
    expect(disposals[0]?.quantity).toBe(1);
    expect(disposals[1]?.quantity).toBeCloseTo(0.5);
    // 1 @ 100 -> +200, then 0.5 @ 200 -> +50.
    expect(disposals[0]?.realizedPnl).toBe(200);
    expect(disposals[1]?.realizedPnl).toBeCloseTo(50);
    expect(openLots[0]?.quantity).toBeCloseTo(0.5);
  });

  it('sorts fills chronologically before matching', () => {
    // FIFO is meaningless if the input arrives newest-first, which is how
    // Robinhood returns order history.
    const { disposals } = computeCostBasis([
      fill({ side: 'sell', quantity: 1, price: 300, timestamp: 3 * DAY, orderId: 's1' }),
      fill({ side: 'buy', quantity: 1, price: 100, timestamp: 1 * DAY, orderId: 'b1' }),
    ]);

    expect(disposals).toHaveLength(1);
    expect(disposals[0]?.costBasis).toBe(100);
  });

  it('reports an unmatched sell instead of assuming a zero basis', () => {
    // Zero basis would overstate the gain and turn incomplete history into a
    // wrong tax number.
    const { disposals, unmatchedSells } = computeCostBasis([
      fill({ side: 'sell', quantity: 2, price: 300, timestamp: 3 * DAY, orderId: 's1' }),
    ]);

    expect(disposals).toHaveLength(0);
    expect(unmatchedSells).toEqual([{ assetCode: 'BTC', quantity: 2, sellOrderId: 's1' }]);
  });

  it('reports the partially unmatched remainder of a sell', () => {
    const { disposals, unmatchedSells } = computeCostBasis([
      fill({ side: 'buy', quantity: 1, price: 100, timestamp: 1 * DAY }),
      fill({ side: 'sell', quantity: 3, price: 300, timestamp: 2 * DAY, orderId: 's1' }),
    ]);

    expect(disposals).toHaveLength(1);
    expect(unmatchedSells[0]?.quantity).toBeCloseTo(2);
  });

  it('keeps assets independent', () => {
    const { openLots } = computeCostBasis([
      fill({ assetCode: 'BTC', side: 'buy', quantity: 1, price: 100, timestamp: 1 }),
      fill({ assetCode: 'ETH', side: 'buy', quantity: 5, price: 10, timestamp: 2 }),
      fill({ assetCode: 'ETH', side: 'sell', quantity: 5, price: 20, timestamp: 3 }),
    ]);

    // Selling all the ETH must not touch the BTC lot.
    expect(openLots).toHaveLength(1);
    expect(openLots[0]?.assetCode).toBe('BTC');
  });

  it('marks a holding over a year as long term', () => {
    const { disposals } = computeCostBasis([
      fill({ side: 'buy', quantity: 1, price: 100, timestamp: 0 }),
      fill({ side: 'sell', quantity: 1, price: 200, timestamp: 400 * DAY }),
    ]);
    expect(disposals[0]?.longTerm).toBe(true);
  });

  it('marks a holding under a year as short term', () => {
    const { disposals } = computeCostBasis([
      fill({ side: 'buy', quantity: 1, price: 100, timestamp: 0 }),
      fill({ side: 'sell', quantity: 1, price: 200, timestamp: 100 * DAY }),
    ]);
    expect(disposals[0]?.longTerm).toBe(false);
  });

  it('does not leave a dust lot behind after a full exit', () => {
    // Float subtraction can leave 1e-17 of an asset, which would show as an
    // open position forever.
    const { openLots } = computeCostBasis([
      fill({ side: 'buy', quantity: 0.1, price: 100, timestamp: 1 }),
      fill({ side: 'buy', quantity: 0.2, price: 100, timestamp: 2 }),
      fill({ side: 'sell', quantity: 0.3, price: 100, timestamp: 3 }),
    ]);
    expect(openLots).toHaveLength(0);
  });
});

describe('summarizePositions', () => {
  const result = computeCostBasis([
    fill({ side: 'buy', quantity: 2, price: 100, timestamp: 1 * DAY }),
    fill({ side: 'sell', quantity: 1, price: 150, timestamp: 2 * DAY }),
  ]);

  it('computes average cost, unrealized and realized together', () => {
    const [position] = summarizePositions(result, { BTC: 200 });

    expect(position?.quantity).toBe(1);
    expect(position?.averageCost).toBe(100);
    expect(position?.marketValue).toBe(200);
    expect(position?.unrealizedPnl).toBe(100);
    expect(position?.unrealizedPnlPercent).toBe(100);
    expect(position?.realizedPnl).toBe(50);
  });

  it('reports null market value rather than assuming a price', () => {
    const [position] = summarizePositions(result, {});
    expect(position?.marketValue).toBeNull();
    expect(position?.unrealizedPnl).toBeNull();
    // Realized P&L is still known: it does not depend on a current price.
    expect(position?.realizedPnl).toBe(50);
  });
});

describe('fillsFromOrders', () => {
  it('prefers per-execution prices over the order average', () => {
    // One order can fill at several prices; the average would lose that.
    const fills = fillsFromOrders([
      {
        id: 'o1',
        symbol: 'BTC-USD',
        side: 'buy',
        average_price: '150',
        executions: [
          { quantity: '1', effective_price: '100', timestamp: '2026-01-01T00:00:00Z' },
          { quantity: '1', effective_price: '200', timestamp: '2026-01-01T00:00:01Z' },
        ],
      },
    ]);

    expect(fills).toHaveLength(2);
    expect(fills.map((f) => f.price)).toEqual([100, 200]);
  });

  it('falls back to the order average when there are no executions', () => {
    const fills = fillsFromOrders([
      {
        id: 'o1',
        symbol: 'ETH-USD',
        side: 'sell',
        filled_asset_quantity: '2',
        average_price: '3000',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ]);

    expect(fills).toEqual([
      expect.objectContaining({ assetCode: 'ETH', side: 'sell', quantity: 2, price: 3000 }),
    ]);
  });

  it('skips an unfilled or unparseable order rather than inventing a fill', () => {
    const fills = fillsFromOrders([
      { id: 'o1', symbol: 'BTC-USD', side: 'buy', filled_asset_quantity: '0', average_price: '100' },
      { id: 'o2', symbol: 'BTC-USD', side: 'buy' },
      { id: 'o3', symbol: 'BTC-USD', side: 'nonsense', filled_asset_quantity: '1', average_price: '1' },
    ]);
    expect(fills).toHaveLength(0);
  });
});

describe('sizeByRisk', () => {
  it('sizes so the stop loses exactly the intended amount', () => {
    const result = sizeByRisk({
      accountValueUsd: 10_000,
      riskPercent: 1,
      entryPrice: 100,
      stopPrice: 90,
    });

    // Risk $100 over a $10 stop distance means 10 units.
    expect(result.riskUsd).toBe(100);
    expect(result.quantity).toBe(10);
    expect(result.notionalUsd).toBe(1_000);
    expect(result.stopDistancePercent).toBe(10);
  });

  it('handles a stop above entry, for a short', () => {
    const result = sizeByRisk({
      accountValueUsd: 10_000,
      riskPercent: 1,
      entryPrice: 100,
      stopPrice: 110,
    });
    expect(result.quantity).toBe(10);
  });

  it('refuses a stop equal to entry instead of returning infinity', () => {
    expect(() =>
      sizeByRisk({ accountValueUsd: 10_000, riskPercent: 1, entryPrice: 100, stopPrice: 100 }),
    ).toThrow(/unlimited position size/);
  });

  it('rejects nonsensical inputs', () => {
    expect(() =>
      sizeByRisk({ accountValueUsd: 0, riskPercent: 1, entryPrice: 100, stopPrice: 90 }),
    ).toThrow(/accountValueUsd/);
    expect(() =>
      sizeByRisk({ accountValueUsd: 100, riskPercent: 0, entryPrice: 100, stopPrice: 90 }),
    ).toThrow(/riskPercent/);
  });
});

describe('estimateSlippage', () => {
  it('charges the ask for a buy and the bid for a sell', () => {
    const buy = estimateSlippage({ bid: 99, ask: 101, side: 'buy', quantity: 10 });
    expect(buy.referencePrice).toBe(101);
    expect(buy.estimatedCostUsd).toBe(1_010);
    expect(buy.spreadCostUsd).toBe(10);

    const sell = estimateSlippage({ bid: 99, ask: 101, side: 'sell', quantity: 10 });
    expect(sell.referencePrice).toBe(99);
  });

  it('computes the spread against the midpoint', () => {
    const result = estimateSlippage({ bid: 99, ask: 101, side: 'buy', quantity: 1 });
    expect(result.spreadPercent).toBe(2);
  });

  it('rejects a crossed quote', () => {
    expect(() => estimateSlippage({ bid: 101, ask: 99, side: 'buy', quantity: 1 })).toThrow(
      /below bid/,
    );
  });
});

describe('realizedVolatility', () => {
  it('returns null for a series too short to mean anything', () => {
    expect(realizedVolatility([100])).toBeNull();
    expect(realizedVolatility([100, 101])).toBeNull();
  });

  it('reports zero for a flat series', () => {
    const result = realizedVolatility([100, 100, 100, 100]);
    expect(result?.volatility).toBe(0);
  });

  it('scales with the size of the moves', () => {
    const calm = realizedVolatility([100, 101, 100, 101, 100]);
    const wild = realizedVolatility([100, 130, 90, 140, 80]);
    expect(wild!.volatility).toBeGreaterThan(calm!.volatility);
  });
});

describe('maxDrawdown', () => {
  it('measures the largest peak-to-trough decline', () => {
    const result = maxDrawdown([100, 120, 60, 80]);
    expect(result.drawdownPercent).toBe(50);
    expect(result.peak).toBe(120);
    expect(result.trough).toBe(60);
  });

  it('reports zero for a series that only rises', () => {
    expect(maxDrawdown([100, 110, 120]).drawdownPercent).toBe(0);
  });
});
