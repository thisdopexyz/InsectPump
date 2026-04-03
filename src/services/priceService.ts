import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG } from '../config/config';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('PriceService');

// Raydium AMM program untuk pool detection
const RAYDIUM_AMM_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CPMM_PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunXiHgG8PnM1b6eJMEmc5BD';

interface PumpPortalPrice {
  mint: string;
  price: number;
  marketCap: number;
  liquidity: number;
  timestamp: number;
}

interface RaydiumPool {
  id: string;
  baseMint: string;
  quoteMint: string;
  baseReserve: number;
  quoteReserve: number;
  lpReserve: number;
}

export class PriceService {
  private heliusConnection: Connection;
  private pumpPortalApiUrl = 'https://pumpportal.fun/api';
  
  // Cache untuk price (WSS update nyimpen disini)
  private priceCache: Map<string, {
    price: number;
    marketCap: number;
    timestamp: number;
    source: 'wss' | 'api' | 'raydium';
  }> = new Map();

  constructor() {
    this.heliusConnection = new Connection(CONFIG.HELIUS_RPC_URL, 'confirmed');
  }

  /**
   * Update price dari WSS (dipanggil oleh PriceMonitor)
   */
  public updatePriceFromWSS(tokenAddress: string, price: number, marketCap: number): void {
    this.priceCache.set(tokenAddress.toLowerCase(), {
      price,
      marketCap,
      timestamp: Date.now(),
      source: 'wss'
    });
  }

  /**
   * Get token price - mencoba beberapa source:
   * 1. WSS Cache (real-time)
   * 2. PumpPortal API (on-demand)
   * 3. Raydium Pool (on-chain calculation)
   * 
   * NO JUPITER - untuk avoid rate limit/block
   */
  public async getTokenPrice(tokenAddress: string): Promise<number> {
    const tokenLower = tokenAddress.toLowerCase();
    
    // 1. Check WSS cache dulu (paling fresh)
    const cached = this.priceCache.get(tokenLower);
    if (cached && (Date.now() - cached.timestamp) < CONFIG.PRICE_CACHE_TTL_SECONDS * 1000) {
      logger.info(`[PriceService] Price from WSS cache: ${cached.price.toFixed(9)} SOL`);
      return cached.price;
    }

    // 2. Try PumpPortal API
    try {
      const ppPrice = await this.getPumpPortalPrice(tokenLower);
      if (ppPrice > 0) {
        this.priceCache.set(tokenLower, {
          price: ppPrice,
          marketCap: 0,
          timestamp: Date.now(),
          source: 'api'
        });
        return ppPrice;
      }
    } catch (error) {
      logger.warn(`[PriceService] PumpPortal API failed: ${error}`);
    }

    // 3. Fallback: Raydium Pool
    try {
      const raydiumPrice = await this.getRaydiumPoolPrice(tokenLower);
      if (raydiumPrice > 0) {
        this.priceCache.set(tokenLower, {
          price: raydiumPrice,
          marketCap: 0,
          timestamp: Date.now(),
          source: 'raydium'
        });
        return raydiumPrice;
      }
    } catch (error) {
      logger.warn(`[PriceService] Raydium pool failed: ${error}`);
    }

    logger.error(`[PriceService] All price sources failed for ${tokenAddress}`);
    return 0;
  }

  /**
   * Query PumpPortal API untuk current price
   * Endpoint: /api/data (REST fallback kalau WSS disconnect)
   */
  private async getPumpPortalPrice(tokenAddress: string): Promise<number> {
    try {
      // PumpPortal REST API (kalau available)
      const response = await axios.get(`${this.pumpPortalApiUrl}/sol-price`, {
        timeout: CONFIG.API_TIMEOUT_MS,
        headers: {
          'Accept': 'application/json'
        }
      });

      // Kalau PumpPortal kasih token-specific endpoint
      if (response.data && response.data[tokenAddress]) {
        return response.data[tokenAddress].price || 0;
      }

      return 0;
    } catch (error) {
      // PumpPortal mungkin ga ada REST endpoint untuk individual token
      // Fallback ke 0, nanti ambil dari WSS
      return 0;
    }
  }

