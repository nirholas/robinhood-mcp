/**
 * Risk controls: the tools that tell an agent what it is exposed to, what the
 * gate will let it do, and the one tool that stops everything.
 *
 * Two of these are unlike the rest of the toolkit.
 *
 * `risk_check_order` is a dry run of the real gate. It calls the same
 * `Executor.price` and `Executor.assertAllowed` that a live order goes through,
 * so its verdict cannot drift from what would actually happen. It reports the
 * rejection structurally instead of throwing, which is what makes it usable as
 * a planning step: an agent can test a whole plan order by order before
 * committing to any of it.
 *
 * The kill switch is enforced, not advisory. Its state lives in the same SQLite
 * database as the jobs, so it survives a restart, and it is re-read on every
 * submit rather than cached, so a switch thrown in one process (an operator at
 * an MCP client) halts another (the daemon supervisor mid-TWAP). Engaging it
 * both blocks new orders at the executor and pauses running jobs, because
 * either alone leaves a way to keep spending.
 *
 * @see docs/architecture.md - "shared/executor.ts - the choke point"
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  roundToIncrement,
  type Executor,
  type OrderRequest,
  type SubmitResult,
} from '../shared/executor.js';
import { PolicyError } from '../shared/execution-mode.js';
import { toolResult, toolError } from '../shared/format.js';
import type { JobStore } from '../engine/store.js';
import { KillSwitch, RELEASED, type KillSwitchState } from '../shared/kill-switch.js';
import { isTerminal } from '../engine/job.js';
import { fillsFromOrders, type Fill } from '../analytics/cost-basis.js';
import { sizeByRisk } from '../analytics/sizing.js';

const symbolSchema = z
  .string()
  .regex(/^[A-Za-z0-9]+-[A-Za-z0-9]+$/, 'Symbol must be a trading pair like BTC-USD.')
  .transform((s) => s.toUpperCase())
  .describe('Trading pair, e.g. BTC-USD.');

const decimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'Must be a positive decimal string, e.g. "0.001".');

/** One holding, valued live. */
interface PricedPosition {
  asset: string;
  quantity: number;
  priceUsd: number | null;
  valueUsd: number | null;
}

interface ExposureSnapshot {
  positions: PricedPosition[];
  /** Assets held but not quotable. Their value is unknown, never zero. */
  unpriceable: string[];
  /** Sum over the positions that could be priced. */
  totalPricedUsd: number;
  complete: boolean;
}

const INCOMPLETE_WARNING =
  'At least one held asset could not be quoted, so the total below is a lower bound and every ' +
  'share percentage is measured against the priced subset only. Treat concentration and sizing ' +
  'derived from it as unverified.';

