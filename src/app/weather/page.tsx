'use client';

import { useState, useEffect, useCallback } from 'react';
import { Badge } from '@/components/Badge';
import { ModelDots } from '@/components/ModelDots';
import { EdgeMeter } from '@/components/EdgeMeter';
import { PriceBar } from '@/components/PriceBar';
import { StatRow } from '@/components/StatRow';
import { Drawer } from '@/components/Drawer';
import { DataStateWrapper } from '@/components/DataState';
import { DataState, CityWeatherCard } from '@/lib/types';

interface WeatherApiResponse {
  cities: CityWeatherCard[];
  lastUpdated: string;
}

export default function WeatherPage() {
  const [data, setData] = useState<WeatherApiResponse | null>(null);
  const [state, setState] = useState<DataState>('loading');
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [selectedCity, setSelectedCity] = useState<CityWeatherCard | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [betConfirm, setBetConfirm] = useState(false);
  const [betPlacing, setBetPlacing] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/weather');
      if (!res.ok) throw new Error('Failed to fetch');
      const json: WeatherApiResponse = await res.json();
      setData(json);
      setLastUpdated(json.lastUpdated);

      if (!json.cities || json.cities.length === 0) {
        setState('empty');
      } else {
        setState('fresh');
      }
    } catch {
      setState(data ? 'stale' : 'error');
    }
  }, [data]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000); // Refresh every minute
    return () => clearInterval(interval);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openCity = (card: CityWeatherCard) => {
    setSelectedCity(card);
    setDrawerOpen(true);
    setBetConfirm(false);
  };

  const placePaperBet = async () => {
    if (!selectedCity?.analysis || !selectedCity.market) return;
    if (!betConfirm) {
      setBetConfirm(true);
      return; // Two-tap confirmation
    }

    setBetPlacing(true);
    try {
      const a = selectedCity.analysis;
      await fetch('/api/bets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          market_id: a.market_id,
          analysis_id: a.id,
          category: 'weather',
          direction: a.direction,
          outcome_label: a.best_outcome_label,
          entry_price: a.market_price,
          amount_usd: a.rec_bet_usd,
        }),
      });
      setDrawerOpen(false);
      fetchData();
    } catch (err) {
      console.error('Failed to place bet:', err);
    } finally {
      setBetPlacing(false);
      setBetConfirm(false);
    }
  };

  const formatTimeAgo = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
  };

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-semibold mb-1">Weather Edge</h1>
        <p className="text-sm text-arbiter-text-2">
          Model consensus vs Polymarket brackets
        </p>
      </div>

      <DataStateWrapper
        state={state}
        lastUpdated={lastUpdated ? formatTimeAgo(lastUpdated) : null}
        emptyMessage="No weather data yet — data pipeline initializing"
        skeletonCount={6}
      >
        {/* City Card Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {data?.cities?.map((card) => (
            <CityCard key={card.city.id} card={card} onClick={() => openCity(card)} />
          ))}
        </div>
      </DataStateWrapper>

      {/* Drawer Detail View */}
      <Drawer
        isOpen={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setBetConfirm(false);
        }}
        title={selectedCity?.city.name}
        subtitle={selectedCity?.consensus?.valid_date || 'No forecast data'}
      >
        {selectedCity && (
          <CityDetail
            card={selectedCity}
            onBet={placePaperBet}
            betConfirm={betConfirm}
            betPlacing={betPlacing}
          />
        )}
      </Drawer>
    </div>
  );
}

