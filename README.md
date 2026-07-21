# robinhood-mcp

An execution toolkit for the **official Robinhood Crypto Trading API**, delivered over the Model Context Protocol.

Robinhood's crypto API exposes four order types and nothing else: `market`, `limit`, `stop_loss`, and `stop_limit`. There is no bracket, no OCO, no trailing stop, no TWAP, no iceberg, no scale-in ladder, no scheduled DCA, no portfolio rebalance. Those are the order types people actually want, and every one of them has the same requirement: something has to keep working after the request returns. A trailing stop that exists only for the duration of one tool call is not a trailing stop. This package synthesizes the thirteen order types Robinhood lacks and runs them as **durable background jobs** that survive the agent disconnecting, the server restarting, and the machine rebooting. Around that sit ~73 tools across 8 opt-in modules: quotes and holdings, FIFO cost basis and realized P&L, a trade journal, risk limits with an enforced kill switch, and integration diagnostics.

> **This is not Robinhood Chain**, and it is not Robinhood equities. It targets the brokerage Crypto Trading API at `trading.robinhood.com`, documented at [docs.robinhood.com/crypto/trading](https://docs.robinhood.com/crypto/trading/).

---

## The signing bench — [nirholas.github.io/robinhood-mcp](https://nirholas.github.io/robinhood-mcp/)

The project site is an interactive **Ed25519 signing bench**. You assemble a real Robinhood trading request and produce a genuine signature in your own browser — the math runs client-side on Robinhood's published example key, nothing is sent anywhere — then watch it disprove Robinhood's own documentation: their published test vector verifies against a Python `dict` repr, not the JSON body every client actually sends. It is a single self-contained page in [`docs/`](docs/), so it deploys anywhere static.

Deploy your own copy in one click:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nirholas/robinhood-mcp)
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/nirholas/robinhood-mcp)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/nirholas/robinhood-mcp&project-name=robinhood-mcp&output-directory=docs)

| Target | How |
| --- | --- |
| **GitHub Pages** | Settings → Pages → Source: `main` / `/docs`. Serves at `nirholas.github.io/robinhood-mcp/`. No build step. |
| **Cloudflare Pages** | The button above, or `wrangler pages deploy docs`. Config in [`wrangler.toml`](wrangler.toml). |
| **Google Cloud** | `gcloud storage cp -r docs/* gs://<bucket>/` behind an HTTPS load balancer, or Cloud Run with any static server rooted at `docs/`. |
| **Netlify / Vercel** | The buttons above. Publish directory is `docs/` ([`netlify.toml`](netlify.toml), [`vercel.json`](vercel.json)). |

---

## Safety

**Robinhood publishes no sandbox.** There is no paper account, no test environment, no dry-run host. Every order this package can place is real money in a real brokerage account, and there is no way to rehearse. Read this section before you set `ROBINHOOD_CRYPTO_ENABLE_TRADING=1`.

Every guard below is enforced **in code**, inside the single `Executor` that all orders pass through, never in a tool description. An instruction in a prompt is a suggestion; a thrown error is not.

| Guard | What it does |
| --- | --- |
| **Separate binary** | The `robinhood-mcp` data server registers no tool that can trade. Attaching it to a general-purpose assistant cannot result in an order. |
| **Explicit opt-in** | The trading server and the daemon refuse to start unless `ROBINHOOD_CRYPTO_ENABLE_TRADING=1`. It cannot be launched by accident. |
| **Per-order USD cap** | Every order is priced before submission and rejected above `ROBINHOOD_CRYPTO_MAX_ORDER_USD` (default `$100`). It **fails closed**: if the USD value cannot be determined up front, the order is rejected rather than assumed cheap. |
| **Cumulative USD cap** | `ROBINHOOD_CRYPTO_MAX_DAILY_USD` refuses once the process has committed that much in total. |
| **Symbol allowlist** | With `ROBINHOOD_CRYPTO_SYMBOL_ALLOWLIST` set, only those pairs may trade. Everything else is refused. |
| **Buy-only** | `ROBINHOOD_CRYPTO_BUY_ONLY=1` rejects every sell order. |
| **Guarded vs autonomous** | In the default `guarded` mode an order tool returns the exact request it *would* send plus a priced estimate, and places nothing until a second call carries `confirm: true`. `ROBINHOOD_CRYPTO_AUTONOMOUS=1` skips that gate for unattended strategies. |
| **Kill switch** | `risk_kill_switch_engage` halts all execution and pauses every running job. Persisted to disk, read on every order and never cached, checked inside the `Executor`. |

