/**
 * WebSocket Price Feed Library for Polymarket CLOB
 *
 * Provides real-time price data from Polymarket's CLOB WebSocket at:
 * wss://ws-subscriptions-clob.polymarket.com/ws/market
 *
 * Exports:
 * - PriceFeed class: Connection management, subscriptions
 * - getLatestPrices(): Snapshot function for serverless/cron use
 * - getOrderbookDepth(): REST API wrapper for orderbook depth
 * - Price validation utilities
 */

import { EventEmitter } from 'events';

// ============================================================
// Types & Interfaces
// ============================================================

/**
 * Real-time price update from WebSocket
 */
export interface PriceUpdate {
  conditionId: string;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  timestamp: Date;
}

/**
 * Price snapshot for serverless functions
 */
export interface PriceSnapshot {
  conditionId: string;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  lastUpdate: Date;
}

/**
 * Orderbook depth from REST API
 */
export interface OrderbookDepth {
  conditionId: string;
  bestBid: number;
  bestAsk: number;
  spread: number;
  bidDepth: number;  // Total size at bid
  askDepth: number;  // Total size at ask
  timestamp: Date;
}

/**
 * Callback function type for price updates
 */
export type PriceCallback = (update: PriceUpdate) => void;

/**
 * WebSocket message types from CLOB
 */
interface CLOBMessage {
  type: string;
  [key: string]: unknown;
}

interface PriceMessage extends CLOBMessage {
  type: 'price';
  product_id?: string;
  condition_id?: string;
  mid_price?: string | number;
  best_bid?: string | number;
  best_ask?: string | number;
}

/**
 * Internal subscription tracker
 */
interface Subscription {
  conditionId: string;
  callback: PriceCallback;
}

// ============================================================
// PriceFeed Class — Connection Management
// ============================================================

/**
 * PriceFeed class manages WebSocket connection to Polymarket CLOB
 *
 * Handles:
 * - Connection lifecycle (connect/disconnect/reconnect)
 * - Subscriptions to market price updates
 * - Automatic reconnection with exponential backoff
 * - Message parsing and callback dispatch
 */
export class PriceFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private subscriptions: Map<string, PriceCallback> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000; // Start at 1s
  private reconnectTimer: NodeJS.Timeout | null = null;
  private messageBuffer: CLOBMessage[] = [];
  private isConnecting = false;
  private readonly wsUrl = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

  constructor() {
    super();
  }

  /**
   * Connect to Polymarket CLOB WebSocket
   * Handles connection establishment and initial subscription
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      if (this.isConnecting) {
        // Already connecting, wait for it
        this.once('connected', resolve);
        this.once('connection_error', reject);
        return;
      }

      this.isConnecting = true;

      try {
        // Use ws package from server-side, or native WebSocket from browser
        const WS = typeof WebSocket !== 'undefined' ? WebSocket : require('ws');
        this.ws = new WS(this.wsUrl) as WebSocket;

        const ws = this.ws;

        ws.onopen = () => {
          this.reconnectAttempts = 0;
          this.reconnectDelay = 1000;
          this.isConnecting = false;
          this.emit('connected');

          // Resubscribe to existing subscriptions
          this.resubscribeAll();

          resolve();
        };

        ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        ws.onerror = (error) => {
          this.emit('error', error);
          if (this.isConnecting) {
            this.isConnecting = false;
            reject(error);
          }
        };

        ws.onclose = () => {
          this.ws = null;
          this.isConnecting = false;
          this.emit('disconnected');

          // Attempt reconnect if we have subscriptions
          if (this.subscriptions.size > 0) {
            this.scheduleReconnect();
          }
        };
      } catch (error) {
        this.isConnecting = false;
        reject(error);
      }
    });
  }

  /**
   * Disconnect from WebSocket and clear subscriptions
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.subscriptions.clear();
    this.reconnectAttempts = 0;
    this.isConnecting = false;
  }

  /**
   * Subscribe to price updates for a condition ID
   * Automatically connects if not already connected
   */
  subscribe(conditionId: string, callback: PriceCallback): void {
    this.subscriptions.set(conditionId, callback);

    // If connected, send subscription immediately
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscription(conditionId);
    } else {
      // Otherwise connect first
      this.connect().catch((err) => {
        this.emit('error', new Error(`Failed to subscribe to ${conditionId}: ${err}`));
      });
    }
  }

  /**
   * Unsubscribe from price updates
   */
  unsubscribe(conditionId: string): void {
    this.subscriptions.delete(conditionId);

    // Send unsubscribe if connected
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendUnsubscription(conditionId);
    }

    // Disconnect if no more subscriptions
    if (this.subscriptions.size === 0) {
      this.disconnect();
    }
  }

  /**
   * Get current subscription count
   */
  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // ============================================================
  // Private methods
  // ============================================================

  private sendSubscription(conditionId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      const message = {
        type: 'subscribe',
        product_id: conditionId,
      };
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      this.emit('error', new Error(`Failed to send subscription: ${error}`));
    }
  }

  private sendUnsubscription(conditionId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      const message = {
        type: 'unsubscribe',
        product_id: conditionId,
      };
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      this.emit('error', new Error(`Failed to send unsubscription: ${error}`));
    }
  }

  private resubscribeAll(): void {
    this.subscriptions.forEach((_, conditionId) => {
      this.sendSubscription(conditionId);
    });
  }

  private handleMessage(data: string): void {
    try {
      const message: CLOBMessage = JSON.parse(data);

      // Handle price update messages
      if (message.type === 'price') {
        this.handlePriceMessage(message as PriceMessage);
      }
    } catch (error) {
      this.emit('error', new Error(`Failed to parse message: ${error}`));
    }
  }

  private handlePriceMessage(message: PriceMessage): void {
    const conditionId = message.condition_id || message.product_id;
    if (!conditionId) return;

    const callback = this.subscriptions.get(String(conditionId));
    if (!callback) return;

    try {
      const bid = parseFloat(String(message.best_bid ?? 0));
      const ask = parseFloat(String(message.best_ask ?? 1));
      const mid = (bid + ask) / 2;
      const spread = ask - bid;

      const update: PriceUpdate = {
        conditionId: String(conditionId),
        bid: Math.max(0, bid),
        ask: Math.max(0, ask),
        mid: Math.max(0, mid),
        spread: Math.max(0, spread),
        timestamp: new Date(),
      };

      callback(update);
      this.emit('price', update);
    } catch (error) {
      this.emit('error', new Error(`Failed to process price message: ${error}`));
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('error', new Error('Max reconnection attempts reached'));
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 30000);

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {
        // Error already emitted by connect()
      });
    }, delay);
  }
}

