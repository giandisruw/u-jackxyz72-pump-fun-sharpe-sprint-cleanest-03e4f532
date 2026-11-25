// Clean-Sharpe: dip-buying for the pump.fun replay.
//
// Ranking is by hourly Sharpe ratio, not by raw PnL, so this bot optimises
// for many small, steady, diversified round trips instead of one lucky
// moonshot. The dev window punishes chasing momentum (the house momentum
// pilot loses 9.4 SOL there, drawdown 95%): fresh curves mostly dump after
// their first run. What shows edge instead is buying the dip on liquid
// curves — a curve holding at least 25 SOL of real reserves that ran up and
// then fell 30-45% from its recent high while buyers are still stepping in
// tends to bounce part of the way back — so this bot buys that dip in small
// tranches and sells on a partial rebound, a tight stop, or a short time
// limit. Small probe trades on weaker curves were tried and dropped: at
// 0.01 SOL a round trip pays ~4.6% in fees alone, which bled the Sharpe
// ratio even when the calls were right.
//
//   - Enter only when the price sits 30-45% below its 2500-slot high, the
//     curve holds at least 25 SOL of real reserves, the last 6 trades
//     include at least 3 buys, and the most recent trade is a buy. No
//     maturity filter: a dip is a dip at any age, as long as a real high
//     exists.
//   - Size is small and capped: first buy 0.20 SOL, add-ons of 0.05 SOL
//     while the price stays within 5% of the first entry, at most 1.00 SOL
//     per coin, at most 2 SOL at cost across all positions. Buys allow
//     1500 bps of slippage so entries actually fill instead of being
//     rejected when the price moves inside the 2-slot latency.
//   - Exit on a 20% take-profit, on recovering half the dip gap (only once
//     the position is actually up more than 3%), on a 10% stop-loss, or
//     after 600 slots held. No outflow exit: after buying a dip, continued
//     selling is normal noise, and cutting on it sells at the worst moment.
//   - Buys are sized at 97% of the per-reply size cap, so the harness never
//     rejects them for the reserves having shifted under our own flow.
//   - At most 2 new entries per batch, 300-slot cooldown, at most 2
//     entries per coin, at most 5 open positions.
// Guardrail pacing keeps the run above the minimum bar (20 distinct mints,
// round trips of at least 0.01 SOL): when fills or coins lag the pace of the
// 6-hour window, the bot opens tiny 0.01 SOL probe round trips on liquid
// curves and closes them as soon as the buy lands.
//
// Deterministic by construction: no clock, no randomness, no network. State
// is kept in insertion-ordered maps fed only by the batch stream, so two runs
// on the same window produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Lookback, in slots, for the recent high the dip is measured from. */
  highWindow: number;
  /** Enter when price is at least this far below the recent high (fraction). */
  dipMin: number;
  /** ...and not further than this (a dip, not a collapse). */
  dipMax: number;
  /** The curve must hold at least this much real SOL at decision time. */
  minRealSol: number;
  /** The recent high must have come with at least this much real SOL. */
  minHighRealSol: number;
  /** Of the last `flowTrades` trades at least `minBuys` must be buys... */
  flowTrades: number;
  minBuys: number;
  /** ...and the most recent trade must be a buy (the dip is being bought). */
  lastMustBeBuy: boolean;
  /** Net SOL over the last `flowTrades` trades must be at least this. */
  minNetFlow: number;
  /** First buy of a position (SOL). */
  firstSol: number;
  /** Total SOL a position may hold at most. */
  stakeSol: number;
  /** Add-on tranche (SOL). */
  addSol: number;
  /** Add tranches only while the price stays within this fraction of the
   *  first entry price. */
  addBand: number;
  /** Smallest buy worth sending (SOL). */
  minBuySol: number;
  /** Slippage allowance on buys, in bps; sells always go out at 10000. */
  buySlipBps: number;
  /** Take profit when value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Or when the price recovers this share of the gap between entry price
   *  and the recent high, once the position is up more than recoverMinGain. */
  recoverShare: number;
  recoverMinGain: number;
  /** Stop when value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Exit after holding this many slots regardless. */
  maxHold: number;
  /** Most new entries per batch. */
  maxEntriesPerBatch: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the whole run. */
  maxEntries: number;
  /** Most dip positions open at once (the rest of the position cap is
   *  reserved for guardrail probes). */
  maxMain: number;
  /** Most SOL at cost across all positions at once (exposure guard). */
  maxExposureSol: number;
  /** Guardrail pacing targets over paceSecs of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  /** Size of a guardrail probe round trip (SOL). */
  probeSol: number;
  /** Most probe round trips open at once. */
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  highWindow: 2500,
  dipMin: 0.3,
  dipMax: 0.45,
  minRealSol: 25,
  minHighRealSol: 3,
  flowTrades: 6,
  minBuys: 3,
  lastMustBeBuy: true,
  minNetFlow: 0,
  firstSol: 0.2,
  stakeSol: 1.0,
  addSol: 0.05,
  addBand: 0.05,
  minBuySol: 0.008,
  buySlipBps: 1500,
  takeProfit: 0.2,
  recoverShare: 0.5,
  recoverMinGain: 0.03,
  stopLoss: 0.1,
  maxHold: 600,
  maxEntriesPerBatch: 2,
  cooldown: 300,
  maxEntries: 2,
  maxMain: 5,
  maxExposureSol: 2,
  targetCoins: 30,
  targetFills: 300,
  paceSecs: 21_600,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
