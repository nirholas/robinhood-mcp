/**
 * First-class tools for the four order types Robinhood actually supports.
 *
 * `place_order` can express all of them, but it is the wrong shape for a model
 * to aim at: its fields are conditionally required in ways a JSON schema cannot
 * state. A market order takes `asset_quantity` and rejects `quote_amount`; a
 * limit order requires `limit_price`; a stop-limit requires both prices. With
 * one polymorphic tool those rules live in runtime validation, which means the
 * agent discovers them by failing.
 *
 * The tools below are narrow instead: each schema contains only the fields its
 * order type accepts, so most illegal orders cannot be constructed at all. That
 * removes a class of failed calls rather than reporting it better.
 *
 * These are ergonomics, not permissions. Every one routes through the same
 * `Executor`, so the spend cap, allowlist, daily ceiling and confirm gate apply
 * exactly as they do to `place_order`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Executor, OrderRequest } from '../shared/executor.js';
import { toolError } from '../shared/format.js';
import { formatSubmitResult } from '../shared/order-format.js';

const symbol = z
  .string()
  .regex(/^[A-Za-z0-9]+-[A-Za-z0-9]+$/, 'Symbol must be a trading pair like BTC-USD.')
  .transform((s) => s.toUpperCase())
  .describe('Trading pair, e.g. BTC-USD.');

const decimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'Must be a positive decimal string, e.g. "0.001".');

const confirm = z
  .boolean()
  .optional()
  .default(false)
  .describe(
    'Must be true to place the order in guarded mode. Ignored in autonomous mode, where orders always send.',
  );

const clientOrderId = z
  .string()
  .uuid()
  .optional()
  .describe('Idempotency key. Generated if omitted. Reuse when retrying one logical order.');

const timeInForce = z.enum(['gtc', 'day']).optional().default('gtc');

/** Sizing shared by limit and stop orders, which accept either denomination. */
const assetQuantity = decimal
  .optional()
  .describe('Size in the base asset, e.g. "0.001" BTC. Mutually exclusive with quote_amount.');

const quoteAmount = decimal
  .optional()
  .describe('Size in the quote currency, e.g. "25.00" USD. Mutually exclusive with asset_quantity.');

