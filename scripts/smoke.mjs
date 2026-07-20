#!/usr/bin/env node
/**
 * Launch a built server over real stdio and list what it exposes.
 *
 * The unit tests drive an McpServer in-process, which does not prove the
 * published artifact works: a stale `dist/`, a bad bin shebang, or a module
 * that throws during registration all pass the suite and fail a real client.
 * This runs the same handshake an MCP client performs.
 *
 * Credentials are never contacted. A throwaway keypair is generated so the
 * servers can construct, and no tool is called, so nothing reaches Robinhood.
 *
 *   npm run smoke
 *   npm run smoke -- trading      # trading server, every module
 */

import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const which = process.argv[2] ?? 'both';

function throwawayPrivateKey() {
  const result = spawnSync('node', ['dist/bin/keygen.js'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`keygen failed. Run \`npm run build\` first.\n${result.stderr}`);
  }
  return JSON.parse(result.stdout).privateKeyBase64;
}

async function listTools(label, bin, extraEnv) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [bin],
    env: { ...process.env, ...extraEnv },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'smoke', version: '0.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  await client.close();

  console.log(`\n${label}: ${tools.length} tools`);
  for (const name of tools.map((t) => t.name).sort()) console.log(`  ${name}`);
  return tools.length;
}

const privateKey = throwawayPrivateKey();
const base = {
  ROBINHOOD_CRYPTO_API_KEY: 'smoke-test-not-a-real-key',
  ROBINHOOD_CRYPTO_PRIVATE_KEY: privateKey,
};

let failed = false;

try {
  if (which === 'both' || which === 'data') {
    const count = await listTools('data server (read-only)', 'dist/bin/data-server.js', base);
    if (count === 0) throw new Error('data server registered no tools');
  }

  if (which === 'both' || which === 'trading') {
    const count = await listTools('trading server (all modules)', 'dist/bin/trading-server.js', {
      ...base,
      ROBINHOOD_CRYPTO_ENABLE_TRADING: '1',
      ROBINHOOD_MCP_MODULES: 'all',
      // Never touch the operator's real job database.
      ROBINHOOD_MCP_DB: '/tmp/robinhood-mcp-smoke.db',
    });
    if (count === 0) throw new Error('trading server registered no tools');
  }
} catch (error) {
  failed = true;
  console.error(`\nsmoke failed: ${error instanceof Error ? error.message : error}`);
}

process.exit(failed ? 1 : 0);
