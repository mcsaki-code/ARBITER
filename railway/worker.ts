// ============================================================
// Railway Persistent Worker — Continuous Analysis Pipeline
//
// Replaces Netlify's 10-second serverless functions with a
// long-running process that can:
// 1. Monitor weather forecasts in real-time (react in seconds)
// 2. Run full multi-model analysis without timeout pressure
// 3. Continuously scan for new market opportunities
// 4. Auto-resolve settled markets every 15 minutes
//
// Deploy: railway up (from /railway directory)
// Env vars: same as Netlify + OPENAI_API_KEY
// ============================================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ── Configuration ──────────────────────────────────────────
const CYCLE_INTERVAL_MS = 5 * 60 * 1000;  // 5 min between full cycles
const WEATHER_CHECK_MS = 2 * 60 * 1000;   // 2 min between weather checks
const RESOLVE_INTERVAL_MS = 15 * 60 * 1000; // 15 min between resolve runs
const MARKET_REFRESH_MS = 10 * 60 * 1000;   // 10 min between market refreshes

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const MIN_EDGE = 0.05;
const MIN_EDGE_WEATHER = 0.08;
const KELLY_FRACTION = 0.125;

// ── Logging ────────────────────────────────────────────────
function log(category: string, msg: string) {
  const ts = new Date().toISOString().substring(11, 19);
  console.log(`[${ts}] [${category}] ${msg}`);
}

// ── Multi-model call (inline, no import needed) ────────────
async function callClaude(prompt: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1000, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.content?.[0]?.text || null;
  } catch { return null; }
}

