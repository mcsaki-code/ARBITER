'use client';

import { useEffect, useState } from 'react';

interface Summary {
  total_captured: number;
  total_scored: number;
  avg_brier: number | null;
  avg_log_loss: number | null;
  avg_abs_error: number | null;
  would_have_bet_count: number;
  would_have_bet_scored_count: number;
  would_have_bet_win_rate: number | null;
}

interface ReliabilityBucket {
  bucket_low: number;
  bucket_high: number;
  n: number;
  mean_predicted: number | null;
  observed_yes_rate: number | null;
}

interface LeadTimeRow {
  lead_time_bucket: string;
  n: number;
  avg_brier: number;
  avg_abs_error: number;
}

interface CityRow {
  city_name: string;
  n: number;
  avg_brier: number;
  avg_abs_error: number;
}

interface BacktestResponse {
  summary: Summary;
  reliability: ReliabilityBucket[];
  by_lead_time: LeadTimeRow[];
  by_city: CityRow[];
  recent_scored: Array<{
    city_name: string | null;
    predicted_prob: number;
    resolved_outcome: string | null;
    brier_score: number | null;
    lead_time_bucket: string | null;
  }>;
}

function fmtPct(x: number | null | undefined, digits = 1): string {
  if (x == null || Number.isNaN(x)) return '—';
  return `${(x * 100).toFixed(digits)}%`;
}

function fmtNum(x: number | null | undefined, digits = 3): string {
  if (x == null || Number.isNaN(x)) return '—';
  return x.toFixed(digits);
}

