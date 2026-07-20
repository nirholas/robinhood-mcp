/**
 * One start tool per synthetic order type.
 *
 * `algo_start` takes `{ strategy, params }` where params is an untyped record.
 * That works, but it puts the entire contract out of reach of the schema: the
 * model has to call `algo_list_strategies`, read prose, and assemble a bag of
 * keys it cannot be validated against until the job is already being created.
 * Every strategy has different required parameters, so this is precisely the
 * case where a schema earns its keep.
 *
 * Each tool below declares the parameters its strategy actually takes, with
 * bounds and units. A TWAP missing `slices` fails at the schema boundary with
 * the field named, instead of inside `init` after the call has been made.
 *
 * These are ergonomics, not permissions. Every one funnels into the same
 * `startJob`, which runs the same `Strategy.init` and creates the same durable
 * job as `algo_start`, so validation and policy cannot diverge between them.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JobStore } from '../engine/store.js';
import type { Supervisor } from '../engine/supervisor.js';
import { toolResult, toolError } from '../shared/format.js';

const symbol = z
  .string()
  .regex(/^[A-Za-z0-9]+-[A-Za-z0-9]+$/, 'Symbol must be a trading pair like BTC-USD.')
  .describe('Trading pair, e.g. BTC-USD.');

const side = z.enum(['buy', 'sell']);

const decimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'Must be a positive decimal string, e.g. "0.001".');

/**
 * Every start tool carries this, because starting a job is a larger commitment
 * than placing an order: it authorizes a sequence of orders over time.
 */
const STAKES =
  'THIS SPENDS REAL MONEY OVER TIME, not just once: the job keeps placing orders until it ' +
  'completes or is cancelled, and it outlives this conversation. Cancel it with ' +
  'algo_cancel_job when it is no longer wanted. Per-order caps still apply to every order ' +
  'the job places, but the job total is not itself capped.';

export interface AlgoStartDeps {
  store: JobStore;
  supervisor: Supervisor;
  daemonRunning: () => boolean;
}

