import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { alpaca, sb, json, snapshot, strategyEquity, authorized } from "./_shared/alpaca.ts";

/** Every 5 minutes: per-strategy virtual equity + SPY mark. Also clears a
 * satisfied flatten request and marks A's flatten. */
Deno.serve(async (req) => {
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  const stocks = new Set<string>(); const cryptos = new Set<string>();
  const { data: strategies } = await sb.from("strategies").select("*");
  for (const s of strategies ?? []) {
    const cfg = s.config as any;
    for (const t of (cfg.tickers ?? cfg.universe ?? []) as string[]) (t.includes("/") ? cryptos : stocks).add(t);
  }
  stocks.add("SPY");
  const mark: Record<string, number> = {};
  const sq = await alpaca.stockQuotes([...stocks]);
  for (const [k, q] of Object.entries<any>(sq.quotes ?? {})) mark[k] = q.ap && q.bp ? (q.ap + q.bp) / 2 : q.ap || q.bp;
  if (cryptos.size) {
    const cq = await alpaca.cryptoQuotes([...cryptos]);
    for (const [k, q] of Object.entries<any>(cq.quotes ?? {})) mark[k] = (q.ap + q.bp) / 2;
  }
  const out: Record<string, number> = {};
  for (const s of strategies ?? []) {
    const { equity, cash, open } = await strategyEquity(s.id, mark);
    await snapshot(s.id, equity, cash, open.map((o) => ({ ...o, mark: mark[o.ticker] })), mark["SPY"]);
    out[s.id] = equity;
  }
  // flatten: A has no engine loop, so close its open trades here if requested
  const { data: ctl } = await sb.from("control").select("*").eq("id", 1).single();
  if (ctl?.flatten_requested) {
    const { data: openA } = await sb.from("trades").select("*").eq("strategy_id", "A").is("exited_at", null);
    for (const t of openA ?? []) {
      try { await alpaca.closePosition(t.ticker); } catch { /* may already be closed */ }
      const px = mark[t.ticker] ?? Number(t.entry_price);
      await sb.from("trades").update({ exit_price: px, exited_at: new Date().toISOString(), gross_pnl: (px - Number(t.entry_price)) * Number(t.qty), net_pnl: (px - Number(t.entry_price)) * Number(t.qty), exit_reason: "flatten" }).eq("id", t.id);
    }
    await sb.from("strategies").update({ armed: false, halted: true, halt_reason: "flattened by user" }).eq("id", "A");
    const { data: stillOpen } = await sb.from("trades").select("id").is("exited_at", null);
    if (!stillOpen?.length) await sb.from("control").update({ flatten_requested: false }).eq("id", 1);
  }
  return json({ ok: true, equity: out, spy: mark["SPY"] });
});
