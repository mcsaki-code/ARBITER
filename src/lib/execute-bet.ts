// ============================================================
// ARBITER — Bet Execution Bridge
// ============================================================
// Shared module used by BOTH place-bets.ts (scheduled) and
// trigger/bets/route.ts (manual). Handles the decision of
// whether to place a paper bet or a live CLOB order.
//
// CRITICAL: This module does NOT change paper trading behavior.
// If live trading is not configured/authorized, it falls through
// to paper mode exactly as before.
// ============================================================

import { SupabaseClient } from '@supabase/supabase-js';
import { isLiveTradingAuthorized, validateLiveOrder } from './guardrails';

// Lazy imports for live trading modules — these depend on @polymarket/clob-client
// and ethers, which may not be installed during paper-only deployments.
// We only load them when live trading is actually attempted.
function isLiveTradingConfigured(): boolean {
  return !!(
    process.env.POLYMARKET_PRIVATE_KEY &&
    process.env.LIVE_TRADING_ENABLED === 'true'
  );
}

// Dynamic import wrapper — only loads CLOB module when needed
async function getClobModule() {
  return await import('./clob');
}

interface BetInsertParams {
  market_id: string;
  analysis_id: string | null;
  category: string;
  direction: string;
  outcome_label: string | null;
  entry_price: number;
  amount_usd: number;
  condition_id?: string; // Polymarket condition_id (from markets table)
}

interface ExecutionResult {
  success: boolean;
  is_paper: boolean;
  bet_id?: string;
  clob_order_id?: string;
  order_status?: string;
  error?: string;
}

/**
 * Execute a bet — either as a paper trade or a live CLOB order.
 *
 * Decision tree:
 *   1. If live trading is not configured → paper bet
 *   2. If guardrails not passed → paper bet
 *   3. If kill switch active → paper bet
 *   4. If per-order validation fails → paper bet
 *   5. If CLOB order fails → paper bet (fallback, logged)
 *   6. Otherwise → live CLOB order + DB record
 *
 * Paper trading is ALWAYS the safe fallback. Live trading
 * only happens when every single check passes.
 */