export function registerAlgoStartTools(server: McpServer, deps: AlgoStartDeps): void {
  const { store, supervisor, daemonRunning } = deps;

  /** The one path all start tools share, so none can drift from the others. */
  async function startJob(strategyName: string, params: Record<string, unknown>) {
    try {
      const impl = supervisor.strategy(strategyName);
      if (!impl) {
        const names = supervisor
          .listStrategies()
          .map((s) => s.name)
          .join(', ');
        throw new Error(
          `Strategy "${strategyName}" is not registered on this server. Available: ${names}.`,
        );
      }

      // Drop keys the caller left unset so `init` sees absent rather than
      // undefined, which its optional-parameter checks distinguish.
      const cleaned = Object.fromEntries(
        Object.entries(params).filter(([, value]) => value !== undefined),
      );

      const context = supervisor.strategyContext();
      const { state, symbol: resolvedSymbol } = await impl.init(cleaned, context);

      const job = store.createJob({
        strategy: strategyName,
        symbol: resolvedSymbol,
        state,
        params: cleaned,
        nextRunAt: Date.now(),
      });
      store.appendEvent(job.id, 'job_created', { strategy: strategyName, params: cleaned });

      return toolResult({
        started: true,
        job_id: job.id,
        strategy: strategyName,
        symbol: resolvedSymbol,
        state,
        execution_note: daemonRunning()
          ? 'A supervisor is running in this process and will advance the job.'
          : 'No always-on daemon detected. This job advances only while an MCP server or the ' +
            '`robinhood-mcp-daemon` process is running. Start the daemon for unattended execution.',
      });
    } catch (error) {
      return toolError(error);
    }
  }

  server.registerTool(
    'algo_twap_start',
    {
      title: 'Start a TWAP',
      description:
        'Split one large order into evenly spaced slices over a duration, so the entry averages ' +
        `across the window instead of paying a single spread. ${STAKES} ` +
        'Without limit_price each slice is a market order, which is the usual TWAP and has no ' +
        'price guard. With limit_price a slice that would trade through it is skipped and ' +
        'retried, so the schedule can finish short of the full size.',
      inputSchema: {
        symbol,
        side,
        total_quantity: decimal.describe('Total size in the base asset, across all slices.'),
        slices: z.number().int().min(2).max(500).describe('Number of slices to split the order into.'),
        duration_minutes: z
          .number()
          .int()
          .min(1)
          .max(60 * 24 * 7)
          .describe('Window to spread the slices across. Slice interval is duration / slices.'),
        limit_price: decimal
          .optional()
          .describe('Optional price guard. Buys will not pay above it; sells will not accept below it.'),
      },
    },
    async (args) => startJob('twap', args),
  );

  server.registerTool(
    'algo_iceberg_start',
    {
      title: 'Start an iceberg order',
      description:
        'Work a large order while showing only a small resting slice at a time, refilling as each ' +
        `slice fills, so the full size never appears in the book. ${STAKES} ` +
        'Without limit_price each refill pegs to the passive touch (the bid for a buy). On expiry ' +
        'the working slice is cancelled and the job completes, likely under-filled.',
      inputSchema: {
        symbol,
        side,
        total_quantity: decimal.describe('Total size in the base asset.'),
        visible_quantity: decimal.describe(
          'Size shown at any one time. Must be less than total_quantity and at or above the venue minimum.',
        ),
        max_duration_minutes: z
          .number()
          .int()
          .min(1)
          .max(60 * 24 * 7)
          .describe('Give up after this long and cancel any resting slice.'),
        limit_price: decimal
          .optional()
          .describe('Fixed price for every slice. Omit to peg each refill to the passive touch.'),
      },
    },
    async (args) => startJob('iceberg', args),
  );

  server.registerTool(
    'algo_ladder_start',
    {
      title: 'Start a price ladder',
      description:
        'Place a series of resting limit orders across a price range, to scale into or out of a ' +
        `position as price moves rather than committing at one level. ${STAKES} ` +
        'start_price is the rung nearest the market. A buy ladder must descend (end below start) ' +
        'and a sell ladder must ascend; a ladder already through the market is rejected. Rungs are ' +
        'placed a few per tick so one rejection does not lose the whole ladder.',
      inputSchema: {
        symbol,
        side,
        total_quantity: decimal.describe('Total size in the base asset, spread across all rungs.'),
        levels: z.number().int().min(2).max(50).describe('Number of rungs.'),
        start_price: decimal.describe('Price of the rung nearest the market.'),
        end_price: decimal.describe('Price of the furthest rung. Below start for a buy, above for a sell.'),
        distribution: z
          .enum(['even', 'front', 'back'])
          .optional()
          .describe(
            'How size is weighted across rungs. even splits equally; front weights toward start_price; back weights toward end_price.',
          ),
        time_in_force: z.enum(['gtc', 'day']).optional(),
      },
    },
    async (args) => startJob('ladder', args),
  );

  server.registerTool(
    'algo_dca_start',
    {
      title: 'Start dollar-cost averaging',
      description:
        'Buy (or sell) a fixed amount on a repeating schedule for a set number of occurrences. ' +
        `${STAKES} ` +
        'Size with exactly one of quote_amount_per_buy (a dollar amount, placed as a bounded limit ' +
        'order because the venue rejects quote_amount on market orders) or asset_quantity_per_buy ' +
        '(placed as a market order). A max_price skip does not consume an occurrence, so the ' +
        'schedule still completes its full count.',
      inputSchema: {
        symbol,
        side,
        interval_hours: z
          .number()
          .min(0.25)
          .max(8760)
          .describe('Hours between each execution. Below 0.25 use algo_twap_start instead.'),
        occurrences: z.number().int().min(1).max(1000).describe('How many times to execute.'),
        quote_amount_per_buy: decimal
          .optional()
          .describe('Dollar amount per execution. Mutually exclusive with asset_quantity_per_buy.'),
        asset_quantity_per_buy: decimal
          .optional()
          .describe('Base-asset size per execution. Mutually exclusive with quote_amount_per_buy.'),
        max_price: decimal
          .optional()
          .describe('Skip an execution above this price (buy) or below it (sell), without consuming an occurrence.'),
      },
    },
    async (args) => startJob('dca', args),
  );

  server.registerTool(
    'algo_trailing_stop_start',
    {
      title: 'Start a trailing stop',
      description:
        'Follow the market with a stop that ratchets in your favour and never retreats, exiting the ' +
        `full size when price retraces past the trail. Robinhood has no native trailing stop. ${STAKES} ` +
        'Set exactly one of trail_percent or trail_amount. Until activation_price is reached (if ' +
        'given) the stop does not arm, which is how you let a position run before protecting it. ' +
        'The exit is a market order, so the fill is not price-bounded.',
      inputSchema: {
        symbol,
        side: side.describe('Side of the EXIT. sell trails a long position; buy trails a short.'),
        quantity: decimal.describe('Size to exit when the trail is hit.'),
        trail_percent: z
          .number()
          .min(0.01)
          .max(99)
          .optional()
          .describe('Trail distance as a percent of the high-water mark. Mutually exclusive with trail_amount.'),
        trail_amount: decimal
          .optional()
          .describe('Trail distance in quote currency. Mutually exclusive with trail_percent.'),
        activation_price: decimal
          .optional()
          .describe('Do not arm the trail until price reaches this level.'),
      },
    },
    async (args) => startJob('trailing_stop', args),
  );

  server.registerTool(
    'algo_bracket_start',
    {
      title: 'Start a bracket order',
      description:
        'Enter a position and attach a take-profit and a stop-loss that cancel one another, so the ' +
        `trade is never left with only one exit. Robinhood has no native bracket. ${STAKES} ` +
        'The exits are placed only after the entry fills. For an existing position you want to ' +
        'protect rather than a new entry, use algo_oco_start instead.',
      inputSchema: {
        symbol,
        side: side.describe('Side of the ENTRY. buy opens a long, whose exits are sells.'),
        quantity: decimal.describe('Position size.'),
        entry_type: z
          .enum(['market', 'limit'])
          .describe('market enters immediately; limit waits at entry_price.'),
        entry_price: decimal.optional().describe('Required when entry_type is limit.'),
        take_profit_price: decimal.describe('Profit target. Above entry for a long, below for a short.'),
        stop_loss_price: decimal.describe('Protective stop. Below entry for a long, above for a short.'),
      },
    },
    async (args) => startJob('bracket', args),
  );

  server.registerTool(
    'algo_oco_start',
    {
      title: 'Start an OCO exit pair',
      description:
        'Protect an EXISTING position with a take-profit and a stop at once, cancelling whichever ' +
        `does not fill. Robinhood has no native OCO. ${STAKES} ` +
        'There is unavoidable exposure between one leg filling and the other being cancelled: if ' +
        'both fill, the job ends failed with the double fill spelled out rather than reporting ' +
        'success. To open a new position with exits attached, use algo_bracket_start.',
      inputSchema: {
        symbol,
        side: side.describe('Side of BOTH exits. sell exits a long position.'),
        quantity: decimal.describe('Size of the position being protected.'),
        take_profit_price: decimal.describe('Profit target. Above the stop for a sell exit.'),
        stop_price: decimal.describe('Protective stop trigger.'),
        stop_limit_price: decimal
          .optional()
          .describe(
            'Makes the stop leg a stop-limit rather than a stop-loss, bounding the fill price at the risk of not filling.',
          ),
      },
    },
    async (args) => startJob('oco', args),
  );

  server.registerTool(
    'algo_chase_start',
    {
      title: 'Start a chasing limit order',
      description:
        'Rest a limit order and repost it as the book moves away, to fill without crossing the ' +
        `spread. ${STAKES} ` +
        'A positive offset_bps rests behind the touch (passive, cheaper, may not fill); a negative ' +
        'one posts through it (marketable, fills sooner, pays more). limit_price is a hard bound ' +
        'the chase never crosses. When the retry budget is spent the last order is left resting, ' +
        'because cancelling it would turn a possible fill into a certain miss.',
      inputSchema: {
        symbol,
        side,
        quantity: decimal.describe('Size to fill.'),
        max_chases: z
          .number()
          .int()
          .min(1)
          .max(100)
          .describe('How many times to repost. The opening order does not count.'),
        offset_bps: z
          .number()
          .min(-1000)
          .max(1000)
          .describe('Basis points from the touch. Positive rests behind it, negative posts through it.'),
        limit_price: decimal
          .optional()
          .describe('Hard bound the chase never crosses: a ceiling for a buy, a floor for a sell.'),
      },
    },
    async (args) => startJob('chase', args),
  );

  server.registerTool(
    'algo_rebalance_start',
    {
      title: 'Start a portfolio rebalance',
      description:
        'Drive holdings toward target weights by selling what is overweight and buying what is ' +
        `underweight. ${STAKES} ` +
        'Sells are never mixed into the same tick as buys, so proceeds are realized before they are ' +
        'spent. The plan is computed once at start and not recomputed, which bounds the work. ' +
        'Set dry_run to size and log every leg without sending anything: do that first, show the ' +
        'user the legs, then run it for real.',
      inputSchema: {
        targets: z
          .record(z.number().min(0).max(1))
          .describe(
            'Trading pair to target weight as a fraction of 1, e.g. {"BTC-USD": 0.6, "ETH-USD": 0.4}. Weights must sum to 1.0.',
          ),
        tolerance_bps: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .describe('Drift band in basis points of the whole portfolio. Legs inside the band are left alone.'),
        max_legs_per_tick: z
          .number()
          .int()
          .min(1)
          .max(10)
          .describe('How many legs to execute per advance, pacing the rebalance.'),
        dry_run: z
          .boolean()
          .optional()
          .describe('Size and log every leg without placing any order. Use this first.'),
      },
    },
    async (args) => startJob('rebalance', args),
  );
}
