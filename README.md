# Paper Desk

Alpaca paper-trading dashboard and strategy workers.

- `index.html` — the dashboard (GitHub Pages). Talks to Supabase directly with the publishable key; RLS limits data to the owner account.
- `supabase/functions/` — edge functions: `snapshot`, `strategy-a`, `fast-engine` (B stocks / C crypto). Deployed to Supabase project `trading`; scheduled by pg_cron.

Spec: see the "Trading Automation Build Spec" doc.
