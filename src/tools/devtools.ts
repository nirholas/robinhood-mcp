/**
 * Builder tools.
 *
 * Integrating against this API fails in a small number of specific ways, and
 * every one of them surfaces as an opaque 401. These tools turn "it does not
 * work" into a named cause: a wrong key format, a skewed clock, a signature
 * built over the wrong bytes, a missing scope.
 *
 * Nothing here places an order, and nothing here prints a secret.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RobinhoodCryptoClient } from '../shared/client.js';
import {
  configuredPublicKey,
  loadCredentials,
  MissingCredentialsError,
  type Credentials,
} from '../shared/config.js';
import {
  buildAuthHeaders,
  buildSignatureMessage,
  currentTimestampSeconds,
  privateKeyFromBase64Seed,
  publicKeyBase64,
  TIMESTAMP_VALIDITY_SECONDS,
} from '../shared/signer.js';
import { generateKeypair } from '../keygen.js';
import { endpointsFor } from '../shared/endpoints.js';
import { toolResult, toolError } from '../shared/format.js';

export function registerDevTools(
  server: McpServer,
  client: RobinhoodCryptoClient,
  credentials: Credentials,
): void {
  server.registerTool(
    'diagnose_connection',
    {
      title: 'Diagnose the connection',
      description:
        'Run every check that distinguishes the common causes of a 401 against this API: key format, derived public key, clock skew, and whether a live authenticated call actually succeeds. Run this FIRST when anything returns 401 or 403, instead of guessing. Never returns secret material.',
      inputSchema: {
        check_live: z
          .boolean()
          .optional()
          .default(true)
          .describe('Make one real authenticated request to confirm the credential works.'),
      },
    },
    async ({ check_live }) => {
      const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

      // 1. Key material shape. A 64-byte paste is the single most common error.
      let publicKey: string | null = null;
      try {
        publicKey = configuredPublicKey(credentials);
        checks.push({
          name: 'private_key_format',
          ok: true,
          detail: 'Decodes to a 32-byte Ed25519 seed, which is the form Robinhood issues.',
        });
      } catch (error) {
        checks.push({
          name: 'private_key_format',
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }

      // 2. API key shape. Keys issued after 2024-08-13 carry the rh-api- prefix.
      const apiKey = credentials.apiKey;
      const looksModern = /^rh-api-[0-9a-f-]{36}$/i.test(apiKey);
      const looksLegacy = /^[0-9a-f-]{36}$/i.test(apiKey);
      checks.push({
        name: 'api_key_format',
        ok: looksModern || looksLegacy,
        detail: looksModern
          ? 'Matches the rh-api-{uuid} format used since August 2024.'
          : looksLegacy
            ? 'Matches the older bare-uuid format. Valid, just issued before August 2024.'
            : 'Does not match either known format. Check for a truncated paste or surrounding quotes.',
      });

      // 3. Clock. Signatures expire 30 seconds after their timestamp, so a
      // skewed clock fails every request while looking like a bad key.
      const skewSeconds = await measureClockSkew();
      checks.push({
        name: 'clock_skew',
        ok: skewSeconds === null || Math.abs(skewSeconds) < TIMESTAMP_VALIDITY_SECONDS / 2,
        detail:
          skewSeconds === null
            ? 'Could not reach a time source to measure skew. Verify NTP is running.'
            : `Local clock differs from the server by ${skewSeconds.toFixed(1)}s. ` +
              `Signatures expire after ${TIMESTAMP_VALIDITY_SECONDS}s, so anything approaching that fails every request.`,
      });

      // 4. The only check that proves the credential actually works.
      if (check_live) {
        try {
          await client.get(endpointsFor(credentials.apiVersion).accounts);
          checks.push({
            name: 'authenticated_request',
            ok: true,
            detail: 'A live authenticated request succeeded. The credential is valid and scoped for reads.',
          });
        } catch (error) {
          checks.push({
            name: 'authenticated_request',
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const failed = checks.filter((c) => !c.ok);
      return toolResult({
        healthy: failed.length === 0,
        api_version: credentials.apiVersion,
        base_url: credentials.baseUrl,
        derived_public_key: publicKey,
        checks,
        ...(publicKey
          ? {
              next_step:
                failed.length === 0
                  ? 'Everything checks out.'
                  : 'Confirm derived_public_key matches the public key registered at https://robinhood.com/account/crypto. If it does not, the configured private key belongs to a different credential.',
            }
          : {}),
      });
    },
  );

  server.registerTool(
    'explain_signature',
    {
      title: 'Explain a request signature',
      description:
        'Show exactly what gets signed for a given request: the concatenated message, its components, and the resulting header. Use this when building a client in another language and its signatures are rejected, to compare byte for byte. Uses the configured credential but never reveals the private key.',
      inputSchema: {
        method: z.enum(['GET', 'POST']).describe('HTTP method, uppercase.'),
        path: z
          .string()
          .min(1)
          .describe('Path including query string and trailing slash, e.g. /api/v1/crypto/trading/accounts/'),
        body: z
          .string()
          .optional()
          .describe('Exact JSON body as it will be sent. Omit for GET.'),
        timestamp: z
          .number()
          .int()
          .optional()
          .describe('Unix seconds. Defaults to now. Fix it to reproduce a past signature.'),
      },
    },
    async ({ method, path, body, timestamp }) => {
      try {
        const ts = timestamp ?? currentTimestampSeconds();
        const message = buildSignatureMessage({
          apiKey: credentials.apiKey,
          timestamp: ts,
          path,
          method,
          body,
        });

        const headers = buildAuthHeaders({
          apiKey: credentials.apiKey,
          privateKey: credentials.privateKey,
          path,
          method,
          body,
          timestamp: ts,
        });

        return toolResult({
          message_format: '{api_key}{timestamp}{path}{method}{body}',
          components: {
            api_key: credentials.apiKey,
            timestamp: String(ts),
            path,
            method,
            body: body ?? '(empty)',
          },
          signed_message: message,
          signed_message_bytes: Buffer.byteLength(message, 'utf8'),
          headers: {
            'x-api-key': headers['x-api-key'],
            'x-timestamp': headers['x-timestamp'],
            'x-signature': headers['x-signature'],
          },
          gotchas: [
            'The path includes the query string and the trailing slash. Both are signed.',
            'Serialize the body once and sign those exact bytes. Re-serializing changes key order or whitespace and invalidates the signature.',
            'The timestamp is Unix SECONDS. Date.now() returns milliseconds.',
            "Robinhood's own published example signature does not match a JSON body: it was generated over a Python dict repr. Do not use it as a conformance check.",
          ],
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'generate_keypair',
    {
      title: 'Generate an API keypair',
      description:
        'Generate a fresh Ed25519 keypair in the format Robinhood expects. Register the PUBLIC key at robinhood.com/account/crypto (web classic only) and Robinhood issues an API key in return. The private key is returned once and never stored: treat it like a password.',
      inputSchema: {},
    },
    async () => {
      try {
        const { publicKeyBase64: pub, privateKeyBase64: priv } = generateKeypair();
        return toolResult({
          public_key: pub,
          private_key: priv,
          steps: [
            'Register public_key at https://robinhood.com/account/crypto (web classic, not mobile).',
            'Robinhood issues an API key. Set it as ROBINHOOD_CRYPTO_API_KEY.',
            'Set private_key as ROBINHOOD_CRYPTO_PRIVATE_KEY.',
            'Pick the credential scopes deliberately: a read-only key cannot place orders no matter what software holds it.',
          ],
          warning:
            'private_key authorizes trades. Never commit it, never paste it into a shared channel, and prefer an IP allowlist on the credential.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'verify_keypair',
    {
      title: 'Verify a keypair matches',
      description:
        'Check whether a private key corresponds to a given public key, without sending anything anywhere. Use this when a 401 might mean the configured private key belongs to a different credential than the one registered with Robinhood.',
      inputSchema: {
        private_key: z.string().min(1).describe('Base64 32-byte Ed25519 seed to test.'),
        expected_public_key: z
          .string()
          .min(1)
          .describe('The public key registered with Robinhood, to compare against.'),
      },
    },
    async ({ private_key, expected_public_key }) => {
      try {
        const derived = publicKeyBase64(privateKeyFromBase64Seed(private_key));
        const matches = derived === expected_public_key.trim();

        return toolResult({
          matches,
          derived_public_key: derived,
          expected_public_key: expected_public_key.trim(),
          conclusion: matches
            ? 'This private key corresponds to that public key.'
            : 'These do not correspond. The private key belongs to a different keypair than the one registered, which produces a 401 on every request.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'generate_client_code',
    {
      title: 'Generate client code',
      description:
        'Emit a runnable, correctly signed request in Python, TypeScript, or curl for any endpoint. Use this when a user wants to call the API from their own code rather than through this server. The signing logic is the same one this server uses.',
      inputSchema: {
        language: z.enum(['python', 'typescript', 'curl']),
        method: z.enum(['GET', 'POST']).optional().default('GET'),
        path: z
          .string()
          .optional()
          .default('/api/v1/crypto/trading/accounts/')
          .describe('Path including trailing slash.'),
        body: z.string().optional().describe('JSON body for a POST.'),
      },
    },
    async ({ language, method, path, body }) => {
      try {
        return toolResult({
          language,
          code: renderClientCode(language, method, path, body),
          note: 'Credentials are read from the environment; no key is embedded in the sample.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'check_environment',
    {
      title: 'Check the environment',
      description:
        'Report which configuration variables are set and what each one currently does, without printing any secret value. Use this to answer "why is trading disabled" or "why was my order rejected" before changing anything.',
      inputSchema: {},
    },
    async () => {
      const env = process.env;
      const present = (name: string) => Boolean(env[name]?.trim());

      let credentialsLoad = 'ok';
      try {
        loadCredentials(env);
      } catch (error) {
        credentialsLoad =
          error instanceof MissingCredentialsError ? error.message : String(error);
      }

      return toolResult({
        credentials: {
          ROBINHOOD_CRYPTO_API_KEY: present('ROBINHOOD_CRYPTO_API_KEY') ? 'set' : 'MISSING',
          ROBINHOOD_CRYPTO_PRIVATE_KEY: present('ROBINHOOD_CRYPTO_PRIVATE_KEY') ? 'set' : 'MISSING',
          status: credentialsLoad,
        },
        api: {
          ROBINHOOD_CRYPTO_API_VERSION: env.ROBINHOOD_CRYPTO_API_VERSION ?? 'v1 (default)',
          ROBINHOOD_CRYPTO_BASE_URL: env.ROBINHOOD_CRYPTO_BASE_URL ?? 'https://trading.robinhood.com (default)',
        },
        execution: {
          ROBINHOOD_CRYPTO_ENABLE_TRADING:
            env.ROBINHOOD_CRYPTO_ENABLE_TRADING === '1'
              ? 'enabled'
              : 'disabled (the trading server will refuse to start)',
          ROBINHOOD_CRYPTO_AUTONOMOUS:
            env.ROBINHOOD_CRYPTO_AUTONOMOUS === '1'
              ? 'autonomous: orders execute immediately with no confirm step'
              : 'guarded (default): orders preview first',
          ROBINHOOD_CRYPTO_MAX_ORDER_USD: env.ROBINHOOD_CRYPTO_MAX_ORDER_USD ?? '100 (default)',
          ROBINHOOD_CRYPTO_MAX_DAILY_USD: env.ROBINHOOD_CRYPTO_MAX_DAILY_USD ?? 'unset (no cumulative cap)',
          ROBINHOOD_CRYPTO_SYMBOL_ALLOWLIST: env.ROBINHOOD_CRYPTO_SYMBOL_ALLOWLIST ?? 'unset (all symbols)',
          ROBINHOOD_CRYPTO_BUY_ONLY: env.ROBINHOOD_CRYPTO_BUY_ONLY === '1' ? 'sells blocked' : 'sells allowed',
        },
        engine: {
          ROBINHOOD_MCP_DB: env.ROBINHOOD_MCP_DB ?? '~/.robinhood-mcp/jobs.db (default)',
          ROBINHOOD_MCP_MODULES: env.ROBINHOOD_MCP_MODULES ?? 'unset (the default module set)',
        },
        node_version: process.version,
        node_requirement: 'Node >= 22.5 is required for the durable job store (node:sqlite).',
      });
    },
  );
}

/**
 * Measure local clock skew against a public time source.
 *
 * Returns null rather than throwing when the network is unavailable: an
 * unmeasurable clock is a weaker signal than a bad one, not an error.
 */
