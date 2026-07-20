# Architecture

`robinhood-mcp` is an execution toolkit for the Robinhood Crypto Trading API, delivered
over MCP. This document explains what it is, why it is shaped the way it is, and where
to add code.

## The problem this solves

Robinhood's Crypto Trading API exposes four order types and nothing else:

| Primitive | Supported |
|---|---|
| `market` | yes |
| `limit` | yes |
| `stop_loss` | yes |
| `stop_limit` | yes |

There is no bracket order. No OCO. No trailing stop. No TWAP, no iceberg, no
scale-in ladder, no scheduled DCA, no portfolio rebalance. Those are the order types
people actually want, and every one of them has the same requirement: **something has
to keep working after the request returns.** A trailing stop that only exists for the
duration of one tool call is not a trailing stop.

That is the gap this package fills. It is not a wrapper around the four primitives; it
is a supervised execution engine that synthesizes the missing order types on top of
them, and exposes that engine to an agent over MCP.

## Non-negotiable constraints

Three facts about the upstream API drive most of the design.

**1. There is no sandbox.** Robinhood documents no paper or test environment for the
crypto API. Every order this package can place is real money in a real account. Guards
are therefore enforced in code, never in a tool description, because an instruction in
a prompt is a suggestion and a thrown error is not.

**2. Writes must never be retried blindly.** Retrying an ambiguous POST can double-fill.
Every write path passes `maxRetries: 0`, and durability is achieved by recording intent
before submitting rather than by retrying after failing.

**3. `client_order_id` is a required UUID.** This is the only idempotency handle the API
gives us, and it is what makes crash-safe execution possible at all. See *Crash safety*
below.

## Layers

```
                 MCP tools  (modular, opt-in)
                     |
                 Executor   <-- single choke point, every order passes here
                     |
        ExecutionPolicy + SpendLedger   <-- caps, allowlist, kill switch
                     |
         RobinhoodCryptoClient  <-- Ed25519 signing, token bucket, pagination
                     |
              trading.robinhood.com
```

Above the Executor sits the piece that makes synthetic order types possible:

```
   MCP tool ("start a TWAP")  -->  JobStore (durable, SQLite)
                                        ^
                                        |
                                   Supervisor  -->  Strategy.advance()  -->  Executor
                                   (tick loop)
```

A tool call does not execute an algorithm. It **enqueues a job** and returns. The
supervisor owns execution from then on, and the job survives the agent disconnecting,
the MCP server restarting, and the machine rebooting.

### `shared/executor.ts` — the choke point

Every order in the package reaches Robinhood through `Executor.submitOrder`. Direct
order tools and multi-leg algorithms both go through it, so a spend cap or allowlist
cannot be bypassed by reaching for a different tool. Strategies compose the Executor;
they never touch the HTTP client.

This is load-bearing. A new mutating tool that calls `client.post` directly is a bug,
not a shortcut.

### `shared/kill-switch.ts` — the emergency stop

Durable state in the job database, read from disk on **every** order and never cached,
checked inside `Executor` rather than by any tool.

That placement is the whole design, and it was got wrong once. The switch was first
enforced by the risk tool module shadowing `Executor.submitOrder` at registration time.
That covers every caller inside an MCP session and misses the one that matters most:
`robinhood-mcp-daemon` builds its own `Executor` and loads no tool modules, so the guard
was never installed there. An operator could engage the switch, see it report `engaged`,
and have the daemon keep slicing a TWAP unattended.

A safety control has to live below everything it protects. Because it is an `Executor`
dependency, a halt binds order tools, strategies, the daemon, and anything added later,
without each having to remember to ask. Because it is read from disk rather than memory,
engaging it from an MCP session stops a daemon that has been running since before the
switch was thrown.

It fails closed: a row that cannot be parsed reads as engaged. Resuming trading because
a row got corrupted is exactly the failure a kill switch exists to prevent.

### `shared/execution-mode.ts` — how much confirmation sits in front of an order

`guarded` (default) returns a priced preview on the first call and executes on a second
call carrying `confirm: true`. `autonomous` executes immediately, for unattended
strategies where no human is in the loop.

The spend cap applies in **both** modes. Autonomous removes the human, not the ceiling.
An unattended agent is exactly the case where a runaway order is most likely and least
observed.

### `engine/` — durable jobs and the supervisor

- `store.ts` — SQLite (`node:sqlite`) persistence for jobs, legs, intents and events.
- `job.ts` — the job model and its state machine.
- `supervisor.ts` — the tick loop that advances due jobs.
- `strategies/` — one file per synthetic order type.

### `tools/` — modular tool surface

A large tool surface hurts an agent rather than helping it: every tool spends context
and adds a wrong option to choose from. So the toolkit ships >100 capabilities as
**modules the operator turns on**, and only the enabled ones are registered.