// ============================================================
// Snapshot Function — For Serverless Use
// ============================================================

/**
 * Get latest prices for a list of condition IDs
 *
 * Connects to WebSocket, subscribes to conditions, waits for price updates,
 * then disconnects. Suitable for serverless/cron functions that cannot
 * maintain persistent connections.
 *
 * @param conditionIds - Array of Polymarket condition IDs
 * @param timeoutMs - Maximum time to wait for prices (default 3000ms)
 * @returns Map of condition ID to price snapshot
 */
export async function getLatestPrices(
  conditionIds: string[],
  timeoutMs: number = 3000
): Promise<Map<string, PriceSnapshot>> {
  const prices = new Map<string, PriceSnapshot>();
  const priceFeed = new PriceFeed();

  return new Promise((resolve) => {
    let timeoutHandle: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      priceFeed.disconnect();
    };

    const resolveAndCleanup = () => {
      cleanup();
      resolve(prices);
    };

    // Set overall timeout
    timeoutHandle = setTimeout(() => {
      resolveAndCleanup();
    }, timeoutMs);

    // Subscribe to all condition IDs
    for (const conditionId of conditionIds) {
      priceFeed.subscribe(conditionId, (update: PriceUpdate) => {
        prices.set(update.conditionId, {
          conditionId: update.conditionId,
          bid: update.bid,
          ask: update.ask,
          mid: update.mid,
          spread: update.spread,
          lastUpdate: update.timestamp,
        });

        // If we have prices for all conditions, resolve early
        if (prices.size === conditionIds.length) {
          resolveAndCleanup();
        }
      });
    }

    // Handle connection errors
    priceFeed.on('error', (error) => {
      console.warn(`Price feed error: ${error}`);
    });

    // Start connection
    priceFeed.connect().catch(() => {
      // Connection error, still wait for timeout
    });
  });
}

// ============================================================
// Orderbook Depth Function — REST API
// ============================================================

/**
 * Get orderbook depth for a condition ID from REST API
 *
 * Uses Polymarket's CLOB REST API which is more reliable than WebSocket
 * for serverless use. Provides bid/ask depth information needed for
 * slippage estimation.
 *
 * @param conditionId - Polymarket condition ID
 * @returns Orderbook depth with best bid/ask and depth information
 */
