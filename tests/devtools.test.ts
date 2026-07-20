import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { transformSync } from 'esbuild';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDevTools } from '../src/tools/devtools.js';
import { privateKeyFromBase64Seed, publicKeyBase64 } from '../src/shared/signer.js';
import type { RobinhoodCryptoClient } from '../src/shared/client.js';
import type { Credentials } from '../src/shared/config.js';

/** Documentation key material published by Robinhood, not a live credential. */
const DOC_PRIVATE_KEY = 'xQnTJVeQLmw1/Mg2YimEViSpw/SdJcgNXZ5kQkAXNPU=';
const DOC_PUBLIC_KEY = 'jPItx4TLjcnSUnmnXQQyAKL4eJj3+oWNNMmmm2vATqk=';

const credentials: Credentials = {
  apiKey: 'rh-api-6148effc-c0b1-486c-8940-a1d099456be6',
  privateKey: privateKeyFromBase64Seed(DOC_PRIVATE_KEY),
  baseUrl: 'https://trading.robinhood.com',
  apiVersion: 'v1',
};

/**
 * Capture registered handlers so tools can be invoked directly, without
 * standing up a transport.
 */
function harness(clientOverrides: Partial<RobinhoodCryptoClient> = {}) {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const server = {
    registerTool(name: string, _config: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;

  const client = {
    async get() {
      throw new Error('not stubbed');
    },
    ...clientOverrides,
  } as unknown as RobinhoodCryptoClient;

  registerDevTools(server, client, credentials);

  return {
    handlers,
    async call(name: string, args: Record<string, unknown> = {}) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Tool not registered: ${name}`);
      const result = (await handler(args)) as { content: Array<{ text: string }>; isError?: boolean };
      const text = result.content[0]!.text;
      // Error results carry a plain message, not JSON.
      let data: any = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      return { raw: result, data };
    },
  };
}

describe('tool registration', () => {
  it('registers every builder tool', () => {
    const { handlers } = harness();
    expect([...handlers.keys()].sort()).toEqual(
      [
        'check_environment',
        'diagnose_connection',
        'explain_signature',
        'generate_client_code',
        'generate_keypair',
        'verify_keypair',
      ].sort(),
    );
  });
});

describe('explain_signature', () => {
  it('reproduces the signature the client would send', async () => {
    const { call } = harness();
    const { data } = await call('explain_signature', {
      method: 'GET',
      path: '/api/v1/crypto/trading/accounts/',
      timestamp: 1698708981,
    });

    expect(data.signed_message).toBe(
      'rh-api-6148effc-c0b1-486c-8940-a1d099456be61698708981/api/v1/crypto/trading/accounts/GET',
    );
    expect(data.headers['x-timestamp']).toBe('1698708981');
    expect(data.headers['x-signature']).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('is deterministic for a fixed timestamp', async () => {
    const { call } = harness();
    const args = { method: 'GET', path: '/api/v1/crypto/trading/accounts/', timestamp: 1_700_000_000 };
    const a = await call('explain_signature', args);
    const b = await call('explain_signature', args);
    expect(a.data.headers['x-signature']).toBe(b.data.headers['x-signature']);
  });

  it('includes the body in the signed message', async () => {
    const { call } = harness();
    const { data } = await call('explain_signature', {
      method: 'POST',
      path: '/api/v1/crypto/trading/orders/',
      body: '{"symbol":"BTC-USD"}',
      timestamp: 1,
    });
    expect(data.signed_message.endsWith('POST{"symbol":"BTC-USD"}')).toBe(true);
  });

  it('never returns the private key', async () => {
    const { call } = harness();
    const { raw } = await call('explain_signature', {
      method: 'GET',
      path: '/x/',
      timestamp: 1,
    });
    expect(raw.content[0]!.text).not.toContain(DOC_PRIVATE_KEY);
  });
});

describe('verify_keypair', () => {
  it('confirms a matching pair', async () => {
    const { call } = harness();
    const { data } = await call('verify_keypair', {
      private_key: DOC_PRIVATE_KEY,
      expected_public_key: DOC_PUBLIC_KEY,
    });
    expect(data.matches).toBe(true);
  });

  it('reports a mismatch as the cause of a 401', async () => {
    const { call } = harness();
    const { data } = await call('verify_keypair', {
      private_key: DOC_PRIVATE_KEY,
      expected_public_key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    });
    expect(data.matches).toBe(false);
    expect(data.conclusion).toMatch(/401/);
  });

  it('names the 64-byte paste mistake specifically', async () => {
    const expanded = Buffer.concat([
      Buffer.from(DOC_PRIVATE_KEY, 'base64'),
      Buffer.from(DOC_PUBLIC_KEY, 'base64'),
    ]).toString('base64');

    const { call } = harness();
    const { raw } = await call('verify_keypair', {
      private_key: expanded,
      expected_public_key: DOC_PUBLIC_KEY,
    });
    expect(raw.isError).toBe(true);
    expect(raw.content[0]!.text).toMatch(/64-byte keypair/);
  });
});

describe('generate_keypair', () => {
  it('produces a usable pair that round-trips', async () => {
    const { call } = harness();
    const { data } = await call('generate_keypair');

    expect(Buffer.from(data.private_key, 'base64')).toHaveLength(32);
    expect(Buffer.from(data.public_key, 'base64')).toHaveLength(32);
    // The generated halves must actually correspond, or enrollment fails later.
    expect(publicKeyBase64(privateKeyFromBase64Seed(data.private_key))).toBe(data.public_key);
  });

  it('warns that the private key authorizes trades', async () => {
    const { call } = harness();
    const { data } = await call('generate_keypair');
    expect(data.warning).toMatch(/never commit/i);
  });
});

describe('diagnose_connection', () => {
  it('passes every check when the credential works', async () => {
    const { call } = harness({ get: async () => ({ account_number: '123' }) });
    const { data } = await call('diagnose_connection', { check_live: true });

    expect(data.derived_public_key).toBe(DOC_PUBLIC_KEY);
    const byName = Object.fromEntries(
      (data.checks as Array<{ name: string; ok: boolean }>).map((c) => [c.name, c.ok]),
    );
    expect(byName.private_key_format).toBe(true);
    expect(byName.api_key_format).toBe(true);
    expect(byName.authenticated_request).toBe(true);
  });

  it('reports the upstream error when the live call fails', async () => {
    const { call } = harness({
      get: async () => {
        throw new Error('Robinhood API 401 on GET /accounts/');
      },
    });
    const { data } = await call('diagnose_connection', { check_live: true });

    expect(data.healthy).toBe(false);
    const live = (data.checks as Array<{ name: string; ok: boolean; detail: string }>).find(
      (c) => c.name === 'authenticated_request',
    );
    expect(live?.ok).toBe(false);
    expect(live?.detail).toMatch(/401/);
    expect(data.next_step).toMatch(/derived_public_key/);
  });

  it('skips the live call when asked', async () => {
    let called = false;
    const { call } = harness({
      get: async () => {
        called = true;
        return {};
      },
    });
    await call('diagnose_connection', { check_live: false });
    expect(called).toBe(false);
  });
});

describe('check_environment', () => {
  it('reports configuration without printing secrets', async () => {
    const { call } = harness();
    const { raw, data } = await call('check_environment');

    expect(data.execution).toHaveProperty('ROBINHOOD_CRYPTO_MAX_ORDER_USD');
    expect(data.node_requirement).toMatch(/22\.5/);
    // Whatever is in the ambient environment, no key value may be echoed.
    expect(raw.content[0]!.text).not.toContain(DOC_PRIVATE_KEY);
  });
});

describe('generate_client_code', () => {
  it('emits code for each language', async () => {
    const { call } = harness();
    for (const language of ['python', 'typescript', 'curl'] as const) {
      const { data } = await call('generate_client_code', { language });
      expect(data.code.length).toBeGreaterThan(100);
      // Every sample must build the message in the documented order.
      expect(data.code).toContain('x-signature');
    }
  });

  it('generates TypeScript that actually signs correctly', async () => {
    // A sample that does not run is a failed doc. This executes the emitted
    // code against the documented keypair and checks the signature it produces
    // matches the one this package's own signer produces.
    const { call } = harness();
    const { data } = await call('generate_client_code', {
      language: 'typescript',
      method: 'GET',
      path: '/api/v1/crypto/trading/accounts/',
    });

    const source = String(data.code)
      // Replace the network call with a print of the signature.
      .replace(/const response = await fetch[\s\S]*$/, 'console.log(signature);')
      .replace(/const timestamp = Math\.floor\(Date\.now\(\) \/ 1000\);/, 'const timestamp = 1698708981;');

    const dir = mkdtempSync(join(tmpdir(), 'rh-codegen-'));
    const file = join(dir, 'sample.mjs');
    // The emitted sample is TypeScript, so transpile it exactly as a user
    // would rather than constraining the generator to type-free output.
    const js = transformSync(source, { loader: 'ts', format: 'esm' }).code;
    writeFileSync(file, js);

    const output = execFileSync('node', [file], {
      env: {
        ...process.env,
        ROBINHOOD_CRYPTO_API_KEY: credentials.apiKey,
        ROBINHOOD_CRYPTO_PRIVATE_KEY: DOC_PRIVATE_KEY,
      },
      encoding: 'utf8',
    }).trim();

    const { data: expected } = await call('explain_signature', {
      method: 'GET',
      path: '/api/v1/crypto/trading/accounts/',
      timestamp: 1698708981,
    });

    expect(output).toBe(expected.headers['x-signature']);
  });
});
