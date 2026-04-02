import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = getSupabaseAdmin();

  const cutoff48h = new Date(Date.now() - 48 * 3600000).toISOString();
  const cutoff24h = new Date(Date.now() - 24 * 3600000).toISOString();

  const [optRes, postRes, anlRes] = await Promise.all([
    // Recent options signals (last 48h)
    supabase
      .from('options_flow_signals')
      .select('id, detected_at, ticker, put_call_ratio, mean_pcr, zscore, is_anomaly, anomaly_direction, call_volume, put_volume')
      .gte('detected_at', cutoff48h)
      .order('detected_at', { ascending: false })
      .limit(100),

    // Recent Trump posts (last 24h)
    supabase
      .from('trump_posts')
      .select('id, posted_at, content, url, keywords, market_impact_score, categories')
      .gte('posted_at', cutoff24h)
      .order('market_impact_score', { ascending: false })
      .limit(20),

    // Sentiment analyses (last 24h)
    supabase
      .from('sentiment_analyses')
      .select('id, analyzed_at, market_id, signal_type, trump_keywords, market_price, true_prob, edge, direction, confidence, kelly_fraction, rec_bet_usd, reasoning, auto_eligible, flags')
      .gte('analyzed_at', cutoff24h)
      .order('analyzed_at', { ascending: false })
      .limit(30),
  ]);

  const rawAnalyses = anlRes.data ?? [];

  // Join market questions
  const marketIds = [...new Set(rawAnalyses.map(a => a.market_id).filter(Boolean))];
  let questionMap: Record<string, string> = {};
  if (marketIds.length > 0) {
    const { data: markets } = await supabase
      .from('markets')
      .select('id, question')
      .in('id', marketIds.slice(0, 30));
    questionMap = Object.fromEntries((markets ?? []).map((m: { id: string; question: string }) => [m.id, m.question]));
  }

  const analyses = rawAnalyses.map(a => ({
    ...a,
    market_question: questionMap[a.market_id] ?? null,
  }));

  return NextResponse.json({
    optionsSignals: optRes.data ?? [],
    trumpPosts: postRes.data ?? [],
    analyses,
  });
}
