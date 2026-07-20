/**
 * Tool module contract.
 *
 * A large tool surface hurts an agent rather than helping it: every tool spends
 * context and adds a wrong option to choose from. So tools ship as modules the
 * operator turns on, and only the enabled ones are registered.
 *
 * Set `ROBINHOOD_MCP_MODULES` to a comma-separated list to pick. The default
 * set is deliberately small and execution-focused; the rest is opt-in.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RobinhoodCryptoClient } from '../shared/client.js';
import type { Credentials } from '../shared/config.js';
import type { Executor } from '../shared/executor.js';

export interface ModuleContext {
  server: McpServer;
  client: RobinhoodCryptoClient;
  credentials: Credentials;
  executor: Executor;
}

export interface ToolModule {
  /** Namespace prefix, e.g. `algo`. Tools register as `<name>_<tool>`. */
  name: string;
  /** One line shown by the `list_modules` tool. */
  description: string;
  /** Whether this module loads when ROBINHOOD_MCP_MODULES is unset. */
  enabledByDefault: boolean;
  /** True if any tool here can move money. */
  mutating: boolean;
  register(context: ModuleContext): void;
}

/**
 * Resolve which modules to load.
 *
 * `all` enables everything. An unknown name is an error rather than a silent
 * no-op — a typo that quietly drops tools is worse than a failed startup.
 */
export function selectModules(
  available: ToolModule[],
  raw: string | undefined,
): ToolModule[] {
  const requested = raw?.trim();

  if (!requested) return available.filter((m) => m.enabledByDefault);
  if (requested.toLowerCase() === 'all') return available;

  const names = requested
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const known = new Map(available.map((m) => [m.name.toLowerCase(), m]));
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length) {
    throw new Error(
      `Unknown module(s) in ROBINHOOD_MCP_MODULES: ${unknown.join(', ')}. ` +
        `Available: ${available.map((m) => m.name).join(', ')}, or "all".`,
    );
  }

  return names.map((n) => known.get(n)!);
}
