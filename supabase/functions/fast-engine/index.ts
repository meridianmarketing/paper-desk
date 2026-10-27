import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { alpaca, sb, log, json, strategyEquity, riskGate, authorized } from "./_shared/alpaca.ts";

type Bar = { t: string; o: number; h: number; l: number; c: number; v: number };
type Cfg = {
  tickers: string[]; target_pct: number; stop_pct: number; max_hold_min: number; max_positions: number;
  vwap_dip_pct: number; breakout_bars: number; vol_mult: number; spread_pct: number; pdt_cap?: number; fee_pct_side?: number;
};

/** Runs every minute. ?strategy=B (stocks, market hours) or ?strategy=C (crypto, 24/7). */
Deno.serve(async (req) => {
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  const id = new URL(req.url).searchParams.get("strategy");
  if (id !== "B" && id !== "C") return json({ error: "strategy must be B or C" }, 400);
  const crypto = id === "C";

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

  // ---- manage open positions first (exits always allowed, even if halted) ----
  for (const t of open) {
    const px = mark[t.ticker]; if (!px) continue;
    const entry = Number(t.entry_price);
    const chg = (px / entry - 1) * 100;
    const held = (Date.now() - new Date((t as any).entered_at ?? Date.now()).getTime()) / 60e3;
    let reason: string | null = null;
    if (chg >= cfg.target_pct) reason = "target";
    else if (chg <= -cfg.stop_pct) reason = "stop";
    else if (held >= cfg.max_hold_min) reason = "time";
    if (reason) await exitTrade(id, t, px, reason, feeSide, !crypto);
  }

  const gate = await riskGate(id, equity);
  if (gate) {
    await sb.from("signals").insert({ strategy_id: id, ticker: "*", rule: "risk_gate", price: 0, acted: false, skip_reason: gate });
    return json({ ok: true, message: gate });
  }

  const { data: openNow } = await sb.from("trades").select("ticker").eq("strategy_id", id).is("exited_at", null);
  let slots = cfg.max_positions - (openNow?.length ?? 0);
  if (slots <= 0) return json({ ok: true, message: "max positions" });

  let pdtLeft = Infinity;
  if (!crypto && cfg.pdt_cap && equity < 25000) {
    const { data: n } = await sb.rpc("day_trade_count", { p_strategy: id });
    pdtLeft = cfg.pdt_cap - (n as number);
  }

  // ---- entries ----
  for (const sym of cfg.tickers) {
    if (slots <= 0) break;
    if (openNow?.some((o) => o.ticker === sym)) continue;
    const b: Bar[] = bars.bars?.[sym] ?? [];
    if (b.length < cfg.breakout_bars + 2) continue;
    const px = mark[sym]; if (!px) continue;

    const last = b.at(-1)!, prev = b.at(-2)!;
    const w20 = b.slice(-20);
    const vwap = w20.reduce((a, x) => a + ((x.h + x.l + x.c) / 3) * x.v, 0) / Math.max(1, w20.reduce((a, x) => a + x.v, 0));
    const dipPct = (vwap / px - 1) * 100; // how far below vwap we are
    const dipHit = dipPct >= cfg.vwap_dip_pct && last.c > last.o && prev.c <= prev.o;

    const win = b.slice(-(cfg.breakout_bars + 1), -1);
    const hi = Math.max(...win.map((x) => x.h));
    const avgVol = win.reduce((a, x) => a + x.v, 0) / win.length;
    const brkHit = last.c > hi && last.v >= cfg.vol_mult * avgVol;

    const rule = dipHit ? "vwap_dip" : brkHit ? "breakout" : null;
    if (!rule) continue;

    let skip: string | null = null;
    if (spread[sym] > cfg.spread_pct) skip = `spread ${spread[sym].toFixed(3)}%`;
    else if (pdtLeft <= 0) skip = "PDT cap";
    const { data: sig } = await sb.from("signals").insert({ strategy_id: id, ticker: sym, rule, price: px, acted: !skip, skip_reason: skip, detail: { vwap, dipPct, hi, vol: last.v, avgVol, spread: spread[sym] } }).select().single();
    if (skip) continue;

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
    const fq = Number(filled.filled_qty);
    await sb.from("orders").update({ status: "filled", filled_at: filled.filled_at, filled_price: fillPx }).eq("id", row!.id);
    await sb.from("trades").insert({ strategy_id: id, ticker: sym, entry_order_id: row!.id, entry_price: fillPx, qty: fq, signal_price: px, entered_at: filled.filled_at, fees: fillPx * fq * feeSide, slippage: (fillPx / px - 1) * 100 });
    await log(id, "info", `BUY ${sym} ${fq} @ ${fillPx} (${rule})`);
    slots--; if (!crypto) pdtLeft--;
  }
  return json({ ok: true });
});

async function exitTrade(id: string, t: any, px: number, reason: string, feeSide: number, stocks: boolean) {
  const sym = t.ticker as string;
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
  const crypto = id === "C";
  const cfg = (await sb.from("strategies").select("config").eq("id", id).single()).data!.config as Cfg;
  const quotes = crypto ? await alpaca.cryptoQuotes(cfg.tickers) : await alpaca.stockQuotes(cfg.tickers);
  for (const t of open ?? []) {
    const q = quotes.quotes?.[t.ticker]; const px = q ? (q.bp + q.ap) / 2 : Number(t.entry_price);
    await exitTrade(id, t, px, "flatten", (cfg.fee_pct_side ?? 0) / 100, !crypto);
  }
  await sb.from("strategies").update({ armed: false, halted: true, halt_reason: "flattened by user" }).eq("id", id);
  await log(id, "alert", "Flattened and halted by red button");
}