Two things about those controls are worth stating plainly, because they are the ones people get wrong.

**Autonomous removes the human, not the ceiling.** The per-order cap, the cumulative cap, the allowlist and the buy-only flag all still apply in autonomous mode. An unattended agent is exactly the case where a runaway order is most likely and least observed.

**The kill switch binds the daemon too.** It lives beside the `Executor` rather than inside the risk tool module, because `robinhood-mcp-daemon` builds its own `Executor` and loads no tool modules at all. A halt installed by a module would leave the one unattended process in the system still placing orders. Because the state is read from disk on every order rather than cached, throwing the switch from an MCP session stops a daemon that has been running since before the switch existed. It fails closed: a row that cannot be parsed reads as *engaged*, because resuming trading over a corrupted row is exactly the failure a kill switch exists to prevent.

Two limits are honest about what they are not. The cumulative cap is a **per-process, in-memory** counter that resets on restart: it is a runaway-loop brake, not an accounting system or a hard budget. And **a durable job's total spend is not capped** at all. Per-order caps apply to each order a job places, but a TWAP with 50 slices under a $100 per-order cap can commit $5,000. Size jobs deliberately and check `risk_status` before starting anything unattended.

Finally, scope the API key itself. Robinhood lets you pick permissions per credential: if you only want reads, do not grant order placement, and the key cannot trade no matter what software holds it. IP allowlisting is also available and worth using.

---

## Install

Requires Node.js **22.5 or newer** (the durable job store uses `node:sqlite`).

Nothing to install ahead of time: MCP clients launch the servers with `npx`.

### 1. Create a credential

```bash
npx robinhood-keygen
```

This prints a fresh Ed25519 keypair as JSON on stdout, with instructions on stderr. Then:

