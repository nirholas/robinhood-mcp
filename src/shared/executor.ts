/**
 * The single path through which every order in this package reaches Robinhood.
 *
 * Direct order tools and multi-leg algorithms both go through `submitOrder`,
 * so a spend cap or allowlist cannot be bypassed by reaching for a different
 * tool. Algorithms compose this; they never call the HTTP client themselves.
 */

import { randomUUID } from 'node:crypto';
import type { RobinhoodCryptoClient } from './client.js';
import { endpointsFor, requiresAccountNumber } from './endpoints.js';
import type { Credentials } from './config.js';
import { PolicyError, SpendLedger, type ExecutionPolicy } from './execution-mode.js';
import type { KillSwitch } from './kill-switch.js';

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop_loss' | 'stop_limit';

export interface OrderRequest {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  assetQuantity?: string | undefined;
  quoteAmount?: string | undefined;
  limitPrice?: string | undefined;
  stopPrice?: string | undefined;
  timeInForce?: 'gtc' | 'day' | undefined;
  clientOrderId?: string | undefined;
}

export interface PricedOrder {
  request: OrderRequest;
  /** Wire body exactly as it will be sent. */
  body: Record<string, unknown>;
  notionalUsd: number | null;
  referencePrice: number | null;
  pricedFrom: string;
}

/**
 * Result of a `client_order_id` lookup.
 *
 * Three states, deliberately. `inconclusive` is the one that matters: it means
 * the search did not complete, and the caller must not infer absence from it.
 */
export type OrderLookup =
  | { status: 'found'; order: Record<string, unknown> }
  | { status: 'not_found' }
  | { status: 'inconclusive'; reason: string };

/** How far back of the intent timestamp to search, covering clock skew. */
const RECONCILE_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Page ceiling for a reconciliation walk. Exceeding it yields `inconclusive`. */
const RECONCILE_MAX_PAGES = 50;

export interface SubmitResult {
  placed: boolean;
  order?: unknown;
  preview?: PricedOrder;
  notionalUsd: number | null;
}

export class Executor {
  private cachedAccountNumber: string | undefined;

  constructor(
    private readonly client: RobinhoodCryptoClient,
    private readonly credentials: Credentials,
    private readonly policy: ExecutionPolicy,
    private readonly ledger: SpendLedger,
    /**
     * The emergency stop, when one is configured.
     *
     * Checked here rather than in a tool module because the daemon builds its
     * own Executor and loads no modules: a halt enforced anywhere else would
     * leave the one unattended process in the system still trading.
     */
    private readonly killSwitch?: KillSwitch,
  ) {}

  /**
   * Refuse everything while the kill switch is engaged.
   *
   * @throws {PolicyError} So a halt surfaces through the same path as a
   *   breached cap: `toolError` renders it verbatim, and strategies already
   *   treat it as a reason to stop rather than a transient failure to retry.
   */
  private assertNotHalted(): void {
    if (!this.killSwitch) return;
    const state = this.killSwitch.read();
    if (state.engaged) throw new PolicyError(this.killSwitch.blockMessage(state));
  }

  get executionPolicy(): ExecutionPolicy {
    return this.policy;
  }

  get spendLedger(): SpendLedger {
    return this.ledger;
  }

  private get endpoints() {
    return endpointsFor(this.credentials.apiVersion);
  }

  /** Resolve the account number v2 endpoints require. */
  async accountNumber(): Promise<string | undefined> {
    if (!requiresAccountNumber(this.credentials.apiVersion)) return undefined;
    if (this.cachedAccountNumber) return this.cachedAccountNumber;

    const accounts = await this.client.get<{ results?: Array<{ account_number?: string }> }>(
      this.endpoints.accounts,
    );
    const resolved = accounts?.results?.[0]?.account_number;
    if (!resolved) {
      throw new Error('Could not resolve account_number, which API v2 requires.');
    }
    this.cachedAccountNumber = resolved;
    return resolved;
  }

  /**
   * The raw quote row for a symbol, unmapped.
   *
   * Callers that need both sides of the book (slippage and spread analysis)
   * read this rather than calling `referencePrice` twice, which would issue two
   * requests against a rate limit of 100/minute and could straddle a tick.
   */
  async rawQuote(symbol: string): Promise<Record<string, unknown> | null> {
    const quote = await this.client.get<{ results?: Array<Record<string, unknown>> }>(
      this.endpoints.bestBidAsk,
      { query: { symbol: [symbol.toUpperCase()] } },
    );
    return quote?.results?.[0] ?? null;
  }

