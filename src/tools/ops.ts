/**
 * Diagnostics for when the server is the thing that is broken.
 *
 * Every other module assumes credentials load, signatures verify and the clock
 * is right. This one assumes none of that, because it is what somebody runs
 * when those assumptions have already failed. That inverts the usual error
 * handling: a missing credential is not an exception here, it is a finding, and
 * a tool that throws on it has failed at its only job. Each check reports pass
 * or fail with the remediation for that specific failure, and a check that
 * cannot be performed reports "unknown" rather than guessing.
 *
 * The other hard rule is that nothing here ever emits secret material. The
 * PUBLIC key is printed in full, because verifying it against what is
 * registered at robinhood.com/account/crypto is the entire point of one of
 * these tools. The API key and the private key are never printed at all, and
 * every result is passed through `redact` on the way out as a second line of
 * defence against a stringified error carrying one.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RobinhoodCryptoClient } from '../shared/client.js';
import { RobinhoodApiError } from '../shared/client.js';
import {
  configuredPublicKey,
  jobDatabasePath,
  redact,
  DEFAULT_BASE_URL,
  RATE_LIMIT_BURST,
  RATE_LIMIT_PER_MINUTE,
  type Credentials,
} from '../shared/config.js';
import { TIMESTAMP_VALIDITY_SECONDS, currentTimestampSeconds } from '../shared/signer.js';
import { endpointsFor, requiresAccountNumber } from '../shared/endpoints.js';
import { toolResult, toolError } from '../shared/format.js';
import { isTerminal, type JobStatus } from '../engine/job.js';
import type { JobStore } from '../engine/store.js';
import type { Supervisor } from '../engine/supervisor.js';
import { VERSION } from '../version.js';

/** Durable-job machinery. Absent on the read-only server, which builds none. */
interface OpsEngine {
  store: JobStore;
  supervisor: Supervisor;
  daemonRunning: () => boolean;
}

interface Check {
  name: string;
  status: 'pass' | 'fail' | 'unknown';
  detail: string;
  /** Present whenever status is not pass: what to actually do about it. */
  remediation?: string;
}

/**
 * Skew bands, in seconds, measured against the 30 second signature window.
 *
 * The bands are deliberately conservative relative to that window: a request
 * signed at the moment of measurement still has to travel, and a clock that is
 * 20 seconds out fails intermittently, which is far harder to diagnose than one
 * that fails every time.
 */
const SKEW_OK_SECONDS = 2;
const SKEW_ELEVATED_SECONDS = 10;

