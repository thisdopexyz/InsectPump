import WebSocket from 'ws';
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
  estimatedPnlPercent?: number; // Estimated based on price change
}

export class InangMonitor extends EventEmitter {
  private ws: WebSocket | null = null;
  private monitoredInangs: Set<string> = new Set();
  private reconnectDelay = CONFIG.WS_RECONNECT_DELAY_MS;
  private isRunning = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private inangBase: InangBase;
  private pumpPortalWsUrl: string;

  /**
   * Track entry prices for each inang per token
   * Key: `${inangAddress}_${tokenAddress}`
   * Value: { entryPrice, timestamp }
   */
  private inangEntries: Map<string, { entryPrice: number; timestamp: number }> = new Map();

  /**
   * Auto-cleanup entries older than 7 days (prevent memory leak)
   */
  private readonly ENTRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  constructor(inangBase: InangBase, pumpPortalWsUrl: string) {
    super();
    this.inangBase = inangBase;
    this.pumpPortalWsUrl = pumpPortalWsUrl;
  }

  /**
   * Init: Ambil semua inang aktif dari database dan mulai monitoring
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('[Monitor] Already running');
      return;
    }

    this.isRunning = true;
    
    // Load active inangs
    await this.refreshMonitoredList();
    
    // Connect to WebSocket
    this.connect();
    
    logger.info(`[Monitor] Monitoring ${this.monitoredInangs.size} active Inangs...`);
  }

  /**
   * Stop monitoring
   */
  public stop(): void {
    this.isRunning = false;
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    logger.info('[Monitor] InangMonitor stopped');
  }

  /**
   * Refresh monitored list dari database
   */
  public async refreshMonitoredList(): Promise<void> {
    try {
      const addresses = this.inangBase.getActiveInangs();
      this.monitoredInangs = new Set(addresses);
      logger.info(`[Monitor] Loaded ${this.monitoredInangs.size} active Inangs from database`);
    } catch (error) {
      logger.error(`[Monitor] Error refreshing monitored list: ${error}`);
    }
  }

