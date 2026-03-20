'use client';

import { useState, useEffect, useCallback } from 'react';
import { Badge } from '@/components/Badge';
import { DataStateWrapper } from '@/components/DataState';
import { DataState } from '@/lib/types';

interface Market {
  id: string;
  condition_id: string;
  question: string;
  category: string;
  city_id: string | null;
  outcomes: string[];
  outcome_prices: number[];
  volume_usd: number;
  liquidity_usd: number;
  resolution_date: string;
  is_active: boolean;
  updated_at: string;
}

interface MarketsResponse {
  markets: Market[];
  lastUpdated: string;
}

export default function MarketsPage() {
  const [data, setData] = useState<MarketsResponse | null>(null);
  const [state, setState] = useState<DataState>('loading');
  const [filter, setFilter] = useState<'all' | 'temperature' | 'weather'>('all');

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/markets');
      if (!res.ok) throw new Error('Failed to fetch');
      const json: MarketsResponse = await res.json();
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

  const filtered = data?.markets?.filter((m) => {
    if (filter === 'all') return true;
    return m.category === filter;
  }) || [];

  const formatDate = (iso: string) => {
    if (!iso) return '—';
    const d = new Date(iso);
    const now = Date.now();
    const hours = Math.round((d.getTime() - now) / 3600000);
    if (hours < 0) return 'Resolved';
    if (hours < 24) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
  };

  const formatUsd = (n: number) => {
    if (n >= 1000000) return `$${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `$${(n / 1000).toFixed(0)}K`;
    return `$${n.toFixed(0)}`;
  };

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold mb-1">Markets</h1>
          <p className="text-sm text-arbiter-text-2">
            Active Polymarket weather and temperature contracts
          </p>
        </div>
        <div className="flex gap-1 bg-arbiter-card border border-arbiter-border rounded-lg p-1">
          {(['all', 'temperature', 'weather'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-xs rounded-md transition-all capitalize ${
                filter === f
                  ? 'bg-arbiter-elevated text-arbiter-text'
                  : 'text-arbiter-text-3 hover:text-arbiter-text-2'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <DataStateWrapper
        state={state}
        lastUpdated={data?.lastUpdated ? 'just now' : null}
        emptyMessage="No active markets found — run pipeline sync to search Polymarket"
        skeletonCount={4}
      >
        {/* Stats bar */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">Active Markets</div>
            <div className="font-mono text-lg">{filtered.length}</div>
          </div>
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">Total Volume</div>
            <div className="font-mono text-lg">
              {formatUsd(filtered.reduce((sum, m) => sum + m.volume_usd, 0))}
            </div>
          </div>
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">City Matched</div>
            <div className="font-mono text-lg">
              {filtered.filter((m) => m.city_id).length}
            </div>
          </div>
        </div>

        {/* Market list */}
        <div className="space-y-2">
          {filtered.map((market) => (
            <MarketCard key={market.id} market={market} formatDate={formatDate} formatUsd={formatUsd} />
          ))}
        </div>
      </DataStateWrapper>
    </div>
  );
}

function MarketCard({
  market,
  formatDate,
  formatUsd,
}: {
  market: Market;
  formatDate: (iso: string) => string;
  formatUsd: (n: number) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const resolves = formatDate(market.resolution_date);
  const hasCity = !!market.city_id;

  return (
    <div className="bg-arbiter-card border border-arbiter-border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-4 py-3 hover:bg-arbiter-elevated/50 transition-colors"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium leading-snug pr-2">
              {market.question}
            </p>
            <div className="flex items-center gap-2 mt-1.5">
              <Badge variant={market.category === 'temperature' ? 'amber' : 'blue'}>
                {market.category}
              </Badge>
              {hasCity && <Badge variant="green">City Matched</Badge>}
              <span className="text-[10px] text-arbiter-text-3 font-mono">
                Vol {formatUsd(market.volume_usd)}
              </span>
              <span className="text-[10px] text-arbiter-text-3 font-mono">
                Liq {formatUsd(market.liquidity_usd)}
              </span>
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="font-mono text-xs text-arbiter-text-3">{resolves}</div>
            <svg
              className={`w-4 h-4 text-arbiter-text-3 mt-1 ml-auto transition-transform ${expanded ? 'rotate-180' : ''}`}
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-arbiter-border/50">
          <div className="pt-3 space-y-1">
            {market.outcomes.map((outcome, i) => {
              const price = market.outcome_prices[i] || 0;
              const pct = (price * 100).toFixed(0);
              return (
                <div key={i} className="flex items-center gap-3">
                  <div className="flex-1 flex items-center gap-2">
                    <span className="text-xs font-mono text-arbiter-text-2 w-32 truncate">
                      {outcome}
                    </span>
                    <div className="flex-1 h-2 bg-arbiter-bg rounded-full overflow-hidden">
                      <div
                        className="h-full bg-arbiter-amber/60 rounded-full transition-all"
                        style={{ width: `${Math.min(price * 100, 100)}%` }}
                      />
                    </div>
                  </div>
                  <span className="font-mono text-xs text-arbiter-text w-12 text-right">
                    {pct}%
                  </span>
                  <span className="font-mono text-[10px] text-arbiter-text-3 w-12 text-right">
                    ${price.toFixed(2)}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="flex gap-4 mt-3 text-[10px] text-arbiter-text-3 font-mono">
            <span>ID: {market.condition_id.substring(0, 12)}...</span>
            <span>Updated: {new Date(market.updated_at).toLocaleTimeString()}</span>
          </div>
        </div>
      )}
    </div>
  );
}
