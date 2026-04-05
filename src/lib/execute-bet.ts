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
// and viem, which may not be installed during paper-only deployments.
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
  edge?: number | null; // Edge from analysis
  confidence?: string | null; // Confidence level from analysis
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
  // Paper bet path
  // ========================================
  if (!goLive) {
    // ── Race condition guard ──────────────────────────────────────────
    // Two concurrent place-bets invocations can both pass the in-memory
    // "existingMarketIds" check and try to insert a bet on the same market.
    // This DB-level check catches the second one. We limit to 1 open bet
    // per market (MAX_BETS_PER_MARKET=1).
    const { count: existingOpen } = await supabase
      .from('bets')
      .select('*', { count: 'exact', head: true })
      .eq('market_id', params.market_id)
      .eq('status', 'OPEN');

    if (existingOpen && existingOpen > 0) {
      addLog(`[paper] Duplicate guard: already have ${existingOpen} open bet(s) on ${params.market_id.substring(0, 8)}`);
      return { success: false, is_paper: true, error: 'Duplicate open bet on this market' };
    }

    // Look up condition_id so resolve-bets can match this bet to a Polymarket market.
    // CRITICAL: without condition_id, bets can never be resolved and P&L tracking breaks.
    let conditionId = params.condition_id;
    if (!conditionId) {
      const { data: mktRow, error: mktError } = await supabase
        .from('markets')
        .select('condition_id')
        .eq('id', params.market_id)
        .single();
      if (mktError) {
        // Log the error explicitly but continue — repair-bets.ts will backfill
        addLog(`[paper] WARNING: condition_id lookup failed: ${mktError.message} — proceeding without it`);
      }
      conditionId = mktRow?.condition_id ?? undefined;
    }

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
      condition_id: conditionId ?? null,
      edge: params.edge ?? null,
      confidence: params.confidence ?? null,
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

  // Pre-flight: Check USDC balance before submitting to CLOB.
  // validateWalletFunds() exists in wallet.ts but was never called — orders
  // would fail with "insufficient balance" on CLOB and waste API quota.
  try {
    const { validateWalletFunds } = await import('./wallet');
    const walletCheck = await validateWalletFunds(params.amount_usd);
    if (!walletCheck.ok) {
      addLog(`[live] Wallet check failed: ${walletCheck.errors.join(', ')} — falling back to paper`);
      // Fall through to paper bet
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
        edge: params.edge ?? null,
        confidence: params.confidence ?? null,
        placed_at: new Date().toISOString(),
        notes: `Live order skipped: ${walletCheck.errors.join('; ')}`,
      }).select('id').single();
      return { success: !!data, is_paper: true, bet_id: data?.id, error: walletCheck.errors.join('; ') };
    }
    addLog(`[live] Wallet OK: $${walletCheck.usdcBalance.toFixed(2)} USDC, ${walletCheck.maticBalance.toFixed(4)} MATIC`);
  } catch (err) {
    addLog(`[live] Wallet check error (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    // Continue anyway — let CLOB reject if funds insufficient
  }

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
      edge: params.edge ?? null,
      confidence: params.confidence ?? null,
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
      edge: params.edge ?? null,
      confidence: params.confidence ?? null,
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
      edge: params.edge ?? null,
      confidence: params.confidence ?? null,
      placed_at: new Date().toISOString(),
      notes: `Live order rejected: ${orderResult.errorMessage}`,
    }).select('id').single();

    return { success: false, is_paper: true, bet_id: data?.id, error: orderResult.errorMessage };
  }

  // SUCCESS — poll for fill confirmation before recording
  addLog(`[live] Order submitted! ID: ${orderResult.orderId} — polling for fill...`);

  // Poll order status for up to 15 seconds to confirm fill.
  // GTC orders may not fill immediately if the price moved.
  let finalStatus = orderResult.status || 'SUBMITTED';
  let filledSize: number | undefined;
  let avgPrice: number | undefined;

  if (orderResult.orderId) {
    const pollStart = Date.now();
    const POLL_TIMEOUT_MS = 15000;
    const POLL_INTERVAL_MS = 2000;

    while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      try {
        const status = await clob.getOrderStatus(orderResult.orderId);
        if (status) {
          finalStatus = status.status;
          filledSize = status.filledSize;
          avgPrice = status.avgPrice;
          addLog(`[live] Poll: status=${finalStatus}, filled=${filledSize ?? 'unknown'}`);
          // Terminal states: MATCHED (filled), CANCELLED, EXPIRED
          if (['MATCHED', 'CANCELLED', 'EXPIRED', 'FILLED'].includes(finalStatus.toUpperCase())) {
            break;
          }
        }
      } catch {
        // Non-fatal — keep polling
      }
    }
  }

  // If order was cancelled or expired and nothing filled, fall back to paper
  const isFilled = finalStatus.toUpperCase() === 'MATCHED' || finalStatus.toUpperCase() === 'FILLED' || (filledSize && filledSize > 0);
  if (!isFilled && ['CANCELLED', 'EXPIRED'].includes(finalStatus.toUpperCase())) {
    addLog(`[live] Order ${finalStatus} with no fills — falling back to paper`);
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
      edge: params.edge ?? null,
      confidence: params.confidence ?? null,
      placed_at: new Date().toISOString(),
      notes: `Live order ${finalStatus}: ${orderResult.orderId}`,
    }).select('id').single();
    return { success: false, is_paper: true, bet_id: data?.id, error: `Order ${finalStatus}` };
  }

  // Record as LIVE bet — use actual fill price if available
  const recordedPrice = avgPrice || params.entry_price;
  const { data, error } = await supabase.from('bets').insert({
    market_id: params.market_id,
    analysis_id: params.analysis_id,
    category: params.category,
    direction: params.direction,
    outcome_label: params.outcome_label,
    entry_price: recordedPrice,
    amount_usd: params.amount_usd,
    is_paper: false,
    status: 'OPEN',
    condition_id: conditionId,
    edge: params.edge ?? null,
    confidence: params.confidence ?? null,
    clob_order_id: orderResult.orderId || null,
    order_status: finalStatus,
    placed_at: new Date().toISOString(),
  }).select('id').single();

  if (error) {
    addLog(`[live] DB insert error (order was placed!): ${error.message}`);
    return {
      success: true, // Order WAS placed on CLOB
      is_paper: false,
      clob_order_id: orderResult.orderId,
      order_status: finalStatus,
      error: `Order placed but DB insert failed: ${error.message}`,
    };
  }

  addLog(`[live] Order confirmed: ${finalStatus}, filled=${filledSize ?? 'pending'}, price=${recordedPrice.toFixed(4)}`);
  return {
    success: true,
    is_paper: false,
    bet_id: data?.id,
    clob_order_id: orderResult.orderId,
    order_status: finalStatus,
  };
}
