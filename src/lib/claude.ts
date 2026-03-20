// ============================================================
// Claude Weather Edge Analyzer
// ============================================================

import { ClaudeWeatherResponse, Market, WeatherConsensus, WeatherForecast } from './types';

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

interface AnalyzeWeatherParams {
  cityName: string;
  forecastDate: string;
  forecasts: WeatherForecast[];
  consensus: WeatherConsensus;
  market: Market;
}

export async function analyzeWeatherEdge(
  params: AnalyzeWeatherParams
): Promise<ClaudeWeatherResponse | null> {
  const { cityName, forecastDate, forecasts, consensus, market } = params;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set');
    return null;
  }

  // Build model data for prompt
  const nws = forecasts.find((f) => f.source === 'nws');
  const gfs = forecasts.find((f) => f.source === 'gfs');
  const ecmwf = forecasts.find((f) => f.source === 'ecmwf');
  const icon = forecasts.find((f) => f.source === 'icon');

  // Build outcomes list
  const outcomesList = market.outcomes
    .map((o, i) => `${o} → $${market.outcome_prices[i]?.toFixed(2) || '?'}`)
    .join('\n');

  // Calculate hours remaining
  const hoursRemaining = market.resolution_date
    ? Math.max(0, (new Date(market.resolution_date).getTime() - Date.now()) / 3600000)
    : 0;

  // Skip conditions
  if (consensus.agreement === 'LOW') return null;
  if (market.liquidity_usd < 25000) return null;
  if (hoursRemaining < 4) return null;

  const prompt = `You are ARBITER's weather analyst. Compare forecast models to Polymarket temperature brackets and identify mispricings.

CITY: ${cityName}
DATE: ${forecastDate}

FORECAST MODELS:
- NWS official high: ${nws?.temp_high_f ?? 'N/A'}°F
- GFS model high:   ${gfs?.temp_high_f ?? 'N/A'}°F
- ECMWF model high: ${ecmwf?.temp_high_f ?? 'N/A'}°F
- ICON model high:  ${icon?.temp_high_f ?? 'N/A'}°F
- Consensus high:   ${consensus.consensus_high_f}°F
- Model spread:     ${consensus.model_spread_f}°F
- Agreement:        ${consensus.agreement}  (HIGH=<2°F, MEDIUM=2-5°F, LOW=>5°F)

POLYMARKET BRACKETS (outcome → current YES price):
${outcomesList}
Example: "44-45°F → $0.08" means 8% implied probability

MARKET INFO:
- Liquidity: $${market.liquidity_usd.toLocaleString()}
- Volume:    $${market.volume_usd.toLocaleString()}
- Resolves:  ${Math.round(hoursRemaining)} hours from now

TASK:
1. Identify which bracket(s) the consensus falls within
2. Estimate true probability for EACH bracket (must sum to ~1.0)
3. Calculate edge = true_prob - market_price per bracket
4. Select the single best bet (highest edge that meets criteria)
5. For kelly_fraction: return your raw edge and confidence — the calling code (lib/kelly.ts) will compute the correct Kelly value.
6. Set auto_eligible = true only if agreement=HIGH, confidence=HIGH, edge>=0.08

SKIP (return best_bet: null) if: agreement=LOW, liquidity<$25k, hours_remaining<4, edge<0.05

Respond ONLY in JSON:
{
  "city": string,
  "consensus_high_f": number,
  "spread_f": number,
  "agreement": "HIGH|MEDIUM|LOW",
  "best_bet": {
    "outcome_index": number,
    "outcome_label": string,
    "market_price": number,
    "true_prob": number,
    "edge": number,
    "direction": "BUY_YES|BUY_NO|PASS",
    "confidence": "HIGH|MEDIUM|LOW",
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
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      console.error(`Claude API error: ${res.status}`);
      return null;
    }

    const data = await res.json();
    const text = data.content?.[0]?.text;
    if (!text) return null;

    // Extract JSON from response (may be wrapped in markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    return JSON.parse(jsonMatch[0]) as ClaudeWeatherResponse;
  } catch (err) {
    console.error('Claude analysis failed:', err);
    return null;
  }
}
