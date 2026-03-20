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

// ============================================================
// Weather market validation — matches server-side filter
// ============================================================
const WEATHER_POSITIVE = [
  'temperature', 'weather', '°f', '°c', 'degrees fahrenheit', 'degrees celsius',
  'high temp', 'low temp', 'precipitation', 'rainfall', 'snowfall',
  'hurricane', 'tropical storm', 'heat wave', 'cold snap', 'frost',
  'wind chill', 'heat index', 'daily high', 'daily low',
  'warmest', 'coldest', 'record high', 'record low',
];

const WEATHER_NEGATIVE = [
  'nba', 'nfl', 'mlb', 'nhl', 'ncaa', 'premier league', 'champions league',
  'world cup', 'ufc', 'mma', 'boxing', 'tennis', 'golf', 'f1', 'formula',
  'election', 'president', 'congress', 'senate', 'democrat', 'republican',
  'bitcoin', 'ethereum', 'crypto', 'stock', 'nasdaq', 's&p',
  'touchdown', 'field goal', 'three-pointer', 'home run', 'strikeout',
  'assists', 'rebounds', 'rushing', 'passing yards', 'sacks',
  'points scored', 'total points', 'over under', 'spread',
  'winner of', 'win the', 'championship', 'playoff', 'super bowl',
  'world series', 'stanley cup', 'finals', 'mvp',
  'oscar', 'emmy', 'grammy', 'box office',
];

const CITY_TERMS = [
  'new york', 'nyc', 'manhattan', 'chicago', 'miami', 'seattle', 'denver',
  'los angeles', 'l.a.', 'oklahoma city', 'okc', 'omaha',
  'minneapolis', 'twin cities', 'phoenix', 'atlanta',
];

function isWeatherMarket(m: Market): boolean {
  const q = m.question.toLowerCase();

  // Reject sports/politics/crypto
  for (const term of WEATHER_NEGATIVE) {
    if (q.includes(term)) return false;
  }

  // Accept if positive weather term found
  for (const term of WEATHER_POSITIVE) {
    if (q.includes(term)) return true;
  }

  // Accept if city mention + degree pattern
  const degreesPattern = /\d+\s*°|above \d+|below \d+|over \d+|under \d+/;
  const hasCityMention = CITY_TERMS.some((c) => q.includes(c));
  if (hasCityMention && degreesPattern.test(q)) return true;

  return false;
}

export default function MarketsPage() {
  const [data, setData] = useState<MarketsResponse | null>(null);
  const [state, setState] = useState<DataState>('loading');
  const [filter, setFilter] = useState<'all' | 'temperature' | 'weather' | 'city-matched'>('all');

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

  // Filter to weather markets only, then apply sub-filter
  const weatherMarkets = data?.markets?.filter(isWeatherMarket) || [];
  const filtered = weatherMarkets.filter((m) => {
    if (filter === 'all') return true;
    if (filter === 'city-matched') return !!m.city_id;
    return m.category === filter;
  });

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
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold mb-1">Markets</h1>
          <p className="text-sm text-arbiter-text-2">
            Active weather and temperature contracts on Polymarket
          </p>
        </div>
        <div className="flex gap-1 bg-arbiter-card border border-arbiter-border rounded-lg p-1">
          {([
            { key: 'all', label: 'All' },
            { key: 'city-matched', label: 'Tracked' },
            { key: 'temperature', label: 'Temp' },
            { key: 'weather', label: 'Weather' },
          ] as const).map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 text-xs rounded-md transition-all ${
                filter === f.key
                  ? 'bg-arbiter-elevated text-arbiter-text'
                  : 'text-arbiter-text-3 hover:text-arbiter-text-2'
              }`}
            >
              {f.label}
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
        <div className="grid grid-cols-4 gap-3 mb-4">
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">Weather Markets</div>
            <div className="font-mono text-lg">{weatherMarkets.length}</div>
          </div>
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">City Tracked</div>
            <div className="font-mono text-lg">
              {weatherMarkets.filter((m) => m.city_id).length}
            </div>
          </div>
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">Total Volume</div>
            <div className="font-mono text-lg">
              {formatUsd(filtered.reduce((sum, m) => sum + m.volume_usd, 0))}
            </div>
          </div>
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">Total Liquidity</div>
            <div className="font-mono text-lg">
              {formatUsd(filtered.reduce((sum, m) => sum + m.liquidity_usd, 0))}
            </div>
          </div>
        </div>

        {/* Info banner when no weather markets found */}
        {weatherMarkets.length === 0 && (data?.markets?.length || 0) > 0 && (
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4 mb-4">
            <p className="text-sm text-arbiter-text-2">
              {data?.markets?.length} total Polymarket contracts found, but none match weather/temperature criteria.
              Temperature markets on Polymarket are typically daily high-temperature bracket bets for major US cities.
              These appear most frequently on weekdays and resolve using NWS data.
            </p>
          </div>
        )}

        {/* Market list */}
        <div className="space-y-2">
          {filtered.map((market) => (
            <MarketCard key={market.id} market={market} formatDate={formatDate} formatUsd={formatUsd} />
          ))}
        </div>

        {filtered.length === 0 && weatherMarkets.length > 0 && (
          <div className="text-center py-8 text-sm text-arbiter-text-3">
            No markets match the selected filter
          </div>
        )}
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
              {hasCity && <Badge variant="green">Tracked</Badge>}
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
