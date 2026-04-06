import EventEmitter from 'events';
import { InangBase } from '../database/inangBase';
import { createModuleLogger } from '../utils/logger';
import { CONFIG } from '../config/config';

const logger = createModuleLogger('Monitor');

export interface InangBuyEvent {
  type: 'inang_buying';
  inangAddress: string;
  tokenAddress: string;
  tokenSymbol?: string;
  amount: number;
  price: number;
  solAmount: number;
  marketCapSol: number;
  timestamp: Date;
  txHash: string;
}

export interface InangSellEvent {
  type: 'inang_selling';
  inangAddress: string;
  tokenAddress: string;
  tokenSymbol?: string;
  amount: number;
  price: number;
  solAmount: number;
  timestamp: Date;
  txHash: string;
  estimatedPnlPercent?: number;
}

interface HeliusTransaction {
  signature: string;
  timestamp: number;
  type: string;
  description?: string;
  source?: string;
  fee: number;
  status: string;
  accountData?: Array<{
    account: string;
    nativeBalanceChange: number;
  }>;
  tokenTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    tokenAmount: number;
    mint: string;
    tokenStandard?: string;
  }>;
  nativeTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
}

export class InangMonitor extends EventEmitter {
  private monitoredInangs: Set<string> = new Set(); // lowercase addresses for lookup
  private originalAddresses: Map<string, string> = new Map(); // lowercase -> original case
  private isRunning = false;
  private inangBase: InangBase;
  private heliusApiKey: string;
  private pollIntervalMs = 10000; // Poll every 10 seconds
  private pollTimer: NodeJS.Timeout | null = null;

  private inangEntries: Map<string, { entryPrice: number; timestamp: number }> = new Map();
  private seenSignatures: Map<string, Set<string>> = new Map();
  private lastCheckTimestamp: Map<string, number> = new Map();

  constructor(inangBase: InangBase) {
    super();
    this.inangBase = inangBase;
    this.heliusApiKey = process.env.HELIUS_API_KEY || '';
    if (!this.heliusApiKey) {
      logger.error('[Monitor] ❌ HELIUS_API_KEY not set!');
    }
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('[Monitor] Already running');
      return;
    }

    this.isRunning = true;
    
    // Load active inangs
    await this.refreshMonitoredList();
    
    // Start polling
    this.startPolling();
    
