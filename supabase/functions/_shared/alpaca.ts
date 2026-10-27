import { createClient } from "npm:@supabase/supabase-js@2";

export const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

let creds: { key: string; secret: string; base: string } | null = null;

export async function alpacaCreds() {
  if (creds) return creds;
  const get = async (n: string) => {
    const { data, error } = await sb.rpc("get_secret", { p_name: n });
    if (error || !data) throw new Error(`missing secret ${n}`);
    return data as string;
  };
  creds = {
    key: await get("ALPACA_KEY"),
    secret: await get("ALPACA_SECRET"),
    base: await get("ALPACA_BASE_URL"),
  };
  return creds;
}

async function call(path: string, init: RequestInit = {}, dataApi = false) {
  const c = await alpacaCreds();
  const base = dataApi ? "https://data.alpaca.markets" : c.base;
  const res = await fetch(base + path, {
    ...init,
    headers: {
      "APCA-API-KEY-ID": c.key,
      "APCA-API-SECRET-KEY": c.secret,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`alpaca ${res.status} ${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}

export const alpaca = {
  account: () => call("/v2/account"),
  positions: () => call("/v2/positions"),
  clock: () => call("/v2/clock"),
  orders: (status = "open") => call(`/v2/orders?status=${status}&limit=100`),
  order: (id: string) => call(`/v2/orders/${id}`),
  submit: (body: Record<string, unknown>) =>
    call("/v2/orders", { method: "POST", body: JSON.stringify(body) }),
  cancel: (id: string) => call(`/v2/orders/${id}`, { method: "DELETE" }),
  closePosition: (sym: string) =>
    call(`/v2/positions/${encodeURIComponent(sym)}`, { method: "DELETE" }),
  closeAll: () => call("/v2/positions?cancel_orders=true", { method: "DELETE" }),
  // market data
  stockBars: (symbols: string[], timeframe: string, start: string, limit = 1000) =>
    call(
      `/v2/stocks/bars?symbols=${symbols.join(",")}&timeframe=${timeframe}&start=${start}&limit=${limit}&feed=iex&sort=asc`,
      {},
      true,
    ),
  stockQuotes: (symbols: string[]) =>
    call(`/v2/stocks/quotes/latest?symbols=${symbols.join(",")}&feed=iex`, {}, true),
  cryptoBars: (symbols: string[], timeframe: string, start: string, limit = 1000) =>
    call(
      `/v1beta3/crypto/us/bars?symbols=${symbols.map(encodeURIComponent).join(",")}&timeframe=${timeframe}&start=${start}&limit=${limit}&sort=asc`,
      {},
      true,
    ),
  cryptoQuotes: (symbols: string[]) =>
    call(`/v1beta3/crypto/us/latest/quotes?symbols=${symbols.map(encodeURIComponent).join(",")}`, {}, true),
};

export async function log(strategy_id: string | null, level: string, message: string, detail?: unknown) {
  await sb.from("events").insert({ strategy_id, level, message, detail: detail ?? null });
}

export async function snapshot(strategy_id: string, equity: number, cash: number, positions: unknown, spy?: number) {
  await sb.from("equity_snapshots").insert({ strategy_id, equity, cash, positions, spy_price: spy ?? null });
}

/** Per-strategy virtual equity: one Alpaca paper account is shared, so each
 * strategy tracks its own start equity + realized/unrealized P&L from its own trades. */
export async function strategyEquity(strategy_id: string, markPrices: Record<string, number>) {
  const { data: s } = await sb.from("strategies").select("*").eq("id", strategy_id).single();
  const { data: closed } = await sb.from("trades").select("net_pnl").eq("strategy_id", strategy_id).not("exited_at", "is", null);
  const { data: open } = await sb.from("trades").select("id,ticker,entry_price,qty,entered_at,fees,high_water").eq("strategy_id", strategy_id).is("exited_at", null);
  const realized = (closed ?? []).reduce((a, t) => a + Number(t.net_pnl ?? 0), 0);
  let unreal = 0, invested = 0;
  for (const t of open ?? []) {
    const px = markPrices[t.ticker] ?? Number(t.entry_price);
    unreal += (px - Number(t.entry_price)) * Number(t.qty);
    invested += px * Number(t.qty);
  }
  const equity = Number(s!.start_equity) + realized + unreal;
  return { s: s!, equity, cash: equity - invested, open: open ?? [] };
}

export async function riskGate(strategy_id: string, equity: number): Promise<string | null> {
  const { data, error } = await sb.rpc("risk_check", { p_strategy: strategy_id, p_equity: equity });
  if (error) throw error;
  return data as string | null;
}

export const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

/** Workers are invoked by pg_cron (no user JWT), so they check a shared secret header instead. */
export async function authorized(req: Request): Promise<boolean> {
  const { data } = await sb.rpc("get_secret", { p_name: "CRON_SECRET" });
  const given = req.headers.get("x-cron-secret");
  return !!data && !!given && given === data;
}