export function registerOpsTools(
  server: McpServer,
  client: RobinhoodCryptoClient,
  credentials: Credentials,
  engine?: OpsEngine,
): void {
  /**
   * Read a credential field without trusting that it is there.
   *
   * The type says these are present, but this module exists for the case where
   * the process is misconfigured in a way the types did not catch, so every
   * access is defensive.
   */
  const apiKey = typeof credentials?.apiKey === 'string' ? credentials.apiKey.trim() : '';
  const baseUrl =
    typeof credentials?.baseUrl === 'string' && credentials.baseUrl
      ? credentials.baseUrl
      : DEFAULT_BASE_URL;
  const apiVersion = credentials?.apiVersion === 'v2' ? 'v2' : 'v1';
  const endpoints = endpointsFor(apiVersion);

  /**
   * Serialize a result with credential material stripped.
   *
   * Ops payloads embed upstream error text, and that text is built from request
   * context which can carry the API key. Redacting the finished document
   * catches anything an individual field forgot to.
   */
  function opsResult(payload: unknown) {
    const scrubbed = redact(JSON.stringify(payload, null, 2), credentials);
    return toolResult(JSON.parse(scrubbed));
  }

  /** Message text from any thrown value, with the API key removed. */
  function describe(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return redact(raw, credentials);
  }

  /** Credentials present and structurally usable. Never throws. */
  function credentialCheck(): Check {
    const missing: string[] = [];
    if (!apiKey) missing.push('ROBINHOOD_CRYPTO_API_KEY');
    if (!credentials?.privateKey) missing.push('ROBINHOOD_CRYPTO_PRIVATE_KEY');

    if (missing.length) {
      return {
        name: 'credentials_present',
        status: 'fail',
        detail: `Not configured: ${missing.join(' and ')}.`,
        remediation:
          'Create a credential at https://robinhood.com/account/crypto (web classic only), then set both variables in the MCP server environment. Run `npx robinhood-keygen` to generate a conforming Ed25519 keypair.',
      };
    }

    return {
      name: 'credentials_present',
      status: 'pass',
      detail: 'Both the API key and the private key are configured.',
    };
  }

  /** The private key loaded into a usable Ed25519 key. Never throws. */
  function keyCheck(): Check {
    if (!credentials?.privateKey) {
      return {
        name: 'private_key_usable',
        status: 'unknown',
        detail: 'No private key is configured, so it could not be checked.',
        remediation: 'Set ROBINHOOD_CRYPTO_PRIVATE_KEY to the base64 32-byte seed Robinhood issued.',
      };
    }

    try {
      configuredPublicKey(credentials);
      return {
        name: 'private_key_usable',
        status: 'pass',
        detail: 'The private key loaded and its public key derives cleanly.',
      };
    } catch (error) {
      return {
        name: 'private_key_usable',
        status: 'fail',
        detail: describe(error),
        remediation:
          'Robinhood issues a base64-encoded 32-byte Ed25519 seed. A 64-byte value is an expanded keypair (seed followed by public key); use its first half. A PEM block is not accepted.',
      };
    }
  }

  /**
   * One authenticated round trip, which is the only way to tell "reachable"
   * from "reachable and accepting our signature" apart.
   */
  async function reachabilityChecks(): Promise<{ checks: Check[]; accountNumber: string | null }> {
    if (!apiKey || !credentials?.privateKey) {
      const skipped = (name: string): Check => ({
        name,
        status: 'unknown',
        detail: 'Skipped: no complete credential to sign a request with.',
        remediation: 'Fix credentials_present first, then re-run this check.',
      });
      return {
        checks: [skipped('api_reachable'), skipped('signature_accepted'), skipped('account_resolvable')],
        accountNumber: null,
      };
    }

    try {
      const response = await client.get<{ results?: Array<Record<string, unknown>> }>(
        endpoints.accounts,
        // One attempt: a diagnostic should report the failure it hit, quickly,
        // rather than spend the retry budget hiding an intermittent one.
        { maxRetries: 0 },
      );

      const account = response?.results?.[0] ?? (response as Record<string, unknown> | undefined);
      const accountNumber =
        account && typeof account.account_number === 'string' ? account.account_number : null;

      return {
        accountNumber,
        checks: [
          {
            name: 'api_reachable',
            status: 'pass',
            detail: `${baseUrl} responded.`,
          },
          {
            name: 'signature_accepted',
            status: 'pass',
            detail: 'Robinhood accepted the Ed25519 signature and the API key.',
          },
          accountNumber
            ? {
                name: 'account_resolvable',
                status: 'pass',
                detail: `Resolved account ${maskAccount(accountNumber)}.`,
              }
            : {
                name: 'account_resolvable',
                status: 'fail',
                detail: 'The accounts endpoint returned no account_number.',
                remediation:
                  'Crypto trading may not be enabled on this Robinhood account, or the credential may belong to a different one. API v2 requires an account_number on most endpoints, so this failure blocks it entirely.',
              },
        ],
      };
    } catch (error) {
      return { accountNumber: null, checks: reachabilityFailure(error) };
    }
  }

  /** Turn one failed round trip into the three checks it actually answers. */
  function reachabilityFailure(error: unknown): Check[] {
    const message = describe(error);

    if (error instanceof RobinhoodApiError) {
      const unauthenticated = error.status === 401 || error.status === 403;
      return [
        {
          name: 'api_reachable',
          status: 'pass',
          detail: `${baseUrl} responded with HTTP ${error.status}, so the network path is fine.`,
        },
        {
          name: 'signature_accepted',
          status: unauthenticated ? 'fail' : 'unknown',
          detail: message,
          remediation: unauthenticated
            ? 'Three things produce this: the API key does not match the registered public key, the private key is not the one whose public half was registered, or the system clock is off. Run ops_key_check to compare the public key against robinhood.com/account/crypto, and ops_clock_skew to rule out the clock. Signatures expire 30 seconds after their timestamp.'
            : 'The request failed before authentication could be judged. Retry, then check Robinhood status if it persists.',
        },
        {
          name: 'account_resolvable',
          status: 'unknown',
          detail: 'Not reached: the accounts request did not succeed.',
          remediation: 'Resolve signature_accepted first.',
        },
      ];
    }

    // No HTTP status at all: DNS, TLS, proxy, timeout or offline.
    return [
      {
        name: 'api_reachable',
        status: 'fail',
        detail: message,
        remediation: `Could not complete a request to ${baseUrl}. Check network access, DNS, any corporate proxy or TLS interception, and that ROBINHOOD_CRYPTO_BASE_URL is not pointed somewhere unintended.`,
      },
      {
        name: 'signature_accepted',
        status: 'unknown',
        detail: 'Not reached: no response came back to judge.',
        remediation: 'Restore connectivity first.',
      },
      {
        name: 'account_resolvable',
        status: 'unknown',
        detail: 'Not reached: no response came back to judge.',
        remediation: 'Restore connectivity first.',
      },
    ];
  }

  /**
   * Measure local clock against Robinhood's `Date` response header.
   *
   * This deliberately bypasses the signing client. The measurement has to work
   * when signing does not, since a bad clock is one of the reasons signing
   * fails, so an unauthenticated request is used: a 401 carries a `Date` header
   * exactly like a 200 does.
   */
  async function measureSkew(): Promise<{
    skewSeconds: number | null;
    roundTripMs: number | null;
    serverTime: string | null;
    error?: string;
  }> {
    const started = Date.now();
    try {
      const response = await fetch(`${baseUrl}${endpoints.accounts}`, {
        method: 'GET',
        signal: AbortSignal.timeout(15_000),
      });
      const finished = Date.now();
      const header = response.headers.get('date');
      if (!header) {
        return {
          skewSeconds: null,
          roundTripMs: finished - started,
          serverTime: null,
          error: 'The response carried no Date header, so skew could not be measured.',
        };
      }

      const serverMs = Date.parse(header);
      if (!Number.isFinite(serverMs)) {
        return {
          skewSeconds: null,
          roundTripMs: finished - started,
          serverTime: header,
          error: `The Date header (${header}) could not be parsed, so skew could not be measured.`,
        };
      }

      // Compare against the midpoint of the request, which is the best estimate
      // of when the server stamped the header. Positive means local is ahead.
      const midpoint = started + (finished - started) / 2;
      return {
        skewSeconds: (midpoint - serverMs) / 1_000,
        roundTripMs: finished - started,
        serverTime: new Date(serverMs).toISOString(),
      };
    } catch (error) {
      return {
        skewSeconds: null,
        roundTripMs: null,
        serverTime: null,
        error: describe(error),
      };
    }
  }

  server.registerTool(
    'ops_health',
    {
      title: 'Check server health end to end',
      description:
        'Run the full startup check: credentials configured, private key usable, API reachable, signature accepted, account resolvable. Each check reports pass, fail or unknown, and every failure carries the specific remediation for that failure rather than a generic error. Run this first whenever anything is not working. A check reports "unknown" when it could not be performed, which is not the same as passing, and is never reported as one.',
      inputSchema: {},
    },
    async () => {
      try {
        const checks: Check[] = [credentialCheck(), keyCheck()];
        const { checks: reach } = await reachabilityChecks();
        checks.push(...reach);

        const failed = checks.filter((c) => c.status === 'fail');
        const unknown = checks.filter((c) => c.status === 'unknown');

        return opsResult({
          healthy: failed.length === 0 && unknown.length === 0,
          summary:
            failed.length === 0 && unknown.length === 0
              ? 'All checks passed. Credentials, signing and account access are working.'
              : `${failed.length} check(s) failed, ${unknown.length} could not be determined.`,
          checks,
          next_steps: failed
            .concat(unknown)
            .map((c) => c.remediation)
            .filter((text): text is string => Boolean(text)),
          server_version: VERSION,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'ops_clock_skew',
    {
      title: 'Check clock skew against Robinhood',
      description:
        'Compare this machine\'s clock to Robinhood\'s, using the Date header on an API response. Every request is signed over a Unix timestamp and Robinhood rejects a signature more than 30 seconds old, so a drifting clock is one of the most common causes of a 401 that looks like a bad key. The measurement uses an unauthenticated request on purpose, so it still works when signing does not. Accuracy is bounded by the round trip and by the header\'s one second resolution, so a sub-second reading is noise, not signal.',
      inputSchema: {},
    },
    async () => {
      try {
        const measured = await measureSkew();

        if (measured.skewSeconds === null) {
          return opsResult({
            measured: false,
            reason: measured.error ?? 'Skew could not be measured.',
            local_time: new Date().toISOString(),
            local_timestamp_seconds: currentTimestampSeconds(),
            signature_validity_seconds: TIMESTAMP_VALIDITY_SECONDS,
            remediation:
              'Without a reference time this cannot rule the clock in or out. Verify network access to the API host, then compare the system clock against a public NTP source manually.',
          });
        }

        const skew = measured.skewSeconds;
        const magnitude = Math.abs(skew);
        const severity =
          magnitude >= TIMESTAMP_VALIDITY_SECONDS
            ? 'critical'
            : magnitude >= SKEW_ELEVATED_SECONDS
              ? 'dangerous'
              : magnitude >= SKEW_OK_SECONDS
                ? 'elevated'
                : 'ok';

        return opsResult({
          measured: true,
          skew_seconds: Number(skew.toFixed(3)),
          direction: skew > 0 ? 'local clock is ahead of Robinhood' : 'local clock is behind Robinhood',
          severity,
          dangerous: severity === 'critical' || severity === 'dangerous',
          local_time: new Date().toISOString(),
          robinhood_time: measured.serverTime,
          round_trip_ms: measured.roundTripMs,
          signature_validity_seconds: TIMESTAMP_VALIDITY_SECONDS,
          accuracy_note:
            'The Date header has one second resolution and the reading is taken at the midpoint of the round trip, so treat anything under two seconds as noise.',
          interpretation:
            severity === 'critical'
              ? `Local time is off by ${magnitude.toFixed(1)}s, at or beyond the ${TIMESTAMP_VALIDITY_SECONDS}s signature window. Every signed request will be rejected with a 401 that looks exactly like a bad key.`
              : severity === 'dangerous'
                ? `Local time is off by ${magnitude.toFixed(1)}s. Requests still sign inside the ${TIMESTAMP_VALIDITY_SECONDS}s window, but a slow request can cross it, which produces intermittent 401s that are very hard to diagnose.`
                : severity === 'elevated'
                  ? `Local time is off by ${magnitude.toFixed(1)}s. Harmless today, but worth fixing before it drifts further.`
                  : 'The clock agrees with Robinhood. Rule it out as a cause of authentication failures.',
          ...(severity === 'ok'
            ? {}
            : {
                remediation:
                  'Enable network time on this machine: `timedatectl set-ntp true` on systemd Linux, `sudo sntp -sS time.apple.com` on macOS, or Settings > Time & language > Set time automatically on Windows. In a container or VM the host clock is usually the one that drifted.',
              }),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'ops_key_check',
    {
      title: 'Show the configured public key',
      description:
        'Print the PUBLIC key derived from the configured private key, so it can be compared character for character against the key registered at robinhood.com/account/crypto. A mismatch here is the single most common cause of a 401: the private key in the environment belongs to a keypair whose public half was never registered, or was registered on a different credential. The private key and the API key are NEVER printed by this tool, only a non-reversible fingerprint of the API key so two installations can be told apart.',
      inputSchema: {},
    },
    async () => {
      try {
        if (!credentials?.privateKey) {
          return opsResult({
            configured: false,
            reason: 'No private key is configured, so no public key can be derived.',
            api_key_configured: Boolean(apiKey),
            remediation:
              'Set ROBINHOOD_CRYPTO_PRIVATE_KEY to the base64 32-byte Ed25519 seed issued by Robinhood, then restart the server.',
          });
        }

        let publicKey: string;
        try {
          publicKey = configuredPublicKey(credentials);
        } catch (error) {
          return opsResult({
            configured: false,
            reason: describe(error),
            api_key_configured: Boolean(apiKey),
            remediation:
              'The configured private key is not a valid Ed25519 seed. Robinhood issues a base64 32-byte seed; a 64-byte value is an expanded keypair whose first half is the seed.',
          });
        }

        return opsResult({
          configured: true,
          public_key_base64: publicKey,
          verify_at: 'https://robinhood.com/account/crypto',
          instructions:
            'Open the credential in Robinhood and compare the public key shown there to public_key_base64 above. They must match exactly. If they do not, either the environment holds the wrong private key or the credential was created from a different keypair; regenerate with `npx robinhood-keygen`, register the new public key, and set the new private key.',
          api_key_configured: Boolean(apiKey),
          // A truncated hash identifies which credential is loaded without
          // being reversible to the credential itself, which is what makes it
          // safe to paste into an issue alongside the public key.
          api_key_fingerprint: apiKey ? fingerprint(apiKey) : null,
          api_key_value: apiKey ? redact(apiKey, credentials) : null,
          secrets_policy:
            'The private key is never printed by any tool in this package. The API key is never printed either: api_key_value shows the redaction marker so the output is safe to share, and api_key_fingerprint is a truncated SHA-256 that identifies the credential without revealing it.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'ops_rate_limit',
    {
      title: 'Show rate limit state',
      description:
        'Report the client-side token bucket and the limits Robinhood documents: 100 requests per minute with a burst of 300. The bucket is a floor that keeps a well-behaved client under the global ceiling, not a mirror of Robinhood\'s accounting: the documented limits are per endpoint and vary, so a 429 is still possible while the local bucket shows tokens available. If the live token count cannot be read it is reported as unknown rather than assumed full.',
      inputSchema: {},
    },
    async () => {
      try {
        const bucket = readBucketState(client);

        return opsResult({
          documented_limits: {
            requests_per_minute: RATE_LIMIT_PER_MINUTE,
            burst: RATE_LIMIT_BURST,
            source: 'https://docs.robinhood.com/crypto/trading/',
            note: 'Robinhood states limits are per endpoint and vary, so these are the global figures the client paces against.',
          },
          client_bucket: bucket
            ? {
                capacity: bucket.capacity,
                available_tokens: Number(bucket.tokens.toFixed(2)),
                refill_per_second: Number((bucket.refillPerMs * 1_000).toFixed(3)),
                percent_available:
                  bucket.capacity > 0 ? Number(((bucket.tokens / bucket.capacity) * 100).toFixed(1)) : null,
                seconds_to_full:
                  bucket.refillPerMs > 0
                    ? Number((((bucket.capacity - bucket.tokens) / bucket.refillPerMs) / 1_000).toFixed(1))
                    : null,
                throttled_now: bucket.tokens < 1,
              }
            : null,
          ...(bucket
            ? {}
            : {
                bucket_state_unknown:
                  'The client did not expose a token bucket in the expected shape, so live capacity could not be read. The documented limits above still apply.',
              }),
          behaviour:
            'Requests wait for a token rather than failing, so a burst is smoothed into a delay. A 429 from Robinhood is retried with its Retry-After, then with exponential backoff.',
          if_rate_limited:
            'Reduce polling frequency, prefer one paginated call over many single lookups, and avoid running several instances of this server against one credential: the bucket is per process, but Robinhood counts per account.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'ops_api_version',
    {
      title: 'Show the configured API version',
      description:
        'Report which Robinhood API version this server is configured for, what differs between v1 and v2, and how to switch. The differences are not cosmetic: v2 orders count toward fee tiers and report fee information, most v2 endpoints require an account_number query parameter, estimated_price moves from /marketdata/ to /trading/, and v2 reports a partly-filled order as "pending" where v1 says "partially_filled". Code written against one version can fail against the other for any of those reasons.',
      inputSchema: {},
    },
    async () => {
      try {
        return opsResult({
          configured_version: apiVersion,
          base_url: baseUrl,
          requires_account_number: requiresAccountNumber(apiVersion),
          active_endpoints: {
            accounts: endpoints.accounts,
            holdings: endpoints.holdings,
            orders: endpoints.orders,
            trading_pairs: endpoints.tradingPairs,
            best_bid_ask: endpoints.bestBidAsk,
            estimated_price: endpoints.estimatedPrice,
          },
          differences: [
            {
              area: 'fee tiers',
              v1: 'Orders do not count toward volume-based fee tiers and carry no fee detail.',
              v2: 'Orders count toward fee tiers and responses carry fee information.',
            },
            {
              area: 'account_number',
              v1: 'Not required.',
              v2: 'Required as a query parameter on accounts, holdings and orders. A request without it fails.',
            },
            {
              area: 'estimated_price',
              v1: endpointsFor('v1').estimatedPrice,
              v2: `${endpointsFor('v2').estimatedPrice} (moved from /marketdata/ to /trading/, which is in Robinhood's spec, not a transcription error).`,
            },
            {
              area: 'partial fills',
              v1: 'Reported with state "partially_filled".',
              v2: 'Reported with state "pending".',
            },
          ],
          how_to_switch:
            'Set ROBINHOOD_CRYPTO_API_VERSION to "v1" or "v2" in the MCP server environment and restart. Nothing switches at runtime: the endpoint set is resolved once at startup so a single session cannot mix versions.',
          current_setting: `ROBINHOOD_CRYPTO_API_VERSION=${apiVersion}${
            apiVersion === 'v1' ? ' (also the default when unset)' : ''
          }`,
          server_version: VERSION,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // The next two tools read durable-job state. Registering them without an
  // engine would hand the agent tools that can only ever answer "not
  // available", which costs context and invites a wrong explanation to the
  // user. The read-only server simply does not have them.
  if (engine) {
    server.registerTool(
      'ops_supervisor_status',
      {
        title: 'Check the job supervisor',
        description:
          'Report whether durable jobs are actually being advanced: is the supervisor ticking in this process, how many jobs sit in each status, when the next one is due, and whether the standalone daemon is needed. This is the check for the failure that produces no error at all, where jobs exist and look healthy but nothing is moving them because the process that owned the tick loop exited. A TWAP that is not ticking is not slow, it is stopped.',
        inputSchema: {},
      },
      async () => {
        try {
          const jobs = engine.store.listJobs();
          const counts: Record<string, number> = {};
          for (const job of jobs) counts[job.status] = (counts[job.status] ?? 0) + 1;

          const active = jobs.filter((job) => !isTerminal(job.status));
          const due = active
            .filter((job) => job.status === 'pending' || job.status === 'running')
            .sort((a, b) => a.nextRunAt - b.nextRunAt);
          const next = due[0];
          const daemon = safeBoolean(() => engine.daemonRunning());

          const overdueMs = next ? Date.now() - next.nextRunAt : null;

          return opsResult({
            in_process_supervisor: true,
            daemon_running: daemon,
            jobs: {
              total: jobs.length,
              pending: counts.pending ?? 0,
              running: counts.running ?? 0,
              paused: counts.paused ?? 0,
              completed: counts.completed ?? 0,
              cancelled: counts.cancelled ?? 0,
              failed: counts.failed ?? 0,
              active: active.length,
            },
            next_job_due: next
              ? {
                  job_id: next.id,
                  strategy: next.strategy,
                  symbol: next.symbol,
                  status: next.status,
                  due_at: new Date(next.nextRunAt).toISOString(),
                  overdue_seconds: overdueMs !== null && overdueMs > 0 ? Math.round(overdueMs / 1_000) : 0,
                }
              : null,
            strategies_loaded: safeStrategyNames(engine.supervisor),
            paused_jobs: jobs
              .filter((job) => job.status === 'paused')
              .map((job) => ({ job_id: job.id, strategy: job.strategy, last_error: job.lastError })),
            failed_jobs: jobs
              .filter((job) => job.status === 'failed')
              .slice(0, 20)
              .map((job) => ({ job_id: job.id, strategy: job.strategy, last_error: job.lastError })),
            daemon_guidance: daemon
              ? 'The standalone daemon is running, so jobs advance even while no MCP client is connected.'
              : 'No standalone daemon detected. Jobs only advance while this MCP server process is alive, which means closing the client stops them. Run `robinhood-mcp-daemon` to keep them moving independently.',
            database_path: jobDatabasePath(),
          });
        } catch (error) {
          return toolError(error);
        }
      },
    );

    server.registerTool(
      'ops_jobs_pending_intents',
      {
        title: 'List unsettled order intents',
        description:
          'List order intents that were reserved but never settled. Each intent is written to the local database BEFORE the order is sent, so a row still marked pending means the process died somewhere between reserving and recording the outcome, and the order may or may not exist at Robinhood. This is the first thing to check after a crash. Do NOT resubmit these by hand: reconciliation looks each one up by its client_order_id and adopts the order if it exists, and a manual resubmit under a new id is how one intended fill becomes two real ones. Use journal_reconcile for the full comparison against Robinhood.',
        inputSchema: {
          limit: z.number().int().positive().max(200).optional().default(50),
        },
      },
      async ({ limit }) => {
        try {
          const pending = engine.store.pendingIntents();
          const now = Date.now();

          return opsResult({
            pending_intents: pending.slice(0, limit).map((intent) => ({
              client_order_id: intent.clientOrderId,
              job_id: intent.jobId,
              symbol: typeof intent.body.symbol === 'string' ? intent.body.symbol : null,
              side: typeof intent.body.side === 'string' ? intent.body.side : null,
              type: typeof intent.body.type === 'string' ? intent.body.type : null,
              notional_usd: intent.notionalUsd,
              reserved_at: new Date(intent.createdAt).toISOString(),
              age_seconds: Math.round((now - intent.createdAt) / 1_000),
            })),
            total: pending.length,
            returned: Math.min(pending.length, limit),
            clean: pending.length === 0,
            interpretation:
              pending.length === 0
                ? 'No unsettled intents. Every order this toolkit reserved reached a recorded outcome.'
                : 'Each of these was reserved locally without a recorded outcome. Robinhood may or may not have the order.',
            remediation:
              pending.length === 0
                ? undefined
                : 'Restart robinhood-mcp-trading, or run robinhood-mcp-daemon: reconciliation runs before any job advances and resolves each intent by looking it up upstream. Run journal_reconcile to see the current verdict per intent without waiting.',
            database_path: jobDatabasePath(),
          });
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  server.registerTool(
    'ops_diagnostics',
    {
      title: 'Collect a diagnostic bundle',
      description:
        'Run health, clock skew, key check and API version in one call and return them as a single document to paste into a bug report or an issue. Every section is collected independently, so one failing section does not lose the others, and the whole document is scrubbed of credential material before it is returned: it contains the PUBLIC key (which is meant to be shared) and never the private key or the API key. Read the output before sharing it anyway, as a habit worth keeping.',
      inputSchema: {
        include_jobs: z
          .boolean()
          .optional()
          .default(true)
          .describe('Include durable job counts, when this server has an engine.'),
      },
    },
    async ({ include_jobs }) => {
      try {
        const checks: Check[] = [credentialCheck(), keyCheck()];
        // Collected independently: a diagnostic bundle that aborts on the first
        // failure is useless in exactly the situation it exists for.
        const reach = await reachabilityChecks().catch((error) => ({
          checks: reachabilityFailure(error),
          accountNumber: null,
        }));
        checks.push(...reach.checks);

        const skew = await measureSkew();
        const publicKey = credentials?.privateKey ? tryPublicKey(credentials) : null;
        const bucket = readBucketState(client);

        const failed = checks.filter((c) => c.status === 'fail');

        return opsResult({
          collected_at: new Date().toISOString(),
          package_version: VERSION,
          runtime: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
          },
          health: {
            healthy: failed.length === 0 && !checks.some((c) => c.status === 'unknown'),
            checks,
          },
          clock: {
            skew_seconds: skew.skewSeconds === null ? null : Number(skew.skewSeconds.toFixed(3)),
            round_trip_ms: skew.roundTripMs,
            robinhood_time: skew.serverTime,
            local_time: new Date().toISOString(),
            signature_validity_seconds: TIMESTAMP_VALIDITY_SECONDS,
            dangerous:
              skew.skewSeconds === null ? null : Math.abs(skew.skewSeconds) >= SKEW_ELEVATED_SECONDS,
            ...(skew.error ? { measurement_error: skew.error } : {}),
          },
          credentials: {
            api_key_configured: Boolean(apiKey),
            api_key_fingerprint: apiKey ? fingerprint(apiKey) : null,
            private_key_configured: Boolean(credentials?.privateKey),
            public_key_base64: publicKey,
            note: 'The public key is safe to share and is what you compare against robinhood.com/account/crypto. No secret material appears anywhere in this document.',
          },
          api: {
            version: apiVersion,
            base_url: baseUrl,
            requires_account_number: requiresAccountNumber(apiVersion),
            orders_endpoint: endpoints.orders,
          },
          rate_limit: {
            documented_per_minute: RATE_LIMIT_PER_MINUTE,
            documented_burst: RATE_LIMIT_BURST,
            available_tokens: bucket ? Number(bucket.tokens.toFixed(2)) : null,
          },
          jobs:
            include_jobs && engine
              ? {
                  database_path: jobDatabasePath(),
                  daemon_running: safeBoolean(() => engine.daemonRunning()),
                  total: engine.store.listJobs().length,
                  active: engine.store.listJobs().filter((job) => !isTerminal(job.status as JobStatus))
                    .length,
                  pending_intents: engine.store.pendingIntents().length,
                }
              : include_jobs
                ? { available: false, reason: 'This server runs no durable-job engine.' }
                : undefined,
          how_to_report:
            'Paste this document into https://github.com/nirholas/robinhood-mcp/issues along with what you were trying to do and the exact tool call that failed.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

/**
 * Read the client's rate-limit bucket.
 *
 * Uses the client's own accessor, which refills before reporting so an idle
 * bucket does not read as stale. Wrapped because a diagnostic must degrade to
 * "unknown" rather than throw: these tools are what someone runs when the
 * client is already misbehaving.
 */
function readBucketState(
  client: RobinhoodCryptoClient,
): { tokens: number; capacity: number; refillPerMs: number } | null {
  try {
    const state = client.rateLimitState();
    if (!Number.isFinite(state.capacity) || state.capacity <= 0) return null;
    if (!Number.isFinite(state.tokens) || !Number.isFinite(state.refillPerMs)) return null;
    return {
      tokens: Math.max(0, state.tokens),
      capacity: state.capacity,
      refillPerMs: state.refillPerMs,
    };
  } catch {
    return null;
  }
}

/** Non-reversible identifier for a secret, safe to paste into an issue. */
function fingerprint(secret: string): string {
  return `sha256:${createHash('sha256').update(secret).digest('hex').slice(0, 12)}`;
}

/** Account numbers are not secret, but there is no reason to print one in full. */
function maskAccount(accountNumber: string): string {
  return accountNumber.length <= 4
    ? '****'
    : `${'*'.repeat(accountNumber.length - 4)}${accountNumber.slice(-4)}`;
}

function tryPublicKey(credentials: Credentials): string | null {
  try {
    return configuredPublicKey(credentials);
  } catch {
    // A key that will not load is already reported as a failed check; the
    // bundle should not lose every other section over it.
    return null;
  }
}

/** A predicate supplied by the host must not be able to break a diagnostic. */
function safeBoolean(read: () => boolean): boolean | null {
  try {
    return read();
  } catch {
    return null;
  }
}

function safeStrategyNames(supervisor: Supervisor): string[] | null {
  try {
    return supervisor.listStrategies().map((strategy) => strategy.name);
  } catch {
    return null;
  }
}
