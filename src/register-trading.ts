/**
 * Order placement and cancellation.
 *
 * Every order here is real money against a real brokerage account: Robinhood
 * publishes no sandbox. Orders route through the shared `Executor`, so the
 * spend cap, symbol allowlist, and daily ceiling cannot be sidestepped by
 * reaching for a different tool.
 *
 * In `guarded` mode (the default) the first call returns a priced preview and
 * a second call with `confirm: true` executes. Setting
 * `ROBINHOOD_CRYPTO_AUTONOMOUS=1` switches to immediate execution for
 * unattended strategies, where no human is present to confirm anything.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Executor, OrderRequest } from './shared/executor.js';
import { toolResult, toolError } from './shared/format.js';
import { describePolicy, describeSpend, formatSubmitResult } from './shared/order-format.js';

const symbolSchema = z
  .string()
  .regex(/^[A-Za-z0-9]+-[A-Za-z0-9]+$/, 'Symbol must be a trading pair like BTC-USD.')
  .transform((s) => s.toUpperCase());

const decimalString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'Must be a positive decimal string, e.g. "0.001".');

export function registerTradingTools(server: McpServer, executor: Executor): void {
  const policy = executor.executionPolicy;
  const autonomous = policy.mode === 'autonomous';

  server.registerTool(
    'place_order',
    {
      title: 'Place order',
      description:
        'Place a crypto order of any type. Prefer the narrower buy_market, sell_market, ' +
        'buy_limit, sell_limit, place_stop_loss and place_stop_limit tools: their schemas ' +
        'accept only the fields that order type allows, so an invalid combination cannot be ' +
        'built. Use this one for programmatically generated orders. ' +
        'THIS SPENDS REAL MONEY: Robinhood has no sandbox. ' +
        (autonomous
          ? 'This server runs in AUTONOMOUS mode, so the order is submitted immediately. '
          : 'Without confirm=true this returns the exact request that would be sent plus a priced estimate, and places nothing. Call once to preview, show the user the numbers, then call again with confirm=true. ') +
        `Orders above $${policy.maxOrderUsd} are rejected.`,
      inputSchema: {
        symbol: symbolSchema.describe('Trading pair, e.g. BTC-USD.'),
        side: z.enum(['buy', 'sell']),
        type: z.enum(['market', 'limit', 'stop_loss', 'stop_limit']),
        asset_quantity: decimalString
          .optional()
          .describe('Size in the base asset, e.g. "0.001" BTC. Mutually exclusive with quote_amount.'),
        quote_amount: decimalString
          .optional()
          .describe('Size in the quote currency, e.g. "25.00" USD. Not supported for market orders.'),
        limit_price: decimalString.optional().describe('Required for limit and stop_limit orders.'),
        stop_price: decimalString.optional().describe('Required for stop_loss and stop_limit orders.'),
        time_in_force: z.enum(['gtc', 'day']).optional().default('gtc'),
        confirm: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'Must be true to place the order in guarded mode. Ignored in autonomous mode, where orders always send.',
          ),
        client_order_id: z
          .string()
          .uuid()
          .optional()
          .describe('Idempotency key. Generated if omitted. Reuse when retrying one logical order.'),
      },
    },
    async (args) => {
      try {
        assertOrderShape(args);

        const request: OrderRequest = {
          symbol: args.symbol,
          side: args.side,
          type: args.type,
          assetQuantity: args.asset_quantity,
          quoteAmount: args.quote_amount,
          limitPrice: args.limit_price,
          stopPrice: args.stop_price,
          timeInForce: args.time_in_force,
          clientOrderId: args.client_order_id,
        };

        return formatSubmitResult(executor, await executor.submitOrder(request, args.confirm));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'cancel_order',
    {
      title: 'Cancel order',
      description:
        'Request cancellation of an open order by id. Cancellation is best-effort: an order that has already filled cannot be canceled. Confirm the resulting state with get_order.',
      inputSchema: { order_id: z.string().min(1).describe('The order id to cancel.') },
    },
    async ({ order_id }) => {
      try {
        const response = await executor.cancelOrder(order_id);
        return toolResult({
          cancel_requested: true,
          order_id,
          response: response ?? null,
          note: 'Cancellation is best-effort. Call get_order to confirm the final state.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_execution_policy',
    {
      title: 'Get execution policy',
      description:
        'Report the execution mode and every limit this server enforces, plus how much has been committed this session. Check this before planning a strategy so sizing fits the caps.',
      inputSchema: {},
    },
    async () => {
      try {
        return toolResult({ ...describePolicy(executor), session_spend: describeSpend(executor) });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

/** Validate combinations the API rejects, with messages that say what to do. */
function assertOrderShape(args: {
  type: string;
  asset_quantity?: string | undefined;
  quote_amount?: string | undefined;
  limit_price?: string | undefined;
  stop_price?: string | undefined;
}): void {
  const { type, asset_quantity, quote_amount, limit_price, stop_price } = args;

  if (!asset_quantity && !quote_amount) {
    throw new Error('Specify either asset_quantity or quote_amount.');
  }
  if (asset_quantity && quote_amount) {
    throw new Error('Specify only one of asset_quantity or quote_amount, not both.');
  }
  if (type === 'market' && quote_amount) {
    throw new Error(
      'Market orders must be sized with asset_quantity; Robinhood does not accept quote_amount for them.',
    );
  }
  if ((type === 'limit' || type === 'stop_limit') && !limit_price) {
    throw new Error(`A ${type} order requires limit_price.`);
  }
  if ((type === 'stop_loss' || type === 'stop_limit') && !stop_price) {
    throw new Error(`A ${type} order requires stop_price.`);
  }
}
