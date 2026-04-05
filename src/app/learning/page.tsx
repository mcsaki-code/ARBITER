'use client';

import { useState, useEffect, useCallback } from 'react';
import { DataState } from '@/lib/types';
import { DataStateWrapper } from '@/components/DataState';
import { Badge } from '@/components/Badge';

// ============================================================
// Types
// ============================================================

interface DirectionStats {
  wins: number;
  losses: number;
  pnl: number;
}

interface PriceBucket {
  bucket: string;
  count: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  roi: number;
}

interface TimingBucket {
  bucket: string;
  count: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
}

interface Calibration {
  city: string;
  multiplier: number;
  updated_at: string;
}

interface Insight {
  category: string;
  dimension: string;
  key: string;
  sample_size: number;
  win_rate: number;
  avg_pnl: number;
  total_pnl: number;
  recommendation: string;
  action_taken: string | null;
}

interface RecentBet {
  direction: string;
  status: string;
  pnl: number;
  entry_price: number;
  confidence: string;
  placed_at: string;
  amount_usd: number;
  question: string;
}

interface SigmaCity {
  multiplier: number;
  win_rate: number;
  n: number;
}

interface KellyBoosts {
  high_high: number;
  medium_high: number;
  low_high: number;
}

interface LearningData {
  insights: { generated_at: string; total_insights: number; insights: Insight[] } | null;
  summary: {
    updated_at: string;
    total_resolved: number;
    win_rate: number;
    total_pnl: number;
    lessons_learned: number;
    key_findings: string[];
  } | null;
  calibrations: Calibration[];
  lastLearningRun: string | null;
  // V2 expert fields
  sigmaAccuracy: Record<string, SigmaCity> | null;
  forecastNextCycle: string[] | null;
  sigmaAdjustments: string[] | null;
  kellyBoosts: KellyBoosts;
  liveStats: {
    totalResolved: number;
    totalOpen: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    totalWagered: number;
  };
  directionBreakdown: Record<string, DirectionStats>;
  confBreakdown: Record<string, DirectionStats>;
  priceAnalysis: PriceBucket[];
  timingAnalysis: TimingBucket[];
  recentBets: RecentBet[];
  lastUpdated: string;
}

// ============================================================
// Helpers
// ============================================================

function fmt(n: number, decimals?: number): string {
  const d = decimals !== undefined ? decimals : (Number.isInteger(n) ? 0 : 2);
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function winRateColor(rate: number): string {
  if (rate >= 0.7) return 'text-arbiter-green';
  if (rate >= 0.5) return 'text-arbiter-amber';
  return 'text-arbiter-red';
}

function pnlColor(pnl: number): string {
  if (pnl > 0) return 'text-arbiter-green';
  if (pnl < 0) return 'text-arbiter-red';
  return 'text-arbiter-text-2';
}

function multiplierColor(mult: number): string {
  if (mult >= 1.1) return 'text-arbiter-green';
  if (mult <= 0.7) return 'text-arbiter-red';
  if (mult <= 0.9) return 'text-arbiter-amber';
  return 'text-arbiter-text';
}

// ============================================================
// Components
// ============================================================

function StatCard({ label, value, sub, color }: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
      <div className="text-xs text-arbiter-text-3 uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-2xl font-semibold font-mono ${color || 'text-arbiter-text'}`}>{value}</div>
      {sub && <div className="text-xs text-arbiter-text-3 mt-1">{sub}</div>}
    </div>
  );
}

