// Types for InsectPump

// Wallet/Inang representation
export interface Inang {
  id?: number;
  address: string;
  discoveredAt: Date;
  totalTx: number;
  tradingActivity: number;
  winrate: number;
  totalPnl: number;
  status: 'active' | 'inactive' | 'blacklisted';
  lastAnalyzedAt?: Date;
  metadata?: string; // JSON string
}

// Trade from PumpPortal WSS
export interface PumpTrade {
  signature: string;
  mint: string;
  trader: string;
  tokenAmount: number;
  solAmount: number;
  isBuy: boolean;
  timestamp: number;
  mcap: number; // Market cap in SOL
  price: number;
}

// Helius Transaction Response
export interface HeliusTransaction {
  signature: string;
  timestamp: number;
  type: string;
  source: string;
  fee: number;
  status: string;
  instructionNames: string[];
  accountData?: Array<{
    account: string;
    nativeBalanceChange: number;
  }>;
  tokenTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    tokenAmount: number;
    mint: string;
  }>;
  nativeTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
}

// Trade Analysis Result
export interface TradeAnalysis {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winrate: number;
  totalPnl: number;
  avgPnlPerTrade: number;
  trades: TradeRecord[];
}

export interface TradeRecord {
  signature: string;
  timestamp: number;
  type: 'buy' | 'sell' | 'unknown';
  token: string;
  amount: number;
  pnl: number;
}

// Filter Result
export interface FilterResult {
  passed: boolean;
  reason?: string;
  data?: unknown;
}

// Blacklist entry
export interface BlacklistEntry {
  address: string;
  reason: string;
  detectedAt: string;
  keywords: string[];
}

// Alchemy Transaction Count Response
export interface AlchemyTxCount {
  jsonrpc: string;
  id: number;
  result: number;
}

// Eye Event Types
export type EyeEventType = 'trade_detected' | 'filter_passed' | 'filter_failed' | 'inang_added';

export interface EyeEvent {
  type: EyeEventType;
  timestamp: Date;
  trader: string;
  stage: string;
  data?: unknown;
}
