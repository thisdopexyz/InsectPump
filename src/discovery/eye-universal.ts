import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger';
import { CONFIG } from '../config/config';
import { FilterIdentity } from './filterIdentity';
import { InangBase } from '../database/inangBase';
import { Analyzer } from './analyzer';

/**
 * EyeUniversal - Universal Pumping Token Radar
 * 
 * Features:
 * - Track BUY trades only (no sells)
 * - Filter: mcap >= 60 SOL, buy size >= 0.3 SOL
 * - FIFO 100 token queue
 * - 30-second tracking window
 * - >10% growth = pumping detected
 * - Emits: 'pumping', 'inang_added', 'trade'
 * 
 * DIFFERENT from Eye.ts:
 * - No create events (trade only)
 * - Buy only (no sell tracking for momentum)
 * - Higher mcap threshold (60 SOL vs 1 SOL)
 * - Longer window (30s vs 15s)
 */

interface TrackedToken {
  mint: string;
  firstSeen: number;
  lastCheck: number;
  initialMcap: number;
  currentMcap: number;
  buyVolume: number;
  buyCount: number;
  mcaps: { mcap: number; ts: number }[];
  wallets: Set<string>;
  isPumping: boolean;
  pumpingNotified: boolean;
}

interface TradeEvent {
  type: 'buy';
  mint: string;
  trader: string;
  amount: number;
  mcap: number;
  signature: string;
  timestamp: number;
}

export class EyeUniversal extends EventEmitter {
  private ws: WebSocket | null = null;
  private filter: FilterIdentity;
  private analyzer: Analyzer;
  private db: InangBase;
  private trackedTokens = new Map<string, TrackedToken>();
  private processingWallets = new Set<string>();
  private checkedWallets = new Map<string, number>(); // Simple rate limiting
  private isRunning = false;
  private radarInterval: NodeJS.Timeout | null = null;
  private readonly PUMP_THRESHOLD = CONFIG.EYE_PUMP_THRESHOLD_PERCENT || 10;
  private readonly CHECK_INTERVAL = 30000; // 30 seconds
  private readonly TRACKING_WINDOW = 30000; // 30 seconds for growth calc
  private readonly MAX_TRACKED = 100;
  private readonly MIN_MCAP = 60; // SOL
  private readonly MIN_BUY_SIZE = 0.3; // SOL
  private readonly WALLET_CHECK_COOLDOWN = 600000; // 10 minutes

  constructor() {
    super();
    this.filter = new FilterIdentity();
    this.analyzer = new Analyzer(
      CONFIG.HELIUS_RPC_URL || '',
      CONFIG.ALCHEMY_RPC_URL || ''
    );
    this.db = new InangBase(); // Auto-init in constructor
  }

  async init(): Promise<void> {
    logger.info('[EyeUniversal] Initializing universal radar...');
    // DB already initialized in constructor, analyzer ready
    logger.info('[EyeUniversal] Radar initialized');
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    logger.info('[EyeUniversal] Starting universal pumping radar...');
    logger.info(`[EyeUniversal] Config: ${this.PUMP_THRESHOLD}% threshold, ${this.CHECK_INTERVAL/1000}s check, max ${this.MAX_TRACKED} tokens`);
    logger.info(`[EyeUniversal] Filters: mcap >= ${this.MIN_MCAP} SOL, buy >= ${this.MIN_BUY_SIZE} SOL`);

    this.connectWebSocket();
    this.startRadar();
  }

