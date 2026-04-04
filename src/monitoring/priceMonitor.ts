import WebSocket from 'ws';
import EventEmitter from 'events';
import { TradeBase } from '../database/tradeBase';
import { createModuleLogger } from '../utils/logger';
import { CONFIG } from '../config/config';

const logger = createModuleLogger('Price');

interface TokenTracking {
  tokenAddress: string;
  entryPrice: number;
  highestPrice: number;
  isTrailingActive: boolean;
  stopLossPrice: number; // -50% from entry
}

interface TrailingStopEvent {
  type: 'trailing_stop_hit';
  tokenAddress: string;
  entryPrice: number;
  highestPrice: number;
  exitPrice: number;
  dropPercent: number;
  profitPercent: number;
  timestamp: Date;
}

interface EmergencyExitEvent {
  type: 'emergency_exit';
  tokenAddress: string;
  entryPrice: number;
  exitPrice: number;
  lossPercent: number;
  timestamp: Date;
}

export class PriceMonitor extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectDelay = CONFIG.WS_RECONNECT_DELAY_MS;
  private isRunning = false;
  private trackedTokens: Map<string, TokenTracking> = new Map();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pumpPortalWsUrl: string;
  private tradeBase: TradeBase;

  // Configurable thresholds from CONFIG
  private trailingActivationProfit = CONFIG.TRAILING_ACTIVATION_PERCENT / 100;
  private trailingStopDrop = CONFIG.TRAILING_STOP_DROP / 100;
  private emergencyStopLoss = CONFIG.EMERGENCY_STOP_LOSS / 100;

  constructor(pumpPortalWsUrl: string, tradeBase: TradeBase) {
    super();
    this.pumpPortalWsUrl = pumpPortalWsUrl;
    this.tradeBase = tradeBase;
  }

  /**
   * Start tracking a new token
   */
  public async startTracking(tokenAddress: string, entryPrice: number): Promise<void> {
    const tokenLower = tokenAddress.toLowerCase();
    
    if (this.trackedTokens.has(tokenLower)) {
      logger.warn(`[PriceMonitor] Token ${tokenAddress} is already being tracked`);
      return;
    }

    const stopLossPrice = entryPrice * (1 - this.emergencyStopLoss);
    
    const tracking: TokenTracking = {
      tokenAddress: tokenLower,
      entryPrice,
      highestPrice: entryPrice,
      isTrailingActive: false,
      stopLossPrice
    };

    this.trackedTokens.set(tokenLower, tracking);
    logger.info(`[PriceMonitor] Started tracking ${tokenAddress} at entry price ${entryPrice.toFixed(9)} SOL`);

    // Subscribe to token-specific trades
    this.subscribeToToken(tokenLower);
  }

  /**
   * Stop tracking a token
   */
  public stopTracking(tokenAddress: string): void {
    const tokenLower = tokenAddress.toLowerCase();
    
    if (this.trackedTokens.has(tokenLower)) {
      this.trackedTokens.delete(tokenLower);
      this.unsubscribeFromToken(tokenLower);
      logger.info(`[PriceMonitor] Stopped tracking ${tokenAddress}`);
    }
  }

  /**
   * Connect to PumpPortal WSS
   */
  public connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      logger.info('[PriceMonitor] Already connected');
      return;
    }

    try {
      this.ws = new WebSocket(this.pumpPortalWsUrl, {
        headers: {
          'Origin': 'https://pumpportal.fun',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      this.ws.on('open', () => {
        logger.info('[PriceMonitor] Connected to PumpPortal WSS');
        
        // Subscribe to all tracked tokens
        this.trackedTokens.forEach((tracking, address) => {
          this.subscribeToToken(address);
        });
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
          logger.warn('[PriceMonitor] WSS disconnected, auto-reconnecting...');
          this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
        }
      });

      this.ws.on('error', (error) => {
        logger.error(`[PriceMonitor] WSS Error: ${error.message}`);
      });

    } catch (error) {
      logger.error(`[PriceMonitor] Failed to connect: ${error}`);
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    }
  }

  /**
   * Subscribe to token-specific trade updates
   */
  private subscribeToToken(tokenAddress: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const subscribeMsg = {
      method: 'subscribeTokenTrade',
      params: {
        token: tokenAddress
      }
    };

    this.ws.send(JSON.stringify(subscribeMsg));
    logger.info(`[PriceMonitor] Subscribed to token: ${tokenAddress.substring(0, 12)}...`);
  }

  /**
   * Unsubscribe from token
   */
  private unsubscribeFromToken(tokenAddress: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const unsubscribeMsg = {
      method: 'unsubscribeTokenTrade',
      params: {
        token: tokenAddress
      }
    };

    this.ws.send(JSON.stringify(unsubscribeMsg));
  }

  /**
   * Handle incoming WSS message
   */
  private async handleMessage(message: any): Promise<void> {
    // Check if this is a token trade message
    if (!message.mint || !message.vSolReserves || !message.vTokenReserves) return;

    const tokenAddress = message.mint.toLowerCase();
    const tracking = this.trackedTokens.get(tokenAddress);

    if (!tracking) return; // Not tracking this token

    // Calculate price: vSolReserves / vTokenReserves
    const vSolReserves = message.vSolReserves / 1e9; // Convert from lamports
    const vTokenReserves = message.vTokenReserves / 1e9;
    const currentPrice = vSolReserves / vTokenReserves;

    // Update highest price if needed
    if (currentPrice > tracking.highestPrice) {
      tracking.highestPrice = currentPrice;
      this.tradeBase.updateHighestPriceByToken(tokenAddress, currentPrice);
      logger.info(`[PriceMonitor] New highest price for ${tokenAddress.substring(0, 12)}...: ${currentPrice.toFixed(9)} SOL`);
    }

    // Check profit and activate trailing stop
    const profitPercent = (currentPrice - tracking.entryPrice) / tracking.entryPrice;
    
    if (profitPercent >= this.trailingActivationProfit && !tracking.isTrailingActive) {
      tracking.isTrailingActive = true;
      logger.info(`[PriceMonitor] Trailing stop activated for ${tokenAddress.substring(0, 12)}... (profit: ${(profitPercent * 100).toFixed(1)}%)`);
    }

    // Check trailing stop condition (20% drop from highest)
    if (tracking.isTrailingActive) {
      const dropFromHighest = (tracking.highestPrice - currentPrice) / tracking.highestPrice;
      
      if (dropFromHighest >= this.trailingStopDrop) {
        // Trailing stop hit - emit event
        const event: TrailingStopEvent = {
          type: 'trailing_stop_hit',
          tokenAddress: tokenAddress,
          entryPrice: tracking.entryPrice,
          highestPrice: tracking.highestPrice,
          exitPrice: currentPrice,
          dropPercent: dropFromHighest * 100,
          profitPercent: profitPercent * 100,
          timestamp: new Date()
        };

        logger.info(`[PriceMonitor] Trailing stop hit for ${tokenAddress.substring(0, 12)}... Drop: ${(dropFromHighest * 100).toFixed(1)}% from highest`);
        
        this.emit('trailing_stop_hit', event);
        this.stopTracking(tokenAddress);
        return;
      }
    }

    // Check emergency exit (stop loss -50% from entry)
    if (currentPrice <= tracking.stopLossPrice) {
      const lossPercent = (tracking.entryPrice - currentPrice) / tracking.entryPrice;
      
      const event: EmergencyExitEvent = {
        type: 'emergency_exit',
        tokenAddress: tokenAddress,
        entryPrice: tracking.entryPrice,
        exitPrice: currentPrice,
        lossPercent: lossPercent * 100,
        timestamp: new Date()
      };

      logger.warn(`[PriceMonitor] Emergency exit triggered for ${tokenAddress.substring(0, 12)}... Loss: ${(lossPercent * 100).toFixed(1)}%`);
      
      this.emit('emergency_exit', event);
      this.stopTracking(tokenAddress);
      return;
    }
  }

  /**
   * Start the monitor (connect WSS)
   */
  public start(): void {
    if (this.isRunning) {
      logger.warn('[PriceMonitor] Already running');
      return;
    }

    this.isRunning = true;
    this.connect();
    logger.info('[PriceMonitor] Started');
  }

  /**
   * Stop the monitor
   */
  public stop(): void {
    this.isRunning = false;
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Unsubscribe from all tokens
    this.trackedTokens.forEach((_, address) => {
      this.unsubscribeFromToken(address);
    });

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    logger.info('[PriceMonitor] Stopped');
  }

  /**
   * Get tracking info for a token
   */
  public getTrackingInfo(tokenAddress: string): TokenTracking | undefined {
    return this.trackedTokens.get(tokenAddress.toLowerCase());
  }

  /**
   * Get all tracked tokens count
   */
  public getTrackedCount(): number {
    return this.trackedTokens.size;
  }

  /**
   * Check if token is being tracked
   */
  public isTracking(tokenAddress: string): boolean {
    return this.trackedTokens.has(tokenAddress.toLowerCase());
  }

  /**
   * Get current price from cache (if available)
   * Note: Price is calculated on-the-fly from WSS messages
   */
  public getCurrentPrice(tokenAddress: string): number | undefined {
    const tracking = this.trackedTokens.get(tokenAddress.toLowerCase());
    return tracking ? tracking.highestPrice : undefined;
  }
}
