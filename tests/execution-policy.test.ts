import { describe, it, expect } from 'vitest';
import {
  loadExecutionPolicy,
  assertTradingEnabled,
  SpendLedger,
  PolicyError,
  TradingDisabledError,
  DEFAULT_MAX_ORDER_USD,
  type ExecutionPolicy,
} from '../src/shared/execution-mode.js';

const env = (extra: Record<string, string> = {}) => extra as NodeJS.ProcessEnv;

describe('trading opt-in', () => {
  it('refuses to enable trading unless explicitly set to 1', () => {
    for (const value of [undefined, 'true', '0', 'yes']) {
      const e = value === undefined ? env() : env({ ROBINHOOD_CRYPTO_ENABLE_TRADING: value });
      expect(() => assertTradingEnabled(e)).toThrow(TradingDisabledError);
    }
  });

  it('enables trading when set to 1', () => {
    expect(() => assertTradingEnabled(env({ ROBINHOOD_CRYPTO_ENABLE_TRADING: '1' }))).not.toThrow();
  });
});

describe('execution mode', () => {
  it('defaults to guarded, which previews before executing', () => {
    expect(loadExecutionPolicy(env()).mode).toBe('guarded');
  });

  it('switches to autonomous only on an exact opt-in', () => {
    expect(loadExecutionPolicy(env({ ROBINHOOD_CRYPTO_AUTONOMOUS: '1' })).mode).toBe('autonomous');
    expect(loadExecutionPolicy(env({ ROBINHOOD_CRYPTO_AUTONOMOUS: 'true' })).mode).toBe('guarded');
  });

  it('keeps the spend cap in autonomous mode', () => {
    // Autonomous removes the human, not the ceiling.
    const policy = loadExecutionPolicy(env({ ROBINHOOD_CRYPTO_AUTONOMOUS: '1' }));
    expect(policy.maxOrderUsd).toBe(DEFAULT_MAX_ORDER_USD);
  });
});

describe('policy limits', () => {
  it('applies a conservative default order cap', () => {
    expect(loadExecutionPolicy(env()).maxOrderUsd).toBe(DEFAULT_MAX_ORDER_USD);
  });

  it('rejects a malformed cap rather than silently defaulting', () => {
    for (const bad of ['0', '-5', 'abc']) {
      expect(() => loadExecutionPolicy(env({ ROBINHOOD_CRYPTO_MAX_ORDER_USD: bad }))).toThrow(
        PolicyError,
      );
    }
  });

  it('parses an allowlist into normalized symbols', () => {
    expect(
      loadExecutionPolicy(env({ ROBINHOOD_CRYPTO_SYMBOL_ALLOWLIST: 'btc-usd, eth-usd' }))
        .symbolAllowlist,
    ).toEqual(['BTC-USD', 'ETH-USD']);
  });

  it('leaves the daily cap unset by default', () => {
    expect(loadExecutionPolicy(env()).maxDailyUsd).toBeNull();
  });
});

describe('SpendLedger', () => {
  const policy = (maxDailyUsd: number | null): ExecutionPolicy => ({
    mode: 'autonomous',
    maxOrderUsd: 1_000,
    maxDailyUsd,
    symbolAllowlist: null,
    buyOnly: false,
  });

  it('accumulates committed spend', () => {
    const ledger = new SpendLedger(policy(500));
    ledger.record(100);
    ledger.record(50);
    expect(ledger.spentUsd).toBe(150);
    expect(ledger.remainingUsd).toBe(350);
  });

  it('blocks an order that would breach the daily cap', () => {
    const ledger = new SpendLedger(policy(100));
    ledger.record(80);
    expect(() => ledger.assertWithinDailyCap(30)).toThrow(/exceed ROBINHOOD_CRYPTO_MAX_DAILY_USD/);
    expect(() => ledger.assertWithinDailyCap(20)).not.toThrow();
  });

  it('is unbounded when no daily cap is configured', () => {
    const ledger = new SpendLedger(policy(null));
    ledger.record(1e6);
    expect(ledger.remainingUsd).toBeNull();
    expect(() => ledger.assertWithinDailyCap(1e6)).not.toThrow();
  });
});
