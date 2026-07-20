/**
 * Rebalance: drive a portfolio back to a set of target weights.
 *
 * A portfolio drifts because the winners grow, which means the largest position
 * is the most expensive one exactly when it is largest. Rebalancing sells some
 * of what ran and buys what did not, and it is the only mechanical way to take
 * profit on a rule instead of on a feeling. Robinhood has no portfolio-level
 * order, so the package synthesizes one out of per-symbol legs.
 *
 * This is the most dangerous strategy here, because one bad number moves every
 * position at once. Three decisions follow from that.
 *
 * **The plan is computed once, at init, and never recomputed.** A rebalancer
 * that re-measures its own drift after every fill chases its own slippage and
 * trades forever. The plan is a fixed list of legs, each executed at most once,
 * so the job provably terminates: in the worst case every leg burns
 * `MAX_LEG_ATTEMPTS` advances and is then abandoned. Running it again is a new
 * job, with a new decision behind it.
 *
 * **Sells go out before buys, and never in the same tick.** The proceeds of the
 * sells are what fund the buys, and an unsettled sale is not buying power.
 *
 * **Anything that cannot be priced is not traded.** A leg with no quote is
 * retried, then skipped with the reason recorded, and never sized from a guess.
 * A portfolio that cannot be valued in full is rejected outright at init rather
 * than rebalanced against a total that is missing one of its parts.
 */

import type { Job, Strategy, StrategyAction, StrategyContext, StrategyStep } from '../job.js';
import { roundToIncrement } from '../../shared/executor.js';
import { requireInt } from './params.js';

/**
 * A rebalance job is portfolio-wide, so it has no one symbol.
 *
 * The jobs table wants one anyway, for listing and filtering, so this sentinel
 * fills it. It is never sent to Robinhood: every leg carries its own pair.
 */
const PORTFOLIO_SYMBOL = 'PORTFOLIO';

/** How far the supplied weights may miss 1.0 in total before they are a typo. */
const WEIGHT_SUM_TOLERANCE = 0.001;

/** Most symbols one job manages, bounding the work a single plan can create. */
const MAX_TARGETS = 20;

/**
 * Attempts a leg gets before it is abandoned.
 *
 * A missing quote is usually a blip, so one outage should not silently drop a
 * leg out of the rebalance. An unbounded retry is a job that never ends, which
 * is the failure this whole strategy is written around.
 */
const MAX_LEG_ATTEMPTS = 3;

type LegStatus = 'pending' | 'submitted' | 'skipped' | 'within_tolerance';

interface RebalanceLeg {
  symbol: string;
  /** Share of the portfolio this symbol should hold, as a fraction of 1. */
  weight: number;
  /** Quantity held when the plan was built, in the base asset. */
  heldQuantity: string;
  /** Mark price the holding was valued at when the plan was built. */
  markPrice: string;
  /** Direction of the correction. Null when the leg was already on target. */
  side: 'buy' | 'sell' | null;
  /** Absolute distance from target, in the quote currency, at plan time. */
  deltaUsd: string;
  status: LegStatus;
  /** Advances this leg has consumed, which is what bounds the retry. */
  attempts: number;
  reason: string | null;
  /** Size actually sent, once the leg executes. */
  executedQuantity: string | null;
  /** Venue constraints captured at init so sizing stays legal without a lookup. */
  assetIncrement: string | null;
  minOrderSize: number;
}

interface RebalanceState {
  toleranceBps: number;
  maxLegsPerTick: number;
  dryRun: boolean;
  /** Total value of the target universe when the plan was built. */
  portfolioUsd: string;
  legs: RebalanceLeg[];
  /** Symbols submitted on the previous advance, so a rejection can be attributed. */
  lastBatch: string[];
  /** Held assets outside the targets, recorded so the caller sees what was excluded. */
  ignoredAssets: string[];
}

