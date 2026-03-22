import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Allow up to 60s for analysis + placement

// ============================================================
// Full Pipeline: Analyze + Place Bets (Manual Trigger)
// GET /api/trigger/bets
//
// This is the COMPLETE pipeline that:
// 1. Checks for existing analyses (last 6 hours)
// 2. If none exist, runs inline Claude analysis on best markets
// 3. Places paper bets from all eligible analyses
//
// This fixes the race condition where market discovery runs but
// no analyses exist yet because the cron hasn't fired.
// ============================================================

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const MAX_SINGLE_BET_PCT = 0.05;
const MAX_DAILY_EXPOSURE_PCT = 0.25;
const MAX_DAILY_BETS = 20;
const MIN_EDGE = 0.02; // Lower threshold to capture more opportunities

interface AnalysisCandidate {
  id: string;
  market_id: string;
  direction: string;
  confidence: string;
  edge: number | null;
  kelly_fraction: number | null;
  rec_bet_usd: number | null;
  auto_eligible: boolean;
  category: string;
  best_outcome_label?: string | null;
  market_price?: number | null;
  event_description?: string | null;
  polymarket_price?: number | null;
  target_bracket?: string | null;
  asset?: string | null;
}

export async function GET() {
  const supabase = getSupabaseAdmin();
  const log: string[] = [];
  const startTime = Date.now();

  try {
    // ============================================================
    // STEP 0: Load system config
    // ============================================================
    const { data: configRows } = await supabase
      .from('system_config')
      .select('key, value')
      .in('key', ['paper_bankroll', 'paper_trade_start_date', 'total_paper_bets']);

    const config: Record<string, string> = {};
    configRows?.forEach((r) => { config[r.key] = r.value; });

    const bankroll = parseFloat(config.paper_bankroll || '500');
    const maxSingleBet = bankroll * MAX_SINGLE_BET_PCT;
    const maxDailyExposure = bankroll * MAX_DAILY_EXPOSURE_PCT;

    // Today's existing bets
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { data: todaysBets } = await supabase
      .from('bets')
      .select('id, amount_usd, market_id')
      .gte('placed_at', todayStart.toISOString());

    const todayBetCount = todaysBets?.length || 0;
    const todayExposure = todaysBets?.reduce((sum, b) => sum + (b.amount_usd || 0), 0) || 0;

    log.push(`Bankroll: $${bankroll} | Today: ${todayBetCount} bets, $${todayExposure.toFixed(2)} deployed`);

    if (todayBetCount >= MAX_DAILY_BETS) {
      log.push('Daily bet limit reached');
      return NextResponse.json({ success: true, placed: 0, log });
    }

    // All open bet market IDs (prevent duplicates)
    const { data: openBets } = await supabase
      .from('bets')
      .select('market_id')
      .eq('status', 'OPEN');
    const openMarketIds = new Set(openBets?.map((b) => b.market_id) || []);

    // ============================================================
    // STEP 1: Check for existing analyses (last 6 hours)
    // ============================================================
    const cutoff = new Date(Date.now() - 6 * 3600000).toISOString();

    const [weatherRes, sportsRes, cryptoRes] = await Promise.all([
      supabase.from('weather_analyses').select('*').gte('analyzed_at', cutoff).neq('direction', 'PASS').gt('edge', MIN_EDGE).order('edge', { ascending: false }),
      supabase.from('sports_analyses').select('*').gte('analyzed_at', cutoff).neq('direction', 'PASS').gt('edge', MIN_EDGE).order('edge', { ascending: false }),
      supabase.from('crypto_analyses').select('*').gte('analyzed_at', cutoff).neq('direction', 'PASS').gt('edge', MIN_EDGE).order('edge', { ascending: false }),
    ]);

    let candidates: AnalysisCandidate[] = [
      ...(weatherRes.data || []).map((a) => ({ ...a, category: 'weather' as const })),
      ...(sportsRes.data || []).map((a) => ({ ...a, category: 'sports' as const })),
      ...(cryptoRes.data || []).map((a) => ({ ...a, category: 'crypto' as const })),
    ];

    log.push(`Existing analyses: ${weatherRes.data?.length || 0} weather, ${sportsRes.data?.length || 0} sports, ${cryptoRes.data?.length || 0} crypto`);

    // ============================================================
    // STEP 2: If no analyses exist, run inline Claude analysis
    // This is the KEY FIX — instead of waiting for cron, we analyze now
    // ============================================================
    if (candidates.length === 0 && process.env.ANTHROPIC_API_KEY) {
      log.push('No existing analyses — running inline analysis...');

      // 2a: Try sports markets (most available on Polymarket)
      const { data: sportsMarkets } = await supabase
        .from('markets')
        .select('*')
        .eq('category', 'sports')
        .eq('is_active', true)
        .order('volume_usd', { ascending: false })
        .limit(10);

      if (sportsMarkets && sportsMarkets.length > 0) {
        log.push(`Found ${sportsMarkets.length} sports markets for inline analysis`);
        const newAnalyses = await runInlineSportsAnalysis(supabase, sportsMarkets.slice(0, 3), bankroll, log);
        candidates.push(...newAnalyses);
      }

      // 2b: Try crypto markets
      if (Date.now() - startTime < 40000) {
        const { data: cryptoMarkets } = await supabase
          .from('markets')
          .select('*')
          .eq('category', 'crypto')
          .eq('is_active', true)
          .order('volume_usd', { ascending: false })
          .limit(10);

        if (cryptoMarkets && cryptoMarkets.length > 0) {
          log.push(`Found ${cryptoMarkets.length} crypto markets for inline analysis`);

          // Get latest signals
          const { data: signals } = await supabase
            .from('crypto_signals')
            .select('*')
            .order('fetched_at', { ascending: false })
            .limit(10);

          const latestSignals: Record<string, typeof signals extends (infer T)[] | null ? T : never> = {};
          if (signals) {
            for (const s of signals) {
              if (!latestSignals[s.asset]) latestSignals[s.asset] = s;
            }
          }

          const newCryptoAnalyses = await runInlineCryptoAnalysis(
            supabase, cryptoMarkets.slice(0, 3), latestSignals, bankroll, log
          );
          candidates.push(...newCryptoAnalyses);
        }
      }

      // 2c: Try weather markets
      if (Date.now() - startTime < 40000) {
        const { data: weatherMarkets } = await supabase
          .from('markets')
          .select('*, weather_cities(*)')
          .eq('is_active', true)
          .not('city_id', 'is', null)
          .order('volume_usd', { ascending: false })
          .limit(5);

        if (weatherMarkets && weatherMarkets.length > 0) {
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          const tomorrowStr = tomorrow.toISOString().split('T')[0];

          for (const market of weatherMarkets.slice(0, 2)) {
            if (Date.now() - startTime > 45000) break;
            const city = market.weather_cities;
            if (!city) continue;

            const { data: consensusArr } = await supabase
              .from('weather_consensus')
              .select('*')
              .eq('city_id', city.id)
              .eq('valid_date', tomorrowStr)
              .order('calculated_at', { ascending: false })
              .limit(1);

            const consensus = consensusArr?.[0];
            if (!consensus || consensus.agreement === 'LOW') continue;

            const newWeatherAnalyses = await runInlineWeatherAnalysis(
              supabase, market, city, consensus, bankroll, log
            );
            candidates.push(...newWeatherAnalyses);
          }
        }
      }

      log.push(`Inline analysis produced ${candidates.length} candidates`);
    }

    // ============================================================
    // STEP 3: Place bets from all candidates
    // ============================================================
    candidates.sort((a, b) => (b.edge || 0) - (a.edge || 0));

    let placed = 0;
    let totalDeployed = todayExposure;

    for (const analysis of candidates) {
      if (placed + todayBetCount >= MAX_DAILY_BETS) break;
      if (totalDeployed >= maxDailyExposure) break;
      if (Date.now() - startTime > 55000) break;

      // Skip duplicate positions
      if (openMarketIds.has(analysis.market_id)) {
        log.push(`Skip ${analysis.market_id.substring(0, 8)} — already open`);
        continue;
      }

      // Must have at least MEDIUM confidence
      const isMediumEligible =
        (analysis.confidence === 'HIGH' || analysis.confidence === 'MEDIUM') &&
        (analysis.edge || 0) >= MIN_EDGE;

      if (!analysis.auto_eligible && !isMediumEligible) continue;

      // Calculate bet size
      let betAmount = analysis.rec_bet_usd || 0;
      if (betAmount <= 0 && analysis.kelly_fraction && analysis.kelly_fraction > 0) {
        betAmount = Math.max(1, Math.round(bankroll * analysis.kelly_fraction * 100) / 100);
      }
      if (betAmount <= 0) betAmount = 5; // Default $5 for paper trading
      betAmount = Math.min(betAmount, maxSingleBet, maxDailyExposure - totalDeployed);
      if (betAmount < 1) break;

      // Determine outcome label and entry price
      let outcomeLabel: string | null = null;
      let entryPrice: number | null = null;

      if (analysis.category === 'weather') {
        outcomeLabel = analysis.best_outcome_label || null;
        entryPrice = analysis.market_price || null;
      } else if (analysis.category === 'sports') {
        outcomeLabel = analysis.event_description || null;
        entryPrice = analysis.polymarket_price || analysis.market_price || null;
      } else if (analysis.category === 'crypto') {
        outcomeLabel = analysis.target_bracket || analysis.asset || null;
        entryPrice = analysis.market_price || null;
      }

      // Normalize entry price — handle percentages (e.g., 90 → 0.90)
      if (entryPrice && entryPrice > 1) {
        entryPrice = entryPrice / 100;
      }

      // Validate entry price (must be between 0.01 and 0.99 exclusive)
      if (!entryPrice || entryPrice <= 0.005 || entryPrice >= 0.995) {
        log.push(`Skip ${analysis.market_id.substring(0, 8)} — price ${entryPrice} out of range`);
        continue;
      }

      const { error } = await supabase.from('bets').insert({
        market_id: analysis.market_id,
        analysis_id: analysis.id,
        category: analysis.category,
        direction: analysis.direction,
        outcome_label: outcomeLabel,
        entry_price: entryPrice,
        amount_usd: betAmount,
        is_paper: true,
        status: 'OPEN',
        placed_at: new Date().toISOString(),
      });

      if (error) {
        log.push(`Error: ${error.message}`);
        continue;
      }

      placed++;
      totalDeployed += betAmount;
      openMarketIds.add(analysis.market_id);
      log.push(`BET: ${analysis.category} ${analysis.direction} $${betAmount.toFixed(2)} @ ${entryPrice.toFixed(3)} | edge=${((analysis.edge || 0) * 100).toFixed(1)}% ${analysis.confidence}`);
    }

    // Update paper_trade_start_date on first ever bet
    if (placed > 0 && !config.paper_trade_start_date) {
      await supabase
        .from('system_config')
        .update({ value: new Date().toISOString().split('T')[0], updated_at: new Date().toISOString() })
        .eq('key', 'paper_trade_start_date');
      log.push('Started paper trading clock');
    }

    // Update total bet count
    if (placed > 0) {
      const { count } = await supabase
        .from('bets')
        .select('*', { count: 'exact', head: true });
      await supabase
        .from('system_config')
        .update({ value: (count || 0).toString(), updated_at: new Date().toISOString() })
        .eq('key', 'total_paper_bets');
    }

    const elapsed = Date.now() - startTime;
    log.push(`Done in ${elapsed}ms — placed ${placed} bets, $${totalDeployed.toFixed(2)} total deployed`);

    return NextResponse.json({
      success: true,
      placed,
      totalDeployed: totalDeployed.toFixed(2),
      candidates: candidates.length,
      log,
    });
  } catch (err) {
    log.push(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ success: false, placed: 0, log }, { status: 500 });
  }
}

