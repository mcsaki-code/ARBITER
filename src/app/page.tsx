'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/Badge';
import { BankrollCard } from '@/components/BankrollCard';
import { EdgeMeter } from '@/components/EdgeMeter';

// ============================================================
// Types
// ============================================================

interface Bet {
  id: string;
  market_id: string;
  category: string;
  direction: string;
  outcome_label: string | null;
  entry_price: number;
  amount_usd: number;
  status: string;
  pnl: number | null;
  placed_at: string;
  resolved_at: string | null;
}

interface CitySignal {
  city_name: string;
  city_id: string;
  consensus_high_f: number | null;
  model_spread_f: number | null;
  agreement: string | null;
  market_question: string | null;
  best_outcome_label: string | null;
  edge: number | null;
  true_prob: number | null;
  market_price: number | null;
  direction: string | null;
  confidence: string | null;
  reasoning: string | null;
  rec_bet_usd: number | null;
  analyzed_at: string | null;
  signal_type: 'edge' | 'near_miss' | 'pass' | 'no_market';
}

interface ArbOpportunity {
  id: string;
  event_question: string;
  price_yes: number;
  price_no: number;
  combined_cost: number;
  gross_edge: number;
  net_edge: number | null;
  category: string | null;
  status: string;
  detected_at: string;
}

// ============================================================
// Main Dashboard
// ============================================================

