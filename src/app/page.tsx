'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/Badge';
import { BankrollCard } from '@/components/BankrollCard';
import { EdgeMeter } from '@/components/EdgeMeter';
import { CityWeatherCard } from '@/lib/types';

export default function HomePage() {
  const [weatherData, setWeatherData] = useState<CityWeatherCard[]>([]);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [betsData, setBetsData] = useState<{ wins: number; losses: number; pnl: number }>({
    wins: 0,
    losses: 0,
    pnl: 0,
  });

  useEffect(() => {
    async function load() {
      try {
        const [weatherRes, betsRes] = await Promise.all([
          fetch('/api/weather'),
          fetch('/api/bets'),
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
      } catch (err) {
        console.error('Failed to load home data:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

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

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column — Intelligence placeholder */}
        <div className="lg:col-span-2 space-y-4">
          {/* Hero status bar */}
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 bg-arbiter-green rounded-full pulse-dot" />
              <span className="text-sm text-arbiter-text-2">
                Systems online — Weather pipeline active
              </span>
            </div>
            <span className="font-mono text-xs text-arbiter-text-3">
              {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
            </span>
          </div>

          {/* Phase 2 placeholder */}
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg overflow-hidden">
            <div className="border-b border-arbiter-border px-5 py-3">
              <h2 className="text-xs text-arbiter-text-3 uppercase tracking-widest">
                Intelligence Feed
              </h2>
            </div>
            <div className="p-8">
              <div className="text-center max-w-sm mx-auto">
                <div className="w-10 h-10 rounded-lg bg-arbiter-elevated border border-arbiter-border flex items-center justify-center mx-auto mb-4">
                  <svg viewBox="0 0 20 20" fill="currentColor" width="20" height="20" className="text-arbiter-text-3">
                    <path fillRule="evenodd" d="M2 5a2 2 0 012-2h8a2 2 0 012 2v10a2 2 0 002 2H4a2 2 0 01-2-2V5zm3 1h6v4H5V6zm6 6H5v2h6v-2z" clipRule="evenodd" />
                    <path d="M15 7h1a2 2 0 012 2v5.5a1.5 1.5 0 01-3 0V7z" />
                  </svg>
                </div>
                <p className="text-sm text-arbiter-text-2 mb-4 leading-relaxed">
                  Phase 2 adds real-time news intelligence from AP, Reuters, and BBC with AI-powered
                  analysis and a CONFIRMED / DISPUTED / UNVERIFIED verdict system.
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  {['Global Feed', 'AI Summaries', 'Hotspot Map', 'Ask ARBITER', 'News-Markets Link'].map(
                    (feature) => (
                      <span
                        key={feature}
                        className="px-2 py-1 text-[10px] uppercase tracking-wider text-arbiter-text-3 border border-arbiter-border rounded"
                      >
                        {feature}
                      </span>
                    )
                  )}
                </div>
              </div>
            </div>
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
                <div className="px-4 py-8 text-center">
                  <p className="text-xs text-arbiter-text-3">
                    No active edges detected
                  </p>
                  <p className="text-[10px] text-arbiter-text-3 mt-1">
                    Pipeline scans every 15 min
                  </p>
                </div>
              )}
            </div>
          </div>

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