// ============================================================
// City Card Component
// ============================================================
function CityCard({ card, onClick }: { card: CityWeatherCard; onClick: () => void }) {
  const { city, consensus, analysis } = card;
  const hasEdge = analysis && analysis.edge !== null && analysis.edge > 0.05;
  const isPass = !analysis || analysis.direction === 'PASS' || !hasEdge;

  return (
    <button
      onClick={onClick}
      className="bg-arbiter-card border border-arbiter-border hover:border-arbiter-border-hi rounded-lg p-4 text-left transition-all hover:bg-arbiter-elevated group w-full"
    >
      {/* City name + agreement badge */}
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-medium text-sm">{city.name}</h3>
        {consensus && (
          <Badge
            variant={
              consensus.agreement === 'HIGH'
                ? 'green'
                : consensus.agreement === 'MEDIUM'
                ? 'amber'
                : 'red'
            }
          >
            {consensus.agreement === 'HIGH'
              ? '● HIGH'
              : consensus.agreement === 'MEDIUM'
              ? '○ MED'
              : '✕ LOW'}
          </Badge>
        )}
      </div>

      {/* Consensus temperature */}
      <div className="font-mono text-3xl font-medium mb-2">
        {consensus ? `${consensus.consensus_high_f}°F` : '—'}
      </div>

      {/* Model dots */}
      {consensus && (
        <ModelDots
          agreement={consensus.agreement}
          modelsUsed={consensus.models_used}
          className="mb-3"
        />
      )}

      {/* Price bar if we have market data */}
      {card.market && (
        <PriceBar
          outcomes={card.market.outcomes}
          prices={card.market.outcome_prices}
          highlightIdx={analysis?.best_outcome_idx}
          className="mb-3"
        />
      )}

      {/* Edge display */}
      {analysis && hasEdge ? (
        <div className="flex items-center justify-between">
          <div>
            <span className="text-xs text-arbiter-text-3">
              {analysis.best_outcome_label}
            </span>
            <EdgeMeter edge={analysis.edge!} className="w-24 mt-0.5" />
          </div>
          <div className="text-right">
            <Badge variant="amber">
              BET ${analysis.rec_bet_usd?.toFixed(0)}
            </Badge>
          </div>
        </div>
      ) : (
        <div className="text-xs text-arbiter-text-3">
          {isPass ? 'PASS — No actionable edge' : 'Awaiting analysis...'}
        </div>
      )}
    </button>
  );
}