  stop(): void {
    this.isRunning = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.radarInterval) {
      clearInterval(this.radarInterval);
      this.radarInterval = null;
    }
    logger.info('[EyeUniversal] Stopped');
  }

  isActive(): boolean {
    return this.isRunning;
  }

  getProcessingCount(): number {
    return this.processingWallets.size;
  }

  getTrackedTokensCount(): number {
    return this.trackedTokens.size;
  }

  private connectWebSocket(): void {
    const wsUrl = CONFIG.PUMP_PORTAL_WSS || 'wss://pumpportal.fun/api/data';
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      logger.info('[EyeUniversal] WebSocket connected');
      this.subscribeToTrades();
    });

    this.ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleWebSocketMessage(msg);
      } catch (err) {
        // ignore parse errors
      }
    });

    this.ws.on('close', () => {
      logger.warn('[EyeUniversal] WebSocket closed, reconnecting in 5s...');
      setTimeout(() => this.connectWebSocket(), 5000);
    });

    this.ws.on('error', (err) => {
      logger.error('[EyeUniversal] WebSocket error:', err.message);
    });
  }

  private subscribeToTrades(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Subscribe to ALL trade events (buy/sell, but we filter buy only)
    const payload = {
      method: 'subscribeAccountTrade',
      keys: ['all'] // Special key to get all trades (if supported)
    };
    
    // Alternative: subscribe to specific high-volume tokens
    // For now, we use a workaround - poll recent trades via Helius
    
    this.ws.send(JSON.stringify(payload));
    logger.info('[EyeUniversal] Subscribed to trade events');
  }

  private handleWebSocketMessage(msg: any): void {
    // Handle different message types from PumpPortal
    if (msg.message === 'Successfully subscribed to account trades.') {
      logger.info('[EyeUniversal] ✅ Trade subscription confirmed');
      return;
    }

    // Trade event format from PumpPortal
    if (msg.type === 'buy' || msg.txType === 'buy') {
      this.handleBuyEvent({
        type: 'buy',
        mint: msg.mint || msg.token,
        trader: msg.trader || msg.user,
        amount: parseFloat(msg.solAmount || msg.amount || 0),
        mcap: parseFloat(msg.marketCapSol || msg.mcap || 0),
        signature: msg.signature || msg.tx,
        timestamp: Date.now()
      });
    }
  }

  private handleBuyEvent(event: TradeEvent): void {
    // Filter: min mcap 60 SOL, min buy 0.3 SOL
    if (event.mcap < this.MIN_MCAP) return;
    if (event.amount < this.MIN_BUY_SIZE) return;

    const mint = event.mint;
    const now = Date.now();

    // Check if already tracked
    let token = this.trackedTokens.get(mint);

    if (!token) {
      // Check if queue full - pop oldest if needed
      if (this.trackedTokens.size >= this.MAX_TRACKED) {
        this.popOldestToken();
      }

      // Create new tracked token
      token = {
        mint,
        firstSeen: now,
        lastCheck: now,
        initialMcap: event.mcap,
        currentMcap: event.mcap,
        buyVolume: event.amount,
        buyCount: 1,
        mcaps: [{ mcap: event.mcap, ts: now }],
        wallets: new Set([event.trader]),
        isPumping: false,
        pumpingNotified: false
      };
      this.trackedTokens.set(mint, token);
      
      logger.info(`[EyeUniversal] 🎯 New tracked token: ${mint.slice(0, 12)}... | Mcap: ${event.mcap.toFixed(1)} SOL | Buy: ${event.amount.toFixed(2)} SOL | Queue: ${this.trackedTokens.size}/${this.MAX_TRACKED}`);
    } else {
      // Update existing token
      token.currentMcap = event.mcap;
      token.buyVolume += event.amount;
      token.buyCount++;
      token.wallets.add(event.trader);
      token.mcaps.push({ mcap: event.mcap, ts: now });
      
      // Keep only last 30 seconds of mcap data
      const cutoff = now - this.TRACKING_WINDOW;
      token.mcaps = token.mcaps.filter(m => m.ts >= cutoff);
    }

    // Emit trade event
    this.emit('trade', event);

    // Check for inang (whale)
    this.checkInang(event.trader, event);
  }

  private popOldestToken(): void {
    let oldest: TrackedToken | null = null;
    let oldestKey = '';

    Array.from(this.trackedTokens.entries()).forEach(([key, token]) => {
      if (!oldest || token.firstSeen < oldest.firstSeen) {
        oldest = token;
        oldestKey = key;
      }
    });

    if (oldestKey) {
      this.trackedTokens.delete(oldestKey);
      logger.info(`[EyeUniversal] ♻️ Replaced token: ${oldestKey.slice(0, 12)}... (oldest)`);
    }
  }

  private startRadar(): void {
    this.radarInterval = setInterval(() => {
      this.checkForPumping();
    }, this.CHECK_INTERVAL);
  }

  private checkForPumping(): void {
    const now = Date.now();

    Array.from(this.trackedTokens.entries()).forEach(([mint, token]) => {
      // Get mcap 30 seconds ago vs current
      const cutoff = now - this.TRACKING_WINDOW;
      const oldMcaps = token.mcaps.filter(m => m.ts <= cutoff + 5000); // within 5s of cutoff
      
      if (oldMcaps.length === 0) return; // Not enough history

      const oldMcap = oldMcaps[0].mcap;
      const currentMcap = token.currentMcap;
      
      if (oldMcap <= 0) return;

      const growth = ((currentMcap - oldMcap) / oldMcap) * 100;

      // Detect pumping
      if (growth >= this.PUMP_THRESHOLD && !token.pumpingNotified) {
        token.isPumping = true;
        token.pumpingNotified = true;

        logger.info('');
        logger.info(`[EyeUniversal] 🚀 PUMPING DETECTED: ${mint.slice(0, 16)}...`);
        logger.info(`[EyeUniversal]    Growth: +${growth.toFixed(1)}% | ${oldMcap.toFixed(1)} → ${currentMcap.toFixed(1)} SOL`);
        logger.info(`[EyeUniversal]    Buys: ${token.buyCount} | Volume: ${token.buyVolume.toFixed(2)} SOL | Wallets: ${token.wallets.size}`);
        logger.info('');

        this.emit('pumping', {
          mint,
          growth,
          initialMcap: token.initialMcap,
          currentMcap,
          buyVolume: token.buyVolume,
          buyCount: token.buyCount,
          walletCount: token.wallets.size,
          age: Math.floor((now - token.firstSeen) / 1000)
        });
      }
    });
  }

  private async checkInang(trader: string, event: TradeEvent): Promise<void> {
    if (this.processingWallets.has(trader)) return;
    
    // Rate limit check per wallet (in-memory)
    const lastCheck = this.checkedWallets.get(trader);
    const now = Date.now();
    if (lastCheck && (now - lastCheck) < this.WALLET_CHECK_COOLDOWN) return; // 10 min cooldown

    this.processingWallets.add(trader);

    try {
      const result = await this.analyzer.analyzeWallet(trader);
      
      // Record check time
      this.checkedWallets.set(trader, now);

      if (result.passedAll && result.stage3.passed) {
        const data = result.stage3.data as any;
        
        logger.info('');
        logger.info(`[EyeUniversal] 🎯 INANG FOUND: ${trader.slice(0, 16)}...`);
        logger.info(`[EyeUniversal]    Winrate: ${data?.winrate}% | PnL: ${data?.total_pnl?.toFixed(2)} SOL`);
        logger.info(`[EyeUniversal]    Swaps: ${data?.swapCount} | Trades: ${data?.completedTrades}`);
        logger.info('');

        // Add to DB with correct format
        this.db.addInang({
          address: trader,
          winrate: data?.winrate || 0,
          total_pnl: data?.total_pnl || 0,
          total_tx: data?.total_tx || 0
        });

        this.emit('inang_added', {
          trader,
          data: data,
          source: 'universal',
          token: event.mint
        });
      }
    } catch (err) {
      // Silently fail
    } finally {
      this.processingWallets.delete(trader);
    }
  }
}