  /**
   * Best available execution-side price for a symbol.
   *
   * Uses the spread-inclusive price when Robinhood provides it, since that is
   * what a market order actually pays, not the mid.
   */
  async referencePrice(symbol: string, side: OrderSide): Promise<number | null> {
    const row = await this.rawQuote(symbol);
    if (!row) return null;

    const keys =
      side === 'buy'
        ? ['ask_inclusive_of_buy_spread', 'ask', 'ask_price', 'price']
        : ['bid_inclusive_of_sell_spread', 'bid', 'bid_price', 'price'];

    for (const key of keys) {
      const value = Number(row[key]);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return null;
  }

  /** Price an order and build its wire body, without sending anything. */
  async price(request: OrderRequest): Promise<PricedOrder> {
    const symbol = request.symbol.toUpperCase();

    let notionalUsd: number | null = null;
    let referencePrice: number | null = null;
    let pricedFrom = 'unavailable';

    if (request.quoteAmount !== undefined) {
      const value = Number(request.quoteAmount);
      notionalUsd = Number.isFinite(value) ? value : null;
      pricedFrom = 'quote_amount';
    } else if (request.assetQuantity !== undefined) {
      const quantity = Number(request.assetQuantity);
      if (Number.isFinite(quantity)) {
        if (request.limitPrice !== undefined) {
          const limit = Number(request.limitPrice);
          if (Number.isFinite(limit)) {
            notionalUsd = quantity * limit;
            pricedFrom = 'limit_price';
          }
        } else {
          referencePrice = await this.referencePrice(symbol, request.side);
          if (referencePrice !== null) {
            notionalUsd = quantity * referencePrice;
            pricedFrom = 'live best bid/ask';
          }
        }
      }
    }

    return {
      request: { ...request, symbol },
      body: buildOrderBody({ ...request, symbol }),
      notionalUsd,
      referencePrice,
      pricedFrom,
    };
  }

  /**
   * Check an order against every policy control.
   *
   * @throws {PolicyError} On the first violation. Fails closed: an order whose
   *   value cannot be determined is rejected, never assumed cheap.
   */
  assertAllowed(priced: PricedOrder): void {
    this.assertNotHalted();

    const { symbol, side } = priced.request;

    if (this.policy.symbolAllowlist && !this.policy.symbolAllowlist.includes(symbol)) {
      throw new PolicyError(
        `Symbol ${symbol} is not in ROBINHOOD_CRYPTO_SYMBOL_ALLOWLIST ` +
          `(${this.policy.symbolAllowlist.join(', ')}).`,
      );
    }

    if (this.policy.buyOnly && side === 'sell') {
      throw new PolicyError('Sell orders are blocked by ROBINHOOD_CRYPTO_BUY_ONLY=1.');
    }

    if (priced.notionalUsd === null) {
      throw new PolicyError(
        `Cannot determine the USD value of this ${symbol} order, so the per-order ceiling ` +
          `($${this.policy.maxOrderUsd}) cannot be enforced. Specify quote_amount, or use a ` +
          'limit order where quantity x limit_price is known.',
      );
    }

    if (priced.notionalUsd > this.policy.maxOrderUsd) {
      throw new PolicyError(
        `Order value $${priced.notionalUsd.toFixed(2)} exceeds ROBINHOOD_CRYPTO_MAX_ORDER_USD ` +
          `($${this.policy.maxOrderUsd.toFixed(2)}).`,
      );
    }

    this.ledger.assertWithinDailyCap(priced.notionalUsd);
  }

  /**
   * Place an order, subject to policy.
   *
   * @param confirm - In `guarded` mode an order is only sent when this is true;
   *   otherwise a priced preview comes back and nothing is placed. Ignored in
   *   `autonomous` mode, where orders always send.
   */
  async submitOrder(request: OrderRequest, confirm = false): Promise<SubmitResult> {
    this.assertNotHalted();

    const priced = await this.price(request);
    this.assertAllowed(priced);

    const shouldExecute = this.policy.mode === 'autonomous' || confirm;
    if (!shouldExecute) {
      return { placed: false, preview: priced, notionalUsd: priced.notionalUsd };
    }

    const order = await this.client.post(this.endpoints.orders, {
      body: priced.body,
      query: requiresAccountNumber(this.credentials.apiVersion)
        ? { account_number: await this.accountNumber() }
        : {},
      // Never retry a write: retrying an ambiguous failure can double-fill.
      maxRetries: 0,
    });

    if (priced.notionalUsd !== null) this.ledger.record(priced.notionalUsd);

    return { placed: true, order, notionalUsd: priced.notionalUsd };
  }

  async cancelOrder(orderId: string): Promise<unknown> {
    return this.client.post(this.endpoints.cancelOrder(orderId), { maxRetries: 0 });
  }

  async getOrder(orderId: string): Promise<unknown> {
    return this.client.get(this.endpoints.order(orderId), {
      query: requiresAccountNumber(this.credentials.apiVersion)
        ? { account_number: await this.accountNumber() }
        : {},
    });
  }

  async holdings(assetCodes?: string[]): Promise<Array<Record<string, unknown>>> {
    const { results } = await this.client.getAllPages<Record<string, unknown>>(
      this.endpoints.holdings,
      {
        query: {
          ...(assetCodes?.length ? { asset_code: assetCodes } : {}),
          ...(requiresAccountNumber(this.credentials.apiVersion)
            ? { account_number: await this.accountNumber() }
            : {}),
        },
      },
    );
    return results;
  }

  async orders(filters: Record<string, string | number | undefined> = {}): Promise<
    Array<Record<string, unknown>>
  > {
    const { results } = await this.client.getAllPages<Record<string, unknown>>(
      this.endpoints.orders,
      {
        query: {
          ...filters,
          ...(requiresAccountNumber(this.credentials.apiVersion)
            ? { account_number: await this.accountNumber() }
            : {}),
        },
      },
    );
    return results;
  }

  /**
   * Look up one order by its `client_order_id`, conclusively.
   *
   * Reconciliation turns this answer into a decision about real money, so
   * "I did not see it" and "it does not exist" must not collapse into the same
   * result. A truncated page walk returns `inconclusive`, never `not_found`:
   * treating an unfinished search as a negative would abandon an intent whose
   * order actually exists, and the strategy would then re-place it under a new
   * `client_order_id` and double-fill.
   *
   * The search is bounded by the intent's own creation time, which is what
   * makes it terminate conclusively — Robinhood has no `client_order_id`
   * filter, so an unbounded walk is the entire order history.
   */
  async findOrderByClientOrderId(
    clientOrderId: string,
    createdAtMs: number,
  ): Promise<OrderLookup> {
    // Widen the window backwards: the intent row is written before the request
    // is signed, and Robinhood stamps `created_at` on its own clock.
    const since = new Date(createdAtMs - RECONCILE_CLOCK_SKEW_MS).toISOString();

    const { results, truncated } = await this.client.getAllPages<Record<string, unknown>>(
      this.endpoints.orders,
      {
        query: {
          created_at_start: since,
          ...(requiresAccountNumber(this.credentials.apiVersion)
            ? { account_number: await this.accountNumber() }
            : {}),
        },
      },
      RECONCILE_MAX_PAGES,
    );

    const match = results.find((order) => order.client_order_id === clientOrderId);
    if (match) return { status: 'found', order: match };

    if (truncated) {
      return {
        status: 'inconclusive',
        reason:
          `Order history since ${since} exceeded ${RECONCILE_MAX_PAGES} pages without finding ` +
          `client_order_id ${clientOrderId}. Treating this as unresolved rather than absent.`,
      };
    }

    return { status: 'not_found' };
  }

  async tradingPair(symbol: string): Promise<Record<string, unknown> | null> {
    const { results } = await this.client.getAllPages<Record<string, unknown>>(
      this.endpoints.tradingPairs,
      { query: { symbol: [symbol.toUpperCase()] } },
      2,
    );
    return results[0] ?? null;
  }
}

/** Build the wire body, including the `*_order_config` matching the type. */
export function buildOrderBody(request: OrderRequest): Record<string, unknown> {
  const { type, assetQuantity, quoteAmount, limitPrice, stopPrice, timeInForce } = request;
  const size = assetQuantity !== undefined ? { asset_quantity: assetQuantity } : { quote_amount: quoteAmount };

  let config: Record<string, unknown>;
  switch (type) {
    case 'market':
      config = { market_order_config: { asset_quantity: assetQuantity } };
      break;
    case 'limit':
      config = { limit_order_config: { ...size, limit_price: limitPrice, time_in_force: timeInForce ?? 'gtc' } };
      break;
    case 'stop_loss':
      config = { stop_loss_order_config: { ...size, stop_price: stopPrice, time_in_force: timeInForce ?? 'gtc' } };
      break;
    case 'stop_limit':
      config = {
        stop_limit_order_config: {
          ...size,
          limit_price: limitPrice,
          stop_price: stopPrice,
          time_in_force: timeInForce ?? 'gtc',
        },
      };
      break;
  }

  return {
    client_order_id: request.clientOrderId ?? randomUUID(),
    symbol: request.symbol,
    side: request.side,
    type,
    ...config,
  };
}

/**
 * Round a quantity down to a trading pair's increment.
 *
 * Rounds DOWN so a computed size never exceeds what the caller intended, and
 * uses string math to avoid float drift on small-increment assets.
 */
export function roundToIncrement(quantity: number, increment: string | number | undefined): string {
  const inc = Number(increment);
  if (!Number.isFinite(inc) || inc <= 0) return String(quantity);

  const decimals = decimalPlaces(inc);
  const steps = Math.floor(quantity / inc);
  return (steps * inc).toFixed(decimals);
}

function decimalPlaces(value: number): number {
  const text = String(value);
  if (text.includes('e-')) return Number(text.split('e-')[1]);
  return text.includes('.') ? (text.split('.')[1]?.length ?? 0) : 0;
}