function BarChart({ items, maxVal }: {
  items: { label: string; value: number; color: string; sub?: string }[];
  maxVal: number;
}) {
  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={item.label}>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-arbiter-text-2">{item.label}</span>
            <span className={item.color}>{item.sub || ''}</span>
          </div>
          <div className="h-2 bg-arbiter-elevated rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                item.color === 'text-arbiter-green' ? 'bg-arbiter-green/70' :
                item.color === 'text-arbiter-red' ? 'bg-arbiter-red/70' :
                item.color === 'text-arbiter-amber' ? 'bg-arbiter-amber/70' :
                'bg-arbiter-blue/70'
              }`}
              style={{ width: `${maxVal > 0 ? Math.max(3, (item.value / maxVal) * 100) : 0}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function InsightRow({ insight }: { insight: Insight }) {
  const badge = insight.action_taken ? 'amber' :
    insight.win_rate >= 0.7 ? 'green' :
    insight.win_rate < 0.3 ? 'red' : 'gray';

  return (
    <div className="flex items-start gap-3 py-3 border-b border-arbiter-border/50 last:border-0">
      <Badge variant={badge as 'amber' | 'green' | 'red' | 'gray'}>
        {insight.category.toUpperCase()}
      </Badge>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-arbiter-text">{insight.key}</div>
        <div className="text-xs text-arbiter-text-2 mt-0.5">{insight.recommendation}</div>
        {insight.action_taken && (
          <div className="text-xs text-arbiter-amber mt-1 flex items-center gap-1">
            <span className="w-1.5 h-1.5 bg-arbiter-amber rounded-full" />
            {insight.action_taken}
          </div>
        )}
      </div>
      <div className="text-right shrink-0">
        <div className={`text-sm font-mono ${winRateColor(insight.win_rate)}`}>{pct(insight.win_rate)}</div>
        <div className="text-xs text-arbiter-text-3">n={insight.sample_size}</div>
      </div>
    </div>
  );
}

function KellyBoostCard({ label, value, conf, agree }: {
  label: string; value: number; conf: string; agree: string;
}) {
  const color = value >= 1.2 ? 'text-arbiter-green' : value <= 0.9 ? 'text-arbiter-red' : 'text-arbiter-amber';
  const barColor = value >= 1.2 ? 'bg-arbiter-green/70' : value <= 0.9 ? 'bg-arbiter-red/70' : 'bg-arbiter-amber/70';
  return (
    <div className="bg-arbiter-elevated border border-arbiter-border/50 rounded-md p-3">
      <div className="flex items-center justify-between mb-1.5">
        <div>
          <span className="text-xs font-medium text-arbiter-text">{label}</span>
          <div className="text-[10px] text-arbiter-text-3">{conf} conf × {agree} agree</div>
        </div>
        <span className={`text-lg font-mono font-semibold ${color}`}>{value.toFixed(2)}x</span>
      </div>
      <div className="h-1.5 bg-arbiter-card rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${Math.min(100, (value / 1.4) * 100)}%` }} />
      </div>
    </div>
  );
}

// ============================================================
// Main Page
// ============================================================

