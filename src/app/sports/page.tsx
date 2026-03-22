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

// Must match the backend league classification in /api/sports/route.ts
function classifyLeague(question: string): string {
  const q = question.toLowerCase();
  if (/nba|basketball/.test(q)) return 'NBA';
  if (/nfl|football/.test(q) && !/ncaa/.test(q)) return 'NFL';
  if (/mlb|baseball/.test(q)) return 'MLB';
  if (/nhl|hockey/.test(q)) return 'NHL';
  if (/ncaa|college|march madness/.test(q)) return 'NCAA';
  if (/ufc|mma/.test(q)) return 'UFC/MMA';
  if (/soccer|premier|champions league|fifa|la liga|bundesliga|serie a|ligue 1|epl|mls/.test(q)) return 'Soccer';
  return 'Other';
}

export default function SportsPage() {
  const [data, setData] = useState<SportsResponse | null>(null);
  const [state, setState] = useState<DataState>('loading');
  const [league, setLeague] = useState<string>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [betting, setBetting] = useState(false);
  const [betResult, setBetResult] = useState<{ id: string; msg: string } | null>(null);

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
    return classifyLeague(m.question) === league;
  });

  // Find analysis for a specific market
  const getAnalysis = (marketId: string): SportsAnalysis | undefined => {
    return (data?.analyses || []).find((a) => a.market_id === marketId);
  };

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

  const placeBet = async (market: SportsMarket, direction: 'BUY_YES' | 'BUY_NO') => {
    setBetting(true);
    setBetResult(null);
    try {
      const priceIndex = direction === 'BUY_YES' ? 0 : 1;
      const entryPrice = market.outcome_prices[priceIndex] || 0.5;
      const analysis = getAnalysis(market.id);
      const amount = analysis?.rec_bet_usd || 10;

      const res = await fetch('/api/bets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          market_id: market.id,
          analysis_id: analysis?.id || null,
          category: 'sports',
          direction,
          outcome_label: direction === 'BUY_YES' ? (market.outcomes?.[0] || 'Yes') : (market.outcomes?.[1] || 'No'),
          entry_price: entryPrice,
          amount_usd: amount,
        }),
      });
      const json = await res.json();
      if (res.ok) {
        const directionLabel = direction === 'BUY_YES' ? 'YES' : 'NO';
        setBetResult({ id: market.id, msg: `Practice bet placed! ${directionLabel} at ${(entryPrice * 100).toFixed(0)}¢ for $${amount.toFixed(0)}` });
      } else {
        setBetResult({ id: market.id, msg: `Error: ${json.error}` });
      }
    } catch (err) {
      setBetResult({ id: market.id, msg: 'Failed to place bet' });
    }
    setBetting(false);
  };

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold mb-1">Sports - AI vs. Sportsbooks</h1>
          <p className="text-sm text-arbiter-text-2">
            Our AI compares odds from 5+ sportsbooks to find markets where Polymarket is wrong
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
        emptyMessage="The AI is warming up — it checks sports markets every 10 minutes. You'll see opportunities here once it finds markets where the odds don't match."
        skeletonCount={4}
      >
        {/* Stats */}
        <div className="grid grid-cols-4 gap-3 mb-4">
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">Markets Tracked</div>
            <div className="font-mono text-lg">{data?.summary?.total_markets || 0}</div>
          </div>
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">Total Volume</div>
            <div className="font-mono text-lg">
              {formatUsd(data?.summary?.total_volume || 0)}
            </div>
          </div>
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">Odds Compared</div>
            <div className="font-mono text-lg">{data?.summary?.total_odds_datapoints || 0}</div>
          </div>
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">Opportunities Found</div>
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
                  <button
                    key={l}
                    onClick={() => setLeague(league === l ? 'all' : l)}
                    className={`flex items-center justify-between rounded px-2 py-1.5 transition-all cursor-pointer ${
                      league === l
                        ? 'bg-arbiter-elevated border border-arbiter-amber/30'
                        : 'bg-arbiter-bg hover:bg-arbiter-elevated border border-transparent'
                    }`}
                  >
                    <span className="text-xs font-medium">{l}</span>
                    <span className="text-[10px] text-arbiter-text-3 font-mono">
                      {info?.markets || 0} mkts / {formatUsd(info?.volume || 0)}
                    </span>
                  </button>
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
              <h2 className="text-xs text-arbiter-text-3 uppercase tracking-widest">AI Picks — Best Bets Right Now</h2>
            </div>
            <div className="divide-y divide-arbiter-border/50">
              {(data?.analyses || []).filter((a: SportsAnalysis) => a.direction !== 'PASS').slice(0, 8).map((a: SportsAnalysis) => (
                <div key={a.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium leading-snug">{a.event_description}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[10px] text-arbiter-text-3">{confidenceDots(a.confidence)} {a.confidence}</span>
                        <span className="text-[10px] font-mono text-arbiter-text-3">
                          {a.direction === 'BUY_YES' ? 'Bet YES' : a.direction === 'BUY_NO' ? 'Bet NO' : 'PASS'}
                        </span>
                        {a.auto_eligible && (
                          <Badge variant="green">AUTO</Badge>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-mono text-sm font-semibold text-arbiter-amber">
                        +{(a.edge * 100).toFixed(1)}% advantage
                      </div>
                      <div className="text-[10px] text-arbiter-text-3 font-mono">
                        Sportsbooks say {(a.sportsbook_consensus * 100).toFixed(0)}¢ · Market price {(a.polymarket_price * 100).toFixed(0)}¢
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
        {league !== 'all' && (
          <div className="text-xs text-arbiter-text-3 mb-2">
            Showing {filtered.length} {league} market{filtered.length !== 1 ? 's' : ''}
          </div>
        )}

        {/* Market list */}
        <div className="space-y-2">
          {filtered.map((market) => {
            const isExpanded = expanded === market.id;
            const analysis = getAnalysis(market.id);
            const hasResult = betResult?.id === market.id;

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
                        <Badge variant="green">sports</Badge>
                        <Badge variant="gray">{classifyLeague(market.question)}</Badge>
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
                          Sportsbooks say {(analysis.sportsbook_consensus * 100).toFixed(0)}¢ · Market says {(analysis.polymarket_price * 100).toFixed(0)}¢ · Recommended: ${analysis.rec_bet_usd?.toFixed(0) || '0'}
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

                    {/* Bet placement buttons */}
                    <div>
                      <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1.5">Place a Bet (Practice Mode)</div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => placeBet(market, 'BUY_YES')}
                          disabled={betting}
                          className="flex-1 bg-arbiter-green/10 hover:bg-arbiter-green/20 border border-arbiter-green/30 text-arbiter-green rounded-lg px-3 py-2 text-xs font-medium transition-colors disabled:opacity-50"
                        >
                          {betting ? 'Placing...' : `Bet YES at ${market.outcome_prices[0] ? (market.outcome_prices[0] * 100).toFixed(0) + '¢' : '--'}`}
                        </button>
                        <button
                          onClick={() => placeBet(market, 'BUY_NO')}
                          disabled={betting}
                          className="flex-1 bg-arbiter-red/10 hover:bg-arbiter-red/20 border border-arbiter-red/30 text-arbiter-red rounded-lg px-3 py-2 text-xs font-medium transition-colors disabled:opacity-50"
                        >
                          {betting ? 'Placing...' : `Bet NO at ${market.outcome_prices[1] ? (market.outcome_prices[1] * 100).toFixed(0) + '¢' : '--'}`}
                        </button>
                      </div>
                      {hasResult && (
                        <div className={`text-xs mt-1.5 font-mono ${betResult.msg.startsWith('Error') ? 'text-arbiter-red' : 'text-arbiter-green'}`}>
                          {betResult.msg}
                        </div>
                      )}
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