export async function executeBet(
  supabase: SupabaseClient,
  params: BetInsertParams,
  config: Record<string, string>,
  todayLiveExposure: number = 0,
  log?: string[]
): Promise<ExecutionResult> {
  const addLog = (msg: string) => { if (log) log.push(msg); };

  // ========================================
  // Determine: paper or live?
  // ========================================
  let goLive = false;

  if (isLiveTradingConfigured()) {
    const auth = isLiveTradingAuthorized(config);

    if (auth.authorized) {
      // Per-order validation
      const orderCheck = validateLiveOrder({
        amountUsd: params.amount_usd,
        todayExposureUsd: todayLiveExposure,
        config,
      });

      if (orderCheck.allowed) {
        goLive = true;
      } else {
        addLog(`[live] Order blocked: ${orderCheck.reason} — falling back to paper`);
      }
    } else {
      // Don't spam logs about this — it's expected during paper phase
      // Only log if it seems like they WANT live trading
      if (config.live_trading_enabled === 'true') {
        addLog(`[live] Not authorized: ${auth.reason}`);
      }
    }
  }

  // ========================================
  // Paper bet path (unchanged behavior)
  // ========================================
  if (!goLive) {
    const { data, error } = await supabase.from('bets').insert({
      market_id: params.market_id,
      analysis_id: params.analysis_id,
      category: params.category,
      direction: params.direction,
      outcome_label: params.outcome_label,
      entry_price: params.entry_price,
      amount_usd: params.amount_usd,
      is_paper: true,
      status: 'OPEN',
      order_status: 'NONE',
      placed_at: new Date().toISOString(),
    }).select('id').single();

    if (error) {
      return { success: false, is_paper: true, error: error.message };
    }

    return { success: true, is_paper: true, bet_id: data?.id };
  }

  // ========================================
  // Live CLOB order path
  // ========================================
  addLog(`[live] Executing LIVE order: ${params.direction} $${params.amount_usd.toFixed(2)} on ${params.market_id.substring(0, 8)}`);

  // We need the condition_id to place a CLOB order
  let conditionId = params.condition_id;

  if (!conditionId) {
    // Look it up from markets table
    const { data: market } = await supabase
      .from('markets')
      .select('condition_id')
      .eq('id', params.market_id)
      .single();

    conditionId = market?.condition_id;
  }

  if (!conditionId) {
    addLog('[live] No condition_id found — falling back to paper');
    // Fallback: place as paper
    const { data, error } = await supabase.from('bets').insert({
      market_id: params.market_id,
      analysis_id: params.analysis_id,
      category: params.category,
      direction: params.direction,
      outcome_label: params.outcome_label,
      entry_price: params.entry_price,
      amount_usd: params.amount_usd,
      is_paper: true,
      status: 'OPEN',
      order_status: 'NONE',
      placed_at: new Date().toISOString(),
      notes: 'Live order attempted but condition_id missing — placed as paper',
    }).select('id').single();

    return {
      success: !!data,
      is_paper: true,
      bet_id: data?.id,
      error: error?.message,
    };
  }

  // Dynamically load CLOB module (avoids breaking paper-only deployments)
  const clob = await getClobModule();

  // Convert to CLOB order
  const orderReq = clob.arbiterBetToOrder({
    conditionId,
    direction: params.direction as 'BUY_YES' | 'BUY_NO',
    entryPrice: params.entry_price,
    amountUsd: params.amount_usd,
  });

  // Submit to Polymarket CLOB
  let orderResult: Awaited<ReturnType<typeof clob.placeOrder>>;
  try {
    orderResult = await clob.placeOrder(orderReq);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addLog(`[live] CLOB error: ${msg} — falling back to paper`);

    // Fallback: place as paper bet so we don't lose the signal
    const { data } = await supabase.from('bets').insert({
      market_id: params.market_id,
      analysis_id: params.analysis_id,
      category: params.category,
      direction: params.direction,
      outcome_label: params.outcome_label,
      entry_price: params.entry_price,
      amount_usd: params.amount_usd,
      is_paper: true,
      status: 'OPEN',
      order_status: 'NONE',
      placed_at: new Date().toISOString(),
      notes: `Live order failed: ${msg}`,
    }).select('id').single();

    return { success: false, is_paper: true, bet_id: data?.id, error: msg };
  }

  if (!orderResult.success) {
    addLog(`[live] Order rejected: ${orderResult.errorMessage} — falling back to paper`);

    const { data } = await supabase.from('bets').insert({
      market_id: params.market_id,
      analysis_id: params.analysis_id,
      category: params.category,
      direction: params.direction,
      outcome_label: params.outcome_label,
      entry_price: params.entry_price,
      amount_usd: params.amount_usd,
      is_paper: true,
      status: 'OPEN',
      order_status: 'NONE',
      placed_at: new Date().toISOString(),
      notes: `Live order rejected: ${orderResult.errorMessage}`,
    }).select('id').single();

    return { success: false, is_paper: true, bet_id: data?.id, error: orderResult.errorMessage };
  }

  // SUCCESS — insert as a LIVE bet
  addLog(`[live] Order placed! ID: ${orderResult.orderId}`);

  const { data, error } = await supabase.from('bets').insert({
    market_id: params.market_id,
    analysis_id: params.analysis_id,
    category: params.category,
    direction: params.direction,
    outcome_label: params.outcome_label,
    entry_price: params.entry_price,
    amount_usd: params.amount_usd,
    is_paper: false,
    status: 'OPEN',
    condition_id: conditionId,
    clob_order_id: orderResult.orderId || null,
    order_status: orderResult.status || 'PENDING',
    placed_at: new Date().toISOString(),
  }).select('id').single();

  if (error) {
    addLog(`[live] DB insert error (order was placed!): ${error.message}`);
    return {
      success: true, // Order WAS placed on CLOB
      is_paper: false,
      clob_order_id: orderResult.orderId,
      order_status: orderResult.status,
      error: `Order placed but DB insert failed: ${error.message}`,
    };
  }

  return {
    success: true,
    is_paper: false,
    bet_id: data?.id,
    clob_order_id: orderResult.orderId,
    order_status: orderResult.status,
  };
}
