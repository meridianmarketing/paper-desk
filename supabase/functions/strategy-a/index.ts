import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { alpaca, sb, log, json, strategyEquity, authorized } from "./_shared/alpaca.ts";

/** Strategy A: weekly momentum rotation.
 *  mode=propose  -> rank universe, write an approval row (Monday pre-open)
 *  mode=execute  -> act on approved proposals, expire stale ones (at open) */
Deno.serve(async (req) => {
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "propose";
  const { data: s } = await sb.from("strategies").select("*").eq("id", "A").single();
  if (!s) return json({ error: "no strategy A" }, 500);
  const cfg = s.config as { universe: string[]; cash_proxy: string; top_n: number; drift_pct: number };

  if (mode === "propose") {
    const start = new Date(Date.now() - 200 * 86400e3).toISOString().slice(0, 10);
    const bars = await alpaca.stockBars(cfg.universe, "1Day", start, 1000);
    const scores: { sym: string; r3: number; r6: number; score: number }[] = [];
    for (const sym of cfg.universe) {
      const b = bars.bars?.[sym] ?? [];
      if (b.length < 130) continue;
      const last = b.at(-1).c, m3 = b.at(-64).c, m6 = b.at(-127).c;
      const r3 = last / m3 - 1, r6 = last / m6 - 1;
      scores.push({ sym, r3, r6, score: (r3 + r6) / 2 });
    }
    scores.sort((a, b) => b.score - a.score);
    const picks = scores.filter((x) => x.r6 > 0 && x.sym !== cfg.cash_proxy).slice(0, cfg.top_n);
    const weights: Record<string, number> = {};
    for (const p of picks) weights[p.sym] = 1 / cfg.top_n;
    const cashW = 1 - picks.length / cfg.top_n;
    if (cashW > 0) weights[cfg.cash_proxy] = (weights[cfg.cash_proxy] ?? 0) + cashW;

    // current weights from our own open trades
    const quotes = await alpaca.stockQuotes(cfg.universe);
    const mark: Record<string, number> = {};
    for (const sym of cfg.universe) mark[sym] = quotes.quotes?.[sym]?.ap || quotes.quotes?.[sym]?.bp || 0;
    const { equity, open } = await strategyEquity("A", mark);
    const current: Record<string, number> = {};
    for (const t of open) current[t.ticker] = (current[t.ticker] ?? 0) + (mark[t.ticker] * Number(t.qty)) / equity;

    const changes: { sym: string; from: number; to: number }[] = [];
    for (const sym of cfg.universe) {
      const from = current[sym] ?? 0, to = weights[sym] ?? 0;
      if (Math.abs(from - to) * 100 >= cfg.drift_pct) changes.push({ sym, from, to });
    }
    await sb.from("signals").insert({ strategy_id: "A", ticker: picks.map((p) => p.sym).join(",") || cfg.cash_proxy, rule: "momentum_rank", price: 0, acted: changes.length > 0, skip_reason: changes.length ? null : "within drift band", detail: { scores, weights, current } });
    if (!changes.length) return json({ ok: true, message: "no rebalance needed", weights });

    const expires = new Date(); expires.setUTCHours(13, 30, 0, 0); // 9:30 ET (approx; DST handled by cron)
    if (expires < new Date()) expires.setDate(expires.getDate() + 1);
    await sb.from("approvals").insert({ strategy_id: "A", proposal: { weights, changes, equity, scores }, expires_at: expires.toISOString() });
    await log("A", "info", `Rebalance proposed: ${changes.map((c) => `${c.sym} ${(c.from * 100).toFixed(0)}%→${(c.to * 100).toFixed(0)}%`).join(", ")}`);
    return json({ ok: true, proposed: changes });
  }

  if (mode === "execute") {
    await sb.from("approvals").update({ status: "expired" }).eq("strategy_id", "A").eq("status", "pending").lt("expires_at", new Date().toISOString());
    const { data: approved } = await sb.from("approvals").select("*").eq("strategy_id", "A").eq("status", "approved").order("created_at", { ascending: false }).limit(1);
    if (!approved?.length) return json({ ok: true, message: "nothing approved" });
    const ap = approved[0];
    const { weights, changes } = ap.proposal as { weights: Record<string, number>; changes: { sym: string; from: number; to: number }[] };
    const quotes = await alpaca.stockQuotes(cfg.universe);
    const mark: Record<string, number> = {};
    for (const sym of cfg.universe) mark[sym] = quotes.quotes?.[sym]?.ap || quotes.quotes?.[sym]?.bp || 0;
    const { equity, open } = await strategyEquity("A", mark);

    // sells first
    for (const c of changes.filter((c) => c.to < c.from)) {
      const t = open.find((o) => o.ticker === c.sym);
      if (!t) continue;
      const targetQty = Math.floor((c.to * equity) / mark[c.sym]);
      const sellQty = Number(t.qty) - targetQty;
      if (sellQty <= 0) continue;
      const o = await alpaca.submit({ symbol: c.sym, qty: sellQty, side: "sell", type: "market", time_in_force: "day", client_order_id: `A-${Date.now()}-${c.sym}` });
      const { data: row } = await sb.from("orders").insert({ alpaca_order_id: o.id, strategy_id: "A", ticker: c.sym, side: "sell", qty: sellQty, status: o.status, raw: o }).select().single();
      const px = mark[c.sym];
      if (sellQty === Number(t.qty)) {
        await sb.from("trades").update({ exit_order_id: row!.id, exit_price: px, exited_at: new Date().toISOString(), gross_pnl: (px - Number(t.entry_price)) * sellQty, net_pnl: (px - Number(t.entry_price)) * sellQty, exit_reason: "rebalance" }).eq("strategy_id", "A").eq("ticker", c.sym).is("exited_at", null);
      } else {
        await sb.from("trades").update({ qty: targetQty }).eq("strategy_id", "A").eq("ticker", c.sym).is("exited_at", null);
        await sb.from("trades").insert({ strategy_id: "A", ticker: c.sym, entry_order_id: row!.id, exit_order_id: row!.id, entry_price: t.entry_price, exit_price: px, qty: sellQty, entered_at: new Date().toISOString(), exited_at: new Date().toISOString(), gross_pnl: (px - Number(t.entry_price)) * sellQty, net_pnl: (px - Number(t.entry_price)) * sellQty, exit_reason: "rebalance" });
      }
    }
    // then buys
    for (const c of changes.filter((c) => c.to > c.from)) {
      const t = open.find((o) => o.ticker === c.sym);
      const targetQty = Math.floor((c.to * equity) / mark[c.sym]);
      const buyQty = targetQty - Number(t?.qty ?? 0);
      if (buyQty <= 0) continue;
      const o = await alpaca.submit({ symbol: c.sym, qty: buyQty, side: "buy", type: "market", time_in_force: "day", client_order_id: `A-${Date.now()}-${c.sym}` });
      const { data: row } = await sb.from("orders").insert({ alpaca_order_id: o.id, strategy_id: "A", ticker: c.sym, side: "buy", qty: buyQty, status: o.status, raw: o }).select().single();
      if (t) {
        const newQty = Number(t.qty) + buyQty;
        const avg = (Number(t.entry_price) * Number(t.qty) + mark[c.sym] * buyQty) / newQty;
        await sb.from("trades").update({ qty: newQty, entry_price: avg }).eq("strategy_id", "A").eq("ticker", c.sym).is("exited_at", null);
      } else {
        await sb.from("trades").insert({ strategy_id: "A", ticker: c.sym, entry_order_id: row!.id, entry_price: mark[c.sym], qty: buyQty, signal_price: mark[c.sym], entered_at: new Date().toISOString() });
      }
    }
    await sb.from("approvals").update({ status: "executed" }).eq("id", ap.id);
    await log("A", "info", `Rebalanced to ${Object.entries(weights).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(", ")}`);
    return json({ ok: true, executed: changes });
  }
  return json({ error: "bad mode" }, 400);
});
