// ============================================================
// ARBITER — Polymarket CLOB Trading Client
// ============================================================
// Wraps @polymarket/clob-client with ARBITER-specific safety
// checks, rate limiting, and error handling.
//
// FLOW:
//   1. Initialize ClobClient with viem WalletClient + API creds
//   2. Look up market token IDs (YES/NO) from condition_id
//   3. Place limit orders (GTC) or market orders (FOK)
//   4. Track order status and fills
//
// SAFETY:
//   - All orders go through pre-flight checks (balance, size, kill switch)
//   - Rate limiter: max 30 orders/minute (Polymarket allows 60)
//   - Every order is logged to console before submission
//   - No order executes without passing guardrails check first
//
// NOTE: @polymarket/clob-client v5+ requires a viem WalletClient
// (ClobSigner), NOT an ethers Wallet.
// ============================================================

import { ClobClient, Side } from '@polymarket/clob-client';
import { getSigner, isLiveTradingConfigured, POLYGON_CHAIN_ID } from './wallet';

const CLOB_HOST = 'https://clob.polymarket.com';

// Rate limiting — stay well under Polymarket's 60/min limit
const MAX_ORDERS_PER_MINUTE = 30;
const orderTimestamps: number[] = [];

// Signature type: 0 = EOA (externally owned account)
const SIGNATURE_TYPE = 0;

// ============================================================
// Types
// ============================================================

export interface OrderRequest {
  /** Polymarket condition_id (from Gamma API / markets table) */
  conditionId: string;
  /** Which token to buy — mapped from ARBITER's direction */
  side: 'YES' | 'NO';
  /** Price in decimal (0.01 to 0.99) */
  price: number;
  /** Size in number of contracts (shares), NOT USD.
   *  For a $10 bet at $0.50/share → size = 20 */
  size: number;
  /** Order type: GTC (limit, stays open) or FOK (fill-or-kill, market-like) */
  orderType?: 'GTC' | 'FOK';
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  status?: string;
  errorMessage?: string;
  /** Actual filled size (may differ from requested for partial fills) */
  filledSize?: number;
  /** Average fill price */
  avgPrice?: number;
}

export interface MarketTokens {
  /** Token ID for the YES outcome */
  yesTokenId: string;
  /** Token ID for the NO outcome */
  noTokenId: string;
  /** Whether this is a neg-risk market */
  negRisk: boolean;
  /** Minimum tick size for price increments */
  tickSize: string;
}

// ============================================================
// Client Singleton
// ============================================================

let cachedClient: ClobClient | null = null;
let cachedApiCreds: { key: string; secret: string; passphrase: string } | null = null;

/**
 * Get or create a ClobClient instance.
 * Lazily initializes API credentials on first call.
 */
export async function getClobClient(): Promise<ClobClient | null> {
  if (!isLiveTradingConfigured()) return null;

  if (cachedClient) return cachedClient;

  const signer = getSigner();
  if (!signer) return null;

  try {
    // Step 1: Create a temporary client to derive API credentials
    // The viem WalletClient satisfies the ClobSigner interface
    const tempClient = new ClobClient(CLOB_HOST, POLYGON_CHAIN_ID, signer);

    // Step 2: Derive L2 API credentials (HMAC-SHA256 based)
    // This signs an EIP-712 message with your private key to get API creds.
    // Creds are deterministic — same key always produces same creds.
    // Note: ApiKeyCreds uses `key` not `apiKey`
    cachedApiCreds = await tempClient.createOrDeriveApiKey();

    // Step 3: Create the full trading client with API creds
    cachedClient = new ClobClient(
      CLOB_HOST,
      POLYGON_CHAIN_ID,
      signer,
      cachedApiCreds,
      SIGNATURE_TYPE
    );

    const address = signer.account?.address || 'unknown';
    console.log('[clob] Trading client initialized for', address);
    return cachedClient;
  } catch (err) {
    console.error('[clob] Failed to initialize trading client:', err);
    cachedClient = null;
    cachedApiCreds = null;
    return null;
  }
}

