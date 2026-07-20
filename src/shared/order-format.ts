/**
 * Shared shaping for order tool results.
 *
 * Every order tool, primitive or composite, reports the same way: a preview
 * carries the exact wire body and the numbers a human needs to approve it, and
 * a placement carries the order plus the running spend. Keeping this in one
 * place is what stops the tools from drifting into subtly different contracts.
 */

import type { Executor, PricedOrder, SubmitResult } from './executor.js';
import { toolResult, type ToolResponse } from './format.js';

export function describePolicy(executor: Executor) {
  const policy = executor.executionPolicy;
  return {
    mode: policy.mode,
    mode_meaning:
      policy.mode === 'autonomous'
        ? 'Orders execute immediately; confirm is ignored.'
        : 'Orders preview first; a second call with confirm=true executes.',
    max_order_usd: policy.maxOrderUsd,
    max_daily_usd: policy.maxDailyUsd,
    symbol_allowlist: policy.symbolAllowlist,
    buy_only: policy.buyOnly,
  };
}

export function describeSpend(executor: Executor) {
  const ledger = executor.spendLedger;
  return {
    committed_usd: ledger.spentUsd,
    remaining_usd: ledger.remainingUsd,
    note: 'Per-process counter; resets on restart. A runaway brake, not an accounting record.',
  };
}

export function describePreview(executor: Executor, preview: PricedOrder) {
  return {
    preview: true,
    placed: false,
    message:
      'Nothing was placed. Review these numbers with the user, then call again with confirm=true.',
    request: { method: 'POST', body: preview.body },
    estimate: {
      notional_usd: preview.notionalUsd,
      reference_price: preview.referencePrice,
      priced_from: preview.pricedFrom,
    },
    policy: describePolicy(executor),
  };
}

/** Turn a submit result into the tool response, preview or placement. */
export function formatSubmitResult(executor: Executor, result: SubmitResult): ToolResponse {
  if (!result.placed && result.preview) {
    return toolResult(describePreview(executor, result.preview));
  }

  return toolResult({
    placed: true,
    mode: executor.executionPolicy.mode,
    estimated_notional_usd: result.notionalUsd,
    order: result.order,
    session_spend: describeSpend(executor),
  });
}
