# Tool reference

Every tool this package exposes, grouped by the module that registers it.

Modules are selected with `ROBINHOOD_MCP_MODULES`. A tool that is not in a loaded
module is not registered at all, so it will not appear in the client's tool list.
Call `list_modules` to see what is loaded and what is switched off.

Two servers ship in the package, and which module can load where is not a
convention but an enforced rule:

| Server | Binary | Modules it can load |
| --- | --- | --- |
| Data | `robinhood-mcp` | `market`, `portfolio`, `journal`, `ops`, `dev` |
| Trading | `robinhood-mcp-trading` | all of the above plus `orders`, `algo`, `risk` |

The data server refuses to load a mutating module (`orders`, `algo`, `risk`), and
it fails at startup rather than dropping it silently, so an operator can never
believe they enabled execution when they did not.

Counts: 8 modules, 68 module tools, plus `list_modules`, which every server
registers. The trading server with `ROBINHOOD_MCP_MODULES=all` exposes 69 tools;
with the default selection it exposes 48. The data server exposes 16 by default.

**Sizing conventions.** Prices and quantities are passed as decimal *strings*
(`"0.001"`, `"65000.00"`), not numbers, so no precision is lost on the way to the
venue. The analytics and risk modules are the exception: they take numbers,
because they compute rather than submit. `asset_quantity` is the base asset (BTC
in `BTC-USD`), `quote_amount` is the quote currency (USD).

---

## `market` (read-only, on by default)

Quotes, account state, and order history. Read-only, so it is the one module
safe to attach to a general-purpose assistant.

### `get_account`
Fetch the Robinhood crypto account: account number, status, and buying power. On
API v2 this also includes fee-tier status. Use it to confirm credentials work and
to check buying power before sizing an order.

No parameters.

### `get_holdings`
List crypto holdings with total quantity and the quantity available for trading.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `asset_codes` | `string[]` | no | Filter to these asset codes, e.g. `["BTC","ETH"]`. These are base assets, not pairs. Omit for all holdings. |

### `get_best_bid_ask`
Current best bid and ask for one or more trading pairs. On API v1 the response
includes the spread-inclusive prices actually used for execution
(`bid_inclusive_of_sell_spread` / `ask_inclusive_of_buy_spread`) alongside the
mid price. Use it to price an order before placing it.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbols` | `string[]` | yes | Trading pairs to quote, e.g. `["BTC-USD","ETH-USD"]`. |

### `get_estimated_price`
Estimated execution price for a given quantity, which accounts for depth rather
than quoting only the top of book. On API v2 the response also carries fee
estimates.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | yes | Trading pair, e.g. `BTC-USD`. |
| `side` | `"bid" \| "ask" \| "both"` | yes | Use `ask` to estimate a buy, `bid` to estimate a sell. |
| `quantities` | `string[]` | yes | Asset quantities to price, as decimal strings, e.g. `["0.1","1.0"]`. |

### `get_trading_pairs`
List supported trading pairs with their minimum and maximum order sizes and
price/quantity increments. Check these increments before placing an order: a
quantity with too many decimals is rejected.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbols` | `string[]` | no | Filter to these pairs. Omit to list every supported pair. |

### `get_orders`
List orders, newest first, with optional filters. Use it to review order history
or to poll an order until it fills.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | no | Filter to one trading pair. |
| `side` | `"buy" \| "sell"` | no | Filter by side. |
| `type` | `"market" \| "limit" \| "stop_loss" \| "stop_limit"` | no | Filter by order type. |
| `state` | `"open" \| "canceled" \| "partially_filled" \| "filled" \| "failed"` | no | Order state. API v2 reports `pending` in place of `partially_filled`. |
| `created_at_start` | `string` | no | ISO 8601 timestamp lower bound. |
| `created_at_end` | `string` | no | ISO 8601 timestamp upper bound. |
| `limit` | `integer` | no | Max results per page. |

### `get_order`
Fetch a single order by its Robinhood order id, including its executions (fill
price and quantity). Use it after placing an order to confirm the fill.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `order_id` | `string` | yes | The order id returned when the order was placed. |

### `get_connection_info`
Report how this server is configured: API version, base URL, and the public key
derived from the configured private key. Reveals no secret. Use it first when
authentication fails, because if the public key shown here does not match the one
registered with Robinhood, the wrong private key is configured.

No parameters.

---

## `orders` (places real orders, on by default, trading server only)

The four order types Robinhood natively supports, each as its own tool, plus the
generic escape hatch and the policy readout.

Every order-placing tool below takes `confirm` and `client_order_id`:

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `confirm` | `boolean` | no (default `false`) | Must be `true` to place the order in guarded mode. Ignored in autonomous mode, where orders always send. |
| `client_order_id` | `string` | no | Idempotency key. Generated if omitted. Reuse it when retrying one logical order. |

