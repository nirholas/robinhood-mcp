/**
 * The module catalogue, and the wiring that turns a selection into tools.
 *
 * The toolkit is larger than any one agent should see at once. Loading every
 * capability would spend context on tools the task will never call and give the
 * model more wrong options to choose between, which measurably degrades tool
 * selection. So capabilities ship as modules, the operator picks with
 * `ROBINHOOD_MCP_MODULES`, and only the selected ones are registered.
 *
 * The default set is deliberately small and execution-focused. `all` is for a
 * builder exploring the surface, not for a production agent.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { selectModules, requireExecution, type ModuleContext, type ToolModule } from './module.js';
import { toolResult } from '../shared/format.js';
import { registerDataTools } from '../register-data.js';
import { registerTradingTools } from '../register-trading.js';
import { registerOrderTools } from './orders.js';
import { registerAlgoTools } from './algo.js';

/**
 * Market data, account state, and order history. Read-only, so it is the one
 * module safe to attach to a general-purpose assistant.
 */
const marketModule: ToolModule = {
  name: 'market',
  description: 'Quotes, holdings, account details, trading pairs, and order history. Read-only.',
  enabledByDefault: true,
  mutating: false,
  register(context) {
    registerDataTools(context.server, context.client, context.credentials);
  },
};

/**
 * The four order types Robinhood supports, each as its own tool, plus the
 * generic escape hatch and the policy readout.
 */
const ordersModule: ToolModule = {
  name: 'orders',
  description:
    'Place and cancel real orders: buy/sell market and limit, stop-loss, stop-limit, and the generic place_order.',
  enabledByDefault: true,
  mutating: true,
  register(context) {
    const { executor } = requireExecution(context);
    registerTradingTools(context.server, executor);
    registerOrderTools(context.server, executor);
  },
};

/**
 * The synthetic order types Robinhood does not offer, run as durable jobs that
 * outlive the tool call which started them.
 */
const algoModule: ToolModule = {
  name: 'algo',
  description:
    'Synthetic order types Robinhood lacks (TWAP, trailing stop, bracket, and more), run as durable background jobs.',
  enabledByDefault: true,
  mutating: true,
  register(context) {
    const { engine } = requireExecution(context);
    registerAlgoTools(context.server, engine.store, engine.supervisor, engine.daemonRunning);
  },
};

/** Every module the toolkit knows about, in catalogue order. */
export const ALL_MODULES: ToolModule[] = [marketModule, ordersModule, algoModule];

export interface ApplyModulesOptions {
  /** False on the read-only server, which cannot host order-placing tools. */
  allowMutating: boolean;
  /** Raw `ROBINHOOD_MCP_MODULES` value. */
  requested: string | undefined;
}

/**
 * Register the selected modules and the `list_modules` tool that describes them.
 *
 * @returns The modules that were loaded, for the startup log.
 * @throws {Error} On an unknown module name, or a mutating module requested on
 *   the read-only server. Both are misconfigurations that should stop startup
 *   rather than silently produce a server missing the tools the operator expected.
 */
export function applyModules(
  context: ModuleContext,
  options: ApplyModulesOptions,
): ToolModule[] {
  const selected = selectModules(ALL_MODULES, options.requested, {
    allowMutating: options.allowMutating,
  });

  for (const toolModule of selected) toolModule.register(context);

  registerListModules(context.server, selected, options);

  return selected;
}

/**
 * Let the agent see what it is missing.
 *
 * Without this, a disabled module is indistinguishable from a capability the
 * toolkit does not have, and the agent will confidently tell the user something
 * is impossible when it is one env var away.
 */
function registerListModules(
  server: McpServer,
  loaded: ToolModule[],
  options: ApplyModulesOptions,
): void {
  const loadedNames = new Set(loaded.map((m) => m.name));

  server.registerTool(
    'list_modules',
    {
      title: 'List capability modules',
      description:
        'List which capability modules are loaded and which exist but are switched off. ' +
        'If a capability you need is listed as available but not loaded, tell the user which ' +
        'ROBINHOOD_MCP_MODULES value would enable it rather than reporting it as impossible.',
      inputSchema: {
        include_disabled: z
          .boolean()
          .optional()
          .default(true)
          .describe('Include modules that exist but are not loaded in this server.'),
      },
    },
    async ({ include_disabled }) =>
      toolResult({
        loaded: loaded.map((m) => ({
          name: m.name,
          description: m.description,
          places_orders: m.mutating,
        })),
        ...(include_disabled
          ? {
              available_but_disabled: ALL_MODULES.filter((m) => !loadedNames.has(m.name)).map(
                (m) => ({
                  name: m.name,
                  description: m.description,
                  places_orders: m.mutating,
                  enable_with:
                    m.mutating && !options.allowMutating
                      ? 'Run robinhood-mcp-trading with ROBINHOOD_CRYPTO_ENABLE_TRADING=1.'
                      : `Set ROBINHOOD_MCP_MODULES to include "${m.name}".`,
                }),
              ),
            }
          : {}),
        selection: {
          env: 'ROBINHOOD_MCP_MODULES',
          current: options.requested ?? '(unset: the default set)',
          note:
            'Loading every module at once spends context and degrades tool choice. ' +
            'Enable what the task needs.',
        },
      }),
  );
}
