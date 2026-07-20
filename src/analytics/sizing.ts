/**
 * Position sizing and risk math.
 *
 * The question "how much should I buy?" has an answer that depends on the stop,
 * not on the account balance alone. These helpers make that answer explicit so
 * an agent sizes from risk rather than from a round number a user guessed.
 */

export interface RiskSizingInput {
  /** Total capital the sizing is measured against. */
  accountValueUsd: number;
  /** Percent of the account to risk if the stop is hit, e.g. 1 for 1%. */
  riskPercent: number;
  entryPrice: number;
  stopPrice: number;
}

export interface RiskSizingResult {
  /** Base-asset quantity to buy. */
  quantity: number;
  notionalUsd: number;
  riskUsd: number;
  /** Distance to the stop as a percent of entry. */
  stopDistancePercent: number;
}

/**
 * Size a position so that hitting the stop loses exactly the intended amount.
 *
 * This inverts the usual mistake. Picking a position size first and then a stop
 * means the loss is whatever it happens to be; picking the risk first and
 * deriving size means it is bounded by construction.
 *
 * @throws {Error} When the stop is on the wrong side of entry or equal to it,
 *   which would imply infinite size.
 */
export function sizeByRisk(input: RiskSizingInput): RiskSizingResult {
  const { accountValueUsd, riskPercent, entryPrice, stopPrice } = input;

  if (!(accountValueUsd > 0)) throw new Error('accountValueUsd must be positive.');
  if (!(riskPercent > 0 && riskPercent <= 100)) {
    throw new Error('riskPercent must be between 0 and 100.');
  }
  if (!(entryPrice > 0) || !(stopPrice > 0)) {
    throw new Error('entryPrice and stopPrice must be positive.');
  }

  const distance = Math.abs(entryPrice - stopPrice);
  if (distance === 0) {
    throw new Error(
      'stopPrice equals entryPrice, which implies unlimited position size. Move the stop away from entry.',
    );
  }

  const riskUsd = accountValueUsd * (riskPercent / 100);
  const quantity = riskUsd / distance;

  return {
    quantity,
    notionalUsd: quantity * entryPrice,
    riskUsd,
    stopDistancePercent: (distance / entryPrice) * 100,
  };
}

/**
 * Estimate the average fill price for a given size against a quote.
 *
 * Robinhood exposes only the top of book, so this models slippage from the
 * spread rather than from real depth. It is a floor on the true cost, not a
 * simulation of the book, and it says so in its result.
 */
export function estimateSlippage(input: {
  bid: number;
  ask: number;
  side: 'buy' | 'sell';
  quantity: number;
}): {
  referencePrice: number;
  spreadPercent: number;
  estimatedCostUsd: number;
  spreadCostUsd: number;
  note: string;
} {
  const { bid, ask, side, quantity } = input;

  if (!(bid > 0) || !(ask > 0)) throw new Error('bid and ask must be positive.');
  if (ask < bid) throw new Error('ask is below bid; the quote is malformed.');

  const mid = (bid + ask) / 2;
  const referencePrice = side === 'buy' ? ask : bid;
  const spreadPercent = ((ask - bid) / mid) * 100;

  return {
    referencePrice,
    spreadPercent,
    estimatedCostUsd: quantity * referencePrice,
    // What crossing the spread costs versus a fill at the midpoint.
    spreadCostUsd: Math.abs(referencePrice - mid) * quantity,
    note: 'Models the quoted spread only. Robinhood publishes no order book depth, so a large order may fill worse than this.',
  };
}

/**
 * Annualized volatility from a price series, using log returns.
 *
 * Returns null for a series too short to say anything, rather than a
 * meaningless number computed from two points.
 */
export function realizedVolatility(
  prices: number[],
  periodsPerYear = 365,
): { volatility: number; samples: number } | null {
  const usable = prices.filter((p) => Number.isFinite(p) && p > 0);
  if (usable.length < 3) return null;

  const returns: number[] = [];
  for (let i = 1; i < usable.length; i++) {
    const previous = usable[i - 1];
    const current = usable[i];
    if (previous === undefined || current === undefined) continue;
    returns.push(Math.log(current / previous));
  }
  if (returns.length < 2) return null;

  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  // Sample variance (n-1): these returns are a sample, not the population.
  const variance =
    returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);

  return {
    volatility: Math.sqrt(variance) * Math.sqrt(periodsPerYear),
    samples: returns.length,
  };
}

/**
 * Largest peak-to-trough decline in a value series, as a percent.
 */
export function maxDrawdown(values: number[]): { drawdownPercent: number; peak: number; trough: number } {
  let peak = -Infinity;
  let worst = 0;
  let worstPeak = 0;
  let worstTrough = 0;

  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value > peak) peak = value;
    if (peak > 0) {
      const drawdown = (peak - value) / peak;
      if (drawdown > worst) {
        worst = drawdown;
        worstPeak = peak;
        worstTrough = value;
      }
    }
  }

  return { drawdownPercent: worst * 100, peak: worstPeak, trough: worstTrough };
}