Without `confirm: true` in guarded mode, these tools return the exact request that
would be sent plus a priced estimate, and place nothing.

### `buy_market` / `sell_market`
Buy or sell immediately at the best available price.

Market orders are sized in the base asset only. Robinhood rejects `quote_amount`
for them, so to trade a dollar amount use `buy_limit`/`sell_limit`, or compute
the quantity from `get_best_bid_ask` first.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | yes | Trading pair, e.g. `BTC-USD`. |
| `asset_quantity` | `string` | yes | Size in the base asset, e.g. `"0.001"` BTC. |
| `confirm`, `client_order_id` | | | See above. |

### `buy_limit` / `sell_limit`
Trade only at `limit_price` or better. Unlike a market order, this may rest
unfilled indefinitely under `time_in_force=gtc`: poll `get_order`, or use
`algo_chase_start` to follow the book until filled.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | yes | Trading pair, e.g. `BTC-USD`. |
| `limit_price` | `string` | yes | Worst acceptable price. Fills at this price or better. |
| `asset_quantity` | `string` | no | Size in the base asset. Mutually exclusive with `quote_amount`. |
| `quote_amount` | `string` | no | Size in the quote currency, e.g. `"25.00"` USD. Mutually exclusive with `asset_quantity`. |
| `time_in_force` | `"gtc" \| "day"` | no (default `gtc`) | Order duration. |
| `confirm`, `client_order_id` | | | See above. |

Size with exactly one of `asset_quantity` or `quote_amount`.

### `place_stop_loss`
Place a stop order that becomes a **market** order once `stop_price` trades.
Because it converts to a market order, the fill price is not bounded and can be
well through the stop in a fast move. This is a single resting order, not a
trailing stop: for one that follows price up, use `algo_trailing_stop_start`.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | yes | Trading pair, e.g. `BTC-USD`. |
| `side` | `"buy" \| "sell"` | yes | `sell` to protect a long; `buy` to cover a short or enter on a breakout. |
| `stop_price` | `string` | yes | Trigger price. The order activates when the market reaches it. |
| `asset_quantity` | `string` | no | Size in the base asset. Mutually exclusive with `quote_amount`. |
| `quote_amount` | `string` | no | Size in the quote currency. Mutually exclusive with `asset_quantity`. |
| `time_in_force` | `"gtc" \| "day"` | no (default `gtc`) | Order duration. |
| `confirm`, `client_order_id` | | | See above. |

### `place_stop_limit`
Place a stop order that becomes a **limit** order once `stop_price` trades. The
limit bounds the fill price at the cost of possibly not filling: if the market
gaps past `limit_price` the order rests unfilled and the position stays open. For
a sell stop set `limit_price` at or below `stop_price`, otherwise it can never
fill.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | yes | Trading pair, e.g. `BTC-USD`. |
| `side` | `"buy" \| "sell"` | yes | Order side. |
| `stop_price` | `string` | yes | Trigger price. The limit order is placed when this trades. |
| `limit_price` | `string` | yes | Worst acceptable fill price once triggered. |
| `asset_quantity` | `string` | no | Size in the base asset. Mutually exclusive with `quote_amount`. |
| `quote_amount` | `string` | no | Size in the quote currency. Mutually exclusive with `asset_quantity`. |
| `time_in_force` | `"gtc" \| "day"` | no (default `gtc`) | Order duration. |
| `confirm`, `client_order_id` | | | See above. |

### `place_order`
Place a crypto order of any type. Prefer the narrower tools above: their schemas
accept only the fields that order type allows, so an invalid combination cannot
be built. Use this one for programmatically generated orders.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | yes | Trading pair, e.g. `BTC-USD`. |
| `side` | `"buy" \| "sell"` | yes | Order side. |
| `type` | `"market" \| "limit" \| "stop_loss" \| "stop_limit"` | yes | Order type. |
| `asset_quantity` | `string` | no | Size in the base asset. Mutually exclusive with `quote_amount`. |
| `quote_amount` | `string` | no | Size in the quote currency. Not supported for market orders. |
| `limit_price` | `string` | no | Required for `limit` and `stop_limit`. |
| `stop_price` | `string` | no | Required for `stop_loss` and `stop_limit`. |
| `time_in_force` | `"gtc" \| "day"` | no (default `gtc`) | Order duration. |
| `confirm`, `client_order_id` | | | See above. |

### `cancel_order`
Request cancellation of an open order by id. Cancellation is best-effort: an
order that has already filled cannot be canceled. Confirm the resulting state
with `get_order`.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `order_id` | `string` | yes | The order id to cancel. |

### `get_execution_policy`
Report the execution mode and every limit this server enforces, plus how much has
been committed this session. Check it before planning a strategy so sizing fits
the caps.

No parameters.

---

## `algo` (places real orders over time, on by default, trading server only)

