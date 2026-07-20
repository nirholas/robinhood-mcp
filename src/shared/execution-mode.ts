/**
 * How aggressively this server executes.
 *
 * Execution is the point of this package — the read-only path exists so that
 * an agent can price a trade before making it, not as the destination. What
 * varies is how much human confirmation sits in front of a live order.
 *
 * `guarded` (default) returns a priced preview on the first call and executes
 * on a second call carrying `confirm: true`. `autonomous` executes
 * immediately, for unattended strategies where no human is in the loop to
 * confirm anything.
 *
 * The spend cap applies in BOTH modes. Autonomous removes the human, not the
 * ceiling — an unattended agent is exactly the case where a runaway order is
 * most likely and least observed.
 */

export type ExecutionMode = 'guarded' | 'autonomous';

export interface ExecutionPolicy {
  mode: ExecutionMode;
  /** Per-order USD ceiling. Enforced in every mode. */
  maxOrderUsd: number;
  /** Cumulative USD this process may spend before refusing. Null disables. */
  maxDailyUsd: number | null;
  /** When set, only these symbols may trade. */
  symbolAllowlist: string[] | null;
  /** When true, sell orders are rejected. */
  buyOnly: boolean;
}

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

export const DEFAULT_MAX_ORDER_USD = 100;

export function loadExecutionPolicy(env: NodeJS.ProcessEnv = process.env): ExecutionPolicy {
  const mode: ExecutionMode =
    env.ROBINHOOD_CRYPTO_AUTONOMOUS?.trim() === '1' ? 'autonomous' : 'guarded';

  return {
    mode,
    maxOrderUsd: positiveNumber(
      env.ROBINHOOD_CRYPTO_MAX_ORDER_USD,
      DEFAULT_MAX_ORDER_USD,
      'ROBINHOOD_CRYPTO_MAX_ORDER_USD',
    ),
    maxDailyUsd: env.ROBINHOOD_CRYPTO_MAX_DAILY_USD
      ? positiveNumber(env.ROBINHOOD_CRYPTO_MAX_DAILY_USD, 0, 'ROBINHOOD_CRYPTO_MAX_DAILY_USD')
      : null,
    symbolAllowlist: parseList(env.ROBINHOOD_CRYPTO_SYMBOL_ALLOWLIST),
    buyOnly: env.ROBINHOOD_CRYPTO_BUY_ONLY?.trim() === '1',
  };
}

function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new PolicyError(`${name} must be a positive number, got "${raw}".`);
  }
  return value;
}

function parseList(raw: string | undefined): string[] | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return trimmed
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

/**
 * Running total of USD committed by this process, for the daily cap.
 *
 * Deliberately in-memory: it resets on restart and does not survive across
 * processes. It is a runaway-loop brake, not an accounting system, and it is
 * documented as such so nobody mistakes it for a hard budget.
 */
export class SpendLedger {
  private spent = 0;

  constructor(private readonly policy: ExecutionPolicy) {}

  get spentUsd(): number {
    return this.spent;
  }

  get remainingUsd(): number | null {
    return this.policy.maxDailyUsd === null ? null : Math.max(0, this.policy.maxDailyUsd - this.spent);
  }

  /** @throws {PolicyError} If this order would breach the cumulative cap. */
  assertWithinDailyCap(notionalUsd: number): void {
    if (this.policy.maxDailyUsd === null) return;
    if (this.spent + notionalUsd > this.policy.maxDailyUsd) {
      throw new PolicyError(
        `Order of $${notionalUsd.toFixed(2)} would exceed ROBINHOOD_CRYPTO_MAX_DAILY_USD ` +
          `($${this.policy.maxDailyUsd.toFixed(2)}); $${this.spent.toFixed(2)} already committed ` +
          `this session. Note this counter is per-process and resets on restart.`,
      );
    }
  }

  record(notionalUsd: number): void {
    this.spent += notionalUsd;
  }
}
