import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { alpaca, sb, log, json, strategyEquity, riskGate, authorized } from "./_shared/alpaca.ts";

type Bar = { t: string; o: number; h: number; l: number; c: number; v: number };
type Cfg = {
  tickers: string[]; target_pct: number; stop_pct: number; max_hold_min: number; max_positions: number;
  vwap_dip_pct: number; breakout_bars: number; vol_mult: number; spread_pct: number; pdt_cap?: number; fee_pct_side?: number;
  trail_arm_pct?: number; trail_pct?: number; // D: trailing stop instead of fixed target
  maker_fee_pct_side?: number; // fee when our resting limit order fills
  trend_bars?: number; trend_min_pct?: number; // skip entries when 1h trend is down
  dip_atr_mult?: number; dip_min_pct?: number; // dip threshold = max(dip_min_pct, dip_atr_mult * avg 1-min range)
};

/** Runs every minute. ?strategy=B (stocks, market hours), C (crypto, fixed target) or D (crypto, trailing stop). */
Deno.serve(async (req) => {
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  const id = new URL(req.url).searchParams.get("strategy");
  if (id !== "B" && id !== "C" && id !== "D") return json({ error: "strategy must be B, C or D" }, 400);
  const crypto = id !== "B";

  // flatten-all?
  const { data: ctl } = await sb.from("control").select("*").eq("id", 1).single();
  if (ctl?.flatten_requested) {
    await flattenAll(id);
    return json({ ok: true, message: "flattened" });
  }

  const { data: s } = await sb.from("strategies").select("*").eq("id", id).single();
  const cfg = s!.config as Cfg;

  if (!crypto) {
    const clock = await alpaca.clock();
    if (!clock.is_open) return json({ ok: true, message: "market closed" });
    const now = new Date(); const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const mins = et.getHours() * 60 + et.getMinutes();
    if (mins < 9 * 60 + 45 || mins > 15 * 60 + 45) return json({ ok: true, message: "outside 9:45-15:45 ET" });
  }

  const start = new Date(Date.now() - 90 * 60e3).toISOString();
  const bars = crypto ? await alpaca.cryptoBars(cfg.tickers, "1Min", start) : await alpaca.stockBars(cfg.tickers, "1Min", start);
  const quotes = crypto ? await alpaca.cryptoQuotes(cfg.tickers) : await alpaca.stockQuotes(cfg.tickers);
  const mark: Record<string, number> = {};
  const spread: Record<string, number> = {};
  for (const t of cfg.tickers) {
    const q = quotes.quotes?.[t]; if (!q) continue;
    const bid = q.bp, ask = q.ap; mark[t] = (bid + ask) / 2;
    spread[t] = bid && ask ? ((ask - bid) / ((ask + bid) / 2)) * 100 : 99;
  }

  const { equity, open } = await strategyEquity(id, mark);
  const feeSide = (cfg.fee_pct_side ?? 0) / 100;
  const makerSide = (cfg.maker_fee_pct_side ?? cfg.fee_pct_side ?? 0) / 100;

  // ---- manage open positions first (exits always allowed, even if halted) ----
  const stale: any[] = []; // past max_hold but not losing: keep unless a new signal needs the slot
  const hardCapMin = (cfg.max_hold_min ?? 90) * 16; // 24h for a 90-min strategy
  for (const t of open) {
    const px = mark[t.ticker]; if (!px) continue;
    const entry = Number(t.entry_price);
    // resting take-profit filled between ticks?
    if ((t as any).tp_order_id) {
      const tp = await alpaca.order((t as any).tp_order_id);
      if (tp.status === "filled") { await closeFromFill(id, t, tp, "target", makerSide); continue; }
      if (["canceled", "rejected", "expired"].includes(tp.status)) await sb.from("trades").update({ tp_order_id: null }).eq("id", t.id);
    }
    const chg = (px / entry - 1) * 100;
    const held = (Date.now() - new Date((t as any).entered_at ?? Date.now()).getTime()) / 60e3;
    let reason: string | null = null;
    if (cfg.trail_pct != null) {
      // trailing stop: once up trail_arm_pct, stop follows the high by trail_pct
      const hw = Math.max(Number((t as any).high_water ?? entry), px);
      if (hw !== Number((t as any).high_water ?? 0)) await sb.from("trades").update({ high_water: hw }).eq("id", t.id);
      const armed = (hw / entry - 1) * 100 >= cfg.trail_arm_pct!;
      if (armed && (px / hw - 1) * 100 <= -cfg.trail_pct!) reason = "trail";
      else if (!armed && chg <= -cfg.stop_pct) reason = "stop";
      else if (held >= hardCapMin) reason = "time cap";
      else if (held >= cfg.max_hold_min && !armed) stale.push({ ...t, px, held });
    } else {
      if (chg >= cfg.target_pct && !(t as any).tp_order_id) reason = "target"; // fallback if no resting TP
      else if (chg <= -cfg.stop_pct) reason = "stop";
      else if (held >= hardCapMin) reason = "time cap";
      else if (held >= cfg.max_hold_min) stale.push({ ...t, px, held });
    }
    if (reason) await exitTrade(id, t, px, reason, feeSide, !crypto);
  }
  stale.sort((a, b) => b.held - a.held); // oldest first

  const gate = await riskGate(id, equity);
  if (gate) {
    // only log real risk events, not the routine "not armed" idle state
    if (gate !== "not armed") await sb.from("signals").insert({ strategy_id: id, ticker: "*", rule: "risk_gate", price: 0, acted: false, skip_reason: gate });
    return json({ ok: true, message: gate });
  }

  const { data: openNow } = await sb.from("trades").select("ticker").eq("strategy_id", id).is("exited_at", null);
  let slots = cfg.max_positions - (openNow?.length ?? 0);
  if (slots <= 0 && !stale.length) return json({ ok: true, message: "max positions" });

  let pdtLeft = Infinity;
  if (!crypto && cfg.pdt_cap && equity < 25000) {
    const { data: n } = await sb.rpc("day_trade_count", { p_strategy: id });
    pdtLeft = cfg.pdt_cap - (n as number);
  }

  // ---- entries ----
  for (const sym of cfg.tickers) {
    if (slots <= 0 && !stale.length) break;
    if (openNow?.some((o) => o.ticker === sym)) continue;
    const b: Bar[] = bars.bars?.[sym] ?? [];
    if (b.length < cfg.breakout_bars + 2) continue;
    const px = mark[sym]; if (!px) continue;

    const last = b.at(-1)!, prev = b.at(-2)!;
    const w20 = b.slice(-20);
    const vwap = w20.reduce((a, x) => a + ((x.h + x.l + x.c) / 3) * x.v, 0) / Math.max(1, w20.reduce((a, x) => a + x.v, 0));
    const dipPct = (vwap / px - 1) * 100; // how far below vwap we are
    // adaptive dip threshold: a quiet coin needs a smaller dip than a wild one
    const avgRangePct = w20.reduce((a, x) => a + ((x.h - x.l) / x.c) * 100, 0) / w20.length;
    const dipThresh = cfg.dip_atr_mult ? Math.max(cfg.dip_min_pct ?? 0.4, cfg.dip_atr_mult * avgRangePct) : cfg.vwap_dip_pct;
    const dipHit = dipPct >= dipThresh && last.c > last.o && prev.c <= prev.o;

    // 1-hour trend filter: breakouts and dips both fail more in a falling market
    const tb = cfg.trend_bars ?? 60;
    const trendPct = b.length > tb ? (last.c / b.at(-tb - 1)!.c - 1) * 100 : 0;
    const sma = b.slice(-tb).reduce((a, x) => a + x.c, 0) / Math.min(tb, b.length);
    const downtrend = trendPct < (cfg.trend_min_pct ?? -0.5) && last.c < sma;

    const win = b.slice(-(cfg.breakout_bars + 1), -1);
    const hi = Math.max(...win.map((x) => x.h));
    const avgVol = win.reduce((a, x) => a + x.v, 0) / win.length;
    const brkHit = last.c > hi && last.v >= cfg.vol_mult * avgVol;

    const rule = dipHit ? "vwap_dip" : brkHit ? "breakout" : null;
    if (!rule) continue;

    let skip: string | null = null;
    if (spread[sym] > cfg.spread_pct) skip = `spread ${spread[sym].toFixed(3)}%`;
    else if (downtrend) skip = `downtrend ${trendPct.toFixed(2)}%/1h`;
    else if (pdtLeft <= 0) skip = "PDT cap";
    const { data: sig } = await sb.from("signals").insert({ strategy_id: id, ticker: sym, rule, price: px, acted: !skip, skip_reason: skip, detail: { vwap, dipPct, dipThresh, avgRangePct, trendPct, hi, vol: last.v, avgVol, spread: spread[sym] } }).select().single();
    if (skip) continue;

    // no free slot but a stale trade is sitting idle: that one makes way for this signal
    if (slots <= 0) {
      const old = stale.shift()!;
      await exitTrade(id, old, old.px, "time (slot needed)", feeSide, !crypto);
      slots++;
    }

    const notional = Math.min(equity * 0.30, equity / cfg.max_positions);
    const qty = crypto ? +(notional / px).toFixed(6) : Math.floor(notional / px);
    if (qty <= 0) continue;

    const limit = crypto ? +(px * 1.0005).toFixed(2) : +(px * 1.0003).toFixed(2);
    const o = await alpaca.submit({ symbol: sym, qty, side: "buy", type: "limit", limit_price: limit, time_in_force: crypto ? "gtc" : "day", client_order_id: `${id}-${Date.now()}-${sym.replace("/", "")}` });
    const { data: row } = await sb.from("orders").insert({ alpaca_order_id: o.id, strategy_id: id, signal_id: sig!.id, ticker: sym, side: "buy", qty, limit_price: limit, status: o.status, raw: o }).select().single();

    // wait up to 15s for fill
    let filled: any = null;
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const st = await alpaca.order(o.id);
      if (st.status === "filled") { filled = st; break; }
      if (["canceled", "rejected", "expired"].includes(st.status)) break;
    }
    if (!filled) {
      try { await alpaca.cancel(o.id); } catch { /* already done */ }
      await sb.from("orders").update({ status: "canceled", cancelled_at: new Date().toISOString() }).eq("id", row!.id);
      await sb.from("signals").update({ acted: false, skip_reason: "unfilled 15s" }).eq("id", sig!.id);
      continue;
    }
    const fillPx = Number(filled.filled_avg_price);
    let fq = Number(filled.filled_qty);
    if (crypto) {
      // Alpaca deducts the crypto buy fee from the coin itself; sell what we actually hold
      try { const pos = await alpaca.position(sym); fq = Math.min(fq, Number(pos.qty_available ?? pos.qty)); } catch { /* keep filled qty */ }
    }
    await sb.from("orders").update({ status: "filled", filled_at: filled.filled_at, filled_price: fillPx }).eq("id", row!.id);
    const entryFee = fillPx * fq * (filled.order_type === "limit" && Number(filled.filled_avg_price) < limit ? makerSide : feeSide);
    const { data: tr } = await sb.from("trades").insert({ strategy_id: id, ticker: sym, entry_order_id: row!.id, entry_price: fillPx, qty: fq, signal_price: px, entered_at: filled.filled_at, fees: entryFee, slippage: (fillPx / px - 1) * 100 }).select().single();
    // fixed-target strategies: rest a take-profit limit sell so spikes between ticks get caught at maker fee
    if (cfg.trail_pct == null && cfg.target_pct) {
      try {
        const tpPx = +(fillPx * (1 + cfg.target_pct / 100)).toFixed(crypto ? 2 : 2);
        const tp = await alpaca.submit({ symbol: sym, qty: fq, side: "sell", type: "limit", limit_price: tpPx, time_in_force: crypto ? "gtc" : "day", client_order_id: `${id}-tp-${Date.now()}-${sym.replace("/", "")}` });
        await sb.from("trades").update({ tp_order_id: tp.id }).eq("id", tr!.id);
        await sb.from("orders").insert({ alpaca_order_id: tp.id, strategy_id: id, ticker: sym, side: "sell", qty: fq, limit_price: tpPx, status: tp.status, raw: tp });
      } catch (e) { await log(id, "warn", `TP order failed for ${sym}: ${String(e).slice(0, 200)}`); }
    }
    await log(id, "info", `BUY ${sym} ${fq} @ ${fillPx} (${rule})`);
    slots--; if (!crypto) pdtLeft--;
  }
  return json({ ok: true });
});

