'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/Badge';
import { BankrollCard } from '@/components/BankrollCard';
import { EdgeMeter } from '@/components/EdgeMeter';
import { SkeletonCard } from '@/components/Skeleton';
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

  // Sort by edge descending
  edgeCities.sort((a, b) => (b.analysis?.edge || 0) - (a.analysis?.edge || 0));

  // Resolving soon — markets expiring within 24h
  const resolvingSoon = weatherData.filter((c) => {
    if (!c.market?.resolution_date) return false;
    const hours =
      (new Date(c.market.resolution_date).getTime() - Date.now()) / 3600000;
    return hours > 0 && hours < 24;
  });

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      {/* Desktop: two columns */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column — News placeholder */}
        <div className="lg:col-span-2">
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg p-8">
            <div className="text-center max-w-md mx-auto">
              <div className="text-4xl mb-4 opacity-40">📰</div>
              <h2 className="text-lg font-semibold mb-2">
                Intelligence Coming Soon
              </h2>
              <p className="text-sm text-arbiter-text-2 mb-4">
                Phase 2 will add real-time news intelligence from AP, Reuters,
                BBC, and more — organized by region with AI-powered analysis and
                a CONFIRMED / DISPUTED / UNVERIFIED verdict system.
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {[
                  'Global News Feed',
                  'AI Summaries',
                  'Hotspot Map',
                  'Ask ARBITER',
                  'News ↔ Markets',
                ].map((feature) => (
                  <Badge key={feature} variant="gray">
                    {feature}
                  </Badge>
                ))}
              </div>
            </div>
          </div>

          {/* Quick links */}
          <div className="grid grid-cols-2 gap-3 mt-4">
            <Link
              href="/weather"
              className="bg-arbiter-card border border-arbiter-border rounded-lg p-4 hover:bg-arbiter-elevated transition-colors"
            >
              <span className="text-2xl">🌤</span>
              <h3 className="text-sm font-medium mt-2">Weather Edge</h3>
              <p className="text-xs text-arbiter-text-3 mt-1">
                {edgeCities.length > 0
                  ? `${edgeCities.length} active opportunities`
                  : 'View model consensus'}
              </p>
            </Link>
            <Link
              href="/tracker"
              className="bg-arbiter-card border border-arbiter-border rounded-lg p-4 hover:bg-arbiter-elevated transition-colors"
            >
              <span className="text-2xl">📈</span>
              <h3 className="text-sm font-medium mt-2">Tracker</h3>
              <p className="text-xs text-arbiter-text-3 mt-1">
                {totalBets > 0
                  ? `${totalBets} bets · ${(winRate * 100).toFixed(0)}% WR`
                  : 'Paper trading dashboard'}
              </p>
            </Link>
          </div>
        </div>

        {/* Right column — Edge Panel */}
        <div className="space-y-4">
          {/* Weather Edges */}
          <div className="bg-arbiter-card border border-arbiter-border rounded-lg">
            <div className="px-4 py-3 border-b border-arbiter-border flex items-center justify-between">
              <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider">
                Weather Edge
              </h3>
              <Link
                href="/weather"
                className="text-xs text-arbiter-blue hover:underline"
              >
                View All →
              </Link>
            </div>
            <div className="p-3 space-y-1">
              {loading ? (
                <>
                  <div className="skeleton h-10 rounded" />
                  <div className="skeleton h-10 rounded" />
                  <div className="skeleton h-10 rounded" />
                </>
              ) : edgeCities.length > 0 ? (
                edgeCities.slice(0, 6).map((card) => (
                  <Link
                    key={card.city.id}
                    href="/weather"
                    className="flex items-center justify-between py-2 px-2 rounded hover:bg-arbiter-elevated/50 transition-colors"
                  >
                    <div>
                      <span className="text-sm font-medium">
                        {card.city.name.split(' ')[0]}
                      </span>
                      <span className="text-[10px] text-arbiter-text-3 ml-2">
                        {card.analysis?.best_outcome_label}
                      </span>
                    </div>
                    <EdgeMeter
                      edge={card.analysis?.edge || 0}
                      className="w-20"
                    />
                  </Link>
                ))
              ) : (
                <div className="text-xs text-arbiter-text-3 text-center py-4">
                  No active edges — check back soon
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
            <div className="bg-arbiter-card border border-arbiter-border rounded-lg">
              <div className="px-4 py-3 border-b border-arbiter-border">
                <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider">
                  Resolving Soon
                </h3>
              </div>
              <div className="p-3 space-y-2">
                {resolvingSoon.slice(0, 4).map((card) => {
                  const hours = card.market?.resolution_date
                    ? Math.round(
                        (new Date(card.market.resolution_date).getTime() -
                          Date.now()) /
                          3600000
                      )
                    : 0;
                  return (
                    <div
                      key={card.city.id}
                      className="flex items-center justify-between text-xs"
                    >
                      <span>{card.city.name}</span>
                      <span className="font-mono text-arbiter-amber">
                        {hours}h
                      </span>
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