export function registerOrderTools(server: McpServer, executor: Executor): void {
  const { maxOrderUsd, mode } = executor.executionPolicy;
  const autonomous = mode === 'autonomous';

  /** Shared preamble so every tool states the stakes identically. */
  const stakes =
    'THIS SPENDS REAL MONEY: Robinhood has no sandbox. ' +
    (autonomous
      ? 'This server runs in AUTONOMOUS mode, so the order is submitted immediately. '
      : 'Without confirm=true this returns the exact request that would be sent plus a priced estimate, and places nothing. ') +
    `Orders above $${maxOrderUsd} are rejected.`;

  const submit = async (request: OrderRequest, doConfirm: boolean) => {
    try {
      return formatSubmitResult(executor, await executor.submitOrder(request, doConfirm));
    } catch (error) {
      return toolError(error);
    }
  };

  for (const side of ['buy', 'sell'] as const) {
    const verb = side === 'buy' ? 'Buy' : 'Sell';

    server.registerTool(
      `${side}_market`,
      {
        title: `${verb} at market`,
        description:
          `${verb} immediately at the best available price. ${stakes} ` +
          'Market orders are sized in the base asset only: Robinhood rejects quote_amount ' +
          `for them, so to ${side} a dollar amount use ${side}_limit, or compute the quantity ` +
          'from get_best_bid_ask first.',
        inputSchema: {
          symbol,
          asset_quantity: decimal.describe('Size in the base asset, e.g. "0.001" BTC.'),
          confirm,
          client_order_id: clientOrderId,
        },
      },
      async (args) =>
        submit(
          {
            symbol: args.symbol,
            side,
            type: 'market',
            assetQuantity: args.asset_quantity,
            clientOrderId: args.client_order_id,
          },
          args.confirm,
        ),
    );

    server.registerTool(
      `${side}_limit`,
      {
        title: `${verb} at a limit price`,
        description:
          `${verb} only at limit_price or better. ${stakes} ` +
          'Size with exactly one of asset_quantity or quote_amount. Unlike a market order, ' +
          'this may rest unfilled indefinitely under time_in_force=gtc; poll get_order, or ' +
          'use algo_chase_start to follow the book until filled.',
        inputSchema: {
          symbol,
          limit_price: decimal.describe(
            `Worst acceptable price. A ${side} fills at this price or better.`,
          ),
          asset_quantity: assetQuantity,
          quote_amount: quoteAmount,
          time_in_force: timeInForce,
          confirm,
          client_order_id: clientOrderId,
        },
      },
      async (args) => {
        const sizing = assertOneSizing(args);
        if (sizing) return sizing;
        return submit(
          {
            symbol: args.symbol,
            side,
            type: 'limit',
            assetQuantity: args.asset_quantity,
            quoteAmount: args.quote_amount,
            limitPrice: args.limit_price,
            timeInForce: args.time_in_force,
            clientOrderId: args.client_order_id,
          },
          args.confirm,
        );
      },
    );
  }

  server.registerTool(
    'place_stop_loss',
    {
      title: 'Place a stop-loss order',
      description:
        'Place a stop order that becomes a MARKET order once stop_price trades. ' +
        `${stakes} ` +
        'Because it converts to a market order, the fill price is not bounded and can be ' +
        'well through the stop in a fast move. Use place_stop_limit to bound it, accepting ' +
        'that a limit may not fill at all. This is a single resting order, not a trailing ' +
        'stop: for one that follows the price up, use algo_trailing_stop_start.',
      inputSchema: {
        symbol,
        side: z
          .enum(['buy', 'sell'])
          .describe('sell to protect a long position; buy to cover a short or enter on a breakout.'),
        stop_price: decimal.describe('Trigger price. The order activates when the market reaches it.'),
        asset_quantity: assetQuantity,
        quote_amount: quoteAmount,
        time_in_force: timeInForce,
        confirm,
        client_order_id: clientOrderId,
      },
    },
    async (args) => {
      const sizing = assertOneSizing(args);
      if (sizing) return sizing;
      return submit(
        {
          symbol: args.symbol,
          side: args.side,
          type: 'stop_loss',
          assetQuantity: args.asset_quantity,
          quoteAmount: args.quote_amount,
          stopPrice: args.stop_price,
          timeInForce: args.time_in_force,
          clientOrderId: args.client_order_id,
        },
        args.confirm,
      );
    },
  );

  server.registerTool(
    'place_stop_limit',
    {
      title: 'Place a stop-limit order',
      description:
        'Place a stop order that becomes a LIMIT order once stop_price trades. ' +
        `${stakes} ` +
        'The limit bounds the fill price, at the cost of possibly not filling: if the market ' +
        'gaps past limit_price the order rests unfilled and the position stays open. For a ' +
        'sell stop set limit_price at or below stop_price, otherwise it can never fill.',
      inputSchema: {
        symbol,
        side: z.enum(['buy', 'sell']),
        stop_price: decimal.describe('Trigger price. The limit order is placed when this trades.'),
        limit_price: decimal.describe('Worst acceptable fill price once triggered.'),
        asset_quantity: assetQuantity,
        quote_amount: quoteAmount,
        time_in_force: timeInForce,
        confirm,
        client_order_id: clientOrderId,
      },
    },
    async (args) => {
      const sizing = assertOneSizing(args);
      if (sizing) return sizing;

      const stop = Number(args.stop_price);
      const limit = Number(args.limit_price);
      if (args.side === 'sell' && limit > stop) {
        return toolError(
          new Error(
            `A sell stop-limit with limit_price (${args.limit_price}) above stop_price ` +
              `(${args.stop_price}) can never fill: once the price falls to the stop it is ` +
              'already below the limit. Set limit_price at or below stop_price.',
          ),
        );
      }
      if (args.side === 'buy' && limit < stop) {
        return toolError(
          new Error(
            `A buy stop-limit with limit_price (${args.limit_price}) below stop_price ` +
              `(${args.stop_price}) can never fill: once the price rises to the stop it is ` +
              'already above the limit. Set limit_price at or above stop_price.',
          ),
        );
      }

      return submit(
        {
          symbol: args.symbol,
          side: args.side,
          type: 'stop_limit',
          assetQuantity: args.asset_quantity,
          quoteAmount: args.quote_amount,
          stopPrice: args.stop_price,
          limitPrice: args.limit_price,
          timeInForce: args.time_in_force,
          clientOrderId: args.client_order_id,
        },
        args.confirm,
      );
    },
  );
}

/**
 * The one cross-field rule a narrow schema still cannot express: exactly one
 * sizing denomination. Returns a tool error to hand back, or null to proceed.
 */
function assertOneSizing(args: {
  asset_quantity?: string | undefined;
  quote_amount?: string | undefined;
}) {
  const { asset_quantity, quote_amount } = args;
  if (asset_quantity && quote_amount) {
    return toolError(
      new Error('Specify only one of asset_quantity or quote_amount, not both.'),
    );
  }
  if (!asset_quantity && !quote_amount) {
    return toolError(
      new Error(
        'Specify a size: asset_quantity (in the base asset) or quote_amount (in the quote currency).',
      ),
    );
  }
  return null;
}
