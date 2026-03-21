'use client';

import { useState, useEffect, useCallback } from 'react';
import { Badge } from '@/components/Badge';
import { DataStateWrapper } from '@/components/DataState';
import { DataState } from '@/lib/types';

interface SportsMarket {
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

interface LeagueInfo {
  markets: number;
  volume: number;
}

interface SportsAnalysis {
  id: string;
  market_id: string;
  event_description: string;
  sport: string;
  sportsbook_consensus: number;
  polymarket_price: number;
  edge: number;
  direction: string;
  confidence: string;
  kelly_fraction: number;
  rec_bet_usd: number;
  reasoning: string;
  auto_eligible: boolean;
  analyzed_at: string;
}

interface SportsResponse {
  summary: {
    total_markets: number;
    total_volume: number;
    total_odds_datapoints: number;
    total_analyses: number;
    league_breakdown: Record<string, LeagueInfo>;
  };
  markets: SportsMarket[];
  analyses: SportsAnalysis[];
}

export default function SportsPage() {
  const [data, setData] = useState<SportsResponse | null>(null);
  const [state, setState] = useState<DataState>('loading');
  const [league, setLeague] = useState<string>('all');

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/sports');
      if (!res.ok) throw new Error('Failed to fetch');
      const json: SportsResponse = await res.json();
      setData(json);
      setState(!json.markets || json.markets.length === 0 ? 'empty' : 'fresh');
    } catch {
      setState(data ? 'stale' : 'error');
    }
  }, [data]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const leagues = data?.summary?.league_breakdown ? Object.keys(data.summary.league_breakdown) : [];

  const filtered = (data?.markets || []).filter((m) => {
    if (league === 'all') return true;
    const q = m.question.toLowerCase();
    const lc = league.toLowerCase();
    return q.includes(lc);
  });

  const formatUsd = (n: number) => {
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

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold mb-1">Sports Edge</h1>
          <p className="text-sm text-arbiter-text-2">
            Cross-referencing sportsbook odds with Polymarket prices
          </p>
        </div>
        <div className="flex gap-1 bg-arbiter-card border border-arbiter-border rounded-lg p-1 flex-wrap">
          <button
            onClick={() => setLeague('all')}
            className={`px-3 py-1.5 text-xs rounded-md transition-all ${
              league === 'all'
                ? 'bg-arbiter-elevated text-arbiter-text'
                : 'text-arbiter-text-3 hover:text-arbiter-text-2'
            }`}
          >
            All
          </button>
          {leagues.map((l) => (
            <button
              key={l}
              onClick={() => setLeague(l)}
              className={`px-3 py-1.5 text-xs rounded-md transition-all ${
                league === l
                  ? 'bg-arbiter-elevated text-arbiter-text'
                  : 'text-arbiter-text-3 hover:text-arbiter-text-2'
              }`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      <DataStateWrapper
        state={state}
        lastUpdated={data ? 'just now' : null}
        emptyMessage="No sports markets found yet. The sports odds engine runs every 10 minutes. Set ODDS_API_KEY in Netlify env vars to enable sportsbook cross-referencing."
        skeletonCount={4}
      >
        {/* Stats */}
        <div className="grid grid-cols-4 gap-3 mb-4">
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">Sports Markets</div>
            <div className="font-mono text-lg">{data?.summary?.total_markets || 0}</div>
          </div>
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">Total Volume</div>
            <div className="font-mono text-lg">
              {formatUsd(data?.summary?.total_volume || 0)}
            </div>
          </div>
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">Odds Data Points</div>
            <div className="font-mono text-lg">{data?.summary?.total_odds_datapoints || 0}</div>
          </div>
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">Edge Analyses</div>
            <div className="font-mono text-lg">{data?.summary?.total_analyses || 0}</div>
          </div>
        </div>

        {/* League breakdown */}
        {leagues.length > 0 && (
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4 mb-4">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-2">League Breakdown</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {leagues.map((l) => {
                const info = data?.summary?.league_breakdown[l];
                return (
                  <div key={l} className="flex items-center justify-between bg-arbiter-bg rounded px-2 py-1.5">
                    <span className="text-xs font-medium">{l}</span>
                    <span className="text-[10px] text-arbiter-text-3 font-mono">
                      {info?.markets || 0} mkts / {formatUsd(info?.volume || 0)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Setup guide — only show if truly no sports data at all */}
        {!data?.summary?.total_markets && !data?.summary?.total_odds_datapoints && (
          <div className="bg-arbiter-card border border-arbiter-amber/30 rounded-lg p-4 mb-4">
            <div className="text-sm font-medium text-arbiter-amber mb-1">Sports Engine Initializing</div>
            <p className="text-xs text-arbiter-text-2">
              The sports ingestion function runs every 10 minutes. It pulls Polymarket sports markets automatically and cross-references with sportsbook odds when <span className="font-mono">ODDS_API_KEY</span> is configured.
              {' '}Odds data is refreshed in 2-hour windows, so this panel may appear empty between cycles.
            </p>
          </div>
        )}

        {/* Edge Analyses */}
        {(data?.analyses || []).length > 0 && (
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg overflow-hidden mb-4">
            <div className="border-b border-arbiter-border px-4 py-3">
              <h2 className="text-xs text-arbiter-text-3 uppercase tracking-widest">Edge Analyses</h2>
            </div>
            <div className="divide-y divide-arbiter-border/50">
              {(data?.analyses || []).filter((a: SportsAnalysis) => a.direction !== 'PASS').slice(0, 8).map((a: SportsAnalysis) => (
                <div key={a.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium leading-snug">{a.event_description}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant={a.confidence === 'HIGH' ? 'green' : a.confidence === 'MEDIUM' ? 'amber' : 'red'}>
                          {a.confidence}
                        </Badge>
                        <span className="text-[10px] font-mono text-arbiter-text-3">
                          {a.direction === 'BUY_YES' ? 'BUY YES' : a.direction === 'BUY_NO' ? 'BUY NO' : 'PASS'}
                        </span>
                        {a.auto_eligible && (
                          <Badge variant="green">AUTO</Badge>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-mono text-sm font-semibold text-arbiter-amber">
                        +{(a.edge * 100).toFixed(1)}%
                      </div>
                      <div className="text-[10px] text-arbiter-text-3 font-mono">
                        SB {(a.sportsbook_consensus * 100).toFixed(0)}% vs PM {(a.polymarket_price * 100).toFixed(0)}%
                      </div>
                      {a.rec_bet_usd > 0 && (
                        <div className="text-[10px] font-mono text-arbiter-green mt-0.5">
                          Kelly: ${a.rec_bet_usd.toFixed(0)}
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

        {/* Market list */}
        <div className="space-y-2">
          {filtered.map((market) => (
            <div key={market.id} className="bg-arbiter-card border border-arbiter-border rounded-lg px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium leading-snug pr-2">
                    {market.question}
                  </p>
                  <div className="flex items-center gap-2 mt-1.5">
                    <Badge variant="green">sports</Badge>
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
                </div>
              </div>
            </div>
          ))}
        </div>
      </DataStateWrapper>
    </div>
  );
}
