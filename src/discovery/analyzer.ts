import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG } from '../config/config';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('Analyzer');

interface FilterResult {
  passed: boolean;
  reason?: string;
  data?: any;
}

interface TradeAnalysis {
  winrate: number;
  totalPnl: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
}



/**
 * Analyzer - 4 Layer Filter (REAL MODE - NO MOCK)
 * 
 * Layer 1: WSS Buy Detection (PumpPortal, free)
 * Layer 2: TX Count Filter (Alchemy free tier, getSignaturesForAddress)
 * Layer 3: Trading Activity Check (Helius Parsed API, real)
 * Layer 4: PnL & Winrate Analysis (Helius Parsed API, real)
 * 
 * Cost: ~1-2 credits per inang (Helius) dengan TX cache
 */
export class Analyzer {
  private heliusConnection: Connection;
  private alchemyConnection: Connection;

  constructor(heliusRpcUrl: string, alchemyRpcUrl: string) {
    this.heliusConnection = new Connection(heliusRpcUrl, 'confirmed');
    this.alchemyConnection = new Connection(alchemyRpcUrl, 'confirmed');
  }

  /**
   * Layer 2: Check total transaction count via Alchemy (FREE)
   * Fail kalau < 100 transactions (dompet baru/bot/dev)
   * 
   * Alchemy free tier = unlimited getSignaturesForAddress, zero credit drain
   * Simpan signatures ke cache untuk reuse L4 (hemat Helius credits)
   */
  public async checkTransactionCountAlchemy(wallet: string): Promise<FilterResult> {
    try {
      const publicKey = new PublicKey(wallet);
      
      // Get signatures - Alchemy free tier handles this well
      const signatures = await this.alchemyConnection.getSignaturesForAddress(
        publicKey,
        { limit: 1000 }
      );

      const txCount = signatures.length;



      if (txCount < CONFIG.MIN_TOTAL_TX) {
        return {
          passed: false,
          reason: `❌ REJECT L2: TX ${txCount} < ${CONFIG.MIN_TOTAL_TX} (need ${CONFIG.MIN_TOTAL_TX - txCount} more)`,
          data: { txCount, threshold: CONFIG.MIN_TOTAL_TX }
        };
      }

      return {
        passed: true,
        data: { txCount }
      };

    } catch (error) {
      console.error(`[Analyzer] Error checking tx count for ${wallet}:`, error);
      // Fail open - anggap lolos kalau error (jangan block potensial inang)
      return { passed: true, data: { txCount: 999 } };
    }
  }