1. Register the **public** key at [robinhood.com/account/crypto](https://robinhood.com/account/crypto). This page exists on **web classic only**, not the mobile app and not the new web UI.
2. Robinhood issues an API key in return. That is `ROBINHOOD_CRYPTO_API_KEY`.
3. Keep the private key as `ROBINHOOD_CRYPTO_PRIVATE_KEY`. It is a **base64-encoded 32-byte Ed25519 seed**, not a 64-byte expanded keypair and not PKCS#8. Several Ed25519 libraries export `seed‖publicKey`; pasting that gives 64 bytes and fails every request. Treat the private key like a password: it authorizes trades, and this package never stores or transmits it anywhere except in the signature it computes locally.

If you already have a keypair from elsewhere, `verify_keypair` (in the `dev` module) checks that a private key matches the public key you registered, without sending anything anywhere.

### 2. Add the server to your MCP client

Two binaries ship in the package, and they are separate on purpose.

| Server | Binary | What it can do |
| --- | --- | --- |
| Data | `robinhood-mcp` | Quotes, holdings, account, order history, cost basis, P&L. **Cannot place an order.** |
| Trading | `robinhood-mcp-trading` | Everything above, plus real orders, synthetic order types, and risk controls. |

**Read-only.** This is the one to start with, and the one to attach to a general-purpose assistant. Paste into `claude_desktop_config.json` (Claude Desktop), `.mcp.json` (Claude Code), or your client's equivalent:

```json
{
  "mcpServers": {
    "robinhood-crypto": {
      "command": "npx",
      "args": ["-y", "robinhood-mcp"],
      "env": {
        "ROBINHOOD_CRYPTO_API_KEY": "rh-api-...",
        "ROBINHOOD_CRYPTO_PRIVATE_KEY": "your-base64-seed"
      }
    }
  }
}
```

Ask your assistant: *"What is my Robinhood crypto buying power, and what is BTC trading at?"*

**Trading.** A separate entry, because it places real orders:

```json
{
  "mcpServers": {
    "robinhood-crypto-trading": {
      "command": "npx",
      "args": ["-y", "robinhood-mcp-trading"],
      "env": {
        "ROBINHOOD_CRYPTO_API_KEY": "rh-api-...",
        "ROBINHOOD_CRYPTO_PRIVATE_KEY": "your-base64-seed",
        "ROBINHOOD_CRYPTO_ENABLE_TRADING": "1",
        "ROBINHOOD_CRYPTO_MAX_ORDER_USD": "50",
        "ROBINHOOD_CRYPTO_MAX_DAILY_USD": "500",
        "ROBINHOOD_CRYPTO_SYMBOL_ALLOWLIST": "BTC-USD,ETH-USD"
      }
    }
  }
}
```

Set the caps to numbers you are comfortable losing. They are the only thing standing between a misunderstood instruction and a real fill.

You can run both entries at once. The data server is safe to leave attached permanently; add the trading server when you intend to trade.

### If you have not set credentials yet

The data server still starts. Rather than exiting (which most MCP clients surface only as an opaque "server failed to start"), it comes up with a single `get_setup_status` tool that reports what is missing and how to fix it. If that is the only tool you see, credentials are not configured: set `ROBINHOOD_CRYPTO_API_KEY` and `ROBINHOOD_CRYPTO_PRIVATE_KEY`, then restart the server and the full tool set appears.

The trading server is deliberately stricter and refuses to start without `ROBINHOOD_CRYPTO_ENABLE_TRADING=1`, so it can never be launched by accident.

---

## Modules

The toolkit is larger than any one agent should see at once. Every tool spends context and adds a wrong option to choose between, which measurably degrades tool selection, so capabilities ship as **modules the operator turns on** with `ROBINHOOD_MCP_MODULES`. Only the selected ones are registered.

| Module | What it does | Default | Places orders |
| --- | --- | --- | --- |
| `market` | Quotes, holdings, account details, trading pairs, order history. | on | no |
| `orders` | The four native order types as individual tools, plus the generic `place_order` and `cancel_order`. | on | **yes** |
| `algo` | The thirteen synthetic order types, run as durable background jobs. | on | **yes** |
| `portfolio` | FIFO cost basis, realized P&L and tax lots, allocation, slippage, volatility, risk-based sizing. | on | no |
| `risk` | Exposure, concentration, drawdown, pre-trade checks, and the enforced kill switch. | on | **yes** |
| `journal` | Fills, round-trip trades, win rate and profit factor, daily summaries, stale open orders, CSV export, reconciliation. | off | no |
| `ops` | Health checks, clock skew, key verification, rate-limit state, API version, supervisor and unsettled-intent status. | off | no |
| `dev` | Connection diagnostics, signature explanation, keypair generation and verification, client codegen, environment check. | off | no |

`risk` is classified as order-placing because engaging the kill switch pauses running jobs. It cannot itself submit an order.

**How selection works:**

- **Unset** loads the default set (`market`, `orders`, `algo`, `portfolio`, `risk`), minus anything the server cannot host. That is 52 tools on the trading server and 16 on the data server.
- **A comma-separated list** loads exactly those: `ROBINHOOD_MCP_MODULES=market,orders,risk`.
- **`all`** loads everything: 73 tools on the trading server.

An unknown module name **fails startup** rather than being silently dropped, because a typo that quietly removes tools is worse than a server that refuses to start.

**Loading everything degrades tool choice.** `all` is useful for a builder exploring the surface and a poor choice for a production agent. Pick the modules the task actually needs. If an agent reports a capability as impossible, have it call `list_modules`: the tool names the exact `ROBINHOOD_MCP_MODULES` value that would enable what is missing, so a disabled module is never mistaken for a capability the toolkit lacks.

The data server refuses to load a mutating module (`orders`, `algo`, `risk`) and fails at startup if asked to, so an operator can never believe they enabled execution when they did not.

Full parameter reference for all 73 tools: **[docs/tools.md](docs/tools.md)**.

---

## The thirteen synthetic order types

Each of these is built on top of Robinhood's four primitives by a supervisor that keeps advancing it over time. Every one is started by its own tool with a typed schema, so a missing or misnamed parameter fails at the schema boundary instead of inside the job.

| Order type | Tool | What it does | Key parameters |
| --- | --- | --- | --- |
| **TWAP** | `algo_twap_start` | Splits one large order into evenly spaced slices over a duration, so the entry averages across the window instead of paying a single spread. | `total_quantity`, `slices`, `duration_minutes`, optional `limit_price` guard |
| **Trailing stop** | `algo_trailing_stop_start` | Follows the market with a stop that ratchets in your favour and never retreats, exiting the full size when price retraces past the trail. | `quantity`, exactly one of `trail_percent` / `trail_amount`, optional `activation_price` |
| **Bracket** | `algo_bracket_start` | Enters a position and attaches a take-profit and a stop-loss that cancel one another, so the trade is never left with only one exit. | `entry_type`, `entry_price`, `take_profit_price`, `stop_loss_price` |
| **OCO** | `algo_oco_start` | Rests a take-profit and a stop against an **existing** position and cancels whichever does not fill. | `quantity`, `take_profit_price`, `stop_price`, optional `stop_limit_price` |
| **DCA** | `algo_dca_start` | Buys or sells a fixed amount on a repeating schedule for a set number of occurrences. | `interval_hours`, `occurrences`, one of `quote_amount_per_buy` / `asset_quantity_per_buy`, optional `max_price` |
| **Ladder** | `algo_ladder_start` | Places a series of resting limit orders across a price range, to scale into or out of a position as price moves. | `total_quantity`, `levels`, `start_price`, `end_price`, `distribution` |
| **Iceberg** | `algo_iceberg_start` | Works a large order behind a small visible slice, refilling as each slice fills, so the book never shows the full size. | `total_quantity`, `visible_quantity`, `max_duration_minutes`, optional `limit_price` |
| **Chase** | `algo_chase_start` | Rests a limit order and reposts it as the book moves away, to fill without crossing the spread. | `quantity`, `max_chases`, `offset_bps`, optional `limit_price` bound |
| **Grid** | `algo_grid_start` | Rests buys below and sells above across a price range, replacing each fill with its opposite one level away, banking the spacing on every round trip. | `lower_price`, `upper_price`, `grid_levels`, `quantity_per_grid`, optional `max_cycles` / `max_duration_minutes` / `stop_price` |
| **Momentum** | `algo_momentum_start` | Enters when price breaks out of its recent range by a set margin, then exits when it retraces a set fraction of the move it reached. | `side`, `quantity`, `lookback_ticks`, `breakout_pct`, `exit_pct`, `max_duration_minutes` |
| **Mean reversion** | `algo_mean_reversion_start` | Fades a price that has stretched a set number of standard deviations from its recent mean, and closes the trade when it reverts toward that mean. | `quantity`, `lookback_ticks`, `entry_z`, `exit_z`, `side_mode`, `max_duration_minutes` |
| **Accumulate** | `algo_accumulate_start` | Buys toward a target size only on weakness, taking a slice whenever price trades a set percentage below its recent average and under a hard ceiling. | `target_quantity`, `slice_quantity`, `max_price`, `buy_below_pct`, `lookback_ticks`, `max_duration_minutes` |
| **Rebalance** | `algo_rebalance_start` | Drives holdings toward target weights, selling what is overweight and buying what is underweight, sells before buys. | `targets`, `tolerance_bps`, `max_legs_per_tick`, `dry_run` |

Each tool's description states its own failure modes, which are not the same across strategies. A TWAP with a `limit_price` can finish short of the full size. An OCO has unavoidable exposure between one leg filling and the other being cancelled, and reports a double fill as `failed` rather than as success. An iceberg that hits `max_duration_minutes` cancels its working slice and completes under-filled. Read the tool description before running one for real, and use `algo_rebalance_start`'s `dry_run` to see the legs before any of them are sent.

**This API is spot only, which constrains four of these.** There is no borrow and no short position to open, so nothing here shorts:

- **`algo_mean_reversion_start`** with `side_mode` of `short_only` or `both` does not open a short. It sells an existing holding into an extreme high and buys it back on reversion. Both modes are rejected at start unless the account already holds enough to cover `quantity`, and every short entry re-checks the balance before submitting.
- **`algo_momentum_start`** with `side: "sell"` is the same shape: a momentum exit from coins the account already holds, not a short. `init` refuses the job if the holding does not exist.
- **`algo_grid_start`** will not sell coins its own buys have not funded. `max_cycles` and `max_duration_minutes` always carry a value (defaults: 100 cycles, 7 days), because a grid with neither never terminates. `stop_price` is the only path that liquidates: it cancels the resting orders and market-sells grid inventory.
- **`algo_accumulate_start`** waits for dips rather than buying on a clock as `algo_dca_start` does, so it **may finish short of target** if no qualifying dip arrives before `max_duration_minutes`. A run that ends short is reported as short.

---

## Durable jobs

A start tool does **not** execute an algorithm inside the call. It writes a durable job and returns; a supervisor owns execution from then on.

```
   algo_twap_start ("TWAP 0.5 BTC over 2 hours")
        |
        v
    JobStore (SQLite)  <-->  Supervisor  -->  Strategy.advance()  -->  Executor
                              (tick loop)
```

That is the whole point: **the job outlives the conversation.** It survives the agent disconnecting, the MCP server restarting, and the machine rebooting. It also keeps spending money after the chat window is closed, which is why every start tool says so and why `algo_cancel_job` exists.

Jobs live in a SQLite database at `~/.robinhood-mcp/jobs.db`, overridable with `ROBINHOOD_MCP_DB`. It is under the home directory rather than the working directory so a job survives being started from a different folder and is not accidentally committed to a repo. The kill-switch state lives in the same file, so the switch and the jobs it halts can never disagree about which database is authoritative.

### Unattended execution

An MCP server only runs while a client holds it open, so a job started through MCP advances only while that conversation is alive. For unattended execution run the daemon, which owns the same job database:

```bash
ROBINHOOD_CRYPTO_ENABLE_TRADING=1 \
ROBINHOOD_CRYPTO_MAX_ORDER_USD=50 \
npx robinhood-mcp-daemon
```

Run it under something that restarts it: systemd, launchd, pm2, a container. Restarts are safe by design. Credentials stay on the machine; the daemon talks only to Robinhood.

If jobs exist and look healthy but nothing is happening, the supervisor is not ticking. `ops_supervisor_status` is the check for that failure, which produces no error at all. A TWAP that is not ticking is not slow, it is stopped.

### Crash safety

Getting this wrong means double-filling a real order with real money.

The naive design submits an order and records it afterwards. If the process dies between those two steps, the order exists at Robinhood and the job has no memory of it; on restart the strategy repeats the slice and the user is filled twice.

Instead every order is a three-phase write:

1. **Reserve.** Generate the `client_order_id` and persist an intent row *before* any network call.
2. **Submit.** POST with that exact id, with retries disabled, since retrying an ambiguous write can double-fill.
3. **Settle.** Record the response.

On startup the supervisor reconciles every still-pending intent against Robinhood by `client_order_id`. **Found** means the order was placed before the crash, so it is adopted and never resubmitted. **Conclusively not found** means Robinhood never saw it. If the lookup itself did not complete, the intent stays pending and is retried, because an inconclusive answer must never be read as "not found": Robinhood offers no `client_order_id` query filter, so the lookup is a bounded walk of order history, and abandoning an intent whose order is live would re-place that slice under a fresh id.

After any crash, `ops_jobs_pending_intents` lists what was left unsettled and `journal_reconcile` compares the whole local record against Robinhood. Do not resubmit those by hand: reconciliation adopts the order if it exists, and a manual resubmit under a new id is how one intended fill becomes two real ones.

---

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ROBINHOOD_CRYPTO_API_KEY` | yes | none | API key issued by Robinhood when you register your public key. |
| `ROBINHOOD_CRYPTO_PRIVATE_KEY` | yes | none | Base64-encoded **32-byte Ed25519 seed**. Never a 64-byte expanded key, never PKCS#8. |
| `ROBINHOOD_CRYPTO_API_VERSION` | no | `v1` | `v1` or `v2`. v2 adds fee-tier data. Any other value fails startup. |
| `ROBINHOOD_CRYPTO_BASE_URL` | no | `https://trading.robinhood.com` | Override the API host. There is no sandbox host to point this at. |
| `ROBINHOOD_MCP_MODULES` | no | the default set | Comma-separated module names, or `all`. An unknown name fails startup. |
| `ROBINHOOD_MCP_DB` | no | `~/.robinhood-mcp/jobs.db` | Where durable jobs and the kill-switch state live. |
| `ROBINHOOD_MCP_TICK_MS` | no | `5000` | Daemon supervisor tick interval, in milliseconds. |
| `ROBINHOOD_CRYPTO_ENABLE_TRADING` | trading server and daemon | `0` | Must be exactly `1` for either to start. Nothing else enables trading. |
| `ROBINHOOD_CRYPTO_AUTONOMOUS` | no | `0` | `1` executes immediately and ignores `confirm`. Spend caps still apply. |
| `ROBINHOOD_CRYPTO_MAX_ORDER_USD` | no | `100` | Hard per-order ceiling. Applies in every mode. Must be a positive number. |
| `ROBINHOOD_CRYPTO_MAX_DAILY_USD` | no | unset (no cap) | Cumulative per-process ceiling. In-memory; resets on restart. |
| `ROBINHOOD_CRYPTO_SYMBOL_ALLOWLIST` | no | unset (all pairs) | Comma-separated pairs, e.g. `BTC-USD,ETH-USD`. When set, only these may trade. |
| `ROBINHOOD_CRYPTO_BUY_ONLY` | no | `0` | `1` rejects every sell order. |

See [`.env.example`](.env.example) for a copy-paste starting point. `check_environment` (in the `dev` module) reports which of these are set and what each currently does, without printing any secret. `risk_limits_export` (in the `risk` module) dumps every enforced limit with the variable that sets it.

### v1 vs v2

v2 adds fee-tier data but is not a drop-in replacement. Its `holdings`, `orders`, and order-placement endpoints require an `account_number` query parameter (resolved automatically here), `estimated_price` moves from `/marketdata/` to `/trading/`, and v2 reports order state `pending` where v1 reports `partially_filled`. Code written against one version can fail against the other for any of those reasons. Default is `v1`; set `v2` if you want fee data. `ops_api_version` explains the differences at runtime.

---

## Examples

### Price a trade, then place it

In guarded mode an order tool previews first. A typical exchange:

1. `get_best_bid_ask` with `symbols: ["BTC-USD"]` to see the live market.
2. `get_trading_pairs` with `symbols: ["BTC-USD"]` to check the quantity increment, because a quantity with too many decimals is rejected.
3. `risk_check_order` to test the order against every control without placing it. It returns a plain allowed true or false and names the control that would reject it.
4. `buy_limit` with `symbol: "BTC-USD"`, `limit_price: "60000.00"`, `quote_amount: "25.00"`. Without `confirm` this returns the exact request that would be sent plus a priced estimate, and places nothing.
5. `buy_limit` again with the same arguments plus `confirm: true`. Now it sends.
6. `get_order` with the returned order id to confirm the fill.

Step 3 matters most for multi-order plans: it fails on paper instead of halfway through with real money already spent.

### Accumulate over two hours, then protect the position

Split the entry so it averages across the window rather than paying one spread:

- `algo_twap_start` with `symbol: "BTC-USD"`, `side: "buy"`, `total_quantity: "0.05"`, `slices: 12`, `duration_minutes: 120`.

That returns a job id and returns immediately. Track it with `algo_list_jobs`, or `algo_get_job` for the full event history and every order it has placed. Stop it early with `algo_cancel_job`, remembering that this stops *further* orders and does not cancel ones already resting: `algo_get_job` lists those by id for `cancel_order`.

Once filled, protect the position with an OCO exit pair:

- `algo_oco_start` with `symbol: "BTC-USD"`, `side: "sell"`, `quantity: "0.05"`, `take_profit_price: "72000.00"`, `stop_price: "58000.00"`.

Both of these outlive the conversation, so run `robinhood-mcp-daemon` if you want them to keep advancing after you close the chat.

### Stop everything

If something looks wrong and you would rather stop than work out why:

- `risk_kill_switch_engage` with a `reason`. Every order is refused from the moment it returns, every running job is paused, and the halt survives a restart of both the server and the daemon.
- `cancel_order` for anything already resting at Robinhood. The kill switch does not cancel those.
- `risk_status` to see the full picture, then `risk_kill_switch_release` with `confirm: true` when the cause no longer applies.

---

## Library use

The signed client works without MCP:

```javascript
import { RobinhoodCryptoClient, loadCredentials } from 'robinhood-mcp';

const client = new RobinhoodCryptoClient(loadCredentials());
const quote = await client.get('/api/v1/crypto/marketdata/best_bid_ask/', {
  query: { symbol: ['BTC-USD'] },
});
console.log(quote);
```

Responses are returned exactly as Robinhood sends them. Field names are deliberately **not** remapped: the published schemas and the community clients disagree in places, and a wrong mapping corrupts data silently while a pass-through stays correct even as the upstream shape changes.

---

## Authentication, and two things that will bite you

Every request carries `x-api-key`, `x-timestamp`, and `x-signature`, where the signature is a detached Ed25519 signature over:

```
message = api_key + timestamp + path + method + body
```

concatenated with no separators. Three details matter:

- **The private key is a 32-byte seed**, not a 64-byte expanded keypair and not PKCS#8. Several Ed25519 libraries export `seed‖publicKey`; pasting that gives 64 bytes and fails. This package detects that case by name.
- **Timestamps are Unix seconds and expire after 30 seconds.** `Date.now()` returns milliseconds; using it directly fails every request. Keep the system clock synced, and use `ops_clock_skew` when a 401 looks like a bad key but might be a drifting clock.
- **The path includes the query string and the trailing slash.** Both are signed. Serialize the body once, sign those exact bytes, send those exact bytes: re-serializing changes key order or whitespace and produces a well-formed request with an invalid signature.

When a signature is rejected, `explain_signature` (in the `dev` module) shows the exact bytes being signed so another implementation can be compared byte for byte, and `diagnose_connection` runs every check that distinguishes the common causes of a 401.

### Robinhood's published conformance vector is wrong

The docs publish a worked example and invite you to check your signature against it. **That vector does not correspond to the JSON body a real client sends.** It was generated by signing a Python `dict` repr: single quotes, spaces after colons, and a different key order than the accompanying table shows:

```
{'client_order_id': '...', 'side': 'buy', 'symbol': 'BTC-USD', 'type': 'market', ...}
```

Signing the actual JSON body, which is what every working client and Robinhood's own sample code does at runtime, will *not* reproduce the published signature. Anyone using that vector as a conformance check will "fix" a correct implementation into a broken one.

Both facts are pinned in [`tests/signer.test.ts`](tests/signer.test.ts) so the quirk stays documented. The signer is verified the sound way instead: Robinhood publishes both halves of an example keypair, and this implementation derives their exact public key from their private key, then round-trips a signature through independent verification.

---

## What this does not do

- **No equities or options.** This is the crypto API. Robinhood's agentic trading product at `agent.robinhood.com/mcp/trading` is a separate, equities-only surface with its own OAuth flow, and it is not wrapped here. There are no plans to add stocks or options.
- **No private-API scraping.** Several community servers drive Robinhood through a browser session or the unauthenticated internal API. This package uses only the documented, signed, supported API.
- **No sandbox, because none exists.** There is no paper mode to fall back to and none can be added from outside Robinhood. `ROBINHOOD_CRYPTO_BASE_URL` overrides the host, but there is no test host to point it at. The guards above are the substitute, and they are the only one available.
- **No historical candles and no order book depth.** Robinhood publishes neither. `get_volatility` therefore takes a price series you supply rather than fetching one, and `estimate_slippage` models the quoted spread only, which is a floor on true cost rather than a simulation.
- **No cross-venue view.** Every derived number (cost basis, realized P&L, drawdown, journal performance) is rebuilt from Robinhood order history alone. Deposits, withdrawals, transfers in from another venue, staking rewards and airdrops are invisible to it, and the affected tools say so in their own descriptions.
- **No vendored OpenAPI spec.** [`scripts/fetch-spec.mjs`](scripts/fetch-spec.mjs) pulls it live, because a vendored copy goes stale silently.

---

## Development

```bash
npm install
npm test          # unit and integration tests, no credentials or network
npm run typecheck
npm run build
npm run smoke     # launch both built servers over real stdio and list their tools
npm run test:live # hits the real API; requires credentials; read-only
```

`npm test` never touches the network: strategy math, policy enforcement, and reconciliation are tested against a real SQLite store in memory, and the network boundary is the only thing substituted. `npm run smoke` performs the handshake a real MCP client performs, which catches what the unit suite cannot: a stale `dist/`, a bad bin shebang, or a module that throws during registration. The live suite is opt-in and read-only, and places no orders.

Design rationale, the layering, and where to add code: [`docs/architecture.md`](docs/architecture.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
