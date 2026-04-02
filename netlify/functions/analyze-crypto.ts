// ============================================================
// Netlify Scheduled Function: Analyze Crypto Edge
// Runs every 30 minutes — compares technical/on-chain signals
// against Polymarket price bracket markets to find mispricings.
// ============================================================

import { schedule } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ensembleAnalyze } from '../../src/lib/ensemble';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const MAX_ANALYSES_PER_RUN = 8;   // increased from 3
const MIN_EDGE_PCT = 0.02;

// ── Threshold extraction ───────────────────────────────────
// Parse a crypto market question to find the price target and
// compute how far the asset needs to move to hit it.
interface ThresholdContext {
  target: number;
  direction: 'up' | 'down';
  pctMove: number;       // % move needed (positive = need to go up, negative = need to go down)
  absPctMove: number;    // absolute % magnitude
  requiredDailyPct: number;  // daily % needed to just reach threshold
  daysRemaining: number;
  feasibilityNote: string;
}

function extractThresholdContext(
  question: string,
  spotPrice: number,
  hoursRemaining: number
): ThresholdContext | null {
  // Match patterns like $90,000 / $90k / $250,000
  const priceMatch = question.match(/\$([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?)/);
  if (!priceMatch) return null;

  const target = parseFloat(priceMatch[1].replace(/,/g, ''));
  if (isNaN(target) || target <= 0 || spotPrice <= 0) return null;

  const q = question.toLowerCase();
  const direction: 'up' | 'down' =
    q.includes('reach') || q.includes('hit') || q.includes('above') || q.includes('exceed')
      ? 'up'
      : q.includes('dip') || q.includes('drop') || q.includes('below') || q.includes('fall')
      ? 'down'
      : target > spotPrice ? 'up' : 'down';

  const pctMove = ((target - spotPrice) / spotPrice) * 100;
  const absPctMove = Math.abs(pctMove);
  const daysRemaining = hoursRemaining / 24;
  const requiredDailyPct = daysRemaining > 0 ? absPctMove / daysRemaining : Infinity;

  let feasibilityNote: string;
  if (absPctMove < 5) {
    feasibilityNote = 'CLOSE — target is within 5% of current price, technically feasible';
  } else if (absPctMove < 15 && daysRemaining > 7) {
    feasibilityNote = 'PLAUSIBLE — moderate move over extended timeframe';
  } else if (absPctMove < 20 && daysRemaining > 30) {
    feasibilityNote = 'PLAUSIBLE — moderate move over long timeframe';
  } else if (requiredDailyPct > 5) {
    feasibilityNote = `VERY DIFFICULT — requires ${requiredDailyPct.toFixed(1)}%/day sustained move`;
  } else if (requiredDailyPct > 2) {
    feasibilityNote = `DIFFICULT — requires ${requiredDailyPct.toFixed(1)}%/day sustained move`;
  } else {
    feasibilityNote = `MODERATE — requires ${requiredDailyPct.toFixed(1)}%/day`;
  }

  return { target, direction, pctMove, absPctMove, requiredDailyPct, daysRemaining, feasibilityNote };
}

// ── Edge/Prob normalization (fixes Claude returning 849 instead of 0.849) ──
function normalizeEdge(raw: number | null | undefined): number | null {
  if (raw == null) return null;
  if (raw > 100) return raw / 1000;
  if (raw > 1)   return raw / 100;
  return raw;
}
function normalizeProb(raw: number | null | undefined): number | null {
  if (raw == null) return null;
  if (raw > 1) return raw / 100;
  return raw;
}

interface SignalRow {
  id: string;
  fetched_at: string;
  asset: string;
  spot_price: number;
  price_1h_ago: number | null;
  price_24h_ago: number | null;
  volume_24h: number | null;
  rsi_14: number | null;
  bb_upper: number | null;
  bb_lower: number | null;
  funding_rate: number | null;
  open_interest: number | null;
  fear_greed: number | null;
  implied_vol: number | null;
  signal_summary: string;
}

interface MarketRow {
  id: string;
  condition_id: string;
  question: string;
  outcomes: string[];
  outcome_prices: number[];
  volume_usd: number;
  liquidity_usd: number;
  resolution_date: string | null;
}

export const handler = schedule('*/30 * * * *', async () => {
  console.log('[analyze-crypto] Starting crypto edge analysis');
  const startTime = Date.now();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[analyze-crypto] ANTHROPIC_API_KEY not set');
    return { statusCode: 500 };
  }

  // Get latest signal snapshots for each asset
  const signals: Record<string, SignalRow> = {};

  for (const asset of ['BTC', 'ETH']) {
    const { data } = await supabase
      .from('crypto_signals')
      .select('*')
      .eq('asset', asset)
      .order('fetched_at', { ascending: false })
      .limit(1);

    if (data && data.length > 0) {
      signals[asset] = data[0];
    }
  }

  if (Object.keys(signals).length === 0) {
    console.log('[analyze-crypto] No signal data available');
    return { statusCode: 200 };
  }

  // Get active crypto markets with 2+ hours remaining
  const minResolutionDate = new Date(Date.now() + 2 * 3600000).toISOString();
  const { data: cryptoMarkets } = await supabase
    .from('markets')
    .select('*')
    .eq('is_active', true)
    .eq('category', 'crypto')
    .gt('liquidity_usd', 5000)
    .gt('resolution_date', minResolutionDate)
    .order('volume_usd', { ascending: false })
    .limit(30);

  if (!cryptoMarkets || cryptoMarkets.length === 0) {
    console.log('[analyze-crypto] No active crypto markets');
    return { statusCode: 200 };
  }

  console.log(`[analyze-crypto] ${Object.keys(signals).length} assets with signals, ${cryptoMarkets.length} crypto markets`);

  // Match markets to assets and find analysis candidates
  const candidates: { market: MarketRow; signal: SignalRow; asset: string }[] = [];

  for (const market of cryptoMarkets as MarketRow[]) {
    const q = market.question.toLowerCase();

    // Determine which asset this market is about
    let matchedAsset: string | null = null;
    if (q.includes('bitcoin') || q.includes('btc')) matchedAsset = 'BTC';
    else if (q.includes('ethereum') || q.includes('eth')) matchedAsset = 'ETH';
    else if (q.includes('solana') || q.includes('sol')) continue; // No signals yet

    if (matchedAsset && signals[matchedAsset]) {
      candidates.push({
        market,
        signal: signals[matchedAsset],
        asset: matchedAsset,
      });
    }
  }

  console.log(`[analyze-crypto] ${candidates.length} markets matched to signal data`);

  // Get recently analyzed market IDs to avoid re-analyzing every 30 min
  const recentCutoff = new Date(Date.now() - 3 * 3600000).toISOString(); // 3h
  const { data: recentRows } = await supabase
    .from('crypto_analyses')
    .select('market_id')
    .gte('analyzed_at', recentCutoff);
  const recentlyAnalyzed = new Set((recentRows ?? []).map((r: { market_id: string }) => r.market_id));

  // Skip markets where we already have an open bet — we can't add to the position
  // and burning API credits on them generates contradictory signals (e.g. BUY_YES on a BUY_NO position).
  const { data: openBetRows } = await supabase
    .from('bets')
    .select('market_id')
    .eq('status', 'OPEN');
  const openBetMarketIds = new Set((openBetRows ?? []).map((b: { market_id: string }) => b.market_id));

  const freshCandidates = candidates.filter(c =>
    !recentlyAnalyzed.has(c.market.id) && !openBetMarketIds.has(c.market.id)
  );
  const skippedOpen = candidates.filter(c => openBetMarketIds.has(c.market.id)).length;
  console.log(`[analyze-crypto] ${freshCandidates.length} fresh candidates (${candidates.length - freshCandidates.length} skipped: ${recentlyAnalyzed.size} recently analyzed, ${skippedOpen} have open bets)`);

  // Analyze top fresh candidates with Claude
  let analyzed = 0;

  for (const candidate of freshCandidates.slice(0, MAX_ANALYSES_PER_RUN)) {
    if (Date.now() - startTime > 20000) break;

    const { market, signal, asset } = candidate;
    const hoursRemaining = market.resolution_date
      ? Math.max(0, (new Date(market.resolution_date).getTime() - Date.now()) / 3600000)
      : 0;

    if (hoursRemaining < 2) continue;
    if (market.liquidity_usd < 5000) continue;

    // Parse signal summary for display
    let signalDetails: Record<string, string> = {};
    try { signalDetails = JSON.parse(signal.signal_summary); } catch { /* empty */ }

    const outcomesList = market.outcomes
      .map((o: string, i: number) => `${o} → $${market.outcome_prices[i]?.toFixed(3) || '?'}`)
      .join('\n');

    // Compute threshold context for explicit feasibility analysis
    const tc = extractThresholdContext(market.question, signal.spot_price, hoursRemaining);
    const thresholdSection = tc ? `
THRESHOLD ANALYSIS:
- Price target:       $${tc.target.toLocaleString()}
- Required move:      ${tc.pctMove > 0 ? '+' : ''}${tc.pctMove.toFixed(1)}% (${tc.direction.toUpperCase()})
- Days remaining:     ${tc.daysRemaining.toFixed(1)} days
- Required daily %:   ${tc.requiredDailyPct === Infinity ? 'N/A' : tc.requiredDailyPct.toFixed(2) + '%/day'}
- Feasibility:        ${tc.feasibilityNote}` : '';

    // Hard calibration rules derived from feasibility
    const hardRules: string[] = [];
    if (tc) {
      if (tc.requiredDailyPct > 5 && tc.daysRemaining < 7) {
        hardRules.push(`EXTREME MOVE REQUIRED: >5%/day for <7 days — bracket_prob MUST be <3% for BUY_YES. Auto_eligible MUST be false.`);
      }
      if (tc.requiredDailyPct > 3 && tc.daysRemaining < 3) {
        hardRules.push(`VERY SHORT WINDOW: required move is ${tc.absPctMove.toFixed(0)}% in ${tc.daysRemaining.toFixed(1)} days — bracket_prob MUST be <1%.`);
      }
      if (tc.absPctMove > 50) {
        hardRules.push(`CATASTROPHIC MOVE: target is ${tc.absPctMove.toFixed(0)}% from current — this is a black-swan bet. Treat market maker's price as much more reliable than your estimate.`);
      }
    }
    // Extra rule: very cheap YES markets (<1%) need substantial estimated probability
    const minPriceOutcome = Math.min(...market.outcome_prices.filter(p => p > 0));
    if (minPriceOutcome < 0.01) {
      hardRules.push(`MICRO-PRICED MARKET: some outcomes priced below 1%. Market makers price these very efficiently. Only BUY_YES if bracket_prob >= 5% with HIGH confidence.`);
    }
    const hardRulesSection = hardRules.length > 0
      ? `\nCALIBRATION RULES (MANDATORY — follow these exactly):\n${hardRules.map(r => `⚠️  ${r}`).join('\n')}`
      : '';

    const prompt = `You are ARBITER's crypto analyst. Compare technical signals against Polymarket price bracket markets to find genuine mispricings. You must be well-calibrated — not just finding mathematical edge, but ensuring the probabilities are realistic.

ASSET: ${asset}
CURRENT SPOT: $${signal.spot_price.toLocaleString(undefined, { maximumFractionDigits: 2 })} (LIVE — fresh from data feed, fetched ${Math.round((Date.now() - new Date(signal.fetched_at).getTime()) / 60000)} min ago)
1H AGO: $${signal.price_1h_ago?.toLocaleString(undefined, { maximumFractionDigits: 2 }) || 'N/A'}
24H AGO: $${signal.price_24h_ago?.toLocaleString(undefined, { maximumFractionDigits: 2 }) || 'N/A'}

TECHNICAL INDICATORS:
- RSI(14):         ${signal.rsi_14?.toFixed(1) ?? 'N/A'}${signal.rsi_14 ? (signal.rsi_14 > 70 ? ' (OVERBOUGHT)' : signal.rsi_14 < 30 ? ' (OVERSOLD — potential bounce, but downtrend can continue for days)' : ' (NEUTRAL)') : ''}
- Bollinger Upper: $${signal.bb_upper?.toFixed(0) ?? 'N/A'}
- Bollinger Lower: $${signal.bb_lower?.toFixed(0) ?? 'N/A'}
- Spot vs BB:      ${signal.bb_upper && signal.bb_lower ? (signal.spot_price > signal.bb_upper ? 'ABOVE UPPER BAND (overextended)' : signal.spot_price < signal.bb_lower ? 'BELOW LOWER BAND (oversold extension)' : 'WITHIN BANDS') : 'N/A'}
- 24H Volume:      $${signal.volume_24h ? (signal.volume_24h / 1e9).toFixed(2) + 'B' : 'N/A'}
- Momentum:        ${JSON.stringify(signalDetails)}
${thresholdSection}${hardRulesSection}

POLYMARKET BRACKET MARKET:
Question: ${market.question}
${outcomesList}
- Volume: $${market.volume_usd.toLocaleString()}
- Liquidity: $${market.liquidity_usd.toLocaleString()}
- Resolves: ${Math.round(hoursRemaining)} hours from now (${(hoursRemaining / 24).toFixed(1)} days)

TASK:
1. Use the CURRENT SPOT price above — this is live data, not a guess
2. Estimate the true probability for each outcome using realistic analysis of feasibility
3. If calibration rules above apply, ENFORCE them — do not rationalize around them
4. Compare your estimates to market prices; identify the best bet
5. Long-dated markets (>30 days) are more eligible for bets than near-term extreme moves
6. Polymarket market makers have real-time data — treat very cheap (<2%) prices with extreme skepticism

IMPORTANT: The market price for a YES outcome priced at 0.3% means professional traders with full information give this only 0.3% probability. Your edge should come from genuine insight, not just "crypto is volatile."

Respond ONLY in JSON:
{
  "asset": string,
  "spot_at_analysis": number,
  "target_bracket": string (the bracket label you're betting on),
  "bracket_prob": number (your estimated true probability 0-1),
  "market_price": number (Polymarket price for that bracket),
  "edge": number (bracket_prob - market_price),
  "direction": "BUY_YES"|"BUY_NO"|"PASS",
  "confidence": "HIGH"|"MEDIUM"|"LOW",
  "kelly_fraction": number,
  "rec_bet_usd": number,
  "reasoning": string (must explicitly address feasibility and the current spot price distance to threshold),
  "auto_eligible": boolean,
  "flags": string[]
}`;

    try {
      // Feature flag: use ensemble if multiple API keys are available
      const USE_ENSEMBLE = (process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY) ? true : false;

      let analysis: any;
      let ensembleData: any = null;

      if (USE_ENSEMBLE) {
        // Call ensemble for parallel multi-model analysis
        try {
          ensembleData = await ensembleAnalyze(prompt);

          // Extract Claude response from ensemble (primary model)
          const claudeResponse = ensembleData.model_responses.find((r: any) => r.model === 'claude');
          if (!claudeResponse) {
            console.error(`[analyze-crypto] Ensemble failed to return Claude response for market ${market.id}`);
            continue;
          }

          // Parse Claude's full JSON response if available
          // The ensemble gives us structured data, but we need the raw analysis object
          // Fall back to direct Claude if parsing fails
          if (claudeResponse.direction && claudeResponse.edge !== null) {
            // Build analysis object from ensemble consensus if Claude was included
            analysis = {
              asset: asset,
              spot_at_analysis: signal.spot_price,
              target_bracket: market.outcomes[0] || '',
              bracket_prob: null, // Will be extracted from reasoning or use consensus
              market_price: null,
              edge: claudeResponse.edge,
              direction: claudeResponse.direction,
              confidence: claudeResponse.confidence,
              kelly_fraction: 0,
              rec_bet_usd: 0,
              reasoning: claudeResponse.reasoning,
              auto_eligible: false,
              flags: [],
            };

            // Log ensemble metrics
            console.log(
              `[analyze-crypto] Ensemble: models=${ensembleData.used_models.join(',')} | agreement=${(ensembleData.agreement_score * 100).toFixed(1)}% | latencies=${ensembleData.model_responses.map((r: any) => `${r.model}:${r.latency_ms}ms`).join(', ')}`
            );

            // If models disagree (agreement < 0.67), downgrade confidence as a warning
            if (ensembleData.agreement_score < 0.67 && analysis.confidence !== 'LOW') {
              console.log(`[analyze-crypto] Model disagreement detected (${(ensembleData.agreement_score * 100).toFixed(1)}%) — downgrading confidence from ${analysis.confidence} to LOW`);
              analysis.confidence = 'LOW';
            }
          }
        } catch (ensembleErr) {
          console.error(`[analyze-crypto] Ensemble call failed, falling back to direct Claude:`, ensembleErr);
          // Fall through to direct Claude as backup
          analysis = null;
        }
      }

      // Fallback to direct Claude if ensemble unavailable or failed
      if (!analysis) {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: CLAUDE_MODEL,
            max_tokens: 1200,
            messages: [{ role: 'user', content: prompt }],
          }),
          signal: AbortSignal.timeout(15000),
        });

        if (!res.ok) {
          console.error(`[analyze-crypto] Claude API error: ${res.status}`);
          continue;
        }

        const data = await res.json();
        const text = data.content?.[0]?.text;
        if (!text) continue;

        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) continue;

        try {
          analysis = JSON.parse(jsonMatch[0]);
        } catch {
          console.error(`[analyze-crypto] JSON parse error for market ${market.id}`);
          continue;
        }

        if (ensembleData) {
          console.log(`[analyze-crypto] Used direct Claude fallback (ensemble consensus unavailable)`);
        }
      }

      // ── RUNTIME VALIDATION ──────────────────────────────────────────
      // Reject malformed Claude responses at the boundary. This catches
      // bad edge values, missing fields, and normalization issues BEFORE
      // they propagate into Kelly sizing and bet placement.
      const { validateCryptoAnalysis } = await import('../../src/lib/validate-analysis');
      const validation = validateCryptoAnalysis(analysis);
      if (!validation.valid) {
        console.error(`[analyze-crypto] VALIDATION FAILED for market ${market.id}:`, validation.errors.join('; '));
        continue;
      }
      // Use validated + normalized data from here on.
      // Keep the raw `analysis` object for fields the validator passes through unchanged,
      // but override the numeric fields with validated versions.
      analysis.bracket_prob = validation.data.bracket_prob;
      analysis.market_price = validation.data.market_price;
      analysis.edge = validation.data.edge;
      analysis.direction = validation.data.direction;
      analysis.confidence = validation.data.confidence;
      analysis.auto_eligible = validation.data.auto_eligible;
      analysis.flags = validation.data.flags;

      // ── POST-PROCESSING HARD GATE ──────────────────────────────────
      // Claude's prompt rules are advisory — LLMs can rationalize around them.
      // These code-level overrides are non-negotiable and cannot be ignored.
      if (tc && analysis.direction !== 'PASS') {
        // Gate 1: >5%/day required move within 7 days → physically impossible to sustain
        // Applies to BOTH BUY_YES (betting it will happen) and BUY_NO (betting against it)
        // For BUY_YES: don't bet on impossible moves. For BUY_NO: market already prices it near 0,
        // so the edge is illusory (you pay 97¢ to win 3¢).
        if (tc.requiredDailyPct > 5 && tc.daysRemaining < 7) {
          console.log(`[analyze-crypto] HARD GATE: ${tc.requiredDailyPct.toFixed(1)}%/day required in ${tc.daysRemaining.toFixed(1)} days — forcing PASS on ${analysis.direction}`);
          analysis.direction = 'PASS';
          analysis.auto_eligible = false;
          if (!analysis.flags) analysis.flags = [];
          analysis.flags.push('HARD_GATE_DAILY_MOVE_EXCEEDED');
        }
        // Gate 2: >30% move required within 30 days for long-shot markets priced under 3%
        if (tc.absPctMove > 30 && tc.daysRemaining < 30 && (analysis.market_price ?? 1) < 0.03) {
          console.log(`[analyze-crypto] HARD GATE: ${tc.absPctMove.toFixed(0)}% move in ${tc.daysRemaining.toFixed(1)} days with <3% market price — forcing PASS`);
          analysis.direction = 'PASS';
          analysis.auto_eligible = false;
          if (!analysis.flags) analysis.flags = [];
          analysis.flags.push('HARD_GATE_EXTREME_MOVE_SHORT_WINDOW');
        }
        // Gate 3: BUY_NO on near-certain outcomes (market price > 97%) — paying 97¢+ to win <3¢
        // is negative EV after fees and slippage, even with a "real" edge.
        if (analysis.direction === 'BUY_NO' && (analysis.market_price ?? 0) > 0.97) {
          console.log(`[analyze-crypto] HARD GATE: BUY_NO at ${((analysis.market_price ?? 0) * 100).toFixed(1)}% — too expensive for meaningful return`);
          analysis.direction = 'PASS';
          analysis.auto_eligible = false;
          if (!analysis.flags) analysis.flags = [];
          analysis.flags.push('HARD_GATE_BUY_NO_TOO_EXPENSIVE');
        }
      }

      // Calculate Kelly bet size
      let kellyFraction = 0;
      let recBetUsd = 0;

      const absEdge = analysis.direction === 'BUY_NO' && analysis.edge < 0 ? -analysis.edge : analysis.edge;
      if (analysis.direction !== 'PASS' && absEdge >= MIN_EDGE_PCT) {
        const { data: configRows } = await supabase
          .from('system_config')
          .select('key, value')
          .in('key', ['paper_bankroll']);

        const bankroll = parseFloat(configRows?.find((r: { key: string }) => r.key === 'paper_bankroll')?.value || '5000');

        // Look up latest calibration for this category + confidence tier
        const { data: calData } = await supabase
          .from('calibration_snapshots')
          .select('total_bets, predicted_win_rate, actual_win_rate')
          .eq('category', 'crypto')
          .eq('confidence_tier', analysis.confidence || 'LOW')
          .order('snapshot_date', { ascending: false })
          .limit(1)
          .single();

        const { computeKelly, getCalibrationDiscount } = await import('../../src/lib/trading-math');
        const calDiscount = getCalibrationDiscount(calData);
        const kelly = computeKelly({
          trueProb: analysis.bracket_prob,
          marketPrice: analysis.market_price,
          direction: analysis.direction,
          confidence: analysis.confidence,
          category: 'crypto',
          liquidityUsd: market.liquidity_usd,
          bankroll,
          calibrationDiscount: calDiscount,
        });
        kellyFraction = kelly.kellyFraction;
        recBetUsd = kelly.recBetUsd;
      }

      // ── Normalize before storing (fixes the 849 bug at source) ──
      // For BUY_NO bets, edge = bracket_prob - market_price is negative (YES is overpriced).
      // Store the absolute magnitude so place-bets' `edge > MIN_EDGE` filter works correctly.
      const rawEdge = analysis.direction === 'BUY_NO' && analysis.edge < 0
        ? -analysis.edge
        : analysis.edge;
      // Cap at 0.50: Claude sometimes returns edge=0.998 for near-certain NO bets
      // (e.g., "BTC won't hit $150k this month") — uncapped, Kelly would over-bet massively.
      const edgeNorm      = Math.min(normalizeEdge(rawEdge) ?? 0, 0.50) || null;
      const bracketNorm   = normalizeProb(analysis.bracket_prob);
      const mktPriceNorm  = normalizeProb(analysis.market_price);

      // Store analysis
      await supabase.from('crypto_analyses').insert({
        market_id: market.id,
        signal_id: signal.id,
        asset: analysis.asset || asset,
        spot_at_analysis: analysis.spot_at_analysis || signal.spot_price,
        target_bracket: analysis.target_bracket,
        bracket_prob: bracketNorm,
        market_price: mktPriceNorm,
        edge: edgeNorm,
        direction: analysis.direction || 'PASS',
        confidence: analysis.confidence || 'LOW',
        kelly_fraction: kellyFraction,
        rec_bet_usd: recBetUsd,
        reasoning: analysis.reasoning,
        auto_eligible: analysis.auto_eligible || false,
        flags: analysis.flags || [],
      });

      analyzed++;
      console.log(`[analyze-crypto] ${asset} bracket "${analysis.target_bracket}": edge=${analysis.edge?.toFixed(3)} dir=${analysis.direction}`);
    } catch (err) {
      console.error(`[analyze-crypto] Analysis failed:`, err);
    }
  }

  console.log(`[analyze-crypto] Done. Analyzed ${analyzed} markets in ${Date.now() - startTime}ms`);
  return { statusCode: 200 };
});
