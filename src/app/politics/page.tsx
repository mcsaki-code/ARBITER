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

function daysUntil(dateStr: string | null | undefined): string {
  if (!dateStr) return '?';
  const ms = new Date(dateStr).getTime() - Date.now();
  if (ms < 0) return 'expired';
  const days = ms / 86400000;
  if (days < 1) return `${Math.round(days * 24)}h`;
  return `${days.toFixed(0)}d`;
}

function urgencyColor(dateStr: string | null | undefined): string {
  if (!dateStr) return 'text-arbiter-muted';
  const ms = new Date(dateStr).getTime() - Date.now();
  if (ms < 0) return 'text-arbiter-muted';
  const days = ms / 86400000;
  if (days <= 3)  return 'text-red-400';
  if (days <= 14) return 'text-arbiter-amber';
  return 'text-arbiter-green';
}

function categoryLabel(cat: string): string {
  const map: Record<string, string> = {
    executive_action: 'EXEC',
    economic_data:    'ECON',
    election:         'ELEC',
    geopolitical:     'GEO',
    legal:            'LEGAL',
    policy:           'POLICY',
    other:            'OTHER',
  };
  return map[cat] ?? cat.toUpperCase().slice(0, 6);
}

function categoryBg(cat: string): string {
  const map: Record<string, string> = {
    executive_action: 'bg-red-500/10 text-red-400 border-red-500/20',
    economic_data:    'bg-blue-500/10 text-blue-400 border-blue-500/20',
    election:         'bg-purple-500/10 text-purple-400 border-purple-500/20',
    geopolitical:     'bg-orange-500/10 text-orange-400 border-orange-500/20',
    legal:            'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
    policy:           'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
    other:            'bg-arbiter-muted/10 text-arbiter-muted border-arbiter-border',
  };
  return map[cat] ?? 'bg-arbiter-muted/10 text-arbiter-muted border-arbiter-border';
}

function edgeTypeBadge(type: string | undefined): string | null {
  if (!type || type === 'NONE') return null;
  const map: Record<string, string> = {
    NEWS:         '📰 NEWS',
    CROSS_MARKET: '⇄ CROSS-MKT',
    CALIBRATION:  '⚖ CALIBRATION',
    DATA:         '📊 DATA',
  };
  return map[type] ?? type;
}

interface PoliticsAnalysis {
  id: string;
  market_id: string;
  question_summary: string;
  category: string;
  direction: string;
  edge: number | string;
  true_prob: number | string;
  market_price: number | string;
  confidence: string;
  rec_bet_usd: number;
  reasoning: string;
  auto_eligible: boolean;
  predictit_aligns: boolean;
  analyzed_at: string;
  flags: string[];
  edge_type?: string;
  market?: {
    question: string;
    liquidity_usd: number;
    resolution_date: string;
    is_active: boolean;
  } | null;
}

interface OpenBet {
  id: string;
  market_id: string;
  direction: string;
  entry_price: number;
  amount_usd: number;
  status: string;
  placed_at: string;
  pnl?: number | null;
  condition_id: string | null;
}

interface CategoryInfo {
  count: number;
  avg_edge: number;
}

interface PoliticsResponse {
  summary: {
    total_analyses: number;
    recent_analyses_2h: number;
    open_bets: number;
    total_deployed: number;
    resolved_bets: number;
    total_pnl: number;
    win_rate: number | null;
    category_breakdown: Record<string, CategoryInfo>;
  };
  top_opportunities: PoliticsAnalysis[];
  open_bets: OpenBet[];
  all_bets: OpenBet[];
}

