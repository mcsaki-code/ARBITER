/**
 * WebSocket Price Feed — Integration Examples
 *
 * Shows how to use the ws-price-feed library in different contexts:
 * 1. Real-time price monitoring (stateful)
 * 2. Serverless snapshot for cron jobs
 * 3. Orderbook analysis before placing bets
 * 4. Slippage estimation for position sizing
 */

// ============================================================
// Example 1: Real-time price monitoring
// ============================================================
/*
import { PriceFeed, type PriceUpdate } from './ws-price-feed';

async function monitorMarketPrices() {
  const priceFeed = new PriceFeed();
  const conditionIds = ['0x123...', '0x456...'];

  // Subscribe to price updates
  for (const conditionId of conditionIds) {
    priceFeed.subscribe(conditionId, (update: PriceUpdate) => {
      console.log(`${update.conditionId}: ${update.bid} / ${update.ask} (spread: ${update.spread})`);

      // Use price for real-time decision making
      if (update.spread > 0.1) {
        console.warn(`High spread detected: ${update.spread}`);
      }
    });
  }

  // Handle connection events
  priceFeed.on('connected', () => console.log('Connected to CLOB'));
  priceFeed.on('disconnected', () => console.log('Disconnected from CLOB'));
  priceFeed.on('error', (err) => console.error('Price feed error:', err));

  // Connect
  await priceFeed.connect();

  // Runs indefinitely, emitting price updates
  // In production, would have graceful shutdown
}
*/

// ============================================================
// Example 2: Serverless snapshot for cron jobs
// ============================================================
/*
import { getLatestPrices, getOrderbookDepth, estimateSlippage, type OrderbookDepth } from './ws-price-feed';

export async function cron_checkMarketPrices() {
  // Get latest prices from WebSocket (3 second timeout)
  const conditionIds = ['0x123...', '0x456...'];
  const prices = await getLatestPrices(conditionIds, 3000);

  // Get orderbook depth for slippage analysis
  for (const conditionId of conditionIds) {
    const book = await getOrderbookDepth(conditionId);

    console.log(`\nMarket: ${conditionId}`);
    console.log(`Bid/Ask: ${book.bestBid.toFixed(3)} / ${book.bestAsk.toFixed(3)}`);
    console.log(`Spread: ${(book.spread * 100).toFixed(2)}%`);
    console.log(`Liquidity: ${book.bidDepth.toFixed(0)} @ bid, ${book.askDepth.toFixed(0)} @ ask`);

    // Estimate slippage for a $100 bet
    const buySlippage = estimateSlippage(book, 100, true);
    const sellSlippage = estimateSlippage(book, 100, false);

    console.log(`Buy slippage for $100: ${buySlippage.toFixed(2)}%`);
    console.log(`Sell slippage for $100: ${sellSlippage.toFixed(2)}%`);
  }
}
*/

// ============================================================
// Example 3: Integration with bet placement
// ============================================================
/*
import { getOrderbookDepth, estimateSlippage, isPriceStale } from './ws-price-feed';
import type { OrderbookDepth } from './ws-price-feed';

interface BetOpportunity {
  conditionId: string;
  edge: number;
  confidenceScore: number;
  recommendedSize: number;  // Computed with slippage
}

async function refineBetSize(
  opportunity: BetOpportunity,
  maxSlippageBps: number = 50  // 0.5%
): Promise<{ shouldPlace: boolean; finalSize: number }> {
  // Get current orderbook
  const book = await getOrderbookDepth(opportunity.conditionId);

  // Check if market is stale
  if (isPriceStale(book.timestamp, 5000)) {
    console.warn('Orderbook data is stale, reducing size');
    return { shouldPlace: true, finalSize: opportunity.recommendedSize * 0.5 };
  }

  // Estimate slippage for intended size
  const buySlippage = estimateSlippage(book, opportunity.recommendedSize, true);
  const slippageBps = buySlippage * 100;

  console.log(`Edge: ${(opportunity.edge * 100).toFixed(2)}%`);
  console.log(`Estimated slippage: ${slippageBps.toFixed(1)} bps`);
  console.log(`Liquidity on ask side: ${book.askDepth.toFixed(0)}`);

  // Adjust size based on slippage
  if (slippageBps > maxSlippageBps) {
    // Too much slippage, reduce size
    const reduced = opportunity.recommendedSize * (maxSlippageBps / slippageBps);
    console.log(`Reducing size from ${opportunity.recommendedSize} to ${reduced.toFixed(2)}`);
    return { shouldPlace: true, finalSize: reduced };
  }

  return { shouldPlace: true, finalSize: opportunity.recommendedSize };
}
*/

// ============================================================
// Example 4: Market health monitoring
// ============================================================
/*
import { getOrderbookDepth, computeSpread, type OrderbookDepth } from './ws-price-feed';

async function assessMarketHealth(conditionId: string): Promise<{
  isHealthy: boolean;
  liquidity: 'excellent' | 'good' | 'fair' | 'poor';
  spread: number;
  minDepth: number;
}> {
  const book = await getOrderbookDepth(conditionId);
  const spreadPct = computeSpread(book);

  // Assess liquidity
  const minDepth = Math.min(book.bidDepth, book.askDepth);
  let liquidity: 'excellent' | 'good' | 'fair' | 'poor' = 'poor';

  if (minDepth > 10000) liquidity = 'excellent';
  else if (minDepth > 5000) liquidity = 'good';
  else if (minDepth > 1000) liquidity = 'fair';

  // Market is healthy if spread < 1% and reasonable depth
  const isHealthy = spreadPct < 1 && liquidity !== 'poor';

  return {
    isHealthy,
    liquidity,
    spread: spreadPct,
    minDepth,
  };
}
*/

// ============================================================
// Example 5: Batch price check for multiple markets
// ============================================================
/*
import { getOrderbookDepth } from './ws-price-feed';
import type { OrderbookDepth } from './ws-price-feed';

async function checkMultipleMarkets(
  conditionIds: string[]
): Promise<Map<string, OrderbookDepth>> {
  const results = new Map<string, OrderbookDepth>();

  // Fetch all in parallel (good for serverless)
  const promises = conditionIds.map(id => getOrderbookDepth(id));
  const books = await Promise.all(promises);

  for (let i = 0; i < conditionIds.length; i++) {
    results.set(conditionIds[i], books[i]);
  }

  return results;
}
*/

// ============================================================
// Key Integration Points
// ============================================================
/*

1. PLACE-BETS CRON:
   Use getLatestPrices() to get current market prices before deciding whether
   to place a bet. This is the primary use case for serverless.

   Before placing a bet, also call getOrderbookDepth() to:
   - Verify market liquidity is sufficient
   - Estimate slippage on bet size
   - Adjust position size down if slippage is too high

2. REAL-TIME DASHBOARD:
   Use PriceFeed class to maintain persistent WebSocket connection.
   Subscribe to condition IDs, emit price updates to frontend via SSE or WebSocket.

3. BET VALIDATION:
   In execute-bet.ts, after guardrails pass:
   - Get latest orderbook
   - Estimate slippage for order size
   - Verify slippage is acceptable
   - Place order with adjusted size if needed

4. ORDERBOOK ANALYSIS:
   Use getOrderbookDepth() REST API for:
   - Market health checks
   - Liquidity assessment
   - Price staleness detection
   - Depth-weighted slippage estimation

5. ERROR HANDLING:
   - WebSocket errors are non-fatal; library gracefully falls back
   - REST API errors also graceful, returns zero liquidity
   - Always have fallback behavior for missing/stale prices

*/

export {};
