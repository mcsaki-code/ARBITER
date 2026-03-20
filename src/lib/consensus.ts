// ============================================================
// Model Consensus Calculator
// ============================================================

import { AgreementLevel, WeatherForecast } from './types';

export interface ConsensusResult {
  valid_date: string;
  consensus_high_f: number;
  model_spread_f: number;
  agreement: AgreementLevel;
  models_used: string[];
}

export function getAgreement(spread: number): AgreementLevel {
  if (spread <= 2) return 'HIGH';
  if (spread <= 5) return 'MEDIUM';
  return 'LOW';
}

export function calculateConsensus(
  forecasts: WeatherForecast[],
  validDate: string
): ConsensusResult | null {
  // Filter forecasts for this date that have high temp data
  const dayForecasts = forecasts.filter(
    (f) => f.valid_date === validDate && f.temp_high_f !== null
  );

  if (dayForecasts.length < 2) return null;

  const highs = dayForecasts.map((f) => f.temp_high_f!);
  const sources = dayForecasts.map((f) => f.source);
  const spread = Math.max(...highs) - Math.min(...highs);
  const avg = highs.reduce((a, b) => a + b, 0) / highs.length;

  return {
    valid_date: validDate,
    consensus_high_f: Math.round(avg),
    model_spread_f: Math.round(spread * 10) / 10,
    agreement: getAgreement(spread),
    models_used: sources,
  };
}
