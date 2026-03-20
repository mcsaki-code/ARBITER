'use client';

import { useState, useEffect, useCallback } from 'react';
import { BankrollCard } from '@/components/BankrollCard';
import { CountdownBadge } from '@/components/CountdownBadge';
import { Badge } from '@/components/Badge';
import { DataStateWrapper } from '@/components/DataState';
import { Bet, PerformanceSnapshot, DataState } from '@/lib/types';

interface TrackerApiResponse {
  bets: Bet[];
  config: Record<string, string>;
  snapshots: PerformanceSnapshot[];
  lastUpdated: string;
}

export default function TrackerPage() {
  const [data, setData] = useState<TrackerApiResponse | null>(null);
  const [state, setState] = useState<DataState>('loading');

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/bets');
      if (!res.ok) throw new Error('Failed to fetch');
      const json: TrackerApiResponse = await res.json();
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Compute stats
  const bets = data?.bets || [];
  const config = data?.config || {};
  const snapshots = data?.snapshots || [];

  const bankroll = parseFloat(config.paper_bankroll || '500');
  const totalBets = bets.length;
  const wins = bets.filter((b) => b.status === 'WON').length;
  const losses = bets.filter((b) => b.status === 'LOST').length;
  const totalPnl = bets.reduce((sum, b) => sum + (b.pnl || 0), 0);
  const winRate = wins + losses > 0 ? wins / (wins + losses) : 0;
  const roi = bankroll > 0 ? (totalPnl / 500) * 100 : 0;

  // Unlock countdown
  const startDate = config.paper_trade_start_date;
  const daysElapsed = startDate
    ? Math.floor((Date.now() - new Date(startDate).getTime()) / 86400000)
    : 0;
  const daysRemaining = Math.max(0, 30 - daysElapsed);
  const betsNeeded = Math.max(0, 50 - totalBets);
  const winRateNeeded = winRate < 0.58;

  // City breakdown
  const cityStats = new Map<string, { wins: number; losses: number; pnl: number }>();
  bets.forEach((bet) => {
    const label = bet.outcome_label?.split(' ')[0] || bet.category;
    if (!cityStats.has(label)) {
      cityStats.set(label, { wins: 0, losses: 0, pnl: 0 });
    }
    const stats = cityStats.get(label)!;
    if (bet.status === 'WON') stats.wins++;
    if (bet.status === 'LOST') stats.losses++;
    stats.pnl += bet.pnl || 0;
  });

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      <h1 className="text-xl font-semibold mb-6">Performance Tracker</h1>

      {/* Top Stats Bar */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <StatBox label="BETS" value={totalBets.toString()} />
        <StatBox
          label="W/L"
          value={`${wins}/${losses}`}
          valueColor={wins > losses ? 'text-arbiter-green' : wins < losses ? 'text-arbiter-red' : undefined}
        />
        <StatBox
          label="P&L"
          value={`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(0)}`}
          valueColor={totalPnl >= 0 ? 'text-arbiter-green' : 'text-arbiter-red'}
        />
        <StatBox
          label="ROI"
          value={`${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`}
          valueColor={roi >= 0 ? 'text-arbiter-green' : 'text-arbiter-red'}
        />
        <StatBox
          label="UNLOCK"
          value={daysRemaining > 0 ? `${daysRemaining}d` : '✓'}
          valueColor={daysRemaining > 0 ? 'text-arbiter-amber' : 'text-arbiter-green'}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column: Chart + Bet Log */}
        <div className="lg:col-span-2 space-y-6">
          {/* Bankroll Chart */}
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
            <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider mb-3">
              Bankroll Over Time
            </h3>
            {snapshots.length > 1 ? (
              <BankrollChart snapshots={snapshots} />
            ) : (
              <div className="h-40 flex items-center justify-center text-sm text-arbiter-text-3">
                Chart will appear after first day of trading
              </div>
            )}
          </div>

          {/* Bet Log */}
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-arbiter-border">
              <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider">
                Bet Log
              </h3>
            </div>
            <DataStateWrapper
              state={state}
              emptyMessage="No bets placed yet — head to Weather to find edges"
              skeletonCount={1}
            >
              {/* Desktop table */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-arbiter-text-3 uppercase tracking-wider border-b border-arbiter-border">
                      <th className="text-left px-4 py-2">Date</th>
                      <th className="text-left px-4 py-2">Market</th>
                      <th className="text-left px-4 py-2">Dir</th>
                      <th className="text-right px-4 py-2">Entry</th>
                      <th className="text-right px-4 py-2">Amount</th>
                      <th className="text-right px-4 py-2">P&L</th>
                      <th className="text-right px-4 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bets.map((bet) => (
                      <tr
                        key={bet.id}
                        className="border-b border-arbiter-border/50 hover:bg-arbiter-elevated/50"
                      >
                        <td className="px-4 py-2 font-mono text-arbiter-text-2">
                          {new Date(bet.placed_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </td>
                        <td className="px-4 py-2">
                          {bet.outcome_label || bet.category}
                        </td>
                        <td className="px-4 py-2">
                          <Badge variant={bet.direction === 'BUY_YES' ? 'green' : 'red'}>
                            {bet.direction === 'BUY_YES' ? 'YES' : 'NO'}
                          </Badge>
                        </td>
                        <td className="px-4 py-2 font-mono text-right">
                          ${bet.entry_price.toFixed(2)}
                        </td>
                        <td className="px-4 py-2 font-mono text-right">
                          ${bet.amount_usd.toFixed(0)}
                        </td>
                        <td
                          className={`px-4 py-2 font-mono text-right ${
                            (bet.pnl || 0) >= 0
                              ? 'text-arbiter-green'
                              : 'text-arbiter-red'
                          }`}
                        >
                          {bet.pnl !== null
                            ? `${bet.pnl >= 0 ? '+' : ''}$${bet.pnl.toFixed(0)}`
                            : '—'}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <Badge
                            variant={
                              bet.status === 'WON'
                                ? 'green'
                                : bet.status === 'LOST'
                                ? 'red'
                                : bet.status === 'OPEN'
                                ? 'blue'
                                : 'gray'
                            }
                          >
                            {bet.status}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile stacked cards */}
              <div className="md:hidden space-y-2 p-3">
                {bets.map((bet) => (
                  <div
                    key={bet.id}
                    className="bg-arbiter-bg rounded-lg p-3 space-y-1"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">
                        {bet.outcome_label || bet.category}
                      </span>
                      <Badge
                        variant={
                          bet.status === 'WON'
                            ? 'green'
                            : bet.status === 'LOST'
                            ? 'red'
                            : 'blue'
                        }
                      >
                        {bet.status}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-arbiter-text-3 font-mono">
                        {new Date(bet.placed_at).toLocaleDateString()}
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-arbiter-text-2">
                          ${bet.amount_usd.toFixed(0)}
                        </span>
                        {bet.pnl !== null && (
                          <span
                            className={`font-mono font-medium ${
                              bet.pnl >= 0 ? 'text-arbiter-green' : 'text-arbiter-red'
                            }`}
                          >
                            {bet.pnl >= 0 ? '+' : ''}${bet.pnl.toFixed(0)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </DataStateWrapper>
          </div>
        </div>

        {/* Right column: Bankroll + Countdown */}
        <div className="space-y-4">
          <BankrollCard
            bankroll={bankroll}
            pnl={totalPnl}
            winRate={winRate}
            totalBets={totalBets}
            wins={wins}
            losses={losses}
          />
          <CountdownBadge
            daysRemaining={daysRemaining}
            betsNeeded={betsNeeded}
            winRateNeeded={winRateNeeded}
          />

          {/* Calibration note */}
          {daysRemaining > 0 && (
            <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
              <p className="text-xs text-arbiter-text-2 leading-relaxed">
                {betsNeeded > 0
                  ? `Need ${betsNeeded} more bets`
                  : 'Bet count met'}
                {daysRemaining > 0 && betsNeeded > 0 ? ' and ' : daysRemaining > 0 ? 'Need ' : ''}
                {daysRemaining > 0 ? `${daysRemaining} more days` : ''}
                {winRateNeeded ? ` + win rate above 58%` : ''}
                {' to unlock real trading.'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Stat Box
// ============================================================
function StatBox({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3 text-center">
      <div className="text-[10px] text-arbiter-text-3 uppercase tracking-wider mb-1">
        {label}
      </div>
      <div className={`font-mono text-xl font-medium ${valueColor || 'text-arbiter-text'}`}>
        {value}
      </div>
    </div>
  );
}

// ============================================================
// Simple Bankroll Chart (SVG-based, no external dependency)
// ============================================================
function BankrollChart({ snapshots }: { snapshots: PerformanceSnapshot[] }) {
  if (snapshots.length < 2) return null;

  const values = snapshots.map((s) => s.paper_bankroll);
  const minVal = Math.min(...values) * 0.95;
  const maxVal = Math.max(...values) * 1.05;
  const range = maxVal - minVal || 1;

  const width = 600;
  const height = 160;
  const padding = { top: 10, right: 10, bottom: 20, left: 50 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const points = values.map((v, i) => {
    const x = padding.left + (i / (values.length - 1)) * chartW;
    const y = padding.top + chartH - ((v - minVal) / range) * chartH;
    return `${x},${y}`;
  });

  const linePath = `M ${points.join(' L ')}`;
  const areaPath = `${linePath} L ${padding.left + chartW},${padding.top + chartH} L ${padding.left},${padding.top + chartH} Z`;

  const lastVal = values[values.length - 1];
  const isUp = lastVal >= 500;

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
      {values.length > 0 && (
        <circle
          cx={parseFloat(points[points.length - 1].split(',')[0])}
          cy={parseFloat(points[points.length - 1].split(',')[1])}
          r="3"
          fill={isUp ? '#00d4a0' : '#ff4d6d'}
        />
      )}
    </svg>
  );
}