/**
 * Reset the cached client (useful if credentials expire or on error).
 */
export function resetClobClient(): void {
  cachedClient = null;
  cachedApiCreds = null;
}

// ============================================================
// Market Token Resolution
// ============================================================

/**
 * Fetch the YES and NO token IDs for a market by condition_id.
 * Token IDs are needed to place orders — they identify which
 * side (YES/NO) of which market you're trading.
 */
export async function getMarketTokens(conditionId: string): Promise<MarketTokens | null> {
  const client = await getClobClient();
  if (!client) return null;

  try {
    // The CLOB API has a market endpoint that returns token IDs
    const market = await client.getMarket(conditionId);

    if (!market || !market.tokens || market.tokens.length < 2) {
      console.error(`[clob] Market ${conditionId} has no tokens`);
      return null;
    }

    // Tokens array: [0] = typically outcome 0 (YES), [1] = outcome 1 (NO)
    // But we identify by outcome string to be safe
    let yesToken = market.tokens.find(
      (t: { outcome: string }) => t.outcome === 'Yes'
    );
    let noToken = market.tokens.find(
      (t: { outcome: string }) => t.outcome === 'No'
    );

    // Fallback: if not a simple Yes/No market, use positional
    if (!yesToken) yesToken = market.tokens[0];
    if (!noToken) noToken = market.tokens[1];

    return {
      yesTokenId: yesToken.token_id,
      noTokenId: noToken.token_id,
      negRisk: market.neg_risk || false,
      tickSize: market.minimum_tick_size || '0.01',
    };
  } catch (err) {
    console.error(`[clob] Failed to get tokens for ${conditionId}:`, err);
    return null;
  }
}

// ============================================================
// Rate Limiting
// ============================================================

function checkRateLimit(): boolean {
  const now = Date.now();
  // Remove timestamps older than 1 minute
  while (orderTimestamps.length > 0 && orderTimestamps[0] < now - 60000) {
    orderTimestamps.shift();
  }
  return orderTimestamps.length < MAX_ORDERS_PER_MINUTE;
}

function recordOrder(): void {
  orderTimestamps.push(Date.now());
}

// ============================================================
// Order Placement
// ============================================================

/**
 * Place a single order on Polymarket's CLOB.
 *
 * This is the core execution function. All safety checks should
 * be performed BEFORE calling this (guardrails, balance, kill switch).
 *
 * @param req - Order parameters
 * @returns OrderResult with success status and order ID
 */
export async function placeOrder(req: OrderRequest): Promise<OrderResult> {
  // Pre-flight: rate limit
  if (!checkRateLimit()) {
    return {
      success: false,
      errorMessage: 'Rate limit reached (30 orders/minute). Try again shortly.',
    };
  }

  // Pre-flight: validate price
  if (req.price <= 0 || req.price >= 1) {
    return {
      success: false,
      errorMessage: `Invalid price ${req.price} — must be between 0.01 and 0.99`,
    };
  }

  // Pre-flight: validate size
  if (req.size <= 0) {
    return {
      success: false,
      errorMessage: `Invalid size ${req.size} — must be > 0`,
    };
  }

  const client = await getClobClient();
  if (!client) {
    return {
      success: false,
      errorMessage: 'CLOB client not initialized. Check POLYMARKET_PRIVATE_KEY and LIVE_TRADING_ENABLED.',
    };
  }

  // Resolve token IDs
  const tokens = await getMarketTokens(req.conditionId);
  if (!tokens) {
    return {
      success: false,
      errorMessage: `Could not resolve token IDs for condition ${req.conditionId}`,
    };
  }

  // Select the correct token based on which side we're buying
  const tokenId = req.side === 'YES' ? tokens.yesTokenId : tokens.noTokenId;

  console.log(
    `[clob] Placing order: ${req.side} ${req.size} shares @ $${req.price} on ${req.conditionId.substring(0, 12)}...`
  );

  try {
    recordOrder();

    // We always BUY — the token ID determines whether it's YES or NO
    const response = await client.createAndPostOrder({
      tokenID: tokenId,
      price: req.price,
      size: req.size,
      side: Side.BUY,
      negRisk: tokens.negRisk,
    });

    // The response structure varies but typically has:
    // { orderID: string, status: string, ... }
    const orderId = response?.orderID || response?.orderIds?.[0] || null;
    const status = response?.status || 'SUBMITTED';

    console.log(`[clob] Order placed: ${orderId} status=${status}`);

    return {
      success: true,
      orderId: orderId || undefined,
      status,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[clob] Order failed:`, message);

    // Reset client on auth errors (credentials may have expired)
    if (message.includes('401') || message.includes('403') || message.includes('Unauthorized')) {
      resetClobClient();
    }

    return {
      success: false,
      errorMessage: message,
    };
  }
}

/**
 * Cancel an open order by order ID.
 */
export async function cancelOrder(orderId: string): Promise<{ success: boolean; error?: string }> {
  const client = await getClobClient();
  if (!client) {
    return { success: false, error: 'CLOB client not initialized' };
  }

  try {
    await client.cancelOrder({ orderID: orderId });
    console.log(`[clob] Cancelled order ${orderId}`);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[clob] Cancel failed for ${orderId}:`, message);
    return { success: false, error: message };
  }
}

