'use client';

import { useState, useEffect, useCallback } from 'react';
import { BankrollCard } from '@/components/BankrollCard';
import { CountdownBadge } from '@/components/CountdownBadge';
import { Badge } from '@/components/Badge';
import { DataStateWrapper } from '@/components/DataState';
import { Bet, PerformanceSnapshot, DataState } from '@/lib/types';

/** Format a number with commas for thousands and optional decimal places */
function fmt(n: number, decimals?: number): string {
  const d = decimals !== undefined ? decimals : (Number.isInteger(n) ? 0 : 2);
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

interface TrackerApiResponse {
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

function formatPrice(price: number): string {
  const cents = price * 100;
  if (cents < 1) return `<1¢`;
  if (cents > 99) return `>99¢`;
  return `${Math.round(cents)}¢`;
}

function getBetDisplayName(bet: Bet): string {
  // Prefer market question (joined from markets table)
  if (bet.market_question) return bet.market_question;
  // Fall back to outcome_label, but not if it's just "Yes"/"No"
  if (bet.outcome_label && !['Yes', 'No', 'yes', 'no'].includes(bet.outcome_label)) {
    return bet.outcome_label;
  }
  // Fall back to category label
  return bet.category === 'weather' ? 'Weather Market' : bet.category === 'sports' ? 'Sports Market' : bet.category === 'crypto' ? 'Crypto Market' : 'Market';
}

export default function TrackerPage() {
  const [data, setData] = useState<TrackerApiResponse | null>(null);
  const [state, setState] = useState<DataState>('loading');
  const [expandedBet, setExpandedBet] = useState<string | null>(null);

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
  const pipelineSummary = data?.pipeline_summary || {
    total_exposure: 0,
    total_potential_profit: 0,
    open_count: 0,
  };

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

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      <h1 className="text-xl font-semibold mb-1">Results & Performance</h1>
      <p className="text-sm text-arbiter-text-2 mb-6">Every bet the AI has placed, and how it turned out</p>

      {/* Top Stats Bar */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <StatBox label="TOTAL BETS" value={totalBets.toString()} />
        <StatBox
          label="WINS / LOSSES"
          value={`${wins} / ${losses}`}
          valueColor={wins > losses ? 'text-arbiter-green' : wins < losses ? 'text-arbiter-red' : undefined}
        />
        <StatBox
          label="PROFIT"
          value={`${totalPnl >= 0 ? '+' : ''}$${fmt(totalPnl)}`}
          valueColor={totalPnl >= 0 ? 'text-arbiter-green' : 'text-arbiter-red'}
        />
        <StatBox
          label="RETURN"
          value={`${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`}
          valueColor={roi >= 0 ? 'text-arbiter-green' : 'text-arbiter-red'}
        />
        <StatBox
          label="REAL MONEY IN"
          value={daysRemaining > 0 ? `${daysRemaining} days` : 'Ready!'}
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
              emptyMessage="No bets yet! Hit 'Run AI Scanner' on the dashboard to start finding opportunities."
              skeletonCount={1}
            >
              {/* Desktop table */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-arbiter-text-3 uppercase tracking-wider border-b border-arbiter-border">
                      <th className="text-left px-4 py-2">Date</th>
                      <th className="text-left px-4 py-2">Market</th>
                      <th className="text-left px-4 py-2">Side</th>
                      <th className="text-right px-4 py-2">Price</th>
                      <th className="text-right px-4 py-2">Bet</th>
                      <th className="text-right px-4 py-2">Potential Payout</th>
                      <th className="text-right px-4 py-2">Profit</th>
                      <th className="text-right px-4 py-2">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bets.map((bet) => (
                      <tr
                        key={bet.id}
                        className="border-b border-arbiter-border/50 hover:bg-arbiter-elevated/50 cursor-pointer"
                        onClick={() => setExpandedBet(expandedBet === bet.id ? null : bet.id)}
                      >
                        <td className="px-4 py-2 font-mono text-arbiter-text-2">
                          {new Date(bet.placed_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </td>
                        <td className="px-4 py-2 max-w-[280px]">
                          <div className="truncate" title={getBetDisplayName(bet)}>
                            {getBetDisplayName(bet)}
                          </div>
                          {bet.outcome_label && bet.market_question && !['Yes', 'No', 'yes', 'no'].includes(bet.outcome_label) && (
                            <div className="text-[10px] text-arbiter-text-3 truncate">
                              {bet.outcome_label}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          <Badge variant={bet.direction === 'BUY_YES' ? 'green' : 'red'}>
                            {bet.direction === 'BUY_YES' ? 'YES' : 'NO'}
                          </Badge>
                        </td>
                        <td className="px-4 py-2 font-mono text-right">
                          <span>{formatPrice(bet.entry_price)}</span>
                          {bet.status === 'OPEN' && bet.current_prices && (() => {
                            const cur = bet.direction === 'BUY_YES' ? bet.current_prices![0] : bet.current_prices![1];
                            const moved = cur - bet.entry_price;
                            return cur ? (
                              <span className={`block text-[10px] ${moved > 0 ? 'text-arbiter-green' : moved < 0 ? 'text-arbiter-red' : 'text-arbiter-text-3'}`}>
                                now {formatPrice(cur)}
                              </span>
                            ) : null;
                          })()}
                        </td>
                        <td className="px-4 py-2 font-mono text-right">
                          ${fmt(bet.amount_usd, 0)}
                        </td>
                        <td className="px-4 py-2 font-mono text-right">
                          {bet.status === 'OPEN'
                            ? `$${fmt(bet.amount_usd / bet.entry_price)}`
                            : bet.status === 'WON'
                            ? `$${fmt(bet.amount_usd + (bet.pnl || 0), 0)}`
                            : '$0'}
                        </td>
                        <td
                          className={`px-4 py-2 font-mono text-right ${
                            (bet.pnl || 0) >= 0
                              ? 'text-arbiter-green'
                              : 'text-arbiter-red'
                          }`}
                        >
                          {bet.pnl !== null
                            ? `${bet.pnl >= 0 ? '+' : ''}$${fmt(bet.pnl, 0)}`
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

                {/* Expanded reasoning panel */}
                {expandedBet && (() => {
                  const bet = bets.find(b => b.id === expandedBet);
                  if (!bet) return null;
                  return (
                    <div className="bg-arbiter-bg border-t border-arbiter-border/50 px-4 py-3">
                      <div className="text-xs text-arbiter-text-3 uppercase tracking-wider mb-2">AI Reasoning</div>
                      <div className="text-xs text-arbiter-text-2 leading-relaxed mb-2">
                        {bet.reasoning || 'No reasoning recorded for this bet.'}
                      </div>
                      <div className="flex items-center gap-4 text-[10px] text-arbiter-text-3 font-mono">
                        <span>Category: {bet.category}</span>
                        <span>Direction: {bet.direction}</span>
                        <span>Entry: {formatPrice(bet.entry_price)}</span>
                        {bet.notes && <span>Notes: {bet.notes}</span>}
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* Mobile stacked cards */}
              <div className="md:hidden space-y-2 p-3">
                {bets.map((bet) => (
                  <div
                    key={bet.id}
                    className="bg-arbiter-bg rounded-lg p-3 space-y-1 cursor-pointer"
                    onClick={() => setExpandedBet(expandedBet === bet.id ? null : bet.id)}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium truncate flex-1 min-w-0">
                        {getBetDisplayName(bet)}
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
                        {new Date(bet.placed_at).toLocaleDateString()} · {bet.direction === 'BUY_YES' ? 'YES' : 'NO'} @ {formatPrice(bet.entry_price)}
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-arbiter-text-2">
                          ${fmt(bet.amount_usd, 0)}
                        </span>
                        {bet.pnl !== null && (
                          <span
                            className={`font-mono font-medium ${
                              bet.pnl >= 0 ? 'text-arbiter-green' : 'text-arbiter-red'
                            }`}
                          >
                            {bet.pnl >= 0 ? '+' : ''}${fmt(bet.pnl, 0)}
                          </span>
                        )}
                      </div>
                    </div>
                    {expandedBet === bet.id && (
                      <div className="mt-2 pt-2 border-t border-arbiter-border/50 text-xs text-arbiter-text-2">
                        <div className="font-medium text-arbiter-text-3 uppercase tracking-wider mb-1">AI Reasoning</div>
                        <div className="leading-relaxed">{bet.reasoning || 'No reasoning recorded.'}</div>
                      </div>
                    )}
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

          {/* Pipeline Summary */}
          {pipelineSummary.open_count > 0 && (
            <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
              <p className="text-xs font-medium text-arbiter-text-2 mb-3">Open Pipeline</p>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-arbiter-text-3">Total Exposure</span>
                  <span className="text-xs font-mono font-medium">${fmt(pipelineSummary.total_exposure, 0)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-arbiter-text-3">Potential Profit</span>
                  <span className={`text-xs font-mono font-medium ${pipelineSummary.total_potential_profit >= 0 ? 'text-arbiter-green' : 'text-arbiter-red'}`}>
                    {pipelineSummary.total_potential_profit >= 0 ? '+' : ''}${fmt(pipelineSummary.total_potential_profit, 0)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-arbiter-text-3">Open Bets</span>
                  <span className="text-xs font-mono font-medium">{pipelineSummary.open_count}</span>
                </div>
              </div>
            </div>
          )}

          <CountdownBadge
            daysRemaining={daysRemaining}
            betsNeeded={betsNeeded}
            winRateNeeded={winRateNeeded}
          />

          {/* Practice mode explanation */}
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-3">
            <p className="text-xs font-medium text-arbiter-text-2 mb-1">Practice Mode</p>
            <p className="text-xs text-arbiter-text-3 leading-relaxed">
              {daysRemaining > 0 || betsNeeded > 0 || winRateNeeded
                ? `The AI needs to prove itself before using real money. ${betsNeeded > 0 ? `${betsNeeded} more practice bets needed. ` : ''}${daysRemaining > 0 ? `${daysRemaining} days left in the trial period. ` : ''}${winRateNeeded ? 'Win rate needs to reach 58%. ' : ''}Once all three milestones are hit, real trading unlocks automatically.`
                : 'All milestones complete! The AI has proven itself and is ready for real money trading.'}
            </p>
          </div>
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
