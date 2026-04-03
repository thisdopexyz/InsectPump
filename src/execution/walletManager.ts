import { Connection, PublicKey, LAMPORTS_PER_SOL, Transaction, Keypair } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getAccount,
  TokenAccountNotFoundError,
  createAssociatedTokenAccountInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import { heliusClient } from '../services/helius';
import { logger } from '../utils/logger';
import { lamportsToSol } from '../utils/math';
import { CONFIG } from '../config/config';
import { TradeBase } from '../database/tradeBase';
import bs58 from 'bs58';

export interface WalletInfo {
  address: string;
  solBalance: number;
  tokenCount: number;
  totalValueUsd?: number;
  // Trading stats from TradeBase
  trading?: {
    totalSpentSOL: number;
    lockedSOL: number;
    availableSOL: number;
    realizedPnLSOL: number;
    todayPnLSOL: number;
    totalTrades: number;
    openTrades: number;
    winRate: number;
  };
}

export interface TokenBalance {
  mint: string;
  symbol: string;
  balance: number;
  decimals: number;
  valueUsd?: number;
}

export class WalletManager {
  private connection: Connection;
  private walletAddress: string;
  private tradeBase: TradeBase;

  constructor(tradeBase?: TradeBase) {
    this.connection = heliusClient.getConnection();

    // Get wallet address from private key in config
    if (!CONFIG.PRIVATE_KEY) {
      throw new Error('Private key not found in config. Please set PRIVATE_KEY in .env');
    }

    const secretKey = bs58.decode(CONFIG.PRIVATE_KEY);
    const keypair = Keypair.fromSecretKey(secretKey);
    this.walletAddress = keypair.publicKey.toBase58();

    // Inject TradeBase for trading analytics
    this.tradeBase = tradeBase || new TradeBase(CONFIG.DB_PATH);
  }

  // ==================== BALANCE CHECKS ====================

  async getSolBalance(): Promise<number> {
    return heliusClient.getSolBalance(this.walletAddress);
  }

  async getTokenBalance(mintAddress: string): Promise<number> {
    return heliusClient.getTokenBalance(this.walletAddress, mintAddress);
  }

  async getAllTokenBalances(): Promise<TokenBalance[]> {
    try {
      const accounts = await heliusClient.getTokenAccounts(this.walletAddress);
      
      return accounts.map(acc => ({
        mint: acc.mint,
        symbol: acc.symbol || 'UNKNOWN',
        balance: acc.amount / Math.pow(10, acc.decimals || 6),
        decimals: acc.decimals || 6,
        valueUsd: undefined // Would need price fetch
      }));
    } catch (error) {
      logger.error(`Error fetching token balances: ${error}`);
      return [];
    }
  }

  // ==================== VALIDATION ====================

  async hasEnoughSol(amount: number): Promise<boolean> {
    const balance = await this.getSolBalance();
    // Include buffer for fees
    return balance >= (amount + CONFIG.WALLET_BUFFER_SOL);
  }

  async validateTrade(amountSol: number): Promise<{ valid: boolean; reason?: string }> {
    // Check SOL balance
    const hasEnough = await this.hasEnoughSol(amountSol);
    if (!hasEnough) {
      return { valid: false, reason: `Insufficient SOL balance. Need: ${amountSol + CONFIG.WALLET_BUFFER_SOL} SOL` };
    }

    // Check if wallet is healthy (no stuck transactions)
    const isHealthy = await this.isWalletHealthy();
    if (!isHealthy) {
      return { valid: false, reason: 'Wallet has pending/stuck transactions' };
    }

    return { valid: true };
  }

  async isWalletHealthy(): Promise<boolean> {
    try {
      // Check for recent failed transactions
      const signatures = await this.connection.getSignaturesForAddress(
        new PublicKey(this.walletAddress),
        { limit: 10 }
      );
      
      const recentFailed = signatures.filter(sig => 
        sig.err && (Date.now() / 1000 - (sig.blockTime || 0)) < 300 // Last 5 min
      );
      
      return recentFailed.length < 3; // Allow some failures
    } catch (error) {
      return true; // Assume healthy if can't check
    }
  }

  // ==================== TOKEN MANAGEMENT ====================

  async hasTokenAccount(mintAddress: string): Promise<boolean> {
    try {
      const ata = await getAssociatedTokenAddress(
        new PublicKey(mintAddress),
        new PublicKey(this.walletAddress)
      );
      
      await getAccount(this.connection, ata);
      return true;
    } catch (error) {
      if (error instanceof TokenAccountNotFoundError) {
        return false;
      }
      return false;
    }
  }

  async getTokenAccountAddress(mintAddress: string): Promise<string | null> {
    try {
      const ata = await getAssociatedTokenAddress(
        new PublicKey(mintAddress),
        new PublicKey(this.walletAddress)
      );
      return ata.toBase58();
    } catch (error) {
      return null;
    }
  }

  // ==================== ATA MANAGEMENT ====================

