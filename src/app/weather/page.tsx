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

/** Normalize edge values — Claude sometimes returns 849 instead of 0.849 */
function normalizeEdge(raw: number | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  if (raw > 100) return raw / 1000;
  if (raw > 1) return raw / 100;
  return raw;
}

/** Normalize probability/price values (0–1 range) */
function normalizeProb(raw: number | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  if (raw > 1) return raw / 100;
  return raw;
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
    const interval = setInterval(fetchData, 60000);
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
      return;
    }

    setBetPlacing(true);
    try {
      const a = selectedCity.analysis;
      // Normalize entry price (handle cases where Claude returns 85 instead of 0.85)
      const rawPrice = a.market_price || 0.5;
      const entryPrice = rawPrice > 1 ? rawPrice / 100 : rawPrice;

      await fetch('/api/bets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          market_id: a.market_id,
          analysis_id: a.id,
          category: 'weather',
          direction: a.direction,
          outcome_label: a.best_outcome_label,
          entry_price: entryPrice,
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
      <div className="mb-6">
        <h1 className="text-xl font-semibold mb-1">Weather - AI vs. the Market</h1>
        <p className="text-sm text-arbiter-text-2">
          5 forecast models + 31-member ensemble vs Polymarket brackets - temperature, precipitation & snowfall
        </p>
      </div>

      <DataStateWrapper
        state={state}
        lastUpdated={lastUpdated ? formatTimeAgo(lastUpdated) : null}
        emptyMessage="No weather data yet — run pipeline sync from the home page"
        skeletonCount={6}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {data?.cities?.map((card) => (
            <CityCard key={card.city.id} card={card} onClick={() => openCity(card)} />
          ))}
        </div>
      </DataStateWrapper>

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
// City Card — shows consensus, model temps, status reason
// ============================================================
function CityCard({ card, onClick }: { card: CityWeatherCard; onClick: () => void }) {
  const { city, consensus, analysis, market, forecasts } = card;
  const edgeNorm = normalizeEdge(analysis?.edge);
  const hasEdge = analysis && analysis.edge !== null && edgeNorm > 0.05;

  // Determine status and reason
  let statusLabel = '';
  let statusVariant: 'amber' | 'green' | 'red' | 'gray' = 'gray';

  if (hasEdge) {
    statusLabel = `EDGE +${(edgeNorm * 100).toFixed(0)}%`;
    statusVariant = 'amber';
  } else if (analysis && analysis.direction === 'PASS') {
    statusLabel = 'PASS';
    statusVariant = 'gray';
  } else if (!market) {
    statusLabel = 'NO MARKET';
    statusVariant = 'gray';
  } else if (!consensus) {
    statusLabel = 'AWAITING DATA';
    statusVariant = 'gray';
  } else if (consensus.agreement === 'LOW') {
    statusLabel = 'LOW AGREE';
    statusVariant = 'red';
  } else if (!analysis) {
    statusLabel = 'PENDING';
    statusVariant = 'gray';
  } else {
    statusLabel = 'PASS';
    statusVariant = 'gray';
  }

  // Get pass reason text
  const passReason = getPassReason(card);

  // Extract individual model temps from forecasts
  const gfs = forecasts?.find((f) => f.source === 'gfs');
  const ecmwf = forecasts?.find((f) => f.source === 'ecmwf');
  const icon = forecasts?.find((f) => f.source === 'icon');
  const nws = forecasts?.find((f) => f.source === 'nws');
  const hrrr = forecasts?.find((f) => f.source === 'hrrr');

  // Detect market type from market question or category
  const marketType = market?.market_type || market?.category || 'temperature';
  const isPrecip = marketType === 'precipitation';
  const isSnow = marketType === 'snowfall';

  return (
    <button
      onClick={onClick}
      className={`bg-arbiter-card border rounded-lg p-4 text-left transition-all hover:bg-arbiter-elevated group w-full ${
        hasEdge ? 'border-arbiter-amber/40 hover:border-arbiter-amber/60' : 'border-arbiter-border hover:border-arbiter-border-hi'
      }`}
    >
      {/* City name + status badge + market type */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-sm">{city.name}</h3>
          {isPrecip && <span className="text-[10px] px-1.5 py-0.5 bg-blue-500/10 text-blue-400 rounded">PRECIP</span>}
          {isSnow && <span className="text-[10px] px-1.5 py-0.5 bg-blue-200/10 text-blue-200 rounded">SNOW</span>}
        </div>
        <Badge variant={statusVariant}>{statusLabel}</Badge>
      </div>

      {/* Consensus temp + model agreement */}
      <div className="flex items-end justify-between mb-2">
        <div className="font-mono text-3xl font-medium">
          {consensus ? (
            isPrecip ? `${consensus.precip_consensus_mm ?? 0}mm` :
            isSnow ? `${consensus.snowfall_consensus_cm ?? 0}cm` :
            `${consensus.consensus_high_f}°F`
          ) : '—'}
        </div>
        {consensus && (
          <div className="flex items-center gap-1.5 mb-1">
            <ModelDots
              agreement={isPrecip ? (consensus.precip_agreement || consensus.agreement) : consensus.agreement}
              modelsUsed={consensus.models_used}
            />
            {!isPrecip && !isSnow && (
              <span className="text-[10px] text-arbiter-text-3 font-mono">
                ±{consensus.model_spread_f}°
              </span>
            )}
            {consensus.ensemble_members && (
              <span className="text-[10px] text-green-400/70 font-mono">
                {consensus.ensemble_members}E
              </span>
            )}
          </div>
        )}
      </div>

      {/* Per-model temperature breakdown */}
      <div className="flex flex-wrap gap-1.5 text-[10px] text-arbiter-text-3 font-mono mb-3">
        {hrrr && <span className="px-1.5 py-0.5 bg-green-500/10 text-green-400 rounded">HRRR {hrrr.temp_high_f}°</span>}
        {gfs && <span className="px-1.5 py-0.5 bg-arbiter-bg rounded">GFS {gfs.temp_high_f}°</span>}
        {ecmwf && <span className="px-1.5 py-0.5 bg-arbiter-bg rounded">ECM {ecmwf.temp_high_f}°</span>}
        {icon && <span className="px-1.5 py-0.5 bg-arbiter-bg rounded">ICN {icon.temp_high_f}°</span>}
        {nws && <span className="px-1.5 py-0.5 bg-arbiter-bg rounded">NWS {nws.temp_high_f}°</span>}
      </div>

      {/* Price bar if we have market data */}
      {market && (
        <PriceBar
          outcomes={market.outcomes}
          prices={market.outcome_prices}
          highlightIdx={analysis?.best_outcome_idx}
          className="mb-3"
        />
      )}

      {/* Edge display OR pass reason */}
      {hasEdge ? (
        <div className="flex items-center justify-between">
          <div>
            <span className="text-xs text-arbiter-text-3">
              {analysis!.best_outcome_label}
            </span>
            <EdgeMeter edge={edgeNorm} className="w-24 mt-0.5" />
          </div>
          <div className="text-right">
            <Badge variant="amber">
              BET ${analysis!.rec_bet_usd?.toFixed(0)}
            </Badge>
          </div>
        </div>
      ) : (
        <div className="text-[10px] text-arbiter-text-3 leading-relaxed">
          {passReason}
        </div>
      )}
    </button>
  );
}

// ============================================================
// Pass Reason Logic — explains WHY we're not betting
// ============================================================
function getPassReason(card: CityWeatherCard): string {
  const { consensus, analysis, market } = card;

  if (!consensus) return 'Waiting for forecast data from 5 weather models + ensemble';

  if (!market) return `Models show ${consensus.consensus_high_f}°F (±${consensus.model_spread_f}°) but no active Polymarket market found for this city`;

  if (consensus.agreement === 'LOW')
    return `Model spread too wide (${consensus.model_spread_f}°F) — GFS/ECMWF/ICON/HRRR disagree. Waiting for convergence`;

  if (!analysis) return `Market found but analysis not yet run — next scan in ~20 min`;

  if (analysis.direction === 'PASS' && analysis.edge !== null) {
    const edgeN = normalizeEdge(analysis.edge);
    if (edgeN < 0.02)
      return `Edge too small (${(edgeN * 100).toFixed(1)}%) — market is efficiently priced`;
    return analysis.reasoning || 'Analysis found no actionable mispricing';
  }

  if (analysis.edge === null || analysis.edge === 0)
    return 'Market price aligns with model consensus — no mispricing detected';

  if (market.liquidity_usd < 10000)
    return `Market liquidity too low ($${(market.liquidity_usd / 1000).toFixed(0)}K) — minimum $10K for safe entry`;

  return analysis.reasoning || 'No actionable edge — models and market agree';
}

// ============================================================
// City Detail Component (Drawer) — full breakdown
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

  const nws = forecasts.find((f) => f.source === 'nws');
  const gfs = forecasts.find((f) => f.source === 'gfs');
  const ecmwf = forecasts.find((f) => f.source === 'ecmwf');
  const icon = forecasts.find((f) => f.source === 'icon');
  const hrrr = forecasts.find((f) => f.source === 'hrrr');

  const edgeNorm = normalizeEdge(analysis?.edge);
  const trueProbNorm = normalizeProb(analysis?.true_prob);
  const mktPriceNorm = normalizeProb(analysis?.market_price);
  const hasEdge = analysis && analysis.edge !== null && edgeNorm > 0.05;
  const passReason = getPassReason(card);
  const hasEnsemble = consensus?.ensemble_members && consensus.ensemble_members > 0;

  return (
    <div className="space-y-6">
      {/* Decision Summary */}
      <div className={`rounded-lg p-4 ${hasEdge ? 'bg-arbiter-amber/10 border border-arbiter-amber/30' : 'bg-arbiter-bg border border-arbiter-border'}`}>
        <div className="flex items-center gap-2 mb-2">
          <div className={`w-2 h-2 rounded-full ${hasEdge ? 'bg-arbiter-amber' : 'bg-arbiter-text-3'}`} />
          <span className="text-xs font-medium uppercase tracking-wider">
            {hasEdge ? 'Edge Detected' : 'No Bet'}
          </span>
          {hasEnsemble && (
            <span className="text-[10px] px-1.5 py-0.5 bg-green-500/10 text-green-400 rounded font-mono">
              {consensus!.ensemble_members}-MEMBER ENSEMBLE
            </span>
          )}
        </div>
        {hasEdge ? (
          <p className="text-sm text-arbiter-text-2 leading-relaxed">
            {hasEnsemble ? (
              <>
                <span className="text-green-400 font-mono">{consensus!.ensemble_members}</span> ensemble members predict{' '}
                <span className="text-arbiter-text font-mono">{consensus?.consensus_high_f}°F</span>.{' '}
              </>
            ) : (
              <>
                Models predict <span className="text-arbiter-text font-mono">{consensus?.consensus_high_f}°F</span> with{' '}
                <span className="text-arbiter-text font-mono">{consensus?.agreement}</span> agreement.{' '}
              </>
            )}
            Market prices <span className="text-arbiter-text font-mono">{analysis!.best_outcome_label}</span> at{' '}
            <span className="text-arbiter-text font-mono">{Math.round(mktPriceNorm * 100)}¢</span> but
            true probability is <span className="text-arbiter-text font-mono">{(trueProbNorm * 100).toFixed(0)}%</span>,
            giving a <span className="text-arbiter-amber font-mono">+{(edgeNorm * 100).toFixed(1)}%</span> advantage.
          </p>
        ) : (
          <p className="text-sm text-arbiter-text-2 leading-relaxed">{passReason}</p>
        )}
      </div>

      {/* Forecast Models */}
      <div>
        <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider mb-2">
          Forecast Models ({consensus?.models_used?.length || 0} sources)
        </h3>
        <div className="bg-arbiter-bg rounded-lg p-3 space-y-1">
          {hrrr && (
            <StatRow label="HRRR 3km" value={`${hrrr.temp_high_f}°F / ${hrrr.temp_low_f}°F`} valueColor="text-green-400" />
          )}
          {nws && (
            <StatRow label="NWS Official" value={`${nws.temp_high_f}°F / ${nws.temp_low_f}°F`} />
          )}
          <StatRow
            label="GFS"
            value={gfs ? `${gfs.temp_high_f}°F / ${gfs.temp_low_f}°F` : 'N/A'}
            valueColor={gfs ? undefined : 'text-arbiter-text-3'}
          />
          <StatRow
            label="ECMWF"
            value={ecmwf ? `${ecmwf.temp_high_f}°F / ${ecmwf.temp_low_f}°F` : 'N/A'}
            valueColor={ecmwf ? undefined : 'text-arbiter-text-3'}
          />
          <StatRow
            label="ICON"
            value={icon ? `${icon.temp_high_f}°F / ${icon.temp_low_f}°F` : 'N/A'}
            valueColor={icon ? undefined : 'text-arbiter-text-3'}
          />
          {consensus && (
            <>
              <div className="border-t border-arbiter-border my-2" />
              <StatRow
                label="Weighted Consensus"
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

      {/* Precipitation Data (if available) */}
      {consensus && ((consensus.precip_consensus_mm ?? 0) > 0 || (consensus.snowfall_consensus_cm ?? 0) > 0) && (
        <div>
          <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider mb-2">
            Precipitation & Snow
          </h3>
          <div className="bg-arbiter-bg rounded-lg p-3 space-y-1">
            {(consensus.precip_consensus_mm ?? 0) > 0 && (
              <StatRow label="Precip Consensus" value={`${consensus.precip_consensus_mm}mm`} />
            )}
            {(consensus.snowfall_consensus_cm ?? 0) > 0 && (
              <StatRow label="Snowfall Consensus" value={`${consensus.snowfall_consensus_cm}cm`} />
            )}
            {consensus.precip_agreement && (
              <StatRow label="Precip Agreement" value={consensus.precip_agreement} />
            )}
          </div>
        </div>
      )}

      {/* Bracket Analysis */}
      {market && (
        <div>
          <h3 className="text-xs text-arbiter-text-3 uppercase tracking-wider mb-2">
            Market Brackets
          </h3>
          <div className="bg-arbiter-bg rounded-lg overflow-hidden">
            <div className="grid grid-cols-4 gap-2 px-3 py-2 text-[10px] text-arbiter-text-3 uppercase tracking-wider border-b border-arbiter-border">
              <span>Outcome</span>
              <span className="text-right">Mkt Price</span>
              <span className="text-right">Est Prob</span>
              <span className="text-right">Edge</span>
            </div>
            {market.outcomes.map((outcome, i) => {
              const mktPrice = market.outcome_prices[i] || 0;
              const isBest = analysis?.best_outcome_idx === i;
              const edgeVal = isBest ? edgeNorm : 0;
              const trueProbVal = isBest ? trueProbNorm : 0;

              return (
                <div
                  key={i}
                  className={`grid grid-cols-4 gap-2 px-3 py-2 text-xs ${
                    isBest
                      ? 'bg-arbiter-amber/10 border-l-2 border-l-arbiter-amber'
                      : 'border-l-2 border-l-transparent'
                  }`}
                >
                  <span className="font-mono truncate">{outcome}</span>
                  <span className="font-mono text-right">${mktPrice.toFixed(2)}</span>
                  <span className="font-mono text-right">
                    {isBest ? `${(trueProbVal * 100).toFixed(0)}%` : '—'}
                  </span>
                  <span
                    className={`font-mono text-right ${
                      edgeVal > 0.05 ? 'text-arbiter-amber font-medium' : edgeVal > 0 ? 'text-arbiter-green' : 'text-arbiter-text-3'
                    }`}
                  >
                    {isBest ? `${edgeVal > 0 ? '+' : ''}${(edgeVal * 100).toFixed(1)}%` : '—'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Kelly + Reasoning */}
      {analysis && analysis.edge !== null && edgeNorm > 0 && (
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
            onClick={() => {}}
            className="px-4 py-3 rounded-lg text-sm text-arbiter-text-2 border border-arbiter-border hover:bg-arbiter-card min-h-[44px]"
          >
            SKIP
          </button>
        </div>
      )}

      {/* No edge state */}
      {(!analysis || analysis.direction === 'PASS' || !hasEdge) && (
        <div className="bg-arbiter-bg rounded-lg p-4 text-center">
          <div className="text-arbiter-text-3 text-xs uppercase tracking-wider mb-1">
            No Bet Recommended
          </div>
          <div className="text-xs text-arbiter-text-3 leading-relaxed max-w-sm mx-auto">
            {passReason}
          </div>
        </div>
      )}
    </div>
  );
}
