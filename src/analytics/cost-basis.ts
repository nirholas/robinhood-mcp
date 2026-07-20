/**
 * Cost basis and realized P&L, computed from order history.
 *
 * Robinhood's API reports what you hold and what it is worth now. It does not
 * report what you paid, what you have realized, or which tax lots are open, so
 * anything a trader actually needs at tax time has to be derived from the fills
 * themselves.
 *
 * Lots are matched FIFO, which is the US default for crypto absent a specific
 * identification election. This is a calculation over the fills the API
 * returns, not tax advice, and it is only as complete as the order history the
 * account exposes.
 */

export interface Fill {
  /** Base asset, e.g. BTC. */
  assetCode: string;
  side: 'buy' | 'sell';
  /** Base-asset quantity of this fill. */
  quantity: number;
  /** Execution price per unit in the quote currency. */
  price: number;
  /** Epoch milliseconds. Ordering key for FIFO. */
  timestamp: number;
  orderId: string;
}

export interface OpenLot {
  assetCode: string;
  /** Quantity still open after any sells consumed part of it. */
  quantity: number;
  price: number;
  timestamp: number;
  orderId: string;
  costBasis: number;
}

export interface RealizedDisposal {
  assetCode: string;
  quantity: number;
  proceeds: number;
  costBasis: number;
  realizedPnl: number;
  acquiredAt: number;
  disposedAt: number;
  /** Held longer than a year: relevant to US long-term treatment. */
  longTerm: boolean;
  buyOrderId: string;
  sellOrderId: string;
}

export interface CostBasisResult {
  openLots: OpenLot[];
  disposals: RealizedDisposal[];
  /** Sells with no remaining lot to match, i.e. incomplete history. */
  unmatchedSells: Array<{ assetCode: string; quantity: number; sellOrderId: string }>;
}

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Match fills FIFO into open lots and realized disposals.
 *
 * A sell with no lot to match against is reported in `unmatchedSells` rather
 * than silently assigned a zero basis. Zero basis would overstate the gain and
 * quietly turn incomplete history into a wrong tax number, so the gap is
 * surfaced instead.
 */
export function computeCostBasis(fills: Fill[]): CostBasisResult {
  // Stable chronological order: FIFO is meaningless without it.
  const ordered = [...fills].sort((a, b) => a.timestamp - b.timestamp);

  const lotsByAsset = new Map<string, OpenLot[]>();
  const disposals: RealizedDisposal[] = [];
  const unmatchedSells: CostBasisResult['unmatchedSells'] = [];

  for (const fill of ordered) {
    if (!Number.isFinite(fill.quantity) || fill.quantity <= 0) continue;

    const lots = lotsByAsset.get(fill.assetCode) ?? [];

    if (fill.side === 'buy') {
      lots.push({
        assetCode: fill.assetCode,
        quantity: fill.quantity,
        price: fill.price,
        timestamp: fill.timestamp,
        orderId: fill.orderId,
        costBasis: fill.quantity * fill.price,
      });
      lotsByAsset.set(fill.assetCode, lots);
      continue;
    }

    let remaining = fill.quantity;

    while (remaining > 0 && lots.length > 0) {
      const lot = lots[0];
      if (!lot) break;

      const consumed = Math.min(lot.quantity, remaining);
      const proceeds = consumed * fill.price;
      const basis = consumed * lot.price;

      disposals.push({
        assetCode: fill.assetCode,
        quantity: consumed,
        proceeds,
        costBasis: basis,
        realizedPnl: proceeds - basis,
        acquiredAt: lot.timestamp,
        disposedAt: fill.timestamp,
        longTerm: fill.timestamp - lot.timestamp > ONE_YEAR_MS,
        buyOrderId: lot.orderId,
        sellOrderId: fill.orderId,
      });

      lot.quantity -= consumed;
      lot.costBasis = lot.quantity * lot.price;
      remaining -= consumed;

      if (lot.quantity <= 1e-12) lots.shift();
    }

    if (remaining > 1e-12) {
      unmatchedSells.push({
        assetCode: fill.assetCode,
        quantity: remaining,
        sellOrderId: fill.orderId,
      });
    }

    lotsByAsset.set(fill.assetCode, lots);
  }

  const openLots = [...lotsByAsset.values()].flat().filter((lot) => lot.quantity > 1e-12);
  return { openLots, disposals, unmatchedSells };
}

