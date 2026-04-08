// ============================================================
// ARBITER — Runtime Validation for Claude Analysis Responses
// ============================================================
// Zero-dependency validation layer. Rejects malformed Claude
// responses at the boundary instead of letting bad data
// propagate through Kelly sizing, bet placement, and P&L.
//
// Every analyzer should call the appropriate validate*() function
// immediately after JSON.parse() and BEFORE any normalization.
// If validation fails, the analysis is skipped with a log.
// ============================================================

export type ValidationResult<T> = { valid: true, data: T } | { valid: false, errors: string[] }

// ── Primitive validators ────────────────────────────────────

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && !isNaN(v) && isFinite(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function isDirection(v: unknown): v is 'BUY_YES' | 'BUY_NO' | 'PASS' {
  return v === 'BUY_YES' || v === 'BUY_NO' || v === 'PASS';
}

function isConfidence(v: unknown): v is 'HIGH' | 'MEDIUM' | 'LOW' {
  return v === 'HIGH' || v === 'MEDIUM' || v === 'LOW';
}

// ── Shared: normalize values that Claude returns inconsistently ──

/** Normalize a probability/price to 0-1 range */
export function normalizeProb(raw: unknown): number | null {
  if (!isNumber(raw)) return null;
  if (raw > 1) return raw / 100;
  if (raw < 0) return null;
  return raw;
}

/** Normalize an edge value to 0-1 range (handles 849 → 0.849, 8.5 → 0.085) */
export function normalizeEdge(raw: unknown): number | null {
  if (!isNumber(raw)) return null;
  if (raw > 100) return raw / 1000;
  if (raw > 1)   return raw / 100;
  if (raw < -1)  return raw / -100; // negative edges from BUY_NO, normalize magnitude
  return raw;
}

// ── Crypto Analysis Schema ──────────────────────────────────

export interface ValidatedCryptoAnalysis {
  asset: string;
  spot_at_analysis: number;
  target_bracket: string;
  bracket_prob: number;   // 0-1 (normalized)
  market_price: number;   // 0-1 (normalized)
  edge: number;           // 0-1 (normalized, absolute value)
  direction: 'BUY_YES' | 'BUY_NO' | 'PASS';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  kelly_fraction: number;
  rec_bet_usd: number;
  reasoning: string;
  auto_eligible: boolean;
  flags: string[];
}

export function validateCryptoAnalysis(raw: unknown): ValidationResult<ValidatedCryptoAnalysis> {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return { valid: false, errors: ['Not an object'] };

  const r = raw as Record<string, unknown>;

  if (!isString(r.asset))               errors.push(`asset: expected string, got ${typeof r.asset}`);
  if (!isNumber(r.spot_at_analysis))    errors.push(`spot_at_analysis: expected number, got ${r.spot_at_analysis}`);
  if (!isString(r.target_bracket))      errors.push(`target_bracket: expected string, got ${typeof r.target_bracket}`);
  if (!isDirection(r.direction))        errors.push(`direction: expected BUY_YES|BUY_NO|PASS, got "${r.direction}"`);
  if (!isConfidence(r.confidence))      errors.push(`confidence: expected HIGH|MEDIUM|LOW, got "${r.confidence}"`);
  if (!isString(r.reasoning))           errors.push(`reasoning: expected string, got ${typeof r.reasoning}`);

  // Normalize probabilities and edge
  const bracketProb = normalizeProb(r.bracket_prob);
  const marketPrice = normalizeProb(r.market_price);
  const edge = normalizeEdge(r.edge);

  if (bracketProb === null)  errors.push(`bracket_prob: not a valid probability (${r.bracket_prob})`);
  if (marketPrice === null)  errors.push(`market_price: not a valid probability (${r.market_price})`);
  if (edge === null)         errors.push(`edge: not a valid number (${r.edge})`);

  // Sanity checks: detect obviously wrong values
  if (bracketProb !== null && (bracketProb < 0 || bracketProb > 1))
    errors.push(`bracket_prob: ${bracketProb} not in 0-1 after normalization`);
  if (marketPrice !== null && (marketPrice < 0 || marketPrice > 1))
    errors.push(`market_price: ${marketPrice} not in 0-1 after normalization`);
  // V3.2: Reject saturated-edge hallucinations outright instead of silently
  // capping at 0.50. Claude returning edge > 0.30 is almost always a model
  // error, and the old cap was responsible for the $27.47 loss on bet 8718a4c2.
  if (edge !== null && Math.abs(edge) > 0.30)
    errors.push(`edge: ${edge} exceeds 0.30 cap — rejected as likely hallucination`);

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    data: {
      asset: r.asset as string,
      spot_at_analysis: r.spot_at_analysis as number,
      target_bracket: r.target_bracket as string,
      bracket_prob: bracketProb!,
      market_price: marketPrice!,
      edge: Math.abs(edge!),
      direction: r.direction as 'BUY_YES' | 'BUY_NO' | 'PASS',
      confidence: r.confidence as 'HIGH' | 'MEDIUM' | 'LOW',
      kelly_fraction: isNumber(r.kelly_fraction) ? r.kelly_fraction : 0,
      rec_bet_usd: isNumber(r.rec_bet_usd) ? r.rec_bet_usd : 0,
      reasoning: r.reasoning as string,
      auto_eligible: isBoolean(r.auto_eligible) ? r.auto_eligible : false,
      flags: Array.isArray(r.flags) ? r.flags.filter(isString) : [],
    },
  };
}

