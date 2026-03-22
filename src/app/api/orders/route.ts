import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { isLiveTradingAuthorized, checkRealMoneyEligibility } from '@/lib/guardrails';

export const dynamic = 'force-dynamic';

// Lazy imports for wallet/clob to avoid breaking builds when
// @polymarket/clob-client and viem aren't installed yet.
function isLiveTradingConfigured(): boolean {
  return !!(
    process.env.POLYMARKET_PRIVATE_KEY &&
    process.env.LIVE_TRADING_ENABLED === 'true'
  );
}

async function getWalletModule() {
  try {
    return await import('@/lib/wallet');
  } catch {
    return null;
  }
}

async function getClobModule() {
  try {
    return await import('@/lib/clob');
  } catch {
    return null;
  }
}

// ============================================================
// GET /api/orders — Live trading status & wallet info
// ============================================================

export async function GET() {
  const supabase = getSupabaseAdmin();

  // Load all relevant config
  const { data: configRows } = await supabase
    .from('system_config')
    .select('key, value')
    .in('key', [
      'paper_bankroll', 'paper_trade_start_date', 'total_paper_bets', 'paper_win_rate',
      'live_trading_enabled', 'live_kill_switch', 'live_max_single_bet_usd',
      'live_max_daily_usd', 'live_wallet_address', 'live_total_orders', 'live_total_pnl',
    ]);

  const config: Record<string, string> = {};
  configRows?.forEach((r) => { config[r.key] = r.value; });

  // Paper trading gate status
  const paperGate = checkRealMoneyEligibility(config);

  // Live trading authorization
  const auth = isLiveTradingAuthorized(config);

  // Wallet info (only if configured and packages available)
  let walletInfo = null;
  if (isLiveTradingConfigured()) {
    const walletMod = await getWalletModule();
    if (walletMod) {
      const address = walletMod.getWalletAddress();
      const usdcBalance = await walletMod.getUSDCBalance();
      const maticBalance = await walletMod.getMATICBalance();
      walletInfo = { address, usdcBalance, maticBalance };
    }
  }

  // Recent live orders
  const { data: liveOrders } = await supabase
    .from('bets')
    .select('id, market_id, direction, amount_usd, entry_price, clob_order_id, order_status, placed_at, status, pnl')
    .eq('is_paper', false)
    .order('placed_at', { ascending: false })
    .limit(20);

  // Today's live exposure
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const { data: todayLive } = await supabase
    .from('bets')
    .select('amount_usd')
    .eq('is_paper', false)
    .gte('placed_at', todayStart.toISOString());
  const todayExposure = todayLive?.reduce((sum, b) => sum + (b.amount_usd || 0), 0) || 0;

  return NextResponse.json({
    paperGate: {
      eligible: paperGate.eligible,
      blockers: paperGate.blockers,
    },
    liveTrading: {
      configured: isLiveTradingConfigured(),
      authorized: auth.authorized,
      reason: auth.reason,
      killSwitch: config.live_kill_switch === 'true',
      maxSingleBet: parseFloat(config.live_max_single_bet_usd || '10'),
      maxDailyUsd: parseFloat(config.live_max_daily_usd || '50'),
      todayExposure,
    },
    wallet: walletInfo,
    recentOrders: liveOrders || [],
    config: {
      liveEnabled: config.live_trading_enabled === 'true',
      totalOrders: parseInt(config.live_total_orders || '0'),
      totalPnl: parseFloat(config.live_total_pnl || '0'),
    },
  });
}

// ============================================================
// POST /api/orders — Kill switch & order management
// ============================================================

export async function POST(request: Request) {
  const supabase = getSupabaseAdmin();
  const body = await request.json();
  const { action } = body;

  // Load config
  const { data: configRows } = await supabase
    .from('system_config')
    .select('key, value')
    .in('key', ['live_kill_switch', 'live_trading_enabled']);
  const config: Record<string, string> = {};
  configRows?.forEach((r) => { config[r.key] = r.value; });

  switch (action) {
    // ========================================
    // KILL SWITCH — Emergency stop all trading
    // ========================================
    case 'kill': {
      // Activate kill switch in DB
      await supabase
        .from('system_config')
        .update({ value: 'true', updated_at: new Date().toISOString() })
        .eq('key', 'live_kill_switch');

      // Cancel all open CLOB orders (if clob module available)
      let cancelResult: { success: boolean; error?: string } = { success: false, error: 'CLOB module not loaded' };
      const clobMod = await getClobModule();
      if (clobMod) {
        cancelResult = await clobMod.cancelAllOrders();
      }

      // Mark all PENDING bets as CANCELLED
      await supabase
        .from('bets')
        .update({ order_status: 'CANCELLED', notes: 'Kill switch activated' })
        .eq('is_paper', false)
        .eq('order_status', 'PENDING');

      return NextResponse.json({
        success: true,
        message: 'Kill switch activated. All orders cancelled.',
        cancelResult,
      });
    }

    // ========================================
    // RESUME — Deactivate kill switch
    // ========================================
    case 'resume': {
      await supabase
        .from('system_config')
        .update({ value: 'false', updated_at: new Date().toISOString() })
        .eq('key', 'live_kill_switch');

      return NextResponse.json({
        success: true,
        message: 'Kill switch deactivated. Live trading can resume.',
      });
    }

    // ========================================
    // CANCEL — Cancel a specific order
    // ========================================
    case 'cancel': {
      const { orderId, betId } = body;

      if (!orderId) {
        return NextResponse.json({ error: 'orderId required' }, { status: 400 });
      }

      const clobCancel = await getClobModule();
      if (!clobCancel) {
        return NextResponse.json({ success: false, error: 'CLOB module not available' }, { status: 500 });
      }

      const result = await clobCancel.cancelOrder(orderId);

      if (result.success && betId) {
        await supabase
          .from('bets')
          .update({ order_status: 'CANCELLED' })
          .eq('id', betId);
      }

      return NextResponse.json(result);
    }

    // ========================================
    // STATUS — Check order fill status
    // ========================================
    case 'status': {
      const { orderId: oid } = body;
      if (!oid) {
        return NextResponse.json({ error: 'orderId required' }, { status: 400 });
      }

      const clobStatus = await getClobModule();
      if (!clobStatus) {
        return NextResponse.json({ status: 'UNKNOWN', error: 'CLOB module not available' });
      }

      const status = await clobStatus.getOrderStatus(oid);
      return NextResponse.json(status || { status: 'UNKNOWN' });
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}