async function closeFromFill(id: string, t: any, st: any, reason: string, exitFeeSide: number) {
  const sym = t.ticker as string;
  const exitPx = Number(st.filled_avg_price);
  const qty = Number(st.filled_qty || t.qty), entry = Number(t.entry_price);
  await sb.from("orders").update({ status: "filled", filled_at: st.filled_at, filled_price: exitPx }).eq("alpaca_order_id", st.id);
  const { data: row } = await sb.from("orders").select("id").eq("alpaca_order_id", st.id).single();
  const gross = (exitPx - entry) * qty;
  const fees = Number(t.fees ?? 0) + exitPx * qty * exitFeeSide;
  const enteredAt = new Date(t.entered_at);
  await sb.from("trades").update({
    exit_order_id: row?.id ?? null, exit_price: exitPx, exited_at: st.filled_at ?? new Date().toISOString(),
    gross_pnl: gross, fees, net_pnl: gross - fees, hold_seconds: Math.round((new Date(st.filled_at ?? Date.now()).getTime() - enteredAt.getTime()) / 1000),
    exit_reason: reason, tp_order_id: null,
  }).eq("id", t.id);
  await log(id, "info", `SELL ${sym} ${qty} @ ${exitPx} (${reason}, resting order) net ${(gross - fees).toFixed(2)}`);
}

