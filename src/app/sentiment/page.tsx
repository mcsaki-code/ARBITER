'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function confidenceDots(level: string): string {
  if (level === 'HIGH')   return '●●●○';
  if (level === 'MEDIUM') return '●●○○';
  return '●○○○';
}

function relTime(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 2)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

function directionBadge(dir: string) {
  if (dir === 'BUY_YES') return <span className="px-2 py-0.5 rounded text-xs font-bold bg-emerald-100 text-emerald-700">BUY YES</span>;
  if (dir === 'BUY_NO')  return <span className="px-2 py-0.5 rounded text-xs font-bold bg-red-100 text-red-700">BUY NO</span>;
  return <span className="px-2 py-0.5 rounded text-xs font-bold bg-gray-100 text-gray-500">PASS</span>;
}

function signalTypeBadge(type: string) {
  if (type === 'options_trump') return <span className="px-2 py-0.5 rounded text-xs font-bold bg-purple-100 text-purple-700">🔥 OPTIONS + TWEET</span>;
  if (type === 'trump_only')   return <span className="px-2 py-0.5 rounded text-xs font-bold bg-orange-100 text-orange-700">📢 TWEET</span>;
  return <span className="px-2 py-0.5 rounded text-xs font-bold bg-blue-100 text-blue-700">📊 OPTIONS FLOW</span>;
}

interface OptionsSignal {
  id: string;
  detected_at: string;
  ticker: string;
  put_call_ratio: number;
  mean_pcr: number;
  zscore: number;
  is_anomaly: boolean;
  anomaly_direction: string;
  call_volume: number;
  put_volume: number;
}

interface TrumpPost {
  id: string;
  posted_at: string;
  content: string;
  url: string;
  keywords: string[];
  market_impact_score: number;
  categories: string[];
}

interface SentimentAnalysis {
  id: string;
  analyzed_at: string;
  market_id: string;
  signal_type: string;
  trump_keywords: string[];
  market_price: number;
  true_prob: number;
  edge: number;
  direction: string;
  confidence: string;
  kelly_fraction: number;
  rec_bet_usd: number;
  reasoning: string;
  auto_eligible: boolean;
  flags: string[];
  // joined
  market_question?: string;
}

