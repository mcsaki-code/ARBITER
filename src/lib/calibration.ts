// ============================================================
// Per-City Calibration Weights & Bias Corrections
// Based on consensus predictions vs weather_actuals analysis
// ============================================================

export interface CityCalibration {
  weight: number;      // Model accuracy weight [0, 1]
  bias_f: number;      // Systematic bias in °F (negative = underpredict)
  mae_f: number;       // Mean Absolute Error in °F
  tier: number;        // Confidence tier 1-4
}

// Tier 1: High confidence (weight 0.85+, MAE ≤1.2°F)
const TIER_1: Record<string, CityCalibration> = {
  'Mexico City': { weight: 0.871, bias_f: -0.62, mae_f: 0.74, tier: 1 },
  'Salt Lake City': { weight: 0.853, bias_f: -0.27, mae_f: 0.86, tier: 1 },
  'Portland': { weight: 0.834, bias_f: -0.27, mae_f: 1.00, tier: 1 },
  'Tokyo': { weight: 0.829, bias_f: -1.03, mae_f: 1.03, tier: 1 },
  'São Paulo': { weight: 0.813, bias_f: 1.15, mae_f: 1.15, tier: 1 },
  'Dallas': { weight: 0.809, bias_f: -0.76, mae_f: 1.18, tier: 1 },
};

// Tier 2: Good confidence (weight 0.75-0.85, MAE 1.2-2.0°F)
const TIER_2: Record<string, CityCalibration> = {
  'Orlando': { weight: 0.805, bias_f: 0.27, mae_f: 1.21, tier: 2 },
  'Sacramento': { weight: 0.793, bias_f: 0.50, mae_f: 1.31, tier: 2 },
  'Tampa': { weight: 0.790, bias_f: 1.30, mae_f: 1.33, tier: 2 },
  'Miami': { weight: 0.786, bias_f: 1.37, mae_f: 1.37, tier: 2 },
  'Phoenix': { weight: 0.781, bias_f: -1.03, mae_f: 1.40, tier: 2 },
  'St. Louis': { weight: 0.768, bias_f: -0.38, mae_f: 1.51, tier: 2 },
  'Minneapolis': { weight: 0.763, bias_f: -1.34, mae_f: 1.55, tier: 2 },
  'Columbus': { weight: 0.758, bias_f: -1.13, mae_f: 1.59, tier: 2 },
  'Atlanta': { weight: 0.750, bias_f: -1.43, mae_f: 1.67, tier: 2 },
  'Oklahoma City': { weight: 0.749, bias_f: -0.09, mae_f: 1.68, tier: 2 },
  'Seattle': { weight: 0.726, bias_f: -1.31, mae_f: 1.88, tier: 2 },
  'Pittsburgh': { weight: 0.716, bias_f: -0.08, mae_f: 1.99, tier: 2 },
};

// Tier 3: Moderate confidence (weight 0.65-0.75, MAE 2.0-3.0°F)
const TIER_3: Record<string, CityCalibration> = {
  'Indianapolis': { weight: 0.708, bias_f: 0.0, mae_f: 2.0, tier: 3 },
  'Buenos Aires': { weight: 0.698, bias_f: 0.0, mae_f: 2.1, tier: 3 },
  'Austin': { weight: 0.691, bias_f: 0.0, mae_f: 2.2, tier: 3 },
  'Houston': { weight: 0.690, bias_f: 0.0, mae_f: 2.2, tier: 3 },
  'Raleigh': { weight: 0.678, bias_f: 0.0, mae_f: 2.3, tier: 3 },
  'Memphis': { weight: 0.676, bias_f: 0.0, mae_f: 2.3, tier: 3 },
  'Milwaukee': { weight: 0.674, bias_f: 0.0, mae_f: 2.4, tier: 3 },
  'Los Angeles': { weight: 0.672, bias_f: 0.0, mae_f: 2.4, tier: 3 },
  'Jacksonville': { weight: 0.665, bias_f: 0.0, mae_f: 2.5, tier: 3 },
  'San Diego': { weight: 0.661, bias_f: 0.0, mae_f: 2.5, tier: 3 },
  'Charlotte': { weight: 0.661, bias_f: 0.0, mae_f: 2.5, tier: 3 },
  'Detroit': { weight: 0.660, bias_f: 0.0, mae_f: 2.5, tier: 3 },
  'Las Vegas': { weight: 0.659, bias_f: 0.0, mae_f: 2.6, tier: 3 },
  'Toronto': { weight: 0.658, bias_f: 0.0, mae_f: 2.6, tier: 3 },
  'San Antonio': { weight: 0.657, bias_f: 0.0, mae_f: 2.6, tier: 3 },
  'Cincinnati': { weight: 0.653, bias_f: 0.0, mae_f: 2.7, tier: 3 },
  'New Orleans': { weight: 0.649, bias_f: 0.0, mae_f: 2.7, tier: 3 },
};

