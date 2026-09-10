# Cloud auto-run — Misfit ⇄ Forge, 24/7

The app now alternates brands on its own:
- **8 AM–8 PM (Central): Misfit Ministries**
- **8 PM–8 AM (Central): Forge Mode**

No switch to flip. The pill at the top just *shows* which window is live.

## How it runs without the app open
`api/cron.js` is a Vercel Cron job set in `vercel.json` to fire **every hour** (`0 * * * *`).
Each run it: picks the brand by the current Central-time hour → generates 4 posts with free
Pollinations AI → saves them to Supabase → buzzes your phone via ntfy. Your phone and laptop
can be off; the cloud keeps generating.

## Deploy
1. Push to GitHub → import on Vercel (detects Vite).
2. Add env vars (Settings → Environment Variables):
   - `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
   - `NTFY_TOPIC` (a private random word; install the ntfy app on your S25 and subscribe to it)
   - `CRON_SECRET` (optional — any random string; protects the endpoint)
3. Supabase table:
   ```sql
   create table media_batches (
     id uuid default gen_random_uuid() primary key,
     brand text, brand_name text, posts jsonb,
     created_at timestamptz default now()
   );
   ```
4. Deploy. Cron starts on the hour. (Vercel Hobby runs crons once/day; Pro runs them hourly.)

## Notes
- Times are **America/Chicago**, so the 12/12 split lands right for Acadiana.
- Want it to write through **Claude** instead of Pollinations for sharper copy? Swap `callText()`
  in `api/cron.js` to call the Anthropic API with your `ANTHROPIC_API_KEY` (server-side).
- The in-browser scheduler still works when the app is open and now also follows the clock —
  but the cron is what makes it truly autonomous.
