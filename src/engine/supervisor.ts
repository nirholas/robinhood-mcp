/**
 * The tick loop that advances jobs, and the reconciliation that makes a
 * restart safe.
 *
 * Strategies are pure step functions: they return the actions they want taken
 * and never sleep, loop, or touch the network. The supervisor is what makes
 * time pass, which is what lets strategies be tested without a live account
 * and resumed without special cases.
 *
 * @see docs/architecture.md - "Crash safety"
 */

import { randomUUID } from 'node:crypto';
import type { Executor } from '../shared/executor.js';
import { buildOrderBody } from '../shared/executor.js';
import type { JobStore } from './store.js';
import { isTerminal, type Job, type Strategy, type StrategyAction, type StrategyContext } from './job.js';

export interface SupervisorOptions {
  /** Milliseconds between ticks. */
  intervalMs?: number;
  /** Max jobs advanced per tick, bounding the work one tick can do. */
  batchSize?: number;
  /** Injected for tests; defaults to the wall clock. */
  now?: () => number;
  /** Surface for operational logging. Defaults to stderr. */
  log?: (message: string) => void;
}

export class Supervisor {
  private readonly strategies = new Map<string, Strategy>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(
    private readonly store: JobStore,
    private readonly executor: Executor,
    strategies: Strategy[],
    options: SupervisorOptions = {},
  ) {
    for (const strategy of strategies) this.strategies.set(strategy.name, strategy);
    this.intervalMs = options.intervalMs ?? 5_000;
    this.batchSize = options.batchSize ?? 25;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((message) => console.error(`[supervisor] ${message}`));
  }

  strategy(name: string): Strategy | undefined {
    return this.strategies.get(name);
  }

  listStrategies(): Strategy[] {
    return [...this.strategies.values()];
  }