export default function SentimentPage() {
  const [optionsSignals,  setOptionsSignals]  = useState<OptionsSignal[]>([]);
  const [trumpPosts,      setTrumpPosts]      = useState<TrumpPost[]>([]);
  const [analyses,        setAnalyses]        = useState<SentimentAnalysis[]>([]);
  const [loading,         setLoading]         = useState(true);
  const [lastRefresh,     setLastRefresh]     = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);

    const cutoff48h = new Date(Date.now() - 48 * 3600000).toISOString();
    const cutoff24h = new Date(Date.now() - 24 * 3600000).toISOString();

    const [optRes, postRes, anlRes] = await Promise.all([
      // Recent options signals (last 48h, show anomalies first)
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
      questionMap = Object.fromEntries((markets ?? []).map(m => [m.id, m.question]));
    }

    setOptionsSignals(optRes.data ?? []);
    setTrumpPosts(postRes.data ?? []);
    setAnalyses(rawAnalyses.map(a => ({ ...a, market_question: questionMap[a.market_id] })));
    setLastRefresh(new Date());
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 60000); // refresh every 60s
    return () => clearInterval(interval);
  }, [load]);

  const anomalies    = optionsSignals.filter(s => s.is_anomaly);
  const highImpactPosts = trumpPosts.filter(p => p.market_impact_score >= 0.3);
  const actionableAnalyses = analyses.filter(a => a.direction !== 'PASS');

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-4 md:p-6">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <span>🧠</span> Sentiment Edge
          </h1>
          <p className="text-gray-400 text-sm mt-1">
            Trump tweet + options flow anomaly detection → Polymarket edge
          </p>
        </div>
        <div className="text-right text-xs text-gray-500">
          {lastRefresh && <div>Updated {relTime(lastRefresh.toISOString())}</div>}
          <button
            onClick={load}
            className="mt-1 px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs"
          >
            Refresh
          </button>
        </div>
      </div>

      {loading && (
        <div className="text-center text-gray-400 py-20">Loading sentiment signals...</div>
      )}

      {!loading && (
        <>
          {/* KPI Row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            {[
              { label: 'Anomalies (48h)',    value: anomalies.length,         color: anomalies.length > 0 ? 'text-amber-400' : 'text-gray-400' },
              { label: 'Trump Posts (24h)',  value: highImpactPosts.length,   color: highImpactPosts.length > 0 ? 'text-orange-400' : 'text-gray-400' },
              { label: 'Analyses (24h)',     value: analyses.length,          color: 'text-indigo-400' },
              { label: 'Actionable',         value: actionableAnalyses.length,color: actionableAnalyses.length > 0 ? 'text-emerald-400' : 'text-gray-400' },
            ].map(kpi => (
              <div key={kpi.label} className="bg-gray-900 rounded-lg p-4 border border-gray-800">
                <div className={`text-2xl font-bold ${kpi.color}`}>{kpi.value}</div>
                <div className="text-xs text-gray-400 mt-1">{kpi.label}</div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">

            {/* ── Left column: Options anomalies ── */}
            <div className="xl:col-span-1">
              <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-3">
                📊 Options Flow — Last 48h
              </h2>

              {optionsSignals.length === 0 ? (
                <div className="bg-gray-900 rounded-lg p-4 text-gray-500 text-sm">No data yet — function deploys soon</div>
              ) : (
                <div className="space-y-2 max-h-[600px] overflow-y-auto">
                  {optionsSignals.slice(0, 40).map(sig => (
                    <div
                      key={sig.id}
                      className={`rounded-lg p-3 border text-xs ${sig.is_anomaly
                        ? 'bg-amber-950 border-amber-700'
                        : 'bg-gray-900 border-gray-800'}`}
                    >
                      <div className="flex justify-between items-start mb-1">
                        <span className="font-bold text-white">{sig.ticker}</span>
                        <span className="text-gray-500">{relTime(sig.detected_at)}</span>
                      </div>
                      <div className="flex gap-3 flex-wrap">
                        <span className="text-gray-300">PCR: <span className={sig.put_call_ratio > (sig.mean_pcr ?? 1) * 1.3 ? 'text-red-400' : sig.put_call_ratio < (sig.mean_pcr ?? 1) * 0.7 ? 'text-emerald-400' : 'text-gray-300'}>{sig.put_call_ratio?.toFixed(3)}</span></span>
                        <span className="text-gray-500">avg: {sig.mean_pcr?.toFixed(3)}</span>
                        <span className={`font-bold ${Math.abs(sig.zscore ?? 0) > 2 ? 'text-amber-400' : 'text-gray-400'}`}>Z={sig.zscore?.toFixed(2)}</span>
                      </div>
                      {sig.is_anomaly && (
                        <div className={`mt-1 font-bold ${sig.anomaly_direction === 'BEARISH' ? 'text-red-400' : 'text-emerald-400'}`}>
                          ⚠️ {sig.anomaly_direction} ANOMALY
                        </div>
                      )}
                      <div className="text-gray-600 mt-1">
                        Calls: {(sig.call_volume ?? 0).toLocaleString()} | Puts: {(sig.put_volume ?? 0).toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Middle column: Trump posts ── */}
            <div className="xl:col-span-1">
              <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-3">
                📢 Truth Social Posts — Last 24h
              </h2>

              {trumpPosts.length === 0 ? (
                <div className="bg-gray-900 rounded-lg p-4 text-gray-500 text-sm">No posts detected — monitoring active</div>
              ) : (
                <div className="space-y-2 max-h-[600px] overflow-y-auto">
                  {trumpPosts.slice(0, 20).map(post => (
                    <div
                      key={post.id}
                      className={`rounded-lg p-3 border text-xs ${post.market_impact_score >= 0.5
                        ? 'bg-orange-950 border-orange-700'
                        : post.market_impact_score >= 0.3
                        ? 'bg-gray-900 border-orange-900'
                        : 'bg-gray-900 border-gray-800'}`}
                    >
                      <div className="flex justify-between items-start mb-2">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${post.market_impact_score >= 0.5 ? 'bg-orange-700 text-orange-100' : 'bg-gray-700 text-gray-300'}`}>
                            {(post.market_impact_score * 100).toFixed(0)}%
                          </span>
                          <span className="text-gray-500">{relTime(post.posted_at)}</span>
                        </div>
                        {post.url && (
                          <a href={post.url} target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:text-indigo-300 text-xs">↗</a>
                        )}
                      </div>
                      <p className="text-gray-200 leading-relaxed mb-2">{post.content.substring(0, 200)}{post.content.length > 200 ? '...' : ''}</p>
                      {(post.categories ?? []).length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {(post.categories ?? []).map(cat => (
                            <span key={cat} className="px-1.5 py-0.5 bg-gray-700 text-gray-300 rounded text-[10px]">{cat}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Right column: Sentiment analyses ── */}
            <div className="xl:col-span-1">
              <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-3">
                🎯 Sentiment Analyses — Last 24h
              </h2>

              {analyses.length === 0 ? (
                <div className="bg-gray-900 rounded-lg p-4 text-gray-500 text-sm">
                  No analyses yet — signals needed to trigger analysis
                </div>
              ) : (
                <div className="space-y-3 max-h-[600px] overflow-y-auto">
                  {analyses.map(a => (
                    <div
                      key={a.id}
                      className={`rounded-lg p-3 border text-xs ${a.direction !== 'PASS' && a.edge >= 0.06
                        ? 'bg-indigo-950 border-indigo-700'
                        : 'bg-gray-900 border-gray-800'}`}
                    >
                      <div className="flex justify-between items-start mb-2">
                        {signalTypeBadge(a.signal_type)}
                        <span className="text-gray-500">{relTime(a.analyzed_at)}</span>
                      </div>

                      <p className="text-gray-200 font-medium mb-2 leading-snug">
                        {a.market_question ?? `Market ${a.market_id?.substring(0, 8)}`}
                      </p>

                      <div className="flex items-center gap-2 flex-wrap mb-2">
                        {directionBadge(a.direction)}
                        <span className="text-gray-400">{confidenceDots(a.confidence)}</span>
                        <span className={`font-bold ${a.edge >= 0.1 ? 'text-emerald-400' : a.edge >= 0.06 ? 'text-yellow-400' : 'text-gray-400'}`}>
                          Edge: {(a.edge * 100).toFixed(1)}%
                        </span>
                      </div>

                      <div className="grid grid-cols-3 gap-1 text-gray-500 mb-2">
                        <div>Mkt: <span className="text-gray-300">${a.market_price?.toFixed(3)}</span></div>
                        <div>True: <span className="text-gray-300">{(a.true_prob * 100).toFixed(1)}%</span></div>
                        <div>Rec: <span className="text-emerald-400 font-bold">${a.rec_bet_usd?.toFixed(0)}</span></div>
                      </div>

                      {a.reasoning && (
                        <p className="text-gray-500 italic leading-relaxed">
                          {a.reasoning.substring(0, 180)}{a.reasoning.length > 180 ? '...' : ''}
                        </p>
                      )}

                      {(a.trump_keywords ?? []).length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {(a.trump_keywords ?? []).slice(0, 5).map(kw => (
                            <span key={kw} className="px-1.5 py-0.5 bg-orange-900 text-orange-300 rounded text-[10px]">{kw}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* How it works callout */}
          <div className="mt-6 bg-gray-900 border border-gray-700 rounded-lg p-4 text-xs text-gray-400">
            <h3 className="text-gray-300 font-semibold mb-2">⚙️ How This Works</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div><span className="text-amber-400 font-bold">Options Flow</span> — Scanned every 5 min. SPY/QQQ/TLT put/call ratio vs 48h rolling baseline. Z-score &gt;2.0 = anomaly flagged.</div>
              <div><span className="text-orange-400 font-bold">Truth Social</span> — Polled every 5 min. Posts scored for tariff, crypto, Fed, stock market keywords. Score 0–1 based on keyword weight.</div>
              <div><span className="text-purple-400 font-bold">Analysis</span> — When signals correlate within 90 min, Claude finds the most affected Polymarket market and calculates edge. Bet auto-placed if edge ≥6%.</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