// ── Sports Analysis Schema ──────────────────────────────────

export interface ValidatedSportsAnalysis {
  event_description: string;
  sport: string;
  sportsbook_consensus: number;  // 0-1
  polymarket_price: number;       // 0-1
  edge: number;                   // 0-1, absolute
  direction: 'BUY_YES' | 'BUY_NO' | 'PASS';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reasoning: string;
  auto_eligible: boolean;
  flags: string[];
}

export function validateSportsAnalysis(raw: unknown): ValidationResult<ValidatedSportsAnalysis> {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return { valid: false, errors: ['Not an object'] };

  const r = raw as Record<string, unknown>;

  if (!isString(r.event_description))  errors.push(`event_description: expected string`);
  if (!isDirection(r.direction))       errors.push(`direction: expected BUY_YES|BUY_NO|PASS, got "${r.direction}"`);
  if (!isConfidence(r.confidence))     errors.push(`confidence: expected HIGH|MEDIUM|LOW, got "${r.confidence}"`);
  if (!isString(r.reasoning))          errors.push(`reasoning: expected string`);

  const sbConsensus = normalizeProb(r.sportsbook_consensus);
  const pmPrice = normalizeProb(r.polymarket_price);
  const edge = normalizeEdge(r.edge);

  if (sbConsensus === null) errors.push(`sportsbook_consensus: invalid (${r.sportsbook_consensus})`);
  if (pmPrice === null)     errors.push(`polymarket_price: invalid (${r.polymarket_price})`);
  if (edge === null)        errors.push(`edge: invalid (${r.edge})`);
  if (edge !== null && Math.abs(edge) > 0.30)
    errors.push(`edge: ${edge} exceeds 0.30 cap — rejected as likely hallucination`);

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    data: {
      event_description: r.event_description as string,
      sport: isString(r.sport) ? r.sport as string : 'sports',
      sportsbook_consensus: sbConsensus!,
      polymarket_price: pmPrice!,
      edge: Math.abs(edge!),
      direction: r.direction as 'BUY_YES' | 'BUY_NO' | 'PASS',
      confidence: r.confidence as 'HIGH' | 'MEDIUM' | 'LOW',
      reasoning: r.reasoning as string,
      auto_eligible: isBoolean(r.auto_eligible) ? r.auto_eligible : false,
      flags: Array.isArray(r.flags) ? r.flags.filter(isString) : [],
    },
  };
}

// ── Weather Analysis Schema ─────────────────────────────────

export interface ValidatedWeatherAnalysis {
  best_bet: {
    outcome_idx: number;
    outcome_label: string;
    model_prob: number;    // 0-1
    market_price: number;  // 0-1
    edge: number;          // 0-1
    direction: 'BUY_YES' | 'BUY_NO' | 'PASS';
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    reasoning: string;
  };
  all_outcomes: Array<{
    label: string;
    model_prob: number;
    market_price: number;
    edge: number;
  }>;
  auto_eligible: boolean;
  flags: string[];
}

