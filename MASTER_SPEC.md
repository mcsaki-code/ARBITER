# ARBITER Master Spec — Tier-One Upgrade

**Date**: 2026-03-28
**Status**: Active — executing against this document

## Executive Summary

ARBITER is an automated Polymarket prediction market trading system spanning weather, crypto, sports, politics, sentiment, and opportunity markets. After deep audit of all 22 Netlify functions, 3 shared libraries, 8 migrations, and 89 tests, this spec defines the precise changes needed to close the gap between the current system and a professional-grade operation.

The architecture is sound. The data pipelines are well-built. What's missing is the math — fees aren't subtracted, edges aren't devigged, confidence labels aren't calibrated, and 2 of 6 Claude-powered analyzers bypass validation entirely. These are the differences between a system that generates signals and a system that makes money.

---

## Current State Snapshot

| Metric | Value |
|--------|-------|
| Netlify functions | 22 |
| Database tables | 21 (all created) |
| Test files | 4 (89 tests, all passing) |
| TypeScript errors | 0 |
| Analyzers with validation | 4 of 6 Claude-powered |
| Fee accounting | None |
| Vig removal | Naive (sum-to-1 normalization) |
| Calibration feedback | Table exists, not populated by analyzers |

---

## Phase 1: Fee-Adjusted Edge Calculation

### Problem
Polymarket charges ~2% to winners (varies by market). Every edge calculation in every analyzer ignores this. A 2.5% edge becomes 0.5% after fees — barely worth execution risk. The system systematically overestimates edge by the fee amount on every bet.

### Solution
Create a shared constant and utility in `src/lib/trading-math.ts`:

```
POLYMARKET_FEE_RATE = 0.02 (2%)

feeAdjustedEdge(rawEdge, direction, marketPrice):
  if direction === 'BUY_YES':
    winPayout = 1.0 - marketPrice  // profit per share if YES wins
    feeOnWin = winPayout * POLYMARKET_FEE_RATE
    netEdge = rawEdge - feeOnWin * marketPrice  // fee scales with position size
  if direction === 'BUY_NO':
    winPayout = marketPrice  // profit per share if NO wins (you bought at 1-marketPrice)
    feeOnWin = winPayout * POLYMARKET_FEE_RATE
    netEdge = rawEdge - feeOnWin * (1 - marketPrice)
  if direction === 'PASS':
    return 0
  return max(netEdge, 0)  // negative fee-adjusted edge = no bet
```

### Files to modify
- NEW: `src/lib/trading-math.ts` — shared Kelly, fee adjustment, vig removal
- `netlify/functions/analyze-crypto.ts` — apply feeAdjustedEdge before Kelly
- `netlify/functions/analyze-sports-edge.ts` — apply feeAdjustedEdge before Kelly
- `netlify/functions/analyze-weather.ts` — apply feeAdjustedEdge before Kelly
- `netlify/functions/analyze-politics.ts` — apply feeAdjustedEdge before Kelly
- `netlify/functions/analyze-opportunities.ts` — apply feeAdjustedEdge before Kelly
- `netlify/functions/analyze-sentiment-edge.ts` — apply feeAdjustedEdge before Kelly

---

## Phase 2: Validation on Unprotected Analyzers

### Problem
`analyze-opportunities.ts` and `analyze-sentiment-edge.ts` parse Claude JSON and write directly to DB with no validation. Invalid enums (`direction: "SELL"`), uncapped edges (`edge: 849`), and garbage confidence values flow into place-bets unfiltered.

### Solution
Add `validateOpportunityAnalysis()` and `validateSentimentAnalysis()` to `validate-analysis.ts`, then wire them into both analyzers. Same pattern as the existing 4 validators.

### Files to modify
- `src/lib/validate-analysis.ts` — add 2 new validators
- `netlify/functions/analyze-opportunities.ts` — wire validation
- `netlify/functions/analyze-sentiment-edge.ts` — wire validation

---

## Phase 3: Unified Confidence Multipliers and Kelly Sizing

