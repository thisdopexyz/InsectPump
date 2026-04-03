import { CONFIG } from './config';

// Program IDs & Constants
export const CONSTANTS = {
  // Pump.fun Program ID
  PUMP_FUN_PROGRAM_ID: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  
  // Pump.fun Global & Fee Accounts
  PUMP_GLOBAL: '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf',
  PUMP_FEE_RECIPIENT: 'CebN5WGQ4jvEPvsVU4EoHEpgULkN3zXjQG7EYnX5Fvj',
  PUMP_EVENT_AUTHORITY: 'Ce6TQqeHC9p8KetN9x8AJZXu2xqnYkYx5xE7h4bN2sF1',
  
  // Token Program
  TOKEN_PROGRAM_ID: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  
  // Token-2022 Program (for newer tokens)
  TOKEN_2022_PROGRAM_ID: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  
  // Associated Token Program
  ASSOCIATED_TOKEN_PROGRAM_ID: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  
  // System Program
  SYSTEM_PROGRAM_ID: '11111111111111111111111111111111',
  
  // Rent Sysvar
  RENT_SYSVAR: 'SysvarRent111111111111111111111111111111111',
  
  // WSOL Mint
  WSOL_MINT: 'So11111111111111111111111111111111111111112',
  
  // LAMPORTS_PER_SOL
  LAMPORTS_PER_SOL: 1_000_000_000,
  
  // RPC Timeouts (from CONFIG)
  RPC_TIMEOUT_MS: CONFIG.RPC_TIMEOUT_MS,
  WS_RECONNECT_INTERVAL_MS: CONFIG.WS_RECONNECT_DELAY_MS,
  MAX_WS_RECONNECT_ATTEMPTS: CONFIG.MAX_WS_RECONNECT_ATTEMPTS,
  
  // Filter Keywords
  BLACKLIST_KEYWORDS: ['create', 'unknown', 'mint', 'initialize'],
  
  // Trade Instructions
  BUY_INSTRUCTION_NAMES: ['buy', 'purchase', 'swap', 'exactIn'],
  SELL_INSTRUCTION_NAMES: ['sell', 'redeem', 'swap', 'exactOut'],
  
  // === DEX PROGRAMS ===
  // Raydium AMM Program
  RAYDIUM_PROGRAM_ID: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  RAYDIUM_AMM_AUTHORITY: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
  
  // Orca Whirlpool (alternative DEX)
  ORCA_WHIRLPOOL_PROGRAM: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  
  // Meteora DLMM
  METEORA_DLMM_PROGRAM: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaBxPK',
  
  // === API ENDPOINTS ===
  // JUPITER REMOVED - IP blocked permanently
  // JUPITER_QUOTE_API: 'https://quote-api.jup.ag/v6/quote',
  // JUPITER_SWAP_API: 'https://quote-api.jup.ag/v6/swap',
  RAYDIUM_API: 'https://api.raydium.io/v2/main',
  DEXSCREENER_API: 'https://api.dexscreener.com/latest/dex',
  
  // === TRADING CONSTANTS (from CONFIG) ===
  // Graduation threshold
  GRADUATION_THRESHOLD_SOL: CONFIG.GRADUATION_THRESHOLD_SOL,
  
  // Default compute unit limit for trades
  COMPUTE_UNIT_LIMIT: CONFIG.COMPUTE_UNIT_LIMIT,
  
  // Minimum token decimals for calculations
  MIN_TOKEN_DECIMALS: 6,
};

// Event types from PumpPortal
export enum PumpPortalEvent {
  TRADE = 'trade',
  TOKEN_CREATE = 'create',
  CONNECT = 'connect',
  SUBSCRIBE = 'subscribe',
}

// Helius Commitment levels
export enum HeliusCommitment {
  PROCESSED = 'processed',
  CONFIRMED = 'confirmed',
  FINALIZED = 'finalized',
}

// DEX types for graduated tokens
export enum DexType {
  PUMPFUN_BONDING_CURVE = 'pumpfun_bonding_curve',
  RAYDIUM = 'raydium',
  ORCA = 'orca',
  METEORA = 'meteora',
  PUMPSWAP = 'pumpswap',
  UNKNOWN = 'unknown',
}

// Trade result status
export enum TradeStatus {
  PENDING = 'pending',
  SUCCESS = 'success',
  FAILED = 'failed',
  CONFIRMED = 'confirmed',
}

// Token graduation status
export interface GraduationStatus {
  isGraduated: boolean;
  reason: string;
  dexType: DexType;
  liquidityInfo?: {
    dexId: string;
    liquidityUsd: number;
    liquiditySol: number;
  };
}