The synthetic order types Robinhood does not offer, run as durable jobs that
outlive the tool call which started them. See
[the synthetic order types](../README.md#the-nine-synthetic-order-types) for what
each one is for.

A start tool **spends real money over time, not just once**: the job keeps
placing orders until it completes or is cancelled, and it outlives the
conversation. Cancel it with `algo_cancel_job` when it is no longer wanted.
Per-order caps apply to every order a job places, but **the job total is not
itself capped**.

### `algo_twap_start`
Split one large order into evenly spaced slices over a duration, so the entry
averages across the window instead of paying a single spread. Without
`limit_price` each slice is a market order, which is the usual TWAP and has no
price guard. With `limit_price` a slice that would trade through it is skipped
and retried, so the schedule can finish short of the full size.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | yes | Trading pair, e.g. `BTC-USD`. |
| `side` | `"buy" \| "sell"` | yes | Order side. |
| `total_quantity` | `string` | yes | Total size in the base asset, across all slices. |
| `slices` | `integer` | yes | Number of slices to split the order into. |
| `duration_minutes` | `integer` | yes | Window to spread the slices across. Slice interval is duration / slices. |
| `limit_price` | `string` | no | Price guard. Buys will not pay above it; sells will not accept below it. |

### `algo_trailing_stop_start`
Follow the market with a stop that ratchets in your favour and never retreats,
exiting the full size when price retraces past the trail. Until
`activation_price` is reached (if given) the stop does not arm, which is how you
let a position run before protecting it. The exit is a market order, so the fill
is not price-bounded.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | yes | Trading pair, e.g. `BTC-USD`. |
| `side` | `"buy" \| "sell"` | yes | Side of the **exit**. `sell` trails a long; `buy` trails a short. |
| `quantity` | `string` | yes | Size to exit when the trail is hit. |
| `trail_percent` | `number` | no | Trail distance as a percent of the high-water mark. Mutually exclusive with `trail_amount`. |
| `trail_amount` | `string` | no | Trail distance in quote currency. Mutually exclusive with `trail_percent`. |
| `activation_price` | `string` | no | Do not arm the trail until price reaches this level. |

Set exactly one of `trail_percent` or `trail_amount`.

### `algo_bracket_start`
Enter a position and attach a take-profit and a stop-loss that cancel one
another, so the trade is never left with only one exit. The exits are placed only
after the entry fills. To protect an *existing* position rather than open a new
one, use `algo_oco_start`.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | yes | Trading pair, e.g. `BTC-USD`. |
| `side` | `"buy" \| "sell"` | yes | Side of the **entry**. `buy` opens a long, whose exits are sells. |
| `quantity` | `string` | yes | Position size. |
| `entry_type` | `"market" \| "limit"` | yes | `market` enters immediately; `limit` waits at `entry_price`. |
| `entry_price` | `string` | no | Required when `entry_type` is `limit`. |
| `take_profit_price` | `string` | yes | Profit target. Above entry for a long, below for a short. |
| `stop_loss_price` | `string` | yes | Protective stop. Below entry for a long, above for a short. |

### `algo_oco_start`
Protect an **existing** position with a take-profit and a stop at once,
cancelling whichever does not fill. There is unavoidable exposure between one leg
filling and the other being cancelled: if both fill, the job ends `failed` with
the double fill spelled out rather than reporting success. To open a new position
with exits attached, use `algo_bracket_start`.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | yes | Trading pair, e.g. `BTC-USD`. |
| `side` | `"buy" \| "sell"` | yes | Side of **both** exits. `sell` exits a long position. |
| `quantity` | `string` | yes | Size of the position being protected. |
| `take_profit_price` | `string` | yes | Profit target. Above the stop for a sell exit. |
| `stop_price` | `string` | yes | Protective stop trigger. |
| `stop_limit_price` | `string` | no | Makes the stop leg a stop-limit rather than a stop-loss, bounding the fill price at the risk of not filling. |

### `algo_dca_start`
Buy (or sell) a fixed amount on a repeating schedule for a set number of
occurrences. A `max_price` skip does not consume an occurrence, so the schedule
still completes its full count.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | yes | Trading pair, e.g. `BTC-USD`. |
| `side` | `"buy" \| "sell"` | yes | Order side. |
| `interval_hours` | `number` | yes | Hours between each execution. Below 0.25 use `algo_twap_start` instead. |
| `occurrences` | `integer` | yes | How many times to execute. |
| `quote_amount_per_buy` | `string` | no | Dollar amount per execution. Mutually exclusive with `asset_quantity_per_buy`. |
| `asset_quantity_per_buy` | `string` | no | Base-asset size per execution. Mutually exclusive with `quote_amount_per_buy`. |
| `max_price` | `string` | no | Skip an execution above this price (buy) or below it (sell), without consuming an occurrence. |

Size with exactly one of `quote_amount_per_buy` (placed as a bounded limit order,
because the venue rejects `quote_amount` on market orders) or
`asset_quantity_per_buy` (placed as a market order).

### `algo_ladder_start`
Place a series of resting limit orders across a price range, to scale into or out
of a position as price moves rather than committing at one level. A buy ladder
must descend (end below start) and a sell ladder must ascend; a ladder already
through the market is rejected. Rungs are placed a few per tick so one rejection
does not lose the whole ladder.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | yes | Trading pair, e.g. `BTC-USD`. |
| `side` | `"buy" \| "sell"` | yes | Order side. |
| `total_quantity` | `string` | yes | Total size in the base asset, spread across all rungs. |
| `levels` | `integer` | yes | Number of rungs. |
| `start_price` | `string` | yes | Price of the rung nearest the market. |
| `end_price` | `string` | yes | Price of the furthest rung. Below start for a buy, above for a sell. |
| `distribution` | `"even" \| "front" \| "back"` | no | How size is weighted across rungs. `even` splits equally; `front` weights toward `start_price`; `back` weights toward `end_price`. |
| `time_in_force` | `"gtc" \| "day"` | no | Order duration for each rung. |

### `algo_iceberg_start`
Work a large order while showing only a small resting slice at a time, refilling
as each slice fills, so the full size never appears in the book. Without
`limit_price` each refill pegs to the passive touch (the bid for a buy). On
expiry the working slice is cancelled and the job completes, likely under-filled.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | yes | Trading pair, e.g. `BTC-USD`. |
| `side` | `"buy" \| "sell"` | yes | Order side. |
| `total_quantity` | `string` | yes | Total size in the base asset. |
| `visible_quantity` | `string` | yes | Size shown at any one time. Must be less than `total_quantity` and at or above the venue minimum. |
| `max_duration_minutes` | `integer` | yes | Give up after this long and cancel any resting slice. |
| `limit_price` | `string` | no | Fixed price for every slice. Omit to peg each refill to the passive touch. |

### `algo_chase_start`
Rest a limit order and repost it as the book moves away, to fill without crossing
the spread. When the retry budget is spent the last order is left resting,
because cancelling it would turn a possible fill into a certain miss.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | yes | Trading pair, e.g. `BTC-USD`. |
| `side` | `"buy" \| "sell"` | yes | Order side. |
| `quantity` | `string` | yes | Size to fill. |
| `max_chases` | `integer` | yes | How many times to repost. The opening order does not count. |
| `offset_bps` | `number` | yes | Basis points from the touch. Positive rests behind it (passive, cheaper, may not fill); negative posts through it (marketable, fills sooner, pays more). |
| `limit_price` | `string` | no | Hard bound the chase never crosses: a ceiling for a buy, a floor for a sell. |

### `algo_rebalance_start`
Drive holdings toward target weights by selling what is overweight and buying
what is underweight. Sells are never mixed into the same tick as buys, so
proceeds are realized before they are spent. The plan is computed once at start
and not recomputed, which bounds the work.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `targets` | `object` | yes | Trading pair to target weight as a fraction of 1, e.g. `{"BTC-USD": 0.6, "ETH-USD": 0.4}`. Weights must sum to 1.0. |
| `tolerance_bps` | `integer` | yes | Drift band in basis points of the whole portfolio. Legs inside the band are left alone. |
| `max_legs_per_tick` | `integer` | yes | How many legs to execute per advance, pacing the rebalance. |
| `dry_run` | `boolean` | no | Size and log every leg without placing any order. Use this first. |

Set `dry_run` to size and log every leg without sending anything: do that first,
show the user the legs, then run it for real.

### `algo_start`
Start a synthetic order type as a durable background job, passing parameters as
an untyped record. Prefer the per-strategy tools above: they declare the
parameters that strategy actually takes, so a missing or misnamed field is caught
by the schema rather than inside the job. Use this one only for a strategy
assembled programmatically.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `strategy` | `string` | yes | Strategy name, e.g. `"twap"`. |
| `params` | `object` | yes | Strategy parameters. See `algo_list_strategies` for what each one requires. |

### `algo_list_strategies`
List the synthetic order types this server can run, with the parameters each
takes.

No parameters.

### `algo_list_jobs`
List execution jobs and their progress. Use it to see what is currently running
against the account before starting something new.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `status` | `"pending" \| "running" \| "paused" \| "completed" \| "cancelled" \| "failed"` | no | Filter by job status. |
| `strategy` | `string` | no | Filter by strategy name. |
| `symbol` | `string` | no | Filter by trading pair. |

### `algo_get_job`
Fetch one job with its full state, the orders it has placed, and its event
history. Use it to explain to a user exactly what an algorithm has done so far.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `job_id` | `string` | yes | The job id. |
| `event_limit` | `integer` | no (default `50`) | How many history events to return. |

### `algo_cancel_job`
Stop a running job so it places no further orders. This does **not** cancel
orders already resting on the book: use `cancel_order` for those, which
`algo_get_job` lists by id.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `job_id` | `string` | yes | The job id. |

---

## `portfolio` (read-only, on by default)

Numbers Robinhood does not report: what you paid, what you realized, which lots
are open, and how large a position your stop actually justifies. All of it is
derived from filled order history.

### `get_cost_basis`
Compute FIFO cost basis, open tax lots, and realized P&L from filled order
history. Robinhood does not report any of this: it tells you what you hold and
what it is worth now, not what you paid.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | no | Limit to one trading pair. Omit for all assets. |
| `include_lots` | `boolean` | no (default `false`) | Include every open lot individually, not just the per-asset summary. |

### `get_realized_pnl`
List every closed disposal with proceeds, cost basis, gain or loss, and whether
the holding period exceeded one year. Use it for tax preparation.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | no | Limit to one trading pair. |
| `year` | `integer` | no | Limit to disposals in this calendar year (UTC). |

### `get_allocation`
Current portfolio weights by asset, with each position valued at its live price.
Use it before rebalancing, or to answer "how concentrated am I".

No parameters.

### `analyze_trade_history`
Summarize trading performance from filled orders: win rate, average win and loss,
profit factor, best and worst trades, and the largest drawdown in realized P&L.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | no | Limit to one trading pair. |

### `estimate_slippage`
Estimate what crossing the spread costs for a given size, using the live quote.
Robinhood publishes no order book depth, so this models the quoted spread only
and is a floor on true cost, not a simulation.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | yes | Trading pair. |
| `side` | `"buy" \| "sell"` | yes | Order side. |
| `quantity` | `number` | yes | Size in the base asset. |

### `get_volatility`
Annualized realized volatility for an asset, computed from prices you supply.
Robinhood publishes no historical candles, so this cannot fetch its own series:
pass one from your own records or another data source.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `prices` | `number[]` | yes | Price series in chronological order. At least 3 points. |
| `periods_per_year` | `number` | no (default `365`) | 365 for daily prices, 8760 for hourly. |

### `size_position_by_risk`
Compute how much to buy so that hitting your stop loses a chosen percentage of
the account, rather than picking a size first and accepting whatever loss
follows. Returns the quantity, notional, and the exact dollar amount at risk.

This is the pure calculator. `risk_position_size` in the `risk` module does the
same arithmetic but sources equity and entry from the live account and rounds to
the venue increment.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `account_value_usd` | `number` | yes | Capital the risk is measured against. |
| `risk_percent` | `number` | yes | Percent of the account to lose if the stop is hit, e.g. 1. |
| `entry_price` | `number` | yes | Intended entry price. |
| `stop_price` | `number` | yes | Stop price. |

---

## `risk` (mutating, on by default, trading server only)

Limits, exposure, and the emergency stop. Classified as mutating because
engaging the kill switch pauses running jobs. The halt itself is enforced in the
`Executor`, not in a tool, so it also binds the daemon, which loads no tool
modules at all.

### `risk_status`
The complete picture of what this server will and will not do right now:
execution mode, every configured limit, how much of the session spend allowance
is already committed, whether the kill switch is engaged, and how many algo jobs
are live. Call it first when an order was refused and the reason is not obvious,
and before starting anything unattended.

No parameters.

### `risk_check_order`
Test a proposed order against every policy control **without** placing it, and
get back a plain allowed true or false plus exactly which control would reject it
and why. Nothing is sent, no spend is committed, and no confirmation is implied.
It runs the same pricing and the same assertions a live order runs, so its
verdict cannot drift from the real gate.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | yes | Trading pair, e.g. `BTC-USD`. |
| `side` | `"buy" \| "sell"` | yes | Order side. |
| `type` | `"market" \| "limit" \| "stop_loss" \| "stop_limit"` | yes | The order type you intend to place. |
| `asset_quantity` | `string` | no | Size in the base asset. Mutually exclusive with `quote_amount`. |
| `quote_amount` | `string` | no | Size in the quote currency. Mutually exclusive with `asset_quantity`. |
| `limit_price` | `string` | no | Required for `limit` and `stop_limit`. |
| `stop_price` | `string` | no | Required for `stop_loss` and `stop_limit`. |
| `time_in_force` | `"gtc" \| "day"` | no (default `gtc`) | Order duration. |

### `risk_exposure`
Total and per-symbol USD exposure from the real account holdings, each valued at
the live bid, with every position's share of the portfolio. An asset that cannot
be quoted is listed as unpriceable rather than counted as zero, and the result
says so.

No parameters.

### `risk_concentration`
Flag every position worth more than a chosen percentage of the portfolio. By
default this refuses to answer when some holding cannot be priced, because an
unknown denominator makes every percentage wrong in the direction that hides a
breach.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `threshold_percent` | `number` | no (default `25`) | Share of the portfolio above which a position is flagged. |
| `allow_incomplete` | `boolean` | no (default `false`) | Answer even when some asset cannot be priced, measuring shares against the priced subset only. |

### `risk_drawdown`
Largest peak-to-trough decline in total P&L (realized plus unrealized), rebuilt
from filled order history and marked to the live price at the end.

What it cannot see, and this matters: Robinhood exposes no deposit or withdrawal
record here, so this is a P&L curve, not an account-balance curve, and a
withdrawal will never appear as a decline. It is sampled only at the moments you
traded, so a crash between two fills is invisible. It reaches back only as far as
the order history the API returns, and a sell with no matching buy in that window
is excluded rather than guessed at. Assets quoted in something other than USD are
treated as USD.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | no | Limit the reconstruction to one trading pair. Omit for the whole account. |

### `risk_position_size`
Work out how much to buy so that being stopped out costs a chosen fraction of the
account. Equity comes from the real holdings priced live unless you override it,
the entry defaults to the live price, and the stop is given either as a price or
as a distance in percent. The returned quantity is rounded **down** to the venue
increment, so it is a size that can actually be submitted. It fails rather than
guesses if equity, the entry price, or the venue increment cannot be determined.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | yes | Trading pair, e.g. `BTC-USD`. |
| `risk_percent` | `number` | yes | Percent of account equity to lose if the stop is hit, e.g. 1. |
| `stop_price` | `number` | no | Absolute stop price. Give this or `stop_distance_percent`, not both. |
| `stop_distance_percent` | `number` | no | Stop distance below entry as a percent of entry, e.g. 5. |
| `entry_price` | `number` | no | Entry price. Defaults to the live ask. |
| `account_value_usd` | `number` | no | Override the equity the risk is measured against. Defaults to live holdings. |

### `risk_limits_export`
Dump every limit this server enforces, with the environment variable that sets
it, its current value, and what it does when it fires. Use it to answer "why was
that refused" and "what would I change to allow it".

No parameters.

### `risk_kill_switch_engage`
**Halt all execution.** Every order is refused at the executor from the moment
this returns, and every running algo job is paused, so neither a tool call nor a
background strategy can spend anything. The halt is written to disk, so it
survives a restart of this server and of the daemon, and it stays in force until
an operator explicitly releases it. It does **not** cancel resting orders already
at Robinhood: use `cancel_order` for those.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `reason` | `string` | yes | Why execution is being halted. Recorded with the switch and shown on every blocked order. |

### `risk_kill_switch_release`
Resume execution after an emergency stop: orders are accepted again, subject to
the usual limits, and the jobs this switch paused are set running again. Jobs
paused for any other reason are left alone. Check `risk_status` first and satisfy
yourself the reason it was engaged no longer applies.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `confirm` | `boolean` | yes | Must be `true`. Releasing the halt re-enables real orders. |

---

## `journal` (read-only, off by default)

What actually happened, derived from filled order history. Enable with
`ROBINHOOD_MCP_MODULES=...,journal`.

Round trips here are grouped flat-to-flat, which is a different unit from the
`portfolio` module's FIFO disposals. Both say so in their descriptions.

### `journal_fills`
List every execution in the account: time, pair, side, quantity, price, and
notional. This is the raw tape, one row per fill rather than one row per order,
because a single order can execute at many prices and the average hides that.
Derived from filled orders returned by the API, so transfers in from another
venue, staking rewards and airdrops do not appear.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | no | Limit to one trading pair. Omit for all pairs. |
| `start` | `string` | no | Only fills at or after this ISO 8601 time. |
| `end` | `string` | no | Only fills at or before this ISO 8601 time. |
| `limit` | `integer` | no (default `100`) | Maximum rows to return. Page with `offset` for more. |
| `offset` | `integer` | no (default `0`) | Row offset for paging. |
| `order` | `"newest_first" \| "oldest_first"` | no (default `newest_first`) | Sort direction by execution time. |

### `journal_trade_history`
Group executions into round-trip trades: a position from the first fill that
opened it to the fill that closed it flat, with holding period and realized P&L
for the whole trade. This is the unit a trader reviews, and it is deliberately
not the same as a tax lot: `get_realized_pnl` matches individual FIFO lots for
reporting, this matches whole positions for reviewing decisions. A position still
open reports a null P&L rather than a mark-to-market guess.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | no | Limit to one trading pair. |
| `start` | `string` | no | Only trades opened at or after this time. |
| `end` | `string` | no | Only fills at or before this time. |
| `include_open` | `boolean` | no (default `true`) | Include the position that is still open, if any. |
| `limit` | `integer` | no (default `100`) | Maximum rows. |
| `offset` | `integer` | no (default `0`) | Row offset for paging. |

### `journal_performance`
Aggregate performance over closed round-trip trades: total trades, win rate,
average win, average loss, profit factor, largest win and largest loss, broken
out per pair and overall.

Derived from Robinhood order history only. It excludes external transfers,
deposits and withdrawals, assets moved in from another venue, staking rewards and
airdrops, and it is before fees and taxes, so it is not a statement of account
performance. It measures the trades this account executed.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | no | Limit to one trading pair. |
| `start` | `string` | no | ISO 8601 lower bound, compared in UTC. |
| `end` | `string` | no | ISO 8601 upper bound, compared in UTC. |

### `journal_daily_summary`
Per-day traded volume, buy and sell counts, and net realized P&L, in UTC days.
Realized P&L is attributed to the day a round trip closed, not spread across the
days it was held, so a day with a large number is the day a position was exited.
Days with no activity are omitted rather than emitted as zeroes.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | no | Limit to one trading pair. |
| `start` | `string` | no | ISO 8601 lower bound, compared in UTC. |
| `end` | `string` | no | ISO 8601 upper bound, compared in UTC. |
| `limit` | `integer` | no (default `90`) | Maximum days to return, most recent first. |

### `journal_open_orders`
List every order currently working, with its age, its resting price, how far that
price sits from the live market, and whether it looks stale. A stale order is one
that is both old and far from the market: it is not protecting anything and not
going to fill, but it is still capital the account cannot use. Distance is
measured against the side the order would actually cross, so a buy is compared to
the ask. An order whose price or market cannot be resolved is reported with
`stale=null` rather than a guess.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | `string` | no | Limit to one trading pair. |
| `stale_after_hours` | `number` | no (default `24`) | An order must be at least this old to count as stale. |
| `stale_distance_percent` | `number` | no (default `5`) | And at least this far from the market, in percent. |

### `journal_reconcile`
Compare what this toolkit recorded that it submitted against what Robinhood
actually reports, and list every disagreement. This is the audit an operator runs
after a crash, a restart or an unexplained position. An intent is written to the
local job database **before** the order is sent, so a crash in between leaves a
record with no order, and the opposite (an order that exists while the local
record says it failed) is the dangerous case worth finding. Absence is never
inferred from an incomplete search: if the order history could not be walked far
enough back, the verdict is "unresolved", not "missing".

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `database_path` | `string` | no | Job database to audit. Defaults to `ROBINHOOD_MCP_DB` or `~/.robinhood-mcp/jobs.db`. |
| `include_matched` | `boolean` | no (default `false`) | Also list the intents that agree with Robinhood, not just the discrepancies. |

### `journal_export_csv`
Render fills or round-trip trades as RFC 4180 CSV text for the user to save to a
file. Fields containing a comma, a quote or a newline are quoted and internal
quotes doubled, and a field that would otherwise be read as a spreadsheet formula
is neutralised. This tool returns the CSV as text; it writes nothing to disk, so
the caller is responsible for saving it.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `format` | `"fills" \| "trades"` | yes | `fills` for one row per execution, `trades` for one row per round trip. |
| `symbol` | `string` | no | Limit to one trading pair. |
| `start` | `string` | no | ISO 8601 lower bound, compared in UTC. |
| `end` | `string` | no | ISO 8601 upper bound, compared in UTC. |
| `limit` | `integer` | no (default `2000`) | Maximum rows, most recent first. |

---

## `ops` (read-only, off by default)

Diagnostics, for when the server is the thing that is broken. Deliberately
resilient: these are what someone runs after a 401 or a crash, so they degrade to
a failing check rather than an exception. Enable with
`ROBINHOOD_MCP_MODULES=...,ops`.

### `ops_health`
Run the full startup check: credentials configured, private key usable, API
reachable, signature accepted, account resolvable. Each check reports pass, fail
or unknown, and every failure carries the specific remediation for that failure
rather than a generic error. Run this first whenever anything is not working. A
check reports "unknown" when it could not be performed, which is not the same as
passing and is never reported as one.

No parameters.

### `ops_clock_skew`
Compare this machine's clock to Robinhood's, using the `Date` header on an API
response. Every request is signed over a Unix timestamp and Robinhood rejects a
signature more than 30 seconds old, so a drifting clock is one of the most common
causes of a 401 that looks like a bad key. The measurement uses an
unauthenticated request on purpose, so it still works when signing does not.
Accuracy is bounded by the round trip and by the header's one-second resolution,
so a sub-second reading is noise, not signal.

No parameters.

### `ops_key_check`
Print the **public** key derived from the configured private key, so it can be
compared character for character against the key registered at
robinhood.com/account/crypto. A mismatch here is the single most common cause of
a 401. The private key and the API key are never printed, only a non-reversible
fingerprint of the API key so two installations can be told apart.

No parameters.

### `ops_rate_limit`
Report the client-side token bucket and the limits Robinhood documents: 100
requests per minute with a burst of 300. The bucket is a floor that keeps a
well-behaved client under the global ceiling, not a mirror of Robinhood's
accounting: the documented limits are per endpoint and vary, so a 429 is still
possible while the local bucket shows tokens available. If the live token count
cannot be read it is reported as unknown rather than assumed full.

No parameters.

### `ops_api_version`
Report which Robinhood API version this server is configured for, what differs
between v1 and v2, and how to switch. The differences are not cosmetic: v2 orders
count toward fee tiers and report fee information, most v2 endpoints require an
`account_number` query parameter, `estimated_price` moves from `/marketdata/` to
`/trading/`, and v2 reports a partly-filled order as `pending` where v1 says
`partially_filled`.

No parameters.

### `ops_supervisor_status`
Report whether durable jobs are actually being advanced: is the supervisor
ticking in this process, how many jobs sit in each status, when the next one is
due, and whether the standalone daemon is needed. This is the check for the
failure that produces no error at all, where jobs exist and look healthy but
nothing is moving them because the process that owned the tick loop exited. A
TWAP that is not ticking is not slow, it is stopped.

No parameters.

### `ops_jobs_pending_intents`
List order intents that were reserved but never settled. Each intent is written
to the local database **before** the order is sent, so a row still marked pending
means the process died somewhere between reserving and recording the outcome, and
the order may or may not exist at Robinhood. This is the first thing to check
after a crash.

Do **not** resubmit these by hand: reconciliation looks each one up by its
`client_order_id` and adopts the order if it exists, and a manual resubmit under a
new id is how one intended fill becomes two real ones. Use `journal_reconcile`
for the full comparison against Robinhood.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | `integer` | no (default `50`) | Maximum intents to return. |

### `ops_diagnostics`
Run health, clock skew, key check and API version in one call and return them as
a single document to paste into a bug report or an issue. Every section is
collected independently, so one failing section does not lose the others, and the
whole document is scrubbed of credential material before it is returned: it
contains the public key (which is meant to be shared) and never the private key
or the API key. Read the output before sharing it anyway, as a habit worth
keeping.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `include_jobs` | `boolean` | no (default `true`) | Include durable job counts, when this server has an engine. |

---

## `dev` (read-only, off by default)

Builder tools. Every way this API rejects a request surfaces as an opaque 401, so
these exist to name the actual cause: key format, clock skew, a signature over
the wrong bytes, a missing scope. Enable with `ROBINHOOD_MCP_MODULES=...,dev`.

### `diagnose_connection`
Run every check that distinguishes the common causes of a 401 against this API:
key format, derived public key, clock skew, and whether a live authenticated call
actually succeeds. Run this **first** when anything returns 401 or 403, instead
of guessing. Never returns secret material.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `check_live` | `boolean` | no (default `true`) | Make one real authenticated request to confirm the credential works. |

### `check_environment`
Report which configuration variables are set and what each one currently does,
without printing any secret value. Use it to answer "why is trading disabled" or
"why was my order rejected" before changing anything.

No parameters.

### `generate_keypair`
Generate a fresh Ed25519 keypair in the format Robinhood expects. Register the
**public** key at robinhood.com/account/crypto (web classic only) and Robinhood
issues an API key in return. The private key is returned once and never stored:
treat it like a password.

No parameters.

### `verify_keypair`
Check whether a private key corresponds to a given public key, without sending
anything anywhere. Use it when a 401 might mean the configured private key
belongs to a different credential than the one registered with Robinhood.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `private_key` | `string` | yes | Base64 32-byte Ed25519 seed to test. |
| `expected_public_key` | `string` | yes | The public key registered with Robinhood, to compare against. |

### `explain_signature`
Show exactly what gets signed for a given request: the concatenated message, its
components, and the resulting header. Use it when building a client in another
language and its signatures are rejected, to compare byte for byte. Uses the
configured credential but never reveals the private key.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `method` | `"GET" \| "POST"` | yes | HTTP method, uppercase. |
| `path` | `string` | yes | Path including query string and trailing slash, e.g. `/api/v1/crypto/trading/accounts/`. |
| `body` | `string` | no | Exact JSON body as it will be sent. Omit for GET. |
| `timestamp` | `integer` | no | Unix seconds. Defaults to now. Fix it to reproduce a past signature. |

### `generate_client_code`
Emit a runnable, correctly signed request in Python, TypeScript, or curl for any
endpoint. Use it when a user wants to call the API from their own code rather
than through this server. The signing logic is the same one this server uses.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `language` | `"python" \| "typescript" \| "curl"` | yes | Target language. |
| `method` | `"GET" \| "POST"` | no (default `GET`) | HTTP method. |
| `path` | `string` | no (default `/api/v1/crypto/trading/accounts/`) | Path including trailing slash. |
| `body` | `string` | no | JSON body for a POST. |

---

## `list_modules` (always registered)

List which capability modules are loaded and which exist but are switched off. If
a capability you need is listed as available but not loaded, the tool tells you
which `ROBINHOOD_MCP_MODULES` value would enable it, so an agent can say "that is
one env var away" rather than "that is impossible".

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `include_disabled` | `boolean` | no (default `true`) | Include modules that exist but are not loaded in this server. |
