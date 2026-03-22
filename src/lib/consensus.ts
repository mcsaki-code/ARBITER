// ============================================================
// Model Consensus Calculator — V2: Temp + Precip + Ensemble
// ============================================================

import { AgreementLevel, WeatherForecast } from './types';
import { EnsembleForecastResult } from './open-meteo';

export interface ConsensusResult {
  valid_date: string;
  consensus_high_f: number;
  consensus_low_f: number;
  model_spread_f: number;
  agreement: AgreementLevel;
  models_used: string[];
  // Precipitation
  precip_consensus_mm: number;
  precip_agreement: AgreementLevel;
  snowfall_consensus_cm: number;
  // Ensemble (if available)
  ensemble_members: number | null;
  ensemble_prob_above: Record<number, number> | null;
  ensemble_prob_below: Record<number, number> | null;
}

export function getAgreement(spread: number): AgreementLevel {
  if (spread <= 2) return 'HIGH';
  if (spread <= 5) return 'MEDIUM';
  return 'LOW';
}

// Precipitation agreement based on how much models disagree on total precip
function getPrecipAgreement(precipValues: number[]): AgreementLevel {
  if (precipValues.length < 2) return 'LOW';
  const max = Math.max(...precipValues);
  const min = Math.min(...precipValues);
  const spread = max - min;
  // For precip in mm: <2mm spread = good agreement, <5mm = medium
  if (spread <= 2) return 'HIGH';
  if (spread <= 5) return 'MEDIUM';
  return 'LOW';
}

// ============================================================
// Dynamic model weighting based on forecast horizon and region
// ECMWF: best at 3+ days, globally
// GFS: best at 0-48h, US (updates 4x/day)
// HRRR: best at 0-18h, US only (3km resolution)
// ICON: best for European precip
// NWS: best official source, US only
// ============================================================
function getModelWeight(
  source: string,
  daysAhead: number,
  isUS: boolean
): number {
  const weights: Record<string, number> = {
    hrrr: 0, gfs: 1.0, ecmwf: 1.0, icon: 1.0, nws: 1.0,
  };

  if (source === 'hrrr') {
    // HRRR is king for 0-18h, good for 0-48h, nothing beyond
    if (daysAhead <= 1) weights.hrrr = 1.5;
    else if (daysAhead <= 2) weights.hrrr = 1.1;
    else weights.hrrr = 0; // no data beyond 2 days
  }

  if (source === 'ecmwf') {
    // ECMWF excels at longer range
    if (daysAhead >= 3) weights.ecmwf = 1.3;
    else weights.ecmwf = 1.1;
  }

  if (source === 'gfs') {
    // GFS good for short range, especially US
    if (daysAhead <= 2 && isUS) weights.gfs = 1.15;
    else weights.gfs = 1.0;
  }

  if (source === 'nws' && isUS) {
    // NWS is the resolution source — very valuable for short range
    if (daysAhead <= 1) weights.nws = 1.4;
    else if (daysAhead <= 2) weights.nws = 1.2;
    else weights.nws = 0.9;
  }

  return weights[source] ?? 1.0;
}