export function validateWeatherAnalysis(raw: unknown): ValidationResult<ValidatedWeatherAnalysis> {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return { valid: false, errors: ['Not an object'] };

  const r = raw as Record<string, unknown>;

  if (!r.best_bet || typeof r.best_bet !== 'object')
    return { valid: false, errors: ['best_bet: missing or not an object'] };

  const bb = r.best_bet as Record<string, unknown>;

  if (!isNumber(bb.outcome_idx))     errors.push(`best_bet.outcome_idx: expected number`);
  if (!isString(bb.outcome_label))   errors.push(`best_bet.outcome_label: expected string`);
  if (!isDirection(bb.direction))    errors.push(`best_bet.direction: expected BUY_YES|BUY_NO|PASS, got "${bb.direction}"`);
  if (!isConfidence(bb.confidence))  errors.push(`best_bet.confidence: expected HIGH|MEDIUM|LOW, got "${bb.confidence}"`);
  if (!isString(bb.reasoning))       errors.push(`best_bet.reasoning: expected string`);

  const modelProb = normalizeProb(bb.model_prob);
  const marketPrice = normalizeProb(bb.market_price);
  const edge = normalizeEdge(bb.edge);

  if (modelProb === null)   errors.push(`best_bet.model_prob: invalid (${bb.model_prob})`);
  if (marketPrice === null)  errors.push(`best_bet.market_price: invalid (${bb.market_price})`);
  if (edge === null)         errors.push(`best_bet.edge: invalid (${bb.edge})`);
  // V3.2: reject outright saturated-edge hallucinations (>0.35). The old
  // silent cap at 0.35 let through bets priced on inflated edges — we now
  // reject so the whole analysis is skipped, not just clamped.
  if (edge !== null && Math.abs(edge) > 0.35)
    errors.push(`best_bet.edge: ${edge} exceeds 0.35 weather cap — rejected as hallucination`);

  // Validate all_outcomes if present
  const allOutcomes: ValidatedWeatherAnalysis['all_outcomes'] = [];
  if (Array.isArray(r.all_outcomes)) {
    for (const o of r.all_outcomes) {
      if (o && typeof o === 'object') {
        const oo = o as Record<string, unknown>;
        allOutcomes.push({
          label: isString(oo.label) ? oo.label as string : '',
          model_prob: normalizeProb(oo.model_prob) ?? 0,
          market_price: normalizeProb(oo.market_price) ?? 0,
          edge: normalizeEdge(oo.edge) ?? 0,
        });
      }
    }
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    data: {
      best_bet: {
        outcome_idx: bb.outcome_idx as number,
        outcome_label: bb.outcome_label as string,
        model_prob: modelProb!,
        market_price: marketPrice!,
        edge: Math.abs(edge!),
        direction: bb.direction as 'BUY_YES' | 'BUY_NO' | 'PASS',
        confidence: bb.confidence as 'HIGH' | 'MEDIUM' | 'LOW',
        reasoning: bb.reasoning as string,
      },
      all_outcomes: allOutcomes,
      auto_eligible: isBoolean(r.auto_eligible) ? r.auto_eligible : false,
      flags: Array.isArray(r.flags) ? r.flags.filter(isString) : [],
    },
  };
}

// ── Politics Analysis Schema ────────────────────────────────

export interface ValidatedPoliticsAnalysis {
  question_summary: string;
  category: string;
  best_outcome_idx: number;
  best_outcome_label: string;
  market_price: number;    // 0-1
  true_prob: number;       // 0-1
  edge: number;            // 0-1
  direction: 'BUY_YES' | 'BUY_NO' | 'PASS';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reasoning: string;
  auto_eligible: boolean;
  flags: string[];
}

export function validatePoliticsAnalysis(raw: unknown): ValidationResult<ValidatedPoliticsAnalysis> {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return { valid: false, errors: ['Not an object'] };

  const r = raw as Record<string, unknown>;

  if (!isDirection(r.direction))    errors.push(`direction: expected BUY_YES|BUY_NO|PASS, got "${r.direction}"`);
  if (!isConfidence(r.confidence))  errors.push(`confidence: expected HIGH|MEDIUM|LOW, got "${r.confidence}"`);

  const marketPrice = normalizeProb(r.market_price);
  const trueProb = normalizeProb(r.true_prob);
  const edge = normalizeEdge(r.edge);

  if (marketPrice === null) errors.push(`market_price: invalid (${r.market_price})`);
  if (trueProb === null)    errors.push(`true_prob: invalid (${r.true_prob})`);
  if (edge === null)        errors.push(`edge: invalid (${r.edge})`);
  if (edge !== null && Math.abs(edge) > 0.30) errors.push(`edge: ${edge} exceeds 0.30 cap — rejected as likely hallucination`);

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    data: {
      question_summary: isString(r.question_summary) ? r.question_summary as string : '',
      category: isString(r.category) ? r.category as string : 'other',
      best_outcome_idx: isNumber(r.best_outcome_idx) ? r.best_outcome_idx as number : 0,
      best_outcome_label: isString(r.best_outcome_label) ? r.best_outcome_label as string : '',
      market_price: marketPrice!,
      true_prob: trueProb!,
      edge: Math.abs(edge!),
      direction: r.direction as 'BUY_YES' | 'BUY_NO' | 'PASS',
      confidence: r.confidence as 'HIGH' | 'MEDIUM' | 'LOW',
      reasoning: isString(r.reasoning) ? r.reasoning as string : '',
      auto_eligible: isBoolean(r.auto_eligible) ? r.auto_eligible : false,
      flags: Array.isArray(r.flags) ? r.flags.filter(isString) : [],
    },
  };
}

