/**
 * Tools for the synthetic order types.
 *
 * These tools do not execute an algorithm inside the call. They enqueue a
 * durable job and return, and the supervisor owns execution from then on.
 * That is what lets a TWAP outlive the tool call that started it.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JobStore } from '../engine/store.js';
import type { Supervisor } from '../engine/supervisor.js';
import { isTerminal } from '../engine/job.js';
import { toolResult, toolError } from '../shared/format.js';

export function registerAlgoTools(
  server: McpServer,
  store: JobStore,
  supervisor: Supervisor,
  daemonRunning: () => boolean,
): void {
  server.registerTool(
    'algo_list_strategies',
    {
      title: 'List execution strategies',
      description:
        'List the synthetic order types this server can run (TWAP, trailing stop, bracket, and so on), with the parameters each takes. Robinhood natively supports only market, limit, stop_loss, and stop_limit; everything here is built on top of those.',
      inputSchema: {},
    },
    async () => {
      try {
        return toolResult({
          strategies: supervisor.listStrategies().map((s) => ({
            name: s.name,
            description: s.description,
            default_interval_seconds: s.defaultIntervalMs / 1_000,
          })),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'algo_start',
    {
      title: 'Start an execution job',
      description:
        'Start a synthetic order type as a durable background job. THIS SPENDS REAL MONEY over time, not just once: the job keeps placing orders until it completes or is cancelled. Call algo_list_strategies first to see the parameters a strategy needs. The job survives this conversation, so cancel it explicitly when it is no longer wanted.',
      inputSchema: {
        strategy: z.string().min(1).describe('Strategy name, e.g. "twap".'),
        params: z
          .record(z.unknown())
          .describe('Strategy parameters. See algo_list_strategies for what each one requires.'),
      },
    },
    async ({ strategy, params }) => {
      try {
        const impl = supervisor.strategy(strategy);
        if (!impl) {
          const names = supervisor.listStrategies().map((s) => s.name).join(', ');
          throw new Error(`Unknown strategy "${strategy}". Available: ${names}.`);
        }

        const context = supervisor.strategyContext();
        const { state, symbol } = await impl.init(params, context);

        const job = store.createJob({
          strategy,
          symbol,
          state,
          params,
          nextRunAt: Date.now(),
        });
        store.appendEvent(job.id, 'job_created', { strategy, params });

        return toolResult({
          started: true,
          job_id: job.id,
          strategy,
          symbol,
          state,
          execution_note: daemonRunning()
            ? 'A supervisor is running in this process and will advance the job.'
            : 'No always-on daemon detected. This job advances only while an MCP server or the `robinhood-mcp-daemon` process is running. Start the daemon for unattended execution.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'algo_list_jobs',
    {
      title: 'List execution jobs',
      description:
        'List execution jobs and their progress. Use this to see what is currently running against the account before starting something new.',
      inputSchema: {
        status: z
          .enum(['pending', 'running', 'paused', 'completed', 'cancelled', 'failed'])
          .optional(),
        strategy: z.string().optional(),
        symbol: z.string().optional(),
      },
    },
    async (filter) => {
      try {
        const jobs = store.listJobs(filter);
        return toolResult({
          count: jobs.length,
          jobs: jobs.map(summarize),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'algo_get_job',
    {
      title: 'Get execution job',
      description:
        'Fetch one job with its full state, the orders it has placed, and its event history. Use this to explain to a user exactly what an algorithm has done so far.',
      inputSchema: {
        job_id: z.string().min(1),
        event_limit: z.number().int().positive().max(500).optional().default(50),
      },
    },
    async ({ job_id, event_limit }) => {
      try {
        const job = store.getJob(job_id);
        if (!job) throw new Error(`No such job: ${job_id}`);

        return toolResult({
          job: summarize(job),
          state: job.state,
          params: job.params,
          orders: store.intentsForJob(job_id).map((intent) => ({
            client_order_id: intent.clientOrderId,
            status: intent.status,
            order_id: intent.orderId,
            notional_usd: intent.notionalUsd,
            error: intent.error,
            created_at: new Date(intent.createdAt).toISOString(),
          })),
          events: store.events(job_id, event_limit).map((event) => ({
            kind: event.kind,
            detail: event.detail,
            at: new Date(event.createdAt).toISOString(),
          })),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'algo_cancel_job',
    {
      title: 'Cancel an execution job',
      description:
        'Stop a running job so it places no further orders. This does NOT cancel orders already resting on the book: use cancel_order for those, which algo_get_job lists by id.',
      inputSchema: { job_id: z.string().min(1) },
    },
    async ({ job_id }) => {
      try {
        const job = store.getJob(job_id);
        if (!job) throw new Error(`No such job: ${job_id}`);
        if (isTerminal(job.status)) {
          return toolResult({
            cancelled: false,
            job_id,
            status: job.status,
            message: `Job is already ${job.status}; nothing to cancel.`,
          });
        }

        const updated = store.updateJob(job_id, { status: 'cancelled' });
        store.appendEvent(job_id, 'job_cancelled', {});

        const resting = store
          .intentsForJob(job_id)
          .filter((i) => i.status === 'submitted' && i.orderId)
          .map((i) => i.orderId);

        return toolResult({
          cancelled: true,
          job_id,
          status: updated.status,
          resting_orders: resting,
          note: resting.length
            ? 'These orders may still be live on the book. Cancel them individually with cancel_order if that is what you want.'
            : 'No orders from this job are recorded as live.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

function summarize(job: {
  id: string;
  strategy: string;
  symbol: string;
  status: string;
  lastError: string | null;
  nextRunAt: number;
  createdAt: number;
  updatedAt: number;
}) {
  return {
    id: job.id,
    strategy: job.strategy,
    symbol: job.symbol,
    status: job.status,
    last_error: job.lastError,
    next_run_at: new Date(job.nextRunAt).toISOString(),
    created_at: new Date(job.createdAt).toISOString(),
    updated_at: new Date(job.updatedAt).toISOString(),
  };
}