export function calculateConsensus(
  forecasts: WeatherForecast[],
  validDate: string,
  ensembleData?: EnsembleForecastResult | null,
  isUS: boolean = true
): ConsensusResult | null {
  const dayForecasts = forecasts.filter(
    (f) => f.valid_date === validDate && f.temp_high_f !== null
  );

  if (dayForecasts.length < 2) return null;

  // Calculate days ahead for weighting
  const today = new Date();
  const forecastDate = new Date(validDate);
  const daysAhead = Math.round(
    (forecastDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
  );

  // Weighted temperature consensus
  let weightedHighSum = 0;
  let weightedLowSum = 0;
  let totalWeight = 0;
  const highs: number[] = [];
  const lows: number[] = [];
  const sources: string[] = [];

  for (const f of dayForecasts) {
    const weight = getModelWeight(f.source, daysAhead, isUS);
    if (weight <= 0) continue;

    highs.push(f.temp_high_f!);
    lows.push(f.temp_low_f ?? f.temp_high_f! - 15); // fallback low
    sources.push(f.source);
    weightedHighSum += f.temp_high_f! * weight;
    weightedLowSum += (f.temp_low_f ?? f.temp_high_f! - 15) * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return null;

  const consensusHigh = weightedHighSum / totalWeight;
  const consensusLow = weightedLowSum / totalWeight;
  const spread = Math.max(...highs) - Math.min(...highs);

  // Precipitation consensus (weighted)
  const precipForecasts = dayForecasts.filter(
    (f) => f.precip_mm !== null && f.precip_mm !== undefined
  );
  const precipValues = precipForecasts.map((f) => f.precip_mm ?? 0);
  const precipConsensus = precipValues.length > 0
    ? precipValues.reduce((a, b) => a + b, 0) / precipValues.length
    : 0;

  // Snowfall consensus
  const snowForecasts = dayForecasts.filter(
    (f) => f.snowfall_cm !== null && f.snowfall_cm !== undefined
  );
  const snowValues = snowForecasts.map((f) => f.snowfall_cm ?? 0);
  const snowConsensus = snowValues.length > 0
    ? snowValues.reduce((a, b) => a + b, 0) / snowValues.length
    : 0;

  return {
    valid_date: validDate,
    consensus_high_f: Math.round(consensusHigh),
    consensus_low_f: Math.round(consensusLow),
    model_spread_f: Math.round(spread * 10) / 10,
    agreement: getAgreement(spread),
    models_used: sources,
    precip_consensus_mm: Math.round(precipConsensus * 100) / 100,
    precip_agreement: getPrecipAgreement(precipValues),
    snowfall_consensus_cm: Math.round(snowConsensus * 10) / 10,
    ensemble_members: ensembleData?.members ?? null,
    ensemble_prob_above: ensembleData?.prob_above ?? null,
    ensemble_prob_below: ensembleData?.prob_below ?? null,
  };
}

// ============================================================
// Ensemble-powered bracket probability calculator
// This is the core edge: map ensemble distribution to market brackets
// ============================================================
export function calculateBracketProbabilities(
  ensemble: EnsembleForecastResult,
  brackets: { label: string; min: number; max: number }[]
): { label: string; prob: number }[] {
  const { temp_highs_f, members } = ensemble;

  return brackets.map((bracket) => {
    const count = temp_highs_f.filter(
      (t) => t >= bracket.min && t < bracket.max
    ).length;
    return {
      label: bracket.label,
      prob: Math.round((count / members) * 1000) / 1000,
    };
  });
}

// ============================================================
// Parse temperature brackets from Polymarket outcome labels
// e.g., "44-45°F" → { min: 44, max: 46 }
// e.g., "Below 40°F" → { min: -100, max: 40 }
// e.g., "80°F or above" → { min: 80, max: 200 }
// ============================================================
export function parseBrackets(
  outcomes: string[]
): { label: string; min: number; max: number }[] {
  return outcomes.map((label) => {
    const l = label.toLowerCase().replace(/\s+/g, ' ').trim();

    // "Below X" or "Under X" or "Less than X"
    const belowMatch = l.match(/(?:below|under|less than|<)\s*(\d+)/);
    if (belowMatch) {
      return { label, min: -100, max: parseInt(belowMatch[1]) };
    }

    // "X or above" or "Above X" or "X+" or "X or higher" or ">= X"
    const aboveMatch = l.match(/(\d+)\s*(?:or above|or higher|\+|°f\s*or\s*above|\s*or\s*more)/i)
      || l.match(/(?:above|over|greater than|more than|>=|≥)\s*(\d+)/);
    if (aboveMatch) {
      return { label, min: parseInt(aboveMatch[1]), max: 200 };
    }

    // Range: "X-Y" or "X to Y" or "X–Y" (em-dash)
    const rangeMatch = l.match(/(\d+)\s*[-–to]+\s*(\d+)/);
    if (rangeMatch) {
      return {
        label,
        min: parseInt(rangeMatch[1]),
        max: parseInt(rangeMatch[2]) + 1, // inclusive upper bound
      };
    }

    // Single temp: "X°F"
    const singleMatch = l.match(/(\d+)\s*°/);
    if (singleMatch) {
      const t = parseInt(singleMatch[1]);
      return { label, min: t, max: t + 1 };
    }

    // Fallback — can't parse
    return { label, min: -999, max: -999 };
  });
}

// ============================================================
// Detect market type from question text
// ============================================================
export function detectMarketType(
  question: string
): 'temperature_high' | 'temperature_low' | 'precipitation' | 'snowfall' | 'climate' | 'other' {
  const q = question.toLowerCase();

  if (q.includes('precipitation') || q.includes('rainfall') || q.includes('rain')) {
    return 'precipitation';
  }
  if (q.includes('snowfall') || q.includes('snow')) {
    return 'snowfall';
  }
  if (q.includes('low temp') || q.includes('lowest temp') || q.includes('daily low') || q.includes('overnight low')) {
    return 'temperature_low';
  }
  if (q.includes('global temp') || q.includes('climate') || q.includes('hottest year') || q.includes('warmest year')) {
    return 'climate';
  }
  if (
    q.includes('temperature') || q.includes('high temp') || q.includes('highest temp') ||
    q.includes('daily high') || q.includes('°f') || q.includes('°c') ||
    q.includes('degrees')
  ) {
    return 'temperature_high';
  }

  return 'other';
}