export const rebalance: Strategy = {
  name: 'rebalance',
  description:
    'Drive a portfolio back to target weights: value every target holding once, trade only the legs that have drifted past a tolerance, and sell before buying so the proceeds fund the buys.',
  defaultIntervalMs: 30_000,

  async init(params, ctx): Promise<{ state: Record<string, unknown>; symbol: string }> {
    const targets = parseTargets(params.targets);
    const toleranceBps = requireInt(params, 'tolerance_bps', { min: 1, max: 5_000 });
    const maxLegsPerTick = requireInt(params, 'max_legs_per_tick', { min: 1, max: 10 });
    const dryRun = parseDryRun(params.dry_run);

    // Holdings are read once and frozen into the plan. Re-reading them per leg
    // would size later legs against balances that earlier legs already moved,
    // which double-counts every correction.
    const holdings = await ctx.executor.holdings();
    const heldByAsset = new Map<string, number>();
    for (const holding of holdings) {
      const asset = String(holding.asset_code ?? '').toUpperCase();
      const quantity = Number(
        holding.total_quantity ?? holding.quantity ?? holding.quantity_available_for_trading ?? 0,
      );
      if (!asset || !Number.isFinite(quantity) || quantity <= 0) continue;
      heldByAsset.set(asset, quantity);
    }

    interface PricedTarget {
      symbol: string;
      weight: number;
      quantity: number;
      price: number;
      valueUsd: number;
      assetIncrement: string | null;
      minOrderSize: number;
    }

    const priced: PricedTarget[] = [];
    for (const [symbol, weight] of targets) {
      const pair = await ctx.executor.tradingPair(symbol);
      if (!pair) {
        throw new Error(
          `targets names "${symbol}", which is not a tradable pair on Robinhood Crypto. Use a symbol ` +
            'from get_trading_pairs, e.g. "BTC-USD", or remove it and redistribute its weight.',
        );
      }

      // Valued at the bid, which is what the holding could actually be realized
      // for. Marking at the ask would inflate the portfolio total and make every
      // buy leg slightly too large.
      const price = await ctx.price(symbol, 'sell');
      if (price === null || !Number.isFinite(price) || price <= 0) {
        // Fail closed, and fail whole: the portfolio total is a sum over every
        // target, so one missing price mis-sizes every other leg too. There is
        // no partial plan worth building here.
        throw new Error(
          `No usable price for ${symbol}, so the portfolio total cannot be computed and every leg ` +
            'would be sized against an incomplete total. Retry when the venue is quoting it, or ' +
            'remove it from targets and redistribute its weight.',
        );
      }

      const quantity = heldByAsset.get(baseAsset(symbol)) ?? 0;
      priced.push({
        symbol,
        weight,
        quantity,
        price,
        valueUsd: quantity * price,
        assetIncrement: pair.asset_increment ? String(pair.asset_increment) : null,
        minOrderSize: Number(pair.min_order_size ?? pair.min_order_amount ?? 0),
      });
    }

    const portfolioUsd = priced.reduce((total, row) => total + row.valueUsd, 0);
    if (!Number.isFinite(portfolioUsd) || portfolioUsd <= 0) {
      throw new Error(
        'The symbols in targets are worth 0 in this account, so there are no weights to correct and ' +
          'nothing to fund a buy with. Open an initial position first, or include a symbol you already hold.',
      );
    }

    // The tolerance is measured against the whole portfolio, not against each
    // leg's own target, so a 25 bps band means the same dollar amount for the
    // 60% leg and the 5% leg.
    const toleranceUsd = (portfolioUsd * toleranceBps) / 10_000;

    const legs: RebalanceLeg[] = priced.map((row) => {
      const deltaUsd = portfolioUsd * row.weight - row.valueUsd;
      const withinTolerance = Math.abs(deltaUsd) <= toleranceUsd;
      return {
        symbol: row.symbol,
        weight: row.weight,
        heldQuantity: String(row.quantity),
        markPrice: String(row.price),
        side: withinTolerance ? null : deltaUsd > 0 ? 'buy' : 'sell',
        deltaUsd: String(Math.abs(deltaUsd)),
        status: withinTolerance ? 'within_tolerance' : 'pending',
        attempts: 0,
        reason: withinTolerance
          ? `Drift of $${Math.abs(deltaUsd).toFixed(2)} is inside the ${toleranceBps} bps band.`
          : null,
        executedQuantity: null,
        assetIncrement: row.assetIncrement,
        minOrderSize: row.minOrderSize,
      };
    });

    // Assets held outside the targets are left alone. The weights describe the
    // universe being managed, and selling something the caller never named would
    // be the strategy inventing a trade.
    const targetAssets = new Set(targets.map(([symbol]) => baseAsset(symbol)));
    const ignoredAssets = [...heldByAsset.keys()].filter((asset) => !targetAssets.has(asset)).sort();

    const state: RebalanceState = {
      toleranceBps,
      maxLegsPerTick,
      dryRun,
      portfolioUsd: String(portfolioUsd),
      legs,
      lastBatch: [],
      ignoredAssets,
    };

    return { state: state as unknown as Record<string, unknown>, symbol: PORTFOLIO_SYMBOL };
  },

  async advance(job: Job, ctx: StrategyContext): Promise<StrategyStep> {
    const state = job.state as unknown as RebalanceState;

    // A rejected submit from the previous batch stops the whole rebalance. The
    // error names one order and the batch may have carried several, so which leg
    // failed is unknowable here, and continuing would buy against sale proceeds
    // that may never have existed.
    if (state.lastBatch.length > 0 && job.lastError !== null) {
      return {
        state: { ...state, lastBatch: [] } as unknown as Record<string, unknown>,
        actions: [
          {
            type: 'log',
            kind: 'rebalance_leg_rejected',
            detail: { batch: state.lastBatch, error: job.lastError },
          },
        ],
        done: {
          status: 'failed',
          reason:
            `A leg in batch [${state.lastBatch.join(', ')}] was rejected: ${job.lastError}. Stopping with ` +
            'the rebalance part-executed. Review holdings, then start a new rebalance from where the ' +
            'portfolio actually is rather than from the original plan.',
        },
      };
    }

    const pending = state.legs.filter((leg) => leg.status === 'pending' && leg.side !== null);
    if (pending.length === 0) return finish(state);

    // Sells first, and never alongside a buy in the same tick.
    const sells = pending.filter((leg) => leg.side === 'sell');
    const batch = (sells.length > 0 ? sells : pending).slice(0, state.maxLegsPerTick);

    const actions: StrategyAction[] = [];
    const submitted: string[] = [];
    const updated = new Map<string, RebalanceLeg>();

    for (const leg of batch) {
      const side = leg.side as 'buy' | 'sell';

      // Sized at the price of the tick it executes on, not the mark from plan
      // time. The USD correction is what the caller approved; converting it to a
      // quantity at a stale price sends the wrong size.
      const price = await ctx.price(leg.symbol, side);
      if (price === null || !Number.isFinite(price) || price <= 0) {
        const attempts = leg.attempts + 1;
        const abandoned = attempts >= MAX_LEG_ATTEMPTS;
        updated.set(leg.symbol, {
          ...leg,
          attempts,
          status: abandoned ? 'skipped' : leg.status,
          reason: abandoned
            ? `No usable price after ${attempts} attempts, so no size could be computed for this leg.`
            : leg.reason,
        });
        actions.push({
          type: 'log',
          kind: 'rebalance_leg_unpriced',
          detail: { symbol: leg.symbol, attempts, abandoned },
        });
        continue;
      }

      // A sell can never exceed what the plan saw in the account, whatever the
      // drift says.
      const rawQuantity =
        side === 'sell'
          ? Math.min(Number(leg.deltaUsd) / price, Number(leg.heldQuantity))
          : Number(leg.deltaUsd) / price;
      const quantity = roundToIncrement(rawQuantity, leg.assetIncrement ?? undefined);
      const sized = Number(quantity);

      if (!Number.isFinite(sized) || sized <= 0 || (leg.minOrderSize > 0 && sized < leg.minOrderSize)) {
        // Below the venue minimum is a real outcome, not an error: a small drift
        // on a small account is often untradeable. Say so rather than sending an
        // order that exists only to be rejected.
        updated.set(leg.symbol, {
          ...leg,
          attempts: leg.attempts + 1,
          status: 'skipped',
          reason:
            `A $${Number(leg.deltaUsd).toFixed(2)} correction is ${quantity} ${baseAsset(leg.symbol)} at ` +
            `${price}, below the venue minimum of ${leg.minOrderSize}. Left untraded.`,
        });
        actions.push({
          type: 'log',
          kind: 'rebalance_leg_below_minimum',
          detail: { symbol: leg.symbol, side, quantity, minOrderSize: leg.minOrderSize },
        });
        continue;
      }

      if (state.dryRun) {
        updated.set(leg.symbol, {
          ...leg,
          attempts: leg.attempts + 1,
          status: 'skipped',
          executedQuantity: quantity,
          reason: 'dry_run: the leg was sized but never sent.',
        });
        actions.push({
          type: 'log',
          kind: 'rebalance_dry_run_leg',
          detail: { symbol: leg.symbol, side, quantity, price, deltaUsd: leg.deltaUsd },
        });
        continue;
      }

      updated.set(leg.symbol, {
        ...leg,
        attempts: leg.attempts + 1,
        status: 'submitted',
        executedQuantity: quantity,
        reason: null,
      });
      submitted.push(leg.symbol);
      actions.push({
        type: 'log',
        kind: 'rebalance_leg_submitted',
        detail: { symbol: leg.symbol, side, quantity, price, deltaUsd: leg.deltaUsd },
      });
      actions.push({
        type: 'submit',
        order: { symbol: leg.symbol, side, type: 'market', assetQuantity: quantity },
      });
    }

    const next: RebalanceState = {
      ...state,
      legs: state.legs.map((leg) => updated.get(leg.symbol) ?? leg),
      lastBatch: submitted,
    };

    // Every advance either completes or moves at least one leg forward, since an
    // unpriced leg still burns an attempt. That is what bounds the job.
    const stillPending = next.legs.some((leg) => leg.status === 'pending' && leg.side !== null);
    if (stillPending) return { state: next as unknown as Record<string, unknown>, actions };

    const end = finish(next);
    return { state: end.state, actions: [...actions, ...end.actions], done: end.done };
  },
};

