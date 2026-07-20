/**
 * The synthetic order types this package can execute.
 *
 * Robinhood's API offers market, limit, stop_loss, and stop_limit and nothing
 * else. Everything registered here is built on top of those four primitives by
 * the supervisor, which is why each one needs a durable job rather than a
 * single API call.
 *
 * Adding a strategy: implement `Strategy` in this directory and add it below.
 * The supervisor, the MCP tools, and the daemon all pick it up from this list.
 */

import type { Strategy } from '../job.js';
import { twap } from './twap.js';
import { trailingStop } from './trailing-stop.js';
import { bracket } from './bracket.js';
import { dca } from './dca.js';
import { ladder } from './ladder.js';
import { rebalance } from './rebalance.js';
import { iceberg } from './iceberg.js';
import { oco } from './oco.js';
import { chase } from './chase.js';

export const ALL_STRATEGIES: Strategy[] = [
  twap,
  trailingStop,
  bracket,
  dca,
  ladder,
  rebalance,
  iceberg,
  oco,
  chase,
];

export { twap, trailingStop, bracket, dca, ladder, rebalance, iceberg, oco, chase };