### Problem
Kelly sizing is inconsistent across analyzers:

| Analyzer | Kelly fraction | HIGH | MEDIUM | LOW |
|----------|---------------|------|--------|-----|
| crypto | 1/4 (0.25) | 1.0 | 0.6 | 0.2 |
| sports (sportsbook) | 1/8 (0.125) | 1.0 | 0.6 | 0.2 |
| sports (knowledge) | 1/8 (0.125) | 0.8 | 0.5 | 0.2 |
| weather | 1/8 (0.125) | 0.8 | 0.5 | 0.2 |
| politics | 1/8 (0.125) | 0.8 | 0.5 | 0.2 |
| opportunities | Claude's value | 0.8 | 0.5 | 0.2 |
| sentiment | Claude's value | 0.8 | 0.5 | 0.2 |

Crypto uses 1/4 Kelly (2x more aggressive). Opportunities/sentiment trust Claude's Kelly output directly.

### Solution
Centralize in `src/lib/trading-math.ts`:

```
KELLY_FRACTION = 0.125 (1/8th — professional standard)
CONFIDENCE_MULTIPLIERS = { HIGH: 0.8, MEDIUM: 0.5, LOW: 0.2 }
MAX_KELLY_CAP = 0.03 (3% of bankroll per bet)

computeKelly(trueProb, marketPrice, direction, confidence, category):
  if direction === 'PASS': return 0

  // Flip for BUY_NO
  p = direction === 'BUY_NO' ? 1 - trueProb : trueProb
  c = direction === 'BUY_NO' ? 1 - marketPrice : marketPrice

  if p <= 0 or c <= 0 or c >= 1: return 0
  b = (1 - c) / c
  fullKelly = (p * b - (1 - p)) / b
  if fullKelly <= 0: return 0

  confMult = CONFIDENCE_MULTIPLIERS[confidence] || 0.2
  sized = fullKelly * KELLY_FRACTION * confMult

  // Category-specific caps
  weatherMult = category === 'weather' ? typeMult(subcategory) : 1.0
  return min(sized * weatherMult, MAX_KELLY_CAP)
```

### Files to modify
- NEW: `src/lib/trading-math.ts` — single source of truth
- ALL 6 Claude analyzers — replace inline Kelly with `computeKelly()`
- `netlify/functions/place-bets.ts` — remove redundant re-sizing (already sized correctly at analysis time)

---

## Phase 4: Calibration Feedback Loop

### Problem
`calibration_snapshots` table exists but the data isn't used to adjust future bets. Claude self-reports "HIGH confidence" but we don't know if HIGH confidence bets actually win more than LOW confidence bets. Without this feedback, confidence multipliers are arbitrary.

### Solution
Two parts:

**Part A**: `performance-snapshot.ts` already writes calibration data. Verify it's computing correctly and populating all fields including `avg_edge` (currently hardcoded to 0).

**Part B**: Add a `getCalibrationDiscount()` function to `trading-math.ts` that reads recent calibration data and adjusts the confidence multiplier based on actual track record:

```
getCalibrationDiscount(category, confidence):
  // Read last 30 days of calibration_snapshots
  // If predicted_win_rate for this tier significantly exceeds actual_win_rate,
  // discount confidence multiplier proportionally
  // If fewer than 20 resolved bets in this tier, return 1.0 (no adjustment)

  overconfidenceRatio = predicted_win_rate / max(actual_win_rate, 0.01)
  if overconfidenceRatio > 1.5: return 0.5  // halve sizing if 50%+ overconfident
  if overconfidenceRatio > 1.2: return 0.75 // reduce by 25%
  return 1.0  // calibration is decent
```

### Files to modify
- `src/lib/trading-math.ts` — add getCalibrationDiscount()
- `netlify/functions/performance-snapshot.ts` — fix avg_edge=0 bug, ensure avg_pnl populated
- All analyzers — multiply Kelly by calibration discount

---

## Phase 5: Sportsbook Vig Removal (Shin's Method)