  /**
   * Query Raydium Pool untuk price calculation
   * Via Helius getProgramAccounts - cukup 1 call
   */
  private async getRaydiumPoolPrice(tokenAddress: string): Promise<number> {
    try {
      // Cari Raydium pool yang quote-nya SOL/SOL-wrapped
      const tokenPubkey = new PublicKey(tokenAddress);
      
      // Query Raydium AMM pools yang baseMint = token kita
      const pools = await this.heliusConnection.getProgramAccounts(
        new PublicKey(RAYDIUM_AMM_PROGRAM),
        {
          filters: [
            { dataSize: 752 }, // Raydium AMM pool account size
            { memcmp: { offset: 400, bytes: tokenAddress } } // baseMint offset
          ]
        }
      );

      if (pools.length === 0) {
        // Try CPMM
        const cpmmPools = await this.heliusConnection.getProgramAccounts(
          new PublicKey(RAYDIUM_CPMM_PROGRAM),
          {
            filters: [
              { memcmp: { offset: 64, bytes: tokenAddress } }
            ]
          }
        );
        
        if (cpmmPools.length === 0) return 0;
        
        // Calculate price dari CPMM pool
        const pool = cpmmPools[0].account.data;
        // CPMM price calculation (simplified)
        // Pool state layout: vaultA (8 bytes), vaultB (8 bytes)...
        return this.calculateCPMMPrice(pool);
      }

      // Calculate price dari AMM pool
      const pool = pools[0].account.data;
      return this.calculateAMMPrice(pool);

    } catch (error) {
      logger.error(`[PriceService] Raydium query error: ${error}`);
      return 0;
    }
  }

  /**
   * Calculate price dari Raydium AMM pool data
   * Pool layout: https://github.com/raydium-io/raydium-sdk
   */
  private calculateAMMPrice(poolData: Buffer): number {
    try {
      // Raydium AMM Pool layout (simplified):
      // - status: u64 (8 bytes)
      // - nonce: u64 (8 bytes) 
      // - max_order: u64 (8 bytes)
      // - depth: u64 (8 bytes)
      // - coin_decimals: u64 (8 bytes) - offset 32
      // - pc_decimals: u64 (8 bytes)
      // - state: u64 (8 bytes)
      // - reset_flag: u64 (8 bytes)
      // - min_size: u64 (8 bytes)
      // - vol_max_cut_ratio: u64 (8 bytes)
      // - amount_wave_ratio: u64 (8 bytes)
      // - coin_lot_size: u64 (8 bytes)
      // - pc_lot_size: u64 (8 bytes)
      // - min_price_multiplier: u64 (8 bytes)
      // - max_price_multiplier: u64 (8 bytes)
      // - sys_decimal_value: u64 (8 bytes)
      // - fees: ... (128 bytes)
      // - coin_reserve: u64 (8 bytes) - base token reserve - offset ~424
      // - pc_reserve: u64 (8 bytes) - quote token (SOL) reserve
      
      // This is simplified - real implementation need proper decoding
      const coinReserve = poolData.readBigUInt64LE(424);
      const pcReserve = poolData.readBigUInt64LE(432);
      
      if (coinReserve === BigInt(0)) return 0;
      
      // price = pc_reserve / coin_reserve (SOL per token)
      const price = Number(pcReserve) / Number(coinReserve);
      return price;
    } catch (error) {
      logger.error(`[PriceService] AMM price calc error: ${error}`);
      return 0;
    }
  }

  /**
   * Calculate price dari Raydium CPMM pool
   */
  private calculateCPMMPrice(poolData: Buffer): number {
    try {
      // CPMM uses constant product formula: x * y = k
      // Price = y / x
      // Vault offsets depend on specific CPMM version
      
      // Simplified: read vault balances
      const vaultA = poolData.readBigUInt64LE(128); // token
      const vaultB = poolData.readBigUInt64LE(136); // SOL
      
      if (vaultA === BigInt(0)) return 0;
      
      return Number(vaultB) / Number(vaultA);
    } catch (error) {
      logger.error(`[PriceService] CPMM price calc error: ${error}`);
      return 0;
    }
  }

  /**
   * Get cached price (untuk PriceMonitor/trailing stop check)
   */
  public getCachedPrice(tokenAddress: string): number {
    const cached = this.priceCache.get(tokenAddress.toLowerCase());
    return cached?.price || 0;
  }

/**
   * Check if price is fresh (under PRICE_CACHE_TTL_SECONDS)
   */
  isPriceFresh(tokenAddress: string): boolean {
    const cached = this.priceCache.get(tokenAddress.toLowerCase());
    if (!cached) return false;
    
    return (Date.now() - cached.timestamp) < CONFIG.PRICE_CACHE_TTL_SECONDS * 1000;
  }
  /**
   * Clear old cache entries
   */
  public clearOldCache(maxAgeMs: number = CONFIG.PRICE_CACHE_TTL_SECONDS * 1000): void {
    const now = Date.now();
    const keysToDelete: string[] = [];
    
    this.priceCache.forEach((value, key) => {
      if (now - value.timestamp > maxAgeMs) {
        keysToDelete.push(key);
      }
    });
    
    keysToDelete.forEach(key => this.priceCache.delete(key));
  }
}

// Export singleton
export const priceService = new PriceService();
