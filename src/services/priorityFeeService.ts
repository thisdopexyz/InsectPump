import { createModuleLogger } from '../utils/logger';
import { CONFIG } from '../config/config';

const logger = createModuleLogger('PriorityFee');

interface PriorityFeeResponse {
  priorityFeeEstimate: number;
  priorityFeeLevels?: {
    min: number;
    low: number;
    medium: number;
    high: number;
    veryHigh: number;
    unsafeMax: number;
  };
}

interface FeeCache {
  fee: number;
  timestamp: number;
}

/**
 * Smart Priority Fee Service
 * Fetches real-time priority fees from multiple sources with fallback
 */
export class PriorityFeeService {
  private heliusApiKey: string;
  private lastFee: FeeCache | null = null;
  private readonly CACHE_TTL_MS = CONFIG.FEE_CACHE_TTL_SECONDS * 1000;
  private readonly DEFAULT_FEE = CONFIG.FEE_TIER_URGENT; // Use CONFIG urgent tier
  private readonly MAX_FEE = CONFIG.PRIORITY_FEE_MAX_SOL; // Max cap (safety limit)
  private readonly MIN_FEE = CONFIG.FEE_TIER_NORMAL; // Use CONFIG normal tier

  constructor(heliusApiKey: string) {
    this.heliusApiKey = heliusApiKey;
    logger.info('[PriorityFee] Service initialized');
  }

  /**
   * Get recommended priority fee with caching
   * @param urgency 'normal' | 'high' | 'urgent' - determines percentile
   * @returns priority fee in SOL
   */
  async getRecommendedFee(urgency: 'normal' | 'high' | 'urgent' = 'normal'): Promise<number> {
    const now = Date.now();

    // Check cache
    if (this.lastFee && (now - this.lastFee.timestamp) < this.CACHE_TTL_MS) {
      logger.debug(`[PriorityFee] Using cached fee: ${this.lastFee.fee} SOL (${urgency})`);
      return this.adjustFeeByUrgency(this.lastFee.fee, urgency);
    }

    try {
      const fee = await this.fetchHeliusFee(urgency);
      this.lastFee = { fee, timestamp: now };
      return fee;
    } catch (error) {
      logger.warn(`[PriorityFee] Helius fetch failed, trying fallback: ${error}`);

      try {
        const fee = await this.fetchSolanaFMFee(urgency);
        this.lastFee = { fee, timestamp: now };
        return fee;
      } catch (fallbackError) {
        logger.warn(`[PriorityFee] Fallback failed, using default: ${fallbackError}`);
        return this.adjustFeeByUrgency(this.DEFAULT_FEE, urgency);
      }
    }
  }

  /**
   * Fetch fee from Helius API (primary source)
   */
  private async fetchHeliusFee(urgency: 'normal' | 'high' | 'urgent'): Promise<number> {
    const url = `https://mainnet.helius-rpc.com/?api-key=${this.heliusApiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getPriorityFeeEstimate',
        params: [
          {
            accountKeys: [],
            options: {
              includeAllPriorityFeeLevels: true
            }
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Helius API error: ${response.status}`);
    }

    const data = await response.json() as { result?: PriorityFeeResponse };

    if (!data.result) {
      throw new Error('Invalid Helius response');
    }

    const levels = data.result.priorityFeeLevels;
    let baseFee = this.DEFAULT_FEE;

    if (levels) {
      // Convert microLamports to SOL (1 SOL = 1e9 lamports, microLamports = 1e-6 lamports)
      switch (urgency) {
        case 'urgent':
          baseFee = (levels.veryHigh || levels.high || 50000) * 1e-15;
          break;
        case 'high':
          baseFee = (levels.high || levels.medium || 30000) * 1e-15;
          break;
        case 'normal':
        default:
          baseFee = (levels.medium || levels.low || 10000) * 1e-15;
          break;
      }
    } else if (data.result.priorityFeeEstimate) {
      baseFee = data.result.priorityFeeEstimate * 1e-15;
    }

    const clampedFee = this.clampFee(baseFee);
    logger.info(`[PriorityFee] Helius ${urgency}: ${clampedFee.toFixed(6)} SOL`);
    return clampedFee;
  }

  /**
   * Fetch fee from Solana.FM API (fallback)
   */
  private async fetchSolanaFMFee(urgency: 'normal' | 'high' | 'urgent'): Promise<number> {
    const response = await fetch('https://api.solana.fm/v0/priority-fee');

    if (!response.ok) {
      throw new Error(`SolanaFM API error: ${response.status}`);
    }

    const data = await response.json() as {
      data?: {
        percentile50?: number;
        percentile75?: number;
        percentile90?: number;
      }
    };

    if (!data.data) {
      throw new Error('Invalid SolanaFM response');
    }

    let baseFee = this.DEFAULT_FEE;

    switch (urgency) {
      case 'urgent':
        baseFee = (data.data.percentile90 || 50000) * 1e-9;
        break;
      case 'high':
        baseFee = (data.data.percentile75 || 30000) * 1e-9;
        break;
      case 'normal':
      default:
        baseFee = (data.data.percentile50 || 10000) * 1e-9;
        break;
    }

    const clampedFee = this.clampFee(baseFee);
    logger.info(`[PriorityFee] SolanaFM ${urgency}: ${clampedFee.toFixed(6)} SOL`);
    return clampedFee;
  }

  /**
   * Adjust cached fee based on urgency
   */
  private adjustFeeByUrgency(baseFee: number, urgency: 'normal' | 'high' | 'urgent'): number {
    switch (urgency) {
      case 'urgent':
        return this.clampFee(baseFee * 1.5);
      case 'high':
        return this.clampFee(baseFee * 1.2);
      case 'normal':
      default:
        return this.clampFee(baseFee);
    }
  }

  /**
   * Clamp fee between MIN and MAX
   */
  private clampFee(fee: number): number {
    return Math.max(this.MIN_FEE, Math.min(this.MAX_FEE, fee));
  }

  /**
   * Clear cache (useful for testing or after errors)
   */
  clearCache(): void {
    this.lastFee = null;
    logger.debug('[PriorityFee] Cache cleared');
  }
}
