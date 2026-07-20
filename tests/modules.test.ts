/**
 * Module selection.
 *
 * The selection layer decides which tools exist, which makes it the thing
 * standing between a read-only deployment and one that can spend money. Its
 * failure modes must be loud: an unknown name and a trading module on the
 * read-only server both stop startup rather than quietly producing a server
 * that is missing what the operator thought they enabled.
 */

import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { selectModules, type ToolModule } from '../src/tools/module.js';
import { ALL_MODULES, applyModules } from '../src/tools/registry.js';
import { Executor } from '../src/shared/executor.js';
import { JobStore } from '../src/engine/store.js';
import { Supervisor } from '../src/engine/supervisor.js';
import { ALL_STRATEGIES } from '../src/engine/strategies/index.js';
import { SpendLedger, type ExecutionPolicy } from '../src/shared/execution-mode.js';
import type { RobinhoodCryptoClient } from '../src/shared/client.js';
import type { Credentials } from '../src/shared/config.js';

const readOnly: ToolModule = {
  name: 'reader',
  description: 'read',
  enabledByDefault: true,
  mutating: false,
  register() {},
};

const writer: ToolModule = {
  name: 'writer',
  description: 'write',
  enabledByDefault: false,
  mutating: true,
  register() {},
};

const available = [readOnly, writer];

describe('selectModules', () => {
  it('loads only the default set when unset', () => {
    expect(selectModules(available, undefined).map((m) => m.name)).toEqual(['reader']);
  });

  it('loads everything for "all"', () => {
    expect(selectModules(available, 'all').map((m) => m.name)).toEqual(['reader', 'writer']);
  });

  it('honours an explicit list, including non-default modules', () => {
    expect(selectModules(available, 'writer').map((m) => m.name)).toEqual(['writer']);
  });

  it('tolerates whitespace and casing', () => {
    expect(selectModules(available, ' Reader , WRITER ').map((m) => m.name)).toEqual([
      'reader',
      'writer',
    ]);
  });

  it('throws on an unknown name rather than dropping it', () => {
    // A typo that silently removes tools is worse than a failed startup.
    expect(() => selectModules(available, 'reader,typo')).toThrow(/typo/);
  });

  it('excludes mutating modules from the default set when they are not allowed', () => {
    const mutatingDefault: ToolModule = { ...writer, enabledByDefault: true };
    const names = selectModules([readOnly, mutatingDefault], undefined, {
      allowMutating: false,
    }).map((m) => m.name);

    expect(names).toEqual(['reader']);
  });

  it('excludes mutating modules from "all" when they are not allowed', () => {
    const names = selectModules(available, 'all', { allowMutating: false }).map((m) => m.name);
    expect(names).toEqual(['reader']);
  });

  it('refuses an explicitly requested mutating module when they are not allowed', () => {
    // Silently dropping it would leave the operator believing trading was on.
    expect(() => selectModules(available, 'writer', { allowMutating: false })).toThrow(
      /not available on the read-only server/,
    );
  });
});

class FakeClient {
  async get(): Promise<unknown> {
    return { results: [] };
  }
  async post(): Promise<unknown> {
    return {};
  }
  async getAllPages(): Promise<{ results: unknown[]; truncated: boolean }> {
    return { results: [], truncated: false };
  }
}

const credentials = { apiVersion: 'v1' } as Credentials;
const policy: ExecutionPolicy = {
  mode: 'guarded',
  maxOrderUsd: 100,
  maxDailyUsd: null,
  symbolAllowlist: null,
  buyOnly: false,
};

async function connect(build: (server: McpServer) => void) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  build(server);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

function tradingContext(server: McpServer) {
  const fake = new FakeClient() as unknown as RobinhoodCryptoClient;
  const executor = new Executor(fake, credentials, policy, new SpendLedger(policy));
  const store = new JobStore(':memory:');
  return {
    server,
    client: fake,
    credentials,
    executor,
    engine: {
      store,
      supervisor: new Supervisor(store, executor, ALL_STRATEGIES),
      daemonRunning: () => false,
    },
  };
}

describe('applyModules', () => {
  it('registers no order-placing tool on the read-only server', async () => {
    const client = await connect((server) => {
      applyModules(
        { server, client: new FakeClient() as unknown as RobinhoodCryptoClient, credentials },
        { allowMutating: false, requested: undefined },
      );
    });

    const names = (await client.listTools()).tools.map((t) => t.name);

    for (const forbidden of ['place_order', 'buy_market', 'sell_market', 'algo_start']) {
      expect(names).not.toContain(forbidden);
    }
    expect(names).toContain('get_best_bid_ask');
    expect(names).toContain('list_modules');
  });

  it('registers order-placing tools on the trading server', async () => {
    const client = await connect((server) => {
      applyModules(tradingContext(server), { allowMutating: true, requested: undefined });
    });

    const names = (await client.listTools()).tools.map((t) => t.name);

    expect(names).toContain('buy_market');
    expect(names).toContain('place_order');
    expect(names).toContain('algo_start');
  });

  it('registers only the requested module', async () => {
    const client = await connect((server) => {
      applyModules(tradingContext(server), { allowMutating: true, requested: 'market' });
    });

    const names = (await client.listTools()).tools.map((t) => t.name);

    expect(names).toContain('get_best_bid_ask');
    expect(names).not.toContain('buy_market');
    expect(names).not.toContain('algo_start');
  });

  it('reports disabled modules and how to enable them', async () => {
    // An agent that cannot see a disabled module will report the capability as
    // impossible rather than as one env var away.
    const client = await connect((server) => {
      applyModules(tradingContext(server), { allowMutating: true, requested: 'market' });
    });

    const result = await client.callTool({ name: 'list_modules', arguments: {} });
    const body = JSON.parse(
      (result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as {
      loaded: Array<{ name: string }>;
      available_but_disabled: Array<{ name: string; enable_with: string }>;
    };

    expect(body.loaded.map((m) => m.name)).toEqual(['market']);
    const disabled = body.available_but_disabled.map((m) => m.name);
    expect(disabled).toContain('orders');
    expect(disabled).toContain('algo');
    expect(body.available_but_disabled[0]!.enable_with).toMatch(/ROBINHOOD_MCP_MODULES/);
  });

  it('tells a read-only operator that trading needs the other server', async () => {
    const client = await connect((server) => {
      applyModules(
        { server, client: new FakeClient() as unknown as RobinhoodCryptoClient, credentials },
        { allowMutating: false, requested: undefined },
      );
    });

    const result = await client.callTool({ name: 'list_modules', arguments: {} });
    const body = JSON.parse(
      (result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { available_but_disabled: Array<{ name: string; enable_with: string }> };

    const orders = body.available_but_disabled.find((m) => m.name === 'orders')!;
    expect(orders.enable_with).toMatch(/robinhood-mcp-trading/);
  });

  it('keeps every catalogue module uniquely named', () => {
    const names = ALL_MODULES.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