  /**
   * Get or create Associated Token Account (ATA)
   * Returns the ATA address (creates if doesn't exist)
   */
  async getOrCreateATA(mintAddress: string): Promise<{ 
    success: boolean; 
    ataAddress: string; 
    created?: boolean; 
    error?: string;
    signature?: string;
  }> {
    try {
      const mintPubkey = new PublicKey(mintAddress);
      const walletPubkey = new PublicKey(this.walletAddress);
      
      // Derive ATA address
      const ata = await getAssociatedTokenAddress(
        mintPubkey,
        walletPubkey,
        false, // allowOwnerOffCurve
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      
      const ataAddress = ata.toBase58();
      
      // Check if ATA exists
      try {
        await getAccount(this.connection, ata);
        logger.info(`[WalletManager] ATA exists: ${ataAddress.substring(0, 12)}...`);
        return { success: true, ataAddress, created: false };
      } catch (error) {
        if (error instanceof TokenAccountNotFoundError) {
          // ATA doesn't exist, need to create
          logger.info(`[WalletManager] Creating ATA for ${mintAddress.substring(0, 12)}...`);
          
          // Get wallet keypair from private key
          if (!CONFIG.PRIVATE_KEY) {
            return { success: false, ataAddress, error: 'Private key not found in config' };
          }
          
          const secretKey = bs58.decode(CONFIG.PRIVATE_KEY);
          const keypair = Keypair.fromSecretKey(secretKey);
          
          // Build transaction to create ATA
          const tx = new Transaction();
          const createAtaIx = createAssociatedTokenAccountInstruction(
            walletPubkey, // payer
            ata, // associated token account
            walletPubkey, // owner
            mintPubkey, // mint
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          );
          tx.add(createAtaIx);
          
          // Get recent blockhash
          const { blockhash } = await this.connection.getLatestBlockhash();
          tx.recentBlockhash = blockhash;
          tx.feePayer = walletPubkey;
          
          // Sign and send
          tx.sign(keypair);
          const signature = await this.connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: false,
            preflightCommitment: 'confirmed'
          });
          
          // Wait for confirmation
          await this.connection.confirmTransaction(signature, 'confirmed');
          
          logger.info(`[WalletManager] ATA created: ${ataAddress.substring(0, 12)}... TX: ${signature.substring(0, 16)}...`);
          return { success: true, ataAddress, created: true, signature };
        }
        throw error;
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[WalletManager] Error getting/creating ATA: ${errMsg}`);
      return { success: false, ataAddress: '', error: errMsg };
    }
  }

  // ==================== WALLET INFO ====================

  async getWalletInfo(): Promise<WalletInfo> {
    const [solBalance, tokens] = await Promise.all([
      this.getSolBalance(),
      this.getAllTokenBalances()
    ]);

    // Get trading stats from TradeBase
    const tradingStats = this.tradeBase.getTradingStats();

    return {
      address: this.walletAddress,
      solBalance,
      tokenCount: tokens.length,
      totalValueUsd: undefined, // Would calculate from token prices
      trading: {
        totalSpentSOL: tradingStats.totalSpent,
        lockedSOL: tradingStats.locked,
        availableSOL: solBalance - tradingStats.locked,
        realizedPnLSOL: tradingStats.realizedPnL,
        todayPnLSOL: tradingStats.todayPnL,
        totalTrades: tradingStats.totalTrades,
        openTrades: tradingStats.openTrades,
        winRate: tradingStats.winRate
      }
    };
  }

  /**
   * Get trading summary from TradeBase
   */
  getTradingSummary(): {
    totalSpent: number;
    locked: number;
    realizedPnL: number;
    todayPnL: number;
    totalTrades: number;
    openTrades: number;
    winRate: number;
  } {
    return this.tradeBase.getTradingStats();
  }

  // ==================== SAFETY CHECKS ====================

  async isTokenSafe(mintAddress: string): Promise<{ safe: boolean; reasons: string[] }> {
    const reasons: string[] = [];

    try {
      const mintPubkey = new PublicKey(mintAddress);
      const mintInfo = await this.connection.getParsedAccountInfo(mintPubkey);
      
      // Check if mint authority is enabled (can mint more)
      const mintData = mintInfo.value?.data as any;
      if (mintData?.parsed?.info?.mintAuthority) {
        reasons.push('Mint authority enabled (dev can mint more)');
      }

      // Check if freeze authority is enabled
      if (mintData?.parsed?.info?.freezeAuthority) {
        reasons.push('Freeze authority enabled (dev can freeze wallets)');
      }

      // Check supply
      const supply = mintData?.parsed?.info?.supply;
      if (supply === '0') {
        reasons.push('Zero supply detected');
      }

    } catch (error) {
      reasons.push('Could not verify token mint');
    }

    return {
      safe: reasons.length === 0,
      reasons
    };
  }

  // ==================== QUICK STATS ====================

  async printWalletStats(): Promise<void> {
    const info = await this.getWalletInfo();

    logger.info('💼 Wallet Stats:');
    logger.info(`  Address: ${info.address}`);
    logger.info(`  SOL Balance: ${info.solBalance.toFixed(4)} SOL`);
    logger.info(`  Token Count: ${info.tokenCount}`);

    // Trading stats
    if (info.trading && info.trading.totalTrades > 0) {
      const t = info.trading;
      const pnlEmoji = t.realizedPnLSOL >= 0 ? '🟢' : '🔴';
      const todayEmoji = t.todayPnLSOL >= 0 ? '📈' : '📉';

      logger.info('📊 Trading Stats:');
      logger.info(`  Total Spent: ${t.totalSpentSOL.toFixed(4)} SOL`);
      logger.info(`  Locked: ${t.lockedSOL.toFixed(4)} SOL | Available: ${t.availableSOL.toFixed(4)} SOL`);
      logger.info(`  ${pnlEmoji} Realized PnL: ${t.realizedPnLSOL >= 0 ? '+' : ''}${t.realizedPnLSOL.toFixed(4)} SOL`);
      logger.info(`  ${todayEmoji} Today PnL: ${t.todayPnLSOL >= 0 ? '+' : ''}${t.todayPnLSOL.toFixed(4)} SOL`);
      logger.info(`  Trades: ${t.totalTrades} total | ${t.openTrades} open | Win Rate: ${t.winRate.toFixed(1)}%`);
    } else {
      logger.info('📊 Trading Stats: No trades yet');
    }
  }
}

export const walletManager = new WalletManager();
