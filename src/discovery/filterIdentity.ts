import { Connection, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG } from '../config/config';
import type { FilterResult } from '../types/index';

// Use FilterResult from types/index.d.ts which includes data?: unknown

/**
 * FilterIdentity - Bot/Dev Detection dengan Cost-Saving Strategy
 * 
 * Layer 1: Blacklist check (memory, instant)
 * Layer 2: Alchemy getSignaturesForAddress (FREE - unlimited calls)
 * Layer 3: Simple heuristics (no expensive getTransaction calls)
 * 
 * Key insight: getSignaturesForAddress is FREE on Alchemy
 * getTransaction is EXPENSIVE on Helius (1 credit per call)
 */
export class FilterIdentity {
  private blacklistSet: Set<string> = new Set();
  private blacklistPath: string;
  private alchemyConnection: Connection;

  constructor() {
    // Use Alchemy for all identity checks (FREE tier)
    const alchemyUrl = `${CONFIG.ALCHEMY_RPC_URL}/v2/${CONFIG.ALCHEMY_API_KEY}`;
    this.alchemyConnection = new Connection(alchemyUrl, 'confirmed');
    this.blacklistPath = path.join(process.cwd(), 'data', 'blacklist.json');
    this.init();
  }

  private init(): void {
    try {
      if (fs.existsSync(this.blacklistPath)) {
        const data = fs.readFileSync(this.blacklistPath, 'utf-8');
        const blacklist = JSON.parse(data);
        if (Array.isArray(blacklist.wallets)) {
          this.blacklistSet = new Set(blacklist.wallets.map((w: string) => w.toLowerCase()));
        }
      } else {
        // Create default blacklist file
        fs.mkdirSync(path.dirname(this.blacklistPath), { recursive: true });
        fs.writeFileSync(this.blacklistPath, JSON.stringify({ wallets: [] }, null, 2));
      }
    } catch (error) {
      console.error('[FilterIdentity] Error loading blacklist:', error);
      this.blacklistSet = new Set();
    }
  }

  private addToBlacklist(wallet: string): void {
    try {
      const walletLower = wallet.toLowerCase();
      
      // Add to memory
      this.blacklistSet.add(walletLower);
      
      // Persist to file
      let data = { wallets: [] as string[] };
      if (fs.existsSync(this.blacklistPath)) {
        const fileContent = fs.readFileSync(this.blacklistPath, 'utf-8');
        data = JSON.parse(fileContent);
      }
      
      if (!data.wallets.includes(walletLower)) {
        data.wallets.push(walletLower);
        fs.writeFileSync(this.blacklistPath, JSON.stringify(data, null, 2));
        console.log(`[FilterIdentity] 🚫 Added to blacklist: ${wallet}`);
      }
    } catch (error) {
      console.error('[FilterIdentity] Error adding to blacklist:', error);
    }
  }

  /**
   * Main filter function - Cost Optimized
   * 
   * Strategy:
   * 1. Blacklist check (instant)
   * 2. TX count via Alchemy (FREE)
   * 3. Simple heuristics based on TX signatures (FREE)
   * 
   * Zero Helius credits used!
   */
  public async filterIdentity(wallet: string): Promise<FilterResult> {
    const walletLower = wallet.toLowerCase();
    
    // === Layer 1: Blacklist check ===
    if (this.blacklistSet.has(walletLower)) {
      return { passed: false, reason: 'Blacklisted' };
    }

    try {
      const publicKey = new PublicKey(wallet);
      
      // === Layer 2: Get recent signatures via Alchemy (FREE) ===
      // Alchemy free tier = unlimited getSignaturesForAddress
      const signatures = await this.alchemyConnection.getSignaturesForAddress(
        publicKey, 
        { limit: 20 }
      );

      if (!signatures || signatures.length === 0) {
        // Empty wallet - fail closed (likely fresh/burn wallet)
        return { 
          passed: false, 
          reason: 'Fresh wallet (no transaction history)' 
        };
      }

      // === Layer 3: Simple heuristics (no expensive getTransaction calls) ===
      
      // Heuristic 1: Check for token creation patterns in memo/signature
      // Dev wallets often have clustered CREATE transactions
      const hasCreatePattern = signatures.some((sig, index) => {
        // Check memo (some devs leave traces in memo)
        const memo = sig.memo?.toLowerCase() || '';
        return memo.includes('create') || memo.includes('mint') || memo.includes('deploy');
      });

      if (hasCreatePattern) {
        this.addToBlacklist(wallet);
        return { passed: false, reason: 'Developer pattern detected (memo)' };
      }

      // Heuristic 2: TX frequency pattern (bots have regular intervals)
      const timestamps = signatures
        .filter(s => s.blockTime)
        .map(s => s.blockTime as number);
      
      if (timestamps.length >= 5) {
        // Calculate intervals between transactions
        const intervals: number[] = [];
        for (let i = 1; i < timestamps.length; i++) {
          intervals.push(timestamps[i - 1] - timestamps[i]); // Descending order
        }
        
        // Bot detection: very regular intervals (< 2 min variance)
        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const variance = intervals.reduce((sum, val) => 
          sum + Math.pow(val - avgInterval, 2), 0
        ) / intervals.length;
        
        // If variance is very low and avg interval is regular, likely bot
        if (variance < 10 && avgInterval < 300) { // < 10s variance, < 5 min avg
          this.addToBlacklist(wallet);
          return { passed: false, reason: 'Bot pattern detected (regular intervals)' };
        }
      }

      // Heuristic 3: Check err field (failed transactions pattern)
      // Bots often have many failed txs
      const failedTxs = signatures.filter(s => s.err !== null).length;
      const failRate = signatures.length > 0 ? failedTxs / signatures.length : 0;
      
      if (failRate > CONFIG.FAIL_RATE_THRESHOLD) {
        this.addToBlacklist(wallet);
        return { passed: false, reason: 'High failure rate (bot/buggy)' };
      }

      // All heuristics passed
      return { 
        passed: true,
        data: { 
          txCount: signatures.length,
          failedRate: failRate 
        }
      };

    } catch (error) {
      console.error(`[FilterIdentity] Error checking wallet ${wallet}:`, error);
      // Fail open - don't block on RPC error
      return { passed: true };
    }
  }

  /**
   * Quick check: Is this wallet blacklisted?
   */
  public isBlacklisted(wallet: string): boolean {
    return this.blacklistSet.has(wallet.toLowerCase());
  }

  /**
   * Get blacklist size
   */
  public getBlacklistSize(): number {
    return this.blacklistSet.size;
  }

  /**
   * Bulk check multiple wallets (for batch operations)
   * Uses Alchemy only (free)
   */
  public async bulkCheck(wallets: string[]): Promise<Map<string, FilterResult>> {
    const results = new Map<string, FilterResult>();
    
    for (const wallet of wallets) {
      results.set(wallet, await this.filterIdentity(wallet));
    }
    
    return results;
  }
}
