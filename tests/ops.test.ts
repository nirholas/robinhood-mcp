/**
 * MCP-level tests for the diagnostics module.
 *
 * The point of these tools is that they work when the server does not, so most
 * of what is exercised here is the degraded path: no credentials, an
 * unreachable API, a rejected signature, a skewed clock, no durable-job engine.
 * A diagnostic that throws in those cases has failed at its only job, so every
 * degraded case asserts a reported finding rather than a tool error.
 *
 * The signing client, the job store and the supervisor are real. Only the
 * network boundary is substituted.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerOpsTools } from '../src/tools/ops.js';
import { RobinhoodApiError, RobinhoodCryptoClient } from '../src/shared/client.js';
import { privateKeyFromBase64Seed, publicKeyBase64 } from '../src/shared/signer.js';
import { Executor } from '../src/shared/executor.js';
import { SpendLedger, type ExecutionPolicy } from '../src/shared/execution-mode.js';
import { JobStore } from '../src/engine/store.js';
import { Supervisor } from '../src/engine/supervisor.js';
import type { Credentials } from '../src/shared/config.js';

const API_KEY = 'rh-api-key-must-never-appear';
/** A real 32-byte Ed25519 seed, so the signer and key derivation run for real. */
const SEED = Buffer.alloc(32, 7).toString('base64');
const PRIVATE_KEY = privateKeyFromBase64Seed(SEED);
const PUBLIC_KEY = publicKeyBase64(PRIVATE_KEY);

function credentialsWith(overrides: Partial<Credentials> = {}): Credentials {
  return {
    apiKey: API_KEY,
    privateKey: PRIVATE_KEY,
    baseUrl: 'https://trading.robinhood.com',
    apiVersion: 'v1',
    ...overrides,
  } as Credentials;
}

class FakeClient {
  /** Set to have every request fail the way the API would. */
  failure: unknown = null;
  accountNumber: string | null = 'ACCT-0009';
  readonly apiVersion = 'v1';

  async get(): Promise<unknown> {
    if (this.failure) throw this.failure;
    return { results: this.accountNumber ? [{ account_number: this.accountNumber }] : [] };
  }

  async getAllPages(): Promise<{ results: unknown[]; truncated: boolean }> {
    return { results: [], truncated: false };
  }
}

const policy: ExecutionPolicy = {
  mode: 'guarded',
  maxOrderUsd: 100,
  maxDailyUsd: null,
  symbolAllowlist: null,
  buyOnly: false,
};

/** A real store and a real supervisor over the fake network client. */
function buildEngine(fake: FakeClient, daemonRunning = false) {
  const store = new JobStore(':memory:');
  const executor = new Executor(
    fake as unknown as RobinhoodCryptoClient,
    credentialsWith(),
    policy,
    new SpendLedger(policy),
  );
  const supervisor = new Supervisor(store, executor, []);
  return { store, supervisor, daemonRunning: () => daemonRunning };
}

async function harness(
  options: {
    credentials?: Credentials;
    client?: unknown;
    engine?: ReturnType<typeof buildEngine>;
  } = {},
) {
  const fake = new FakeClient();
  const server = new McpServer({ name: 'test', version: '0.0.0' });

  registerOpsTools(
    server,
    (options.client ?? fake) as unknown as RobinhoodCryptoClient,
    options.credentials ?? credentialsWith(),
    options.engine,
  );

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { client, fake };
}

function payload(result: unknown): Record<string, unknown> {
  return JSON.parse(text(result)) as Record<string, unknown>;
}

function text(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]!.text;
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

function checks(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return body.checks as Array<Record<string, unknown>>;
}

function check(body: Record<string, unknown>, name: string): Record<string, unknown> {
  return checks(body).find((c) => c.name === name)!;
}

/**
 * Answer the clock probe with a Date header that places Robinhood's clock
 * `localAheadSeconds` behind this machine's, i.e. a positive value simulates a
 * local clock running fast.
 */