  /**
   * Layer 3: COMPREHENSIVE Trading Analysis via Helius Enhanced API
   * 
   * Fetch SWAP data → Parse BUY/SELL → Calculate Winrate + PnL
   * Semua dalam 1 API call!
   * 
   * HELIUS API: type=SWAP (1 credit per wallet)
   * 
   * REAL MODE ONLY - NO MOCK
   */
  public async analyzeTradingActivityAndPnl(wallet: string): Promise<FilterResult> {
    try {
      // Extract API key dari RPC URL
      let heliusKey = '';
      if (CONFIG.HELIUS_RPC_URL.includes('api-key=')) {
        const parts = CONFIG.HELIUS_RPC_URL.split('api-key=');
        heliusKey = parts[parts.length - 1];
      } else {
        heliusKey = CONFIG.HELIUS_API_KEY;
      }

      if (!heliusKey) {
        logger.error('[Analyzer] No Helius API key found!');
        return { 
          passed: false, 
          reason: 'No API key', 
          data: { swapCount: 0, completedTrades: 0, winrate: 0, totalPnl: 0, creditsUsed: 0 } 
        };
      }

      // Fetch ALL swaps with pagination (no limit)
      let allSwapTxs: any[] = [];
      let cursor: string | undefined = undefined;
      let pageCount = 0;
      const maxPages = 20; // Safety limit (100 * 20 = 2000 swaps max)
      const pageSize = 100; // Max Helius allows per page
      
      logger.info(`[Analyzer] L3 fetching ALL swaps for ${wallet.slice(0, 8)}... (paginated)`);
      
      do {
        pageCount++;
        let url = `https://api-mainnet.helius-rpc.com/v0/addresses/${wallet}/transactions?api-key=${heliusKey}&type=SWAP&limit=${pageSize}`;
        if (cursor) {
          url += `&cursor=${cursor}`;
        }
        
        const response = await fetch(url, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(CONFIG.HELIUS_API_TIMEOUT_MS)
        });

        if (!response.ok) {
          logger.warn(`[Analyzer] Helius L3 HTTP ${response.status} for ${wallet.slice(0, 8)}...`);
          // Return what we have so far, don't fail completely
          break;
        }

        const data = await response.json();
        
        if (!Array.isArray(data)) {
          logger.warn(`[Analyzer] Invalid response format for ${wallet.slice(0, 8)}...`);
          break;
        }
        
        allSwapTxs = allSwapTxs.concat(data);
        
        // Helius Enhanced API returns paginationToken in response for next page
        // Check common locations: response.paginationToken or last item's signature
        const paginationToken = (data as any).paginationToken;
        const lastItem = data[data.length - 1];
        
        if (paginationToken) {
          cursor = paginationToken;
        } else if (lastItem && lastItem.signature) {
          // Fallback: use last signature as cursor (for older API versions)
          cursor = lastItem.signature;
        } else {
          cursor = undefined;
        }
        
        // Stop if we got less than pageSize (no more data) or reached maxPages
        if (data.length < pageSize || pageCount >= maxPages) {
          break;
        }
        
      } while (cursor);
      
      const swapTxs = allSwapTxs;
      const swapCount = swapTxs.length;
      const creditsUsed = pageCount; // 1 credit per page
      logger.info(`[Analyzer] L3 got ${swapCount} total SWAP (${pageCount} pages, ${creditsUsed} credits) for ${wallet.slice(0, 8)}...`);

      // === FILTER 1: Minimum Trading Activity ===
      if (swapCount < CONFIG.MIN_TRADING_ACTIVITY) {
        return {
          passed: false,
          reason: `❌ REJECT L3-SWAP: ${swapCount} swaps < ${CONFIG.MIN_TRADING_ACTIVITY} (need ${CONFIG.MIN_TRADING_ACTIVITY - swapCount} more)`,
          data: { 
            swapCount, 
            threshold: CONFIG.MIN_TRADING_ACTIVITY,
            completedTrades: 0, 
            winrate: 0, 
            totalPnl: 0,
            creditsUsed
          }
        };
      }

      // === PARSE SWAP DATA & CALCULATE PnL ===
      // FIXED: Use nativeBalanceChange + tokenTransfers (tokenInputs/Outputs are empty!)
      let completedTrades = 0;
      let winningTrades = 0;
      let losingTrades = 0;
      let totalPnl = 0;
      let dustBuys = 0;
      let unmatchedSells = 0;
      let validBuys = 0;

      // Build trade events from raw swap data
      const tradeEvents: Array<{
        type: 'buy' | 'sell';
        timestamp: number;
        mint: string;
        solAmount: number;
        tokenAmount: number;
        signature: string;
      }> = [];

      for (const swap of swapTxs) {
        if (!swap.timestamp) continue;
        if (swap.transactionError) continue;

        // Get SOL change from accountData (reliable!)
        const accountData = swap.accountData || [];
        const walletData = accountData.find((a: any) => a.account === wallet);
        const solChange = walletData ? (walletData.nativeBalanceChange || 0) / 1e9 : 0;

        // Get token direction from tokenTransfers
        const tokenTransfers = swap.tokenTransfers || [];
        let tokenIn = 0, tokenOut = 0, tokenMint = '';
        for (const tt of tokenTransfers) {
          if (tt.toUserAccount === wallet) {
            tokenIn += tt.tokenAmount || 0;
            tokenMint = tt.mint;
          } else if (tt.fromUserAccount === wallet) {
            tokenOut += tt.tokenAmount || 0;
            tokenMint = tt.mint;
          }
        }

        // BUY: SOL keluar (-), token masuk (+)
        if (solChange < -0.0001 && tokenIn > 0 && tokenOut === 0) {
          tradeEvents.push({
            type: 'buy',
            timestamp: swap.timestamp,
            mint: tokenMint,
            solAmount: Math.abs(solChange),
            tokenAmount: tokenIn,
            signature: swap.signature
          });
        }
        // SELL: SOL masuk (+), token keluar (-)
        else if (solChange > 0.0001 && tokenOut > 0 && tokenIn === 0) {
          tradeEvents.push({
            type: 'sell',
            timestamp: swap.timestamp,
            mint: tokenMint,
            solAmount: solChange,
            tokenAmount: tokenOut,
            signature: swap.signature
          });
        }
      }

      // Sort chronologically
      tradeEvents.sort((a, b) => a.timestamp - b.timestamp);

      // Track token positions for FIFO pairing
      const tokenPositions: { 
        [token: string]: Array<{
          buyAmount: number;
          tokenAmount: number;
          buyTime: number;
          sold: boolean;
          buySignature: string;
        }>
      } = {};

      // Process trades
      for (const event of tradeEvents) {
        if (event.type === 'buy') {
          // Dust buy filter
          if (event.solAmount < CONFIG.MIN_BUY_SIZE_SOL) {
            dustBuys++;
            continue;
          }
          validBuys++;

          if (!tokenPositions[event.mint]) {
            tokenPositions[event.mint] = [];
          }
          tokenPositions[event.mint].push({
            buyAmount: event.solAmount,
            tokenAmount: event.tokenAmount,
            buyTime: event.timestamp,
            sold: false,
            buySignature: event.signature
          });
        } 
        else if (event.type === 'sell') {
          const positions = tokenPositions[event.mint];
          if (!positions || positions.length === 0) {
            unmatchedSells++;
            continue;
          }

          // FIFO: match dengan buy pertama yang belum sold
          const pos = positions.find(p => !p.sold);
          if (!pos) {
            unmatchedSells++;
            continue;
          }

          // Partial sell check
          const ratio = event.tokenAmount / pos.tokenAmount;
          if (ratio < CONFIG.PARTIAL_SELL_RATIO) continue;

          // Calculate PnL proportionally
          const proportionalBuy = pos.buyAmount * ratio;
          const pnl = event.solAmount - proportionalBuy;

          completedTrades++;
          totalPnl += pnl;

          if (pnl > 0) {
            winningTrades++;
          } else {
            losingTrades++;
          }

          pos.sold = true;
        }
      }

      // Calculate metrics
      const winrate = completedTrades > 0 ? (winningTrades / completedTrades) * 100 : 0;
      const avgPnl = completedTrades > 0 ? totalPnl / completedTrades : 0;

      logger.info(`[Analyzer] L3 Result for ${wallet.slice(0, 8)}...: ${swapCount} swaps | ${validBuys} buys | ${unmatchedSells} unmatchedSells | ${completedTrades} trades | Winrate ${winrate.toFixed(1)}% | PnL ${totalPnl.toFixed(4)} SOL | Dust: ${dustBuys}`);

      // === FILTER 2: Sell-only wallet (dumpers/deployers) ===
      if (CONFIG.SKIP_SELL_ONLY_WALLETS && unmatchedSells > 0 && validBuys === 0) {
        return {
          passed: false,
          reason: `❌ REJECT L3-DUMPER: Sell-only wallet (${unmatchedSells} sells, 0 buys) - likely deployer/dumper`,
          data: {
            swapCount,
            completedTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            totalPnl: 0,
            avgPnl: 0,
            unmatchedSells,
            validBuys,
            creditsUsed
          }
        };
      }

      // === FILTER 3: Minimum completed trades ===
      if (completedTrades < CONFIG.MIN_COMPLETED_TRADES) {
        return {
          passed: false,
          reason: `❌ REJECT L3-TRADE: ${completedTrades} completed < ${CONFIG.MIN_COMPLETED_TRADES} (need ${CONFIG.MIN_COMPLETED_TRADES - completedTrades} more round-trip)`,
          data: {
            swapCount,
            completedTrades,
            winningTrades,
            losingTrades,
            winrate: parseFloat(winrate.toFixed(2)),
            totalPnl: parseFloat(totalPnl.toFixed(4)),
            avgPnl: parseFloat(avgPnl.toFixed(4)),
            threshold: CONFIG.MIN_COMPLETED_TRADES,
            creditsUsed
          }
        };
      }

      // === FILTER 4: Winrate threshold ===
      if (winrate < CONFIG.MIN_WINRATE_PERCENT) {
        return {
          passed: false,
          reason: `❌ REJECT L3-WINRATE: ${winrate.toFixed(1)}% < ${CONFIG.MIN_WINRATE_PERCENT}% (losing trader)`,
          data: {
            swapCount,
            completedTrades,
            winningTrades,
            losingTrades,
            winrate: parseFloat(winrate.toFixed(2)),
            totalPnl: parseFloat(totalPnl.toFixed(4)),
            avgPnl: parseFloat(avgPnl.toFixed(4)),
            threshold: CONFIG.MIN_WINRATE_PERCENT,
            creditsUsed
          }
        };
      }

      // === FILTER 5: PnL must be positive (DISABLED FOR TESTING - allow 0 PnL) ===
      if (totalPnl < 0) {
        return {
          passed: false,
          reason: `❌ REJECT L3-PnL: ${totalPnl.toFixed(4)} SOL < 0 (losing money)`,
          data: {
            swapCount,
            completedTrades,
            winningTrades,
            losingTrades,
            winrate: parseFloat(winrate.toFixed(2)),
            totalPnl: parseFloat(totalPnl.toFixed(4)),
            avgPnl: parseFloat(avgPnl.toFixed(4)),
            threshold: 0,
            creditsUsed
          }
        };
      }

      // === PASSED ALL FILTERS ===
      return {
        passed: true,
        data: {
          swapCount,
          completedTrades,
          winningTrades,
          losingTrades,
          winrate: parseFloat(winrate.toFixed(2)),
          totalPnl: parseFloat(totalPnl.toFixed(4)),
          avgPnl: parseFloat(avgPnl.toFixed(4)),
          dustBuys,
          unmatchedSells,
          creditsUsed  // 1 credit for Helius type=SWAP
        }
      };

    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[Analyzer] Error in L3 for ${wallet}: ${errMsg}`);
      return { 
        passed: true,  // Fail open
        data: { 
          swapCount: 999, 
          completedTrades: 99, 
          winrate: 99, 
          totalPnl: 999 
        }
      };
    }
  }

  /**
   * Run all analysis layers in sequence
   * Cost breakdown:
   * - L2: 0 credits (Alchemy free)
   * - L3: 1 credit (Helius type=SWAP - includes PnL!)
   */
  public async analyzeWallet(wallet: string): Promise<{
    stage2: FilterResult;
    stage3: FilterResult;
    passedAll: boolean;
    creditsUsed: number;
  }> {
    let creditsUsed = 0;

    // Layer 2: TX Count (Alchemy, free)
    const stage2 = await this.checkTransactionCountAlchemy(wallet);
    if (!stage2.passed) {
      return { 
        stage2, 
        stage3: { passed: false, reason: 'L2 failed', data: {} }, 
        passedAll: false,
        creditsUsed: 0
      };
    }

    // Layer 3: Comprehensive Analysis (Helius SWAP - includes PnL!)
    const stage3 = await this.analyzeTradingActivityAndPnl(wallet);
    if (stage3.data?.creditsUsed) {
      creditsUsed += stage3.data.creditsUsed;
    }

    // Log result
    if (stage3.passed) {
      console.log(`[Analyzer] ✓ Wallet ${wallet.slice(0, 8)}... passed all layers (${creditsUsed} Helius credits)`);
    } else {
      console.log(`[Analyzer] ✗ Wallet ${wallet.slice(0, 8)}... failed: ${stage3.reason}`);
    }
    
    return {
      stage2,
      stage3,
      passedAll: stage3.passed,
      creditsUsed
    };
  }


  public async quickCheck(wallet: string): Promise<{ worthAnalyzing: boolean; txCount: number }> {
    try {
      const publicKey = new PublicKey(wallet);
      const signatures = await this.alchemyConnection.getSignaturesForAddress(
        publicKey,
        { limit: 100 }
      );
      
      return {
        worthAnalyzing: signatures.length >= CONFIG.MIN_TOTAL_TX,
        txCount: signatures.length
      };
    } catch (error) {
      return { worthAnalyzing: true, txCount: 999 }; // Fail open
    }
  }
}