  /**
   * Reconcile, then start ticking.
   *
   * Reconciliation runs before any job advances, so a job never executes
   * against stale state.
   */
  async start(): Promise<void> {
    await this.reconcile();
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // Do not hold the process open solely for the tick loop.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Resolve orders that were reserved but never settled.
   *
   * For each `pending` intent, ask Robinhood whether the order exists. Found
   * means the crash happened after submission: adopt it, never resubmit.
   * Not found means Robinhood never saw it, so it is safe to retry later with
   * the same `client_order_id`.
   */
  async reconcile(): Promise<{ adopted: number; released: number; unresolved: number }> {
    const pending = this.store.pendingIntents();
    if (!pending.length) return { adopted: 0, released: 0, unresolved: 0 };

    this.log(`reconciling ${pending.length} unsettled order intent(s)`);
    let adopted = 0;
    let released = 0;
    let unresolved = 0;

    for (const intent of pending) {
      try {
        const lookup = await this.executor.findOrderByClientOrderId(
          intent.clientOrderId,
          intent.createdAt,
        );

        if (lookup.status === 'found') {
          this.store.settleIntent(intent.clientOrderId, {
            status: 'submitted',
            orderId: typeof lookup.order.id === 'string' ? lookup.order.id : null,
          });
          if (intent.jobId) {
            this.store.appendEvent(intent.jobId, 'intent_adopted', {
              clientOrderId: intent.clientOrderId,
              orderId: lookup.order.id ?? null,
            });
          }
          adopted++;
          continue;
        }

        if (lookup.status === 'inconclusive') {
          // The search did not finish. Absence was not proven, so the intent
          // stays pending and is retried on the next reconcile. Abandoning here
          // would let the strategy re-place the order under a fresh
          // client_order_id and fill the same slice twice.
          unresolved++;
          this.log(`unresolved ${intent.clientOrderId}: ${lookup.reason}`);
          if (intent.jobId) {
            this.store.appendEvent(intent.jobId, 'intent_unresolved', {
              clientOrderId: intent.clientOrderId,
              reason: lookup.reason,
            });
          }
          continue;
        }

        // Conclusively absent: Robinhood never saw it. Mark abandoned rather
        // than auto-resubmitting — the strategy decides on its next advance
        // whether the slice is still wanted, since the market has moved.
        this.store.settleIntent(intent.clientOrderId, {
          status: 'abandoned',
          error: 'Not found upstream during reconciliation; never reached Robinhood.',
        });
        if (intent.jobId) {
          this.store.appendEvent(intent.jobId, 'intent_abandoned', {
            clientOrderId: intent.clientOrderId,
          });
        }
        released++;
      } catch (error) {
        // An errored check is also inconclusive: leave it pending.
        unresolved++;
        this.log(
          `could not reconcile ${intent.clientOrderId}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    return { adopted, released, unresolved };
  }

  /** Advance every due job once. Safe to call concurrently; overlaps are skipped. */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;

    try {
      const due = this.store.dueJobs(this.now(), this.batchSize);
      let advanced = 0;
      for (const job of due) {
        await this.advanceJob(job);
        advanced++;
      }
      return advanced;
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Advance one job.
   *
   * A strategy that throws pauses its own job with the reason recorded; it
   * never takes down the supervisor or stalls unrelated jobs.
   */
  async advanceJob(job: Job): Promise<Job> {
    const strategy = this.strategies.get(job.strategy);
    if (!strategy) {
      return this.failJob(job, `Unknown strategy "${job.strategy}".`);
    }
    if (isTerminal(job.status)) return job;

    const context = this.strategyContext();

    let step: Awaited<ReturnType<Strategy['advance']>>;
    try {
      step = await strategy.advance(job, context);
    } catch (error) {
      return this.failJob(job, error instanceof Error ? error.message : String(error));
    }

    // Persist the new state BEFORE acting, so a crash mid-action resumes from
    // the advanced state rather than repeating the whole step.
    let current = this.store.updateJob(job.id, {
      status: job.status === 'pending' ? 'running' : job.status,
      state: step.state,
      nextRunAt: step.nextRunAt ?? this.now() + strategy.defaultIntervalMs,
      lastError: null,
    });

    for (const action of step.actions) {
      try {
        await this.performAction(current, action);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.appendEvent(current.id, 'action_failed', { action: action.type, error: message });
        // A rejected order (cap, allowlist) is information for the strategy,
        // not a reason to kill a job that may still have valid work left.
        current = this.store.updateJob(current.id, { lastError: message });
      }
    }

    if (step.done) {
      current = this.store.updateJob(current.id, {
        status: step.done.status,
        lastError: step.done.reason ?? null,
      });
      this.store.appendEvent(current.id, 'job_finished', {
        status: step.done.status,
        reason: step.done.reason ?? null,
      });
    }

    return current;
  }

  /** Build the context a strategy sees. Public so `algo_start` can call init(). */
  strategyContext(): StrategyContext {
    return {
      executor: this.executor,
      now: this.now(),
      price: (symbol, side) => this.executor.referencePrice(symbol, side),
      openOrders: async (jobId) => {
        const intents = this.store.intentsForJob(jobId);
        const ids = new Set(
          intents.filter((i) => i.status === 'submitted' && i.orderId).map((i) => i.orderId),
        );
        if (!ids.size) return [];
        const orders = await this.executor.orders({ state: 'open' });
        return orders.filter((order) => ids.has(String(order.id)));
      },
    };
  }

  /** Execute one strategy action through the reserve/submit/settle protocol. */
  private async performAction(job: Job, action: StrategyAction): Promise<void> {
    switch (action.type) {
      case 'log':
        this.store.appendEvent(job.id, action.kind, action.detail ?? {});
        return;

      case 'cancel': {
        await this.executor.cancelOrder(action.orderId);
        this.store.appendEvent(job.id, 'order_cancelled', { orderId: action.orderId });
        return;
      }

      case 'submit': {
        // Reserve first: the id must exist on disk before the network call.
        const clientOrderId = action.order.clientOrderId ?? randomUUID();
        const request = { ...action.order, clientOrderId };

        const priced = await this.executor.price(request);
        this.executor.assertAllowed(priced);

        this.store.reserveIntent({
          jobId: job.id,
          clientOrderId,
          body: buildOrderBody(request),
          notionalUsd: priced.notionalUsd,
        });

        try {
          const result = await this.executor.submitOrder(request, true);
          const order = result.order as Record<string, unknown> | undefined;
          this.store.settleIntent(clientOrderId, {
            status: 'submitted',
            orderId: typeof order?.id === 'string' ? order.id : null,
          });
          this.store.appendEvent(job.id, 'order_submitted', {
            clientOrderId,
            orderId: order?.id ?? null,
            notionalUsd: priced.notionalUsd,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.store.settleIntent(clientOrderId, { status: 'failed', error: message });
          throw error;
        }
        return;
      }
    }
  }

  private failJob(job: Job, reason: string): Job {
    this.store.appendEvent(job.id, 'job_failed', { reason });
    return this.store.updateJob(job.id, { status: 'failed', lastError: reason });
  }
}