// ============================================================
// City Detail Component (shown in Drawer)
// ============================================================
function CityDetail({
  card,
  onBet,
  betConfirm,
  betPlacing,
}: {
  card: CityWeatherCard;
  onBet: () => void;
  betConfirm: boolean;
  betPlacing: boolean;
}) {
  const { consensus, market, analysis, forecasts } = card;

  // Group forecasts by source
  const nws = forecasts.find((f) => f.source === 'nws');
  const gfs = forecasts.find((f) => f.source === 'gfs');
  const ecmwf = forecasts.find((f) => f.source === 'ecmwf');
  const icon = forecasts.find((f) => f.source === 'icon');

  return (
    <div className="space-y-6">
      {/* Forecast Models */}
      <div>
        <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider mb-2">
          Forecast Models
        </h3>
        <div className="bg-arbiter-bg rounded-lg p-3 space-y-1">
          {nws && (
            <StatRow label="NWS Official" value={`${nws.temp_high_f}°F / ${nws.temp_low_f}°F`} />
          )}
          <StatRow
            label="GFS"
            value={gfs ? `${gfs.temp_high_f}°F` : 'N/A'}
            valueColor={gfs ? undefined : 'text-arbiter-text-3'}
          />
          <StatRow
            label="ECMWF"
            value={ecmwf ? `${ecmwf.temp_high_f}°F` : 'N/A'}
            valueColor={ecmwf ? undefined : 'text-arbiter-text-3'}
          />
          <StatRow
            label="ICON"
            value={icon ? `${icon.temp_high_f}°F` : 'N/A'}
            valueColor={icon ? undefined : 'text-arbiter-text-3'}
          />
          {consensus && (
            <>
              <div className="border-t border-arbiter-border my-2" />
              <StatRow
                label="Consensus"
                value={`${consensus.consensus_high_f}°F ± ${consensus.model_spread_f}°F`}
              />
              <div className="flex items-center gap-2 mt-1">
                <ModelDots agreement={consensus.agreement} modelsUsed={consensus.models_used} />
                <Badge
                  variant={
                    consensus.agreement === 'HIGH'
                      ? 'green'
                      : consensus.agreement === 'MEDIUM'
                      ? 'amber'
                      : 'red'
                  }
                >
                  {consensus.agreement}
                </Badge>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Bracket Analysis */}
      {market && (
        <div>
          <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider mb-2">
            Bracket Analysis
          </h3>
          <div className="bg-arbiter-bg rounded-lg overflow-hidden">
            {/* Header */}
            <div className="grid grid-cols-5 gap-2 px-3 py-2 text-[10px] text-arbiter-text-3 uppercase tracking-wider border-b border-arbiter-border">
              <span>Outcome</span>
              <span className="text-right">Mkt Price</span>
              <span className="text-right">Our Est</span>
              <span className="text-right">Edge</span>
              <span className="text-right">Action</span>
            </div>
            {/* Rows */}
            {market.outcomes.map((outcome, i) => {
              const mktPrice = market.outcome_prices[i] || 0;
              const isBest = analysis?.best_outcome_idx === i;
              // Find matching outcome in analysis all_outcomes would be ideal,
              // but we'll use the best bet info
              const edge = isBest ? analysis?.edge || 0 : 0;
              const trueProb = isBest ? analysis?.true_prob || 0 : 0;

              return (
                <div
                  key={i}
                  className={`grid grid-cols-5 gap-2 px-3 py-2 text-xs ${
                    isBest
                      ? 'bg-arbiter-amber/10 border-l-2 border-l-arbiter-amber'
                      : 'border-l-2 border-l-transparent'
                  }`}
                >
                  <span className="font-mono">{outcome}</span>
                  <span className="font-mono text-right">
                    ${mktPrice.toFixed(2)}
                  </span>
                  <span className="font-mono text-right">
                    {isBest ? `${(trueProb * 100).toFixed(0)}%` : '—'}
                  </span>
                  <span
                    className={`font-mono text-right ${
                      edge > 0
                        ? 'text-arbiter-green'
                        : edge < 0
                        ? 'text-arbiter-red'
                        : 'text-arbiter-text-3'
                    }`}
                  >
                    {isBest
                      ? `${edge > 0 ? '+' : ''}${(edge * 100).toFixed(0)}%`
                      : '—'}
                  </span>
                  <span className="text-right">
                    {isBest && edge > 0 ? (
                      <span className="text-arbiter-amber font-medium">★ BUY</span>
                    ) : (
                      <span className="text-arbiter-text-3">—</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Kelly + Reasoning */}
      {analysis && analysis.edge !== null && analysis.edge > 0 && (
        <div>
          <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider mb-2">
            Analysis
          </h3>
          <div className="bg-arbiter-bg rounded-lg p-3 space-y-2">
            <StatRow
              label="Kelly Fraction"
              value={`${((analysis.kelly_fraction || 0) * 100).toFixed(1)}%`}
            />
            <StatRow
              label="Recommended Bet"
              value={`$${(analysis.rec_bet_usd || 0).toFixed(2)}`}
              valueColor="text-arbiter-amber"
            />
            <StatRow
              label="Confidence"
              value={analysis.confidence}
              valueColor={
                analysis.confidence === 'HIGH'
                  ? 'text-arbiter-green'
                  : analysis.confidence === 'MEDIUM'
                  ? 'text-arbiter-amber'
                  : 'text-arbiter-red'
              }
            />
            {analysis.reasoning && (
              <div className="pt-2 border-t border-arbiter-border">
                <p className="text-xs text-arbiter-text-2 leading-relaxed">
                  {analysis.reasoning}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Bet Button */}
      {analysis && analysis.direction !== 'PASS' && analysis.rec_bet_usd && analysis.rec_bet_usd > 0 && (
        <div className="flex gap-3">
          <button
            onClick={onBet}
            disabled={betPlacing}
            className={`flex-1 py-3 rounded-lg font-medium text-sm transition-all min-h-[44px] ${
              betConfirm
                ? 'bg-arbiter-amber text-arbiter-bg hover:bg-arbiter-amber/90'
                : 'bg-arbiter-amber/20 text-arbiter-amber border border-arbiter-amber/40 hover:bg-arbiter-amber/30'
            } ${betPlacing ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {betPlacing
              ? 'Placing...'
              : betConfirm
              ? `CONFIRM — Paper Bet $${analysis.rec_bet_usd.toFixed(0)}`
              : `PAPER BET — $${analysis.rec_bet_usd.toFixed(0)}`}
          </button>
          <button
            onClick={() => {
              // Close drawer
            }}
            className="px-4 py-3 rounded-lg text-sm text-arbiter-text-2 border border-arbiter-border hover:bg-arbiter-card min-h-[44px]"
          >
            SKIP
          </button>
        </div>
      )}

      {/* No edge state */}
      {(!analysis || analysis.direction === 'PASS') && (
        <div className="bg-arbiter-bg rounded-lg p-4 text-center">
          <div className="text-arbiter-text-3 text-sm">
            No actionable edge detected for this market
          </div>
        </div>
      )}
    </div>
  );
}
