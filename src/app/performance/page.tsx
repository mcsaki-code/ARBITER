'use client';

import { useState, useEffect, useCallback } from 'react';
import { Bet, PerformanceSnapshot, DataState } from '@/lib/types';
import { DataStateWrapper } from '@/components/DataState';
import { Badge } from '@/components/Badge';

// ============================================================
// Helpers
// ============================================================

function fmt(n: number, decimals?: number): string {
  const d = decimals !== undefined ? decimals : (Number.isInteger(n) ? 0 : 2);
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function formatPrice(price: number): string {
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

// ============================================================
// Types
// ============================================================

interface ApiResponse {
  bets: Bet[];
  config: Record<string, string>;
  snapshots: PerformanceSnapshot[];
  lastUpdated: string;
  pipeline_summary: {
    total_exposure: number;
    total_potential_profit: number;
    open_count: number;
  };
}

interface EntryPriceBucket {
  label: string;
  min: number;
  max: number;
  bets: number;
  wins: number;
  losses: number;
  open: number;
  totalWagered: number;
  totalPnl: number;
  winRate: number;
}

interface CategoryStats {
  wins: number;
  losses: number;
  open: number;
  winRate: number;
  totalPnl: number;
  totalWagered: number;
}

// ============================================================
// Main Page
// ============================================================

export default function PerformancePage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [state, setState] = useState<DataState>('loading');
  const [tab, setTab] = useState<'overview' | 'bets' | 'open'>('overview');

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/bets');
      if (!res.ok) throw new Error('Failed to fetch');
      const json: ApiResponse = await res.json();
      setData(json);
      setState(json.bets.length === 0 ? 'empty' : 'fresh');
    } catch {
      setState(data ? 'stale' : 'error');
    }
  }, [data]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  const bets = data?.bets || [];
  const config = data?.config || {};
  const snapshots = data?.snapshots || [];
  const bankroll = parseFloat(config.paper_bankroll || '5000');

  // Core metrics
  const resolved = bets.filter(b => b.status === 'WON' || b.status === 'LOST');
  const open = bets.filter(b => b.status === 'OPEN');
  const wins = bets.filter(b => b.status === 'WON').length;
  const losses = bets.filter(b => b.status === 'LOST').length;
  const totalPnl = resolved.reduce((sum, b) => sum + (b.pnl || 0), 0);
  const totalWagered = bets.reduce((sum, b) => sum + b.amount_usd, 0);
  const winRate = wins + losses > 0 ? wins / (wins + losses) : 0;
  const roi = totalWagered > 0 ? (totalPnl / totalWagered) * 100 : 0;
  const openExposure = open.reduce((sum, b) => sum + b.amount_usd, 0);
  const openPotentialProfit = open.reduce((sum, b) => {
    return sum + ((b.amount_usd / b.entry_price) - b.amount_usd);
  }, 0);

  // Sharpe ratio
  const returns = resolved.map(b => b.pnl || 0);
  const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 1
    ? returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1)
    : 0;
  const sharpe = Math.sqrt(variance) > 0 ? avgReturn / Math.sqrt(variance) : 0;

  // Entry price bucket analysis — THE key insight
  const entryBuckets = analyzeEntryPriceBuckets(bets);

  // Category stats
  const categories = ['weather', 'sports', 'crypto'];
  const categoryStats: Record<string, CategoryStats> = {};
  for (const cat of categories) {
    categoryStats[cat] = calculateCategoryStats(bets, cat);
  }

  // Sort bets by date for display
  const allBetsSorted = [...bets].sort((a, b) =>
    new Date(b.placed_at).getTime() - new Date(a.placed_at).getTime()
  );
  const resolvedSorted = [...resolved].sort((a, b) =>
    new Date(b.placed_at).getTime() - new Date(a.placed_at).getTime()
  );
  const openSorted = [...open].sort((a, b) =>
    new Date(b.placed_at).getTime() - new Date(a.placed_at).getTime()
  );

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-xl font-semibold">Performance Analysis</h1>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-arbiter-amber/15 text-arbiter-amber border border-arbiter-amber/30 tracking-wider">
            V2
          </span>
        </div>
        <p className="text-sm text-arbiter-text-2">
          {config.v2_start_date
            ? `Tracking since ${new Date(config.v2_start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} — fresh start with updated risk rules`
            : 'Live performance metrics, bet history, and strategy analysis'}
        </p>
      </div>

      {/* KPI Cards — Always visible */}
      <DataStateWrapper state={state} emptyMessage="No betting data yet" skeletonCount={1}>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3 mb-6">
          <KpiCard
            label="NET P&L"
            value={`${totalPnl >= 0 ? '+' : ''}$${fmt(totalPnl)}`}
            color={totalPnl >= 0 ? 'green' : 'red'}
          />
          <KpiCard
            label="BANKROLL"
            value={`$${fmt(bankroll, 0)}`}
            color="white"
          />
          <KpiCard
            label="ROI"
            value={`${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`}
            color={roi >= 0 ? 'green' : 'red'}
          />
          <KpiCard
            label="WIN RATE"
            value={resolved.length > 0 ? `${(winRate * 100).toFixed(1)}%` : '—'}
            color={winRate >= 0.5 ? 'green' : winRate > 0 ? 'red' : 'gray'}
          />
          <KpiCard
            label="RESOLVED"
            value={`${wins}W / ${losses}L`}
            sub={`${resolved.length} total`}
            color="white"
          />
          <KpiCard
            label="OPEN BETS"
            value={`${open.length}`}
            sub={`$${fmt(openExposure, 0)} at risk`}
            color="blue"
          />
          <KpiCard
            label="WAGERED"
            value={`$${fmt(totalWagered, 0)}`}
            color="white"
          />
          <KpiCard
            label="SHARPE"
            value={fmt(sharpe, 2)}
            color={sharpe > 0 ? 'green' : sharpe < 0 ? 'red' : 'gray'}
          />
        </div>

        {/* Tab Switcher */}
        <div className="flex gap-1 mb-6 bg-arbiter-card border border-arbiter-border rounded-lg p-1 w-fit">
          {[
            { key: 'overview' as const, label: 'Overview' },
            { key: 'bets' as const, label: `All Bets (${bets.length})` },
            { key: 'open' as const, label: `Open (${open.length})` },
          ].map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2 text-xs font-semibold rounded-md transition-all ${
                tab === t.key
                  ? 'bg-arbiter-amber/20 text-arbiter-amber'
                  : 'text-arbiter-text-3 hover:text-arbiter-text-2'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* TAB: Overview */}
        {tab === 'overview' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left column — Charts & analysis */}
            <div className="lg:col-span-2 space-y-6">
              {/* Cumulative P&L Chart */}
              <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
                <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider mb-3">
                  CUMULATIVE P&L
                </h3>
                {resolved.length > 1 ? (
                  <PnlChart bets={resolved} />
                ) : (
                  <div className="h-40 flex items-center justify-center text-sm text-arbiter-text-3">
                    Chart appears after 2+ resolved bets
                  </div>
                )}
              </div>

              {/* Entry Price Analysis — THE KEY INSIGHT */}
              <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
                <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider mb-1">
                  ENTRY PRICE VS OUTCOME
                </h3>
                <p className="text-[10px] text-arbiter-text-3 mb-4">
                  Bets grouped by entry price. Lower entry = higher leverage = better risk/reward.
                  MAX_ENTRY_PRICE cap at 40¢ is now enforced.
                </p>
                <div className="space-y-3">
                  {entryBuckets.map((bucket, i) => (
                    <EntryPriceBucketRow key={i} bucket={bucket} />
                  ))}
                </div>
              </div>

              {/* Category Performance */}
              <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
                <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider mb-4">
                  PERFORMANCE BY CATEGORY
                </h3>
                <div className="space-y-4">
                  {categories.map(cat => (
                    <CategoryRow key={cat} category={cat} stats={categoryStats[cat]} />
                  ))}
                </div>
              </div>

              {/* Recent Resolved Bets — Top 10 */}
              <div className="bg-arbiter-card border border-arbiter-border rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-arbiter-border flex items-center justify-between">
                  <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider">
                    RECENT RESOLVED BETS
                  </h3>
                  <button
                    onClick={() => setTab('bets')}
                    className="text-[10px] text-arbiter-amber hover:underline"
                  >
                    View all →
                  </button>
                </div>
                <BetTable bets={resolvedSorted.slice(0, 10)} showPnl={true} />
              </div>
            </div>

            {/* Right column — Summary panels */}
            <div className="space-y-4">
              {/* Bankroll History */}
              {snapshots.length > 1 && (
                <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
                  <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider mb-3">
                    BANKROLL HISTORY
                  </h3>
                  <BankrollChart snapshots={snapshots} />
                </div>
              )}

              {/* Risk Rules */}
              <div className="bg-arbiter-elevated border border-arbiter-border rounded-lg p-4">
                <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider mb-3">
                  ACTIVE RISK RULES
                </h3>
                <div className="space-y-2 text-xs">
                  <RiskRule label="Max Entry Price" value="40¢" highlight />
                  <RiskRule label="Max Per Bet" value="3% bankroll" />
                  <RiskRule label="Max Daily Exposure" value="20% bankroll" />
                  <RiskRule label="Min Edge (Weather)" value="8%" />
                  <RiskRule label="Min Edge (Other)" value="5%" />
                  <RiskRule label="Kelly Fraction" value="1/8th" />
                  <RiskRule label="Min Liquidity" value="$5,000" />
                  <RiskRule label="Min Liquidity (Weather)" value="$400" />
                </div>
              </div>

              {/* Pipeline Summary */}
              <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
                <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider mb-2">
                  OPEN PIPELINE
                </h3>
                <div className="text-2xl font-data font-semibold text-arbiter-blue">
                  {openPotentialProfit >= 0 ? '+' : ''}${fmt(openPotentialProfit)}
                </div>
                <p className="text-[10px] text-arbiter-text-3 mt-2">
                  Potential profit from {open.length} open bets if all win
                </p>
                <div className="mt-3 text-[10px] text-arbiter-text-3 space-y-1">
                  <div className="flex justify-between">
                    <span>Total at risk</span>
                    <span className="font-data text-arbiter-text">${fmt(openExposure)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Avg entry price</span>
                    <span className="font-data text-arbiter-text">
                      {open.length > 0
                        ? formatPrice(open.reduce((s, b) => s + b.entry_price, 0) / open.length)
                        : '—'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Bet Size Stats */}
              <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
                <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider mb-3">
                  BET SIZE DISTRIBUTION
                </h3>
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-arbiter-text-3">Average</span>
                    <span className="font-data text-arbiter-text">
                      ${fmt(bets.length > 0 ? bets.reduce((s, b) => s + b.amount_usd, 0) / bets.length : 0, 0)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-arbiter-text-3">Max</span>
                    <span className="font-data text-arbiter-text">
                      ${fmt(Math.max(...bets.map(b => b.amount_usd), 0), 0)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-arbiter-text-3">Largest Win</span>
                    <span className="font-data text-arbiter-green">
                      +${fmt(resolved.filter(b => b.status === 'WON').reduce((max, b) => Math.max(max, b.pnl || 0), 0))}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-arbiter-text-3">Largest Loss</span>
                    <span className="font-data text-arbiter-red">
                      ${fmt(resolved.filter(b => b.status === 'LOST').reduce((min, b) => Math.min(min, b.pnl || 0), 0))}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB: All Bets */}
        {tab === 'bets' && (
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-arbiter-border">
              <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider">
                ALL BETS ({bets.length})
              </h3>
            </div>
            <BetTable bets={allBetsSorted} showPnl={true} />
          </div>
        )}

        {/* TAB: Open Positions */}
        {tab === 'open' && (
          <div className="space-y-6">
            <div className="bg-arbiter-card border border-arbiter-border rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-arbiter-border">
                <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider">
                  OPEN POSITIONS ({open.length})
                </h3>
              </div>
              <BetTable bets={openSorted} showPnl={false} showPotential={true} />
            </div>

            {/* Risk profile of open bets */}
            <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
              <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider mb-3">
                OPEN POSITION RISK PROFILE
              </h3>
              <div className="space-y-2">
                {openSorted.map(bet => {
                  const leverage = (1 / bet.entry_price).toFixed(1);
                  const potential = (bet.amount_usd / bet.entry_price) - bet.amount_usd;
                  const isHighPrice = bet.entry_price > 0.40;
                  return (
                    <div key={bet.id} className="flex items-center justify-between text-xs py-2 border-b border-arbiter-border/30">
                      <div className="flex-1 min-w-0">
                        <div className="truncate text-arbiter-text text-[11px]">
                          {getBetDisplayName(bet)}
                        </div>
                        <div className="text-[10px] text-arbiter-text-3 mt-0.5">
                          {bet.direction === 'BUY_YES' ? 'YES' : 'NO'} @ {formatPrice(bet.entry_price)} · {leverage}x leverage
                        </div>
                      </div>
                      <div className="text-right ml-3">
                        <div className="font-data text-arbiter-text">${fmt(bet.amount_usd, 0)}</div>
                        <div className={`font-data text-[10px] ${isHighPrice ? 'text-arbiter-red' : 'text-arbiter-green'}`}>
                          {isHighPrice ? '⚠ High entry' : `+$${fmt(potential, 0)} potential`}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </DataStateWrapper>
    </div>
  );
}

// ============================================================
// KPI Card
// ============================================================

function KpiCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  const colorMap: Record<string, string> = {
    green: 'text-arbiter-green',
    red: 'text-arbiter-red',
    blue: 'text-arbiter-blue',
    amber: 'text-arbiter-amber',
    white: 'text-arbiter-text',
    gray: 'text-arbiter-text-3',
  };
  return (
    <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
      <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">{label}</div>
      <div className={`font-data text-lg font-semibold ${colorMap[color] || 'text-arbiter-text'}`}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-arbiter-text-3 mt-0.5">{sub}</div>}
    </div>
  );
}

// ============================================================
// Risk Rule Row
// ============================================================

function RiskRule({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-arbiter-text-3">{label}</span>
      <span className={`font-data ${highlight ? 'text-arbiter-amber font-semibold' : 'text-arbiter-text'}`}>
        {value}
      </span>
    </div>
  );
}

// ============================================================
// Bet Table (responsive)
// ============================================================

function BetTable({ bets, showPnl, showPotential }: { bets: Bet[]; showPnl: boolean; showPotential?: boolean }) {
  if (bets.length === 0) {
    return (
      <div className="p-6 text-center text-sm text-arbiter-text-3">
        No bets to display
      </div>
    );
  }

  return (
    <>
      {/* Desktop */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-arbiter-text-3 uppercase tracking-wider border-b border-arbiter-border">
              <th className="text-left px-4 py-2">Date</th>
              <th className="text-left px-4 py-2">Market</th>
              <th className="text-center px-4 py-2">Cat</th>
              <th className="text-center px-4 py-2">Side</th>
              <th className="text-right px-4 py-2">Entry</th>
              <th className="text-right px-4 py-2">Amount</th>
              {showPnl && <th className="text-right px-4 py-2">P&L</th>}
              {showPotential && <th className="text-right px-4 py-2">Potential</th>}
              <th className="text-center px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {bets.map(bet => {
              const potential = (bet.amount_usd / bet.entry_price) - bet.amount_usd;
              return (
                <tr key={bet.id} className="border-b border-arbiter-border/50 hover:bg-arbiter-elevated/50">
                  <td className="px-4 py-2 font-data text-arbiter-text-2 whitespace-nowrap">
                    {new Date(bet.placed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </td>
                  <td className="px-4 py-2 max-w-[280px]">
                    <div className="truncate text-arbiter-text" title={getBetDisplayName(bet)}>
                      {getBetDisplayName(bet)}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-center">
                    <Badge variant={bet.category === 'weather' ? 'blue' : bet.category === 'sports' ? 'green' : 'purple'}>
                      {bet.category}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-center">
                    <Badge variant={bet.direction === 'BUY_YES' ? 'green' : 'red'}>
                      {bet.direction === 'BUY_YES' ? 'YES' : 'NO'}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 font-data text-right text-arbiter-text-2">
                    {formatPrice(bet.entry_price)}
                  </td>
                  <td className="px-4 py-2 font-data text-right text-arbiter-text">
                    ${fmt(bet.amount_usd, 0)}
                  </td>
                  {showPnl && (
                    <td className={`px-4 py-2 font-data text-right ${
                      (bet.pnl || 0) >= 0 ? 'text-arbiter-green' : 'text-arbiter-red'
                    }`}>
                      {bet.pnl !== null ? `${bet.pnl >= 0 ? '+' : ''}$${fmt(bet.pnl, 0)}` : '—'}
                    </td>
                  )}
                  {showPotential && (
                    <td className="px-4 py-2 font-data text-right text-arbiter-blue">
                      +${fmt(potential, 0)}
                    </td>
                  )}
                  <td className="px-4 py-2 text-center">
                    <Badge variant={bet.status === 'WON' ? 'green' : bet.status === 'LOST' ? 'red' : 'amber'}>
                      {bet.status}
                    </Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile */}
      <div className="md:hidden space-y-2 p-3">
        {bets.map(bet => {
          const potential = (bet.amount_usd / bet.entry_price) - bet.amount_usd;
          return (
            <div key={bet.id} className="bg-arbiter-bg rounded-lg p-3 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium truncate max-w-[200px]">
                  {getBetDisplayName(bet)}
                </span>
                <Badge variant={bet.status === 'WON' ? 'green' : bet.status === 'LOST' ? 'red' : 'amber'}>
                  {bet.status}
                </Badge>
              </div>
              <div className="flex items-center justify-between text-xs font-data">
                <span className="text-arbiter-text-3">
                  {new Date(bet.placed_at).toLocaleDateString()} · {bet.direction === 'BUY_YES' ? 'YES' : 'NO'} @ {formatPrice(bet.entry_price)}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs font-data">
                <span className="text-arbiter-text-2">${fmt(bet.amount_usd, 0)}</span>
                {showPnl && bet.pnl !== null && (
                  <span className={(bet.pnl || 0) >= 0 ? 'text-arbiter-green' : 'text-arbiter-red'}>
                    {bet.pnl >= 0 ? '+' : ''}${fmt(bet.pnl, 0)}
                  </span>
                )}
                {showPotential && (
                  <span className="text-arbiter-blue">+${fmt(potential, 0)} potential</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ============================================================
// Entry Price Bucket Row
// ============================================================

function EntryPriceBucketRow({ bucket }: { bucket: EntryPriceBucket }) {
  const barWidth = bucket.bets > 0 ? Math.min((bucket.bets / 15) * 100, 100) : 0;
  const isProfit = bucket.totalPnl >= 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div>
          <span className="text-xs font-medium text-arbiter-text">{bucket.label}</span>
          <span className="text-[10px] text-arbiter-text-3 ml-2">
            {bucket.bets} bets · {bucket.wins}W/{bucket.losses}L{bucket.open > 0 ? `/${bucket.open}O` : ''}
          </span>
        </div>
        <div className="text-right">
          <span className={`text-xs font-data font-semibold ${isProfit ? 'text-arbiter-green' : 'text-arbiter-red'}`}>
            {isProfit ? '+' : ''}${fmt(bucket.totalPnl)}
          </span>
          {bucket.wins + bucket.losses > 0 && (
            <span className="text-[10px] text-arbiter-text-3 ml-2">
              {(bucket.winRate * 100).toFixed(0)}% WR
            </span>
          )}
        </div>
      </div>
      <div className="w-full bg-arbiter-bg rounded h-2 overflow-hidden">
        <div
          className={`h-full ${isProfit ? 'bg-arbiter-green' : 'bg-arbiter-red'}`}
          style={{ width: `${barWidth}%`, opacity: 0.7 }}
        />
      </div>
    </div>
  );
}

// ============================================================
// Category Row
// ============================================================

function CategoryRow({ category, stats }: { category: string; stats: CategoryStats }) {
  const total = stats.wins + stats.losses;
  const winPct = total > 0 ? (stats.wins / total) * 100 : 0;
  const displayCat = category.charAt(0).toUpperCase() + category.slice(1);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-xs font-medium text-arbiter-text">{displayCat}</div>
          <div className="text-[10px] text-arbiter-text-3">
            {stats.wins}W / {stats.losses}L{stats.open > 0 ? ` / ${stats.open}O` : ''}
            {stats.totalWagered > 0 && ` · $${fmt(stats.totalWagered, 0)} wagered`}
          </div>
        </div>
        <div className="text-right">
          <div className={`text-xs font-data font-semibold ${stats.totalPnl >= 0 ? 'text-arbiter-green' : 'text-arbiter-red'}`}>
            {stats.totalPnl >= 0 ? '+' : ''}${fmt(stats.totalPnl)}
          </div>
          <div className="text-[10px] text-arbiter-text-3">
            {total > 0 ? `${(stats.winRate * 100).toFixed(1)}% WR` : 'No resolved'}
          </div>
        </div>
      </div>
      <div className="w-full bg-arbiter-bg rounded h-2 overflow-hidden">
        <div className="h-full bg-arbiter-green" style={{ width: `${Math.min(winPct, 100)}%` }} />
      </div>
    </div>
  );
}

// ============================================================
// SVG Charts
// ============================================================

function PnlChart({ bets }: { bets: Bet[] }) {
  const sorted = [...bets].sort((a, b) =>
    new Date(a.resolved_at || '').getTime() - new Date(b.resolved_at || '').getTime()
  );

  let cumulative = 0;
  const points = sorted.map(bet => {
    cumulative += bet.pnl || 0;
    return { date: bet.resolved_at || '', pnl: cumulative };
  });

  if (points.length < 2) return null;

  const values = points.map(p => p.pnl);
  const minVal = Math.min(...values, 0);
  const maxVal = Math.max(...values, 0);
  const range = maxVal - minVal || 1;

  const width = 600;
  const height = 160;
  const padding = { top: 10, right: 10, bottom: 20, left: 50 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const svgPoints = values.map((v, i) => {
    const x = padding.left + (i / (values.length - 1)) * chartW;
    const y = padding.top + chartH - ((v - minVal) / range) * chartH;
    return `${x},${y}`;
  });

  const linePath = `M ${svgPoints.join(' L ')}`;
  const areaPath = `${linePath} L ${padding.left + chartW},${padding.top + chartH} L ${padding.left},${padding.top + chartH} Z`;
  const lastVal = values[values.length - 1];
  const isUp = lastVal >= 0;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-40">
      {[0, 0.25, 0.5, 0.75, 1].map(pct => {
        const y = padding.top + chartH * (1 - pct);
        const val = minVal + range * pct;
        return (
          <g key={pct}>
            <line x1={padding.left} x2={width - padding.right} y1={y} y2={y} stroke="#2a2a38" strokeWidth="1" />
            <text x={padding.left - 5} y={y + 3} fill="#555570" fontSize="9" textAnchor="end" fontFamily="JetBrains Mono, monospace">
              ${Math.round(val)}
            </text>
          </g>
        );
      })}
      <path d={areaPath} fill={isUp ? 'rgba(0, 212, 160, 0.1)' : 'rgba(255, 77, 109, 0.1)'} />
      <path d={linePath} fill="none" stroke={isUp ? '#00d4a0' : '#ff4d6d'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {svgPoints.length > 0 && (
        <circle
          cx={parseFloat(svgPoints[svgPoints.length - 1].split(',')[0])}
          cy={parseFloat(svgPoints[svgPoints.length - 1].split(',')[1])}
          r="3"
          fill={isUp ? '#00d4a0' : '#ff4d6d'}
        />
      )}
    </svg>
  );
}

function BankrollChart({ snapshots }: { snapshots: PerformanceSnapshot[] }) {
  const sorted = [...snapshots].sort((a, b) =>
    new Date(a.snapshot_date).getTime() - new Date(b.snapshot_date).getTime()
  );

  if (sorted.length < 2) return null;

  const values = sorted.map(s => s.paper_bankroll || 0);
  const minVal = Math.min(...values) * 0.95;
  const maxVal = Math.max(...values) * 1.05;
  const range = maxVal - minVal || 1;

  const width = 300;
  const height = 120;
  const padding = { top: 5, right: 5, bottom: 15, left: 40 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const svgPoints = values.map((v, i) => {
    const x = padding.left + (i / (values.length - 1)) * chartW;
    const y = padding.top + chartH - ((v - minVal) / range) * chartH;
    return `${x},${y}`;
  });

  const linePath = `M ${svgPoints.join(' L ')}`;
  const lastVal = values[values.length - 1];
  const firstVal = values[0];
  const isUp = lastVal >= firstVal;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-28">
      <path d={linePath} fill="none" stroke={isUp ? '#00d4a0' : '#ff4d6d'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <text x={padding.left - 3} y={padding.top + 8} fill="#555570" fontSize="8" textAnchor="end" fontFamily="JetBrains Mono, monospace">
        ${fmt(maxVal, 0)}
      </text>
      <text x={padding.left - 3} y={height - padding.bottom} fill="#555570" fontSize="8" textAnchor="end" fontFamily="JetBrains Mono, monospace">
        ${fmt(minVal, 0)}
      </text>
    </svg>
  );
}

// ============================================================
// Analysis Helpers
// ============================================================

function analyzeEntryPriceBuckets(bets: Bet[]): EntryPriceBucket[] {
  const ranges = [
    { label: 'Under 4¢ (tail bets)', min: 0, max: 0.04 },
    { label: '4¢ – 15¢ (high leverage)', min: 0.04, max: 0.15 },
    { label: '15¢ – 40¢ (moderate)', min: 0.15, max: 0.40 },
    { label: 'Over 40¢ (now blocked)', min: 0.40, max: 1.01 },
  ];

  return ranges.map(range => {
    const bucketBets = bets.filter(b => b.entry_price >= range.min && b.entry_price < range.max);
    const resolved = bucketBets.filter(b => b.status === 'WON' || b.status === 'LOST');
    const wins = bucketBets.filter(b => b.status === 'WON').length;
    const losses = bucketBets.filter(b => b.status === 'LOST').length;
    const openCount = bucketBets.filter(b => b.status === 'OPEN').length;

    return {
      label: range.label,
      min: range.min,
      max: range.max,
      bets: bucketBets.length,
      wins,
      losses,
      open: openCount,
      totalWagered: bucketBets.reduce((s, b) => s + b.amount_usd, 0),
      totalPnl: resolved.reduce((s, b) => s + (b.pnl || 0), 0),
      winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
    };
  });
}

function calculateCategoryStats(bets: Bet[], category: string): CategoryStats {
  const catBets = bets.filter(b => b.category === category);
  const resolved = catBets.filter(b => b.status === 'WON' || b.status === 'LOST');
  const wins = catBets.filter(b => b.status === 'WON').length;
  const losses = catBets.filter(b => b.status === 'LOST').length;
  const openCount = catBets.filter(b => b.status === 'OPEN').length;

  return {
    wins,
    losses,
    open: openCount,
    winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
    totalPnl: resolved.reduce((s, b) => s + (b.pnl || 0), 0),
    totalWagered: catBets.reduce((s, b) => s + b.amount_usd, 0),
  };
}