// Tier 4: Low confidence (weight <0.65, MAE >3.0°F)
const TIER_4: Record<string, CityCalibration> = {
  'Washington DC': { weight: 0.622, bias_f: 0.0, mae_f: 3.0, tier: 4 },
  'Chicago': { weight: 0.608, bias_f: 0.0, mae_f: 3.2, tier: 4 },
  'Nashville': { weight: 0.603, bias_f: 0.0, mae_f: 3.2, tier: 4 },
  'Kansas City': { weight: 0.599, bias_f: 0.0, mae_f: 3.3, tier: 4 },
  'Denver': { weight: 0.583, bias_f: 0.0, mae_f: 3.4, tier: 4 },
  'Philadelphia': { weight: 0.560, bias_f: 0.0, mae_f: 3.6, tier: 4 },
  'San Francisco': { weight: 0.553, bias_f: 0.0, mae_f: 3.7, tier: 4 },
  'Baltimore': { weight: 0.541, bias_f: 0.0, mae_f: 3.8, tier: 4 },
  'New York City': { weight: 0.507, bias_f: 0.0, mae_f: 4.0, tier: 4 },
  'Boston': { weight: 0.499, bias_f: 0.0, mae_f: 4.1, tier: 4 },
  'Omaha': { weight: 0.497, bias_f: 0.0, mae_f: 4.1, tier: 4 },
  'Cleveland': { weight: 0.355, bias_f: 0.0, mae_f: 4.5, tier: 4 },
};

// International cities without enough consensus data yet (default weight 0.75)
const INTERNATIONAL_DEFAULT: Record<string, CityCalibration> = {
  'Seoul': { weight: 0.75, bias_f: 0.0, mae_f: 2.0, tier: 3 },
  'Singapore': { weight: 0.75, bias_f: 0.0, mae_f: 2.0, tier: 3 },
  'Wellington': { weight: 0.75, bias_f: 0.0, mae_f: 2.0, tier: 3 },
  'London': { weight: 0.75, bias_f: 0.0, mae_f: 2.0, tier: 3 },
  'Paris': { weight: 0.75, bias_f: 0.0, mae_f: 2.0, tier: 3 },
  'Istanbul': { weight: 0.75, bias_f: 0.0, mae_f: 2.0, tier: 3 },
  'Madrid': { weight: 0.75, bias_f: 0.0, mae_f: 2.0, tier: 3 },
};

// Combine all calibration data
const ALL_CALIBRATIONS: Record<string, CityCalibration> = {
  ...TIER_1,
  ...TIER_2,
  ...TIER_3,
  ...TIER_4,
  ...INTERNATIONAL_DEFAULT,
};

/**
 * Get calibration data for a city
 * @param cityName City name to look up
 * @returns Calibration object with weight, bias, MAE, and tier
 */
export function getCityCalibration(cityName: string): CityCalibration {
  const calibration = ALL_CALIBRATIONS[cityName];
  if (!calibration) {
    // Default for unknown cities: moderate confidence (Tier 3)
    return { weight: 0.70, bias_f: 0.0, mae_f: 2.5, tier: 3 };
  }
  return calibration;
}

/**
 * Get edge multiplier based on city's confidence tier
 * Tier 1 (most reliable) → 1.0x, Tier 4 (least reliable) → 0.5x
 * This dampens edges from unreliable cities
 * @param cityName City name to look up
 * @returns Multiplier [0, 1] to apply to raw edge
 */
export function getEdgeMultiplier(cityName: string): number {
  const calibration = getCityCalibration(cityName);
  const tierMultipliers: Record<number, number> = {
    1: 1.0,   // Tier 1: full edge
    2: 0.9,   // Tier 2: 90% of edge
    3: 0.75,  // Tier 3: 75% of edge
    4: 0.5,   // Tier 4: 50% of edge
  };
  return tierMultipliers[calibration.tier] || 0.75;
}

/**
 * Get systematic bias correction for a city
 * Positive bias = models overpredict temps, negative = underpredict
 * Example: Mexico City has -0.62°F bias → models run 0.62°F too cold
 * @param cityName City name to look up
 * @returns Bias in °F to warn Claude about
 */
export function getBiasCorrection(cityName: string): number {
  const calibration = getCityCalibration(cityName);
  return calibration.bias_f;
}

/**
 * Get human-readable tier description
 * @param cityName City name to look up
 * @returns Tier description with accuracy context
 */
export function getTierDescription(cityName: string): string {
  const calibration = getCityCalibration(cityName);
  const descriptions: Record<number, string> = {
    1: 'High confidence (MAE ≤1.2°F)',
    2: 'Good confidence (MAE 1.2-2.0°F)',
    3: 'Moderate confidence (MAE 2.0-3.0°F)',
    4: 'Low confidence (MAE >3.0°F)',
  };
  return descriptions[calibration.tier] || 'Unknown confidence';
}

/**
 * Build calibration context string for Claude prompt
 * @param cityName City name to look up
 * @returns Formatted string describing forecast accuracy and bias
 */
export function getCalibrationContext(cityName: string): string {
  const calibration = getCityCalibration(cityName);
  const tierDesc = getTierDescription(cityName);
  const biasStr =
    calibration.bias_f === 0
      ? 'neutral (no systematic bias)'
      : calibration.bias_f < 0
        ? `negative bias: models underpredict highs by ${Math.abs(calibration.bias_f).toFixed(2)}°F`
        : `positive bias: models overpredict highs by ${calibration.bias_f.toFixed(2)}°F`;

  return `CALIBRATION (${cityName}):
- Forecast accuracy: ${tierDesc}
- Systematic bias: ${biasStr}
- Mean Absolute Error: ${calibration.mae_f.toFixed(2)}°F
- Adjust confidence DOWN if this city has low calibration. Reduce edge sizing for Tier 4 cities.`;
}