/** Summarize what the plan did, and end the job. */
function finish(state: RebalanceState): StrategyStep {
  const traded = state.legs.filter((leg) => leg.status === 'submitted');
  const skipped = state.legs.filter((leg) => leg.status === 'skipped');
  const onTarget = state.legs.filter((leg) => leg.status === 'within_tolerance');

  const reason = state.dryRun
    ? `Dry run: ${skipped.length} leg(s) sized, nothing sent. Re-run without dry_run to execute.`
    : skipped.length > 0
      ? `Traded ${traded.length} leg(s); skipped ${skipped.length}: ` +
        skipped.map((leg) => `${leg.symbol} (${leg.reason ?? 'no reason recorded'})`).join('; ')
      : `Traded ${traded.length} leg(s); ${onTarget.length} already inside the ${state.toleranceBps} bps band.`;

  return {
    state: { ...state, lastBatch: [] } as unknown as Record<string, unknown>,
    actions: [
      {
        type: 'log',
        kind: 'rebalance_complete',
        detail: {
          dryRun: state.dryRun,
          portfolioUsd: state.portfolioUsd,
          traded: traded.map((leg) => ({ symbol: leg.symbol, side: leg.side, quantity: leg.executedQuantity })),
          skipped: skipped.map((leg) => ({ symbol: leg.symbol, reason: leg.reason })),
          withinTolerance: onTarget.map((leg) => leg.symbol),
          ignoredAssets: state.ignoredAssets,
        },
      },
    ],
    done: { status: 'completed', reason },
  };
}