export function registerRiskTools(server: McpServer, executor: Executor, store: JobStore): void {
  const killSwitch = new KillSwitch(store.database);

  const policy = executor.executionPolicy;
  const ledger = executor.spendLedger;

  /**
   * Value every holding at the live bid, which is what the position is worth to
   * someone who wants out. An asset that cannot be quoted is reported as
   * unpriceable rather than folded in at zero, because a zero would understate
   * exposure precisely when it matters.
   */
  async function exposure(): Promise<ExposureSnapshot> {
    const holdings = await executor.holdings();

    const positions: PricedPosition[] = [];
    const unpriceable: string[] = [];

    for (const holding of holdings) {
      const asset = String(holding.asset_code ?? '').toUpperCase();
      const quantity = Number(holding.total_quantity ?? holding.quantity ?? 0);
      if (!asset || !Number.isFinite(quantity) || quantity <= 0) continue;

      // USD is not a quote lookup, it is the unit of account. This is a
      // definition, not an assumption about a price.
      const priceUsd = asset === 'USD' ? 1 : await executor.referencePrice(`${asset}-USD`, 'sell');

      if (priceUsd === null) unpriceable.push(asset);

      positions.push({
        asset,
        quantity,
        priceUsd,
        valueUsd: priceUsd === null ? null : quantity * priceUsd,
      });
    }

    const totalPricedUsd = positions.reduce((total, p) => total + (p.valueUsd ?? 0), 0);

    return {
      positions: positions.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0)),
      unpriceable,
      totalPricedUsd,
      complete: unpriceable.length === 0,
    };
  }

  /** Current limits, attached to a refusal so the caller sees the whole gate. */
  const limitsSnapshot = () => ({
    max_order_usd: policy.maxOrderUsd,
    max_daily_usd: policy.maxDailyUsd,
    symbol_allowlist: policy.symbolAllowlist,
    buy_only: policy.buyOnly,
    session_committed_usd: ledger.spentUsd,
    session_remaining_usd: ledger.remainingUsd,
  });

  /** Serialize a snapshot with each position's share of the priced total. */
  function renderPositions(snapshot: ExposureSnapshot) {
    return snapshot.positions.map((p) => ({
      asset: p.asset,
      quantity: p.quantity,
      price_usd: p.priceUsd,
      value_usd: p.valueUsd,
      share_percent:
        p.valueUsd === null || snapshot.totalPricedUsd <= 0
          ? null
          : (p.valueUsd / snapshot.totalPricedUsd) * 100,
    }));
  }

  server.registerTool(
    'risk_status',
    {
      title: 'Risk status',
      description:
        'The complete picture of what this server will and will not do right now: execution mode, ' +
        'every configured limit, how much of the session spend allowance is already committed, ' +
        'whether the kill switch is engaged, and how many algo jobs are live. Call this first when ' +
        'an order was refused and the reason is not obvious, and before starting anything unattended.',
      inputSchema: {},
    },
    async () => {
      try {
        const state = killSwitch.read();
        const jobs = store.listJobs();
        const byStatus = (status: string) => jobs.filter((job) => job.status === status).length;

        return toolResult({
          kill_switch: {
            engaged: state.engaged,
            reason: state.reason,
            engaged_at: state.engagedAt ? new Date(state.engagedAt).toISOString() : null,
            released_at: state.releasedAt ? new Date(state.releasedAt).toISOString() : null,
            paused_job_count: state.pausedJobIds.length,
            effect: state.engaged
              ? 'Every order is refused at the executor. No tool and no running strategy can place one.'
              : 'Orders are subject to the limits below only.',
          },
          policy: {
            mode: policy.mode,
            mode_effect:
              policy.mode === 'autonomous'
                ? 'Orders send immediately. confirm is ignored.'
                : 'Orders return a priced preview unless the call carries confirm=true.',
            max_order_usd: policy.maxOrderUsd,
            max_daily_usd: policy.maxDailyUsd,
            symbol_allowlist: policy.symbolAllowlist,
            buy_only: policy.buyOnly,
          },
          session_spend: {
            committed_usd: ledger.spentUsd,
            remaining_usd: ledger.remainingUsd,
            note:
              'This counter is per-process and resets on restart. It is a runaway-loop brake, ' +
              'not an accounting system.',
          },
          jobs: {
            running: byStatus('running'),
            pending: byStatus('pending'),
            paused: byStatus('paused'),
            total_non_terminal: jobs.filter((job) => !isTerminal(job.status)).length,
          },
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'risk_exposure',
    {
      title: 'Get USD exposure',
      description:
        'Total and per-symbol USD exposure from the real account holdings, each valued at the live ' +
        'bid, with every position\'s share of the portfolio. This is what you are actually carrying ' +
        'right now, as opposed to what you paid for it. An asset that cannot be quoted is listed as ' +
        'unpriceable rather than counted as zero, and the result says so.',
      inputSchema: {},
    },
    async () => {
      try {
        const snapshot = await exposure();

        if (!snapshot.positions.length) {
          return toolResult({
            positions: [],
            total_exposure_usd: 0,
            complete: true,
            message: 'No holdings in this account, so there is no exposure to report.',
          });
        }

        return toolResult({
          total_exposure_usd: snapshot.totalPricedUsd,
          priced_positions: snapshot.positions.filter((p) => p.valueUsd !== null).length,
          positions: renderPositions(snapshot),
          complete: snapshot.complete,
          ...(snapshot.complete
            ? {}
            : { unpriceable_assets: snapshot.unpriceable, warning: INCOMPLETE_WARNING }),
          valuation: 'Live best bid inclusive of the sell spread, i.e. exit value, not mid.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'risk_concentration',
    {
      title: 'Check position concentration',
      description:
        'Flag every position worth more than a chosen percentage of the portfolio. Use it to answer ' +
        '"is any single asset too large a share of what I hold" before adding to a winner. By ' +
        'default this refuses to answer when some holding cannot be priced, because an unknown ' +
        'denominator makes every percentage wrong in the direction that hides a breach.',
      inputSchema: {
        threshold_percent: z
          .number()
          .positive()
          .max(100)
          .optional()
          .default(25)
          .describe('Share of the portfolio above which a position is flagged.'),
        allow_incomplete: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'Answer even when some asset cannot be priced, measuring shares against the priced subset only.',
          ),
      },
    },
    async ({ threshold_percent, allow_incomplete }) => {
      try {
        const snapshot = await exposure();

        if (!snapshot.positions.length) {
          return toolResult({
            threshold_percent,
            breaches: [],
            message: 'No holdings in this account, so nothing can be concentrated.',
          });
        }

        if (!snapshot.complete && !allow_incomplete) {
          throw new Error(
            `Cannot measure concentration: ${snapshot.unpriceable.join(', ')} could not be quoted, ` +
              'so the portfolio total is unknown and every share percentage would be overstated ' +
              'against too small a denominator. Retry when the quote is available, or pass ' +
              'allow_incomplete=true to accept a result measured against the priced subset only.',
          );
        }

        if (snapshot.totalPricedUsd <= 0) {
          throw new Error(
            'The priced portfolio total is zero, so no share can be computed. Check risk_exposure.',
          );
        }

        const rows = renderPositions(snapshot).filter((row) => row.share_percent !== null);
        const breaches = rows.filter((row) => (row.share_percent ?? 0) > threshold_percent);

        return toolResult({
          threshold_percent,
          total_exposure_usd: snapshot.totalPricedUsd,
          breaches,
          largest_position: rows[0] ?? null,
          within_threshold: rows.filter((row) => (row.share_percent ?? 0) <= threshold_percent),
          verdict: breaches.length
            ? `${breaches.length} position(s) exceed ${threshold_percent}% of the portfolio.`
            : `No position exceeds ${threshold_percent}% of the portfolio.`,
          complete: snapshot.complete,
          ...(snapshot.complete
            ? {}
            : { unpriceable_assets: snapshot.unpriceable, warning: INCOMPLETE_WARNING }),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'risk_drawdown',
    {
      title: 'Get peak-to-trough drawdown',
      description:
        'Largest peak-to-trough decline in total P&L (realized plus unrealized), rebuilt from filled ' +
        'order history and marked to the live price at the end. ' +
        'What it CANNOT see, and this matters: Robinhood exposes no deposit or withdrawal record ' +
        'here, so this is a P&L curve, not an account-balance curve, and a withdrawal will never ' +
        'appear as a decline. It is sampled only at the moments you traded, so a crash between two ' +
        'fills is invisible. It reaches back only as far as the order history the API returns, and ' +
        'a sell with no matching buy in that window is excluded rather than guessed at. Assets ' +
        'quoted in something other than USD are treated as USD.',
      inputSchema: {
        symbol: symbolSchema
          .optional()
          .describe('Limit the reconstruction to one trading pair. Omit for the whole account.'),
      },
    },
    async ({ symbol }) => {
      try {
        const orders = await executor.orders({ state: 'filled', ...(symbol ? { symbol } : {}) });
        const fills = fillsFromOrders(orders);

        if (fills.length < 2) {
          return toolResult({
            message:
              'Fewer than two fills in the available history. A drawdown needs a curve, and one ' +
              'point is not one.',
            fills: fills.length,
          });
        }

        const curve = buildPnlCurve(fills);

        // Mark the open lots to the live price so the final point is today, not
        // the last time this account happened to trade.
        const openAssets = [...curve.openLots.keys()];
        const livePrices = new Map<string, number>();
        const unpriceable: string[] = [];
        for (const asset of openAssets) {
          const price = asset === 'USD' ? 1 : await executor.referencePrice(`${asset}-USD`, 'sell');
          if (price === null) unpriceable.push(asset);
          else livePrices.set(asset, price);
        }

        // Fail closed on the final mark: a live point built from a partial set
        // of prices would understate open risk and could invent a fake trough.
        const markable = unpriceable.length === 0;
        if (markable) {
          curve.points.push({
            at: Date.now(),
            pnlUsd: curve.realized + unrealized(curve.openLots, livePrices),
            source: 'live mark',
          });
        }

        const values = curve.points.map((p) => p.pnlUsd);
        const worst = peakToTrough(values);

        const peakPoint = curve.points[worst.peakIndex];
        const troughPoint = curve.points[worst.troughIndex];
        const last = curve.points[curve.points.length - 1];

        return toolResult({
          max_drawdown_usd: worst.declineUsd,
          // A percentage only means something when the peak was a gain. From a
          // peak at or below zero the denominator is not a capital base, so it
          // is reported as null instead of a number that reads as precise.
          max_drawdown_percent_of_peak:
            worst.peakValue > 0 ? (worst.declineUsd / worst.peakValue) * 100 : null,
          peak: peakPoint
            ? { pnl_usd: peakPoint.pnlUsd, at: new Date(peakPoint.at).toISOString() }
            : null,
          trough: troughPoint
            ? { pnl_usd: troughPoint.pnlUsd, at: new Date(troughPoint.at).toISOString() }
            : null,
          current_pnl_usd: last?.pnlUsd ?? null,
          realized_pnl_usd: curve.realized,
          samples: curve.points.length,
          marked_to_live_price: markable,
          ...(markable
            ? {}
            : {
                unpriceable_assets: unpriceable,
                warning:
                  'Open positions in these assets could not be quoted, so the curve ends at the ' +
                  'last fill instead of today. Any decline since then is not counted.',
              }),
          ...(curve.unmatchedSells
            ? {
                unmatched_sells: curve.unmatchedSells,
                warning_history:
                  'Some sells had no matching buy in the available history, so their proceeds are ' +
                  'excluded from realized P&L rather than credited against a zero cost basis.',
              }
            : {}),
          method:
            'FIFO lots over filled orders. Curve value at each fill is cumulative realized P&L plus ' +
            'unrealized P&L on open lots marked at the most recent traded price.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'risk_check_order',
    {
      title: 'Dry-run an order against every control',
      description:
        'Test a proposed order against every policy control WITHOUT placing it, and get back a plain ' +
        'allowed true or false plus exactly which control would reject it and why. Nothing is sent, ' +
        'no spend is committed, and no confirmation is implied. ' +
        'This is the pre-trade gate: call it for each leg before committing to a plan, so a ' +
        'multi-order plan fails on paper instead of halfway through with real money spent. It runs ' +
        'the same pricing and the same assertions a live order runs, so its verdict cannot drift ' +
        'from the real gate.',
      inputSchema: {
        symbol: symbolSchema,
        side: z.enum(['buy', 'sell']),
        type: z
          .enum(['market', 'limit', 'stop_loss', 'stop_limit'])
          .describe('The order type you intend to place.'),
        asset_quantity: decimal
          .optional()
          .describe('Size in the base asset. Mutually exclusive with quote_amount.'),
        quote_amount: decimal
          .optional()
          .describe('Size in the quote currency. Mutually exclusive with asset_quantity.'),
        limit_price: decimal.optional().describe('Required for limit and stop_limit.'),
        stop_price: decimal.optional().describe('Required for stop_loss and stop_limit.'),
        time_in_force: z.enum(['gtc', 'day']).optional().default('gtc'),
      },
    },
    async (args) => {
      try {
        if (args.asset_quantity && args.quote_amount) {
          throw new Error('Specify only one of asset_quantity or quote_amount, not both.');
        }
        if (!args.asset_quantity && !args.quote_amount) {
          throw new Error(
            'Specify a size: asset_quantity (in the base asset) or quote_amount (in the quote currency).',
          );
        }

        const request: OrderRequest = {
          symbol: args.symbol,
          side: args.side,
          type: args.type,
          assetQuantity: args.asset_quantity,
          quoteAmount: args.quote_amount,
          limitPrice: args.limit_price,
          stopPrice: args.stop_price,
          timeInForce: args.time_in_force,
        };

        const priced = await executor.price(request);

        const estimate = {
          notional_usd: priced.notionalUsd,
          reference_price: priced.referencePrice,
          priced_from: priced.pricedFrom,
        };

        // The kill switch is checked first because that is where it sits in the
        // live path: it wraps submitOrder, above the policy assertions.
        const state = killSwitch.read();
        if (state.engaged) {
          return toolResult({
            allowed: false,
            rejected_by: 'kill_switch',
            reason: killSwitch.blockMessage(state),
            estimate,
            remediation: 'An operator must call risk_kill_switch_release with confirm=true.',
          });
        }

        try {
          executor.assertAllowed(priced);
        } catch (error) {
          if (!(error instanceof PolicyError)) throw error;
          return toolResult({
            allowed: false,
            rejected_by: classifyPolicyError(error.message),
            reason: error.message,
            estimate,
            limits: limitsSnapshot(),
          });
        }

        return toolResult({
          allowed: true,
          estimate,
          would_send: priced.body,
          confirmation_required: policy.mode === 'guarded',
          note:
            policy.mode === 'guarded'
              ? 'Nothing was placed. Passing this check does not place the order: call the order ' +
                'tool with confirm=true to do that.'
              : 'Nothing was placed. This server is autonomous, so the order tool will send ' +
                'immediately when called.',
          caveat:
            'Checked against the limits as they stand now. A later order can still be refused if ' +
            'session spend has risen or the live price has moved.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'risk_kill_switch_engage',
    {
      title: 'Engage the kill switch (EMERGENCY STOP)',
      description:
        'HALT ALL EXECUTION. Every order is refused at the executor from the moment this returns, ' +
        'and every running algo job is paused, so neither a tool call nor a background strategy can ' +
        'spend anything. The halt is written to disk, so it survives a restart of this server and ' +
        'of the daemon, and it stays in force until an operator explicitly releases it. ' +
        'Use it when something is going wrong and you would rather stop everything than work out ' +
        'what: a strategy behaving unexpectedly, a price that looks wrong, or a user saying stop. ' +
        'It does NOT cancel resting orders already at Robinhood: use cancel_order for those.',
      inputSchema: {
        reason: z
          .string()
          .trim()
          .min(3)
          .describe(
            'Why execution is being halted. Recorded with the switch and shown on every blocked order.',
          ),
      },
    },
    async ({ reason }) => {
      try {
        const existing = killSwitch.read();
        if (existing.engaged) {
          return toolResult({
            engaged: true,
            already_engaged: true,
            reason: existing.reason,
            engaged_at: existing.engagedAt ? new Date(existing.engagedAt).toISOString() : null,
            message: 'Execution was already halted. The original reason is kept.',
          });
        }

        const now = Date.now();

        // Block first, pause second. If pausing throws partway, the executor
        // guard is already live, so nothing can slip through the gap.
        killSwitch.write(
          { engaged: true, reason, engagedAt: now, releasedAt: null, pausedJobIds: [] },
          now,
        );

        const paused: string[] = [];
        const failed: Array<{ job_id: string; error: string }> = [];
        for (const job of store.listJobs({ status: 'running' })) {
          try {
            store.updateJob(job.id, {
              status: 'paused',
              lastError: `Paused by the risk kill switch: ${reason}`,
            });
            store.appendEvent(job.id, 'kill_switch_paused', { reason });
            paused.push(job.id);
          } catch (error) {
            failed.push({ job_id: job.id, error: error instanceof Error ? error.message : String(error) });
          }
        }

        killSwitch.write(
          { engaged: true, reason, engagedAt: now, releasedAt: null, pausedJobIds: paused },
          now,
        );

        // A pending job has never run, and the job state machine has no
        // pending -> paused edge, so it cannot be paused. It is still harmless:
        // its first advance will try to submit and be refused by the guard.
        const pending = store.listJobs({ status: 'pending' }).map((job) => job.id);

        return toolResult({
          engaged: true,
          reason,
          engaged_at: new Date(now).toISOString(),
          paused_jobs: paused,
          ...(pending.length
            ? {
                pending_jobs_not_paused: pending,
                pending_note:
                  'These jobs have not started, so the state machine has no pause transition for ' +
                  'them. They cannot spend: any order they attempt is refused at the executor.',
              }
            : {}),
          ...(failed.length
            ? {
                jobs_that_could_not_be_paused: failed,
                failure_note:
                  'These jobs kept their status. They still cannot spend, because the executor ' +
                  'refuses every order while the switch is engaged.',
              }
            : {}),
          effect: 'No order can be placed by any tool or strategy until the switch is released.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'risk_kill_switch_release',
    {
      title: 'Release the kill switch',
      description:
        'Resume execution after an emergency stop: orders are accepted again, subject to the usual ' +
        'limits, and the jobs this switch paused are set running again. Jobs paused for any other ' +
        'reason are left alone. Requires confirm=true, because releasing it is the act of turning ' +
        'real spending back on. Check risk_status first and satisfy yourself the reason it was ' +
        'engaged no longer applies.',
      inputSchema: {
        confirm: z
          .boolean()
          .describe('Must be true. Releasing the halt re-enables real orders.'),
      },
    },
    async ({ confirm }) => {
      try {
        if (confirm !== true) {
          throw new Error(
            'Releasing the kill switch re-enables real orders, so it requires confirm=true.',
          );
        }

        const state = killSwitch.read();
        if (!state.engaged) {
          return toolResult({
            engaged: false,
            already_released: true,
            message: 'The kill switch was not engaged. Execution is subject to the usual limits.',
          });
        }

        const now = Date.now();
        const resumed: string[] = [];
        const skipped: Array<{ job_id: string; reason: string }> = [];

        for (const jobId of state.pausedJobIds) {
          const job = store.getJob(jobId);
          if (!job) {
            skipped.push({ job_id: jobId, reason: 'The job no longer exists.' });
            continue;
          }
          if (job.status !== 'paused') {
            // Someone cancelled or otherwise moved it while the halt was on.
            // Their decision outranks an automatic resume.
            skipped.push({ job_id: jobId, reason: `Job is ${job.status}, not paused. Left as is.` });
            continue;
          }
          try {
            store.updateJob(jobId, { status: 'running', lastError: null }, now);
            store.appendEvent(jobId, 'kill_switch_released', {}, now);
            resumed.push(jobId);
          } catch (error) {
            skipped.push({
              job_id: jobId,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }

        killSwitch.write({ ...RELEASED, releasedAt: now }, now);

        return toolResult({
          engaged: false,
          released_at: new Date(now).toISOString(),
          previous_reason: state.reason,
          resumed_jobs: resumed,
          ...(skipped.length ? { not_resumed: skipped } : {}),
          effect: 'Orders are accepted again, subject to the limits in risk_status.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'risk_position_size',
    {
      title: 'Size a position from account risk',
      description:
        'Work out how much to buy so that being stopped out costs a chosen fraction of the account, ' +
        'rather than picking a size and accepting whatever loss follows. Equity comes from the real ' +
        'holdings priced live unless you override it, the entry defaults to the live price, and the ' +
        'stop is given either as a price or as a distance in percent. ' +
        'The returned quantity is rounded DOWN to the venue increment, so it is a size that can ' +
        'actually be submitted, and the notional is recomputed from that rounded quantity. It fails ' +
        'rather than guesses if equity, the entry price, or the venue increment cannot be determined.',
      inputSchema: {
        symbol: symbolSchema,
        risk_percent: z
          .number()
          .positive()
          .max(100)
          .describe('Percent of account equity to lose if the stop is hit, e.g. 1.'),
        stop_price: z
          .number()
          .positive()
          .optional()
          .describe('Absolute stop price. Give this or stop_distance_percent, not both.'),
        stop_distance_percent: z
          .number()
          .positive()
          .max(100)
          .optional()
          .describe('Stop distance below entry as a percent of entry, e.g. 5.'),
        entry_price: z
          .number()
          .positive()
          .optional()
          .describe('Entry price. Defaults to the live ask.'),
        account_value_usd: z
          .number()
          .positive()
          .optional()
          .describe('Override the equity the risk is measured against. Defaults to live holdings.'),
      },
    },
    async (args) => {
      try {
        if (args.stop_price !== undefined && args.stop_distance_percent !== undefined) {
          throw new Error('Specify only one of stop_price or stop_distance_percent, not both.');
        }
        if (args.stop_price === undefined && args.stop_distance_percent === undefined) {
          throw new Error(
            'Specify the stop: stop_price for an absolute level, or stop_distance_percent for a ' +
              'distance below entry.',
          );
        }

        // Entry from the ask, because that is what entering actually costs.
        const entryPrice = args.entry_price ?? (await executor.referencePrice(args.symbol, 'buy'));
        if (entryPrice === null) {
          throw new Error(
            `No live price is available for ${args.symbol}, so an entry cannot be established and ` +
              'no size can be justified. Supply entry_price explicitly if you have one.',
          );
        }

        let equity = args.account_value_usd;
        let equitySource = 'caller-supplied account_value_usd';
        if (equity === undefined) {
          const snapshot = await exposure();
          if (!snapshot.complete) {
            throw new Error(
              `Account equity cannot be determined: ${snapshot.unpriceable.join(', ')} could not be ` +
                'quoted. Sizing against an understated equity would size every position too small ' +
                'and hide how much of the account is really at stake. Supply account_value_usd, or ' +
                'retry when quotes are available.',
            );
          }
          if (snapshot.totalPricedUsd <= 0) {
            throw new Error(
              'Account equity priced out at zero, so no position can be sized against it. Check ' +
                'risk_exposure.',
            );
          }
          equity = snapshot.totalPricedUsd;
          equitySource = 'live holdings valued at the bid';
        }

        const stopPrice =
          args.stop_price ?? entryPrice * (1 - (args.stop_distance_percent ?? 0) / 100);
        if (!(stopPrice > 0)) {
          throw new Error('The resulting stop price is not positive. Reduce stop_distance_percent.');
        }

        const sized = sizeByRisk({
          accountValueUsd: equity,
          riskPercent: args.risk_percent,
          entryPrice,
          stopPrice,
        });

        // The venue increment is what makes this a submittable size rather than
        // an arithmetic result. Without the pair row there is no increment and
        // no minimum, so refuse instead of returning a quantity that would be
        // rejected on submission.
        const pair = await executor.tradingPair(args.symbol);
        if (!pair) {
          throw new Error(
            `Could not load the trading pair for ${args.symbol}, so the venue quantity increment is ` +
              'unknown and no submittable size can be produced. Verify the symbol with ' +
              'get_trading_pairs.',
          );
        }

        const assetIncrement = pair.asset_increment ? String(pair.asset_increment) : null;
        if (!assetIncrement) {
          throw new Error(
            `The trading pair row for ${args.symbol} carries no asset_increment, so a quantity ` +
              'cannot be rounded to something the venue will accept.',
          );
        }

        const quantity = roundToIncrement(sized.quantity, assetIncrement);
        const roundedQuantity = Number(quantity);
        const minOrderSize = Number(pair.min_order_size ?? pair.min_order_amount ?? 0);

        if (!(roundedQuantity > 0)) {
          throw new Error(
            `Risking ${args.risk_percent}% of $${equity.toFixed(2)} with a stop ` +
              `${sized.stopDistancePercent.toFixed(2)}% away sizes to less than one increment of ` +
              `${assetIncrement}. Widen the risk or tighten the stop.`,
          );
        }

        const notionalUsd = roundedQuantity * entryPrice;

        return toolResult({
          symbol: args.symbol,
          quantity,
          notional_usd: notionalUsd,
          entry_price: entryPrice,
          stop_price: stopPrice,
          stop_distance_percent: sized.stopDistancePercent,
          // Recomputed from the rounded quantity, so it is the loss actually
          // taken rather than the one the unrounded arithmetic implied.
          risk_usd: roundedQuantity * Math.abs(entryPrice - stopPrice),
          intended_risk_usd: sized.riskUsd,
          account_value_usd: equity,
          account_value_source: equitySource,
          venue: {
            asset_increment: assetIncrement,
            min_order_size: Number.isFinite(minOrderSize) && minOrderSize > 0 ? minOrderSize : null,
            below_minimum:
              Number.isFinite(minOrderSize) && minOrderSize > 0
                ? roundedQuantity < minOrderSize
                : null,
          },
          exceeds_max_order_usd: notionalUsd > policy.maxOrderUsd,
          next_step:
            'Run risk_check_order with this quantity before placing it: sizing does not consult the ' +
            'per-order ceiling, the allowlist, or the session spend allowance.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'risk_limits_export',
    {
      title: 'Export every enforced limit',
      description:
        'Dump every limit this server enforces, with the environment variable that sets it, its ' +
        'current value, and what it does when it fires. Use it to answer "why was that refused" and ' +
        '"what would I change to allow it", and to hand an operator an exact list of what is ' +
        'configured rather than a description of what could be.',
      inputSchema: {},
    },
    async () => {
      try {
        const state = killSwitch.read();

        return toolResult({
          limits: [
            {
              control: 'trading_enabled',
              env: 'ROBINHOOD_CRYPTO_ENABLE_TRADING',
              value: '1 (this server is running, so it is set)',
              effect: 'Without 1, the trading server refuses to start at all.',
            },
            {
              control: 'execution_mode',
              env: 'ROBINHOOD_CRYPTO_AUTONOMOUS',
              value: policy.mode,
              effect:
                policy.mode === 'autonomous'
                  ? 'Orders send immediately; confirm is ignored. Set to anything but 1 to require confirmation.'
                  : 'Orders require confirm=true. Set to 1 to execute immediately instead.',
            },
            {
              control: 'max_order_usd',
              env: 'ROBINHOOD_CRYPTO_MAX_ORDER_USD',
              value: policy.maxOrderUsd,
              effect:
                'Any single order valued above this is refused, in both modes. An order whose USD ' +
                'value cannot be determined is also refused, since the ceiling could not be applied.',
            },
            {
              control: 'max_daily_usd',
              env: 'ROBINHOOD_CRYPTO_MAX_DAILY_USD',
              value: policy.maxDailyUsd,
              effect:
                policy.maxDailyUsd === null
                  ? 'Unset, so cumulative spend is not capped. Set it to bound a runaway loop.'
                  : 'Cumulative committed notional above this is refused. Per-process, resets on restart.',
            },
            {
              control: 'symbol_allowlist',
              env: 'ROBINHOOD_CRYPTO_SYMBOL_ALLOWLIST',
              value: policy.symbolAllowlist,
              effect:
                policy.symbolAllowlist === null
                  ? 'Unset, so any tradable symbol is permitted.'
                  : 'Only these symbols may trade. Everything else is refused.',
            },
            {
              control: 'buy_only',
              env: 'ROBINHOOD_CRYPTO_BUY_ONLY',
              value: policy.buyOnly,
              effect: policy.buyOnly
                ? 'Sell orders are refused, including the exit leg of a strategy.'
                : 'Both sides are permitted.',
            },
            {
              control: 'kill_switch',
              env: null,
              value: state.engaged ? `engaged: ${state.reason}` : 'released',
              effect:
                'When engaged, every order is refused and running jobs are paused. Set at runtime ' +
                'with risk_kill_switch_engage, not by environment variable, and persisted in the ' +
                'job database so it survives a restart.',
            },
            {
              control: 'modules_loaded',
              env: 'ROBINHOOD_MCP_MODULES',
              value: process.env.ROBINHOOD_MCP_MODULES ?? '(unset: the default set)',
              effect:
                'Decides which tools exist at all. A capability that is switched off cannot be ' +
                'reached by any means.',
            },
          ],
          session_spend: {
            committed_usd: ledger.spentUsd,
            remaining_usd: ledger.remainingUsd,
          },
          note:
            'Environment limits are read once at startup. Changing one takes effect only after the ' +
            'server restarts. The kill switch is the only control that changes at runtime.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

/** Map a policy rejection to the control that produced it. */
function classifyPolicyError(message: string): string {
  if (message.includes('SYMBOL_ALLOWLIST')) return 'symbol_allowlist';
  if (message.includes('BUY_ONLY')) return 'buy_only';
  if (message.includes('MAX_DAILY_USD')) return 'max_daily_usd';
  if (message.includes('Cannot determine the USD value')) return 'unpriceable_order';
  if (message.includes('MAX_ORDER_USD')) return 'max_order_usd';
  // Reported rather than guessed: the verdict above is authoritative because it
  // came from the real gate, and a wrong label on a correct refusal is better
  // than a confident label on a control this function has not been taught.
  return 'unclassified_policy_control';
}

interface CurvePoint {
  at: number;
  pnlUsd: number;
  source: string;
}

interface OpenLot {
  quantity: number;
  price: number;
}

interface PnlCurve {
  points: CurvePoint[];
  openLots: Map<string, OpenLot[]>;
  realized: number;
  unmatchedSells: number;
}

/**
 * Rebuild total P&L through time from fills.
 *
 * `computeCostBasis` answers what was realized, not when the account was worth
 * what, so a drawdown needs its own walk. Lots are matched FIFO the same way,
 * and each fill emits a point valued as cumulative realized P&L plus unrealized
 * P&L on the open lots, marked at the most recent price each asset traded at.
 *
 * A sell with no lot to match is counted as unmatched rather than credited
 * against a zero basis: a fabricated gain would invent a peak that never existed
 * and manufacture the drawdown that follows it.
 */
function buildPnlCurve(fills: Fill[]): PnlCurve {
  const ordered = [...fills].sort((a, b) => a.timestamp - b.timestamp);

  const openLots = new Map<string, OpenLot[]>();
  const lastPrice = new Map<string, number>();
  const points: CurvePoint[] = [];
  let realized = 0;
  let unmatchedSells = 0;

  for (const fill of ordered) {
    if (!Number.isFinite(fill.quantity) || fill.quantity <= 0) continue;
    if (!Number.isFinite(fill.price) || fill.price <= 0) continue;

    lastPrice.set(fill.assetCode, fill.price);
    const lots = openLots.get(fill.assetCode) ?? [];

    if (fill.side === 'buy') {
      lots.push({ quantity: fill.quantity, price: fill.price });
    } else {
      let remaining = fill.quantity;
      while (remaining > 0 && lots.length > 0) {
        const lot = lots[0];
        if (!lot) break;
        const consumed = Math.min(lot.quantity, remaining);
        realized += consumed * (fill.price - lot.price);
        lot.quantity -= consumed;
        remaining -= consumed;
        if (lot.quantity <= 1e-12) lots.shift();
      }
      if (remaining > 1e-12) unmatchedSells += 1;
    }

    openLots.set(fill.assetCode, lots);
    points.push({
      at: fill.timestamp,
      pnlUsd: realized + unrealized(openLots, lastPrice),
      source: 'fill',
    });
  }

  return { points, openLots, realized, unmatchedSells };
}

/** Mark-to-market P&L on open lots. Assets with no price contribute nothing. */
function unrealized(openLots: Map<string, OpenLot[]>, prices: Map<string, number>): number {
  let total = 0;
  for (const [asset, lots] of openLots) {
    const price = prices.get(asset);
    if (price === undefined) continue;
    for (const lot of lots) total += lot.quantity * (price - lot.price);
  }
  return total;
}

/** Largest decline from a running peak, in absolute terms. */
function peakToTrough(values: number[]): {
  declineUsd: number;
  peakValue: number;
  peakIndex: number;
  troughIndex: number;
} {
  let peak = -Infinity;
  let peakIndex = 0;
  let worst = { declineUsd: 0, peakValue: 0, peakIndex: 0, troughIndex: 0 };

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value === undefined || !Number.isFinite(value)) continue;

    if (value > peak) {
      peak = value;
      peakIndex = i;
    }

    const decline = peak - value;
    if (decline > worst.declineUsd) {
      worst = { declineUsd: decline, peakValue: peak, peakIndex, troughIndex: i };
    }
  }

  return worst;
}

