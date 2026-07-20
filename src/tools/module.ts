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
import type { JobStore } from '../engine/store.js';
import type { Supervisor } from '../engine/supervisor.js';

/** Durable-job machinery. Only the trading server builds one. */
export interface EngineContext {
  store: JobStore;
  supervisor: Supervisor;
  daemonRunning: () => boolean;
}

/**
 * What a module gets to register with.
 *
 * `executor` and `engine` are absent on the read-only server, which builds
 * neither. A module that needs them declares `mutating: true`, and the
 * read-only server refuses to load such a module at all, so the optionality
 * never has to be re-checked inside a handler.
 */
export interface ModuleContext {
  server: McpServer;
  client: RobinhoodCryptoClient;
  credentials: Credentials;
  executor?: Executor;
  engine?: EngineContext;
}

/**
 * Narrow a context for a mutating module.
 *
 * @throws {Error} If the server did not supply execution machinery. This is a
 *   wiring bug, not a user error: `selectModules` should already have excluded
 *   the module.
 */
export function requireExecution(context: ModuleContext): {
  executor: Executor;
  engine: EngineContext;
} {
  if (!context.executor || !context.engine) {
    throw new Error(
      'A mutating module was registered on a server without execution machinery. ' +
        'Mutating modules belong on robinhood-mcp-trading only.',
    );
  }
  return { executor: context.executor, engine: context.engine };
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
  options: { allowMutating?: boolean } = {},
): ToolModule[] {
  const allowMutating = options.allowMutating ?? true;
  const requested = raw?.trim();

  const permitted = allowMutating ? available : available.filter((m) => !m.mutating);

  if (!requested) return permitted.filter((m) => m.enabledByDefault);
  if (requested.toLowerCase() === 'all') return permitted;

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

  const selected = names.map((n) => known.get(n)!);

  // Asking the read-only server for a trading module is a misconfiguration
  // worth failing on. Silently dropping it would leave an operator believing
  // they had enabled execution when they had not.
  if (!allowMutating) {
    const refused = selected.filter((m) => m.mutating).map((m) => m.name);
    if (refused.length) {
      throw new Error(
        `Module(s) ${refused.join(', ')} can place orders and are not available on the ` +
          'read-only server. Run robinhood-mcp-trading (with ROBINHOOD_CRYPTO_ENABLE_TRADING=1) ' +
          'to use them, or remove them from ROBINHOOD_MCP_MODULES.',
      );
    }
  }

  return selected;
}