/**
 * Validate the weight map.
 *
 * Weights that do not sum to 1 are not a rounding problem: they mean the caller
 * described a different portfolio than the one they think they did, and every
 * leg would then be sized against a total that does not exist.
 */
function parseTargets(raw: unknown): Array<[string, number]> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(
      '"targets" must be an object mapping trading pair symbols to weights, e.g. ' +
        '{"BTC-USD": 0.6, "ETH-USD": 0.4}.',
    );
  }

  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error('"targets" is empty. Name at least one trading pair symbol and its target weight.');
  }
  if (entries.length > MAX_TARGETS) {
    throw new Error(
      `"targets" holds ${entries.length} symbols, more than the ${MAX_TARGETS} one job manages. ` +
        'Split the portfolio across separate rebalance jobs.',
    );
  }

  const parsed: Array<[string, number]> = [];
  const seen = new Set<string>();
  let sum = 0;

  for (const [key, value] of entries) {
    const symbol = key.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,10}-[A-Z]{2,5}$/.test(symbol)) {
      throw new Error(
        `"targets" key "${key}" is not a trading pair symbol. Use the pair, not the asset code: ` +
          '"BTC-USD" rather than "BTC".',
      );
    }
    if (seen.has(symbol)) {
      throw new Error(`"targets" names ${symbol} twice. Give each symbol exactly one weight.`);
    }
    seen.add(symbol);

    const weight = Number(value);
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
      throw new Error(
        `"targets" weight for ${symbol} must be a number between 0 and 1, a fraction of the portfolio ` +
          `rather than a percentage. Got ${String(value)}; for 60% pass 0.6.`,
      );
    }

    sum += weight;
    parsed.push([symbol, weight]);
  }

  if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
    throw new Error(
      `"targets" weights sum to ${sum.toFixed(4)}, not 1.0. Scale them so they add up to 1: as written, ` +
        (sum > 1
          ? 'the plan would try to hold more than the portfolio is worth.'
          : 'part of the portfolio has no target and would be left unmanaged.'),
    );
  }

  return parsed;
}

function parseDryRun(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== 'boolean') {
    throw new Error(
      '"dry_run" must be a boolean. Omit it to execute, or pass true to size every leg and log it ' +
        'without sending an order.',
    );
  }
  return raw;
}

/** `BTC-USD` holds `BTC`, which is the code holdings are keyed by. */
function baseAsset(symbol: string): string {
  return String(symbol.split('-')[0] ?? symbol).toUpperCase();
}