export async function getOrderbookDepth(
  conditionId: string,
  timeoutMs: number = 5000
): Promise<OrderbookDepth> {
  const url = `https://clob.polymarket.com/book?token_id=${encodeURIComponent(conditionId)}`;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      console.error(`Orderbook API error: ${response.status} for ${conditionId}`);
      return {
        conditionId,
        bestBid: 0,
        bestAsk: 1,
        spread: 1,
        bidDepth: 0,
        askDepth: 0,
        timestamp: new Date(),
      };
    }

    const data = await response.json();

    // Parse orderbook response
    const bidLevels = data.bids || [];
    const askLevels = data.asks || [];

    const bestBid = bidLevels.length > 0 ? parseFloat(bidLevels[0][0]) : 0;
    const bestAsk = askLevels.length > 0 ? parseFloat(askLevels[0][0]) : 1;

    // Compute depth as sum of all levels
    let bidDepth = 0;
    let askDepth = 0;

    for (const [_, size] of bidLevels) {
      bidDepth += parseFloat(String(size));
    }

    for (const [_, size] of askLevels) {
      askDepth += parseFloat(String(size));
    }

    const spread = Math.max(0, bestAsk - bestBid);

    return {
      conditionId,
      bestBid: Math.max(0, bestBid),
      bestAsk: Math.max(0, bestAsk),
      spread,
      bidDepth,
      askDepth,
      timestamp: new Date(),
    };
  } catch (error) {
    console.error(`Failed to fetch orderbook for ${conditionId}:`, error);
    return {
      conditionId,
      bestBid: 0,
      bestAsk: 1,
      spread: 1,
      bidDepth: 0,
      askDepth: 0,
      timestamp: new Date(),
    };
  }
}

// ============================================================
// Price Validation & Analysis Functions
// ============================================================

/**
 * Check if a price snapshot is stale
 *
 * @param lastUpdate - Timestamp of last price update
 * @param maxAgeMs - Maximum age in milliseconds (default 30s)
 * @returns true if price is older than maxAgeMs
 */
export function isPriceStale(
  lastUpdate: Date,
  maxAgeMs: number = 30000
): boolean {
  const now = new Date();
  return now.getTime() - lastUpdate.getTime() > maxAgeMs;
}

/**
 * Compute spread percentage
 *
 * @param book - Orderbook depth
 * @returns Spread as percentage of mid price
 */
export function computeSpread(book: OrderbookDepth): number {
  const mid = (book.bestBid + book.bestAsk) / 2;
  if (mid === 0) return 0;
  return (book.spread / mid) * 100;
}

/**
 * Estimate slippage for a market order
 *
 * Uses orderbook depth to estimate the average execution price
 * for an order of given size. Assumes linear slippage across
 * available levels.
 *
 * @param book - Orderbook depth
 * @param orderSize - Size of order in tokens
 * @param isBuy - true for buy orders, false for sell orders
 * @returns Estimated slippage in percentage points
 */
export function estimateSlippage(
  book: OrderbookDepth,
  orderSize: number,
  isBuy: boolean = true
): number {
  if (orderSize <= 0) return 0;

  const mid = (book.bestBid + book.bestAsk) / 2;
  if (mid === 0) return 0;

  // For buy orders, we execute against asks
  // For sell orders, we execute against bids
  const depth = isBuy ? book.askDepth : book.bidDepth;
  const sidePrice = isBuy ? book.bestAsk : book.bestBid;

  if (depth === 0) {
    // No liquidity on side, very high slippage
    return 100;
  }

  // Simple linear model: average execution improves as we fill more
  // Assume average execution is halfway through available depth
  const avgPriceDelta = book.spread * Math.min(orderSize / (depth * 2), 0.5);
  const slippagePrice = sidePrice + (isBuy ? avgPriceDelta : -avgPriceDelta);

  return ((slippagePrice - mid) / mid) * 100;
}

/**
 * Validate price snapshot
 *
 * @param snapshot - Price snapshot to validate
 * @returns true if price appears valid
 */
export function isValidPrice(snapshot: PriceSnapshot): boolean {
  // Price should be between 0 and 1 (yes/no tokens)
  if (snapshot.bid < 0 || snapshot.ask > 1) return false;

  // Bid should not exceed ask
  if (snapshot.bid > snapshot.ask) return false;

  // Mid should be between bid and ask
  if (snapshot.mid < snapshot.bid || snapshot.mid > snapshot.ask) return false;

  // Spread should be non-negative
  if (snapshot.spread < 0) return false;

  return true;
}
