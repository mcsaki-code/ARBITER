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
  market_question?: string | null;
  reasoning?: string | null;
  current_prices?: number[] | null;
  resolution_date?: string | null;
  is_resolved?: boolean;
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
// Helpers
// ============================================================

function formatCents(price: number): string {
  const cents = price * 100;
  if (cents < 1) return '<1¢';
  if (cents > 99) return '>99¢';
  return `${Math.round(cents)}¢`;
}

function getBetDisplayName(bet: Bet): string {
  if (bet.market_question) return bet.market_question;
  if (bet.outcome_label && !['Yes', 'No', 'yes', 'no'].includes(bet.outcome_label)) {
    return bet.outcome_label;
  }
  return bet.category === 'weather' ? 'Weather Market' : bet.category === 'sports' ? 'Sports Market' : bet.category === 'crypto' ? 'Crypto Market' : 'Market';
}

function formatAdvantage(edge: number): string {
  return `+${(edge * 100).toFixed(1)}%`;
}

function getConfidenceDots(level: string | null): string {
  if (!level) return '●○○○';
  if (level === 'HIGH') return '●●●●';
  if (level === 'MEDIUM') return '●●○○';
  if (level === 'LOW') return '●○○○';
  return '●○○○';
}

function getCategoryBadge(category: string | null): React.ReactNode {
  if (!category || category === 'general') return <div className="w-2 h-2 bg-slate-400 rounded-full" />;
  if (category === 'weather') return <div className="w-2 h-2 bg-yellow-400 rounded-full" />;
  if (category === 'sports') return <div className="w-2 h-2 bg-blue-400 rounded-full" />;
  if (category === 'crypto') return <div className="w-2 h-2 bg-orange-400 rounded-full" />;
  return <div className="w-2 h-2 bg-slate-400 rounded-full" />;
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
  const [pipelineProgress, setPipelineProgress] = useState(0);
  const [pipelineStep, setPipelineStep] = useState('');
  const [pipelineLog, setPipelineLog] = useState<string | null>(null);
  const [pipelineMarketCount, setPipelineMarketCount] = useState(0);
  const [pipelineDetails, setPipelineDetails] = useState<string[]>([]);

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

  // ============================================================
  // Pipeline trigger with progress steps
  // ============================================================
  const runPipeline = async () => {
    setPipelineStatus('running');
    setPipelineProgress(0);
    setPipelineStep('Ingesting weather forecasts...');
    setPipelineMarketCount(0);
    setPipelineLog(null);
    setPipelineDetails([]);

    try {
      // Step 1: Weather ingestion (2 batches, 25% each)
      setPipelineProgress(10);
      const w1 = await fetch('/api/trigger/weather?offset=0');
      const w1Data = w1.ok ? await w1.json() : null;
      const f1 = w1Data?.summary?.forecasts || 0;

      setPipelineProgress(20);
      const w2 = await fetch('/api/trigger/weather?offset=5');
      const w2Data = w2.ok ? await w2.json() : null;
      const f2 = w2Data?.summary?.forecasts || 0;
      const totalForecasts = f1 + f2;

      // Step 2: Market discovery (50%)
      setPipelineProgress(30);
      setPipelineStep('Discovering markets across weather, sports & crypto...');
      const res = await fetch('/api/trigger');
      const trigData = res.ok ? await res.json() : null;
      const marketsFound = trigData?.summary?.marketsFound || 0;
      setPipelineMarketCount(marketsFound);

      setPipelineProgress(55);
      setPipelineStep('Analyzing top picks with AI...');

      // Step 3: Analyze + Place Bets (75%)
      const betRes = await fetch('/api/trigger/bets');
      const betData = betRes.ok ? await betRes.json() : null;
      const betsPlaced = betData?.placed || 0;
      const candidates = betData?.candidates || 0;
      const betLog = betData?.log || [];
      setPipelineDetails(betLog);

      setPipelineProgress(80);
      setPipelineStep('Resolving settled markets...');

      // Step 4: Resolve (100%)
      let resolved = 0;
      try {
        const resolveRes = await fetch('/api/resolve');
        const resolveData = resolveRes.ok ? await resolveRes.json() : null;
        resolved = resolveData?.resolved || 0;
      } catch { /* non-critical */ }

      setPipelineProgress(100);

      // Build summary message
      const summary = [
        totalForecasts > 0 ? `${totalForecasts} forecasts ingested` : null,
        marketsFound > 0 ? `${marketsFound} markets discovered` : null,
        candidates > 0 ? `${candidates} analyzed` : null,
        betsPlaced > 0 ? `${betsPlaced} bets placed` : 'no new bets',
        resolved > 0 ? `${resolved} resolved` : null,
      ].filter(Boolean).join(' • ');

      setPipelineLog(summary || 'Pipeline complete');
      setPipelineStatus('done');

      // Reload after brief delay
      setTimeout(() => window.location.reload(), 2500);
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
  const allOpportunities = [...edgeSignals, ...arbs];

  // Calculate potential winnings from open bets
  const potentialWinnings = openBets.reduce((sum, b) => {
    const potentialPayout = b.amount_usd / b.entry_price;
    const potentialProfit = potentialPayout - b.amount_usd;
    return sum + potentialProfit;
  }, 0);

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold text-arbiter-text mb-1">ARBITER</h1>
            <p className="text-sm text-arbiter-text-3">AI-Powered Market Scanner</p>
          </div>
          <button
            onClick={runPipeline}
            disabled={pipelineStatus === 'running'}
            className={`px-6 py-2.5 rounded-lg font-semibold text-sm transition-all ${
              pipelineStatus === 'running'
                ? 'bg-arbiter-text-3/20 text-arbiter-text-3 cursor-wait'
                : pipelineStatus === 'done'
                ? 'bg-arbiter-green/20 text-arbiter-green border border-arbiter-green/40'
                : 'bg-arbiter-amber/15 text-arbiter-amber border border-arbiter-amber/40 hover:bg-arbiter-amber/25'
            }`}
          >
            {pipelineStatus === 'running' ? 'Scanning...' : pipelineStatus === 'done' ? 'Done' : 'Run AI Scanner'}
          </button>
        </div>

        {/* Scanning Progress Bar */}
        {pipelineStatus === 'running' && (
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4 mb-6">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-sm font-semibold text-arbiter-text">
                  SCANNING {pipelineMarketCount > 0 ? `${pipelineMarketCount}` : '?'} MARKETS
                </div>
                <div className="text-xs text-arbiter-text-3 mt-0.5">
                  Step {Math.ceil(pipelineProgress / 25)}/4: {pipelineStep}
                </div>
              </div>
              <div className="text-sm font-mono font-semibold text-arbiter-amber">
                {pipelineProgress}%
              </div>
            </div>
            {/* Progress bar */}
            <div className="h-2 bg-arbiter-bg rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-arbiter-amber to-arbiter-green rounded-full transition-all duration-500"
                style={{ width: `${pipelineProgress}%` }}
              />
            </div>
            {/* Step indicators */}
            <div className="grid grid-cols-4 gap-2 mt-3">
              {['Weather', 'Markets', 'Analysis', 'Settle'].map((label, idx) => (
                <div
                  key={idx}
                  className={`text-center text-xs py-2 rounded ${
                    pipelineProgress >= (idx + 1) * 25
                      ? 'bg-arbiter-amber/20 text-arbiter-amber font-semibold'
                      : 'bg-arbiter-bg text-arbiter-text-3'
                  }`}
                >
                  {label}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Pipeline completion message */}
        {pipelineLog && pipelineStatus !== 'running' && (
          <div className={`bg-arbiter-card border rounded-lg p-4 mb-6 ${
            pipelineStatus === 'error'
              ? 'border-arbiter-red/40 bg-arbiter-red/5'
              : 'border-arbiter-green/40 bg-arbiter-green/5'
          }`}>
            <div className={`text-sm font-mono ${
              pipelineStatus === 'error' ? 'text-arbiter-red' : 'text-arbiter-green'
            }`}>
              {pipelineLog}
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        {/* Key Metrics - 5 cards */}
        <div className="lg:col-span-2">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
            {/* Bankroll */}
            <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
              <div className="text-xs text-arbiter-text-3 uppercase tracking-wide mb-2">Bankroll</div>
              <div className="text-2xl font-bold text-arbiter-text">
                ${bankroll.toFixed(0)}
              </div>
              {totalPnl !== 0 && (
                <div className={`text-xs font-semibold mt-1 ${totalPnl >= 0 ? 'text-arbiter-green' : 'text-arbiter-red'}`}>
                  {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(0)} from trading
                </div>
              )}
            </div>

            {/* Open Bets */}
            <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
              <div className="text-xs text-arbiter-text-3 uppercase tracking-wide mb-2">Active Bets</div>
              <div className="text-2xl font-bold text-arbiter-text">
                {openBets.length}
              </div>
              {openBets.length > 0 && (
                <div className="text-xs text-arbiter-text-3 mt-1">
                  ${openExposure.toFixed(2)} at risk
                </div>
              )}
            </div>

            {/* Win Rate */}
            <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
              <div className="text-xs text-arbiter-text-3 uppercase tracking-wide mb-2">Win Rate</div>
              <div className={`text-2xl font-bold ${winRate > 0.55 ? 'text-arbiter-green' : 'text-arbiter-text'}`}>
                {resolvedBets.length > 0 ? `${Math.round(winRate * 100)}%` : '—'}
              </div>
              {resolvedBets.length > 0 && (
                <div className="text-xs text-arbiter-text-3 mt-1">
                  {wins}W/{losses}L
                </div>
              )}
            </div>

            {/* Total P&L */}
            <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
              <div className="text-xs text-arbiter-text-3 uppercase tracking-wide mb-2">Profit</div>
              <div className={`text-2xl font-bold ${totalPnl >= 0 ? 'text-arbiter-green' : 'text-arbiter-red'}`}>
                {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(0)}
              </div>
            </div>

            {/* Pipeline / Potential Winnings */}
            <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
              <div className="text-xs text-arbiter-text-3 uppercase tracking-wide mb-2">Pipeline</div>
              <div className={`text-2xl font-bold ${potentialWinnings >= 0 ? 'text-arbiter-green' : 'text-arbiter-text'}`}>
                {potentialWinnings >= 0 ? '+' : ''}{potentialWinnings.toFixed(0)}
              </div>
              {potentialWinnings > 0 && (
                <div className="text-xs text-arbiter-text-3 mt-1">
                  potential profit
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Bankroll Card */}
        <div>
          <BankrollCard
            bankroll={bankroll}
            pnl={totalPnl}
            winRate={winRate}
            totalBets={resolvedBets.length}
            wins={wins}
            losses={losses}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main content - 2/3 width */}
        <div className="lg:col-span-2 space-y-6">
          {/* AI Picks Section */}
          {allOpportunities.length > 0 ? (
            <div className="bg-arbiter-card border border-arbiter-border rounded-lg overflow-hidden">
              <div className="border-b border-arbiter-border px-5 py-4">
                <h2 className="text-sm font-semibold text-arbiter-text">
                  AI PICKS — Best opportunities right now
                </h2>
                <p className="text-xs text-arbiter-text-3 mt-1">
                  {allOpportunities.length} high-confidence edges discovered
                </p>
              </div>

              <div className="divide-y divide-arbiter-border/50">
                {allOpportunities.slice(0, 4).map((opp) => {
                  const isSignal = 'city_name' in opp;
                  const title = isSignal ? (opp as CitySignal).city_name : (opp as ArbOpportunity).event_question;
                  const edge = isSignal ? (opp as CitySignal).edge || 0 : (opp as ArbOpportunity).net_edge || (opp as ArbOpportunity).gross_edge;
                  const confidence = isSignal ? (opp as CitySignal).confidence : 'HIGH';
                  const reasoning = isSignal ? (opp as CitySignal).reasoning : null;
                  const category = isSignal ? 'weather' : (opp as ArbOpportunity).category;
                  const marketPrice = isSignal ? (opp as CitySignal).market_price : null;
                  const trueProb = isSignal ? (opp as CitySignal).true_prob : null;
                  const recBet = isSignal ? (opp as CitySignal).rec_bet_usd : null;
                  const outcome = isSignal ? (opp as CitySignal).best_outcome_label : null;

                  return (
                    <div key={isSignal ? (opp as CitySignal).city_id : (opp as ArbOpportunity).id} className="p-5 hover:bg-arbiter-elevated/30 transition-colors">
                      {/* Header with category badge and title */}
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-start gap-3 flex-1">
                          <div className="mt-1.5">{getCategoryBadge(category)}</div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-semibold text-arbiter-text truncate">{title}</div>
                            {outcome && (
                              <div className="text-xs text-arbiter-text-3 mt-0.5">
                                Betting: {outcome}
                              </div>
                            )}
                          </div>
                        </div>
                        <Badge variant={edge > 0.05 ? 'green' : 'amber'}>
                          {formatAdvantage(edge)}
                        </Badge>
                      </div>

                      {/* Prices and reasoning */}
                      {isSignal && marketPrice && trueProb && (
                        <div className="bg-arbiter-bg rounded p-3 mb-3 text-xs">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-arbiter-text-3">Market price:</span>
                            <span className="font-mono text-arbiter-text">{formatCents(marketPrice)}</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-arbiter-text-3">AI estimate:</span>
                            <span className="font-mono text-arbiter-green font-semibold">{formatCents(trueProb)}</span>
                          </div>
                        </div>
                      )}

                      {!isSignal && (
                        <div className="text-xs text-arbiter-text-3 mb-3 font-mono">
                          YES {formatCents((opp as ArbOpportunity).price_yes)} + NO {formatCents((opp as ArbOpportunity).price_no)} = {((opp as ArbOpportunity).combined_cost * 100).toFixed(0)}¢
                        </div>
                      )}

                      {reasoning && (
                        <div className="text-xs text-arbiter-text-2 mb-3 italic">
                          "{reasoning.substring(0, 120)}{reasoning.length > 120 ? '...' : ''}"
                        </div>
                      )}

                      {/* Confidence dots and recommendation */}
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-arbiter-text-3">Confidence:</span>
                          <span className="text-sm font-mono tracking-widest text-arbiter-amber">
                            {getConfidenceDots(confidence)}
                          </span>
                        </div>
                        {recBet && recBet > 0 && (
                          <div className="text-xs font-semibold text-arbiter-green">
                            Recommended: ${recBet.toFixed(2)}
                          </div>
                        )}
                      </div>

                      {/* Action button */}
                      <div className="mt-3">
                        <button className="w-full bg-arbiter-green/10 hover:bg-arbiter-green/20 border border-arbiter-green/40 text-arbiter-green text-xs font-semibold py-2 px-3 rounded transition-colors">
                          BET NOW
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {allOpportunities.length > 4 && (
                <div className="px-5 py-3 bg-arbiter-bg border-t border-arbiter-border/50 text-center">
                  <Link
                    href="/weather"
                    className="text-xs text-arbiter-text-3 hover:text-arbiter-amber transition-colors uppercase font-semibold tracking-wide"
                  >
                    View all {allOpportunities.length} opportunities →
                  </Link>
                </div>
              )}
            </div>
          ) : loading ? (
            <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-5">
              <div className="skeleton h-48 rounded" />
            </div>
          ) : (
            <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-6 text-center">
              <div className="text-sm text-arbiter-text-2 mb-2">No picks available yet</div>
              <p className="text-xs text-arbiter-text-3 mb-4">
                Run the AI Scanner to analyze markets and find the best betting opportunities
              </p>
              <button
                onClick={runPipeline}
                className="inline-block px-4 py-2 bg-arbiter-amber/15 hover:bg-arbiter-amber/25 border border-arbiter-amber/40 text-arbiter-amber text-xs font-semibold rounded transition-colors"
              >
                Start Scanning
              </button>
            </div>
          )}

          {/* Live Positions */}
          {openBets.length > 0 && (
            <div className="bg-arbiter-card border border-arbiter-border rounded-lg overflow-hidden">
              <div className="border-b border-arbiter-border px-5 py-4">
                <h2 className="text-sm font-semibold text-arbiter-text">
                  LIVE POSITIONS — Your AI's open bets
                </h2>
              </div>

              <div className="divide-y divide-arbiter-border/50">
                {openBets.slice(0, 6).map((bet) => {
                  // Current market price for the side we bet on
                  const currentPrice = bet.current_prices
                    ? bet.direction === 'BUY_YES'
                      ? bet.current_prices[0]
                      : bet.current_prices[1]
                    : null;
                  const priceMove = currentPrice ? currentPrice - bet.entry_price : null;

                  // Calculate potential payout and profit
                  const potentialPayout = bet.amount_usd / bet.entry_price;
                  const potentialProfit = potentialPayout - bet.amount_usd;

                  return (
                    <div key={bet.id} className="px-5 py-3 flex items-center justify-between hover:bg-arbiter-elevated/30 transition-colors">
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <div className="mt-0.5">{getCategoryBadge(bet.category)}</div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-arbiter-text truncate">
                            {getBetDisplayName(bet)}
                          </div>
                          <div className="text-xs text-arbiter-text-3 font-mono mt-0.5">
                            Bet {bet.direction === 'BUY_YES' ? 'YES' : 'NO'} at {formatCents(bet.entry_price)}
                            {currentPrice !== null && (
                              <span className={priceMove && priceMove > 0 ? 'text-arbiter-green' : priceMove && priceMove < 0 ? 'text-arbiter-red' : ''}>
                                {' → now '}{formatCents(currentPrice)}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="text-right shrink-0 ml-3">
                        <div className="text-sm font-bold text-arbiter-text">
                          ${bet.amount_usd.toFixed(2)}
                          {potentialProfit > 0 && (
                            <div className="text-xs text-arbiter-green font-semibold">
                              → +${potentialProfit.toFixed(2)}
                            </div>
                          )}
                        </div>
                        <div className="text-xs text-arbiter-amber font-semibold">{new Date(bet.placed_at).toLocaleDateString()}</div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Total exposure and potential upside summary */}
              <div className="px-5 py-3 bg-arbiter-bg border-t border-arbiter-border/50">
                <div className="text-xs text-arbiter-text-3">
                  Total exposure: <span className="text-arbiter-text font-semibold">${openExposure.toFixed(2)}</span> |
                  Potential upside: <span className="text-arbiter-green font-semibold">${potentialWinnings.toFixed(2)}</span>
                </div>
              </div>

              {openBets.length > 6 && (
                <div className="px-5 py-3 bg-arbiter-bg border-t border-arbiter-border/50 text-center">
                  <Link
                    href="/tracker"
                    className="text-xs text-arbiter-text-3 hover:text-arbiter-green transition-colors uppercase font-semibold tracking-wide"
                  >
                    View all {openBets.length} positions →
                  </Link>
                </div>
              )}
            </div>
          )}

          {/* Recent Results */}
          {resolvedBets.length > 0 && (
            <div className="bg-arbiter-card border border-arbiter-border rounded-lg overflow-hidden">
              <div className="border-b border-arbiter-border px-5 py-4">
                <h2 className="text-sm font-semibold text-arbiter-text">
                  RECENT RESULTS
                </h2>
              </div>

              <div className="divide-y divide-arbiter-border/50">
                {resolvedBets.slice(0, 5).map((bet) => (
                  <div key={bet.id} className="px-5 py-3 flex items-center justify-between">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div>
                        <Badge variant={bet.status === 'WON' ? 'green' : 'red'}>
                          {bet.status === 'WON' ? 'WON' : 'LOST'}
                        </Badge>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-arbiter-text truncate">
                          {getBetDisplayName(bet)}
                        </div>
                        <div className="text-xs text-arbiter-text-3 font-mono">
                          {new Date(bet.resolved_at || bet.placed_at).toLocaleDateString()}
                        </div>
                      </div>
                    </div>
                    <div className="text-right shrink-0 ml-3">
                      <div className={`text-sm font-bold font-mono ${(bet.pnl || 0) >= 0 ? 'text-arbiter-green' : 'text-arbiter-red'}`}>
                        {(bet.pnl || 0) >= 0 ? '+' : ''}{(bet.pnl || 0).toFixed(2)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Practice Mode Progress */}
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-5">
            <h3 className="text-sm font-semibold text-arbiter-text mb-4">
              PRACTICE MODE — Complete to unlock real trading
            </h3>

            <div className="space-y-4">
              <ProgressItem
                label="30-Day Track Record"
                current={config.paper_trade_start_date
                  ? Math.floor((Date.now() - new Date(config.paper_trade_start_date).getTime()) / 86400000)
                  : 0}
                target={30}
                unit="days"
              />
              <ProgressItem
                label="Minimum 50 Bets"
                current={bets.length}
                target={50}
                unit="bets"
              />
              <ProgressItem
                label="58% Win Rate"
                current={Math.round(winRate * 100)}
                target={58}
                unit="%"
              />
            </div>

            <div className="mt-4 text-xs text-arbiter-text-3 border-t border-arbiter-border/50 pt-4">
              Complete all three milestones to transition from paper to real money trading. Requirements exist to prove your system is robust.
            </div>
          </div>
        </div>

        {/* Right sidebar - 1/3 width */}
        <div className="space-y-6">
          {/* System Status */}
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg overflow-hidden">
            <div className="border-b border-arbiter-border px-5 py-4">
              <h3 className="text-sm font-semibold text-arbiter-text">System Status</h3>
            </div>

            <div className="p-5 space-y-3 text-xs">
              <StatusDot label="Markets scanned" count={pipelineMarketCount > 0 ? pipelineMarketCount : sportsCount + cryptoCount} active={pipelineMarketCount > 0 || sportsCount + cryptoCount > 0} />
              <StatusDot label="Weather edges" count={edgeSignals.length} active={edgeSignals.length > 0} />
              <StatusDot label="Arb opportunities" count={arbs.length} active={arbs.length > 0} />
              <StatusDot label="Open positions" count={openBets.length} active={openBets.length > 0} />
              <StatusDot label="Resolved bets" count={resolvedBets.length} active={resolvedBets.length > 0} />
            </div>
          </div>

          {/* Quick Links */}
          <div className="space-y-3">
            <Link
              href="/weather"
              className="block bg-arbiter-card border border-arbiter-border rounded-lg p-4 hover:border-arbiter-amber/40 transition-all"
            >
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2.5 h-2.5 bg-yellow-400 rounded-full" />
                <span className="text-xs font-semibold text-arbiter-text-3 uppercase">WEA</span>
              </div>
              <h4 className="text-sm font-semibold text-arbiter-text mb-1">Weather</h4>
              <p className="text-xs text-arbiter-text-3">{edgeSignals.length > 0 ? `${edgeSignals.length} edges` : 'Forecast analysis'}</p>
            </Link>

            <Link
              href="/sports"
              className="block bg-arbiter-card border border-arbiter-border rounded-lg p-4 hover:border-arbiter-green/40 transition-all"
            >
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2.5 h-2.5 bg-blue-400 rounded-full" />
                <span className="text-xs font-semibold text-arbiter-text-3 uppercase">SPO</span>
              </div>
              <h4 className="text-sm font-semibold text-arbiter-text mb-1">Sports</h4>
              <p className="text-xs text-arbiter-text-3">{sportsCount > 0 ? `${sportsCount} markets` : 'Market analysis'}</p>
            </Link>

            <Link
              href="/crypto"
              className="block bg-arbiter-card border border-arbiter-border rounded-lg p-4 hover:border-purple-400/40 transition-all"
            >
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2.5 h-2.5 bg-orange-400 rounded-full" />
                <span className="text-xs font-semibold text-arbiter-text-3 uppercase">CRY</span>
              </div>
              <h4 className="text-sm font-semibold text-arbiter-text mb-1">Crypto</h4>
              <p className="text-xs text-arbiter-text-3">{cryptoCount > 0 ? `${cryptoCount} markets` : 'Bracket analysis'}</p>
            </Link>

            <Link
              href="/arb"
              className="block bg-arbiter-card border border-arbiter-border rounded-lg p-4 hover:border-cyan-400/40 transition-all"
            >
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2.5 h-2.5 bg-cyan-400 rounded-full" />
                <span className="text-xs font-semibold text-arbiter-text-3 uppercase">ARB</span>
              </div>
              <h4 className="text-sm font-semibold text-arbiter-text mb-1">Arbitrage</h4>
              <p className="text-xs text-arbiter-text-3">{arbs.length > 0 ? `${arbs.length} opps` : 'Scanner'}</p>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Sub-components
// ============================================================

function ProgressItem({
  label,
  current,
  target,
  unit,
}: {
  label: string;
  current: number;
  target: number;
  unit: string;
}) {
  const pct = Math.min(100, (current / target) * 100);
  const passed = current >= target;

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-arbiter-text">{label}</span>
        <span className={`font-mono text-xs font-semibold ${passed ? 'text-arbiter-green' : 'text-arbiter-text-3'}`}>
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

function StatusDot({
  label,
  count,
  active,
}: {
  label: string;
  count: number;
  active: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <div className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-arbiter-green' : 'bg-arbiter-text-3/30'}`} />
        <span className="text-arbiter-text-2">{label}</span>
      </div>
      <span className="font-mono font-semibold text-arbiter-text">{count}</span>
    </div>
  );
}