async function measureClockSkew(): Promise<number | null> {
  try {
    const before = Date.now();
    const response = await fetch('https://trading.robinhood.com/', {
      method: 'HEAD',
      signal: AbortSignal.timeout(5_000),
    });
    const after = Date.now();

    const header = response.headers.get('date');
    if (!header) return null;

    const serverTime = Date.parse(header);
    if (!Number.isFinite(serverTime)) return null;

    // Compare against the midpoint of the request to cancel out latency.
    return (before + after) / 2 - serverTime > 0
      ? ((before + after) / 2 - serverTime) / 1000
      : ((before + after) / 2 - serverTime) / 1000;
  } catch {
    return null;
  }
}

function renderClientCode(
  language: 'python' | 'typescript' | 'curl',
  method: string,
  path: string,
  body: string | undefined,
): string {
  const bodyLiteral = body ?? '';

  if (language === 'python') {
    return `import base64, datetime, os, requests
from nacl.signing import SigningKey

API_KEY = os.environ["ROBINHOOD_CRYPTO_API_KEY"]
PRIVATE_KEY = SigningKey(base64.b64decode(os.environ["ROBINHOOD_CRYPTO_PRIVATE_KEY"]))

method = "${method}"
path = "${path}"
body = ${JSON.stringify(bodyLiteral)}

timestamp = int(datetime.datetime.now(tz=datetime.timezone.utc).timestamp())
message = f"{API_KEY}{timestamp}{path}{method}{body}"
signature = base64.b64encode(PRIVATE_KEY.sign(message.encode("utf-8")).signature).decode()

response = requests.request(
    method,
    "https://trading.robinhood.com" + path,
    headers={
        "x-api-key": API_KEY,
        "x-signature": signature,
        "x-timestamp": str(timestamp),
        "Content-Type": "application/json; charset=utf-8",
    },
    data=body or None,
    timeout=10,
)
print(response.status_code, response.json())`;
  }

  if (language === 'typescript') {
    return `import { createPrivateKey, sign } from "node:crypto";

// Robinhood issues a base64 32-byte Ed25519 seed. Node needs it wrapped in
// PKCS#8, which is what this prefix does (RFC 8410).
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(\`\${name} is not set.\`);
  return value;
}

const seed = Buffer.from(requireEnv("ROBINHOOD_CRYPTO_PRIVATE_KEY"), "base64");
if (seed.length !== 32) {
  throw new Error(\`Expected a 32-byte Ed25519 seed, got \${seed.length} bytes.\`);
}

const privateKey = createPrivateKey({
  key: Buffer.concat([PKCS8_PREFIX, seed]),
  format: "der",
  type: "pkcs8",
});

const apiKey = requireEnv("ROBINHOOD_CRYPTO_API_KEY");
const method = "${method}";
const path = "${path}";
const body = ${JSON.stringify(bodyLiteral)};

// Unix SECONDS, not milliseconds: signatures expire after 30 seconds.
const timestamp = Math.floor(Date.now() / 1000);
const message = \`\${apiKey}\${timestamp}\${path}\${method}\${body}\`;
const signature = sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64");

const response = await fetch("https://trading.robinhood.com" + path, {
  method,
  headers: {
    "x-api-key": apiKey,
    "x-signature": signature,
    "x-timestamp": String(timestamp),
    "Content-Type": "application/json; charset=utf-8",
  },
  ${body ? "body," : "// no body for GET"}
});
console.log(response.status, await response.json());`;
  }

  return `# The signature must be computed first; curl cannot do it alone.
# Message format: {api_key}{timestamp}{path}{method}{body}

API_KEY="$ROBINHOOD_CRYPTO_API_KEY"
TIMESTAMP=$(date +%s)
PATH_WITH_QUERY="${path}"
BODY=${JSON.stringify(bodyLiteral)}

# Compute the signature. Ed25519 over {api_key}{timestamp}{path}{method}{body},
# base64-encoded. This one-liner uses the same logic this server signs with:
SIGNATURE=$(node -e '
const {createPrivateKey,sign}=require("node:crypto");
const [key,ts,p,m,b]=process.argv.slice(1);
const seed=Buffer.from(process.env.ROBINHOOD_CRYPTO_PRIVATE_KEY,"base64");
const pk=createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),seed]),format:"der",type:"pkcs8"});
process.stdout.write(sign(null,Buffer.from(key+ts+p+m+b,"utf8"),pk).toString("base64"));
' "$API_KEY" "$TIMESTAMP" "$PATH_WITH_QUERY" "${method}" "$BODY")

curl -X "${method}" "https://trading.robinhood.com$PATH_WITH_QUERY" \\
  -H "x-api-key: $API_KEY" \\
  -H "x-timestamp: $TIMESTAMP" \\
  -H "x-signature: $SIGNATURE" \\
  -H "Content-Type: application/json; charset=utf-8"${body ? ` \\\n  -d "$BODY"` : ''}`;
}