    logger.info(`[Monitor] Helius polling started for ${this.monitoredInangs.size} inangs`);
  }

  public stop(): void {
    this.isRunning = false;
    
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    
    logger.info('[Monitor] InangMonitor stopped');
  }

  public async refreshMonitoredList(): Promise<void> {
    try {
      const addresses = this.inangBase.getActiveInangs();
      addresses.forEach(addr => {
        const addrLower = addr.toLowerCase();
        this.monitoredInangs.add(addrLower);
        this.originalAddresses.set(addrLower, addr); // Store original case
        if (!this.seenSignatures.has(addrLower)) {
          this.seenSignatures.set(addrLower, new Set());
        }
        if (!this.lastCheckTimestamp.has(addrLower)) {
          this.lastCheckTimestamp.set(addrLower, Date.now() - 60000); // Start from 1 min ago
        }
      });
      logger.info(`[Monitor] Loaded ${this.monitoredInangs.size} active Inangs from database`);
    } catch (error) {
      logger.error(`[Monitor] Error refreshing monitored list: ${error}`);
    }
  }

  public addInangToMonitor(address: string): void {
    const addressLower = address.toLowerCase();
    
    if (!this.monitoredInangs.has(addressLower)) {
      this.monitoredInangs.add(addressLower);
      this.originalAddresses.set(addressLower, address); // Store original case
      this.seenSignatures.set(addressLower, new Set());
      this.lastCheckTimestamp.set(addressLower, Date.now() - 60000);
      logger.info(`[Monitor] Added new inang to monitoring: ${address}`);
    }
  }

  private startPolling(): void {
    // Initial poll
    this.pollAllInangs();
    
    // Set up interval
    this.pollTimer = setInterval(() => {
      this.pollAllInangs();
    }, this.pollIntervalMs);
  }

  private async pollAllInangs(): Promise<void> {
    if (!this.isRunning) return;

    const addresses = Array.from(this.monitoredInangs);
    
    for (const address of addresses) {
      try {
        await this.pollInang(address);
        // Small delay between inangs to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        logger.error(`[Monitor] Error polling ${address.slice(0, 12)}...: ${error}`);
      }
    }
  }

  private async pollInang(address: string): Promise<void> {
    if (!this.heliusApiKey) return;

    // CRITICAL FIX: Get original case address for API call (Solana addresses are case-sensitive!)
    const originalAddress = this.originalAddresses.get(address.toLowerCase()) || address;

    const url = `https://mainnet.helius-rpc.com/?api-key=${this.heliusApiKey}`;
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `poll-${originalAddress.slice(0, 8)}`,
          method: 'getSignaturesForAddress',
          params: [originalAddress, { limit: 10 }]
        })
      });

      if (!response.ok) {
        if (response.status === 429) {
          logger.warn('[Monitor] Helius rate limit, waiting...');
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          // CRITICAL FIX: Log non-429 errors (400, 500, etc)
          const errorText = await response.text().catch(() => 'unknown');
          logger.error(`[Monitor] Helius API error ${response.status} for ${originalAddress.slice(0, 12)}: ${errorText.substring(0, 100)}`);
        }
        return;
      }

      const data = await response.json() as { result?: Array<{ signature: string; blockTime?: number }>, error?: any };
      if (data.error) {
        logger.error(`[Monitor] Helius RPC error for ${originalAddress.slice(0, 12)}: ${JSON.stringify(data.error)}`);
        return;
      }
      if (!data.result || !Array.isArray(data.result)) return;

      const signatures = data.result;
      const seenSigs = this.seenSignatures.get(address.toLowerCase()) || new Set();
      const newSignatures = signatures.filter(sig => !seenSigs.has(sig.signature));

      if (newSignatures.length > 0) {
        logger.info(`[Monitor] 🔍 ${originalAddress.slice(0, 12)}... has ${newSignatures.length} new transactions`);
        
        // Add to seen
        newSignatures.forEach(sig => seenSigs.add(sig.signature));
        this.seenSignatures.set(address.toLowerCase(), seenSigs);

        // Fetch transaction details - pass original case address for API
        for (const sig of newSignatures.slice(0, 3)) { // Process max 3 at a time
          await this.fetchAndProcessTransaction(originalAddress, sig.signature);
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
    } catch (error) {
      logger.error(`[Monitor] Polling error for ${originalAddress.slice(0, 12)}...: ${error}`);
    }
  }

  private async fetchAndProcessTransaction(address: string, signature: string): Promise<void> {
    if (!this.heliusApiKey) return;

    const url = `https://mainnet.helius-rpc.com/?api-key=${this.heliusApiKey}`;
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `tx-${signature.slice(0, 8)}`,
          method: 'getTransaction',
          params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
        })
      });

      if (!response.ok) return;
      const data = await response.json() as { 
        result?: { 
          meta?: { 
            preBalances?: number[]; 
            postBalances?: number[]; 
            innerInstructions?: any[];
            preTokenBalances?: any[];
            postTokenBalances?: any[];
            logMessages?: string[];
          }; 
          transaction?: { 
            message?: { 
              accountKeys?: any[] 
            } 
          };
          blockTime?: number;
        } 
      };
      if (!data.result) return;

      // Check if this is a Pump.fun trade using meta data
      const tx = data.result;
      const meta = tx.meta || {};
      
      // Check for token transfers (pump.fun usually creates token transfers)
      const preBalances = meta.preBalances || [];
      const postBalances = meta.postBalances || [];
      const accountKeys = tx.transaction?.message?.accountKeys || [];
      
      // Find SOL change for our inang address
      const accountIndex = accountKeys.findIndex((key: any) => 
        (typeof key === 'string' ? key : key.pubkey).toLowerCase() === address.toLowerCase()
      );
      
      if (accountIndex === -1) return;
      
      const solChange = (postBalances[accountIndex] || 0) - (preBalances[accountIndex] || 0);
      const solChangeAbs = Math.abs(solChange) / 1e9;
      
      // Ignore if SOL change is too small (not a trade)
      if (solChangeAbs < 0.001) return;
      
      // Get token info from innerInstructions if available
      const innerInstructions = meta.innerInstructions || [];
      let tokenMint: string | undefined;
      let tokenAmount: number = 0;
      
      // Try to extract token transfer info
      for (const inner of innerInstructions) {
        for (const instruction of inner.instructions || []) {
          const parsed = instruction.parsed;
          if (parsed && parsed.type === 'transfer') {
            const info = parsed.info;
            if (info && info.mint) {
              tokenMint = info.mint;
              tokenAmount = parseFloat(info.amount || '0') / 1e6; // Assuming 6 decimals
              break;
            }
          }
        }
        if (tokenMint) break;
      }
      
      if (!tokenMint) {
        // Try from pre/post token balances
        const preTokenBalances = meta.preTokenBalances || [];
        const postTokenBalances = meta.postTokenBalances || [];
        
        for (const post of postTokenBalances) {
          const pre = preTokenBalances.find((p: any) => p.accountIndex === post.accountIndex && p.mint === post.mint);
          const preAmount = pre ? parseFloat(pre.uiTokenAmount?.amount || '0') : 0;
          const postAmount = parseFloat(post.uiTokenAmount?.amount || '0');
          
          if (Math.abs(postAmount - preAmount) > 0) {
            tokenMint = post.mint;
            tokenAmount = Math.abs(postAmount - preAmount);
            break;
          }
        }
      }
      
      if (!tokenMint) {
        // Fallback: use logMessages to detect pump.fun
        const logMessages = meta.logMessages || [];
        const isPumpFun = logMessages.some((msg: string) => msg.includes('pump') || msg.includes('Pump'));
        if (!isPumpFun) return;
        
        tokenMint = 'pump-fun-unknown';
      }
      
      const blockTime = tx.blockTime || Date.now() / 1000;
      const timestamp = new Date(blockTime * 1000);
      
      // Get original case address for event emission and database
      const originalAddress = this.originalAddresses.get(address.toLowerCase()) || address;
      
      // Determine if buy or sell
      if (solChange < 0) {
        // SOL went out = BUY
        const solAmount = Math.abs(solChange) / 1e9;
        
        logger.info(`[Monitor] 🟢 Inang BUY: ${originalAddress.slice(0, 12)}... buying ${tokenMint.slice(0, 12)}... @ ${solAmount.toFixed(4)} SOL`);
        
        const event: InangBuyEvent = {
          type: 'inang_buying',
          inangAddress: originalAddress, // CRITICAL: Use original case for copy-sell matching
          tokenAddress: tokenMint,
          tokenSymbol: tokenMint.slice(0, 6),
          amount: tokenAmount,
          price: 0, // Will be fetched by trade engine
          solAmount: solAmount,
          marketCapSol: 0,
          timestamp: timestamp,
          txHash: signature
        };
        
        // Track entry (internal use lowercase key)
        this.inangEntries.set(`${address}_${tokenMint}`, {
          entryPrice: solAmount / (tokenAmount || 1),
          timestamp: Date.now()
        });
        
        this.emit('inang_buying', event);
        
      } else if (solChange > 0) {
        // SOL came in = SELL
        const solAmount = solChange / 1e9;
        
        // Calculate PnL if we have entry (internal use lowercase key)
        const entryKey = `${address}_${tokenMint}`;
        const entry = this.inangEntries.get(entryKey);
        let pnlPercent: number | undefined;
        
        if (entry && entry.entryPrice > 0) {
          const exitPrice = solAmount / (tokenAmount || 1);
          pnlPercent = ((exitPrice - entry.entryPrice) / entry.entryPrice) * 100;
          this.inangEntries.delete(entryKey);
        }
        
        const pnlStr = pnlPercent !== undefined ? ` (PnL: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)` : '';
        logger.info(`[Monitor] 🔴 Inang SELL: ${originalAddress.slice(0, 12)}... selling ${tokenMint.slice(0, 12)}... @ ${solAmount.toFixed(4)} SOL${pnlStr}`);
        
        const event: InangSellEvent = {
          type: 'inang_selling',
          inangAddress: originalAddress, // CRITICAL: Use original case for copy-sell matching
          tokenAddress: tokenMint,
          tokenSymbol: tokenMint.slice(0, 6),
          amount: tokenAmount,
          price: 0,
          solAmount: solAmount,
          timestamp: timestamp,
          txHash: signature,
          estimatedPnlPercent: pnlPercent
        };
        
        this.emit('inang_selling', event);
      }
      
      // Update last trade in database (use original case)
      this.inangBase.updateLastTrade(originalAddress);
      
    } catch (error) {
      logger.error(`[Monitor] Error fetching tx ${signature.slice(0, 12)}...: ${error}`);
    }
  }

  public cleanup(): void {
    // Cleanup old entries
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    
    const keysToDelete: string[] = [];
    this.inangEntries.forEach((entry, key) => {
      if (now - entry.timestamp > maxAge) {
        keysToDelete.push(key);
      }
    });
    
    keysToDelete.forEach(key => this.inangEntries.delete(key));
  }

  public cleanupOldEntries(): void {
    this.cleanup();
  }

  public getEntryStats(): { total: number } {
    return { total: this.inangEntries.size };
  }
}
