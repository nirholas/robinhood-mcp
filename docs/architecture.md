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

`ROBINHOOD_MCP_MODULES=core,algo,risk` selects them. Unset loads a deliberately small
default set. `all` loads everything, which is useful for a builder exploring the surface
and a poor choice for a production agent.

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
queries the orders endpoint and matches by `client_order_id`.

- Found upstream → the order was placed before the crash. Mark `submitted`, adopt the
  upstream order, do not resubmit.
- Not found → the crash happened before Robinhood saw it. Safe to resubmit, and it
  resubmits with the *same* `client_order_id`, so a duplicate that was in flight is
  rejected by Robinhood rather than filled twice.

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
