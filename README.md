[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/giandisruw/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/giandisruw/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Clean-Sharpe — Pump.fun Sharpe Sprint

A low-variance paper-trading bot for the make.fun **Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins** bounty. One strategy program, `main.ts` on Node 22, speaking the `agent-fun/replay/v2` protocol. It trades paper SOL on a 6-hour pump.fun forward replay; places go by **hourly Sharpe ratio**, best first, and a placement reward needs net PnL above holding cash (above 0 after every fee).

## Strategy

Steady, controlled gains over one lucky moonshot:

- **Buy the dip on liquid curves only** — price 30–45% below its 2500-slot high, curve holding ≥ 25 SOL of real reserves, the last 6 trades include ≥ 3 buys and the most recent trade is a buy. Fresh curves mostly dump after their first run, so chasing momentum loses; the bounce after a dip on a liquid curve is where the edge is.
- **Start small, add in tranches** — first buy 0.20 SOL, add-ons of 0.05 SOL while the price stays within 5% of the first entry, up to 1.00 SOL per coin, at most 2 SOL at cost across all positions, at most 2 new entries per batch.
- **Cut losers fast, bank winners early** — 20% take-profit, exit on recovering half the dip gap (once up > 3%), 10% stop-loss, 600-slot time limit. Buys allow 1500 bps of slippage so entries fill instead of being rejected inside the 2-slot latency, and are sized at 97% of the per-reply size cap.
- **Guardrail pacing** — tiny 0.01 SOL probe round trips keep the run above the minimum bar (≥ 20 distinct mints, round trips ≥ 0.01 SOL) when fills or coins lag the pace of the 6-hour window.

Local dev-window grade (kit's `grade-local`, process driver): **net PnL +0.52 SOL, Sharpe (hourly) +0.10, max drawdown 6.7%, 612 fills, 79 distinct mints, 159 round trips, 19.5% win rate** — the only variant tested with a positive Sharpe and a positive PnL on the dev window (house momentum pilot: −9.44 SOL / −0.58; house reversion pilot: −3.99 SOL / −0.48; house sniper pilot: −0.50 SOL / −0.84).

Deterministic by construction: no clock, no randomness, no network calls. Two runs on the same window produce byte-identical action logs.

## Files

- `main.ts` — entrypoint (run by the grader as `node /bot/main.ts`)
- `strategy.ts` — the Clean-Sharpe strategy
- `vendor/makefun-bot.ts` — the kit's TypeScript SDK shim, vendored byte for byte
- `.makefun/owner.json` — claim file for the entry wallet

## Local grade

From the unpacked kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process --worktree
```

## Referral

Built for make.fun — join with referral code `0txwmf1m`.
