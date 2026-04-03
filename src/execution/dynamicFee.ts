import { Connection } from '@solana/web3.js';
import { logger } from '../utils/logger';
import { CONFIG } from '../config/config';

/**
 * Dynamic Priority Fee Calculator
 * Adjusts transaction priority fees based on network congestion
 */
export class DynamicFeeService {
  private connection: Connection;
  private lastFeeUpdate: number = 0;
  private cachedFee: number = CONFIG.FEE_TIER_NORMAL; // Default from CONFIG
  private readonly CACHE_TTL_MS = CONFIG.FEE_CACHE_TTL_SECONDS * 1000;

  // Fee tiers from CONFIG
  private readonly FEE_TIERS = {
    low: CONFIG.FEE_TIER_LOW,
    normal: CONFIG.FEE_TIER_NORMAL,
    high: CONFIG.FEE_TIER_HIGH,
    urgent: CONFIG.FEE_TIER_URGENT
  };

  constructor(connection: Connection) {
    this.connection = connection;
    logger.info(`[DynamicFee] Initialized with default fee: ${CONFIG.FEE_TIER_NORMAL} SOL`);
  }

  /**
   * Get current recommended priority fee
   * Fetches from network if cache expired
   */
  async getRecommendedFee(urgency: 'low' | 'normal' | 'high' | 'urgent' = 'normal'): Promise<number> {
    const now = Date.now();

    // Return cached fee if still fresh
    if (now - this.lastFeeUpdate < this.CACHE_TTL_MS) {
      return this.applyUrgencyMultiplier(this.cachedFee, urgency);
    }

    try {
      // Fetch recent prioritization fees from network
      // This returns fees for recent slots, we take median of high percentile
      const recentFees = await this.connection.getRecentPrioritizationFees({
        lockedWritableAccounts: []
      });

      if (!recentFees || recentFees.length === 0) {
        logger.warn('[DynamicFee] No fee data, using default');
        return this.FEE_TIERS[urgency];
      }

      // Sort by fee amount
      const sortedFees = recentFees
        .map(f => f.prioritizationFee)
        .sort((a, b) => a - b);

      // Calculate percentiles
      const medianFee = sortedFees[Math.floor(sortedFees.length / 2)];
      const p90Fee = sortedFees[Math.floor(sortedFees.length * 0.9)];

      // Convert from micro-lamports to SOL
      const medianFeeSol = medianFee / 1e9;
      const p90FeeSol = p90Fee / 1e9;

      // Use P90 for better landing rate, with minimum threshold
      let recommendedFee = Math.max(p90FeeSol, this.FEE_TIERS.normal);

      // Cap at urgent tier to prevent excessive fees
      recommendedFee = Math.min(recommendedFee, this.FEE_TIERS.urgent);

      // Update cache
      this.cachedFee = recommendedFee;
      this.lastFeeUpdate = now;

      logger.info(`[DynamicFee] Network fee: median=${medianFeeSol.toFixed(6)} SOL, p90=${p90FeeSol.toFixed(6)} SOL, using=${recommendedFee.toFixed(6)} SOL`);

      return this.applyUrgencyMultiplier(recommendedFee, urgency);

    } catch (error) {
      logger.error(`[DynamicFee] Error fetching fees: ${error}`);
      return this.FEE_TIERS[urgency];
    }
  }

  /**
   * Apply urgency multiplier to base fee
   */
  private applyUrgencyMultiplier(baseFee: number, urgency: 'low' | 'normal' | 'high' | 'urgent'): number {
    const multipliers = {
      low: 0.5,      // 50% of recommended
      normal: 1.0,   // 100% of recommended
      high: 2.0,     // 200% of recommended
      urgent: 5.0    // 500% of recommended
    };

    return Math.min(baseFee * multipliers[urgency], this.FEE_TIERS.urgent);
  }

  /**
   * Quick fee estimate without network call (uses cache)
   */
  getFeeEstimate(urgency: 'low' | 'normal' | 'high' | 'urgent' = 'normal'): number {
    return this.applyUrgencyMultiplier(this.cachedFee, urgency);
  }

  /**
   * Force refresh fee from network
   */
  async refreshFees(): Promise<void> {
    this.lastFeeUpdate = 0; // Reset cache
    await this.getRecommendedFee('normal');
  }

  /**
   * Get fee tier constants for reference
   */
  getFeeTiers(): typeof this.FEE_TIERS {
    return { ...this.FEE_TIERS };
  }
}

// Singleton instance
let feeService: DynamicFeeService | null = null;

export function initDynamicFeeService(connection: Connection): DynamicFeeService {
  feeService = new DynamicFeeService(connection);
  return feeService;
}

export function getDynamicFeeService(): DynamicFeeService | null {
  return feeService;
}
