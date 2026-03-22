// ============================================================
// ARBITER — Type Definitions (Phase 1)
// ============================================================

export interface WeatherCity {
  id: string;
  name: string;
  lat: number;
  lon: number;
  nws_office: string | null;
  nws_grid_x: number | null;
  nws_grid_y: number | null;
  timezone: string;
  is_active: boolean;
}

export interface WeatherForecast {
  id: string;
  city_id: string;
  fetched_at: string;
  valid_date: string;
  source: 'nws' | 'gfs' | 'ecmwf' | 'icon' | 'hrrr';
  temp_high_f: number | null;
  temp_low_f: number | null;
  precip_prob: number | null;
  precip_mm: number | null;
  rain_mm: number | null;
  snowfall_cm: number | null;
  wind_speed_max: number | null;
  wind_gust_max: number | null;
  cloud_cover_pct: number | null;
  weather_code: number | null;
  conditions: string | null;
}

export type AgreementLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export interface WeatherConsensus {
  id: string;
  city_id: string;
  calculated_at: string;
  valid_date: string;
  consensus_high_f: number;
  consensus_low_f: number | null;
  model_spread_f: number;
  agreement: AgreementLevel;
  models_used: string[];
  // Precipitation consensus
  precip_consensus_mm: number | null;
  precip_agreement: AgreementLevel | null;
  snowfall_consensus_cm: number | null;
  // Ensemble data
  ensemble_members: number | null;
  ensemble_prob_above: Record<number, number> | null;
  ensemble_prob_below: Record<number, number> | null;
}

export type WeatherMarketType = 'temperature_high' | 'temperature_low' | 'precipitation' | 'snowfall' | 'climate' | 'other';

export interface Market {
  id: string;
  condition_id: string;
  platform: string;
  question: string;
  category: string | null;
  market_type: WeatherMarketType | null;
  city_id: string | null;
  outcomes: string[];
  outcome_prices: number[];
  volume_usd: number;
  liquidity_usd: number;
  resolution_date: string | null;
  is_active: boolean;
  is_resolved: boolean;
  resolution_val: string | null;
  created_at: string;
  updated_at: string;
}

export type Direction = 'BUY_YES' | 'BUY_NO' | 'PASS';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface WeatherAnalysis {
  id: string;
  market_id: string;
  city_id: string;
  consensus_id: string;
  analyzed_at: string;
  model_high_f: number | null;
  model_spread_f: number | null;
  model_agreement: AgreementLevel | null;
  market_type: WeatherMarketType | null;
  best_outcome_idx: number | null;
  best_outcome_label: string | null;
  market_price: number | null;
  true_prob: number | null;
  edge: number | null;
  direction: Direction;
  confidence: Confidence;
  kelly_fraction: number | null;
  rec_bet_usd: number | null;
  reasoning: string | null;
  auto_eligible: boolean;
  ensemble_prob: number | null;
  ensemble_edge: number | null;
  precip_consensus: number | null;
  flags: string[];
}

export type BetStatus = 'OPEN' | 'WON' | 'LOST' | 'PUSHED';
export type OrderStatus = 'NONE' | 'PENDING' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED' | 'REJECTED' | 'EXPIRED';

export interface Bet {
  id: string;
  market_id: string;
  analysis_id: string | null;
  placed_at: string;
  category: string;
  direction: Direction;
  outcome_label: string | null;
  entry_price: number;
  amount_usd: number;
  is_paper: boolean;
  exit_price: number | null;
  pnl: number | null;
  status: BetStatus;
  resolved_at: string | null;
  notes: string | null;
  // Live trading fields (null for paper bets)
  clob_order_id: string | null;
  transaction_hash: string | null;
  filled_price: number | null;
  filled_size: number | null;
  condition_id: string | null;
  token_id: string | null;
  order_status: OrderStatus;
  // Joined from markets table
  market_question?: string | null;
  current_prices?: number[] | null;
  // Joined from analysis tables
  reasoning?: string | null;
}

export interface PerformanceSnapshot {
  id: string;
  snapshot_date: string;
  total_bets: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  total_pnl: number;
  paper_bankroll: number;
  real_bankroll: number;
}

export interface SystemConfig {
  key: string;
  value: string;
  updated_at: string;
}

// ============================================================
// Claude Analysis Response Types
// ============================================================

export interface ClaudeOutcomeAnalysis {
  index: number;
  label: string;
  market_price: number;
  true_prob: number;
  edge: number;
}

export interface ClaudeBestBet {
  outcome_index: number;
  outcome_label: string;
  market_price: number;
  true_prob: number;
  edge: number;
  direction: Direction;
  confidence: Confidence;
  kelly_fraction: number;
  reasoning: string;
}

export interface ClaudeWeatherResponse {
  city: string;
  consensus_high_f: number;
  spread_f: number;
  agreement: AgreementLevel;
  best_bet: ClaudeBestBet | null;
  all_outcomes: ClaudeOutcomeAnalysis[];
  auto_eligible: boolean;
  flags: string[];
}

// ============================================================
// Kelly Calculator Types
// ============================================================

export interface KellyParams {
  trueProb: number;
  marketPrice: number;
  confidence: Confidence;
  liquidity: number;
  bankroll: number;
}

export interface KellyResult {
  fraction: number;
  amountUsd: number;
  eligible: boolean;
}

// ============================================================
// UI Types
// ============================================================

export interface CityWeatherCard {
  city: WeatherCity;
  consensus: WeatherConsensus | null;
  market: Market | null;
  analysis: WeatherAnalysis | null;
  forecasts: WeatherForecast[];
}

export type DataState = 'loading' | 'error' | 'empty' | 'stale' | 'fresh';
