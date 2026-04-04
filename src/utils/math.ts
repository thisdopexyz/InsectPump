// Math utilities for InsectPump

import { CONSTANTS } from '../config/constants';
import { CONFIG } from '../config/config';

/**
 * Calculate token price using Constant Product formula
 * P = vSolReserves / vTokenReserves
 */
export function calculatePrice(vSolReserves: number, vTokenReserves: number): number {
  if (vTokenReserves === 0) return 0;
  return vSolReserves / vTokenReserves;
}

/**
 * Calculate Market Cap in SOL
 * Mcap = vSolReserves × 2
 * (Total supply Pump.fun = 1B token, bonding curve ends at ~30 SOL)
 */
export function calculateMcap(vSolReserves: number): number {
  return vSolReserves * 2;
}

/**
 * Convert lamports to SOL
 */
export function lamportsToSol(lamports: number): number {
  return lamports / CONSTANTS.LAMPORTS_PER_SOL;
}

/**
 * Convert SOL to lamports
 */
export function solToLamports(sol: number): number {
  return sol * CONSTANTS.LAMPORTS_PER_SOL;
}

/**
 * Convert basis points (bps) to percentage
 * 100 bps = 1%, 50 bps = 0.5%
 * Used for slippage calculations
 */
export function bpsToPercentage(bps: number): number {
  return bps / 100;
}

/**
 * Format number to fixed decimals
 */
export function formatNumber(num: number, decimals = 4): string {
  return num.toFixed(decimals);
}

/**
 * Calculate percentage change
 */
export function calculatePercentChange(oldVal: number, newVal: number): number {
  if (oldVal === 0) return 0;
  return ((newVal - oldVal) / oldVal) * 100;
}

/**
 * Calculate winrate percentage
 */
export function calculateWinrate(wins: number, total: number): number {
  if (total === 0) return 0;
  return (wins / total) * 100;
}

/**
 * Sleep utility for async delays
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts = CONFIG.MATH_RETRY_ATTEMPTS,
  baseDelay = 1000
): Promise<T> {
  let lastError: Error | undefined;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (attempt === maxAttempts) {
        throw lastError;
      }
      
      const delay = baseDelay * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }
  
  throw lastError || new Error('Retry failed');
}

/**
 * Truncate string with ellipsis
 */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...';
}

/**
 * Parse timestamp to Date
 */
export function parseTimestamp(ts: number): Date {
  // Handle both seconds and milliseconds
  if (ts < 10000000000) {
    return new Date(ts * 1000);
  }
  return new Date(ts);
}
