---
name: robinhood-crypto-readonly
description: Read a Robinhood Crypto account through the read-only robinhood-mcp data server: account and buying power, holdings, best bid and ask, depth-aware price estimates, trading pairs, order history, cost basis and P&L. Use when the user wants crypto portfolio or quote data from Robinhood Crypto.
---

# Robinhood Crypto, read-only

This plugin's `.mcp.json` starts the data server of the `robinhood-mcp` package with `npx -y robinhood-mcp`. That binary registers no tool that can place an order, so attaching it cannot trade. It targets the official Robinhood Crypto Trading API at `trading.robinhood.com`. Requires Node.js.

## Credentials

Create an API credential on the Robinhood web classic crypto account page (https://robinhood.com/account/crypto) with only the permissions you need (read access is enough). Generate the Ed25519 keypair with `npx -y -p robinhood-mcp robinhood-keygen`, register the PUBLIC key with Robinhood, and keep the private key to yourself.

Export these in your own shell before starting Claude Code:

- `ROBINHOOD_CRYPTO_API_KEY`: the API key Robinhood issues. This plugin passes it to the server.
- `ROBINHOOD_CRYPTO_PRIVATE_KEY`: the base64 32-byte Ed25519 seed. It is deliberately not listed in the plugin config. The server inherits it from your shell. Never paste it into a chat or a file.
- Optional `ROBINHOOD_CRYPTO_API_VERSION`: `v1` (default) or `v2`.
- Optional `ROBINHOOD_MCP_MODULES`: comma-separated modules. Default is `market,portfolio`. The data server can also load `journal`, `ops` and `dev`. It refuses to start if you ask for a trading module (`orders`, `algo`, `risk`).

There is no sandbox: every call hits a real account. Robinhood publishes no test host.

## Tools (default modules)

`market`:
- `get_account`: account number, status, buying power.
- `get_holdings`: optional `asset_codes` such as `["BTC","ETH"]` (base assets, not pairs).
- `get_best_bid_ask`: `symbols` such as `["BTC-USD"]`.
- `get_estimated_price`: `symbol`, `side` (`bid`, `ask` or `both`), `quantities` as decimal strings. Use `ask` to estimate a buy.
- `get_trading_pairs`: optional `symbols`; shows size limits and increments.
- `get_orders`: filters `symbol`, `side`, `type`, `state`, `created_at_start`, `created_at_end`, `limit`.
- `get_order`: `order_id`, including fills.
- `get_connection_info`: API version, base URL and the derived public key. Call it first if authentication fails: the public key must match the one registered with Robinhood.

`portfolio`: `get_cost_basis`, `get_realized_pnl`, `get_allocation`, `size_position_by_risk`, `estimate_slippage`, `analyze_trade_history`, `get_volatility`.

`list_modules` shows what is loaded and what is switched off.

## Workflow

1. Call `get_connection_info`, then `get_account` to confirm credentials work.
2. For a status report, call `get_holdings` and `get_best_bid_ask` for the held assets, then `get_allocation`.
3. For performance, call `get_realized_pnl` or `analyze_trade_history`.
4. Quantities and prices are decimal strings such as `"0.001"`, never floats.

Example: "what is my BTC position worth?" becomes `get_holdings` with `{"asset_codes": ["BTC"]}` and `get_best_bid_ask` with `{"symbols": ["BTC-USD"]}`, then quantity times the bid.

## Trading is a separate, opt-in server

Placing orders needs the `robinhood-mcp-trading` binary, which refuses to start unless `ROBINHOOD_CRYPTO_ENABLE_TRADING=1` and enforces `ROBINHOOD_CRYPTO_MAX_ORDER_USD` (default 100), an optional daily cap, symbol allowlist and buy-only flag. Its order tools return a priced preview and place nothing until called again with `confirm: true`. This plugin does not configure it. If the user wants it, point them at the repo README safety section, and never place an order without showing the pair, side, quantity and estimated cost and getting an explicit yes.