async function exitTrade(id: string, t: any, px: number, reason: string, feeSide: number, stocks: boolean) {
  const sym = t.ticker as string;
  if (t.tp_order_id) { try { await alpaca.cancel(t.tp_order_id); } catch { /* may have just filled; handled next tick */ } }
  const o = await alpaca.submit({ symbol: sym, qty: t.qty, side: "sell", type: "market", time_in_force: stocks ? "day" : "gtc", client_order_id: `${id}-x-${Date.now()}-${sym.replace("/", "")}` });
  let st = o;
  for (let i = 0; i < 5 && st.status !== "filled"; i++) { await new Promise((r) => setTimeout(r, 2000)); st = await alpaca.order(o.id); }
  const exitPx = Number(st.filled_avg_price || px);
  const { data: row } = await sb.from("orders").insert({ alpaca_order_id: o.id, strategy_id: id, ticker: sym, side: "sell", qty: t.qty, status: st.status, filled_at: st.filled_at, filled_price: exitPx, raw: st }).select().single();
  const qty = Number(t.qty), entry = Number(t.entry_price);
  const gross = (exitPx - entry) * qty;
  const fees = Number(t.fees ?? 0) + exitPx * qty * feeSide;
  const enteredAt = new Date(t.entered_at);
  const isDay = stocks && enteredAt.toDateString() === new Date().toDateString();
  await sb.from("trades").update({
    exit_order_id: row!.id, exit_price: exitPx, exited_at: st.filled_at ?? new Date().toISOString(),
    gross_pnl: gross, fees, net_pnl: gross - fees, hold_seconds: Math.round((Date.now() - enteredAt.getTime()) / 1000),
    exit_reason: reason, is_day_trade: isDay,
  }).eq("id", t.id);
  await log(id, "info", `SELL ${sym} ${qty} @ ${exitPx} (${reason}) net ${(gross - fees).toFixed(2)}`);
}

async function flattenAll(id: string) {
  const { data: open } = await sb.from("trades").select("*").eq("strategy_id", id).is("exited_at", null);
  const crypto = id !== "B";
  const cfg = (await sb.from("strategies").select("config").eq("id", id).single()).data!.config as Cfg;
  const quotes = crypto ? await alpaca.cryptoQuotes(cfg.tickers) : await alpaca.stockQuotes(cfg.tickers);
  for (const t of open ?? []) {
    const q = quotes.quotes?.[t.ticker]; const px = q ? (q.bp + q.ap) / 2 : Number(t.entry_price);
    await exitTrade(id, t, px, "flatten", (cfg.fee_pct_side ?? 0) / 100, !crypto);
  }
  await sb.from("strategies").update({ armed: false, halted: true, halt_reason: "flattened by user" }).eq("id", id);
  await log(id, "alert", "Flattened and halted by red button");
}
