'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/Badge';
import { BankrollCard } from '@/components/BankrollCard';
import { EdgeMeter } from '@/components/EdgeMeter';
import { CityWeatherCard } from '@/lib/types';

interface CitySignal {
  city_name: string;
  city_id: string;
  consensus_high_f: number | null;
  model_spread_f: number | null;
  agreement: string | null;
  market_question: string | null;
  market_outcomes: string[] | null;
  market_prices: number[] | null;
  best_outcome_label: string | null;
  edge: number | null;
  true_prob: number | null;
  market_price: number | null;
  direction: string | null;
  confidence: string | null;
  reasoning: string | null;
  rec_bet_usd: number | null;
  analyzed_at: string | null;
  nws_high: number | null;
  gfs_high: number | null;
  ecmwf_high: number | null;
  icon_high: number | null;
  signal_type: 'edge' | 'near_miss' | 'pass' | 'no_market';
}

export default function HomePage() {
  const [weatherData, setWeatherData] = useState<CityWeatherCard[]>([]);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [signals, setSignals] = useState<CitySignal[]>([]);
  const [citySnapshots, setCitySnapshots] = useState<CitySignal[]>([]);
  const [pipelineStatus, setPipelineStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [pipelineLog, setPipelineLog] = useState<string | null>(null);
  const [betsData, setBetsData] = useState<{ wins: number; losses: number; pnl: number }>({
    wins: 0,
    losses: 0,
    pnl: 0,
  });

  useEffect(() => {
    async function load() {
      try {
        const [weatherRes, betsRes, signalsRes] = await Promise.all([
          fetch('/api/weather'),
          fetch('/api/bets'),
          fetch('/api/signals'),
        ]);

        if (weatherRes.ok) {
          const wData = await weatherRes.json();
          setWeatherData(wData.cities || []);
        }

        if (betsRes.ok) {
          const bData = await betsRes.json();
          setConfig(bData.config || {});
          const bets = bData.bets || [];
          setBetsData({
            wins: bets.filter((b: { status: string }) => b.status === 'WON').length,
            losses: bets.filter((b: { status: string }) => b.status === 'LOST').length,
            pnl: bets.reduce((sum: number, b: { pnl: number | null }) => sum + (b.pnl || 0), 0),
          });
        }

        if (signalsRes.ok) {
          const sData = await signalsRes.json();
          setSignals(sData.signals || []);
          setCitySnapshots(sData.citySnapshots || []);
        }
      } catch (err) {
        console.error('Failed to load home data:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const runPipeline = async () => {
    setPipelineStatus('running');
    setPipelineLog('Fetching weather data...');
    try {
      // Step 1: Weather for cities 0-4
      const w1 = await fetch('/api/trigger/weather?offset=0');
      const w1Data = w1.ok ? await w1.json() : null;
      const f1 = w1Data?.summary?.forecasts || 0;
      setPipelineLog(`Batch 1: ${f1} forecasts. Fetching batch 2...`);

      // Step 2: Weather for cities 5-9
      const w2 = await fetch('/api/trigger/weather?offset=5');
      const w2Data = w2.ok ? await w2.json() : null;
      const f2 = w2Data?.summary?.forecasts || 0;
      setPipelineLog(`${f1 + f2} forecasts ingested. Searching markets...`);

      // Step 3: Market search + analysis
      const res = await fetch('/api/trigger');
      let marketsFound = 0;
      if (res.ok) {
        const data = await res.json();
        marketsFound = data.summary?.marketsFound || 0;
        setPipelineStatus('done');
        setPipelineLog(
          `${f1 + f2 + (data.summary?.forecasts || 0)} forecasts, ${marketsFound} markets found (${data.summary?.durationMs || 0}ms)`
        );
      } else {
        // Even if trigger fails, we got weather data
        const body = await res.text();
        setPipelineStatus(f1 + f2 > 0 ? 'done' : 'error');
        setPipelineLog(
          f1 + f2 > 0
            ? `${f1 + f2} forecasts ingested. Market search issue: ${body.substring(0, 100)}`
            : `Pipeline error: ${body.substring(0, 120)}`
        );
      }

      // Reload to show new data
      if (f1 + f2 > 0 || marketsFound > 0) {
        setTimeout(() => window.location.reload(), 2000);
      }
    } catch (err) {
      setPipelineStatus('error');
      setPipelineLog(`Network error: ${err instanceof Error ? err.message : 'check console'}`);
    }
  };

  const bankroll = parseFloat(config.paper_bankroll || '500');
  const totalBets = betsData.wins + betsData.losses;
  const winRate = totalBets > 0 ? betsData.wins / totalBets : 0;

  // Filter cities with edges
  const edgeCities = weatherData.filter(
    (c) => c.analysis && c.analysis.edge !== null && c.analysis.edge > 0.05
  );
  edgeCities.sort((a, b) => (b.analysis?.edge || 0) - (a.analysis?.edge || 0));

  // Resolving soon
  const resolvingSoon = weatherData.filter((c) => {
    if (!c.market?.resolution_date) return false;
    const hours = (new Date(c.market.resolution_date).getTime() - Date.now()) / 3600000;
    return hours > 0 && hours < 24;
  });

  // Cities with forecast data (even without markets)
  const citiesWithData = citySnapshots.filter((s) => s.consensus_high_f !== null);

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column */}
        <div className="lg:col-span-2 space-y-4">
          {/* Hero status bar */}
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-2 h-2 rounded-full ${citiesWithData.length > 0 ? 'bg-arbiter-green pulse-dot' : 'bg-arbiter-text-3'}`} />
              <span className="text-sm text-arbiter-text-2">
                {citiesWithData.length > 0
                  ? `Systems online — ${citiesWithData.length} cities tracked`
                  : 'Pipeline initializing — run manual sync below'}
              </span>
            </div>
            <span className="font-mono text-xs text-arbiter-text-3">
              {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
            </span>
          </div>

          {/* Recent Signals — the 3 closest opportunities */}
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg overflow-hidden">
            <div className="border-b border-arbiter-border px-5 py-3 flex items-center justify-between">
              <h2 className="text-xs text-arbiter-text-3 uppercase tracking-widest">
                Recent Signals
              </h2>
              <span className="text-[10px] text-arbiter-text-3 uppercase tracking-wider">
                Last 24h
              </span>
            </div>
            {loading ? (
              <div className="p-5 space-y-4">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="skeleton h-20 rounded" />
                ))}
              </div>
            ) : signals.length > 0 ? (
              <div className="divide-y divide-arbiter-border/50">
                {signals.map((signal) => (
                  <SignalCard key={signal.city_id} signal={signal} />
                ))}
              </div>
            ) : citiesWithData.length > 0 ? (
              /* Show city forecast snapshots when we have weather data but no analyzed signals */
              <div className="divide-y divide-arbiter-border/50">
                {citiesWithData.slice(0, 3).map((snap) => (
                  <div key={snap.city_id} className="px-5 py-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{snap.city_name}</span>
                        {snap.agreement && (
                          <Badge
                            variant={snap.agreement === 'HIGH' ? 'green' : snap.agreement === 'MEDIUM' ? 'amber' : 'red'}
                          >
                            {snap.agreement}
                          </Badge>
                        )}
                      </div>
                      <span className="font-mono text-lg font-medium">
                        {snap.consensus_high_f !== null ? `${snap.consensus_high_f}°F` : '—'}
                      </span>
                    </div>
                    <div className="flex gap-4 text-[11px] text-arbiter-text-3 font-mono">
                      {snap.gfs_high !== null && <span>GFS {snap.gfs_high}°</span>}
                      {snap.ecmwf_high !== null && <span>ECMWF {snap.ecmwf_high}°</span>}
                      {snap.icon_high !== null && <span>ICON {snap.icon_high}°</span>}
                      {snap.nws_high !== null && <span>NWS {snap.nws_high}°</span>}
                    </div>
                    {snap.model_spread_f !== null && (
                      <div className="mt-1.5 text-[10px] text-arbiter-text-3">
                        Spread: {snap.model_spread_f}°F
                        {!snap.market_question && (
                          <span className="ml-2 text-arbiter-text-3/60">No active market matched</span>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-5 py-10 text-center">
                <div className="w-10 h-10 rounded-lg bg-arbiter-elevated border border-arbiter-border flex items-center justify-center mx-auto mb-4">
                  <svg viewBox="0 0 20 20" fill="currentColor" width="20" height="20" className="text-arbiter-text-3">
                    <path fillRule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clipRule="evenodd" />
                  </svg>
                </div>
                <p className="text-sm text-arbiter-text-2 mb-1">No data yet</p>
                <p className="text-xs text-arbiter-text-3 mb-4">
                  Run the pipeline to start ingesting weather forecasts and scanning markets
                </p>
                <button
                  onClick={runPipeline}
                  disabled={pipelineStatus === 'running'}
                  className={`px-5 py-2.5 rounded-lg text-xs font-medium tracking-wide uppercase transition-all ${
                    pipelineStatus === 'running'
                      ? 'bg-arbiter-elevated text-arbiter-text-3 cursor-wait'
                      : pipelineStatus === 'done'
                      ? 'bg-arbiter-green/20 text-arbiter-green border border-arbiter-green/30'
                      : 'bg-arbiter-amber/20 text-arbiter-amber border border-arbiter-amber/30 hover:bg-arbiter-amber/30'
                  }`}
                >
                  {pipelineStatus === 'running'
                    ? 'Running pipeline...'
                    : pipelineStatus === 'done'
                    ? 'Complete — reloading'
                    : 'Run Pipeline Now'}
                </button>
                {pipelineLog && (
                  <p className={`text-[10px] mt-2 font-mono ${pipelineStatus === 'error' ? 'text-arbiter-red' : 'text-arbiter-text-3'}`}>
                    {pipelineLog}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Quick nav cards */}
          <div className="grid grid-cols-2 gap-3">
            <Link
              href="/weather"
              className="group bg-arbiter-card border border-arbiter-border rounded-lg p-4 hover:border-arbiter-amber/40 transition-all duration-200"
            >
              <div className="flex items-center gap-2 mb-2">
                <div className="w-6 h-6 rounded bg-arbiter-amber/10 flex items-center justify-center">
                  <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14" className="text-arbiter-amber">
                    <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
                  </svg>
                </div>
                <h3 className="text-sm font-medium group-hover:text-arbiter-amber transition-colors">
                  Weather Edge
                </h3>
              </div>
              <p className="text-xs text-arbiter-text-3">
                {edgeCities.length > 0
                  ? `${edgeCities.length} active opportunities`
                  : 'Model consensus vs market brackets'}
              </p>
            </Link>
            <Link
              href="/tracker"
              className="group bg-arbiter-card border border-arbiter-border rounded-lg p-4 hover:border-arbiter-green/40 transition-all duration-200"
            >
              <div className="flex items-center gap-2 mb-2">
                <div className="w-6 h-6 rounded bg-arbiter-green/10 flex items-center justify-center">
                  <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14" className="text-arbiter-green">
                    <path fillRule="evenodd" d="M12 7a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0V8.414l-4.293 4.293a1 1 0 01-1.414 0L8 10.414l-4.293 4.293a1 1 0 01-1.414-1.414l5-5a1 1 0 011.414 0L11 10.586 14.586 7H12z" clipRule="evenodd" />
                  </svg>
                </div>
                <h3 className="text-sm font-medium group-hover:text-arbiter-green transition-colors">
                  Tracker
                </h3>
              </div>
              <p className="text-xs text-arbiter-text-3">
                {totalBets > 0
                  ? `${totalBets} bets \u00B7 ${(winRate * 100).toFixed(0)}% win rate`
                  : 'Paper trading dashboard'}
              </p>
            </Link>
          </div>
        </div>

        {/* Right column — Edge Panel */}
        <div className="space-y-4">
          {/* Pipeline trigger (compact, always visible in sidebar) */}
          {citiesWithData.length > 0 && (
            <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs text-arbiter-text-3 uppercase tracking-widest">
                  Pipeline
                </h3>
                <button
                  onClick={runPipeline}
                  disabled={pipelineStatus === 'running'}
                  className={`px-3 py-1.5 rounded text-[10px] font-medium uppercase tracking-wider transition-all ${
                    pipelineStatus === 'running'
                      ? 'bg-arbiter-elevated text-arbiter-text-3 cursor-wait'
                      : pipelineStatus === 'done'
                      ? 'bg-arbiter-green/20 text-arbiter-green'
                      : 'bg-arbiter-amber/15 text-arbiter-amber hover:bg-arbiter-amber/25'
                  }`}
                >
                  {pipelineStatus === 'running' ? 'Running...' : pipelineStatus === 'done' ? 'Done' : 'Sync Now'}
                </button>
              </div>
              {pipelineLog && (
                <p className={`text-[10px] font-mono ${pipelineStatus === 'error' ? 'text-arbiter-red' : 'text-arbiter-text-3'}`}>
                  {pipelineLog}
                </p>
              )}
            </div>
          )}

          {/* Weather Edges */}
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-arbiter-border flex items-center justify-between">
              <h3 className="text-xs text-arbiter-text-3 uppercase tracking-widest">
                Active Edges
              </h3>
              <Link
                href="/weather"
                className="text-[10px] text-arbiter-text-3 hover:text-arbiter-amber transition-colors uppercase tracking-wider"
              >
                View All
              </Link>
            </div>
            <div className="divide-y divide-arbiter-border/50">
              {loading ? (
                <div className="p-4 space-y-3">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="skeleton h-10 rounded" />
                  ))}
                </div>
              ) : edgeCities.length > 0 ? (
                edgeCities.slice(0, 6).map((card) => (
                  <Link
                    key={card.city.id}
                    href="/weather"
                    className="flex items-center justify-between py-3 px-4 hover:bg-arbiter-elevated/50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-1.5 h-1.5 rounded-full bg-arbiter-amber" />
                      <div>
                        <span className="text-sm font-medium">
                          {card.city.name}
                        </span>
                        <span className="text-[10px] text-arbiter-text-3 ml-2 font-mono">
                          {card.analysis?.best_outcome_label}
                        </span>
                      </div>
                    </div>
                    <EdgeMeter edge={card.analysis?.edge || 0} className="w-20" />
                  </Link>
                ))
              ) : (
                <div className="px-4 py-6 text-center">
                  <p className="text-xs text-arbiter-text-3">
                    No active edges detected
                  </p>
                  <p className="text-[10px] text-arbiter-text-3 mt-1">
                    {citiesWithData.length > 0 ? 'Monitoring markets for mispricings' : 'Awaiting pipeline data'}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* City Forecast Grid (compact) */}
          {citiesWithData.length > 0 && (
            <div className="bg-arbiter-card border border-arbiter-border rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-arbiter-border">
                <h3 className="text-xs text-arbiter-text-3 uppercase tracking-widest">
                  Forecast Snapshot
                </h3>
              </div>
              <div className="divide-y divide-arbiter-border/50">
                {citiesWithData.map((snap) => (
                  <Link
                    key={snap.city_id}
                    href="/weather"
                    className="flex items-center justify-between py-2.5 px-4 hover:bg-arbiter-elevated/50 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <div className={`w-1.5 h-1.5 rounded-full ${
                        snap.agreement === 'HIGH' ? 'bg-arbiter-green' :
                        snap.agreement === 'MEDIUM' ? 'bg-arbiter-amber' : 'bg-arbiter-red'
                      }`} />
                      <span className="text-xs text-arbiter-text-2">{snap.city_name}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-xs">
                        {snap.consensus_high_f}°F
                      </span>
                      <span className="font-mono text-[10px] text-arbiter-text-3">
                        ±{snap.model_spread_f}°
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* Bankroll */}
          <BankrollCard
            bankroll={bankroll}
            pnl={betsData.pnl}
            winRate={winRate}
            totalBets={totalBets}
            wins={betsData.wins}
            losses={betsData.losses}
          />

          {/* Resolving Soon */}
          {resolvingSoon.length > 0 && (
            <div className="bg-arbiter-card border border-arbiter-border rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-arbiter-border">
                <h3 className="text-xs text-arbiter-text-3 uppercase tracking-widest">
                  Resolving Soon
                </h3>
              </div>
              <div className="divide-y divide-arbiter-border/50">
                {resolvingSoon.slice(0, 4).map((card) => {
                  const hours = card.market?.resolution_date
                    ? Math.round(
                        (new Date(card.market.resolution_date).getTime() - Date.now()) / 3600000
                      )
                    : 0;
                  return (
                    <div
                      key={card.city.id}
                      className="flex items-center justify-between py-2.5 px-4 text-xs"
                    >
                      <span className="text-arbiter-text-2">{card.city.name}</span>
                      <span className="font-mono text-arbiter-amber">{hours}h</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Signal Card Component — shows analyzed opportunity details
// ============================================================
function SignalCard({ signal }: { signal: CitySignal }) {
  const isEdge = signal.signal_type === 'edge';
  const isNearMiss = signal.signal_type === 'near_miss';

  return (
    <Link
      href="/weather"
      className="block px-5 py-4 hover:bg-arbiter-elevated/50 transition-colors"
    >
      {/* Header row */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${
            isEdge ? 'bg-arbiter-amber' : isNearMiss ? 'bg-arbiter-text-3' : 'bg-arbiter-border'
          }`} />
          <span className="text-sm font-medium">{signal.city_name}</span>
          {signal.agreement && (
            <Badge
              variant={signal.agreement === 'HIGH' ? 'green' : signal.agreement === 'MEDIUM' ? 'amber' : 'red'}
            >
              {signal.agreement}
            </Badge>
          )}
        </div>
        <div className="text-right">
          {isEdge ? (
            <Badge variant="amber">EDGE</Badge>
          ) : isNearMiss ? (
            <Badge variant="gray">NEAR MISS</Badge>
          ) : (
            <Badge variant="gray">PASS</Badge>
          )}
        </div>
      </div>

      {/* Forecast row */}
      <div className="flex items-baseline gap-4 mb-2">
        <span className="font-mono text-xl font-medium">
          {signal.consensus_high_f !== null ? `${signal.consensus_high_f}°F` : '—'}
        </span>
        <div className="flex gap-3 text-[10px] text-arbiter-text-3 font-mono">
          {signal.gfs_high !== null && <span>GFS {signal.gfs_high}°</span>}
          {signal.ecmwf_high !== null && <span>ECM {signal.ecmwf_high}°</span>}
          {signal.icon_high !== null && <span>ICN {signal.icon_high}°</span>}
          {signal.nws_high !== null && <span>NWS {signal.nws_high}°</span>}
        </div>
      </div>

      {/* Edge details */}
      {signal.edge !== null && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-xs">
            <span className="text-arbiter-text-3">{signal.best_outcome_label}</span>
            {signal.market_price !== null && (
              <span className="font-mono text-arbiter-text-3">
                mkt ${signal.market_price.toFixed(2)}
              </span>
            )}
            {signal.true_prob !== null && (
              <span className="font-mono text-arbiter-text-2">
                est {(signal.true_prob * 100).toFixed(0)}%
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {signal.edge > 0 && (
              <EdgeMeter edge={signal.edge} className="w-16" />
            )}
            {signal.rec_bet_usd !== null && signal.rec_bet_usd > 0 && (
              <span className="font-mono text-[10px] text-arbiter-amber">
                ${signal.rec_bet_usd.toFixed(0)}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Reasoning snippet */}
      {signal.reasoning && (
        <p className="text-[10px] text-arbiter-text-3 mt-2 leading-relaxed line-clamp-2">
          {signal.reasoning}
        </p>
      )}
    </Link>
  );
}