export default function PoliticsPage() {
  const [data, setData]     = useState<PoliticsResponse | null>(null);
  const [state, setState]   = useState<DataState>('loading');
  const [tab, setTab]       = useState<'opportunities' | 'positions'>('opportunities');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setState('loading');
    try {
      const res = await fetch('/api/politics');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setState('success');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleExpanded = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const fmt = (n: number | string | undefined | null, pct = false): string => {
    const num = parseFloat(String(n ?? 0));
    if (isNaN(num)) return '—';
    if (pct) return `${(num * 100).toFixed(1)}%`;
    return num.toFixed(3);
  };

  const fmtUsd = (n: number | null | undefined): string => {
    const num = parseFloat(String(n ?? 0));
    if (isNaN(num)) return '$0';
    return `$${Math.abs(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const s = data?.summary;
  const opportunities = data?.top_opportunities ?? [];
  const openBets      = data?.open_bets ?? [];

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-arbiter-text">Politics & News</h1>
          <p className="text-sm text-arbiter-muted mt-0.5">
            Executive actions · Economic data · Elections · Geopolitical events
          </p>
        </div>
        <button
          onClick={load}
          className="text-xs px-3 py-1.5 rounded border border-arbiter-border text-arbiter-muted hover:text-arbiter-text hover:border-arbiter-amber transition-colors"
        >
          Refresh
        </button>
      </div>

      <DataStateWrapper state={state} onRetry={load}>
        {/* Summary stats */}
        {s && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
            <div className="bg-arbiter-surface border border-arbiter-border rounded-lg p-4">
              <div className="text-xs text-arbiter-muted mb-1">Analyses</div>
              <div className="text-2xl font-mono font-semibold text-arbiter-text">{s.total_analyses}</div>
              <div className="text-xs text-arbiter-muted">{s.recent_analyses_2h} in last 2h</div>
            </div>
            <div className="bg-arbiter-surface border border-arbiter-border rounded-lg p-4">
              <div className="text-xs text-arbiter-muted mb-1">Open Positions</div>
              <div className="text-2xl font-mono font-semibold text-arbiter-text">{s.open_bets}</div>
              <div className="text-xs text-arbiter-muted">{fmtUsd(s.total_deployed)} deployed</div>
            </div>
            <div className="bg-arbiter-surface border border-arbiter-border rounded-lg p-4">
              <div className="text-xs text-arbiter-muted mb-1">Resolved</div>
              <div className="text-2xl font-mono font-semibold text-arbiter-text">{s.resolved_bets}</div>
              <div className="text-xs text-arbiter-muted">
                {s.win_rate !== null ? `${(s.win_rate * 100).toFixed(0)}% win rate` : 'no results yet'}
              </div>
            </div>
            <div className="bg-arbiter-surface border border-arbiter-border rounded-lg p-4">
              <div className="text-xs text-arbiter-muted mb-1">P&L</div>
              <div className={`text-2xl font-mono font-semibold ${(s.total_pnl ?? 0) >= 0 ? 'text-arbiter-green' : 'text-red-400'}`}>
                {(s.total_pnl ?? 0) >= 0 ? '+' : ''}{fmtUsd(s.total_pnl)}
              </div>
              <div className="text-xs text-arbiter-muted">paper trading</div>
            </div>
            <div className="bg-arbiter-surface border border-arbiter-border rounded-lg p-4">
              <div className="text-xs text-arbiter-muted mb-2">Categories</div>
              <div className="flex flex-wrap gap-1">
                {Object.entries(s.category_breakdown)
                  .sort((a, b) => b[1].count - a[1].count)
                  .slice(0, 4)
                  .map(([cat, info]) => (
                    <span key={cat} className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${categoryBg(cat)}`}>
                      {categoryLabel(cat)} {info.count}
                    </span>
                  ))}
              </div>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-4 mb-4 border-b border-arbiter-border">
          {(['opportunities', 'positions'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`pb-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
                tab === t
                  ? 'text-arbiter-amber border-arbiter-amber'
                  : 'text-arbiter-muted border-transparent hover:text-arbiter-text'
              }`}
            >
              {t === 'opportunities' ? `Opportunities (${opportunities.length})` : `Open Positions (${openBets.length})`}
            </button>
          ))}
        </div>

        {/* Opportunities tab */}
        {tab === 'opportunities' && (
          <div className="space-y-3">
            {opportunities.length === 0 ? (
              <div className="text-center py-16 text-arbiter-muted text-sm">
                No betable opportunities found — analysis is running every 30 minutes
              </div>
            ) : opportunities.map((a) => {
              const edge = parseFloat(String(a.edge ?? 0));
              const isExp = expanded.has(a.id);
              const resDate = a.market?.resolution_date;
              const edgeTag = edgeTypeBadge(a.edge_type);

              return (
                <div key={a.id} className="bg-arbiter-surface border border-arbiter-border rounded-lg overflow-hidden">
                  <button
                    className="w-full text-left p-4 hover:bg-arbiter-surface/80 transition-colors"
                    onClick={() => toggleExpanded(a.id)}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${categoryBg(a.category)}`}>
                            {categoryLabel(a.category)}
                          </span>
                          {edgeTag && (
                            <span className="text-[10px] text-arbiter-muted font-mono">{edgeTag}</span>
                          )}
                          {resDate && (
                            <span className={`text-[10px] font-mono ${urgencyColor(resDate)}`}>
                              ⏱ {daysUntil(resDate)}
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-arbiter-text font-medium leading-snug truncate">
                          {a.question_summary || a.market?.question}
                        </div>
                        <div className="text-xs text-arbiter-muted mt-1">
                          {confidenceDots(a.confidence)} {a.confidence} · {new Date(a.analyzed_at).toLocaleTimeString()}
                          {a.predictit_aligns && <span className="ml-2 text-arbiter-green">↔ PredictIt agrees</span>}
                        </div>
                      </div>
                      <div className="flex-shrink-0 text-right">
                        <Badge
                          value={edge}
                          direction={a.direction === 'BUY_NO' ? 'BUY_NO' : 'BUY_YES'}
                          size="lg"
                        />
                        <div className="text-xs font-mono text-arbiter-muted mt-1">
                          mkt {fmt(a.market_price, true)} → {fmt(a.true_prob, true)}
                        </div>
                        {a.rec_bet_usd > 0 && (
                          <div className="text-xs font-mono text-arbiter-amber mt-0.5">
                            Kelly {fmtUsd(a.rec_bet_usd)}
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                  {isExp && a.reasoning && (
                    <div className="border-t border-arbiter-border px-4 py-3 bg-arbiter-bg/50">
                      <div className="text-xs text-arbiter-muted mb-1 font-mono">REASONING</div>
                      <p className="text-xs text-arbiter-text leading-relaxed">{a.reasoning}</p>
                      {a.market && (
                        <div className="flex gap-4 mt-2 text-xs text-arbiter-muted font-mono">
                          <span>Liquidity: {fmtUsd(a.market.liquidity_usd)}</span>
                          {a.market.resolution_date && (
                            <span>Resolves: {new Date(a.market.resolution_date).toLocaleDateString()}</span>
                          )}
                          {a.auto_eligible && (
                            <span className="text-arbiter-green">✓ auto-eligible</span>
                          )}
                        </div>
                      )}
                      {a.flags && a.flags.length > 0 && (
                        <div className="flex gap-1 flex-wrap mt-2">
                          {a.flags.map((f, i) => (
                            <span key={i} className="text-[10px] font-mono text-arbiter-muted bg-arbiter-border/50 px-1.5 py-0.5 rounded">
                              {f}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Positions tab */}
        {tab === 'positions' && (
          <div className="space-y-3">
            {openBets.length === 0 ? (
              <div className="text-center py-16 text-arbiter-muted text-sm">
                No open politics positions
              </div>
            ) : openBets.map((b) => (
              <div key={b.id} className="bg-arbiter-surface border border-arbiter-border rounded-lg p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-xs font-mono font-semibold px-2 py-0.5 rounded ${
                        b.direction === 'BUY_YES'
                          ? 'bg-arbiter-green/10 text-arbiter-green'
                          : 'bg-red-500/10 text-red-400'
                      }`}>
                        {b.direction === 'BUY_YES' ? 'YES' : 'NO'}
                      </span>
                      {!b.condition_id && (
                        <span className="text-[10px] font-mono text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded">
                          ⚠ NO CONDITION_ID
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-arbiter-muted font-mono">
                      {b.market_id.slice(0, 16)}...
                    </div>
                    <div className="text-xs text-arbiter-muted mt-1">
                      Placed {new Date(b.placed_at).toLocaleDateString()} @ {b.entry_price.toFixed(3)}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-base font-mono font-semibold text-arbiter-text">
                      {fmtUsd(b.amount_usd)}
                    </div>
                    <div className="text-xs text-arbiter-muted">wagered</div>
                    {b.pnl !== null && b.pnl !== undefined && (
                      <div className={`text-xs font-mono mt-0.5 ${b.pnl >= 0 ? 'text-arbiter-green' : 'text-red-400'}`}>
                        {b.pnl >= 0 ? '+' : ''}{fmtUsd(b.pnl)}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </DataStateWrapper>
    </div>
  );
}