export interface PositionSummary {
  assetCode: string;
  quantity: number;
  costBasis: number;
  averageCost: number;
  /** Null when no current price was supplied. */
  marketValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPercent: number | null;
  realizedPnl: number;
}

/**
 * Roll lots and disposals into one row per asset.
 *
 * @param prices - Current price per asset code. An asset missing from this map
 *   reports null market value rather than a stale or assumed one.
 */
export function summarizePositions(
  result: CostBasisResult,
  prices: Record<string, number> = {},
): PositionSummary[] {
  const assets = new Set<string>([
    ...result.openLots.map((lot) => lot.assetCode),
    ...result.disposals.map((d) => d.assetCode),
  ]);

  const summaries: PositionSummary[] = [];

  for (const assetCode of assets) {
    const lots = result.openLots.filter((lot) => lot.assetCode === assetCode);
    const quantity = lots.reduce((sum, lot) => sum + lot.quantity, 0);
    const costBasis = lots.reduce((sum, lot) => sum + lot.costBasis, 0);

    const realizedPnl = result.disposals
      .filter((d) => d.assetCode === assetCode)
      .reduce((sum, d) => sum + d.realizedPnl, 0);

    const price = prices[assetCode];
    const marketValue = price === undefined ? null : quantity * price;

    summaries.push({
      assetCode,
      quantity,
      costBasis,
      averageCost: quantity > 0 ? costBasis / quantity : 0,
      marketValue,
      unrealizedPnl: marketValue === null ? null : marketValue - costBasis,
      unrealizedPnlPercent:
        marketValue === null || costBasis === 0 ? null : ((marketValue - costBasis) / costBasis) * 100,
      realizedPnl,
    });
  }

  return summaries.sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0));
}

/**
 * Extract fills from Robinhood order objects.
 *
 * Field names are read defensively: the published schemas and the community
 * clients disagree in places, and an order that cannot be parsed into a fill is
 * skipped rather than guessed at, since a wrong price silently corrupts every
 * downstream number.
 */
export function fillsFromOrders(orders: Array<Record<string, unknown>>): Fill[] {
  const fills: Fill[] = [];

  for (const order of orders) {
    const side = String(order.side ?? '').toLowerCase();
    if (side !== 'buy' && side !== 'sell') continue;

    const symbol = String(order.symbol ?? '');
    const assetCode = symbol.includes('-') ? (symbol.split('-')[0] ?? symbol) : symbol;
    if (!assetCode) continue;

    const orderId = String(order.id ?? '');
    const executions = Array.isArray(order.executions) ? order.executions : [];

    if (executions.length > 0) {
      // Per-execution is the accurate path: one order can fill at many prices.
      for (const raw of executions) {
        const execution = raw as Record<string, unknown>;
        const quantity = Number(execution.quantity);
        const price = Number(execution.effective_price ?? execution.price);
        const timestamp = Date.parse(String(execution.timestamp ?? order.updated_at ?? ''));

        if (!Number.isFinite(quantity) || quantity <= 0) continue;
        if (!Number.isFinite(price) || price <= 0) continue;

        fills.push({
          assetCode,
          side,
          quantity,
          price,
          timestamp: Number.isFinite(timestamp) ? timestamp : 0,
          orderId,
        });
      }
      continue;
    }

    // Fall back to the order-level average only when it actually filled.
    const quantity = Number(order.filled_asset_quantity);
    const price = Number(order.average_price);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    if (!Number.isFinite(price) || price <= 0) continue;

    const timestamp = Date.parse(String(order.updated_at ?? order.created_at ?? ''));
    fills.push({
      assetCode,
      side,
      quantity,
      price,
      timestamp: Number.isFinite(timestamp) ? timestamp : 0,
      orderId,
    });
  }

  return fills;
}
