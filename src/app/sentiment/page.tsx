'use client';

import { useState, useEffect, useCallback } from 'react';

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
  if (dir === 'BUY_YES') return <span className="px-2 py-0.5 rounded text-xs font-bold bg-emerald-900/40 text-emerald-400 border border-emerald-800/50">BUY YES</span>;
  if (dir === 'BUY_NO')  return <span className="px-2 py-0.5 rounded text-xs font-bold bg-red-900/40 text-red-400 border border-red-800/50">BUY NO</span>;
  return <span className="px-2 py-0.5 rounded text-xs font-bold bg-arbiter-card text-arbiter-text-3 border border-arbiter-border">PASS</span>;
}

function signalTypeBadge(type: string) {
  if (type === 'options_trump') return <span className="px-2 py-0.5 rounded text-xs font-bold bg-purple-900/40 text-purple-300 border border-purple-800/50">OPTIONS + TWEET</span>;
  if (type === 'trump_only')   return <span className="px-2 py-0.5 rounded text-xs font-bold bg-orange-900/40 text-orange-300 border border-orange-800/50">TWEET</span>;
  return <span className="px-2 py-0.5 rounded text-xs font-bold bg-blue-900/40 text-blue-300 border border-blue-800/50">OPTIONS FLOW</span>;
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
    try {
      const res = await fetch('/api/sentiment');
      const data = await res.json();
      setOptionsSignals(data.optionsSignals ?? []);
      setTrumpPosts(data.trumpPosts ?? []);
      setAnalyses(data.analyses ?? []);
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Failed to fetch sentiment data:', err);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, [load]);

  const anomalies    = optionsSignals.filter(s => s.is_anomaly);
  const highImpactPosts = trumpPosts.filter(p => p.market_impact_score >= 0.3);
  const actionableAnalyses = analyses.filter(a => a.direction !== 'PASS');

  return (
    <div className="p-4 md:p-6 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-arbiter-text tracking-wide">
            Sentiment Signals
          </h1>
          <p className="text-arbiter-text-3 text-sm mt-1">
            Options flow anomalies + social media signal detection
          </p>
        </div>
        <div className="text-right text-xs text-arbiter-text-3">
          {lastRefresh && <div>Updated {relTime(lastRefresh.toISOString())}</div>}
          <button
            onClick={load}
            className="mt-1 px-3 py-1 bg-arbiter-elevated hover:bg-arbiter-card text-arbiter-text border border-arbiter-border rounded text-xs transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {loading && (
        <div className="text-center text-arbiter-text-3 py-20">Loading sentiment signals...</div>
      )}

      {!loading && (
        <>
          {/* KPI Row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            {[
              { label: 'Anomalies (48h)',    value: anomalies.length,         color: anomalies.length > 0 ? 'text-arbiter-amber' : 'text-arbiter-text-3' },
              { label: 'Posts (24h)',        value: highImpactPosts.length,   color: highImpactPosts.length > 0 ? 'text-orange-400' : 'text-arbiter-text-3' },
              { label: 'Analyses (24h)',     value: analyses.length,          color: 'text-blue-400' },
              { label: 'Actionable',         value: actionableAnalyses.length,color: actionableAnalyses.length > 0 ? 'text-emerald-400' : 'text-arbiter-text-3' },
            ].map(kpi => (
              <div key={kpi.label} className="bg-arbiter-card rounded-lg p-4 border border-arbiter-border">
                <div className={`text-2xl font-bold ${kpi.color}`}>{kpi.value}</div>
                <div className="text-xs text-arbiter-text-3 mt-1">{kpi.label}</div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">

            {/* Left column: Options anomalies */}
            <div className="xl:col-span-1">
              <h2 className="text-sm font-semibold text-arbiter-text-2 uppercase tracking-wider mb-3">
                Options Flow — Last 48h
              </h2>

              {optionsSignals.length === 0 ? (
                <div className="bg-arbiter-card rounded-lg p-4 text-arbiter-text-3 text-sm border border-arbiter-border">No signals detected</div>
              ) : (
                <div className="space-y-2 max-h-[600px] overflow-y-auto">
                  {optionsSignals.slice(0, 40).map(sig => (
                    <div
                      key={sig.id}
                      className={`rounded-lg p-3 border text-xs ${sig.is_anomaly
                        ? 'bg-arbiter-amber/5 border-arbiter-amber/30'
                        : 'bg-arbiter-card border-arbiter-border'}`}
                    >
                      <div className="flex justify-between items-start mb-1">
                        <span className="font-bold text-arbiter-text">{sig.ticker}</span>
                        <span className="text-arbiter-text-3">{relTime(sig.detected_at)}</span>
                      </div>
                      <div className="flex gap-3 flex-wrap">
                        <span className="text-arbiter-text-2">PCR: <span className={sig.put_call_ratio > (sig.mean_pcr ?? 1) * 1.3 ? 'text-red-400' : sig.put_call_ratio < (sig.mean_pcr ?? 1) * 0.7 ? 'text-emerald-400' : 'text-arbiter-text-2'}>{sig.put_call_ratio?.toFixed(3)}</span></span>
                        <span className="text-arbiter-text-3">avg: {sig.mean_pcr?.toFixed(3)}</span>
                        <span className={`font-bold ${Math.abs(sig.zscore ?? 0) > 2 ? 'text-arbiter-amber' : 'text-arbiter-text-3'}`}>Z={sig.zscore?.toFixed(2)}</span>
                      </div>
                      {sig.is_anomaly && (
                        <div className={`mt-1 font-bold ${sig.anomaly_direction === 'BEARISH' ? 'text-red-400' : 'text-emerald-400'}`}>
                          {sig.anomaly_direction} ANOMALY
                        </div>
                      )}
                      <div className="text-arbiter-text-3 mt-1">
                        Calls: {(sig.call_volume ?? 0).toLocaleString()} | Puts: {(sig.put_volume ?? 0).toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Middle column: Trump posts */}
            <div className="xl:col-span-1">
              <h2 className="text-sm font-semibold text-arbiter-text-2 uppercase tracking-wider mb-3">
                Social Posts — Last 24h
              </h2>

              {trumpPosts.length === 0 ? (
                <div className="bg-arbiter-card rounded-lg p-4 text-arbiter-text-3 text-sm border border-arbiter-border">No posts detected</div>
              ) : (
                <div className="space-y-2 max-h-[600px] overflow-y-auto">
                  {trumpPosts.slice(0, 20).map(post => (
                    <div
                      key={post.id}
                      className={`rounded-lg p-3 border text-xs ${post.market_impact_score >= 0.5
                        ? 'bg-orange-900/10 border-orange-700/40'
                        : post.market_impact_score >= 0.3
                        ? 'bg-arbiter-card border-orange-900/30'
                        : 'bg-arbiter-card border-arbiter-border'}`}
                    >
                      <div className="flex justify-between items-start mb-2">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${post.market_impact_score >= 0.5 ? 'bg-orange-900/50 text-orange-300' : 'bg-arbiter-elevated text-arbiter-text-2'}`}>
                            {(post.market_impact_score * 100).toFixed(0)}%
                          </span>
                          <span className="text-arbiter-text-3">{relTime(post.posted_at)}</span>
                        </div>
                        {post.url && (
                          <a href={post.url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 text-xs">Link</a>
                        )}
                      </div>
                      <p className="text-arbiter-text-2 leading-relaxed mb-2">{post.content.substring(0, 200)}{post.content.length > 200 ? '...' : ''}</p>
                      {(post.categories ?? []).length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {(post.categories ?? []).map(cat => (
                            <span key={cat} className="px-1.5 py-0.5 bg-arbiter-elevated text-arbiter-text-2 rounded text-[10px]">{cat}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Right column: Sentiment analyses */}
            <div className="xl:col-span-1">
              <h2 className="text-sm font-semibold text-arbiter-text-2 uppercase tracking-wider mb-3">
                Analyses — Last 24h
              </h2>

              {analyses.length === 0 ? (
                <div className="bg-arbiter-card rounded-lg p-4 text-arbiter-text-3 text-sm border border-arbiter-border">
                  No analyses yet — signals needed to trigger analysis
                </div>
              ) : (
                <div className="space-y-3 max-h-[600px] overflow-y-auto">
                  {analyses.map(a => (
                    <div
                      key={a.id}
                      className={`rounded-lg p-3 border text-xs ${a.direction !== 'PASS' && a.edge >= 0.06
                        ? 'bg-blue-900/10 border-blue-700/40'
                        : 'bg-arbiter-card border-arbiter-border'}`}
                    >
                      <div className="flex justify-between items-start mb-2">
                        {signalTypeBadge(a.signal_type)}
                        <span className="text-arbiter-text-3">{relTime(a.analyzed_at)}</span>
                      </div>

                      <p className="text-arbiter-text font-medium mb-2 leading-snug">
                        {a.market_question ?? `Market ${a.market_id?.substring(0, 8)}`}
                      </p>

                      <div className="flex items-center gap-2 flex-wrap mb-2">
                        {directionBadge(a.direction)}
                        <span className="text-arbiter-text-3">{confidenceDots(a.confidence)}</span>
                        <span className={`font-bold ${a.edge >= 0.1 ? 'text-emerald-400' : a.edge >= 0.06 ? 'text-arbiter-amber' : 'text-arbiter-text-3'}`}>
                          Edge: {(a.edge * 100).toFixed(1)}%
                        </span>
                      </div>

                      <div className="grid grid-cols-3 gap-1 text-arbiter-text-3 mb-2">
                        <div>Mkt: <span className="text-arbiter-text-2">${a.market_price?.toFixed(3)}</span></div>
                        <div>True: <span className="text-arbiter-text-2">{(a.true_prob * 100).toFixed(1)}%</span></div>
                        <div>Rec: <span className="text-emerald-400 font-bold">${a.rec_bet_usd?.toFixed(0)}</span></div>
                      </div>

                      {a.reasoning && (
                        <p className="text-arbiter-text-3 italic leading-relaxed">
                          {a.reasoning.substring(0, 180)}{a.reasoning.length > 180 ? '...' : ''}
                        </p>
                      )}

                      {(a.trump_keywords ?? []).length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {(a.trump_keywords ?? []).slice(0, 5).map(kw => (
                            <span key={kw} className="px-1.5 py-0.5 bg-orange-900/30 text-orange-300 rounded text-[10px]">{kw}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* How it works */}
          <div className="mt-6 bg-arbiter-card border border-arbiter-border rounded-lg p-4 text-xs text-arbiter-text-3">
            <h3 className="text-arbiter-text-2 font-semibold mb-2">How This Works</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div><span className="text-arbiter-amber font-bold">Options Flow</span> — SPY/QQQ/TLT put/call ratio vs 48h rolling baseline. Z-score &gt;2.0 flags anomaly.</div>
              <div><span className="text-orange-400 font-bold">Social Posts</span> — Polled for tariff, crypto, Fed, market keywords. Impact scored 0–1.</div>
              <div><span className="text-blue-400 font-bold">Analysis</span> — When signals correlate, Claude finds the most affected market and calculates edge.</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