async function callGPT4o(prompt: string): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o', max_tokens: 1000, temperature: 0.2,
        messages: [
          { role: 'system', content: 'You are a quantitative prediction market analyst. Respond ONLY in valid JSON.' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch { return null; }
}

function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

function normalizeEdge(raw: number | null | undefined): number {
  if (raw == null) return 0;
  if (raw > 100) return raw / 1000;
  if (raw > 1) return raw / 100;
  return raw;
}

// ── Weather tail bet scanner ───────────────────────────────
// This is where the real money is. Focus on brackets priced
// under 15¢ where ensemble models show higher probability.
async function scanWeatherTailBets(): Promise<number> {
  log('weather', 'Scanning for tail bet opportunities...');

  const minResolution = new Date(Date.now() + 4 * 3600000).toISOString();
  const { data: markets } = await supabase
    .from('markets')
    .select('*, weather_cities(*)')
    .eq('is_active', true)
    .not('city_id', 'is', null)
    .gt('resolution_date', minResolution)
    .gt('liquidity_usd', 400);  // Lower threshold for weather tail bets

  if (!markets?.length) {
    log('weather', 'No active weather markets');
    return 0;
  }

  let opportunities = 0;
  const recentCutoff = new Date(Date.now() - 3 * 3600000).toISOString();

  for (const market of markets) {
    const city = market.weather_cities;
    if (!city) continue;

    // Check if already analyzed recently
    const { data: existing } = await supabase
      .from('weather_analyses')
      .select('id')
      .eq('market_id', market.id)
      .gte('analyzed_at', recentCutoff)
      .limit(1);

    if (existing?.length) continue;

    // Find tail bets: brackets priced under 15¢ (high payout potential)
    const tailBrackets: { label: string; price: number; index: number }[] = [];
    for (let i = 0; i < market.outcomes.length; i++) {
      const price = market.outcome_prices[i] || 0;
      if (price > 0.005 && price < 0.15) {
        tailBrackets.push({ label: market.outcomes[i], price, index: i });
      }
    }

    if (tailBrackets.length === 0) continue;

    // Get consensus data
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const { data: consensusArr } = await supabase
      .from('weather_consensus')
      .select('*')
      .eq('city_id', city.id)
      .eq('valid_date', tomorrow.toISOString().split('T')[0])
      .order('calculated_at', { ascending: false })
      .limit(1);

    const consensus = consensusArr?.[0];
    if (!consensus || consensus.agreement === 'LOW') continue;

    // Get forecasts for detail
    const { data: forecasts } = await supabase
      .from('weather_forecasts')
      .select('source, temp_high_f, temp_low_f')
      .eq('city_id', city.id)
      .eq('valid_date', tomorrow.toISOString().split('T')[0])
      .order('fetched_at', { ascending: false })
      .limit(10);

    const outcomesList = market.outcomes
      .map((o: string, i: number) => `${o} → $${market.outcome_prices[i]?.toFixed(3) || '?'}`)
      .join('\n');

    const forecastList = forecasts?.map((f: { source: string; temp_high_f: number | null }) =>
      `${f.source}: ${f.temp_high_f}°F`
    ).join(', ') || 'N/A';

    const prompt = `You are an expert weather forecaster analyzing Polymarket temperature brackets.

CITY: ${city.name}
CONSENSUS HIGH: ${consensus.consensus_high_f}°F (spread: ${consensus.model_spread_f}°F, agreement: ${consensus.agreement})
INDIVIDUAL MODELS: ${forecastList}

POLYMARKET BRACKETS:
${outcomesList}

TAIL BETS (priced under 15¢ — high payout potential):
${tailBrackets.map(t => `"${t.label}" @ $${t.price.toFixed(3)} (${(t.price * 100).toFixed(1)}% implied)`).join('\n')}

TASK: The consensus high is ${consensus.consensus_high_f}°F. Evaluate whether any tail bracket has TRUE probability significantly higher than its market price. Focus on:
- Is the consensus near a bracket boundary? (creates mispricing)
- Is the model spread large enough that the tail bracket could hit?
- Weather is naturally uncertain — even HIGH agreement has ~3-5°F error bars

Respond ONLY in JSON:
{
  "direction": "BUY_YES"|"PASS",
  "confidence": "HIGH"|"MEDIUM"|"LOW",
  "edge": number (0-1, true_prob minus market_price),
  "estimated_prob": number (0-1),
  "target_bracket": string,
  "target_index": number,
  "market_price": number,
  "reasoning": string
}`;

    // Run both models in parallel
    const [claudeText, gptText] = await Promise.all([
      callClaude(prompt),
      callGPT4o(prompt),
    ]);

    const claudeResult = parseJson(claudeText);
    const gptResult = parseJson(gptText);

    // Require consensus for tail bets (they're risky)
    const claudeDir = claudeResult?.direction as string;
    const gptDir = gptResult?.direction as string;

    if (!claudeResult || claudeDir !== 'BUY_YES') continue;
    if (gptResult && gptDir !== 'BUY_YES') {
      log('weather', `${city.name} — Claude says BUY but GPT disagrees, skipping tail bet`);
      continue;
    }

    const claudeEdge = normalizeEdge(claudeResult.edge as number);
    const gptEdge = gptResult ? normalizeEdge(gptResult.edge as number) : claudeEdge;
    const avgEdge = (claudeEdge + gptEdge) / 2;

    if (avgEdge < MIN_EDGE_WEATHER) continue;

    const avgProb = (
      normalizeEdge(claudeResult.estimated_prob as number) +
      (gptResult ? normalizeEdge(gptResult.estimated_prob as number) : normalizeEdge(claudeResult.estimated_prob as number))
    ) / 2;

    // Store the analysis
    const targetBracket = claudeResult.target_bracket as string || tailBrackets[0]?.label || '';
    const targetIndex = (claudeResult.target_index as number) ?? tailBrackets[0]?.index ?? 0;
    const marketPrice = market.outcome_prices[targetIndex] || tailBrackets[0]?.price || 0.05;

    const { error } = await supabase
      .from('weather_analyses')
      .insert({
        market_id: market.id,
        city_id: city.id,
        consensus_id: consensus.id,
        model_high_f: consensus.consensus_high_f,
        model_spread_f: consensus.model_spread_f,
        model_agreement: consensus.agreement,
        best_outcome_idx: targetIndex,
        best_outcome_label: targetBracket,
        market_price: marketPrice,
        true_prob: avgProb,
        edge: avgEdge,
        direction: 'BUY_YES',
        confidence: gptResult ? 'HIGH' : 'MEDIUM',  // consensus = HIGH
        kelly_fraction: Math.min(avgEdge * KELLY_FRACTION, 0.03),
        rec_bet_usd: 5,
        reasoning: `[TAIL BET${gptResult ? ' CONSENSUS' : ''}] ${claudeResult.reasoning || ''}`,
        auto_eligible: true,
        flags: ['tail_bet', gptResult ? 'multi_model' : 'single_model'],
        analyzed_at: new Date().toISOString(),
      });

    if (!error) {
      opportunities++;
      log('weather', `TAIL BET: ${city.name} "${targetBracket}" @ ${(marketPrice * 100).toFixed(1)}¢ | edge=${(avgEdge * 100).toFixed(1)}%${gptResult ? ' [CONSENSUS]' : ''}`);
    }
  }

  return opportunities;
}

// ── Market refresh ─────────────────────────────────────────
async function refreshMarkets(): Promise<void> {
  log('markets', 'Refreshing market data from Gamma API...');
  try {
    const tagSlugs = ['temperature', 'weather', 'precipitation', 'climate'];
    let totalMarkets = 0;

    for (const slug of tagSlugs) {
      const tagRes = await fetch(`https://gamma-api.polymarket.com/tags/slug/${slug}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!tagRes.ok) continue;
      const tagData = await tagRes.json();
      if (!tagData?.id) continue;

      const eventsRes = await fetch(
        `https://gamma-api.polymarket.com/events?tag_id=${tagData.id}&active=true&closed=false&limit=100`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (!eventsRes.ok) continue;
      const events = await eventsRes.json();

      if (Array.isArray(events)) {
        for (const event of events) {
          if (event.markets && Array.isArray(event.markets)) {
            for (const m of event.markets) {
              let outcomes: string[];
              let outcomePrices: number[];
              try { outcomes = JSON.parse(m.outcomes); } catch { outcomes = ['Yes', 'No']; }
              try { outcomePrices = JSON.parse(m.outcomePrices).map(Number); } catch { outcomePrices = [0.5, 0.5]; }

              await supabase.from('markets').upsert({
                condition_id: m.conditionId,
                question: m.question,
                outcomes,
                outcome_prices: outcomePrices,
                volume_usd: parseFloat(m.volume) || 0,
                liquidity_usd: parseFloat(m.liquidity) || 0,
                resolution_date: m.endDate,
                is_active: m.active && !m.closed,
                updated_at: new Date().toISOString(),
              }, { onConflict: 'condition_id' });
              totalMarkets++;
            }
          }
        }
      }
    }

    log('markets', `Refreshed ${totalMarkets} markets`);
  } catch (err) {
    log('markets', `Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Resolve bets ───────────────────────────────────────────
async function resolveBets(): Promise<void> {
  log('resolve', 'Checking for resolved markets...');

  const { data: openBets } = await supabase
    .from('bets')
    .select('*, markets(condition_id, question, is_resolved)')
    .eq('status', 'OPEN');

  if (!openBets?.length) {
    log('resolve', 'No open bets to resolve');
    return;
  }

  let resolved = 0;
  for (const bet of openBets) {
    const market = bet.markets as { condition_id: string; question: string; is_resolved: boolean } | null;
    if (!market?.condition_id) continue;

    try {
      const gammaRes = await fetch(
        `https://gamma-api.polymarket.com/markets?condition_id=${market.condition_id}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!gammaRes.ok) continue;
      const gammaData = await gammaRes.json();
      const gammaMarket = Array.isArray(gammaData) ? gammaData[0] : gammaData;

      if (!gammaMarket?.closed) continue;

      // Determine outcome
      let outcomes: string[];
      let outcomePrices: number[];
      try { outcomes = JSON.parse(gammaMarket.outcomes); } catch { continue; }
      try { outcomePrices = JSON.parse(gammaMarket.outcomePrices).map(Number); } catch { continue; }

      // Find winning outcome (price ~1.0)
      const winnerIdx = outcomePrices.findIndex((p: number) => p > 0.95);
      if (winnerIdx === -1) continue;
      const winningOutcome = outcomes[winnerIdx];

      // Did our bet win?
      let won = false;
      if (bet.direction === 'BUY_YES') {
        won = bet.outcome_label === winningOutcome;
      } else if (bet.direction === 'BUY_NO') {
        won = bet.outcome_label !== winningOutcome || winningOutcome === 'No';
      }

      const pnl = won
        ? (bet.amount_usd / bet.entry_price) - bet.amount_usd
        : -bet.amount_usd;

      await supabase.from('bets').update({
        status: won ? 'WON' : 'LOST',
        pnl,
        resolved_at: new Date().toISOString(),
      }).eq('id', bet.id);

      // Update bankroll
      const { data: configRow } = await supabase
        .from('system_config')
        .select('value')
        .eq('key', 'paper_bankroll')
        .single();

      const currentBankroll = parseFloat(configRow?.value || '5000');
      await supabase.from('system_config').update({
        value: (currentBankroll + pnl).toFixed(2),
        updated_at: new Date().toISOString(),
      }).eq('key', 'paper_bankroll');

      resolved++;
      log('resolve', `${won ? 'WON' : 'LOST'}: "${market.question.substring(0, 50)}" PnL=$${pnl.toFixed(2)}`);
    } catch (err) {
      log('resolve', `Error resolving bet ${bet.id}: ${err instanceof Error ? err.message : ''}`);
    }
  }

  log('resolve', `Resolved ${resolved}/${openBets.length} bets`);
}

// ── Main loop ──────────────────────────────────────────────
async function main() {
  log('main', '=== ARBITER Railway Worker Starting ===');
  log('main', `Multi-model: ${process.env.OPENAI_API_KEY ? 'ENABLED (Claude + GPT-4o)' : 'Claude only'}`);
  log('main', `Supabase: ${process.env.NEXT_PUBLIC_SUPABASE_URL ? 'connected' : 'MISSING'}`);

  let lastMarketRefresh = 0;
  let lastWeatherScan = 0;
  let lastResolve = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const now = Date.now();

    try {
      // Market refresh every 10 min
      if (now - lastMarketRefresh > MARKET_REFRESH_MS) {
        await refreshMarkets();
        lastMarketRefresh = now;
      }

      // Weather tail bet scan every 2 min (this is where the edge is)
      if (now - lastWeatherScan > WEATHER_CHECK_MS) {
        const found = await scanWeatherTailBets();
        if (found > 0) log('main', `Found ${found} weather tail bet opportunities`);
        lastWeatherScan = now;
      }

      // Resolve every 15 min
      if (now - lastResolve > RESOLVE_INTERVAL_MS) {
        await resolveBets();
        lastResolve = now;
      }

    } catch (err) {
      log('main', `Cycle error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Sleep until next cycle
    await new Promise(resolve => setTimeout(resolve, CYCLE_INTERVAL_MS));
  }
}

// ── Start ──────────────────────────────────────────────────
main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
