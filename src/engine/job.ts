/**
 * The job model.
 *
 * A job is one running synthetic order type: a TWAP, a trailing stop, a
 * rebalance. It is the unit the supervisor advances and the unit that survives
 * a restart, so everything a strategy needs to resume must live in its
 * persisted `state` rather than in a closure.
 */

export type JobStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';

/** Terminal statuses never advance again. */
export const TERMINAL_STATUSES: readonly JobStatus[] = ['completed', 'cancelled', 'failed'];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Legal transitions. Enforced in the store so a strategy bug cannot resurrect a
 * cancelled job and start spending again.
 */
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  pending: ['running', 'cancelled', 'failed'],
  running: ['running', 'paused', 'completed', 'cancelled', 'failed'],
  paused: ['running', 'cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: [],
};

export class JobTransitionError extends Error {
  constructor(from: JobStatus, to: JobStatus) {
    super(
      `Illegal job transition ${from} -> ${to}. ` +
        (isTerminal(from)
          ? `${from} is terminal; start a new job instead of reviving this one.`
          : `Legal targets from ${from}: ${TRANSITIONS[from].join(', ') || 'none'}.`),
    );
    this.name = 'JobTransitionError';
  }
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!TRANSITIONS[from].includes(to)) throw new JobTransitionError(from, to);
}

export interface Job {
  id: string;
  /** Strategy name, e.g. `twap`. Selects the `Strategy` that advances it. */
  strategy: string;
  symbol: string;
  status: JobStatus;
  /** Strategy-owned state. Persisted verbatim as JSON; must be serializable. */
  state: Record<string, unknown>;
  /** Original parameters, kept immutable for audit and for `algo_get`. */
  params: Record<string, unknown>;
  /** Epoch ms after which the supervisor should advance this job. */
  nextRunAt: number;
  /** Set when the job stops for a reason worth surfacing. */
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * The lifecycle of one order this package intends to place.
 *
 * The `clientOrderId` is generated and persisted BEFORE the network call, which
 * is what makes crash recovery possible: on restart a `pending` intent is looked
 * up upstream by that id, so a crash between submit and record cannot double-fill.
 *
 * @see docs/architecture.md - "Crash safety"
 */
export type IntentStatus = 'pending' | 'submitted' | 'failed' | 'abandoned';

export interface OrderIntentRecord {
  id: number;
  jobId: string | null;
  clientOrderId: string;
  status: IntentStatus;
  /** The exact wire body, so a resubmit is byte-identical to the original. */
  body: Record<string, unknown>;
  notionalUsd: number | null;
  /** Robinhood's order id, once known. */
  orderId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface JobEvent {
  id: number;
  jobId: string;
  kind: string;
  detail: Record<string, unknown>;
  createdAt: number;
}

/** Actions a strategy can ask the supervisor to take. */
export type StrategyAction =
  | { type: 'submit'; order: import('../shared/executor.js').OrderRequest }
  | { type: 'cancel'; orderId: string }
  | { type: 'log'; kind: string; detail?: Record<string, unknown> };

export interface StrategyStep {
  /** Replaces the job's persisted state. */
  state: Record<string, unknown>;
  /** Orders to place and orders to cancel, executed in listed order. */
  actions: StrategyAction[];
  /** Epoch ms for the next advance. Omit to use the strategy's default cadence. */
  nextRunAt?: number;
  /** Set to finish the job. */
  done?: { status: Extract<JobStatus, 'completed' | 'failed'>; reason?: string };
}

export interface StrategyContext {
  executor: import('../shared/executor.js').Executor;
  /** Epoch ms. Injected rather than read from the clock so steps are testable. */
  now: number;
  /** Live execution-side price for the job's symbol, or null when unavailable. */
  price(symbol: string, side: 'buy' | 'sell'): Promise<number | null>;
  /** Open orders previously placed by this job. */
  openOrders(jobId: string): Promise<Array<Record<string, unknown>>>;
}

export interface Strategy {
  name: string;
  /** One-line description, surfaced by `algo_list_strategies`. */
  description: string;
  /** Default milliseconds between advances when a step does not specify. */
  defaultIntervalMs: number;
  /**
   * Validate and normalize the caller's parameters into initial job state.
   * @throws {Error} With remediation text when parameters are unusable.
   */
  init(params: Record<string, unknown>, ctx: StrategyContext): Promise<{
    state: Record<string, unknown>;
    symbol: string;
  }>;
  /** Advance one step. Must not sleep, loop, or call the network directly. */
  advance(job: Job, ctx: StrategyContext): Promise<StrategyStep>;
}