  /**
   * Dynamic Update: Tambah inang baru ke monitoring tanpa restart
   */
  public addInangToMonitor(address: string): void {
    const addressLower = address.toLowerCase();
    
    if (!this.monitoredInangs.has(addressLower)) {
      this.monitoredInangs.add(addressLower);
      logger.info(`[Monitor] Added new inang to monitoring: ${address}`);
      
      // If WS is open, subscribe to this specific address
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.subscribeToTrader(addressLower);
      }
    }
  }

  /**
   * Koneksi ke PumpPortal WSS dengan Auto-Reconnect
   */
  private connect(): void {
    if (!this.isRunning) return;

    try {
      this.ws = new WebSocket(this.pumpPortalWsUrl);

      this.ws.on('open', () => {
        logger.info('[Monitor] Connected to PumpPortal WSS');
        
        // Subscribe to all monitored inangs
        this.monitoredInangs.forEach(address => {
          this.subscribeToTrader(address);
        });
        
        logger.info(`[Monitor] Subscribed to ${this.monitoredInangs.size} traders`);
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          // Ignore invalid JSON
        }
      });

      this.ws.on('close', () => {
        if (this.isRunning) {
          logger.warn('[Monitor] WSS disconnected, auto-reconnecting...');
          this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
        }
      });

      this.ws.on('error', (error) => {
        logger.error(`[Monitor] WSS Error: ${error.message}`);
      });

    } catch (error) {
      logger.error(`[Monitor] Failed to connect: ${error}`);
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    }
  }

  /**
   * Subscribe ke trader-specific feed (bukan global)
   */
  private subscribeToTrader(address: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    
    const subscribeMsg = {
      method: 'subscribeTrader',
      params: {
        trader: address
      }
    };
    
    this.ws.send(JSON.stringify(subscribeMsg));
    logger.info(`[Monitor] Subscribed to trader: ${address.substring(0, 12)}...`);
  }

  /**
   * Unsubscribe dari trader
   */
  private unsubscribeFromTrader(address: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    
    const unsubscribeMsg = {
      method: 'unsubscribeTrader',
      params: {
        trader: address
      }
    };
    
    this.ws.send(JSON.stringify(unsubscribeMsg));
  }

  /**
   * Handling Message dari PumpPortal
   */
  private async handleMessage(message: any): Promise<void> {
    // Check if this is a trade message
    if (!message.traderPublicKey || !message.txType) return;
    
    const trader = message.traderPublicKey.toLowerCase();
    
    // Check if this trader is in our monitored list
    if (!this.monitoredInangs.has(trader)) return;

    const txType = message.txType.toUpperCase();
    
    // Update last_trade_at in database for any trade
    this.inangBase.updateLastTrade(trader);

    if (txType === 'BUY') {
      // Handle BUY event
      const buyPrice = (message.priceInLamports || 0) / 1e9;
      const buyEvent: InangBuyEvent = {
        type: 'inang_buying',
        inangAddress: trader,
        tokenAddress: message.mint,
        tokenSymbol: message.name || message.symbol || message.mint.substring(0, 6),
        amount: message.tokenAmount || 0,
        price: buyPrice,
        solAmount: (message.solAmount || message.vSolInBondingCurve || 0) / 1e9,
        timestamp: new Date(message.timestamp || Date.now()),
        txHash: message.signature
      };

      // Track this entry for accurate PnL calculation on sell
      const entryKey = `${trader}_${message.mint}`;
      this.inangEntries.set(entryKey, {
        entryPrice: buyPrice,
        timestamp: Date.now()
      });

      logger.info(`[Monitor] 🟢 Inang BUY: ${trader.substring(0, 12)}... buying ${buyEvent.tokenSymbol} @ ${buyPrice.toFixed(9)} SOL (${buyEvent.solAmount.toFixed(4)} SOL)`);
      this.emit('inang_buying', buyEvent);
      
    } else if (txType === 'SELL') {
      // Handle SELL event (for copy-sell logic)
      const sellPrice = (message.priceInLamports || 0) / 1e9;
      const tokenSymbol = message.name || message.symbol || message.mint.substring(0, 6);

      // Calculate accurate PnL from tracked entry
      const entryKey = `${trader}_${message.mint}`;
      const entry = this.inangEntries.get(entryKey);

      let pnlPercent: number | undefined;
      if (entry && entry.entryPrice > 0) {
        pnlPercent = ((sellPrice - entry.entryPrice) / entry.entryPrice) * 100;
        this.inangEntries.delete(entryKey); // Clean up after exit
      }

      const sellEvent: InangSellEvent = {
        type: 'inang_selling',
        inangAddress: trader,
        tokenAddress: message.mint,
        tokenSymbol: tokenSymbol,
        amount: message.tokenAmount || 0,
        price: sellPrice,
        solAmount: (message.solAmount || message.vSolInBondingCurve || 0) / 1e9,
        timestamp: new Date(message.timestamp || Date.now()),
        txHash: message.signature,
        estimatedPnlPercent: pnlPercent ?? message.pnlPercent ?? undefined
      };

      const pnlStr = pnlPercent !== undefined ? ` (PnL: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)` : '';
      const exitType = pnlPercent !== undefined
        ? (pnlPercent < 0 ? '🔴 CL' : pnlPercent > 0 ? '🟢 TP' : '⚪ FLAT')
        : '🔴 SELL';

      logger.info(`[Monitor] ${exitType}: ${trader.substring(0, 12)}... selling ${tokenSymbol} @ ${sellPrice.toFixed(9)} SOL${pnlStr}`);
      this.emit('inang_selling', sellEvent);
    }
  }

  /**
   * Get list of currently monitored addresses
   */
  public getMonitoredCount(): number {
    return this.monitoredInangs.size;
  }

  /**
   * Check if address is being monitored
   */
  public isMonitored(address: string): boolean {
    return this.monitoredInangs.has(address.toLowerCase());
  }

  /**
   * Remove inang dari monitoring (e.g., when blacklisted)
   */
  public removeInang(address: string): void {
    const addressLower = address.toLowerCase();
    
    if (this.monitoredInangs.has(addressLower)) {
      this.monitoredInangs.delete(addressLower);
      this.unsubscribeFromTrader(addressLower);
      logger.info(`[Monitor] Removed inang from monitoring: ${address}`);
    }
  }

  /**
   * Force refresh all subscriptions (useful when adding multiple new inangs)
   */
  public async refreshSubscriptions(): Promise<void> {
    await this.refreshMonitoredList();
    
    if (this.ws?.readyState === WebSocket.OPEN) {
      // Re-subscribe to all
      this.monitoredInangs.forEach(address => {
        this.subscribeToTrader(address);
      });
    }
    
    logger.info(`[Monitor] Refreshed subscriptions: ${this.monitoredInangs.size} inangs`);
  }

  /**
   * Cleanup old entries to prevent memory leaks
   * Call this periodically (e.g., once per day)
   */
  public cleanupOldEntries(): void {
    const now = Date.now();
    let cleaned = 0;

    this.inangEntries.forEach((entry, key) => {
      if ((now - entry.timestamp) > this.ENTRY_MAX_AGE_MS) {
        this.inangEntries.delete(key);
        cleaned++;
      }
    });

    if (cleaned > 0) {
      logger.info(`[Monitor] Cleaned up ${cleaned} old entry records`);
    }
  }

  /**
   * Get stats about tracked entries (for debugging)
   */
  public getEntryStats(): { total: number; oldest: number | null } {
    let oldest: number | null = null;

    this.inangEntries.forEach((entry) => {
      if (oldest === null || entry.timestamp < oldest) {
        oldest = entry.timestamp;
      }
    });

    return {
      total: this.inangEntries.size,
      oldest: oldest
    };
  }
}
