'use client';

import { useState, useEffect, useCallback } from 'react';
import { Badge } from '@/components/Badge';
import { DataStateWrapper } from '@/components/DataState';
import { DataState } from '@/lib/types';

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
  analyses: unknown[];
}

export default function CryptoPage() {
  const [data, setData] = useState<CryptoResponse | null>(null);
  const [state, setState] = useState<DataState>('loading');
  const [asset, setAsset] = useState<string>('all');

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
    const q = m.question.toLowerCase();
    return q.includes(asset.toLowerCase());
  });

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

  // Parse signal summary JSON
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
          <h1 className="text-xl font-semibold mb-1">Crypto Edge</h1>
          <p className="text-sm text-arbiter-text-2">
            Price bracket analysis using technical + on-chain signals
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
        emptyMessage="No crypto markets found yet. The crypto signal engine runs every 10 minutes and will discover BTC/ETH bracket markets automatically."
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
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">Crypto Markets</div>
            <div className="font-mono text-lg">{data?.summary?.total_markets || 0}</div>
          </div>
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">Total Volume</div>
            <div className="font-mono text-lg">{formatUsd(data?.summary?.total_volume || 0)}</div>
          </div>
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">Signal Snapshots</div>
            <div className="font-mono text-lg">{data?.summary?.total_signals || 0}</div>
          </div>
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">Edge Analyses</div>
            <div className="font-mono text-lg">{data?.summary?.total_analyses || 0}</div>
          </div>
        </div>

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
                    <Badge variant="purple">crypto</Badge>
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
                </div>
              </div>
            </div>
          ))}
        </div>
      </DataStateWrapper>
    </div>
  );
}
