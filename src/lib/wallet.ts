// ============================================================
// ARBITER — Polygon Wallet & Signer Management
// ============================================================
// Handles private key → Signer initialization for Polymarket
// CLOB order signing. The private key is the one exported from
// your Polymarket account (Settings → Advanced → Export).
//
// SECURITY: Private key is read from env vars only. Never
// logged, never stored in DB, never sent to any API except
// for local EIP-712 signing.
// ============================================================

import { ethers } from 'ethers';

// Polygon Mainnet chain ID
export const POLYGON_CHAIN_ID = 137;

// Default public Polygon RPC (fallback if no custom RPC configured)
const DEFAULT_POLYGON_RPC = 'https://polygon-rpc.com';

// USDC contract on Polygon
export const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

// Polymarket CTF Exchange contract (Conditional Token Framework)
export const CTF_EXCHANGE_ADDRESS = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

// Polymarket Neg Risk CTF Exchange (for neg risk markets)
export const NEG_RISK_CTF_EXCHANGE_ADDRESS = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

/**
 * Check if live trading environment variables are configured.
 * Does NOT check if guardrails are passed — that's a separate check.
 */
export function isLiveTradingConfigured(): boolean {
  return !!(
    process.env.POLYMARKET_PRIVATE_KEY &&
    process.env.LIVE_TRADING_ENABLED === 'true'
  );
}

/**
 * Get a configured ethers Signer for Polygon.
 * Returns null if private key is not configured.
 */
export function getSigner(): ethers.Wallet | null {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) return null;

  const rpcUrl = process.env.POLYGON_RPC_URL || DEFAULT_POLYGON_RPC;
  const provider = new ethers.JsonRpcProvider(rpcUrl, POLYGON_CHAIN_ID);

  return new ethers.Wallet(privateKey, provider);
}

/**
 * Get the wallet address without creating a full provider connection.
 * Useful for display and balance checks.
 */
export function getWalletAddress(): string | null {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) return null;

  try {
    const wallet = new ethers.Wallet(privateKey);
    return wallet.address;
  } catch {
    return null;
  }
}

/**
 * Get USDC balance for the configured wallet on Polygon.
 * Returns balance in human-readable format (6 decimals for USDC).
 */
export async function getUSDCBalance(): Promise<number | null> {
  const signer = getSigner();
  if (!signer) return null;

  try {
    const usdcAbi = ['function balanceOf(address) view returns (uint256)'];
    const usdc = new ethers.Contract(USDC_ADDRESS, usdcAbi, signer.provider);
    const balance = await usdc.balanceOf(signer.address);
    // USDC has 6 decimals on Polygon
    return parseFloat(ethers.formatUnits(balance, 6));
  } catch (err) {
    console.error('[wallet] Failed to fetch USDC balance:', err);
    return null;
  }
}

/**
 * Get MATIC balance for gas fees.
 */
export async function getMATICBalance(): Promise<number | null> {
  const signer = getSigner();
  if (!signer || !signer.provider) return null;

  try {
    const balance = await signer.provider.getBalance(signer.address);
    return parseFloat(ethers.formatEther(balance));
  } catch (err) {
    console.error('[wallet] Failed to fetch MATIC balance:', err);
    return null;
  }
}

/**
 * Validate that the wallet has sufficient funds for trading.
 * Checks both USDC (for bets) and MATIC (for gas).
 */
export async function validateWalletFunds(requiredUSDC: number): Promise<{
  ok: boolean;
  usdcBalance: number;
  maticBalance: number;
  errors: string[];
}> {
  const errors: string[] = [];

  const usdcBalance = await getUSDCBalance();
  const maticBalance = await getMATICBalance();

  if (usdcBalance === null) {
    errors.push('Could not fetch USDC balance');
    return { ok: false, usdcBalance: 0, maticBalance: 0, errors };
  }

  if (maticBalance === null) {
    errors.push('Could not fetch MATIC balance');
    return { ok: false, usdcBalance: usdcBalance || 0, maticBalance: 0, errors };
  }

  if (usdcBalance < requiredUSDC) {
    errors.push(`Insufficient USDC: have $${usdcBalance.toFixed(2)}, need $${requiredUSDC.toFixed(2)}`);
  }

  // Need at least 0.01 MATIC for gas (~a few transactions)
  if (maticBalance < 0.01) {
    errors.push(`Low MATIC for gas: ${maticBalance.toFixed(4)} MATIC (need >= 0.01)`);
  }

  return {
    ok: errors.length === 0,
    usdcBalance,
    maticBalance,
    errors,
  };
}
