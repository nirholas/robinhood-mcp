# robinhood-mcp

Model Context Protocol servers for the **official Robinhood Crypto Trading API** — the credentialed brokerage API at `trading.robinhood.com`, documented at [docs.robinhood.com/crypto/trading](https://docs.robinhood.com/crypto/trading/).

Two servers ship in this package:

| Server | Binary | What it can do |
| --- | --- | --- |
| Data | `robinhood-mcp` | Read quotes, holdings, account, order history. Cannot move money. |
| Trading | `robinhood-mcp-trading` | Everything above, plus `place_order` and `cancel_order`, behind an opt-in flag, a spend cap, and a per-call confirm gate. |

> **This is not Robinhood Chain.** For the L2 (chain ID 4663) — Stock Tokens, USDG, Uniswap v3 swaps — see [`robinhood-chain-mcp`](https://github.com/nirholas/robinhood-chain-mcp). Different product, different credentials, different money. Mixing them up is the most common mistake in this space.

---

## Quick start (read-only)

```bash
npx robinhood-keygen        # generate an Ed25519 keypair
```

Register the **public** key at [robinhood.com/account/crypto](https://robinhood.com/account/crypto) (web classic only), and Robinhood issues you an API key. Then:

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

Ask your assistant: *"What's my Robinhood crypto buying power, and what's BTC trading at?"*

---

## Tools

### Read-only (both servers)

| Tool | Purpose |
| --- | --- |
| `get_account` | Account number, status, buying power. Fee-tier status on v2. |
| `get_holdings` | Holdings with total and tradable quantity. |
| `get_best_bid_ask` | Best bid/ask for one or more pairs, including the spread-inclusive execution prices. |
| `get_estimated_price` | Depth-aware execution estimate for a given size. |
| `get_trading_pairs` | Supported pairs with min/max order size and price/quantity increments. |
| `get_orders` | Order history, filterable by symbol, side, type, state, and time. |
| `get_order` | One order by id, including its fills. |
| `get_connection_info` | Configured API version and the **public** key derived from your private key. Never returns secrets. |

### Trading (trading server only)

| Tool | Purpose |
| --- | --- |
| `place_order` | Market, limit, stop-loss, and stop-limit orders. Previews by default. |
| `cancel_order` | Best-effort cancellation of an open order. |
| `get_execution_policy` | The active mode, every limit enforced, and what has been committed. |

### Execution engine (trading server only)

| Tool | Purpose |
| --- | --- |
| `algo_list_strategies` | The synthetic order types available, and their parameters. |
| `algo_start` | Start one as a durable background job. |
| `algo_list_jobs` | What is currently running against the account. |
| `algo_get_job` | One job's state, the orders it placed, and its event history. |
| `algo_cancel_job` | Stop a job placing further orders. |

---

## The execution engine

Robinhood's API offers four order types: `market`, `limit`, `stop_loss`, and
`stop_limit`. There is no bracket, no OCO, no trailing stop, no TWAP, no
scheduled DCA. Those are the order types people actually want, and every one of
them needs something that keeps working after the request returns. A trailing
stop that exists only for the duration of one tool call is not a trailing stop.

So `algo_start` does not run an algorithm inside the call. It writes a durable
job and returns; a supervisor advances it from there.

```
   algo_start ("TWAP 0.5 BTC over 2 hours")
        |
        v
    JobStore (SQLite)  <-->  Supervisor  -->  Strategy.advance()  -->  Executor
                              (tick loop)
```

Strategies are pure step functions. They never sleep, never loop, and never
touch the network; they return the actions they want taken and the state to
persist. That is what makes them testable without a live account and
resumable without special cases.

### Keeping jobs moving

An MCP server only runs while a client holds it open, so a job started through
MCP advances only while that conversation is alive. For unattended execution,
run the daemon, which owns the same job database:

```bash
ROBINHOOD_CRYPTO_ENABLE_TRADING=1 npx robinhood-mcp-daemon
```

Run it under something that restarts it (systemd, launchd, pm2, a container).
Restarts are safe by design, which is the next section.

### Crash safety

Getting this wrong means double-filling a real order with real money.

The naive design submits an order and records it afterwards. If the process
dies between those two steps, the order exists at Robinhood and the job has no
memory of it; on restart the strategy repeats the slice and the user is filled
twice.

Instead every order is a three-phase write:

1. **Reserve.** Generate the `client_order_id` and persist an intent row
   *before* any network call.
2. **Submit.** POST with that exact id, with retries disabled.
3. **Settle.** Record the response.

On startup the supervisor reconciles: for every still-pending intent it queries
Robinhood by `client_order_id`. Found means the order was placed before the
crash, so it is adopted and never resubmitted. Not found means Robinhood never
saw it. If the check itself fails, the intent is left pending rather than
guessed at, because an inconclusive answer must not be read as "not found".

Jobs live in `~/.robinhood-mcp/jobs.db` by default (`ROBINHOOD_MCP_DB` to
override).

---

## Safety

**Robinhood publishes no sandbox.** Every order this server can place is real money in a real brokerage account. Four independent controls sit in front of that, all enforced in code rather than in a prompt:

1. **Separate binary.** The data server registers no tool that can trade. Attaching it to a general-purpose assistant cannot result in an order.
2. **Explicit opt-in.** The trading server refuses to start unless `ROBINHOOD_CRYPTO_ENABLE_TRADING=1`.
3. **Confirm gate.** In the default `guarded` mode, `place_order` returns the exact request it *would* send plus a priced estimate. Nothing is placed until a second call sets `confirm: true`.
4. **Spend cap.** Every order is priced before submission and rejected above `ROBINHOOD_CRYPTO_MAX_ORDER_USD` (default `$100`), with an optional cumulative `ROBINHOOD_CRYPTO_MAX_DAILY_USD`.

### Autonomous execution

Unattended strategies have no human available to confirm anything, so
`ROBINHOOD_CRYPTO_AUTONOMOUS=1` executes orders immediately and ignores
`confirm`.

**The spend caps still apply.** Autonomous removes the human, not the ceiling:
an unattended agent is exactly where a runaway order is most likely and least
observed. Every order still routes through one executor that prices it, checks
it against the per-order cap, the daily cap, the allowlist, and the buy-only
flag, and refuses outright when the value cannot be determined. Call
`get_execution_policy` to see the active limits and what has been committed.

The cap **fails closed**: if an order's USD value cannot be determined up front, it is rejected rather than assumed cheap. Writes are never retried, since retrying an ambiguous failure can double-fill.

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
        "ROBINHOOD_CRYPTO_SYMBOL_ALLOWLIST": "BTC-USD,ETH-USD"
      }
    }
  }
}
```

Scope the API key itself too. Robinhood lets you pick permissions per credential — if you only want reads, do not grant order placement, and the key cannot trade no matter what software holds it. IP allowlisting is also available and worth using.

---

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ROBINHOOD_CRYPTO_API_KEY` | yes | — | API key from your crypto account settings. |
| `ROBINHOOD_CRYPTO_PRIVATE_KEY` | yes | — | Base64 **32-byte Ed25519 seed**. |
| `ROBINHOOD_CRYPTO_API_VERSION` | no | `v1` | `v1` or `v2`. v2 adds fee tiers. |
| `ROBINHOOD_CRYPTO_BASE_URL` | no | `https://trading.robinhood.com` | Override the API host. |
| `ROBINHOOD_CRYPTO_ENABLE_TRADING` | trading only | `0` | Must be `1` to start the trading server. |
| `ROBINHOOD_CRYPTO_AUTONOMOUS` | no | `0` | Set `1` to execute immediately with no confirm step. |
| `ROBINHOOD_CRYPTO_MAX_ORDER_USD` | no | `100` | Hard ceiling per order. Applies in every mode. |
| `ROBINHOOD_CRYPTO_MAX_DAILY_USD` | no | unset | Cumulative per-process ceiling. |
| `ROBINHOOD_CRYPTO_SYMBOL_ALLOWLIST` | no | unset | Comma-separated pairs; when set, only these may trade. |
| `ROBINHOOD_CRYPTO_BUY_ONLY` | no | `0` | Set `1` to reject sell orders. |

