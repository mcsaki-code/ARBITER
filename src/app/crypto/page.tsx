'use client';

import { useState, useEffect, useCallback } from 'react';
import { Badge } from '@/components/Badge';
import { DataStateWrapper } from '@/components/DataState';
import { DataState } from '@/lib/types';

function confidenceDots(level: string): string {
  if (level === 'HIGH') return '●●●○';
  if (level === 'MEDIUM') return '●●○○';
  return '●○○○';
}

interface CryptoMarket {
  id: string;
  condition_id: string;
  question: string;
  category: string;
  outcomes: string[];
  outcome_prices: number[];
  volume_usd: number;
  liquidity_usd: number;
  resolution_date: string;
  is_active: boolean;
  updated_at: string;
}

interface CryptoSignal {
  id: string;
  fetched_at: string;
  asset: string;
  spot_price: number;
  rsi_14: number | null;
  bb_upper: number | null;
  bb_lower: number | null;
  funding_rate: number | null;
  volume_24h: number | null;
  signal_summary: string;
}

interface CryptoAnalysis {
  id: string;
  market_id: string;
  asset: string;
  spot_at_analysis: number;
  target_bracket: string;
  bracket_prob: number;
  market_price: number;
  edge: number;
  direction: string;
  confidence: string;
  kelly_fraction: number;
  rec_bet_usd: number;
  reasoning: string;
  auto_eligible: boolean;
  analyzed_at: string;
}

interface AssetInfo {
  markets: number;
  volume: number;
}

interface CryptoResponse {
  summary: {
    total_markets: number;
    total_volume: number;
    total_signals: number;
    total_analyses: number;
    asset_breakdown: Record<string, AssetInfo>;
  };
  latest_signals: Record<string, CryptoSignal>;
  markets: CryptoMarket[];
  analyses: CryptoAnalysis[];
}

function classifyAsset(question: string): string {
  const q = question.toLowerCase();
  if (/\bbtc\b|bitcoin/.test(q)) return 'BTC';
  if (/\beth\b|ethereum/.test(q)) return 'ETH';
  if (/\bsol\b|solana/.test(q)) return 'SOL';
  if (/\bxrp\b|ripple/.test(q)) return 'XRP';
  if (/\bdoge\b|dogecoin/.test(q)) return 'DOGE';
  return 'Other';
}