export default function HomePage() {
  const [config, setConfig] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [bets, setBets] = useState<Bet[]>([]);
  const [signals, setSignals] = useState<CitySignal[]>([]);
  const [arbs, setArbs] = useState<ArbOpportunity[]>([]);
  const [sportsCount, setSportsCount] = useState(0);
  const [cryptoCount, setCryptoCount] = useState(0);
  const [cryptoSignals, setCryptoSignals] = useState<Record<string, { spot_price: number; rsi_14: number | null; signal_summary: string }>>({});

  // Pipeline state
  const [pipelineStatus, setPipelineStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [pipelineLog, setPipelineLog] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [betsRes, signalsRes, arbRes, sportsRes, cryptoRes] = await Promise.all([
          fetch('/api/bets'),
          fetch('/api/signals'),
          fetch('/api/arb'),
          fetch('/api/sports'),
          fetch('/api/crypto'),
        ]);

        if (betsRes.ok) {
          const bData = await betsRes.json();
          setConfig(bData.config || {});
          setBets(bData.bets || []);
        }

        if (signalsRes.ok) {
          const sData = await signalsRes.json();
          setSignals(sData.signals || []);
        }

        if (arbRes.ok) {
          const aData = await arbRes.json();
          setArbs(aData.opportunities || []);
        }

        if (sportsRes.ok) {
          const spData = await sportsRes.json();
          setSportsCount(spData.summary?.total_markets || 0);
        }

        if (cryptoRes.ok) {
          const cData = await cryptoRes.json();
          setCryptoCount(cData.summary?.total_markets || 0);
          setCryptoSignals(cData.latest_signals || {});
        }
      } catch (err) {
        console.error('Failed to load dashboard data:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // Pipeline detail log
  const [pipelineDetails, setPipelineDetails] = useState<string[]>([]);

  // ============================================================
  // Pipeline trigger — runs full ingest + market discovery + analysis + bet placement
  // ============================================================
  const runPipeline = async () => {
    setPipelineStatus('running');
    setPipelineLog('Step 1/4: Ingesting weather forecasts...');
    setPipelineDetails([]);
    try {
      // Step 1: Weather ingestion (two batches)
      const w1 = await fetch('/api/trigger/weather?offset=0');
      const w1Data = w1.ok ? await w1.json() : null;
      const f1 = w1Data?.summary?.forecasts || 0;

      const w2 = await fetch('/api/trigger/weather?offset=5');
      const w2Data = w2.ok ? await w2.json() : null;
      const f2 = w2Data?.summary?.forecasts || 0;
      setPipelineLog(`Step 2/4: Discovering markets... (${f1 + f2} forecasts ingested)`);

      // Step 2: Market discovery
      const res = await fetch('/api/trigger');
      const trigData = res.ok ? await res.json() : null;
      const marketsFound = trigData?.summary?.marketsFound || 0;
      setPipelineLog(`Step 3/4: Analyzing markets + placing bets... (${marketsFound} markets found)`);

      // Step 3: Analyze + Place Bets (this now runs inline Claude analysis if needed)
      const betRes = await fetch('/api/trigger/bets');
      const betData = betRes.ok ? await betRes.json() : null;
      const betsPlaced = betData?.placed || 0;
      const betLog = betData?.log || [];
      setPipelineDetails(betLog);

      // Step 4: Resolve any settled markets
      setPipelineLog('Step 4/4: Resolving settled bets...');
      let resolved = 0;
      try {
        const resolveRes = await fetch('/api/resolve');
        const resolveData = resolveRes.ok ? await resolveRes.json() : null;
        resolved = resolveData?.resolved || 0;
      } catch { /* non-critical */ }

      const summary = [
        f1 + f2 > 0 ? `${f1 + f2} forecasts` : null,
        marketsFound > 0 ? `${marketsFound} markets` : null,
        betData?.candidates > 0 ? `${betData.candidates} analyzed` : null,
        betsPlaced > 0 ? `${betsPlaced} bets placed` : 'no new bets',
        resolved > 0 ? `${resolved} resolved` : null,
      ].filter(Boolean).join(' · ');

      setPipelineLog(summary || 'Pipeline complete — no new data');
      setPipelineStatus('done');

      // Reload after brief delay
      setTimeout(() => window.location.reload(), 3000);
    } catch (err) {
      setPipelineStatus('error');
      setPipelineLog(`Error: ${err instanceof Error ? err.message : 'check console'}`);
    }
  };

  // Derived stats
  const openBets = bets.filter((b) => b.status === 'OPEN');
  const resolvedBets = bets.filter((b) => b.status === 'WON' || b.status === 'LOST');
  const wins = resolvedBets.filter((b) => b.status === 'WON').length;
  const losses = resolvedBets.filter((b) => b.status === 'LOST').length;
  const totalPnl = resolvedBets.reduce((sum, b) => sum + (b.pnl || 0), 0);
  const winRate = resolvedBets.length > 0 ? wins / resolvedBets.length : 0;
  const bankroll = parseFloat(config.paper_bankroll || '500');
  const openExposure = openBets.reduce((sum, b) => sum + b.amount_usd, 0);
  const edgeSignals = signals.filter((s) => s.signal_type === 'edge');

  // BTC/ETH spot prices
  const btcSpot = (cryptoSignals as Record<string, { spot_price: number }>)?.['BTC']?.spot_price;
  const ethSpot = (cryptoSignals as Record<string, { spot_price: number }>)?.['ETH']?.spot_price;

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      {/* Hero bar */}
      <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4 flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${openBets.length > 0 ? 'bg-arbiter-green pulse-dot' : bets.length > 0 ? 'bg-arbiter-amber' : 'bg-arbiter-text-3'}`} />
          <span className="text-sm text-arbiter-text-2">
            {openBets.length > 0
              ? `${openBets.length} open position${openBets.length > 1 ? 's' : ''} · $${openExposure.toFixed(2)} deployed`
              : bets.length > 0
              ? `${resolvedBets.length} resolved · ${wins}W/${losses}L`
              : 'Pipeline initializing — run sync to start'}
          </span>
        </div>
        <button
          onClick={runPipeline}
          disabled={pipelineStatus === 'running'}
          className={`px-4 py-1.5 rounded-lg text-[10px] font-medium uppercase tracking-wider transition-all ${
            pipelineStatus === 'running'
              ? 'bg-arbiter-elevated text-arbiter-text-3 cursor-wait'
              : pipelineStatus === 'done'
              ? 'bg-arbiter-green/20 text-arbiter-green'
              : 'bg-arbiter-amber/15 text-arbiter-amber hover:bg-arbiter-amber/25 border border-arbiter-amber/30'
          }`}
        >
          {pipelineStatus === 'running' ? 'Running...' : pipelineStatus === 'done' ? 'Done ✓' : 'Sync & Place Bets'}
        </button>
      </div>
      {pipelineLog && (
        <div className="mb-4 px-1">
          <div className={`text-[10px] font-mono ${pipelineStatus === 'error' ? 'text-arbiter-red' : pipelineStatus === 'done' ? 'text-arbiter-green' : 'text-arbiter-amber'}`}>
            {pipelineLog}
          </div>
          {pipelineDetails.length > 0 && (
            <div className="mt-1 space-y-0.5">
              {pipelineDetails.slice(-8).map((line, i) => (
                <div key={i} className={`text-[9px] font-mono ${line.startsWith('BET:') ? 'text-arbiter-green' : line.startsWith('Error') || line.startsWith('Skip') ? 'text-arbiter-text-3' : 'text-arbiter-text-3/70'}`}>
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column — 2/3 width */}
        <div className="lg:col-span-2 space-y-4">

          {/* Active Positions */}
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg overflow-hidden">
            <div className="border-b border-arbiter-border px-5 py-3 flex items-center justify-between">
              <h2 className="text-xs text-arbiter-text-3 uppercase tracking-widest">
                Active Positions
              </h2>
              <Link href="/tracker" className="text-[10px] text-arbiter-text-3 hover:text-arbiter-green transition-colors uppercase tracking-wider">
                All Bets
              </Link>
            </div>
            {loading ? (
              <div className="p-5 space-y-3">
                {[1, 2, 3].map((i) => <div key={i} className="skeleton h-14 rounded" />)}
              </div>
            ) : openBets.length > 0 ? (
              <div className="divide-y divide-arbiter-border/50">
                {openBets.slice(0, 8).map((bet) => (
                  <div key={bet.id} className="px-5 py-3 flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <Badge variant={
                          bet.category === 'weather' ? 'amber' :
                          bet.category === 'sports' ? 'green' :
                          bet.category === 'crypto' ? 'purple' : 'gray'
                        }>
                          {bet.category}
                        </Badge>
                        <span className="text-xs font-medium truncate">
                          {bet.outcome_label || bet.market_id.substring(0, 12)}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-[10px] text-arbiter-text-3 font-mono">
                        <span>{bet.direction === 'BUY_YES' ? 'YES' : 'NO'}</span>
                        <span>@ {bet.entry_price.toFixed(3)}</span>
                        <span>{new Date(bet.placed_at).toLocaleDateString()}</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-sm font-semibold">${bet.amount_usd.toFixed(2)}</div>
                      <div className="text-[10px] font-mono text-arbiter-amber">OPEN</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-5 py-8 text-center">
                <p className="text-sm text-arbiter-text-2 mb-1">No active positions</p>
                <p className="text-xs text-arbiter-text-3">
                  {bets.length > 0
                    ? 'All bets have been resolved'
                    : 'Click "Sync & Place Bets" to analyze markets and place paper bets'}
                </p>
              </div>
            )}
          </div>

          {/* Weather Signals */}
          {edgeSignals.length > 0 && (
            <div className="bg-arbiter-card border border-arbiter-border rounded-lg overflow-hidden">
              <div className="border-b border-arbiter-border px-5 py-3 flex items-center justify-between">
                <h2 className="text-xs text-arbiter-text-3 uppercase tracking-widest">Weather Edges</h2>
                <Link href="/weather" className="text-[10px] text-arbiter-text-3 hover:text-arbiter-amber transition-colors uppercase tracking-wider">
                  View All
                </Link>
              </div>
              <div className="divide-y divide-arbiter-border/50">
                {edgeSignals.slice(0, 4).map((signal) => (
                  <Link
                    key={signal.city_id}
                    href="/weather"
                    className="flex items-center justify-between px-5 py-3 hover:bg-arbiter-elevated/50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-2 rounded-full bg-arbiter-amber" />
                      <div>
                        <span className="text-sm font-medium">{signal.city_name}</span>
                        <span className="text-[10px] text-arbiter-text-3 ml-2">{signal.best_outcome_label}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {signal.confidence && (
                        <Badge variant={signal.confidence === 'HIGH' ? 'green' : signal.confidence === 'MEDIUM' ? 'amber' : 'red'}>
                          {signal.confidence}
                        </Badge>
                      )}
                      <EdgeMeter edge={signal.edge || 0} className="w-16" />
                      {signal.rec_bet_usd !== null && signal.rec_bet_usd > 0 && (
                        <span className="font-mono text-[10px] text-arbiter-green">${signal.rec_bet_usd.toFixed(0)}</span>
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* Arb Opportunities */}
          {arbs.length > 0 && (
            <div className="bg-arbiter-card border border-arbiter-border rounded-lg overflow-hidden">
              <div className="border-b border-arbiter-border px-5 py-3 flex items-center justify-between">
                <h2 className="text-xs text-arbiter-text-3 uppercase tracking-widest">Arb Opportunities</h2>
                <Link href="/arb" className="text-[10px] text-arbiter-text-3 hover:text-arbiter-green transition-colors uppercase tracking-wider">
                  View All
                </Link>
              </div>
              <div className="divide-y divide-arbiter-border/50">
                {arbs.slice(0, 4).map((arb) => (
                  <div key={arb.id} className="px-5 py-3 flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate pr-3">{arb.event_question}</p>
                      <div className="flex items-center gap-2 mt-1 text-[10px] text-arbiter-text-3 font-mono">
                        <span>YES {arb.price_yes.toFixed(2)}</span>
                        <span>+</span>
                        <span>NO {arb.price_no.toFixed(2)}</span>
                        <span>=</span>
                        <span>{arb.combined_cost.toFixed(3)}</span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-mono text-sm font-semibold text-arbiter-green">
                        +{((arb.net_edge || arb.gross_edge) * 100).toFixed(1)}%
                      </div>
                      {arb.category && (
                        <Badge variant="gray">{arb.category}</Badge>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Quick Nav Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Link
              href="/weather"
              className="group bg-arbiter-card border border-arbiter-border rounded-lg p-4 hover:border-arbiter-amber/40 transition-all"
            >
              <div className="flex items-center gap-2 mb-1.5">
                <div className="w-5 h-5 rounded bg-arbiter-amber/10 flex items-center justify-center">
                  <svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12" className="text-arbiter-amber">
                    <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
                  </svg>
                </div>
                <h3 className="text-xs font-medium group-hover:text-arbiter-amber transition-colors">Weather</h3>
              </div>
              <p className="text-[10px] text-arbiter-text-3">
                {edgeSignals.length > 0 ? `${edgeSignals.length} edges` : 'Forecast analysis'}
              </p>
            </Link>
            <Link
              href="/sports"
              className="group bg-arbiter-card border border-arbiter-border rounded-lg p-4 hover:border-arbiter-green/40 transition-all"
            >
              <div className="flex items-center gap-2 mb-1.5">
                <div className="w-5 h-5 rounded bg-arbiter-green/10 flex items-center justify-center">
                  <svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12" className="text-arbiter-green">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9 5a1 1 0 012 0v4.586l2.707 2.707a1 1 0 11-1.414 1.414l-3-3A1 1 0 019 10V5z" clipRule="evenodd" />
                  </svg>
                </div>
                <h3 className="text-xs font-medium group-hover:text-arbiter-green transition-colors">Sports</h3>
              </div>
              <p className="text-[10px] text-arbiter-text-3">{sportsCount > 0 ? `${sportsCount} markets` : 'Sportsbook edge'}</p>
            </Link>
            <Link
              href="/crypto"
              className="group bg-arbiter-card border border-arbiter-border rounded-lg p-4 hover:border-purple-400/40 transition-all"
            >
              <div className="flex items-center gap-2 mb-1.5">
                <div className="w-5 h-5 rounded bg-purple-500/10 flex items-center justify-center">
                  <svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12" className="text-purple-400">
                    <path d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" />
                  </svg>
                </div>
                <h3 className="text-xs font-medium group-hover:text-purple-400 transition-colors">Crypto</h3>
              </div>
              <p className="text-[10px] text-arbiter-text-3">{cryptoCount > 0 ? `${cryptoCount} markets` : 'Bracket analysis'}</p>
            </Link>
            <Link
              href="/arb"
              className="group bg-arbiter-card border border-arbiter-border rounded-lg p-4 hover:border-cyan-400/40 transition-all"
            >
              <div className="flex items-center gap-2 mb-1.5">
                <div className="w-5 h-5 rounded bg-cyan-500/10 flex items-center justify-center">
                  <svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12" className="text-cyan-400">
                    <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" />
                  </svg>
                </div>
                <h3 className="text-xs font-medium group-hover:text-cyan-400 transition-colors">Arbitrage</h3>
              </div>
              <p className="text-[10px] text-arbiter-text-3">{arbs.length > 0 ? `${arbs.length} opps` : 'Sum-to-one scanner'}</p>
            </Link>
          </div>

          {/* Recent Resolved Bets */}
          {resolvedBets.length > 0 && (
            <div className="bg-arbiter-card border border-arbiter-border rounded-lg overflow-hidden">
              <div className="border-b border-arbiter-border px-5 py-3">
                <h2 className="text-xs text-arbiter-text-3 uppercase tracking-widest">Recent Results</h2>
              </div>
              <div className="divide-y divide-arbiter-border/50">
                {resolvedBets.slice(0, 6).map((bet) => (
                  <div key={bet.id} className="px-5 py-2.5 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className={`w-1.5 h-1.5 rounded-full ${bet.status === 'WON' ? 'bg-arbiter-green' : 'bg-arbiter-red'}`} />
                      <Badge variant={
                        bet.category === 'weather' ? 'amber' :
                        bet.category === 'sports' ? 'green' :
                        bet.category === 'crypto' ? 'purple' : 'gray'
                      }>
                        {bet.category}
                      </Badge>
                      <span className="text-xs text-arbiter-text-2 truncate max-w-[200px]">
                        {bet.outcome_label || bet.market_id.substring(0, 12)}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`font-mono text-xs font-semibold ${(bet.pnl || 0) >= 0 ? 'text-arbiter-green' : 'text-arbiter-red'}`}>
                        {(bet.pnl || 0) >= 0 ? '+' : ''}${(bet.pnl || 0).toFixed(2)}
                      </span>
                      <Badge variant={bet.status === 'WON' ? 'green' : 'red'}>
                        {bet.status}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right column — 1/3 width */}
        <div className="space-y-4">
          {/* Bankroll */}
          <BankrollCard
            bankroll={bankroll}
            pnl={totalPnl}
            winRate={winRate}
            totalBets={resolvedBets.length}
            wins={wins}
            losses={losses}
          />

          {/* System Status */}
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-arbiter-border">
              <h3 className="text-xs text-arbiter-text-3 uppercase tracking-widest">System Status</h3>
            </div>
            <div className="p-4 space-y-2">
              <StatusRow label="Open Positions" value={`${openBets.length}`} active={openBets.length > 0} />
              <StatusRow label="Exposure" value={`$${openExposure.toFixed(2)}`} active={openExposure > 0} />
              <StatusRow label="Weather Edges" value={`${edgeSignals.length}`} active={edgeSignals.length > 0} />
              <StatusRow label="Sports Markets" value={`${sportsCount}`} active={sportsCount > 0} />
              <StatusRow label="Crypto Markets" value={`${cryptoCount}`} active={cryptoCount > 0} />
              <StatusRow label="Arb Opps" value={`${arbs.length}`} active={arbs.length > 0} />
              {btcSpot && (
                <StatusRow label="BTC" value={`$${btcSpot.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} active />
              )}
              {ethSpot && (
                <StatusRow label="ETH" value={`$${ethSpot.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} active />
              )}
            </div>
          </div>

          {/* Paper Trading Gate */}
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-arbiter-border">
              <h3 className="text-xs text-arbiter-text-3 uppercase tracking-widest">Real Money Gate</h3>
            </div>
            <div className="p-4 space-y-3">
              <GateRow
                label="30-Day Track Record"
                current={config.paper_trade_start_date
                  ? Math.floor((Date.now() - new Date(config.paper_trade_start_date).getTime()) / 86400000)
                  : 0}
                target={30}
                unit="days"
              />
              <GateRow
                label="Minimum 50 Bets"
                current={bets.length}
                target={50}
                unit="bets"
              />
              <GateRow
                label="58% Win Rate"
                current={Math.round(winRate * 100)}
                target={58}
                unit="%"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Sub-components
// ============================================================

function StatusRow({ label, value, active }: { label: string; value: string; active: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <div className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-arbiter-green' : 'bg-arbiter-text-3/30'}`} />
        <span className="text-xs text-arbiter-text-2">{label}</span>
      </div>
      <span className="font-mono text-xs text-arbiter-text">{value}</span>
    </div>
  );
}

function GateRow({ label, current, target, unit }: { label: string; current: number; target: number; unit: string }) {
  const pct = Math.min(100, (current / target) * 100);
  const passed = current >= target;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-arbiter-text-2">{label}</span>
        <span className={`font-mono text-xs ${passed ? 'text-arbiter-green' : 'text-arbiter-text-3'}`}>
          {current}/{target}{unit}
        </span>
      </div>
      <div className="h-1.5 bg-arbiter-bg rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${passed ? 'bg-arbiter-green' : 'bg-arbiter-amber'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