/** Protocol (0.95%) + creator (0.30%) fee taken on every curve trade. */
const CURVE_FEE = 0.0125;

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  price: number;
  realSol: number;
}

interface Tape {
  created: number | null;
  ticks: Tick[];
  entries: number;
  lastExit: number;
}

interface Open {
  opened: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  entryPrice: number;
  entryHigh: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const open = new Map<Pubkey, Open>();
  /** Probe round trips in flight: false while the buy is pending, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = p.highWindow + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, ticks: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Recent high (price and the real SOL behind it) over the high window. */
  const recentHigh = (t: Tape, now: number): { price: number; realSol: number } => {
    let price = 0;
    let realSol = 0;
    for (const tr of t.ticks) {
      if (tr.slot <= now - p.highWindow) continue;
      if (tr.price > price) {
        price = tr.price;
        realSol = tr.realSol;
      }
    }
    return { price, realSol };
  };

  /** Dip entry signal. Returns the recent high when the dip qualifies. */
  const dipSignal = (t: Tape, now: number, price: number, realSol: number): number | null => {
    if (realSol < p.minRealSol) return null;
    const high = recentHigh(t, now);
    if (high.price <= 0 || high.realSol < p.minHighRealSol) return null;
    const dip = 1 - price / high.price;
    if (dip < p.dipMin || dip > p.dipMax) return null;
    const n = t.ticks.length;
    if (n < p.flowTrades) return null;
    const last = t.ticks.slice(n - p.flowTrades);
    let buys = 0;
    let net = 0;
    for (const tr of last) {
      if (tr.buy) buys++;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    if (buys < p.minBuys) return null;
    if (p.lastMustBeBuy && !t.ticks[n - 1]!.buy) return null;
    if (net < p.minNetFlow) return null;
    return high.price;
  };

  /** Mark-to-market value of a position in SOL, curve fee and tx fee deducted. */
  const valueOf = (tokens: number, vq: number, vt: number, txSol: number): number =>
    ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - txSol;

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          t.ticks.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(e.sol_amount) / LAMPORTS,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
            realSol: Number(e.real_quote_reserves) / LAMPORTS,
          });
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.ticks.length && t.ticks[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.ticks.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;
      /** The per-reply buy cap with a margin: the harness checks it against
       *  reserves shifted by our own earlier flow, which can sit a little
       *  below the recorded ones. */
      const buyCapSol = (mint: Pubkey): number =>
        (Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS) * 0.97;

      // --- Exits first: take-profit, dip recovery, stop-loss, time limit.
      for (const [mint, h] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            open.delete(mint);
            if (h.filled) tapeOf(mint).lastExit = now;
            else tapeOf(mint).entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const price = vq / vt;
        const value = valueOf(Number(pos.token_amount), vq, vt, tx);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        const gain = cost > 0 ? value / cost - 1 : 0;
        let exit = h.exiting;
        if (!exit && gain >= p.takeProfit) exit = true;
        if (
          !exit &&
          price >= h.entryPrice + p.recoverShare * (h.entryHigh - h.entryPrice) &&
          gain > p.recoverMinGain
        ) {
          exit = true;
        }
        if (!exit && gain <= -p.stopLoss) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // --- Probe round trips: sell the whole probe as soon as its buy lands.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // --- Entries and add-on tranches.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - open.size;
      let exposure = 0;
      for (const [mint, h] of open) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      let entries = 0;
      for (const mint of traded) {
        if (orders.length >= cap || entries >= p.maxEntriesPerBatch) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = open.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        let entryHigh = 0;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          const high = dipSignal(t, now, price, realSol);
          if (high === null) continue;
          entryHigh = high;
          want = Math.min(p.firstSol, p.stakeSol);
        } else {
          // Add a tranche only while the price stays near the first entry.
          if (h.exiting || !h.filled || h.invested >= p.stakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.entryPrice * (1 - p.addBand) || price > h.entryPrice * (1 + p.addBand)) continue;
          want = Math.min(p.addSol, p.stakeSol - h.invested);
        }
        let amount = Math.min(buyCapSol(mint), want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          open.set(mint, {
            opened: now,
            invested: amount,
            exiting: false,
            filled: false,
            entryPrice: price,
            entryHigh,
          });
          t.entries++;
          slotsLeft--;
          mainLeft--;
          entries++;
        } else {
          h.invested += amount;
        }
      }

      // --- Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minReal = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minReal * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