export default function CryptoPage() {
  const [data, setData] = useState<CryptoResponse | null>(null);
  const [state, setState] = useState<DataState>('loading');
  const [asset, setAsset] = useState<string>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  // Manual betting removed — all bets placed by AI auto-placement pipeline

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/crypto');
      if (!res.ok) throw new Error('Failed to fetch');
      const json: CryptoResponse = await res.json();
      setData(json);
      setState(!json.markets || json.markets.length === 0 ? 'empty' : 'fresh');
    } catch {
      setState(data ? 'stale' : 'error');
    }
  }, [data]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const assets = data?.summary?.asset_breakdown ? Object.keys(data.summary.asset_breakdown) : [];

  const filtered = (data?.markets || []).filter((m) => {
    if (asset === 'all') return true;
    return classifyAsset(m.question) === asset;
  });

  const getAnalysis = (marketId: string): CryptoAnalysis | undefined => {
    return (data?.analyses || []).find((a) => a.market_id === marketId);
  };

  const formatUsd = (n: number) => {
    if (n >= 1000000000) return `$${(n / 1000000000).toFixed(1)}B`;
    if (n >= 1000000) return `$${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `$${(n / 1000).toFixed(0)}K`;
    return `$${n.toFixed(0)}`;
  };

  const formatDate = (iso: string) => {
    if (!iso) return '--';
    const d = new Date(iso);
    const hours = Math.round((d.getTime() - Date.now()) / 3600000);
    if (hours < 0) return 'Past';
    if (hours < 24) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
  };

  const btcSignal = data?.latest_signals?.['BTC'] as CryptoSignal | undefined;
  const ethSignal = data?.latest_signals?.['ETH'] as CryptoSignal | undefined;

  const parseSignals = (sig: CryptoSignal | undefined): Record<string, string> => {
    if (!sig?.signal_summary) return {};
    try { return JSON.parse(sig.signal_summary); } catch { return {}; }
  };

  const btcIndicators = parseSignals(btcSignal);
  const ethIndicators = parseSignals(ethSignal);

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold mb-1">Crypto - AI Price Predictions</h1>
          <p className="text-sm text-arbiter-text-2">
            Using RSI, Bollinger Bands, and volume data to predict where BTC and ETH will land
          </p>
        </div>
        <div className="flex gap-1 bg-arbiter-card border border-arbiter-border rounded-lg p-1">
          <button
            onClick={() => setAsset('all')}
            className={`px-3 py-1.5 text-xs rounded-md transition-all ${
              asset === 'all'
                ? 'bg-arbiter-elevated text-arbiter-text'
                : 'text-arbiter-text-3 hover:text-arbiter-text-2'
            }`}
          >
            All
          </button>
          {assets.map((a) => (
            <button
              key={a}
              onClick={() => setAsset(a)}
              className={`px-3 py-1.5 text-xs rounded-md transition-all ${
                asset === a
                  ? 'bg-arbiter-elevated text-arbiter-text'
                  : 'text-arbiter-text-3 hover:text-arbiter-text-2'
              }`}
            >
              {a}
            </button>
          ))}
        </div>
      </div>

      <DataStateWrapper
        state={state}
        lastUpdated={data ? 'just now' : null}
        emptyMessage="The AI is warming up — it monitors BTC and ETH markets every 10 minutes. You'll see bracket predictions here soon."
        skeletonCount={4}
      >
        {/* Signal cards */}
        {(btcSignal || ethSignal) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
            {btcSignal && (
              <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Badge variant="purple">BTC</Badge>
                    <span className="font-mono text-lg font-semibold">
                      ${btcSignal.spot_price.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                  </div>
                  <span className="text-[10px] text-arbiter-text-3 font-mono">
                    {new Date(btcSignal.fetched_at).toLocaleTimeString()}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <div className="text-[10px] text-arbiter-text-3 uppercase">RSI(14)</div>
                    <div className={`font-mono ${
                      (btcSignal.rsi_14 || 50) > 70 ? 'text-arbiter-red' :
                      (btcSignal.rsi_14 || 50) < 30 ? 'text-arbiter-green' : 'text-arbiter-text'
                    }`}>
                      {btcSignal.rsi_14?.toFixed(1) || '--'}
                    </div>
                    <div className="text-[10px] text-arbiter-text-3 mt-0.5">
                      {(btcSignal.rsi_14 || 50) > 70 ? '(overbought — likely to drop)' :
                       (btcSignal.rsi_14 || 50) < 30 ? '(oversold — likely to bounce)' : '(neutral)'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-arbiter-text-3 uppercase">BB Range</div>
                    <div className="font-mono text-arbiter-text-2">
                      {btcSignal.bb_lower ? `${(btcSignal.bb_lower/1000).toFixed(0)}K` : '--'} -
                      {btcSignal.bb_upper ? ` ${(btcSignal.bb_upper/1000).toFixed(0)}K` : '--'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-arbiter-text-3 uppercase">24h Vol</div>
                    <div className="font-mono">{btcSignal.volume_24h ? formatUsd(btcSignal.volume_24h) : '--'}</div>
                  </div>
                </div>
                {Object.keys(btcIndicators).length > 0 && (
                  <div className="flex gap-2 mt-2 flex-wrap">
                    {Object.entries(btcIndicators).map(([key, val]) => (
                      <span key={key} className="text-[10px] font-mono bg-arbiter-bg rounded px-1.5 py-0.5 text-arbiter-text-2">
                        {key}: {val}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {ethSignal && (
              <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Badge variant="blue">ETH</Badge>
                    <span className="font-mono text-lg font-semibold">
                      ${ethSignal.spot_price.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                  </div>
                  <span className="text-[10px] text-arbiter-text-3 font-mono">
                    {new Date(ethSignal.fetched_at).toLocaleTimeString()}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <div className="text-[10px] text-arbiter-text-3 uppercase">RSI(14)</div>
                    <div className={`font-mono ${
                      (ethSignal.rsi_14 || 50) > 70 ? 'text-arbiter-red' :
                      (ethSignal.rsi_14 || 50) < 30 ? 'text-arbiter-green' : 'text-arbiter-text'
                    }`}>
                      {ethSignal.rsi_14?.toFixed(1) || '--'}
                    </div>
                    <div className="text-[10px] text-arbiter-text-3 mt-0.5">
                      {(ethSignal.rsi_14 || 50) > 70 ? '(overbought — likely to drop)' :
                       (ethSignal.rsi_14 || 50) < 30 ? '(oversold — likely to bounce)' : '(neutral)'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-arbiter-text-3 uppercase">BB Range</div>
                    <div className="font-mono text-arbiter-text-2">
                      {ethSignal.bb_lower ? `$${ethSignal.bb_lower.toFixed(0)}` : '--'} -
                      {ethSignal.bb_upper ? ` $${ethSignal.bb_upper.toFixed(0)}` : '--'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-arbiter-text-3 uppercase">24h Vol</div>
                    <div className="font-mono">{ethSignal.volume_24h ? formatUsd(ethSignal.volume_24h) : '--'}</div>
                  </div>
                </div>
                {Object.keys(ethIndicators).length > 0 && (
                  <div className="flex gap-2 mt-2 flex-wrap">
                    {Object.entries(ethIndicators).map(([key, val]) => (
                      <span key={key} className="text-[10px] font-mono bg-arbiter-bg rounded px-1.5 py-0.5 text-arbiter-text-2">
                        {key}: {val}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Stats bar */}
        <div className="grid grid-cols-4 gap-3 mb-4">
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">Markets Tracked</div>
            <div className="font-mono text-lg">{data?.summary?.total_markets || 0}</div>
          </div>
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">Total Volume</div>
            <div className="font-mono text-lg">{formatUsd(data?.summary?.total_volume || 0)}</div>
          </div>
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">Data Points</div>
            <div className="font-mono text-lg">{data?.summary?.total_signals || 0}</div>
          </div>
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">Opportunities Found</div>
            <div className="font-mono text-lg">{data?.summary?.total_analyses || 0}</div>
          </div>
        </div>

        {/* Edge Analyses */}
        {(data?.analyses || []).length > 0 && (
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg overflow-hidden mb-4">
            <div className="border-b border-arbiter-border px-4 py-3">
              <h2 className="text-xs text-arbiter-text-3 uppercase tracking-widest">AI Picks — Best Bets Right Now</h2>
            </div>
            <div className="divide-y divide-arbiter-border/50">
              {(data?.analyses || []).filter((a: CryptoAnalysis) => a.direction !== 'PASS').slice(0, 8).map((a: CryptoAnalysis) => (
                <div key={a.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="purple">{a.asset}</Badge>
                        <span className="text-sm font-medium">{a.target_bracket}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-arbiter-text-3">{confidenceDots(a.confidence)} {a.confidence}</span>
                        <span className="text-[10px] font-mono text-arbiter-text-3">
                          {a.direction === 'BUY_YES' ? 'Bet YES' : a.direction === 'BUY_NO' ? 'Bet NO' : 'PASS'}
                        </span>
                        <span className="text-[10px] font-mono text-arbiter-text-3">
                          Spot ${a.spot_at_analysis?.toLocaleString(undefined, { maximumFractionDigits: 0 }) || '?'}
                        </span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-mono text-sm font-semibold text-arbiter-amber">
                        +{(a.edge * 100).toFixed(1)}% advantage
                      </div>
                      <div className="text-[10px] text-arbiter-text-3 font-mono">
                        AI thinks {(a.bracket_prob * 100).toFixed(0)}¢ · Market says {(a.market_price * 100).toFixed(0)}¢
                      </div>
                      {a.rec_bet_usd > 0 && (
                        <div className="text-[10px] font-mono text-arbiter-green mt-0.5">
                          Recommended: ${a.rec_bet_usd.toFixed(0)}
                        </div>
                      )}
                    </div>
                  </div>
                  {a.reasoning && (
                    <p className="text-[10px] text-arbiter-text-3 mt-2 leading-relaxed line-clamp-2">{a.reasoning}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Filtered count */}
        {asset !== 'all' && (
          <div className="text-xs text-arbiter-text-3 mb-2">
            Showing {filtered.length} {asset} market{filtered.length !== 1 ? 's' : ''}
          </div>
        )}

        {/* Market list */}
        <div className="space-y-2">
          {filtered.map((market) => {
            const isExpanded = expanded === market.id;
            const analysis = getAnalysis(market.id);
            return (
              <div key={market.id} className="bg-arbiter-card border border-arbiter-border rounded-lg overflow-hidden">
                {/* Clickable header */}
                <button
                  onClick={() => setExpanded(isExpanded ? null : market.id)}
                  className="w-full px-4 py-3 text-left hover:bg-arbiter-elevated/50 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium leading-snug pr-2">
                        {market.question}
                      </p>
                      <div className="flex items-center gap-2 mt-1.5">
                        <Badge variant="purple">crypto</Badge>
                        <Badge variant="gray">{classifyAsset(market.question)}</Badge>
                        <span className="text-[10px] text-arbiter-text-3 font-mono">
                          Vol {formatUsd(market.volume_usd)}
                        </span>
                        <span className="text-[10px] text-arbiter-text-3 font-mono">
                          Liq {formatUsd(market.liquidity_usd)}
                        </span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-mono text-xs text-arbiter-text-3">{formatDate(market.resolution_date)}</div>
                      {market.outcome_prices.length >= 2 && (
                        <div className="font-mono text-sm mt-0.5">
                          <span className="text-arbiter-green">{(market.outcome_prices[0] * 100).toFixed(0)}%</span>
                          <span className="text-arbiter-text-3 mx-1">/</span>
                          <span className="text-arbiter-red">{(market.outcome_prices[1] * 100).toFixed(0)}%</span>
                        </div>
                      )}
                      <div className="text-[10px] text-arbiter-text-3 mt-0.5">
                        {isExpanded ? 'collapse' : 'expand'}
                      </div>
                    </div>
                  </div>
                </button>

                {/* Expanded detail panel */}
                {isExpanded && (
                  <div className="border-t border-arbiter-border bg-arbiter-bg/50 px-4 py-3 space-y-3">
                    {/* Outcomes */}
                    <div>
                      <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1.5">Outcomes</div>
                      <div className="grid grid-cols-2 gap-2">
                        {market.outcomes?.map((outcome, i) => (
                          <div key={i} className="bg-arbiter-card border border-arbiter-border rounded px-3 py-2 flex items-center justify-between">
                            <span className="text-xs font-medium">{outcome}</span>
                            <span className={`font-mono text-sm font-semibold ${i === 0 ? 'text-arbiter-green' : 'text-arbiter-red'}`}>
                              {market.outcome_prices[i] ? `${(market.outcome_prices[i] * 100).toFixed(1)}%` : '--'}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Analysis if available */}
                    {analysis && (
                      <div className="bg-arbiter-card border border-arbiter-amber/20 rounded-lg p-3">
                        <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1.5">What the AI Found</div>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-[10px] text-arbiter-text-3">{confidenceDots(analysis.confidence)} {analysis.confidence}</span>
                          <span className="text-xs font-mono">
                            {analysis.direction === 'BUY_YES' ? 'Bet YES' : analysis.direction === 'BUY_NO' ? 'Bet NO' : 'PASS'}
                          </span>
                          <span className="font-mono text-sm font-semibold text-arbiter-amber">
                            +{(analysis.edge * 100).toFixed(1)}% advantage
                          </span>
                        </div>
                        <div className="text-[10px] text-arbiter-text-3 font-mono mb-1">
                          Bracket: {analysis.target_bracket} | AI thinks {(analysis.bracket_prob * 100).toFixed(0)}¢ · Market says {(analysis.market_price * 100).toFixed(0)}¢ · Recommended: ${analysis.rec_bet_usd?.toFixed(0) || '0'}
                        </div>
                        {analysis.reasoning && (
                          <p className="text-xs text-arbiter-text-2 mt-1.5 leading-relaxed">{analysis.reasoning}</p>
                        )}
                      </div>
                    )}

                    {/* Market details */}
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div className="bg-arbiter-card border border-arbiter-border rounded px-2 py-1.5">
                        <div className="text-[10px] text-arbiter-text-3">Volume</div>
                        <div className="font-mono">{formatUsd(market.volume_usd)}</div>
                      </div>
                      <div className="bg-arbiter-card border border-arbiter-border rounded px-2 py-1.5">
                        <div className="text-[10px] text-arbiter-text-3">Liquidity</div>
                        <div className="font-mono">{formatUsd(market.liquidity_usd)}</div>
                      </div>
                      <div className="bg-arbiter-card border border-arbiter-border rounded px-2 py-1.5">
                        <div className="text-[10px] text-arbiter-text-3">Resolves</div>
                        <div className="font-mono">{formatDate(market.resolution_date)}</div>
                      </div>
                    </div>

                    {/* Auto-bet status */}
                    <div className="bg-arbiter-bg rounded-lg p-3 text-center">
                      <div className="text-xs text-arbiter-text-3">
                        Bets placed automatically by AI when edge meets thresholds
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </DataStateWrapper>
    </div>
  );
}
