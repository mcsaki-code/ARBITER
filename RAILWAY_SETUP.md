# ARBITER Railway Worker — Setup Guide

## Plan Confirmation
**The $5/month Hobby plan is correct.** Here's what you get:
- Always-on Node.js process (no cold starts, no timeouts)
- 512MB RAM — plenty for the worker
- $5/month flat + usage (a small always-on Node app costs ~$1-3/month in compute, well within the $5)
- You're good.

---

## One-Time Setup (15 minutes)

### Step 1: Install the Railway CLI
```bash
npm install -g @railway/cli
railway login
```

### Step 2: Link the project to Railway
In the arbiter repo root:
```bash
railway init
# Choose "Deploy from repo"
# Select your GitHub account and the arbiter repo
```

### Step 3: Set environment variables
These are the same vars you have in Netlify. Run each:
```bash
railway variables set NEXT_PUBLIC_SUPABASE_URL="https://kntdxewgksmvnkynzgyx.supabase.co"
railway variables set SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"

# Optional but useful:
railway variables set ANTHROPIC_API_KEY="your-anthropic-key"  # for future LLM analysis in worker
```

To find your service role key: Supabase Dashboard → Project Settings → API → service_role key

### Step 4: Deploy
```bash
railway up
```

Railway will:
1. Detect `railway.toml` in the repo root
2. Run `cd worker && npm install && npm run build`
3. Start the worker with `cd worker && npm start`

### Step 5: Watch the logs
```bash
railway logs
```

You should see:
```
╔═══════════════════════════════════════════╗
║        ARBITER Railway Worker v1.0        ║
║  Persistent analysis — no timeout limits  ║
╚═══════════════════════════════════════════╝
[worker] ✅ Supabase connection OK
[worker] === Temperature cycle #1 ===
[temp-analysis] Found 783 eligible markets (5-day lookahead)
[temp-analysis] ✅ Wellington lte20°C | 1d out σ=2.0°C | ...
```

---

## What the Worker Does

| Loop | Frequency | What |
|---|---|---|
| Temperature analysis | Every 5 min | Processes ALL eligible markets (783+), no timeout |
| Market price monitor | Every 60 sec | Detects price shifts ≥3%, invalidates analysis cache |
| Health logging | Every 15 min | Writes heartbeat to Supabase (visible on dashboard) |

The Netlify `analyze-temperature.ts` function can stay running as a backup — the Railway worker sets `market_type = 'temperature_statistical'` on the same records, so place-bets.ts sees all analyses regardless of source.

---

## Monitoring

Check Railway dashboard at railway.app — it shows:
- CPU/RAM usage (should be <50MB RAM at idle)
- Log stream
- Deployment history

Check worker status in Supabase:
```sql
SELECT key, value FROM system_config
WHERE key LIKE 'railway_worker_%'
ORDER BY key;
```

---

## Cost Estimate

A Node.js worker doing light DB queries:
- CPU: ~0.01 vCPU average → ~$0.40/month
- RAM: ~50MB → ~$0.25/month
- **Total: ~$0.65/month compute** — well within the $5 Hobby plan

---

## Troubleshooting

**Worker crashes on startup:**
```bash
railway logs  # look for FATAL messages
# Most likely cause: missing env vars
railway variables  # verify they're set
```

**"Cannot reach Supabase" error:**
- Check NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set correctly
- Make sure service_role key (not anon key)

**Worker restarts frequently:**
- Check for uncaught promise rejections in logs
- Railway auto-restarts on failure (configured in railway.toml)

**Temperature analyses not appearing:**
- Check Supabase: `SELECT COUNT(*) FROM weather_analyses WHERE flags::text LIKE '%railway%'`
- If 0 rows, check logs for "skippedNoForecast" — means ingest-weather hasn't run recently
