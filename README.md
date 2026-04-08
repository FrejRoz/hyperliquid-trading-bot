# Hyperliquid grid trading bot

A **Node.js (TypeScript)** grid trading bot for [Hyperliquid](https://hyperliquid.xyz): configurable grid levels, WebSocket mid prices, limit orders via the official API stack, and risk rules (drawdown, position size, optional stop / take profit).

> **Node.js ≥ 20.19** is required (used by `@nktkas/hyperliquid`).

## Features

- **Grid strategy** — geometric price levels, buy below / sell above mid, optional rebalance when price drifts
- **Hyperliquid** — `Info` + `Exchange` clients, testnet or mainnet
- **Risk** — max drawdown, max position as % of account, optional stop-loss and take-profit
- **Config** — YAML files under `bots/` (same style as before), `active: true` for auto-pick
- **Keys** — env vars, optional per-bot fields in YAML (not recommended for production)

## Quick start

```bash
git clone https://github.com/yura-money/hyperliquid-trading-bot.git
npm install
cp .env.example .env   # if you add an example; otherwise create .env (see below)
```

Set your private key (testnet is strongly recommended first):

| Environment | Purpose |
|-------------|---------|
| `HYPERLIQUID_TESTNET_PRIVATE_KEY` | `0x…` key (use Hyperliquid [testnet](https://app.hyperliquid-testnet.xyz) for development) |
| `HYPERLIQUID_MAINNET_PRIVATE_KEY` | mainnet (real funds) |
| `HYPERLIQUID_PRIVATE_KEY` | legacy fallback for both |
| `HYPERLIQUID_TESTNET` | `true` / `false` (default follows `exchange.testnet` in YAML) |

Validate configuration:

```bash
npm run validate
# or
npx tsx src/runBot.ts --validate bots/btc_conservative.yaml
```

Run the bot (picks the first `active: true` file in `bots/`, or pass a path):

```bash
npm start
npx tsx src/runBot.ts bots/btc_conservative.yaml
```

Stop with `Ctrl+C` (open orders are cancelled; positions are left as on the previous Python behaviour).

## Configuration (`bots/*.yaml`)

Key sections:

- **`active`** — `true` so this file is auto-selected when you don’t pass a path  
- **`exchange.type`** — `hyperliquid` or `hl`  
- **`exchange.testnet`** — `true` for `https://api.hyperliquid-testnet.xyz`  
- **`account.max_allocation_pct`** — share of a notional `10_000` USD base used to size `total_allocation` in the engine (see `src/runBot.ts`)  
- **`grid`** — `symbol`, `levels`, `price_range.auto.range_pct`  
- **`risk_management`** — drawdown, position caps, `rebalance.price_move_threshold_pct` for the grid, optional SL/TP  
- **`monitoring.log_level`** — `DEBUG` \| `INFO` \| `WARNING` \| `ERROR`

Edit the sample file: `bots/btc_conservative.yaml`.

## Project layout

```
bots/                    # Bot YAML configs
src/
  runBot.ts              # CLI: validate, run, discover active config
  core/                  # Engine, config loader, keys, risk
  exchanges/             # Hyperliquid adapter + WebSocket market data
  strategies/grid/      # Basic grid strategy
  interfaces/            # Exchange + strategy types
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Run the bot |
| `npm run validate` | Load and validate YAML (uses first active `bots/*.yaml` if no path) |
| `npm run typecheck` | `tsc --noEmit` |

## Stack

- **[@nktkas/hyperliquid](https://www.npmjs.com/package/@nktkas/hyperliquid)** — Info / Exchange / transport  
- **[viem](https://viem.sh)** — wallet from private key  
- **[ws](https://github.com/websockets/ws)** — `allMids` subscription  
- **[js-yaml](https://www.npmjs.com/package/js-yaml)** — configs  
- **[pino](https://getpino.io/)** — structured logs  

## Safety

- Never commit a real private key. Use env vars or a file outside the repo.  
- Test on **testnet** and small size before mainnet.  
- This software is for automation **at your own risk**; the authors are not responsible for trading losses.

## Optional: Python learning examples

The `learning_examples/` folder still contains small **Python** scripts (Hyperliquid API demos). They are independent of the main bot. The main bot is **TypeScript only**.

---

*Legacy Python entry `uv run src/run_bot.py` has been replaced by `npm start` / `npx tsx src/runBot.ts`.*