`ROBINHOOD_MCP_MODULES=market,orders,algo` selects them. Unset loads a deliberately small
default set. `all` loads everything, which is useful for a builder exploring the surface
and a poor choice for a production agent.

| Module | Default | Places orders | What it covers |
|---|---|---|---|
| `market` | on | no | Quotes, holdings, account, trading pairs, order history |
| `orders` | on | **yes** | The four primitives, each as its own tool, plus `place_order` |
| `algo` | on | **yes** | The synthetic order types, as durable jobs |
| `portfolio` | on | no | Cost basis, realized P&L, tax lots, allocation, slippage, volatility |
| `risk` | on | **yes** | Exposure, drawdown, pre-trade checks, the kill switch |
| `journal` | off | no | Fills, round trips, win rate, daily summaries, CSV export |
| `ops` | off | no | Health, clock skew, key check, rate limit, supervisor status |
| `dev` | off | no | Keypair generation, signature explanation, client code generation |

Two rules the registry enforces at startup rather than silently:

- An unknown module name is an error. A typo that quietly drops tools is worse than a
  failed start.
- A mutating module requested on the read-only server is an error, not an omission.
  Dropping it would leave an operator believing they had enabled execution when they had
  not.

`list_modules` reports what is loaded **and** what exists but is switched off, with the
env var that would enable it. Without that, a disabled module is indistinguishable from a
capability the toolkit lacks, and the agent tells the user something is impossible when
it is one variable away.

## Crash safety

This is the part that has to be right, because getting it wrong means double-filling a
real order with real money.

The naive design submits an order and records it afterwards. If the process dies between
those two steps, the order exists at Robinhood and the job has no memory of it. On
restart the strategy repeats the slice, and the user is filled twice.

Instead, every order follows a three-phase write:

1. **Reserve.** Generate the `client_order_id` and write an `intent` row *before* any
   network call, inside a transaction with the job's state advance. Status `pending`.
2. **Submit.** POST with that exact `client_order_id`, `maxRetries: 0`.
3. **Settle.** Record the response and mark the intent `submitted` (or `failed`).

On startup, the supervisor runs **reconciliation**: for every intent still `pending`, it
asks Robinhood whether an order with that `client_order_id` exists. The answer has
**three** states, and keeping them distinct is the whole point:

- **Found** → the order was placed before the crash. Mark `submitted`, adopt the
  upstream order, never resubmit.
- **Conclusively not found** → Robinhood never saw it. Mark `abandoned`. The strategy
  decides on its next advance whether the slice is still wanted, since the market has
  moved since the crash.
- **Inconclusive** → the search did not complete (page ceiling hit, or the request
  errored). The intent stays `pending` and is retried next reconcile.

The third state is not defensive padding. Robinhood has **no `client_order_id` query
filter**, so the lookup is a bounded walk of order history. Collapsing "I did not finish
looking" into "it does not exist" would abandon an intent whose order is live, and the
strategy would then re-place that slice under a fresh `client_order_id` — a double fill
with real money. `Executor.findOrderByClientOrderId` bounds the walk by the intent's own
`created_at` so it terminates conclusively in the normal case, and reports
`inconclusive` rather than guessing when it cannot.

Reconciliation runs before any strategy advances. A job never executes against stale
state.

## Adding a strategy

A strategy is a pure step function over persisted state. It receives the job and a
context, and returns the actions it wants taken. It does not sleep, does not loop, and
does not call the network directly; the supervisor is what makes time pass. This is what
makes strategies testable without a live account and restartable without special cases.

```ts
export const twap: Strategy = {
  name: 'twap',
  advance(job, ctx) { /* return actions, or `done` */ },
};
```

See `engine/strategies/` for the implemented set.

## Testing posture

`npm test` runs unit and integration tests with no credentials and no network. The live
suite (`npm run test:live`) is opt-in, read-only, and skipped without credentials, per
`vitest.live.config.ts`.

Strategy math, policy enforcement, and reconciliation logic are all tested against the
store directly, using an in-memory database. There is no mocked Robinhood: the tests
exercise real code paths against a real SQLite store, and the network boundary is the
only thing substituted.

## What this package deliberately does not do

- **No equities or options.** This is the crypto API. Robinhood's agentic trading
  product (`agent.robinhood.com/mcp/trading`) is a separate, equities-only surface with
  its own OAuth flow; it is not wrapped here.
- **No private-API scraping.** Several community servers drive Robinhood through a
  browser session or the unauthenticated internal API. This package uses only the
  documented, signed, supported API.
- **No vendored OpenAPI spec.** `scripts/fetch-spec.mjs` pulls it live, because a
  vendored copy goes stale silently.