### Problem
`ingest-sports-odds.ts` removes vig by simple normalization: `probs.map(p => p / total)`. This is the naive method that distributes overround proportionally. For a -110/-110 market, both sides get exactly 50%. But for lopsided markets (-300/+250), naive devig is systematically biased toward the favorite.

### Solution
Implement Shin's method (the industry standard for binary markets):

```
shinDevig(impliedProbs: number[]):
  // Shin's model assumes a proportion z of bettors are insiders
  // True probability = (sqrt(z^2 + 4*(1-z)*p_i/total) - z) / (2*(1-z))
  // where z is solved iteratively to make probs sum to 1

  total = sum(impliedProbs)
  z = total - 1  // overround as initial estimate

  // Newton's method: iterate until convergence
  for 20 iterations:
    shinProbs = impliedProbs.map(p =>
      (sqrt(z*z + 4*(1-z)*p/total) - z) / (2*(1-z))
    )
    sumShin = sum(shinProbs)
    if abs(sumShin - 1.0) < 0.0001: break
    z = z * sumShin  // adjust

  return shinProbs
```

For 3+ outcome markets (which naive devig handles incorrectly), Shin's method naturally extends.

### Files to modify
- `src/lib/trading-math.ts` — add shinDevig()
- `netlify/functions/ingest-sports-odds.ts` — replace `removeVig()` with shinDevig()

---

## Phase 6: Bug Fixes (Found During Audit)

### 6a. Crypto 1/4 Kelly → 1/8 Kelly
`analyze-crypto.ts` line 438 uses `fullKelly * 0.25` while every other analyzer uses `0.125`. Standardize to 1/8.

### 6b. Politics bankroll fallback
`analyze-politics.ts` line 608 defaults bankroll to '500' instead of '5000'. Fix to match other analyzers.

### 6c. execute-bet.ts condition_id lookup
Silent failure on condition_id lookup inserts bets with null condition_id. Add explicit error handling — if lookup fails, log and reject the bet rather than inserting broken data.

### 6d. resolve-bets.ts outcome_label null safety
Line 189: `(bet.outcome_label || '').toLowerCase()` — add explicit null check and skip resolution if outcome_label is missing.

### 6e. Weather MIN_EDGE conflict
`analyze-weather.ts` uses MIN_EDGE=0.05 (5%) but `place-bets.ts` uses MIN_EDGE_WEATHER=0.08 (8%). Unify to 0.08 (the more conservative filter) at analysis time.

### 6f. Double normalization in crypto analyzer
Validation normalizes edge/prob, then the analyzer normalizes again. Remove the second pass.

---

## Phase 7: Test Suite Expansion

### New tests needed
- `tests/trading-math.test.ts` — fee adjustment, Shin's devig, unified Kelly, calibration discount
- `tests/validation-expanded.test.ts` — opportunity and sentiment validators
- Expand existing sports/weather/politics validator tests from 2-3 to 8+ each

---

## Implementation Order

The phases are ordered by impact on P&L:

1. **Phase 1** (fees) — Every bet is currently oversized by ~2%. Fixing this immediately reduces losses.
2. **Phase 3** (unified Kelly) — Crypto is 2x more aggressive than other categories for no reason.
3. **Phase 6** (bug fixes) — Politics bankroll typo, condition_id failures, null safety.
4. **Phase 2** (validation) — Two analyzers are unprotected. Wire them up.
5. **Phase 5** (Shin's devig) — Better true probabilities = better edge estimates = better sizing.
6. **Phase 4** (calibration) — Requires historical data to be meaningful. Plant the seed now.
7. **Phase 7** (tests) — Lock everything in with tests.

---

## Success Criteria

After all phases:
- Every edge calculation subtracts Polymarket fees before Kelly sizing
- Every Claude analyzer validates and normalizes its output before DB write
- Kelly sizing is computed by a single shared function with unified parameters
- Sportsbook consensus uses Shin's devig, not naive normalization
- Calibration feedback adjusts confidence multipliers based on actual track record
- 120+ tests cover all critical paths
- 0 TypeScript errors
- No silent failures in bet execution pipeline