// ============================================================
// Inline Analysis Functions
// These replicate the scheduled function logic but run on-demand
// ============================================================

async function runInlineSportsAnalysis(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  markets: Array<{ id: string; question: string; outcomes: string[]; outcome_prices: number[]; volume_usd: number; liquidity_usd: number; resolution_date: string | null }>,
  bankroll: number,
  log: string[]
): Promise<AnalysisCandidate[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];

  const results: AnalysisCandidate[] = [];

  for (const market of markets) {
    try {
      const outcomesList = market.outcomes
        .map((o: string, i: number) => `${o} → YES price: $${(market.outcome_prices[i] || 0).toFixed(3)}`)
        .join('\n');

      const prompt = `You are ARBITER's sports analyst. Analyze this Polymarket sports market for mispricings.

MARKET: ${market.question}

POLYMARKET OUTCOMES (current YES prices):
${outcomesList}

Volume: $${market.volume_usd.toLocaleString()}
Liquidity: $${market.liquidity_usd.toLocaleString()}

TASK: Based on your knowledge of current team performance, injuries, schedules, and public consensus:
1. Estimate the TRUE probability for the most liquid YES outcome
2. Compare to the Polymarket price to find edge
3. If edge >= 3%, recommend a bet

Respond ONLY in JSON:
{
  "event_description": string,
  "sport": string,
  "estimated_prob": number (0-1),
  "polymarket_price": number (0-1),
  "edge": number (positive = underpriced),
  "direction": "BUY_YES"|"BUY_NO"|"PASS",
  "confidence": "HIGH"|"MEDIUM"|"LOW",
  "reasoning": string (1-2 sentences),
  "auto_eligible": boolean
}`;

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 800,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        log.push(`Claude API error: ${res.status}`);
        continue;
      }

      const data = await res.json();
      const text = data.content?.[0]?.text;
      if (!text) continue;

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;

      const analysis = JSON.parse(jsonMatch[0]);

      if (analysis.direction === 'PASS' || !analysis.edge || analysis.edge < MIN_EDGE) continue;

      // Calculate Kelly
      const p = analysis.estimated_prob || 0.5;
      const c = analysis.polymarket_price || 0.5;
      const edge = Math.abs(p - c);
      let kellyFraction = 0;
      let recBetUsd = 0;

      if (edge >= MIN_EDGE && c > 0 && c < 1) {
        const b = (1 - c) / c;
        const fullKelly = (p * b - (1 - p)) / b;
        if (fullKelly > 0) {
          const confMult = { HIGH: 1.0, MEDIUM: 0.6, LOW: 0.2 }[analysis.confidence as string] || 0.2;
          kellyFraction = Math.min(fullKelly * 0.25 * confMult, 0.05);
          recBetUsd = Math.max(1, Math.round(bankroll * kellyFraction * 100) / 100);
        }
      }

      // Store in DB
      const { data: inserted, error } = await supabase
        .from('sports_analyses')
        .insert({
          market_id: market.id,
          event_description: analysis.event_description || market.question,
          sport: analysis.sport || 'unknown',
          sportsbook_consensus: analysis.estimated_prob || 0,
          polymarket_price: analysis.polymarket_price || c,
          edge: edge,
          direction: analysis.direction,
          confidence: analysis.confidence || 'LOW',
          kelly_fraction: kellyFraction,
          rec_bet_usd: recBetUsd,
          reasoning: analysis.reasoning || '',
          auto_eligible: analysis.auto_eligible || false,
          analyzed_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (error) {
        log.push(`DB insert error: ${error.message}`);
        continue;
      }

      if (inserted) {
        results.push({
          ...inserted,
          category: 'sports',
        });
        log.push(`Analyzed sports: "${market.question.substring(0, 50)}" edge=${(edge * 100).toFixed(1)}%`);
      }
    } catch (err) {
      log.push(`Sports analysis error: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  return results;
}

async function runInlineCryptoAnalysis(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  markets: Array<{ id: string; question: string; outcomes: string[]; outcome_prices: number[]; volume_usd: number; liquidity_usd: number; resolution_date: string | null }>,
  signals: Record<string, { spot_price: number; rsi_14: number | null; bb_upper: number | null; bb_lower: number | null; volume_24h: number | null; signal_summary: string }>,
  bankroll: number,
  log: string[]
): Promise<AnalysisCandidate[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];

  const results: AnalysisCandidate[] = [];

  for (const market of markets) {
    try {
      const q = market.question.toLowerCase();
      const asset = /\bbtc\b|bitcoin/.test(q) ? 'BTC' : /\beth\b|ethereum/.test(q) ? 'ETH' : null;
      const signal = asset ? signals[asset] : null;

      const outcomesList = market.outcomes
        .map((o: string, i: number) => `${o} → YES price: $${(market.outcome_prices[i] || 0).toFixed(3)}`)
        .join('\n');

      const signalInfo = signal
        ? `Spot: $${signal.spot_price.toLocaleString()} | RSI: ${signal.rsi_14?.toFixed(1) || 'N/A'} | BB: ${signal.bb_lower?.toFixed(0) || '?'}-${signal.bb_upper?.toFixed(0) || '?'} | 24h Vol: ${signal.volume_24h ? `$${(signal.volume_24h / 1e9).toFixed(1)}B` : 'N/A'}`
        : 'No signal data available';

      const prompt = `You are ARBITER's crypto analyst. Analyze this Polymarket crypto bracket market.

MARKET: ${market.question}
ASSET: ${asset || 'unknown'}
SIGNALS: ${signalInfo}

OUTCOMES (current YES prices):
${outcomesList}

TASK: Based on current price, momentum, and technicals:
1. Estimate which bracket is most likely
2. Calculate edge vs market price
3. If edge >= 3%, recommend a bet

Respond ONLY in JSON:
{
  "asset": string,
  "target_bracket": string,
  "bracket_prob": number (0-1),
  "market_price": number (0-1),
  "edge": number,
  "direction": "BUY_YES"|"BUY_NO"|"PASS",
  "confidence": "HIGH"|"MEDIUM"|"LOW",
  "reasoning": string,
  "auto_eligible": boolean
}`;

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 800,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) continue;

      const data = await res.json();
      const text = data.content?.[0]?.text;
      if (!text) continue;

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;

      const analysis = JSON.parse(jsonMatch[0]);

      if (analysis.direction === 'PASS' || !analysis.edge || analysis.edge < MIN_EDGE) continue;

      const p = analysis.bracket_prob || 0.5;
      const c = analysis.market_price || 0.5;
      const edge = Math.abs(p - c);
      let kellyFraction = 0;
      let recBetUsd = 0;

      if (edge >= MIN_EDGE && c > 0 && c < 1) {
        const b = (1 - c) / c;
        const fullKelly = (p * b - (1 - p)) / b;
        if (fullKelly > 0) {
          const confMult = { HIGH: 1.0, MEDIUM: 0.6, LOW: 0.2 }[analysis.confidence as string] || 0.2;
          kellyFraction = Math.min(fullKelly * 0.25 * confMult, 0.05);
          recBetUsd = Math.max(1, Math.round(bankroll * kellyFraction * 100) / 100);
        }
      }

      const { data: inserted, error } = await supabase
        .from('crypto_analyses')
        .insert({
          market_id: market.id,
          asset: analysis.asset || asset || 'unknown',
          spot_at_analysis: signal?.spot_price || 0,
          target_bracket: analysis.target_bracket || '',
          bracket_prob: p,
          market_price: c,
          edge: edge,
          direction: analysis.direction,
          confidence: analysis.confidence || 'LOW',
          kelly_fraction: kellyFraction,
          rec_bet_usd: recBetUsd,
          reasoning: analysis.reasoning || '',
          auto_eligible: analysis.auto_eligible || false,
          analyzed_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (error) {
        log.push(`Crypto DB error: ${error.message}`);
        continue;
      }

      if (inserted) {
        results.push({ ...inserted, category: 'crypto' });
        log.push(`Analyzed crypto: "${market.question.substring(0, 50)}" edge=${(edge * 100).toFixed(1)}%`);
      }
    } catch (err) {
      log.push(`Crypto analysis error: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  return results;
}

async function runInlineWeatherAnalysis(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  market: { id: string; question: string; outcomes: string[]; outcome_prices: number[]; volume_usd: number; liquidity_usd: number; resolution_date: string | null },
  city: { id: string; name: string },
  consensus: { id: string; consensus_high_f: number; model_spread_f: number; agreement: string },
  bankroll: number,
  log: string[]
): Promise<AnalysisCandidate[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];

  try {
    const outcomesList = market.outcomes
      .map((o: string, i: number) => `${o} → $${(market.outcome_prices[i] || 0).toFixed(3)}`)
      .join('\n');

    const prompt = `You are ARBITER's weather analyst. Compare forecast consensus to Polymarket brackets.

CITY: ${city.name}
CONSENSUS HIGH: ${consensus.consensus_high_f}°F (spread: ${consensus.model_spread_f}°F, agreement: ${consensus.agreement})

POLYMARKET BRACKETS:
${outcomesList}

TASK: Identify the bracket the consensus falls in, estimate true probability, and find edge.

Respond ONLY in JSON:
{
  "best_bet": {
    "outcome_index": number,
    "outcome_label": string,
    "market_price": number (0-1),
    "true_prob": number (0-1),
    "edge": number,
    "direction": "BUY_YES"|"BUY_NO"|"PASS",
    "confidence": "HIGH"|"MEDIUM"|"LOW",
    "reasoning": string
  },
  "auto_eligible": boolean
}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return [];

    const data = await res.json();
    const text = data.content?.[0]?.text;
    if (!text) return [];

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const analysis = JSON.parse(jsonMatch[0]);
    const bet = analysis.best_bet;
    if (!bet || bet.direction === 'PASS' || !bet.edge || bet.edge < MIN_EDGE) return [];

    const p = bet.true_prob || 0.5;
    const c = bet.market_price || 0.5;
    let kellyFraction = 0;
    let recBetUsd = 0;

    if (c > 0 && c < 1) {
      const b = (1 - c) / c;
      const fullKelly = (p * b - (1 - p)) / b;
      if (fullKelly > 0) {
        const confMult = { HIGH: 1.0, MEDIUM: 0.6, LOW: 0.2 }[bet.confidence as string] || 0.2;
        kellyFraction = Math.min(fullKelly * 0.25 * confMult, 0.05);
        recBetUsd = Math.max(1, Math.round(bankroll * kellyFraction * 100) / 100);
      }
    }

    const { data: inserted, error } = await supabase
      .from('weather_analyses')
      .insert({
        market_id: market.id,
        city_id: city.id,
        consensus_id: consensus.id,
        model_high_f: consensus.consensus_high_f,
        model_spread_f: consensus.model_spread_f,
        model_agreement: consensus.agreement,
        best_outcome_idx: bet.outcome_index ?? null,
        best_outcome_label: bet.outcome_label ?? null,
        market_price: bet.market_price ?? null,
        true_prob: bet.true_prob ?? null,
        edge: bet.edge ?? null,
        direction: bet.direction,
        confidence: bet.confidence || 'LOW',
        kelly_fraction: kellyFraction,
        rec_bet_usd: recBetUsd,
        reasoning: bet.reasoning || '',
        auto_eligible: analysis.auto_eligible || false,
        flags: [],
        analyzed_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      log.push(`Weather DB error: ${error.message}`);
      return [];
    }

    if (inserted) {
      log.push(`Analyzed weather: ${city.name} edge=${(bet.edge * 100).toFixed(1)}%`);
      return [{ ...inserted, category: 'weather' }];
    }
  } catch (err) {
    log.push(`Weather analysis error: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  return [];
}
