# ARBITER Railway Worker

Persistent worker that runs continuously on Railway, replacing Netlify's 10-second serverless timeout.

## What it does

- **Weather tail bet scanner** (every 2 min) — the #1 edge source
- **Market refresh** (every 10 min) — keeps market prices current
- **Bet resolution** (every 15 min) — auto-resolves settled markets
- **Multi-model consensus** — calls Claude + GPT-4o in parallel

## Deploy to Railway

1. Install Railway CLI: `npm install -g @railway/cli`
2. Login: `railway login`
3. Create project: `railway init`
4. Set env vars:
   ```
   railway variables set NEXT_PUBLIC_SUPABASE_URL=https://kntdxewgksmvnkynzgyx.supabase.co
   railway variables set SUPABASE_SERVICE_ROLE_KEY=<your-key>
   railway variables set ANTHROPIC_API_KEY=<your-key>
   railway variables set OPENAI_API_KEY=<your-key>  # optional, enables multi-model
   ```
5. Deploy: `railway up`

## Env vars (same as Netlify)

| Variable | Required | Description |
|----------|----------|-------------|
| NEXT_PUBLIC_SUPABASE_URL | Yes | Supabase project URL |
| SUPABASE_SERVICE_ROLE_KEY | Yes | Supabase service role key |
| ANTHROPIC_API_KEY | Yes | Claude API key |
| OPENAI_API_KEY | No | GPT-4o API key (enables multi-model) |
