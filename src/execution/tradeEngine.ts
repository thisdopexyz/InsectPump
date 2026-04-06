/**
 * tradeEngine.ts - InsectPump Trading Engine
 * 
 * PumpPortal API-based trading (local/raydium pools)
 * Flow: Pump.fun bonding curve -> Pump AMM -> Raydium
 * 
 * Architecture mirroring TheParasite for consistency
 */

import {
  Connection,
  PublicKey,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import * as anchor from '@coral-xyz/anchor';
import bs58 from 'bs58';
import { CONFIG } from '../config/config';
import { CONSTANTS } from '../config/constants';
import { logger } from '../utils/logger';
import { TradeBase } from '../database/tradeBase';
import { priceService } from '../services/priceService';
import { initDynamicFeeService, DynamicFeeService } from './dynamicFee';

// ---------------------------------------------------------------------------
// Pump.fun IDL (Sell only)
// ---------------------------------------------------------------------------
const PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_FUN_FEE_RECIPIENT = new PublicKey('CebN5WGQ4dMPhcM6GqwfN7j7Fc8f6Mm4NzT7EqnR3E7E');
const GLOBAL_ACCOUNT = new PublicKey('4wzbMAxcJ6E7ggj8jPqDudqxGkjZcQtNh9VWuG6iY9rz');
const EVENT_AUTHORITY = new PublicKey('Ce6Rq6wV8ACqP7j7T9e6X7g4dMPhcM6GqwfN7j7Fc8f6');

// ---------------------------------------------------------------------------
// Trade Result Interface
// ---------------------------------------------------------------------------
interface TradeResult {
  success: boolean;
  txHash?: string;
  error?: string;
  slippageUsed?: number;
  route?: 'pump_portal' | 'pump_amm' | 'raydium' | 'none';
}

// PumpPortal API Constants
const PUMP_PORTAL_API = 'https://pumpportal.fun/api/trade-local';
const PUMP_PORTAL_FEE_SOL = CONFIG.PUMP_PORTAL_FEE_SOL; // Fee charged by PumpPortal per trade

// Program IDs (for reference)
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

export class TradeEngine {
  private keypair: Keypair;
  private connection: Connection;
  private tradeBase: TradeBase;
  private slippageBps: number;
  private feeService: DynamicFeeService;

  constructor() {
    if (!CONFIG.PRIVATE_KEY) {
      throw new Error('Private key not found in config. Please set PRIVATE_KEY in .env');
    }

    const secretKey = bs58.decode(CONFIG.PRIVATE_KEY);
    this.keypair = Keypair.fromSecretKey(secretKey);
    this.connection = new Connection(CONFIG.HELIUS_RPC_URL, 'confirmed');
    this.tradeBase = new TradeBase(CONFIG.DB_PATH);
    
    // Dynamic priority fee based on network congestion
    this.feeService = initDynamicFeeService(this.connection);
    this.slippageBps = CONFIG.DEFAULT_SLIPPAGE_BPS;

    logger.info(`[TradeEngine] Initialized with wallet: ${this.keypair.publicKey.toBase58().substring(0, 12)}...`);
    logger.info(`[TradeEngine] Dynamic priority fees enabled | Slippage: ${this.slippageBps/100}%`);
    logger.info(`[TradeEngine] Routes: PumpPortal BC -> Pump AMM -> Raydium`);
  }

  getPublicKey(): string {
    return this.keypair.publicKey.toBase58();
  }

  getKeypair(): Keypair {
    return this.keypair;
  }

  getConnection(): Connection {
    return this.connection;
  }

  // ==================== BALANCE HELPERS ====================

  async getBalance(): Promise<number> {
    try {
      const balance = await this.connection.getBalance(this.keypair.publicKey);
      const solBalance = balance / LAMPORTS_PER_SOL;
      logger.info(`[TradeEngine] SOL balance: ${solBalance.toFixed(4)} SOL`);
      return solBalance;
    } catch (error) {
      logger.error(`[TradeEngine] get_balance error: ${error}`);
      return 0;
    }
  }

  async getTokenBalance(mint: string): Promise<number> {
    try {
      const mintPubkey = new PublicKey(mint);
      
      // Try SPL Token program first
      let ata = await getAssociatedTokenAddress(mintPubkey, this.keypair.publicKey, false, TOKEN_PROGRAM_ID);
      try {
        const accountInfo = await this.connection.getTokenAccountBalance(ata);
        const balance = accountInfo.value.uiAmount || 0;
        if (balance > 0) {
          logger.info(`[TradeEngine] Token balance (SPL) ${mint.substring(0, 8)}...: ${balance}`);
        }
        return balance;
      } catch {
        // SPL failed, try Token-2022
      }
      
      // Try Token-2022 program
      ata = await getAssociatedTokenAddress(mintPubkey, this.keypair.publicKey, false, TOKEN_2022_PROGRAM_ID);
      try {
        const accountInfo = await this.connection.getTokenAccountBalance(ata);
        const balance = accountInfo.value.uiAmount || 0;
        if (balance > 0) {
          logger.info(`[TradeEngine] Token balance (T2022) ${mint.substring(0, 8)}...: ${balance}`);
        }
        return balance;
      } catch {
        return 0;
      }
    } catch (error) {
      logger.error(`[TradeEngine] get_token_balance error: ${error}`);
      return 0;
    }
  }

  async getTokenBalanceRaw(mint: string): Promise<anchor.BN> {
    try {
      const mintPubkey = new PublicKey(mint);
      
      // Try SPL Token program first
      let ata = await getAssociatedTokenAddress(mintPubkey, this.keypair.publicKey, false, TOKEN_PROGRAM_ID);
      try {
        const accountInfo = await this.connection.getTokenAccountBalance(ata);
        const amount = accountInfo.value.amount || '0';
        if (new anchor.BN(amount).gt(new anchor.BN(0))) {
          return new anchor.BN(amount);
        }
      } catch {
        // SPL failed, try Token-2022
      }
      
      // Try Token-2022 program
      ata = await getAssociatedTokenAddress(mintPubkey, this.keypair.publicKey, false, TOKEN_2022_PROGRAM_ID);
      try {
        const accountInfo = await this.connection.getTokenAccountBalance(ata);
        const amount = accountInfo.value.amount || '0';
        return new anchor.BN(amount);
      } catch {
        return new anchor.BN(0);
      }
    } catch (error) {
      return new anchor.BN(0);
    }
  }

  /**
   * Get all token accounts in wallet with non-zero balance
   * Returns map of mint -> balance
   * Checks BOTH SPL Token and Token-2022 programs
   */
  async getAllTokenBalances(): Promise<Map<string, number>> {
    try {
      const balances = new Map<string, number>();
      
      // SPL Token Program
      const splTokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
        this.keypair.publicKey,
        { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
      );
      
      for (const account of splTokenAccounts.value) {
        const parsed = account.account.data.parsed;
        const mint = parsed.info.mint;
        const balance = parsed.info.tokenAmount.uiAmount || 0;
        
        if (balance > 0) {
          balances.set(mint, balance);
        }
      }
      
      // Token-2022 Program
      const token2022Accounts = await this.connection.getParsedTokenAccountsByOwner(
        this.keypair.publicKey,
        { programId: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') }
      );
      
      for (const account of token2022Accounts.value) {
        const parsed = account.account.data.parsed;
        const mint = parsed.info.mint;
        const balance = parsed.info.tokenAmount.uiAmount || 0;
        
        if (balance > 0) {
          balances.set(mint, balance);
          logger.info(`[TradeEngine] Token-2022 found: ${mint.substring(0, 12)}... balance = ${balance}`);
        }
      }
      
      logger.info(`[TradeEngine] Found ${balances.size} tokens in wallet (${splTokenAccounts.value.length} SPL + ${token2022Accounts.value.length} Token-2022)`);
      return balances;
    } catch (error) {
      logger.error(`[TradeEngine] getAllTokenBalances error: ${error}`);
      return new Map();
    }
  }

  // ==================== PUBLIC API (for main.ts) ====================

  async buy(mint: string, amountSol: number, tokenSymbol: string = 'UNKNOWN', inangAddress: string = ''): Promise<TradeResult> {
    return this.buyToken(mint, amountSol, tokenSymbol, inangAddress);
  }

  async sell(mint: string, percentage: number): Promise<TradeResult> {
    return this.sellToken(mint, percentage);
  }

  // ==================== BUY TOKEN ====================

  async buyToken(mint: string, amountSol: number, tokenSymbol: string = 'UNKNOWN', inangAddress: string = ''): Promise<TradeResult> {
    logger.info(`[TradeEngine] BUY ${mint.substring(0, 12)}... amount=${amountSol} SOL`);

    // Check balance
    const balance = await this.getBalance();
    if (balance < CONFIG.WALLET_MIN_BALANCE_SOL) {
      logger.error(`[LOW BALANCE] Wallet hanya punya ${balance.toFixed(4)} SOL. Butuh minimal ${CONFIG.WALLET_MIN_BALANCE_SOL} SOL.`);
      return { success: false, error: 'low_balance', route: 'none' };
    }

    // Try 1: Pump.fun bonding curve via PumpPortal
    const pumpResult = await this.executePumpPortalBuy(mint, amountSol, 'pump');
    if (pumpResult.success && pumpResult.txHash) {
      await this.recordBuyPosition(mint, tokenSymbol, inangAddress, amountSol, pumpResult.txHash);
      return { ...pumpResult, route: 'pump_portal' };
    }

    // Try 2: Pump AMM (for graduated tokens)
    logger.info(`[Buy] BC failed/migrated -> trying Pump AMM...`);
    const ammResult = await this.executePumpPortalBuy(mint, amountSol, 'pump_amm');  // FIX: was 'pump', now 'pump_amm'
    if (ammResult.success && ammResult.txHash) {
      await this.recordBuyPosition(mint, tokenSymbol, inangAddress, amountSol, ammResult.txHash);
      return { ...ammResult, route: 'pump_amm' };
    }

    // Try 3: Raydium via PumpPortal
    logger.info(`[Buy] Pump AMM failed, trying Raydium via PumpPortal...`);
    const raydiumResult = await this.executePumpPortalBuy(mint, amountSol, 'raydium');
    if (raydiumResult.success && raydiumResult.txHash) {
      await this.recordBuyPosition(mint, tokenSymbol, inangAddress, amountSol, raydiumResult.txHash);
      return { ...raydiumResult, route: 'raydium' };
    }

    logger.error(`[TradeEngine] ALL BUY PATHS FAILED for ${mint.substring(0, 12)}...`);
    return { success: false, error: 'all_paths_failed', route: 'none' };
  }

  // ==================== SELL TOKEN ====================

  async sellToken(mint: string, percentage: number, reason: string = ''): Promise<TradeResult> {
    logger.info(`[TradeEngine] SELL ${mint.substring(0, 12)}... pct=${percentage}% reason=${reason}`);

    // Validate percentage
    percentage = Math.max(0, Math.min(100, percentage));
    if (percentage <= 0) {
      return { success: false, error: 'Invalid percentage', route: 'none' };
    }

    // Get token balance
    const balance = await this.getTokenBalanceRaw(mint);
    if (balance.lte(new anchor.BN(0))) {
      return { success: false, error: 'no_token_balance', route: 'none' };
    }

    const sellAmount = balance.muln(Math.floor(percentage)).divn(100);
    if (sellAmount.lte(new anchor.BN(0))) {
      return { success: false, error: 'sell_amount_zero', route: 'none' };
    }

    // Check if Token-2022
    const mintPubkey = new PublicKey(mint);
    const mintAccount = await this.connection.getAccountInfo(mintPubkey);
    const isToken2022 = mintAccount?.owner.equals(TOKEN_2022_PROGRAM_ID) ?? false;
    
    if (isToken2022) {
      logger.info(`[Sell] Token-2022 detected, using manual bonding curve sell...`);
      const token2022Result = await this.executeToken2022Sell(mint, percentage);
      if (token2022Result.success && token2022Result.txHash) {
        await this.recordSellPosition(mint, token2022Result.txHash, 'token2022_sell');
        return { ...token2022Result, route: 'pump_portal' };
      }
      logger.warn(`[Sell] Token-2022 sell failed, trying fallback paths...`);
    }

    // Try 1: Pump.fun bonding curve via PumpPortal
    const pumpResult = await this.executePumpPortalSell(mint, percentage, 'pump');
    if (pumpResult.success && pumpResult.txHash) {
      await this.recordSellPosition(mint, pumpResult.txHash, 'pump_sell');
      return { ...pumpResult, route: 'pump_portal' };
    }

    // Try 2: Pump AMM
    logger.info(`[Sell] BC failed -> trying Pump AMM...`);
    const ammResult = await this.executePumpPortalSell(mint, percentage, 'pump_amm');
    if (ammResult.success && ammResult.txHash) {
      await this.recordSellPosition(mint, ammResult.txHash, 'pump_amm_sell');
      return { ...ammResult, route: 'pump_amm' };
    }

    // Try 3: Raydium via PumpPortal
    logger.info(`[Sell] Pump paths failed, trying Raydium via PumpPortal...`);
    const raydiumResult = await this.executePumpPortalSell(mint, percentage, 'raydium');
    if (raydiumResult.success && raydiumResult.txHash) {
      await this.recordSellPosition(mint, raydiumResult.txHash, 'raydium_sell');
      return { ...raydiumResult, route: 'raydium' };
    }

    logger.error(`[TradeEngine] ALL SELL PATHS FAILED for ${mint.substring(0, 12)}...`);
    return { success: false, error: 'all_paths_failed', route: 'none' };
  }

  // ==================== COPY-SELL (Follow Whale Exit) ====================

  async copySell(tokenAddress: string, whaleAddress: string, whalePnlPercent: number): Promise<TradeResult & { skipped?: boolean; reason?: string }> {
    logger.info(`[TradeEngine] COPY-SELL signal from ${whaleAddress.substring(0, 12)}... (whale PnL: ${whalePnlPercent.toFixed(2)}%)`);

    // 1. Check if we have a position
    const trade = this.tradeBase.getTradeByToken(tokenAddress);
    if (!trade) {
      logger.warn(`[TradeEngine] COPY-SELL: No position found`);
      return { success: false, error: 'No position to sell', skipped: true, reason: 'no_position', route: 'none' };
    }

    // 2. Check if position already closed
    if (trade.status === 'CLOSED') {
      return { success: true, error: 'Position already closed', skipped: true, reason: 'already_closed', route: 'none' };
    }

    // 3. Check if trailing stop is active
    if (trade.is_trailing_active === 1) {
      logger.info(`[TradeEngine] COPY-SELL: SKIPPED - Trailing stop active, ignoring whale sell`);
      return {
        success: true,
        skipped: true,
        reason: 'trailing_active',
        error: 'Trailing stop active - ignoring whale sell signal',
        route: 'none'
      };
    }

    // 4. Trailing not active -> Follow whale sell 100%
    logger.info(`[TradeEngine] COPY-SELL: Trailing NOT active, following whale exit`);

    const result = await this.sellToken(tokenAddress, 100, `whale_exit_${whaleAddress.substring(0, 8)}`);

    if (result.success) {
      logger.info(`[TradeEngine] COPY-SELL SUCCESS via ${result.route}: ${result.txHash}`);
      
      // Record copy-sell in database
      const currentPrice = await priceService.getTokenPrice(tokenAddress);
      const ourPnlPercent = ((currentPrice - trade.entry_price) / trade.entry_price) * 100;
      
      this.tradeBase.recordCopySell(tokenAddress, {
        whale_address: whaleAddress,
        whale_pnl: whalePnlPercent,
        our_pnl: ourPnlPercent,
        exit_price: currentPrice,
        tx_hash: result.txHash,
        timestamp: new Date().toISOString()
      });
    } else {
      logger.error(`[TradeEngine] COPY-SELL FAILED: ${result.error}`);
    }

    return { ...result, skipped: false };
  }

  // ==================== PUMP PORTAL API EXECUTION ====================

  private async executePumpPortalBuy(mint: string, amountSol: number, pool: 'pump' | 'pump_amm' | 'raydium'): Promise<TradeResult> {
    try {
      logger.info(`[PumpPortal] Buying ${amountSol} SOL of ${mint} (pool: ${pool})`);

      // Get dynamic priority fee - use 'high' urgency for buys to land faster
      const priorityFee = await this.feeService.getRecommendedFee('high');

      const payload = {
        publicKey: this.keypair.publicKey.toBase58(),
        action: 'buy',
        mint: mint,
        denominatedInSol: 'true',
        amount: amountSol.toString(),
        slippage: this.slippageBps / 100, // Convert bps to percent
        priorityFee: priorityFee,
        pool: pool,
      };

      const response = await fetch(PUMP_PORTAL_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`[PumpPortal] API error ${response.status}: ${errorText.substring(0, 150)}`);
        return { success: false, error: `api_error_${response.status}` };
      }

      // Get transaction bytes from response
      const txBuffer = Buffer.from(await response.arrayBuffer());
      const transaction = VersionedTransaction.deserialize(txBuffer);

      // Sign transaction
      transaction.sign([this.keypair]);

      // Send via Helius RPC
      const signature = await this.connection.sendTransaction(transaction, {
        maxRetries: CONFIG.TX_SEND_MAX_RETRIES,
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });

      // Wait for confirmation
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      const confirmation = await this.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed'
      );

      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${confirmation.value.err}`);
      }

      logger.info(`[PumpPortal] BUY SUCCESS! Tx: ${signature}`);
      return { success: true, txHash: signature, slippageUsed: this.slippageBps / 100 };

    } catch (error: any) {
      const errorMsg = error.message || String(error);
      
      // Check for low balance error
      if (errorMsg.toLowerCase().includes('insufficient lamports') || 
          errorMsg.includes('0x1') || 
          errorMsg.toLowerCase().includes('rent')) {
        logger.error(`[LOW BALANCE] SOL kurang! Butuh ~${CONFIG.ATA_COST_ESTIMATE_SOL} SOL untuk buat ATA. Top up wallet. Error: ${errorMsg}`);
        return { success: false, error: 'low_balance_for_ata' };
      }

      // Check for slippage error
      if (this.isSlippageError(errorMsg)) {
        return { success: false, error: 'slippage_exceeded', slippageUsed: this.slippageBps / 100 };
      }

      logger.error(`[PumpPortal] BUY Failed: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  private async executePumpPortalSell(mint: string, percentage: number, pool: 'pump' | 'pump_amm' | 'raydium'): Promise<TradeResult> {
    try {
      // PumpPortal expects percentage string for sells
      const percent = Math.max(1, Math.min(100, Math.floor(percentage)));
      logger.info(`[PumpPortal Sell] Selling ${percent}% of ${mint} (pool: ${pool})`);

      // Get dynamic priority fee - use 'urgent' for sells (need to exit fast)
      const priorityFee = await this.feeService.getRecommendedFee('urgent');

      const payload = {
        publicKey: this.keypair.publicKey.toBase58(),
        action: 'sell',
        mint: mint,
        denominatedInSol: 'false',
        amount: `${percent}%`,
        slippage: 25, // Higher slippage for sells
        priorityFee: priorityFee,
        pool: pool,
      };

      const response = await fetch(PUMP_PORTAL_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`[PumpPortal Sell] API error ${response.status}: ${errorText.substring(0, 150)}`);
        return { success: false, error: `api_error_${response.status}` };
      }

      // Get transaction bytes from response
      const txBuffer = Buffer.from(await response.arrayBuffer());
      const transaction = VersionedTransaction.deserialize(txBuffer);

      // Sign transaction
      transaction.sign([this.keypair]);

      // Send via Helius RPC
      const signature = await this.connection.sendTransaction(transaction, {
        maxRetries: CONFIG.TX_SEND_MAX_RETRIES,
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });

      // Wait for confirmation
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      const confirmation = await this.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed'
      );

      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${confirmation.value.err}`);
      }

      logger.info(`[PumpPortal Sell] SUCCESS! Tx: ${signature}`);
      return { success: true, txHash: signature, slippageUsed: 25 / 100 };

    } catch (error: any) {
      const errorMsg = error.message || String(error);
      
      if (this.isSlippageError(errorMsg)) {
        return { success: false, error: 'slippage_exceeded', slippageUsed: 25 / 100 };
      }

      logger.error(`[PumpPortal Sell] Failed: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Execute sell for Token-2022 via bonding curve (manual Anchor transaction)
   * PumpPortal API doesn't support Token-2022, so we build tx manually
   */
  private async executeToken2022Sell(mint: string, percentage: number): Promise<TradeResult> {
    try {
      const percent = Math.max(1, Math.min(100, Math.floor(percentage)));
      logger.info(`[Token2022 Sell] Selling ${percent}% of ${mint.slice(0, 12)}... via bonding curve`);

      // Get token balance
      const mintPubkey = new PublicKey(mint);
      const userPubkey = this.keypair.publicKey;
      
      // Get Token-2022 ATA
      const userAta = await getAssociatedTokenAddress(
        mintPubkey, 
        userPubkey, 
        false, 
        TOKEN_2022_PROGRAM_ID
      );
      
      // Get balance
      const accountInfo = await this.connection.getTokenAccountBalance(userAta);
      const balance = new anchor.BN(accountInfo.value.amount);
      
      if (balance.lte(new anchor.BN(0))) {
        return { success: false, error: 'no_token_balance' };
      }
      
      // Calculate sell amount
      const sellAmount = balance.muln(percent).divn(100);
      if (sellAmount.lte(new anchor.BN(0))) {
        return { success: false, error: 'sell_amount_zero' };
      }

      // Get bonding curve PDA
      const [bondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), mintPubkey.toBuffer()],
        PUMP_FUN_PROGRAM_ID
      );

      // Get associated bonding curve ATA
      const associatedBondingCurve = await getAssociatedTokenAddress(
        mintPubkey,
        bondingCurve,
        true,
        TOKEN_2022_PROGRAM_ID
      );

      // Build instruction data: sighash + amount
      // Sell sighash: anchor hash of "global:sell"
      const sellDiscriminator = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
      const amountBuffer = Buffer.alloc(8);
      amountBuffer.writeBigUInt64LE(BigInt(sellAmount.toString()));
      const data = Buffer.concat([sellDiscriminator, amountBuffer]);

      // Create instruction
      const keys = [
        { pubkey: GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_FEE_RECIPIENT, isSigner: false, isWritable: true },
        { pubkey: mintPubkey, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: userAta, isSigner: false, isWritable: true },
        { pubkey: userPubkey, isSigner: true, isWritable: true },
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: anchor.web3.SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false },
      ];

      const instruction = new anchor.web3.TransactionInstruction({
        keys,
        programId: PUMP_FUN_PROGRAM_ID,
        data,
      });

      // Get priority fee
      const priorityFee = await this.feeService.getRecommendedFee('urgent');

      // Build transaction
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      
      const messageV0 = new anchor.web3.TransactionMessage({
        payerKey: userPubkey,
        recentBlockhash: blockhash,
        instructions: [
          // Priority fee instruction
          anchor.web3.ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: priorityFee,
          }),
          instruction,
        ],
      }).compileToV0Message();

      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([this.keypair]);

      // Send transaction
      const signature = await this.connection.sendTransaction(transaction, {
        maxRetries: CONFIG.TX_SEND_MAX_RETRIES,
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });

      // Wait for confirmation
      const confirmation = await this.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed'
      );

      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${confirmation.value.err}`);
      }

      logger.info(`[Token2022 Sell] SUCCESS! Tx: ${signature}`);
      return { success: true, txHash: signature, route: 'pump_portal', slippageUsed: 25 / 100 };

    } catch (error: any) {
      const errorMsg = error.message || String(error);
      
      if (errorMsg.includes('slippage') || errorMsg.includes('0x11')) {
        return { success: false, error: 'slippage_exceeded', slippageUsed: 25 / 100 };
      }
      
      logger.error(`[Token2022 Sell] Failed: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  // ==================== DATABASE HELPERS ====================

  private async recordBuyPosition(
    tokenAddress: string,
    tokenSymbol: string,
    inangAddress: string,
    amountSol: number,
    txHash: string
  ): Promise<void> {
    try {
      const entryPrice = await priceService.getTokenPrice(tokenAddress);
      
      // Record in trades table
      this.tradeBase.openTrade({
        token_address: tokenAddress,
        token_symbol: tokenSymbol,
        inang_address: inangAddress || this.keypair.publicKey.toBase58(),
        entry_price: entryPrice,
        buy_amount_sol: amountSol,
        token_amount: 0,
      });

      // SYNC: Also record in positions table
      this.tradeBase.openPosition({
        token_mint: tokenAddress,
        token_symbol: tokenSymbol,
        inang_address: inangAddress || this.keypair.publicKey.toBase58(),
        entry_price: entryPrice,
        amount_sol: amountSol,
        amount_tokens: 0,
      });

      logger.info(`[TradeEngine] Recorded buy position for ${tokenAddress.substring(0, 12)}... tx: ${txHash.substring(0, 16)}...`);
    } catch (error) {
      logger.error(`[TradeEngine] Failed to record buy position: ${error}`);
    }
  }

  private async recordSellPosition(tokenAddress: string, txHash: string, reason: string = ''): Promise<void> {
    try {
      const trade = this.tradeBase.getTradeByToken(tokenAddress);
      if (trade) {
        const currentPrice = await priceService.getTokenPrice(tokenAddress);
        const pnlPercent = ((currentPrice - trade.entry_price) / trade.entry_price) * 100;
        
        // Close in trades table
        this.tradeBase.closeTradeByToken(tokenAddress, pnlPercent);
        
        // SYNC: Also close in positions table
        this.tradeBase.closePosition(tokenAddress, pnlPercent, currentPrice, reason);
        
        logger.info(`[TradeEngine] Recorded sell position for ${tokenAddress.substring(0, 12)}... (PnL: ${pnlPercent.toFixed(2)}%) tx: ${txHash.substring(0, 16)}...`);
      }
    } catch (error) {
      logger.error(`[TradeEngine] Failed to record sell position: ${error}`);
    }
  }

  // ==================== UTILITY HELPERS ====================

  private isSlippageError(errorMsg: string): boolean {
    const slippageKeywords = [
      'slippage',
      'Slippage Hit',
      'exceeds slippage',
      'insufficient output',
      'price impact too high',
      'exceeded slippage tolerance',
      '0x1771',
      'Swap failed',
      'insufficient liquidity',
    ];

    const lowerError = errorMsg.toLowerCase();
    return slippageKeywords.some(keyword => lowerError.includes(keyword.toLowerCase()));
  }
}

// Export singleton instance
export const tradeEngine = new TradeEngine();
