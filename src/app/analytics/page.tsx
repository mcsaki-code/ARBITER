'use client';

import { useState, useEffect, useCallback } from 'react';
import { Bet, PerformanceSnapshot, DataState } from '@/lib/types';
import { DataStateWrapper } from '@/components/DataState';
import { Badge } from '@/components/Badge';

interface AnalyticsApiResponse {
  bets: Bet[];
  config: Record<string, string>;
  snapshots: PerformanceSnapshot[];
  lastUpdated: string;
}

function formatPrice(price: number): string {
  const cents = price * 100;
  if (cents < 1) return `<1c`;
  if (cents > 99) return `>99c`;
  return `${Math.round(cents)}c`;
}

function getBetDisplayName(bet: Bet): string {
  if (bet.market_question) return bet.market_question;
  if (bet.outcome_label && !['Yes', 'No', 'yes', 'no'].includes(bet.outcome_label)) {
    return bet.outcome_label;
  }
  return bet.category === 'weather' ? 'Weather Market' : bet.category === 'sports' ? 'Sports Market' : bet.category === 'crypto' ? 'Crypto Market' : 'Market';
}

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsApiResponse | null>(null);
  const [state, setState] = useState<DataState>('loading');

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/bets');
      if (!res.ok) throw new Error('Failed to fetch');
      const json: AnalyticsApiResponse = await res.json();
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
  const bankroll = parseFloat(config.paper_bankroll || '500');

  // Core metrics
  const resolved = bets.filter(b => b.status === 'WON' || b.status === 'LOST');
  const open = bets.filter(b => b.status === 'OPEN');
  const wins = bets.filter(b => b.status === 'WON').length;
  const losses = bets.filter(b => b.status === 'LOST').length;
  const totalPnl = resolved.reduce((sum, b) => sum + (b.pnl || 0), 0);
  const winRate = wins + losses > 0 ? wins / (wins + losses) : 0;
  const roi = bankroll > 0 ? (totalPnl / 500) * 100 : 0;

  // Average edge at entry
  const avgEdge = bets.length > 0
    ? bets.reduce((sum, b) => {
        // Extract edge from reasoning or estimate from entry price
        // For now, we'll estimate edge as (1 - entry_price) for YES bets, entry_price for NO bets
        // This represents the initial probability mismatch
        const edge = b.direction === 'BUY_YES' ? (1 - b.entry_price) : b.entry_price;
        return sum + Math.abs(edge);
      }, 0) / bets.length
    : 0;

  // Sharpe-like ratio (return per unit of volatility)
  const returns = resolved.map(b => b.pnl || 0);
  const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 1
    ? returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1)
    : 0;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? avgReturn / stdDev : 0;

  // Open bet pipeline (potential profit)
  const openPotentialProfit = open.reduce((sum, b) => {
    const potentialPayout = b.amount_usd / b.entry_price;
    const potentialProfit = potentialPayout - b.amount_usd;
    return sum + potentialProfit;
  }, 0);

  // Stats by category
  const categoryStats = {
    weather: calculateCategoryStats(bets, 'weather'),
    sports: calculateCategoryStats(bets, 'sports'),
    crypto: calculateCategoryStats(bets, 'crypto'),
  };

  // Edge buckets analysis
  const edgeBuckets = analyzeEdgeBuckets(resolved);

  // Bet size distribution
  const betSizes = bets.map(b => b.amount_usd);
  const avgBetSize = betSizes.length > 0 ? betSizes.reduce((a, b) => a + b, 0) / betSizes.length : 0;
  const maxBetSize = Math.max(...betSizes, 0);
  const largestWin = resolved.filter(b => b.status === 'WON').reduce((max, b) => Math.max(max, b.pnl || 0), 0);
  const largestLoss = resolved.filter(b => b.status === 'LOST').reduce((min, b) => Math.min(min, b.pnl || 0), 0);

  // Recent bets (last 20 resolved)
  const recentBets = resolved.slice(-20).reverse();

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      {/* Header */}
      <h1 className="text-xl font-semibold mb-1">Performance Analytics</h1>
      <p className="text-sm text-arbiter-text-2 mb-6">Deep dive into strategy performance, edge calibration, and bet outcomes</p>

      {/* Summary Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <StatCard
          label="TOTAL P&L"
          value={`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`}
          color={totalPnl >= 0 ? 'arbiter-green' : 'arbiter-red'}
        />
        <StatCard
          label="ROI"
          value={`${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`}
          color={roi >= 0 ? 'arbiter-green' : 'arbiter-red'}
        />
        <StatCard
          label="WIN RATE"
          value={`${(winRate * 100).toFixed(1)}%`}
          color={winRate >= 0.55 ? 'arbiter-green' : winRate >= 0.50 ? 'arbiter-amber' : 'arbiter-red'}
        />
        <StatCard
          label="AVG EDGE"
          value={`${(avgEdge * 100).toFixed(1)}%`}
          color="arbiter-blue"
        />
        <StatCard
          label="SHARPE RATIO"
          value={sharpe.toFixed(2)}
          color={sharpe > 0 ? 'arbiter-green' : sharpe < 0 ? 'arbiter-red' : 'arbiter-text'}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column */}
        <div className="lg:col-span-2 space-y-6">
          {/* P&L Over Time Chart */}
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
            <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider mb-3">
              CUMULATIVE P&L
            </h3>
            {resolved.length > 0 ? (
              <PnlChart bets={resolved} />
            ) : (
              <div className="h-40 flex items-center justify-center text-sm text-arbiter-text-3">
                P&L chart will appear after first resolved bet
              </div>
            )}
          </div>

          {/* Win Rate by Category */}
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
            <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider mb-4">
              WIN RATE BY CATEGORY
            </h3>
            <div className="space-y-4">
              {Object.entries(categoryStats).map(([cat, stats]) => (
                <CategoryBar key={cat} category={cat} stats={stats} />
              ))}
            </div>
          </div>

          {/* Edge Accuracy Analysis */}
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
            <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider mb-4">
              EDGE ACCURACY ANALYSIS
            </h3>
            <p className="text-xs text-arbiter-text-3 mb-4">
              Win rate by entry edge bucket. High-edge bets should have higher win rates.
            </p>
            <div className="space-y-3">
              {edgeBuckets.map((bucket, i) => (
                <EdgeBucketBar key={i} bucket={bucket} />
              ))}
            </div>
          </div>

          {/* Bet Size Distribution */}
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
            <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider mb-4">
              BET SIZE DISTRIBUTION
            </h3>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-arbiter-text-3">Average Bet Size</span>
                <span className="font-data text-arbiter-text">${avgBetSize.toFixed(0)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-arbiter-text-3">Max Bet Size</span>
                <span className="font-data text-arbiter-text">${maxBetSize.toFixed(0)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-arbiter-text-3">Largest Win</span>
                <span className="font-data text-arbiter-green">{largestWin > 0 ? '+' : ''}${largestWin.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-arbiter-text-3">Largest Loss</span>
                <span className="font-data text-arbiter-red">${largestLoss.toFixed(2)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right column */}
        <div className="space-y-4">
          {/* Summary boxes */}
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4 space-y-3">
            <div>
              <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider">Total Bets</div>
              <div className="text-2xl font-data font-semibold text-arbiter-text mt-1">{bets.length}</div>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider">Resolved</div>
                <div className="text-xl font-data text-arbiter-text">{resolved.length}</div>
              </div>
              <div className="flex-1">
                <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider">Open</div>
                <div className="text-xl font-data text-arbiter-text">{open.length}</div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider">Wins</div>
                <div className="text-xl font-data text-arbiter-green">{wins}</div>
              </div>
              <div className="flex-1">
                <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider">Losses</div>
                <div className="text-xl font-data text-arbiter-red">{losses}</div>
              </div>
            </div>
          </div>

          {/* Open Pipeline */}
          <div className="bg-arbiter-elevated border border-arbiter-border rounded-lg p-4">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-2">
              OPEN BET PIPELINE
            </div>
            <div className="text-2xl font-data font-semibold text-arbiter-blue">
              {openPotentialProfit >= 0 ? '+' : ''}${openPotentialProfit.toFixed(2)}
            </div>
            <p className="text-[10px] text-arbiter-text-3 mt-2">
              Potential profit from {open.length} open bets if all win
            </p>
          </div>

          {/* Starting Bankroll */}
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
            <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-2">
              Starting Bankroll
            </div>
            <div className="text-lg font-data text-arbiter-text">${bankroll.toFixed(0)}</div>
            <div className="text-[10px] text-arbiter-text-3 mt-2">
              Current Value: ${(bankroll + totalPnl).toFixed(0)}
            </div>
          </div>
        </div>
      </div>

      {/* Recent Bet Performance Table */}
      <div className="bg-arbiter-card border border-arbiter-border rounded-lg overflow-hidden mt-6">
        <div className="px-4 py-3 border-b border-arbiter-border">
          <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider">
            RECENT BET PERFORMANCE (Last 20 Resolved)
          </h3>
        </div>
        <DataStateWrapper
          state={state}
          emptyMessage="No resolved bets yet. Bets will appear here once they resolve."
          skeletonCount={1}
        >
          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-arbiter-text-3 uppercase tracking-wider border-b border-arbiter-border">
                  <th className="text-left px-4 py-2">Date</th>
                  <th className="text-left px-4 py-2">Market</th>
                  <th className="text-center px-4 py-2">Side</th>
                  <th className="text-right px-4 py-2">Entry Price</th>
                  <th className="text-right px-4 py-2">Amount</th>
                  <th className="text-right px-4 py-2">Payout</th>
                  <th className="text-right px-4 py-2">P&L</th>
                  <th className="text-center px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {recentBets.map((bet) => {
                  const payout = bet.pnl !== null ? bet.amount_usd + bet.pnl : null;
                  return (
                    <tr
                      key={bet.id}
                      className="border-b border-arbiter-border/50 hover:bg-arbiter-elevated/50"
                    >
                      <td className="px-4 py-2 font-data text-arbiter-text-2">
                        {new Date(bet.placed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </td>
                      <td className="px-4 py-2 max-w-[280px]">
                        <div className="truncate text-arbiter-text" title={getBetDisplayName(bet)}>
                          {getBetDisplayName(bet)}
                        </div>
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
                        ${bet.amount_usd.toFixed(0)}
                      </td>
                      <td className="px-4 py-2 font-data text-right text-arbiter-text-2">
                        {payout !== null ? `$${payout.toFixed(0)}` : '—'}
                      </td>
                      <td
                        className={`px-4 py-2 font-data text-right ${
                          (bet.pnl || 0) >= 0 ? 'text-arbiter-green' : 'text-arbiter-red'
                        }`}
                      >
                        {bet.pnl !== null ? `${bet.pnl >= 0 ? '+' : ''}$${bet.pnl.toFixed(0)}` : '—'}
                      </td>
                      <td className="px-4 py-2 text-center">
                        <Badge
                          variant={
                            bet.status === 'WON'
                              ? 'green'
                              : bet.status === 'LOST'
                              ? 'red'
                              : 'gray'
                          }
                        >
                          {bet.status}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile stacked cards */}
          <div className="md:hidden space-y-2 p-3">
            {recentBets.map((bet) => {
              const payout = bet.pnl !== null ? bet.amount_usd + bet.pnl : null;
              return (
                <div
                  key={bet.id}
                  className="bg-arbiter-bg rounded-lg p-3 space-y-1"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium truncate max-w-[200px]">
                      {getBetDisplayName(bet)}
                    </span>
                    <Badge
                      variant={
                        bet.status === 'WON'
                          ? 'green'
                          : bet.status === 'LOST'
                          ? 'red'
                          : 'gray'
                      }
                    >
                      {bet.status}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between text-xs font-data">
                    <span className="text-arbiter-text-3">
                      {new Date(bet.placed_at).toLocaleDateString()} · {bet.direction === 'BUY_YES' ? 'YES' : 'NO'} @ {formatPrice(bet.entry_price)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs font-data">
                    <span className="text-arbiter-text-2">${bet.amount_usd.toFixed(0)}</span>
                    {payout !== null && (
                      <span className="text-arbiter-text-2">{payout.toFixed(0)}</span>
                    )}
                    {bet.pnl !== null && (
                      <span className={bet.pnl >= 0 ? 'text-arbiter-green' : 'text-arbiter-red'}>
                        {bet.pnl >= 0 ? '+' : ''}${bet.pnl.toFixed(0)}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </DataStateWrapper>
      </div>
    </div>
  );
}

// ============================================================
// Helper Components
// ============================================================

const COLOR_CLASSES: Record<string, string> = {
  'arbiter-green': 'text-arbiter-green',
  'arbiter-red': 'text-arbiter-red',
  'arbiter-amber': 'text-arbiter-amber',
  'arbiter-blue': 'text-arbiter-blue',
  'arbiter-text': 'text-arbiter-text',
};

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  const colorClass = COLOR_CLASSES[color] || 'text-arbiter-text';
  return (
    <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3 text-center">
      <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">
        {label}
      </div>
      <div className={`font-data text-xl font-semibold ${colorClass}`}>
        {value}
      </div>
    </div>
  );
}

function CategoryBar({
  category,
  stats,
}: {
  category: string;
  stats: { wins: number; losses: number; open: number; winRate: number; avgEdge: number };
}) {
  const total = stats.wins + stats.losses;
  const winPct = total > 0 ? (stats.wins / total) * 100 : 0;
  const displayCat = category.charAt(0).toUpperCase() + category.slice(1);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-xs font-medium text-arbiter-text">{displayCat}</div>
          <div className="text-[10px] text-arbiter-text-3">
            {stats.wins}W / {stats.losses}L / {stats.open}O
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs font-data font-semibold text-arbiter-text">
            {(stats.winRate * 100).toFixed(1)}%
          </div>
          <div className="text-[10px] text-arbiter-text-3">
            {(stats.avgEdge * 100).toFixed(1)}% avg edge
          </div>
        </div>
      </div>
      <div className="w-full bg-arbiter-bg rounded h-2 overflow-hidden">
        <div
          className="h-full bg-arbiter-green"
          style={{ width: `${Math.min(winPct, 100)}%` }}
        />
      </div>
    </div>
  );
}

function EdgeBucketBar({
  bucket,
}: {
  bucket: { min: number; max: number; winRate: number; count: number };
}) {
  const label = `${(bucket.min * 100).toFixed(0)}-${(bucket.max * 100).toFixed(0)}%`;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-arbiter-text-2">Edge: {label}</span>
        <span className="text-xs font-data text-arbiter-text">
          {(bucket.winRate * 100).toFixed(1)}% ({bucket.count} bets)
        </span>
      </div>
      <div className="w-full bg-arbiter-bg rounded h-2 overflow-hidden">
        <div
          className="h-full bg-arbiter-blue"
          style={{
            width: `${Math.min(bucket.winRate * 100, 100)}%`,
            opacity: Math.min(0.5 + bucket.count / 10, 1),
          }}
        />
      </div>
    </div>
  );
}

// ============================================================
// SVG Charts
// ============================================================

function PnlChart({ bets }: { bets: Bet[] }) {
  // Sort by resolved_at
  const sorted = [...bets].sort((a, b) => {
    const dateA = new Date(a.resolved_at || '').getTime();
    const dateB = new Date(b.resolved_at || '').getTime();
    return dateA - dateB;
  });

  // Calculate cumulative P&L
  let cumulative = 0;
  const points = sorted.map(bet => {
    cumulative += bet.pnl || 0;
    return {
      date: bet.resolved_at || '',
      pnl: cumulative,
    };
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
      {/* Grid lines */}
      {[0, 0.25, 0.5, 0.75, 1].map((pct) => {
        const y = padding.top + chartH * (1 - pct);
        const val = minVal + range * pct;
        return (
          <g key={pct}>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={y}
              y2={y}
              stroke="#2a2a38"
              strokeWidth="1"
            />
            <text
              x={padding.left - 5}
              y={y + 3}
              fill="#555570"
              fontSize="9"
              textAnchor="end"
              fontFamily="JetBrains Mono, monospace"
            >
              ${Math.round(val)}
            </text>
          </g>
        );
      })}

      {/* Area fill */}
      <path
        d={areaPath}
        fill={isUp ? 'rgba(0, 212, 160, 0.1)' : 'rgba(255, 77, 109, 0.1)'}
      />

      {/* Line */}
      <path
        d={linePath}
        fill="none"
        stroke={isUp ? '#00d4a0' : '#ff4d6d'}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* End dot */}
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

// ============================================================
// Data Analysis Helpers
// ============================================================

interface CategoryStats {
  wins: number;
  losses: number;
  open: number;
  winRate: number;
  avgEdge: number;
}

function calculateCategoryStats(bets: Bet[], category: string): CategoryStats {
  const categoryBets = bets.filter(b => b.category === category);
  const resolved = categoryBets.filter(b => b.status === 'WON' || b.status === 'LOST');
  const open = categoryBets.filter(b => b.status === 'OPEN');
  const wins = categoryBets.filter(b => b.status === 'WON').length;
  const losses = categoryBets.filter(b => b.status === 'LOST').length;
  const winRate = wins + losses > 0 ? wins / (wins + losses) : 0;

  const avgEdge = categoryBets.length > 0
    ? categoryBets.reduce((sum, b) => {
        const edge = b.direction === 'BUY_YES' ? (1 - b.entry_price) : b.entry_price;
        return sum + Math.abs(edge);
      }, 0) / categoryBets.length
    : 0;

  return { wins, losses, open: open.length, winRate, avgEdge };
}

interface EdgeBucket {
  min: number;
  max: number;
  winRate: number;
  count: number;
}

function analyzeEdgeBuckets(bets: Bet[]): EdgeBucket[] {
  const bucketRanges = [
    { min: 0, max: 0.05 },
    { min: 0.05, max: 0.1 },
    { min: 0.1, max: 0.15 },
    { min: 0.15, max: 1 },
  ];

  return bucketRanges.map(range => {
    const bucketBets = bets.filter(b => {
      const edge = b.direction === 'BUY_YES' ? (1 - b.entry_price) : b.entry_price;
      const absEdge = Math.abs(edge);
      return absEdge >= range.min && absEdge < range.max;
    });

    const wins = bucketBets.filter(b => b.status === 'WON').length;
    const total = bucketBets.length;
    const winRate = total > 0 ? wins / total : 0;

    return {
      min: range.min,
      max: range.max,
      winRate,
      count: total,
    };
  });
}