function stubClock(localAheadSeconds: number): void {
  vi.stubGlobal('fetch', async () => {
    const headers = new Headers();
    headers.set('date', new Date(Date.now() - localAheadSeconds * 1_000).toUTCString());
    // A 401 carries a Date header exactly like a 200 does, which is why the
    // probe does not need to authenticate.
    return new Response(null, { status: 401, headers });
  });
}

describe('ops tools', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('registration', () => {
    it('registers the diagnostics that need no engine', async () => {
      const h = await harness();
      const { tools } = await h.client.listTools();

      expect(tools.map((t) => t.name).sort()).toEqual([
        'ops_api_version',
        'ops_clock_skew',
        'ops_diagnostics',
        'ops_health',
        'ops_key_check',
        'ops_rate_limit',
      ]);
    });

    it('adds the job tools when an engine is available', async () => {
      const fake = new FakeClient();
      const engine = buildEngine(fake);
      const h = await harness({ engine });
      const names = (await h.client.listTools()).tools.map((t) => t.name);

      expect(names).toContain('ops_supervisor_status');
      expect(names).toContain('ops_jobs_pending_intents');
      engine.store.close();
    });
  });

  describe('ops_health', () => {
    it('passes every check when the account resolves', async () => {
      const h = await harness();
      const body = payload(await h.client.callTool({ name: 'ops_health', arguments: {} }));

      expect(body.healthy).toBe(true);
      expect(checks(body).map((c) => c.name)).toEqual([
        'credentials_present',
        'private_key_usable',
        'api_reachable',
        'signature_accepted',
        'account_resolvable',
      ]);
      expect(checks(body).every((c) => c.status === 'pass')).toBe(true);
    });

    it('reports a missing credential as a finding, not an exception', async () => {
      const h = await harness({
        credentials: { apiKey: '', apiVersion: 'v1' } as Credentials,
      });
      const result = await h.client.callTool({ name: 'ops_health', arguments: {} });

      expect(isError(result)).toBe(false);
      const body = payload(result);

      expect(body.healthy).toBe(false);
      expect(check(body, 'credentials_present').status).toBe('fail');
      expect(String(check(body, 'credentials_present').detail)).toContain(
        'ROBINHOOD_CRYPTO_API_KEY',
      );
      expect(String(check(body, 'credentials_present').remediation)).toContain(
        'robinhood.com/account/crypto',
      );
      // No credential to sign with, so the network checks are unknown, and
      // unknown is never reported as a pass.
      expect(check(body, 'signature_accepted').status).toBe('unknown');
      expect(body.next_steps).not.toHaveLength(0);
    });

    it('reports an unusable private key without taking the tool down', async () => {
      const h = await harness({
        credentials: { apiKey: API_KEY, privateKey: {}, apiVersion: 'v1' } as unknown as Credentials,
      });
      const body = payload(await h.client.callTool({ name: 'ops_health', arguments: {} }));

      expect(check(body, 'private_key_usable').status).toBe('fail');
      expect(String(check(body, 'private_key_usable').remediation)).toContain('32-byte');
    });

    it('separates a rejected signature from an unreachable API', async () => {
      const h = await harness();
      h.fake.failure = new RobinhoodApiError('Robinhood API 401 on GET /accounts/', 401);

      const body = payload(await h.client.callTool({ name: 'ops_health', arguments: {} }));

      expect(check(body, 'api_reachable').status).toBe('pass');
      expect(check(body, 'signature_accepted').status).toBe('fail');
      expect(String(check(body, 'signature_accepted').remediation)).toContain('30 seconds');
      expect(check(body, 'account_resolvable').status).toBe('unknown');
    });

    it('reports a transport failure as unreachable, not as a bad signature', async () => {
      const h = await harness();
      h.fake.failure = new Error('getaddrinfo ENOTFOUND trading.robinhood.com');

      const body = payload(await h.client.callTool({ name: 'ops_health', arguments: {} }));

      expect(check(body, 'api_reachable').status).toBe('fail');
      expect(check(body, 'signature_accepted').status).toBe('unknown');
      expect(String(check(body, 'api_reachable').remediation)).toContain('proxy');
    });

    it('fails the account check when no account number comes back', async () => {
      const h = await harness();
      h.fake.accountNumber = null;

      const body = payload(await h.client.callTool({ name: 'ops_health', arguments: {} }));

      expect(check(body, 'account_resolvable').status).toBe('fail');
      expect(body.healthy).toBe(false);
    });

    it('masks the account number it resolved', async () => {
      const h = await harness();
      const body = payload(await h.client.callTool({ name: 'ops_health', arguments: {} }));

      expect(String(check(body, 'account_resolvable').detail)).toContain('0009');
      expect(text({ content: [{ text: JSON.stringify(body) }] })).not.toContain('ACCT-0009');
    });
  });

  describe('ops_clock_skew', () => {
    it('reports an aligned clock as safe', async () => {
      stubClock(0);
      const h = await harness();
      const body = payload(await h.client.callTool({ name: 'ops_clock_skew', arguments: {} }));

      expect(body.measured).toBe(true);
      expect(body.severity).toBe('ok');
      expect(body.dangerous).toBe(false);
      expect(body.signature_validity_seconds).toBe(30);
      expect(Math.abs(body.skew_seconds as number)).toBeLessThan(2);
    });

    it('calls a skew beyond the signature window critical', async () => {
      stubClock(120);
      const h = await harness();
      const body = payload(await h.client.callTool({ name: 'ops_clock_skew', arguments: {} }));

      expect(body.severity).toBe('critical');
      expect(body.dangerous).toBe(true);
      expect(body.skew_seconds as number).toBeGreaterThan(100);
      expect(String(body.direction)).toContain('ahead');
      expect(String(body.interpretation)).toContain('rejected');
      expect(String(body.remediation)).toContain('timedatectl');
    });

    it('calls a skew inside the window but close to it dangerous', async () => {
      stubClock(-20);
      const h = await harness();
      const body = payload(await h.client.callTool({ name: 'ops_clock_skew', arguments: {} }));

      expect(String(body.direction)).toContain('behind');
      expect(body.severity).toBe('dangerous');
      expect(String(body.interpretation)).toContain('intermittent');
    });

    it('reports that skew is unknown when the probe fails, rather than assuming it is fine', async () => {
      vi.stubGlobal('fetch', async () => {
        throw new Error('connect ECONNREFUSED');
      });
      const h = await harness();
      const result = await h.client.callTool({ name: 'ops_clock_skew', arguments: {} });

      expect(isError(result)).toBe(false);
      const body = payload(result);
      expect(body.measured).toBe(false);
      expect(String(body.reason)).toContain('ECONNREFUSED');
      expect(String(body.remediation)).toContain('NTP');
    });

    it('reports unknown when the response carries no Date header', async () => {
      vi.stubGlobal('fetch', async () => new Response(null, { status: 401 }));
      const h = await harness();
      const body = payload(await h.client.callTool({ name: 'ops_clock_skew', arguments: {} }));

      expect(body.measured).toBe(false);
      expect(String(body.reason)).toContain('Date header');
    });

    it('works without credentials, since a bad clock is why signing fails', async () => {
      stubClock(0);
      const h = await harness({ credentials: { apiKey: '', apiVersion: 'v1' } as Credentials });
      const body = payload(await h.client.callTool({ name: 'ops_clock_skew', arguments: {} }));

      expect(body.measured).toBe(true);
    });
  });

  describe('ops_key_check', () => {
    it('prints the public key and never the secrets', async () => {
      const h = await harness();
      const result = await h.client.callTool({ name: 'ops_key_check', arguments: {} });
      const body = payload(result);

      expect(body.configured).toBe(true);
      expect(body.public_key_base64).toBe(PUBLIC_KEY);
      expect(String(body.verify_at)).toContain('robinhood.com/account/crypto');

      expect(text(result)).not.toContain(API_KEY);
      expect(text(result)).not.toContain(SEED);
      expect(body.api_key_configured).toBe(true);
      expect(body.api_key_value).toBe('[redacted-api-key]');
      expect(String(body.api_key_fingerprint)).toMatch(/^sha256:[0-9a-f]{12}$/);
    });

    it('explains what to do when no private key is configured', async () => {
      const h = await harness({ credentials: { apiKey: API_KEY, apiVersion: 'v1' } as Credentials });
      const body = payload(await h.client.callTool({ name: 'ops_key_check', arguments: {} }));

      expect(body.configured).toBe(false);
      expect(String(body.remediation)).toContain('ROBINHOOD_CRYPTO_PRIVATE_KEY');
      expect(body.api_key_configured).toBe(true);
    });

    it('explains a private key that will not load', async () => {
      const h = await harness({
        credentials: { apiKey: API_KEY, privateKey: 'not-a-key', apiVersion: 'v1' } as unknown as Credentials,
      });
      const body = payload(await h.client.callTool({ name: 'ops_key_check', arguments: {} }));

      expect(body.configured).toBe(false);
      expect(String(body.remediation)).toContain('32-byte seed');
    });
  });

  describe('ops_rate_limit', () => {
    it('reports the documented limits', async () => {
      const h = await harness();
      const body = payload(await h.client.callTool({ name: 'ops_rate_limit', arguments: {} }));
      const documented = body.documented_limits as Record<string, unknown>;

      expect(documented.requests_per_minute).toBe(100);
      expect(documented.burst).toBe(300);
    });

    it('reads live bucket state from a real client', async () => {
      const real = new RobinhoodCryptoClient(credentialsWith());
      const h = await harness({ client: real });
      const body = payload(await h.client.callTool({ name: 'ops_rate_limit', arguments: {} }));
      const bucket = body.client_bucket as Record<string, number | boolean>;

      expect(bucket.capacity).toBe(300);
      expect(bucket.available_tokens).toBe(300);
      expect(bucket.percent_available).toBe(100);
      expect(bucket.throttled_now).toBe(false);
    });

    it('reports unknown rather than assuming a full bucket when state is unreadable', async () => {
      const h = await harness();
      const body = payload(await h.client.callTool({ name: 'ops_rate_limit', arguments: {} }));

      expect(body.client_bucket).toBeNull();
      expect(String(body.bucket_state_unknown)).toContain('could not be read');
    });
  });

  describe('ops_api_version', () => {
    it('reports v1 endpoints and how to switch', async () => {
      const h = await harness();
      const body = payload(await h.client.callTool({ name: 'ops_api_version', arguments: {} }));

      expect(body.configured_version).toBe('v1');
      expect(body.requires_account_number).toBe(false);
      expect((body.active_endpoints as Record<string, string>).estimated_price).toContain(
        '/marketdata/',
      );
      expect(String(body.how_to_switch)).toContain('ROBINHOOD_CRYPTO_API_VERSION');
    });

    it('reports the v2 asymmetries', async () => {
      const h = await harness({ credentials: credentialsWith({ apiVersion: 'v2' }) });
      const body = payload(await h.client.callTool({ name: 'ops_api_version', arguments: {} }));

      expect(body.configured_version).toBe('v2');
      expect(body.requires_account_number).toBe(true);
      expect((body.active_endpoints as Record<string, string>).estimated_price).toContain(
        '/trading/',
      );

      const areas = (body.differences as Array<Record<string, string>>).map((d) => d.area);
      expect(areas).toContain('fee tiers');
      expect(areas).toContain('account_number');
      expect(areas).toContain('partial fills');
    });
  });

  describe('ops_supervisor_status', () => {
    let engine: ReturnType<typeof buildEngine>;

    afterEach(() => {
      engine.store.close();
    });

    it('counts jobs by status and names the next one due', async () => {
      engine = buildEngine(new FakeClient());
      const due = Date.now() - 60_000;
      engine.store.createJob({
        strategy: 'twap',
        symbol: 'BTC-USD',
        state: {},
        params: {},
        nextRunAt: due,
      });
      const other = engine.store.createJob({
        strategy: 'twap',
        symbol: 'ETH-USD',
        state: {},
        params: {},
        nextRunAt: Date.now() + 600_000,
      });
      engine.store.updateJob(other.id, { status: 'cancelled' });

      const h = await harness({ engine });
      const body = payload(
        await h.client.callTool({ name: 'ops_supervisor_status', arguments: {} }),
      );

      expect((body.jobs as Record<string, number>).pending).toBe(1);
      expect((body.jobs as Record<string, number>).cancelled).toBe(1);
      expect((body.jobs as Record<string, number>).active).toBe(1);

      const next = body.next_job_due as Record<string, unknown>;
      expect(next.symbol).toBe('BTC-USD');
      expect(next.overdue_seconds as number).toBeGreaterThanOrEqual(60);
    });

    it('warns that jobs stop with the process when no daemon is running', async () => {
      engine = buildEngine(new FakeClient(), false);
      const h = await harness({ engine });
      const body = payload(
        await h.client.callTool({ name: 'ops_supervisor_status', arguments: {} }),
      );

      expect(body.daemon_running).toBe(false);
      expect(String(body.daemon_guidance)).toContain('robinhood-mcp-daemon');
    });

    it('reports a running daemon without the warning', async () => {
      engine = buildEngine(new FakeClient(), true);
      const h = await harness({ engine });
      const body = payload(
        await h.client.callTool({ name: 'ops_supervisor_status', arguments: {} }),
      );

      expect(body.daemon_running).toBe(true);
      expect(String(body.daemon_guidance)).toContain('even while no MCP client is connected');
    });

    it('surfaces paused and failed jobs with their reasons', async () => {
      engine = buildEngine(new FakeClient());
      const job = engine.store.createJob({
        strategy: 'twap',
        symbol: 'BTC-USD',
        state: {},
        params: {},
        nextRunAt: Date.now(),
      });
      engine.store.updateJob(job.id, { status: 'running' });
      engine.store.updateJob(job.id, { status: 'paused', lastError: 'spend cap exceeded' });

      const h = await harness({ engine });
      const body = payload(
        await h.client.callTool({ name: 'ops_supervisor_status', arguments: {} }),
      );

      expect((body.paused_jobs as Array<Record<string, unknown>>)[0]!.last_error).toBe(
        'spend cap exceeded',
      );
    });
  });

  describe('ops_jobs_pending_intents', () => {
    let engine: ReturnType<typeof buildEngine>;

    afterEach(() => {
      engine.store.close();
    });

    it('reports a clean store when nothing is unsettled', async () => {
      engine = buildEngine(new FakeClient());
      const h = await harness({ engine });
      const body = payload(
        await h.client.callTool({ name: 'ops_jobs_pending_intents', arguments: {} }),
      );

      expect(body.clean).toBe(true);
      expect(body.pending_intents).toEqual([]);
      expect(String(body.interpretation)).toContain('No unsettled intents');
    });

    it('lists an intent left behind by a crash and warns against resubmitting', async () => {
      engine = buildEngine(new FakeClient());
      const job = engine.store.createJob({
        strategy: 'twap',
        symbol: 'BTC-USD',
        state: {},
        params: {},
        nextRunAt: Date.now(),
      });
      engine.store.reserveIntent({
        jobId: job.id,
        clientOrderId: 'coid-1',
        body: { symbol: 'BTC-USD', side: 'buy', type: 'market' },
        notionalUsd: 25,
      });

      const h = await harness({ engine });
      const result = await h.client.callTool({
        name: 'ops_jobs_pending_intents',
        arguments: {},
      });
      const body = payload(result);
      const rows = body.pending_intents as Array<Record<string, unknown>>;

      expect(body.clean).toBe(false);
      expect(rows[0]!.client_order_id).toBe('coid-1');
      expect(rows[0]!.symbol).toBe('BTC-USD');
      expect(rows[0]!.notional_usd).toBe(25);
      expect(String(body.remediation)).toContain('journal_reconcile');
      // The double-fill warning belongs in the description an agent reads.
      const tool = (await h.client.listTools()).tools.find(
        (t) => t.name === 'ops_jobs_pending_intents',
      )!;
      expect(tool.description).toContain('Do NOT resubmit');
    });
  });

  describe('ops_diagnostics', () => {
    it('bundles every section and leaks nothing', async () => {
      stubClock(0);
      const h = await harness();
      const result = await h.client.callTool({ name: 'ops_diagnostics', arguments: {} });
      const body = payload(result);

      expect((body.health as Record<string, unknown>).healthy).toBe(true);
      expect((body.clock as Record<string, unknown>).dangerous).toBe(false);
      expect((body.credentials as Record<string, unknown>).public_key_base64).toBe(PUBLIC_KEY);
      expect((body.api as Record<string, unknown>).version).toBe('v1');
      expect(body.package_version).toBeTruthy();
      expect(String(body.how_to_report)).toContain('github.com');

      expect(text(result)).not.toContain(API_KEY);
      expect(text(result)).not.toContain(SEED);
    });

    it('still returns the other sections when every probe fails', async () => {
      vi.stubGlobal('fetch', async () => {
        throw new Error('offline');
      });
      const h = await harness({ credentials: { apiKey: '', apiVersion: 'v1' } as Credentials });
      h.fake.failure = new Error('offline');

      const result = await h.client.callTool({ name: 'ops_diagnostics', arguments: {} });

      expect(isError(result)).toBe(false);
      const body = payload(result);

      expect((body.health as Record<string, unknown>).healthy).toBe(false);
      expect((body.clock as Record<string, unknown>).skew_seconds).toBeNull();
      expect(String((body.clock as Record<string, unknown>).measurement_error)).toContain('offline');
      expect((body.credentials as Record<string, unknown>).public_key_base64).toBeNull();
      // The version section needs nothing from the network, so it survives.
      expect((body.api as Record<string, unknown>).version).toBe('v1');
    });

    it('says the engine is absent rather than omitting the section', async () => {
      stubClock(0);
      const h = await harness();
      const body = payload(await h.client.callTool({ name: 'ops_diagnostics', arguments: {} }));

      expect((body.jobs as Record<string, unknown>).available).toBe(false);
    });

    it('includes job counts when an engine is present', async () => {
      stubClock(0);
      const engine = buildEngine(new FakeClient(), true);
      engine.store.createJob({
        strategy: 'twap',
        symbol: 'BTC-USD',
        state: {},
        params: {},
        nextRunAt: Date.now(),
      });

      const h = await harness({ engine });
      const body = payload(await h.client.callTool({ name: 'ops_diagnostics', arguments: {} }));
      const jobs = body.jobs as Record<string, unknown>;

      expect(jobs.total).toBe(1);
      expect(jobs.active).toBe(1);
      expect(jobs.pending_intents).toBe(0);
      expect(jobs.daemon_running).toBe(true);
      engine.store.close();
    });

    it('omits the job section entirely when not asked for it', async () => {
      stubClock(0);
      const h = await harness();
      const body = payload(
        await h.client.callTool({ name: 'ops_diagnostics', arguments: { include_jobs: false } }),
      );

      expect(body.jobs).toBeUndefined();
    });
  });

  describe('secret hygiene', () => {
    let engine: ReturnType<typeof buildEngine>;

    beforeEach(() => {
      engine = buildEngine(new FakeClient(), false);
    });

    afterEach(() => {
      engine.store.close();
    });

    it('never emits the API key or the private key from any ops tool', async () => {
      stubClock(0);
      const h = await harness({ engine });
      const { tools } = await h.client.listTools();

      expect(tools).toHaveLength(8);
      for (const tool of tools) {
        const output = text(await h.client.callTool({ name: tool.name, arguments: {} }));
        expect(output, `${tool.name} leaked the API key`).not.toContain(API_KEY);
        expect(output, `${tool.name} leaked the private key seed`).not.toContain(SEED);
      }
    });

    it('strips the API key out of an upstream error that carries it', async () => {
      stubClock(0);
      const h = await harness({ engine });
      // The client builds error text from request context, and that context can
      // carry the key. The last line of defence is redacting the finished
      // document, which is what this asserts.
      h.fake.failure = new Error(`Request failed with x-api-key: ${API_KEY}`);

      const health = text(await h.client.callTool({ name: 'ops_health', arguments: {} }));
      expect(health).not.toContain(API_KEY);
      expect(health).toContain('[redacted-api-key]');

      const bundle = text(await h.client.callTool({ name: 'ops_diagnostics', arguments: {} }));
      expect(bundle).not.toContain(API_KEY);
    });
  });
});
