/**
 * Live, read-only checks against the real Robinhood Crypto Trading API.
 *
 * Excluded from `npm test`. Run with real credentials:
 *
 *     ROBINHOOD_CRYPTO_API_KEY=... ROBINHOOD_CRYPTO_PRIVATE_KEY=... npm run test:live
 *
 * These tests place no orders and are safe against a funded account. They
 * exist because the unit tests cannot prove the signature is accepted by
 * Robinhood: only a real 200 can.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { RobinhoodCryptoClient } from '../src/shared/client.js';
import { loadCredentials, configuredPublicKey, type Credentials } from '../src/shared/config.js';
import { endpointsFor } from '../src/shared/endpoints.js';

const hasCredentials = Boolean(
  process.env.ROBINHOOD_CRYPTO_API_KEY && process.env.ROBINHOOD_CRYPTO_PRIVATE_KEY,
);

describe.skipIf(!hasCredentials)('live API (read-only)', () => {
  let client: RobinhoodCryptoClient;
  let credentials: Credentials;

  beforeAll(() => {
    credentials = loadCredentials();
    client = new RobinhoodCryptoClient(credentials);
  });

  it('derives a public key from the configured private key', () => {
    // If this does not match what is registered with Robinhood, every other
    // test here fails with 401 and this is the reason.
    expect(configuredPublicKey(credentials)).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it('authenticates: the account endpoint accepts our signature', async () => {
    const account = await client.get<Record<string, unknown>>(
      endpointsFor(credentials.apiVersion).accounts,
    );
    expect(account).toBeTruthy();
    // v1 returns the account directly; v2 wraps it in results[].
    const payload = (account.results as unknown[])?.[0] ?? account;
    expect(payload).toHaveProperty('account_number');
  });

  it('fetches a live quote', async () => {
    const quote = await client.get<{ results?: Array<Record<string, unknown>> }>(
      endpointsFor(credentials.apiVersion).bestBidAsk,
      { query: { symbol: ['BTC-USD'] } },
    );
    expect(Array.isArray(quote.results)).toBe(true);
    expect(quote.results?.length).toBeGreaterThan(0);
  });

  it('lists trading pairs and follows pagination', async () => {
    const { results } = await client.getAllPages(
      endpointsFor(credentials.apiVersion).tradingPairs,
      {},
      3,
    );
    expect(results.length).toBeGreaterThan(0);
  });

  it('rejects a bad signature with 401 rather than hanging', async () => {
    const broken = new RobinhoodCryptoClient({ ...credentials, apiKey: 'rh-api-not-a-real-key' });
    await expect(
      broken.get(endpointsFor(credentials.apiVersion).accounts, { maxRetries: 0 }),
    ).rejects.toThrow(/40[13]/);
  });
});
