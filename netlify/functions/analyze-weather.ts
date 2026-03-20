// ============================================================
// Netlify Scheduled Function: Analyze Weather
// Runs every 20 minutes — Claude analysis for cities with fresh data + active market
// Max 3 cities per invocation to stay under time limit
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

export const handler = schedule('*/20 * * * *', async () => {
  console.log('[analyze-weather] Starting weather analysis');
  const startTime = Date.now();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[analyze-weather] ANTHROPIC_API_KEY not set');
    return { statusCode: 500 };
  }

  // Get cities with active markets
  const { data: markets } = await supabase
    .from('markets')
    .select('*, weather_cities(*)')
    .eq('is_active', true)
    .not('city_id', 'is', null);

  if (!markets || markets.length === 0) {
    console.log('[analyze-weather] No active markets with city matches');
    return { statusCode: 200 };
  }

  // Process max 3 cities
  let processed = 0;
  for (const market of markets.slice(0, 3)) {
    if (Date.now() - startTime > 20000) break;

    const city = market.weather_cities;
    if (!city) continue;

    // Get latest consensus for tomorrow
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    const { data: consensusArr } = await supabase
      .from('weather_consensus')
      .select('*')
      .eq('city_id', city.id)
      .eq('valid_date', tomorrowStr)
      .order('calculated_at', { ascending: false })
      .limit(1);

    const consensus = consensusArr?.[0];
    if (!consensus) continue;

    // Skip LOW agreement
    if (consensus.agreement === 'LOW') continue;

    // Get individual forecasts for context
    const { data: forecasts } = await supabase
      .from('weather_forecasts')
      .select('*')
      .eq('city_id', city.id)
      .eq('valid_date', tomorrowStr)
      .order('fetched_at', { ascending: false })
      .limit(10);

    const nws = forecasts?.find((f: { source: string }) => f.source === 'nws');
    const gfs = forecasts?.find((f: { source: string }) => f.source === 'gfs');
    const ecmwf = forecasts?.find((f: { source: string }) => f.source === 'ecmwf');
    const icon = forecasts?.find((f: { source: string }) => f.source === 'icon');

    const outcomesList = market.outcomes
      .map((o: string, i: number) => `${o} → $${market.outcome_prices[i]?.toFixed(2) || '?'}`)
      .join('\n');

    const hoursRemaining = market.resolution_date
      ? Math.max(0, (new Date(market.resolution_date).getTime() - Date.now()) / 3600000)
      : 0;

    if (hoursRemaining < 4) continue;
    if (market.liquidity_usd < 25000) continue;

    const prompt = `You are ARBITER's weather analyst. Compare forecast models to Polymarket temperature brackets and identify mispricings.

CITY: ${city.name}
DATE: ${tomorrowStr}

FORECAST MODELS:
- NWS official high: ${nws?.temp_high_f ?? 'N/A'}°F
- GFS model high:   ${gfs?.temp_high_f ?? 'N/A'}°F
- ECMWF model high: ${ecmwf?.temp_high_f ?? 'N/A'}°F
- ICON model high:  ${icon?.temp_high_f ?? 'N/A'}°F
- Consensus high:   ${consensus.consensus_high_f}°F
- Model spread:     ${consensus.model_spread_f}°F
- Agreement:        ${consensus.agreement}

POLYMARKET BRACKETS (outcome → current YES price):
${outcomesList}

MARKET INFO:
- Liquidity: $${market.liquidity_usd.toLocaleString()}
- Volume:    $${market.volume_usd.toLocaleString()}
- Resolves:  ${Math.round(hoursRemaining)} hours from now

TASK:
1. Identify which bracket(s) the consensus falls within
2. Estimate true probability for EACH bracket (must sum to ~1.0)
3. Calculate edge = true_prob - market_price per bracket
4. Select the single best bet (highest edge that meets criteria)
5. Return edge + confidence accurately for Kelly calculation
6. Set auto_eligible = true only if agreement=HIGH, confidence=HIGH, edge>=0.08

SKIP (return best_bet: null) if: agreement=LOW, liquidity<$25k, hours_remaining<4, edge<0.05

Respond ONLY in JSON:
{
  "city": string,
  "consensus_high_f": number,
  "spread_f": number,
  "agreement": "HIGH"|"MEDIUM"|"LOW",
  "best_bet": {
    "outcome_index": number,
    "outcome_label": string,
    "market_price": number,
    "true_prob": number,
    "edge": number,
    "direction": "BUY_YES"|"BUY_NO"|"PASS",
    "confidence": "HIGH"|"MEDIUM"|"LOW",
    "kelly_fraction": number,
    "reasoning": string
  } | null,
  "all_outcomes": [{"index": number, "label": string, "market_price": number, "true_prob": number, "edge": number}],
  "auto_eligible": boolean,
  "flags": string[]
}`;

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 1500,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        console.error(`[analyze-weather] Claude API error: ${res.status}`);
        continue;
      }

      const data = await res.json();
      const text = data.content?.[0]?.text;
      if (!text) continue;

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;

      const analysis = JSON.parse(jsonMatch[0]);

      // Calculate Kelly bet size
      let kellyFraction = 0;
      let recBetUsd = 0;
      if (analysis.best_bet) {
        const { data: configRows } = await supabase
          .from('system_config')
          .select('key, value')
          .in('key', ['paper_bankroll', 'kelly_fraction']);

        const config: Record<string, string> = {};
        configRows?.forEach((r: { key: string; value: string }) => {
          config[r.key] = r.value;
        });
        const bankroll = parseFloat(config.paper_bankroll || '500');

        const p = analysis.best_bet.true_prob;
        const c = analysis.best_bet.market_price;
        const edge = p - c;
        if (edge >= 0.05) {
          const b = (1 - c) / c;
          const fullKelly = (p * b - (1 - p)) / b;
          if (fullKelly > 0) {
            const confMult = { HIGH: 1.0, MEDIUM: 0.6, LOW: 0.2 }[
              analysis.best_bet.confidence as string
            ] || 0.2;
            const adjusted = fullKelly * 0.25 * (confMult as number);
            const liquidityCap = (market.liquidity_usd * 0.02) / bankroll;
            kellyFraction = Math.min(adjusted, 0.05, liquidityCap);
            recBetUsd = Math.max(1, Math.round(bankroll * kellyFraction * 100) / 100);
          }
        }
      }

      // Store analysis
      await supabase.from('weather_analyses').insert({
        market_id: market.id,
        city_id: city.id,
        consensus_id: consensus.id,
        model_high_f: consensus.consensus_high_f,
        model_spread_f: consensus.model_spread_f,
        model_agreement: consensus.agreement,
        best_outcome_idx: analysis.best_bet?.outcome_index ?? null,
        best_outcome_label: analysis.best_bet?.outcome_label ?? null,
        market_price: analysis.best_bet?.market_price ?? null,
        true_prob: analysis.best_bet?.true_prob ?? null,
        edge: analysis.best_bet?.edge ?? null,
        direction: analysis.best_bet?.direction ?? 'PASS',
        confidence: analysis.best_bet?.confidence ?? 'LOW',
        kelly_fraction: kellyFraction,
        rec_bet_usd: recBetUsd,
        reasoning: analysis.best_bet?.reasoning ?? null,
        auto_eligible: analysis.auto_eligible || false,
        flags: analysis.flags || [],
      });

      processed++;
      console.log(`[analyze-weather] Analyzed ${city.name}: edge=${analysis.best_bet?.edge ?? 0}`);
    } catch (err) {
      console.error(`[analyze-weather] Analysis failed for ${city.name}:`, err);
    }
  }

  console.log(`[analyze-weather] Done. Processed ${processed} cities in ${Date.now() - startTime}ms`);
  return { statusCode: 200 };
});
