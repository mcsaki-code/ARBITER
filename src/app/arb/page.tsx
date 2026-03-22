'use client';

import { useState, useEffect, useCallback } from 'react';
import { Badge } from '@/components/Badge';
import { DataStateWrapper } from '@/components/DataState';
import { DataState } from '@/lib/types';

interface ArbOpportunity {
  id: string;
  detected_at: string;
  market_a_id: string;
  platform_a: string;
  platform_b: string | null;
  event_question: string;
  price_yes: number;
  price_no: number;
  combined_cost: number;
  gross_edge: number;
  net_edge: number;
  volume_a: number;
  liquidity_a: number;
  category: string;
  status: string;
}

interface ArbResponse {
  summary: {
    total_open: number;
    avg_net_edge: number;
    total_liquidity: number;
    by_category: Record<string, number>;
  };
  opportunities: ArbOpportunity[];
}

export default function ArbPage() {
  const [data, setData] = useState<ArbResponse | null>(null);
  const [state, setState] = useState<DataState>('loading');
  const [filter, setFilter] = useState<string>('all');

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/arb');
      if (!res.ok) throw new Error('Failed to fetch');
      const json: ArbResponse = await res.json();
      setData(json);
      setState(!json.opportunities || json.opportunities.length === 0 ? 'empty' : 'fresh');
    } catch {
      setState(data ? 'stale' : 'error');
    }
  }, [data]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = (data?.opportunities || []).filter((arb) => {
    if (filter === 'all') return true;
    return arb.category === filter;
  });

  const formatUsd = (n: number) => {
    if (n >= 1000000) return `$${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `$${(n / 1000).toFixed(0)}K`;
    return `$${n.toFixed(0)}`;
  };

  const categories = data?.summary?.by_category ? Object.keys(data.summary.by_category) : [];

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold mb-1">Arbitrage Scanner</h1>
          <p className="text-sm text-arbiter-text-2">
            Sum-to-one and cross-platform pricing inefficiencies
          </p>
        </div>
        <div className="flex gap-1 bg-arbiter-card border border-arbiter-border rounded-lg p-1">
          <button
            onClick={() => setFilter('all')}
            className={`px-3 py-1.5 text-xs rounded-md transition-all ${
              filter === 'all'
                ? 'bg-arbiter-elevated text-arbiter-text'
                : 'text-arbiter-text-3 hover:text-arbiter-text-2'
            }`}
          >
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setFilter(cat)}
              className={`px-3 py-1.5 text-xs rounded-md transition-all capitalize ${
                filter === cat
                  ? 'bg-arbiter-elevated text-arbiter-text'
                  : 'text-arbiter-text-3 hover:text-arbiter-text-2'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      <DataStateWrapper
        state={state}
        lastUpdated={data ? 'just now' : null}
        emptyMessage="No arbitrage opportunities detected yet. The scanner runs every 15 minutes."
        skeletonCount={4}
      >
        {/* Stats bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">Open Arbs</div>
            <div className="font-mono text-lg">{data?.summary?.total_open || 0}</div>
          </div>
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">Avg Net Edge</div>
            <div className="font-mono text-lg text-arbiter-green">
              {((data?.summary?.avg_net_edge || 0) * 100).toFixed(1)}%
            </div>
          </div>
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">Total Liquidity</div>
            <div className="font-mono text-lg">
              {formatUsd(data?.summary?.total_liquidity || 0)}
            </div>
          </div>
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">Categories</div>
            <div className="font-mono text-lg">{categories.length}</div>
          </div>
        </div>

        {/* Arb list */}
        <div className="space-y-2">
          {filtered.map((arb) => (
            <ArbCard key={arb.id} arb={arb} formatUsd={formatUsd} />
          ))}
        </div>

        {filtered.length === 0 && (data?.opportunities?.length || 0) > 0 && (
          <div className="text-center py-8 text-sm text-arbiter-text-3">
            No arbs match the selected filter
          </div>
        )}
      </DataStateWrapper>
    </div>
  );
}

function ArbCard({ arb, formatUsd }: { arb: ArbOpportunity; formatUsd: (n: number) => string }) {
  const [expanded, setExpanded] = useState(false);

  const categoryVariant = (cat: string) => {
    switch (cat) {
      case 'sports': return 'green' as const;
      case 'crypto': return 'purple' as const;
      case 'weather': return 'amber' as const;
      case 'politics': return 'blue' as const;
      default: return 'gray' as const;
    }
  };

  return (
    <div className="bg-arbiter-card border border-arbiter-border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-4 py-3 hover:bg-arbiter-elevated/50 transition-colors"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium leading-snug pr-2">
              {arb.event_question}
            </p>
            <div className="flex items-center gap-2 mt-1.5">
              <Badge variant={categoryVariant(arb.category)}>{arb.category}</Badge>
              <span className="text-[10px] text-arbiter-text-3 font-mono">
                Liq {formatUsd(arb.liquidity_a)}
              </span>
              <span className="text-[10px] text-arbiter-text-3 font-mono">
                Vol {formatUsd(arb.volume_a)}
              </span>
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="font-mono text-sm font-semibold text-arbiter-green">
              +{(arb.net_edge * 100).toFixed(1)}%
            </div>
            <div className="text-[10px] text-arbiter-text-3 font-mono">net edge</div>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-arbiter-border/50">
          <div className="pt-3 grid grid-cols-2 gap-3">
            <div>
              <div className="text-[10px] text-arbiter-text-3 uppercase">YES Price</div>
              <div className="font-mono text-sm">${arb.price_yes.toFixed(3)}</div>
            </div>
            <div>
              <div className="text-[10px] text-arbiter-text-3 uppercase">NO Price</div>
              <div className="font-mono text-sm">${arb.price_no.toFixed(3)}</div>
            </div>
            <div>
              <div className="text-[10px] text-arbiter-text-3 uppercase">Combined Cost</div>
              <div className="font-mono text-sm">${arb.combined_cost.toFixed(3)}</div>
            </div>
            <div>
              <div className="text-[10px] text-arbiter-text-3 uppercase">Gross Edge</div>
              <div className="font-mono text-sm text-arbiter-green">
                {(arb.gross_edge * 100).toFixed(2)}%
              </div>
            </div>
          </div>
          <div className="flex gap-4 mt-3 text-[10px] text-arbiter-text-3 font-mono">
            <span>Detected: {new Date(arb.detected_at).toLocaleString()}</span>
            <span>ID: {arb.market_a_id.substring(0, 12)}...</span>
          </div>
        </div>
      )}
    </div>
  );
}