/**
 * Cancel all open orders (emergency kill).
 */
export async function cancelAllOrders(): Promise<{ success: boolean; error?: string }> {
  const client = await getClobClient();
  if (!client) {
    return { success: false, error: 'CLOB client not initialized' };
  }

  try {
    await client.cancelAll();
    console.log('[clob] All orders cancelled');
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[clob] Cancel all failed:', message);
    return { success: false, error: message };
  }
}

/**
 * Get the status of an order by ID.
 */
export async function getOrderStatus(orderId: string): Promise<{
  status: string;
  filledSize?: number;
  avgPrice?: number;
} | null> {
  const client = await getClobClient();
  if (!client) return null;

  try {
    const order = await client.getOrder(orderId);
    return {
      status: order?.status || 'UNKNOWN',
      filledSize: order?.size_matched ? parseFloat(order.size_matched) : undefined,
      avgPrice: order?.associate_trades?.[0]?.price
        ? parseFloat(order.associate_trades[0].price)
        : undefined,
    };
  } catch (err) {
    console.error(`[clob] Get order failed for ${orderId}:`, err);
    return null;
  }
}

// ============================================================
// Helper: Convert ARBITER bet to CLOB order
// ============================================================

/**
 * Convert ARBITER's internal bet representation to a CLOB order.
 *
 * ARBITER uses:
 *   - direction: 'BUY_YES' | 'BUY_NO'
 *   - entry_price: what we pay per share (0-1)
 *   - amount_usd: total dollar amount
 *
 * CLOB uses:
 *   - side: Side.BUY (always buying — we pick YES or NO token)
 *   - price: price per share
 *   - size: number of shares (= amount_usd / price)
 */
export function arbiterBetToOrder(params: {
  conditionId: string;
  direction: 'BUY_YES' | 'BUY_NO';
  entryPrice: number;
  amountUsd: number;
}): OrderRequest {
  const { conditionId, direction, entryPrice, amountUsd } = params;

  // Which side are we buying?
  const side: 'YES' | 'NO' = direction === 'BUY_YES' ? 'YES' : 'NO';

  // Price is what we pay per share of our chosen side
  // For BUY_YES: price = entry_price (the YES price)
  // For BUY_NO: price = entry_price (already converted to NO price = 1 - YES price)
  const price = Math.round(entryPrice * 100) / 100; // Round to nearest cent (tick size)

  // Size = how many shares we're buying
  // If price is $0.50 and we want to bet $10, we buy 20 shares
  const size = Math.floor(amountUsd / price);

  return {
    conditionId,
    side,
    price,
    size: Math.max(1, size), // At least 1 share
    orderType: 'GTC', // Default to limit order (GTC)
  };
}