// ── Opportunity Analysis Schema ──────────────────────────

export interface ValidatedOpportunityAnalysis {
  direction: 'BUY_YES' | 'BUY_NO' | 'PASS';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  edge: number;           // 0-1 (normalized, capped at 0.50)
  true_prob: number;      // 0-1
  market_price: number;   // 0-1
  reasoning: string;
  auto_eligible: boolean;
  flags: string[];
  market_category: string;
}

export function validateOpportunityAnalysis(raw: unknown): ValidationResult<ValidatedOpportunityAnalysis> {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return { valid: false, errors: ['Not an object'] };

  const r = raw as Record<string, unknown>;

  if (!isDirection(r.direction))    errors.push(`direction: expected BUY_YES|BUY_NO|PASS, got "${r.direction}"`);
  if (!isConfidence(r.confidence))  errors.push(`confidence: expected HIGH|MEDIUM|LOW, got "${r.confidence}"`);

  const edge = normalizeEdge(r.edge);
  const trueProb = normalizeProb(r.true_prob);
  const marketPrice = normalizeProb(r.market_price);

  if (edge === null)        errors.push(`edge: invalid (${r.edge})`);
  if (trueProb === null)    errors.push(`true_prob: invalid (${r.true_prob})`);
  if (marketPrice === null) errors.push(`market_price: invalid (${r.market_price})`);
  if (edge !== null && Math.abs(edge) > 0.30) errors.push(`edge: ${edge} exceeds 0.30 cap — rejected as likely hallucination`);

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    data: {
      direction: r.direction as 'BUY_YES' | 'BUY_NO' | 'PASS',
      confidence: r.confidence as 'HIGH' | 'MEDIUM' | 'LOW',
      edge: Math.abs(edge!),
      true_prob: trueProb!,
      market_price: marketPrice!,
      reasoning: isString(r.reasoning) ? r.reasoning as string : '',
      auto_eligible: isBoolean(r.auto_eligible) ? r.auto_eligible : false,
      flags: Array.isArray(r.flags) ? r.flags.filter(isString) : [],
      market_category: isString(r.market_category) ? r.market_category as string : 'other',
    },
  };
}

// ── Sentiment Analysis Schema ────────────────────────────

export interface ValidatedSentimentAnalysis {
  direction: 'BUY_YES' | 'BUY_NO' | 'PASS';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  edge: number;           // 0-1 (normalized, capped at 0.50)
  true_prob: number;      // 0-1
  market_price: number;   // 0-1
  reasoning: string;
  auto_eligible: boolean;
  flags: string[];
  signal_type: string;
}

export function validateSentimentAnalysis(raw: unknown): ValidationResult<ValidatedSentimentAnalysis> {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return { valid: false, errors: ['Not an object'] };

  const r = raw as Record<string, unknown>;

  if (!isDirection(r.direction))    errors.push(`direction: expected BUY_YES|BUY_NO|PASS, got "${r.direction}"`);
  if (!isConfidence(r.confidence))  errors.push(`confidence: expected HIGH|MEDIUM|LOW, got "${r.confidence}"`);

  const edge = normalizeEdge(r.edge);
  const trueProb = normalizeProb(r.true_prob);
  const marketPrice = normalizeProb(r.market_price);

  if (edge === null)        errors.push(`edge: invalid (${r.edge})`);
  if (trueProb === null)    errors.push(`true_prob: invalid (${r.true_prob})`);
  if (marketPrice === null) errors.push(`market_price: invalid (${r.market_price})`);
  if (edge !== null && Math.abs(edge) > 0.30) errors.push(`edge: ${edge} exceeds 0.30 cap — rejected as likely hallucination`);

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    data: {
      direction: r.direction as 'BUY_YES' | 'BUY_NO' | 'PASS',
      confidence: r.confidence as 'HIGH' | 'MEDIUM' | 'LOW',
      edge: Math.abs(edge!),
      true_prob: trueProb!,
      market_price: marketPrice!,
      reasoning: isString(r.reasoning) ? r.reasoning as string : '',
      auto_eligible: isBoolean(r.auto_eligible) ? r.auto_eligible : false,
      flags: Array.isArray(r.flags) ? r.flags.filter(isString) : [],
      signal_type: isString(r.signal_type) ? r.signal_type as string : 'combined',
    },
  };
}