export default function BacktestPage() {
  const [data, setData] = useState<BacktestResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    fetch('/api/backtest')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        if (mounted) {
          setData(j);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (mounted) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0d0d14] text-[#e0e0e8] p-6">
        <div className="max-w-5xl mx-auto">Loading backtest data…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="min-h-screen bg-[#0d0d14] text-[#ff4d6d] p-6">
        <div className="max-w-5xl mx-auto">Error: {error}</div>
      </div>
    );
  }
  if (!data) return null;

  const { summary, reliability, by_lead_time, by_city, recent_scored } = data;

  return (
    <div className="min-h-screen bg-[#0d0d14] text-[#e0e0e8] p-4 sm:p-6">
      <div className="max-w-5xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-[#f0b429] mb-1">Backtest Shadow</h1>
          <p className="text-sm text-[#888]">
            Path B self-building calibration. Every analyzed bracket is scored on resolution — no bets placed.
          </p>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <Card label="Captured" value={summary.total_captured.toLocaleString()} />
          <Card label="Scored" value={summary.total_scored.toLocaleString()} sub={`${summary.total_captured > 0 ? fmtPct(summary.total_scored / summary.total_captured) : '—'} resolved`} />
          <Card label="Brier" value={fmtNum(summary.avg_brier)} sub="lower = better (0.25 = chance)" accent={summary.avg_brier != null && summary.avg_brier < 0.20 ? 'green' : undefined} />
          <Card label="Abs Error" value={fmtNum(summary.avg_abs_error)} />
          <Card label="Would-bet flagged" value={summary.would_have_bet_count.toLocaleString()} sub={`${summary.would_have_bet_scored_count} scored`} />
          <Card label="Would-bet WR" value={fmtPct(summary.would_have_bet_win_rate)} accent={summary.would_have_bet_win_rate != null && summary.would_have_bet_win_rate > 0.55 ? 'green' : summary.would_have_bet_win_rate != null && summary.would_have_bet_win_rate < 0.45 ? 'red' : undefined} />
          <Card label="Log Loss" value={fmtNum(summary.avg_log_loss)} />
          <Card label="Chance reference" value="0.250" sub="Brier at max uncertainty" />
        </div>

        {/* Reliability diagram */}
        <Section title="Reliability Diagram">
          <div className="text-xs text-[#888] mb-2">
            For each predicted-probability bucket, how often did YES actually happen? Perfect calibration means mean_predicted ≈ observed_yes_rate.
          </div>
          <table className="w-full text-sm">
            <thead className="text-[#888] text-left">
              <tr>
                <th className="py-1">Bucket</th>
                <th className="py-1 text-right">n</th>
                <th className="py-1 text-right">Mean predicted</th>
                <th className="py-1 text-right">Observed YES</th>
                <th className="py-1 text-right">Gap</th>
              </tr>
            </thead>
            <tbody>
              {reliability.map((b) => {
                const gap = b.mean_predicted != null && b.observed_yes_rate != null
                  ? b.observed_yes_rate - b.mean_predicted
                  : null;
                return (
                  <tr key={`${b.bucket_low}-${b.bucket_high}`} className="border-t border-[#1a1a2e]">
                    <td className="py-1">{fmtPct(b.bucket_low, 0)}–{fmtPct(b.bucket_high, 0)}</td>
                    <td className="py-1 text-right">{b.n}</td>
                    <td className="py-1 text-right">{fmtPct(b.mean_predicted)}</td>
                    <td className="py-1 text-right">{fmtPct(b.observed_yes_rate)}</td>
                    <td className={`py-1 text-right ${gap == null ? '' : Math.abs(gap) < 0.05 ? 'text-[#00d4a0]' : Math.abs(gap) < 0.15 ? 'text-[#f0b429]' : 'text-[#ff4d6d]'}`}>
                      {gap == null ? '—' : (gap > 0 ? '+' : '') + fmtPct(gap)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Section>

        <Section title="By Lead Time">
          <table className="w-full text-sm">
            <thead className="text-[#888] text-left">
              <tr>
                <th className="py-1">Bucket</th>
                <th className="py-1 text-right">n</th>
                <th className="py-1 text-right">Brier</th>
                <th className="py-1 text-right">Abs Err</th>
              </tr>
            </thead>
            <tbody>
              {by_lead_time.map((r) => (
                <tr key={r.lead_time_bucket} className="border-t border-[#1a1a2e]">
                  <td className="py-1">{r.lead_time_bucket}</td>
                  <td className="py-1 text-right">{r.n}</td>
                  <td className="py-1 text-right">{fmtNum(r.avg_brier)}</td>
                  <td className="py-1 text-right">{fmtNum(r.avg_abs_error)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section title="By City (top 20 by sample)">
          <table className="w-full text-sm">
            <thead className="text-[#888] text-left">
              <tr>
                <th className="py-1">City</th>
                <th className="py-1 text-right">n</th>
                <th className="py-1 text-right">Brier</th>
                <th className="py-1 text-right">Abs Err</th>
              </tr>
            </thead>
            <tbody>
              {by_city.slice(0, 20).map((r) => (
                <tr key={r.city_name} className="border-t border-[#1a1a2e]">
                  <td className="py-1">{r.city_name}</td>
                  <td className="py-1 text-right">{r.n}</td>
                  <td className="py-1 text-right">{fmtNum(r.avg_brier)}</td>
                  <td className="py-1 text-right">{fmtNum(r.avg_abs_error)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section title="Recent Scored (last 20)">
          <table className="w-full text-sm">
            <thead className="text-[#888] text-left">
              <tr>
                <th className="py-1">City</th>
                <th className="py-1">Lead</th>
                <th className="py-1 text-right">Predicted</th>
                <th className="py-1">Outcome</th>
                <th className="py-1 text-right">Brier</th>
              </tr>
            </thead>
            <tbody>
              {recent_scored.map((r, i) => (
                <tr key={i} className="border-t border-[#1a1a2e]">
                  <td className="py-1">{r.city_name ?? '—'}</td>
                  <td className="py-1">{r.lead_time_bucket ?? '—'}</td>
                  <td className="py-1 text-right">{fmtPct(r.predicted_prob)}</td>
                  <td className={`py-1 ${r.resolved_outcome === 'YES' ? 'text-[#00d4a0]' : 'text-[#ff4d6d]'}`}>{r.resolved_outcome}</td>
                  <td className="py-1 text-right">{fmtNum(r.brier_score)}</td>
                </tr>
              ))}
              {recent_scored.length === 0 && (
                <tr><td colSpan={5} className="py-3 text-center text-[#555570]">No scored rows yet — wait for markets to resolve</td></tr>
              )}
            </tbody>
          </table>
        </Section>

        <div className="text-xs text-[#555570] mt-6">
          Scoring runs hourly with resolve-bets. Data accumulates as markets close.
        </div>
      </div>
    </div>
  );
}

function Card({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: 'green' | 'red' }) {
  const color = accent === 'green' ? 'text-[#00d4a0]' : accent === 'red' ? 'text-[#ff4d6d]' : 'text-[#e0e0e8]';
  return (
    <div className="bg-[#1a1a2e] rounded-lg p-3 border border-[#2a2a3e]">
      <div className="text-xs text-[#888]">{label}</div>
      <div className={`text-xl font-semibold ${color}`}>{value}</div>
      {sub && <div className="text-xs text-[#555570] mt-0.5">{sub}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6 bg-[#12121c] rounded-lg p-4 border border-[#1a1a2e]">
      <h2 className="text-base font-semibold text-[#f0b429] mb-3">{title}</h2>
      {children}
    </div>
  );
}