export default function LearningPage() {
  const [data, setData] = useState<LearningData | null>(null);
  const [state, setState] = useState<DataState>('loading');
  const [tab, setTab] = useState<'overview' | 'insights' | 'calibration' | 'forecast'>('overview');

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/learning');
      if (!res.ok) throw new Error('Failed to fetch');
      const json: LearningData = await res.json();
      setData(json);
      setState('fresh');
    } catch {
      setState(data ? 'stale' : 'error');
    }
  }, [data]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tabs = [
    { id: 'overview' as const, label: 'Overview' },
    { id: 'insights' as const, label: 'Insights' },
    { id: 'calibration' as const, label: 'Calibration' },
    { id: 'forecast' as const, label: 'Forecast' },
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      {/* Header */}
      <div className="flex items-start justify-between mb-1">
        <div>
          <h1 className="text-xl font-semibold">Learning Agent</h1>
          <p className="text-sm text-arbiter-text-2">
            Self-improving analysis of what works and what doesn&apos;t
          </p>
        </div>
        {data?.lastLearningRun && (
          <div className="text-xs text-arbiter-text-3 text-right">
            <div>Last run</div>
            <div className="text-arbiter-text-2">{timeAgo(data.lastLearningRun)}</div>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mt-4 mb-6 border-b border-arbiter-border">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t.id
                ? 'text-arbiter-amber border-arbiter-amber'
                : 'text-arbiter-text-3 border-transparent hover:text-arbiter-text-2'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <DataStateWrapper state={state} skeletonCount={6}>
        {data && tab === 'overview' && <OverviewTab data={data} />}
        {data && tab === 'insights' && <InsightsTab data={data} />}
        {data && tab === 'calibration' && <CalibrationTab data={data} />}
        {data && tab === 'forecast' && <ForecastTab data={data} />}
      </DataStateWrapper>
    </div>
  );
}

// ============================================================
// Overview Tab
// ============================================================

function OverviewTab({ data }: { data: LearningData }) {
  const { liveStats, directionBreakdown, confBreakdown, priceAnalysis, timingAnalysis } = data;

  return (
    <div className="space-y-6">
      {/* Top stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label="Win Rate"
          value={pct(liveStats.winRate)}
          sub={`${liveStats.wins}W / ${liveStats.losses}L`}
          color={winRateColor(liveStats.winRate)}
        />
        <StatCard
          label="Total P&L"
          value={`$${fmt(liveStats.totalPnl)}`}
          sub={`$${fmt(liveStats.totalWagered)} wagered`}
          color={pnlColor(liveStats.totalPnl)}
        />
        <StatCard
          label="Resolved"
          value={`${liveStats.totalResolved}`}
          sub={`${liveStats.totalOpen} open`}
        />
        <StatCard
          label="Lessons Applied"
          value={`${data.summary?.lessons_learned || 0}`}
          sub={data.lastLearningRun ? timeAgo(data.lastLearningRun) : 'Not yet run'}
          color="text-arbiter-amber"
        />
      </div>

      {/* Kelly Boosts — V2 */}
      {(data.kellyBoosts.high_high !== 1.0 || data.kellyBoosts.medium_high !== 1.0) && (
        <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
          <h3 className="text-sm font-medium text-arbiter-text mb-1 flex items-center gap-2">
            <span className="w-2 h-2 bg-arbiter-amber rounded-full" />
            Kelly Size Multipliers
          </h3>
          <p className="text-xs text-arbiter-text-3 mb-3">
            Learned from confidence × model agreement interactions. 1.0x = baseline Kelly.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <KellyBoostCard label="Strong Signal" value={data.kellyBoosts.high_high} conf="HIGH" agree="HIGH" />
            <KellyBoostCard label="Confident" value={data.kellyBoosts.medium_high} conf="MEDIUM" agree="HIGH" />
            <KellyBoostCard label="Uncertain" value={data.kellyBoosts.low_high} conf="LOW" agree="HIGH" />
          </div>
        </div>
      )}

      {/* Key Findings from last learning run */}
      {data.summary?.key_findings && data.summary.key_findings.length > 0 && (
        <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
          <h3 className="text-sm font-medium text-arbiter-text mb-3 flex items-center gap-2">
            <span className="w-2 h-2 bg-arbiter-amber rounded-full" />
            Key Findings
          </h3>
          <div className="space-y-2">
            {data.summary.key_findings.map((finding, i) => (
              <div key={i} className="text-sm text-arbiter-text-2 pl-4 border-l-2 border-arbiter-border">
                {finding}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Direction & Confidence side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Direction Performance */}
        <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
          <h3 className="text-sm font-medium text-arbiter-text mb-3">Direction Performance</h3>
          {Object.keys(directionBreakdown).length === 0 ? (
            <div className="text-sm text-arbiter-text-3">No resolved bets yet</div>
          ) : (
            <div className="space-y-3">
              {Object.entries(directionBreakdown).map(([dir, stats]) => {
                const total = stats.wins + stats.losses;
                const wr = total > 0 ? stats.wins / total : 0;
                return (
                  <div key={dir} className="flex items-center justify-between">
                    <div>
                      <span className="text-sm text-arbiter-text font-mono">{dir}</span>
                      <span className="text-xs text-arbiter-text-3 ml-2">{stats.wins}W/{stats.losses}L</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`text-sm font-mono ${winRateColor(wr)}`}>{pct(wr)}</span>
                      <span className={`text-xs font-mono ${pnlColor(stats.pnl)}`}>${fmt(stats.pnl)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-3 pt-3 border-t border-arbiter-border/50 text-xs text-arbiter-text-3">
            BUY_NO is currently blocked (0% historical win rate)
          </div>
        </div>

        {/* Confidence Calibration */}
        <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
          <h3 className="text-sm font-medium text-arbiter-text mb-3">Confidence Calibration</h3>
          {Object.keys(confBreakdown).length === 0 ? (
            <div className="text-sm text-arbiter-text-3">No resolved bets yet</div>
          ) : (
            <div className="space-y-3">
              {Object.entries(confBreakdown).map(([conf, stats]) => {
                const total = stats.wins + stats.losses;
                const wr = total > 0 ? stats.wins / total : 0;
                return (
                  <div key={conf} className="flex items-center justify-between">
                    <div>
                      <Badge variant={conf === 'HIGH' ? 'green' : conf === 'LOW' ? 'red' : 'gray'}>
                        {conf}
                      </Badge>
                      <span className="text-xs text-arbiter-text-3 ml-2">{stats.wins}W/{stats.losses}L</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`text-sm font-mono ${winRateColor(wr)}`}>{pct(wr)}</span>
                      <span className={`text-xs font-mono ${pnlColor(stats.pnl)}`}>${fmt(stats.pnl)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-3 pt-3 border-t border-arbiter-border/50 text-xs text-arbiter-text-3">
            Ideal: HIGH &gt; 70%, MEDIUM ~55%, LOW &lt; 40%
          </div>
        </div>
      </div>

      {/* Entry Price & Timing side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Entry Price Analysis */}
        <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
          <h3 className="text-sm font-medium text-arbiter-text mb-3">Entry Price Sweet Spots</h3>
          {priceAnalysis.length === 0 ? (
            <div className="text-sm text-arbiter-text-3">No data yet</div>
          ) : (
            <BarChart
              items={priceAnalysis.map((b) => ({
                label: `${b.bucket} (n=${b.count})`,
                value: b.winRate,
                color: winRateColor(b.winRate),
                sub: `${pct(b.winRate)} WR  $${fmt(b.totalPnl)} P&L`,
              }))}
              maxVal={1}
            />
          )}
        </div>

        {/* Timing Analysis */}
        <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
          <h3 className="text-sm font-medium text-arbiter-text mb-3">Timing (Hours to Resolution)</h3>
          {timingAnalysis.length === 0 ? (
            <div className="text-sm text-arbiter-text-3">No data yet</div>
          ) : (
            <BarChart
              items={timingAnalysis.map((b) => ({
                label: `${b.bucket} (n=${b.count})`,
                value: b.winRate,
                color: winRateColor(b.winRate),
                sub: `${pct(b.winRate)} WR  $${fmt(b.totalPnl)} P&L`,
              }))}
              maxVal={1}
            />
          )}
        </div>
      </div>

      {/* Recent Bets Feed */}
      {data.recentBets.length > 0 && (
        <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
          <h3 className="text-sm font-medium text-arbiter-text mb-3">Recent Resolved Bets</h3>
          <div className="space-y-0">
            {data.recentBets.map((bet, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-arbiter-border/30 last:border-0">
                <div className="flex items-center gap-2 min-w-0">
                  <Badge variant={bet.status === 'WON' ? 'green' : 'red'}>
                    {bet.status}
                  </Badge>
                  <span className="text-sm text-arbiter-text-2 truncate">{bet.question}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0 ml-2">
                  <span className="text-xs text-arbiter-text-3 font-mono">{bet.direction}</span>
                  <span className={`text-sm font-mono ${pnlColor(bet.pnl)}`}>
                    {bet.pnl >= 0 ? '+' : ''}${fmt(bet.pnl)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Insights Tab
// ============================================================

function InsightsTab({ data }: { data: LearningData }) {
  const insights = data.insights?.insights || [];
  const categories = [
    'direction', 'city', 'implied_multiplier', 'confidence',
    'confidence_agreement', 'brier_score', 'sigma_accuracy', 'entry_price', 'timing',
  ];

  if (insights.length === 0) {
    return (
      <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-8 text-center">
        <div className="text-arbiter-text-2 text-sm mb-2">No learning insights yet</div>
        <div className="text-arbiter-text-3 text-xs">
          The learning agent runs daily at 6 AM UTC. Once enough bets resolve,
          insights will appear here with actionable recommendations.
        </div>
        {data.lastLearningRun && (
          <div className="text-arbiter-text-3 text-xs mt-3">
            Last run: {new Date(data.lastLearningRun).toLocaleString()}
          </div>
        )}
      </div>
    );
  }

  // Group insights into actions taken vs monitoring
  const actioned = insights.filter((i) => i.action_taken);
  const monitoring = insights.filter((i) => !i.action_taken);

  return (
    <div className="space-y-6">
      {/* Actions Taken */}
      {actioned.length > 0 && (
        <div className="bg-arbiter-card border border-arbiter-amber/30 rounded-lg p-4">
          <h3 className="text-sm font-medium text-arbiter-amber mb-2 flex items-center gap-2">
            <span className="w-2 h-2 bg-arbiter-amber rounded-full" />
            Actions Taken ({actioned.length})
          </h3>
          <p className="text-xs text-arbiter-text-3 mb-3">
            Parameters automatically adjusted by the learning agent
          </p>
          {actioned.map((insight, i) => (
            <InsightRow key={i} insight={insight} />
          ))}
        </div>
      )}

      {/* Grouped insights by category */}
      {categories.map((cat) => {
        const catInsights = monitoring.filter((i) => i.category === cat);
        if (catInsights.length === 0) return null;
        return (
          <div key={cat} className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
            <h3 className="text-sm font-medium text-arbiter-text mb-2 capitalize">
              {cat.replace('_', ' ')} Analysis
            </h3>
            {catInsights.map((insight, i) => (
              <InsightRow key={i} insight={insight} />
            ))}
          </div>
        );
      })}

      {/* Metadata */}
      {data.insights?.generated_at && (
        <div className="text-center text-xs text-arbiter-text-3">
          {insights.length} insights generated at{' '}
          {new Date(data.insights.generated_at).toLocaleString()}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Calibration Tab
// ============================================================

function CalibrationTab({ data }: { data: LearningData }) {
  const { calibrations } = data;

  // Static tier definitions for reference
  const staticTiers = [
    { tier: 'Tier 1', mult: '1.0x', desc: 'Best calibrated cities' },
    { tier: 'Tier 2', mult: '0.9x', desc: 'Good but slightly noisy' },
    { tier: 'Tier 3', mult: '0.75x', desc: 'Higher bias or variance' },
    { tier: 'Tier 4', mult: '0.5x', desc: 'Poor calibration — extreme caution' },
  ];

  return (
    <div className="space-y-6">
      {/* How it works */}
      <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
        <h3 className="text-sm font-medium text-arbiter-text mb-2">How Calibration Works</h3>
        <div className="text-xs text-arbiter-text-2 space-y-2">
          <p>
            The learning agent adjusts per-city edge multipliers based on actual win rates.
            Cities that consistently win get boosted (up to 1.3x), while cities that consistently
            lose get downgraded (down to 0.3x). Adjustments happen at 10% per daily cycle.
          </p>
          <p>
            These dynamic multipliers override the static tier weights when available, creating
            a feedback loop: bet → resolve → learn → recalibrate → better bets.
          </p>
        </div>
      </div>

      {/* Dynamic calibrations */}
      <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
        <h3 className="text-sm font-medium text-arbiter-text mb-3 flex items-center gap-2">
          <span className="w-2 h-2 bg-arbiter-amber rounded-full" />
          Dynamic Calibration Weights
        </h3>

        {calibrations.length === 0 ? (
          <div className="text-sm text-arbiter-text-3 text-center py-4">
            No dynamic calibration overrides yet. The learning agent will create these
            after enough bets resolve per city (minimum 5 resolved bets needed).
          </div>
        ) : (
          <div className="space-y-2">
            {calibrations
              .sort((a, b) => b.multiplier - a.multiplier)
              .map((cal) => (
                <div key={cal.city} className="flex items-center justify-between py-2 border-b border-arbiter-border/30 last:border-0">
                  <div>
                    <span className="text-sm text-arbiter-text capitalize">{cal.city}</span>
                    <span className="text-xs text-arbiter-text-3 ml-2">
                      updated {timeAgo(cal.updated_at)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-24 h-1.5 bg-arbiter-elevated rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          cal.multiplier >= 1.0 ? 'bg-arbiter-green/70' :
                          cal.multiplier >= 0.7 ? 'bg-arbiter-amber/70' :
                          'bg-arbiter-red/70'
                        }`}
                        style={{ width: `${(cal.multiplier / 1.3) * 100}%` }}
                      />
                    </div>
                    <span className={`text-sm font-mono font-medium ${multiplierColor(cal.multiplier)}`}>
                      {cal.multiplier.toFixed(2)}x
                    </span>
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>

      {/* Sigma Adjustments alert — V2 */}
      {data.sigmaAdjustments && data.sigmaAdjustments.length > 0 && (
        <div className="bg-arbiter-elevated border border-arbiter-amber/30 rounded-lg p-4">
          <h3 className="text-sm font-medium text-arbiter-amber mb-2 flex items-center gap-2">
            <span className="w-2 h-2 bg-arbiter-amber rounded-full animate-pulse" />
            Sigma Recalibration Recommended
          </h3>
          <div className="space-y-1">
            {data.sigmaAdjustments.map((adj, i) => (
              <div key={i} className="text-xs text-arbiter-text-2 pl-3 border-l-2 border-arbiter-amber/40">{adj}</div>
            ))}
          </div>
        </div>
      )}

      {/* Static tiers reference */}
      <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
        <h3 className="text-sm font-medium text-arbiter-text mb-3">Static Tier Baseline</h3>
        <p className="text-xs text-arbiter-text-3 mb-3">
          Default weights before the learning agent adjusts them
        </p>
        <div className="space-y-2">
          {staticTiers.map((tier) => (
            <div key={tier.tier} className="flex items-center justify-between py-1">
              <div>
                <span className="text-sm text-arbiter-text">{tier.tier}</span>
                <span className="text-xs text-arbiter-text-3 ml-2">{tier.desc}</span>
              </div>
              <span className="text-sm font-mono text-arbiter-text-2">{tier.mult}</span>
            </div>
          ))}

        </div>
      </div>

      {/* Sigma Accuracy per city — V2 */}
      {data.sigmaAccuracy && Object.keys(data.sigmaAccuracy).length > 0 && (
        <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
          <h3 className="text-sm font-medium text-arbiter-text mb-1 flex items-center gap-2">
            <span className="w-2 h-2 bg-arbiter-amber rounded-full" />
            Per-City Sigma Accuracy
          </h3>
          <p className="text-xs text-arbiter-text-3 mb-3">
            Compares realized win rate to model_prob predictions. &gt;1.0x = model underestimating edge; &lt;1.0x = overconfident.
          </p>
          <div className="space-y-2">
            {Object.entries(data.sigmaAccuracy)
              .sort(([, a], [, b]) => b.multiplier - a.multiplier)
              .map(([city, info]) => (
                <div key={city} className="flex items-center justify-between py-2 border-b border-arbiter-border/30 last:border-0">
                  <div>
                    <span className="text-sm text-arbiter-text capitalize">{city}</span>
                    <span className="text-xs text-arbiter-text-3 ml-2">
                      {pct(info.win_rate)} WR · n={info.n}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-20 h-1.5 bg-arbiter-elevated rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          info.multiplier >= 1.1 ? 'bg-arbiter-green/70' :
                          info.multiplier <= 0.8 ? 'bg-arbiter-red/70' : 'bg-arbiter-amber/70'
                        }`}
                        style={{ width: `${Math.min(100, (info.multiplier / 2.0) * 100)}%` }}
                      />
                    </div>
                    <span className={`text-sm font-mono font-medium ${multiplierColor(info.multiplier)}`}>
                      {info.multiplier.toFixed(2)}x
                    </span>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Learning cycle explanation */}
      <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
        <h3 className="text-sm font-medium text-arbiter-text mb-3">Learning Cycle</h3>
        <div className="flex flex-col gap-2">
          {[
            { step: '1', label: 'Resolve', desc: 'Bets settle against actual outcomes' },
            { step: '2', label: 'Analyze', desc: 'Learning agent evaluates 8 dimensions daily at 6 AM UTC' },
            { step: '3', label: 'Calibrate', desc: 'City multipliers adjusted ±10% based on win rate vs model_prob' },
            { step: '4', label: 'Kelly Tune', desc: 'Confidence × agreement interactions auto-adjust bet sizing' },
            { step: '5', label: 'Apply', desc: 'Next analysis cycle uses updated weights' },
            { step: '6', label: 'Bet', desc: 'Place-bets uses ensemble Kelly with calibrated sizing' },
          ].map((item) => (
            <div key={item.step} className="flex items-center gap-3">
              <div className="w-6 h-6 rounded-full bg-arbiter-elevated border border-arbiter-border flex items-center justify-center text-xs font-mono text-arbiter-amber shrink-0">
                {item.step}
              </div>
              <div>
                <span className="text-sm text-arbiter-text">{item.label}</span>
                <span className="text-xs text-arbiter-text-3 ml-2">{item.desc}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Forecast Tab — V2 Expert Edition
// ============================================================

function ForecastTab({ data }: { data: LearningData }) {
  const forecast = data.forecastNextCycle;
  const insights = data.insights?.insights || [];
  const impliedInsights = insights.filter((i) => i.category === 'implied_multiplier');
  const brierInsights = insights.filter((i) => i.category === 'brier_score');

  return (
    <div className="space-y-6">
      {/* Next Cycle Forecast */}
      <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
        <h3 className="text-sm font-medium text-arbiter-text mb-1 flex items-center gap-2">
          <span className="w-2 h-2 bg-arbiter-amber rounded-full" />
          AI Forecast — Next Learning Cycle
        </h3>
        <p className="text-xs text-arbiter-text-3 mb-4">
          Generated by the learning agent based on current patterns. Updated at 6 AM UTC daily.
        </p>

        {!forecast || forecast.length === 0 ? (
          <div className="text-center py-8">
            <div className="text-sm text-arbiter-text-2 mb-2">No forecast available yet</div>
            <div className="text-xs text-arbiter-text-3">
              The learning agent needs at least 10 resolved bets to generate a forecast.
              Once enough bets resolve, predictions about calibration changes, edge patterns,
              and recommended focus areas will appear here.
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {forecast.map((line, i) => (
              <div key={i} className="flex items-start gap-3 py-2 border-b border-arbiter-border/30 last:border-0">
                <div className="w-6 h-6 rounded-full bg-arbiter-elevated border border-arbiter-amber/40 flex items-center justify-center text-xs font-mono text-arbiter-amber shrink-0 mt-0.5">
                  {i + 1}
                </div>
                <div className="text-sm text-arbiter-text-2 leading-relaxed">{line}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Implied Multiplier sweet spots */}
      {impliedInsights.length > 0 && (
        <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
          <h3 className="text-sm font-medium text-arbiter-text mb-1">Implied Multiplier Sweet Spots</h3>
          <p className="text-xs text-arbiter-text-3 mb-3">
            our_probability ÷ market_price. High multiplier = market severely underpricing us.
          </p>
          <div className="space-y-0">
            {impliedInsights.map((insight, i) => (
              <InsightRow key={i} insight={insight} />
            ))}
          </div>
        </div>
      )}

      {/* Brier Score Calibration */}
      {brierInsights.length > 0 && (
        <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
          <h3 className="text-sm font-medium text-arbiter-text mb-1">Brier Score Calibration</h3>
          <p className="text-xs text-arbiter-text-3 mb-3">
            Measures probability accuracy. Lower = better. 0.0 = perfect, 0.25 = random coin flip.
            Overconfident means we assign too much probability and lose more than expected.
          </p>
          <div className="space-y-0">
            {brierInsights.map((insight, i) => (
              <InsightRow key={i} insight={insight} />
            ))}
          </div>
        </div>
      )}

      {/* What the agent looks for */}
      <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4">
        <h3 className="text-sm font-medium text-arbiter-text mb-3">8 Dimensions Analyzed</h3>
        <div className="space-y-2">
          {[
            { num: '1', name: 'Direction', desc: 'BUY_YES vs BUY_NO win rate — currently BUY_NO is blocked (0% WR)' },
            { num: '2', name: 'City Calibration', desc: 'Per-city edge multipliers based on historical win rates (±10%/cycle)' },
            { num: '3', name: 'Implied Multiplier', desc: 'our_prob ÷ market_price — the primary alpha signal for market mispricing' },
            { num: '4', name: 'Confidence Tier', desc: 'HIGH/MEDIUM/LOW tier performance and expected vs realized accuracy' },
            { num: '5', name: 'Entry Price', desc: 'Sweet spots in entry price distribution — some ranges outperform systematically' },
            { num: '6', name: 'Conf × Agreement', desc: 'Interaction of confidence tier × model agreement → auto-tunes Kelly size' },
            { num: '7', name: 'Brier Score', desc: 'Probability calibration per tier — catches overconfidence before it bleeds' },
            { num: '8', name: 'Sigma Accuracy', desc: 'Realized win rate vs model_prob expectations per city (σ recalibration)' },
          ].map((dim) => (
            <div key={dim.num} className="flex items-start gap-3 py-1.5">
              <div className="w-5 h-5 rounded bg-arbiter-elevated border border-arbiter-border flex items-center justify-center text-[10px] font-mono text-arbiter-amber shrink-0 mt-0.5">
                {dim.num}
              </div>
              <div>
                <span className="text-sm text-arbiter-text">{dim.name}</span>
                <span className="text-xs text-arbiter-text-3 ml-2">{dim.desc}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