### v1 vs v2

v2 adds fee-tier data but is not a drop-in replacement. Its `holdings`, `orders`, and order-placement endpoints require an `account_number` query parameter (resolved automatically here), and `estimated_price` moves from `/marketdata/` to `/trading/`. v2 also reports order state `pending` where v1 reports `partially_filled`. Default is v1; set `ROBINHOOD_CRYPTO_API_VERSION=v2` if you want fee data.

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
- **Timestamps are Unix seconds and expire after 30 seconds.** `Date.now()` returns milliseconds; using it directly fails every request. Keep the system clock synced.
- **The path includes the query string and the trailing slash.** Both are signed. Serialize the body once, sign those exact bytes, send those exact bytes — re-serializing changes key order or whitespace and produces a well-formed request with an invalid signature.

### Robinhood's published conformance vector is wrong

The docs publish a worked example and invite you to check your signature against it. **That vector does not correspond to the JSON body a real client sends.** It was generated by signing a Python `dict` repr — single quotes, spaces after colons, and a different key order than the accompanying table shows:

```
{'client_order_id': '...', 'side': 'buy', 'symbol': 'BTC-USD', 'type': 'market', ...}
```

Signing the actual JSON body, which is what every working client and Robinhood's own sample code does at runtime, will *not* reproduce the published signature. Anyone using that vector as a conformance check will "fix" a correct implementation into a broken one.

Both facts are pinned in [`tests/signer.test.ts`](tests/signer.test.ts) so the quirk stays documented. The signer is verified the sound way instead: Robinhood publishes both halves of an example keypair, and this implementation derives their exact public key from their private key, then round-trips a signature through independent verification.

---

## Development

```bash
npm install
npm test          # unit tests, no credentials or network needed
npm run typecheck
npm run build
npm run test:live # hits the real API; requires credentials
```

`npm test` never touches the network. The live suite is opt-in and read-only — it places no orders.

## Reference

The upstream OpenAPI document is vendored at [`docs/openapi-extracted.json`](docs/openapi-extracted.json). Robinhood serves its docs as a client-rendered SPA with no published spec URL; this copy was extracted from the page bundle so the endpoint list and schemas can be diffed when they change.

## License

See [LICENSE](LICENSE).
