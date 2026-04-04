import 'dotenv/config'; // Load .env before other imports
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { CONFIG } from '../config/config';
import { CONSTANTS } from '../config/constants';
import { logger } from '../utils/logger';
import { FilterIdentity } from './filterIdentity';
import { Analyzer } from './analyzer';
import { InangBase } from '../database/inangBase';
import { initDatabase } from '../database/sqlite';
import type { PumpTrade, Inang, FilterResult, EyeEvent } from '../types/index';
import { lamportsToSol, sleep } from '../utils/math';
/**
 * Eye - Layer 1 & 1.5 Discovery Radar
 * 
 * Cost-efficient inang discovery using PumpPortal WebSocket (FREE)
 * 
 * Architecture:
 * - L1 (WSS): 0 credits (PumpPortal free)
 * - L2 (Alchemy): 0 credits (free tier unlimited)
 * - L3 (Trading Check): ~2-3 credits (Helius Parsed API)
 * - L4 (Winrate Calc): included in L3 call (REAL calculation)
 * 
 * Total per inang: ~2-3 credits (Helius untuk analysis)
 * Buy/Sell execution: 1 credit per trade (Helius sendTransaction)
 * 
 * HYBRID_MODE=false: REAL winrate calculation via Helius
 */
export class Eye extends EventEmitter {
  private ws: WebSocket | null = null;
  private filterIdentity: FilterIdentity;
  private analyzer: Analyzer;
  private inangBase: InangBase;
  private isRunning = false;
  private reconnectAttempts = 0;
  private processingWallets: Set<string> = new Set();
  private totalCreditsUsed: number = 0;

  constructor() {
    super();
    this.filterIdentity = new FilterIdentity(); // Uses Alchemy internally (FREE)
    // Fix: HELIUS_RPC_URL might already contain api-key, check before appending
    const heliusUrl = CONFIG.HELIUS_RPC_URL.includes('api-key=') 
      ? CONFIG.HELIUS_RPC_URL 
      : `${CONFIG.HELIUS_RPC_URL}/?api-key=${CONFIG.HELIUS_API_KEY}`;
    this.analyzer = new Analyzer(
      heliusUrl,
      `${CONFIG.ALCHEMY_RPC_URL}/v2/${CONFIG.ALCHEMY_API_KEY}`
    );
    this.inangBase = new InangBase();
  }

  /**
   * Initialize Eye radar
   */
  async init(): Promise<void> {
    logger.info('[Eye] Initializing radar...');

    // Init database
    await initDatabase();

    // Filter modules auto-init in constructor
    logger.info(`[Eye] Blacklist loaded: ${this.filterIdentity.getBlacklistSize()} wallets`);
    logger.info(`[Eye] Mode: REAL (Helius L3/L4 analysis)`);

    logger.info('[Eye] Radar initialized successfully');
  }

  /**
   * Start Eye radar - connect to PumpPortal WSS
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('[Eye] Radar already running');
      return;
    }

    await this.connect();
  }

  /**
   * Stop Eye radar
   */
  stop(): void {
    this.isRunning = false;
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
    // Cleanup pumping check timer
    if (this.mcapCheckTimer) {
      clearInterval(this.mcapCheckTimer);
      this.mcapCheckTimer = null;
    }
    // FIX #1: Cleanup wallet cache timer
    if (this.walletCacheTimer) {
      clearInterval(this.walletCacheTimer);
      this.walletCacheTimer = null;
    }
    logger.info('[Eye] Radar stopped');
  }

  /**
   * Connect to PumpPortal WebSocket
   */
  private connect(): void {
    logger.info(`[Eye] Connecting to ${CONFIG.PUMP_PORTAL_WSS}`);

    this.ws = new WebSocket(CONFIG.PUMP_PORTAL_WSS, {
      headers: {
        'Origin': 'https://pumpportal.fun',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    this.ws.on('open', () => {
      logger.info('[Eye] WebSocket connected');
      this.isRunning = true;
      this.reconnectAttempts = 0;

      // Subscribe newToken buat dapet data stream (mcap tracking)
      this.subscribeToTrades();
      
      // Start pumping check timer
      this.startPumpingCheck();
    });

    this.ws.on('message', async (data: WebSocket.Data) => {
      try {
        await this.handleMessage(data.toString());
      } catch (error) {
        logger.debug(`[Eye] Error handling message: ${error}`);
      }
    });

    this.ws.on('error', (error) => {
      logger.error(`[Eye] WebSocket error: ${error.message}`);
    });

    this.ws.on('close', () => {
      logger.warn('[Eye] WebSocket disconnected');
      this.handleDisconnect();
    });
  }

  /**
   * Subscribe to global trade events
   * STRATEGY: newToken + Skip first 5 buys (deployer/sniper protection)
   */
  private subscribeToTrades(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Subscribe ke newToken events (dapat semua token baru)
    const newTokenMsg = { method: 'subscribeNewToken' };
    this.ws.send(JSON.stringify(newTokenMsg));
    logger.info('[Eye] ✅ Subscribed to newToken (with deployer skip: first 5 buys ignored)');
  }

  // Message counter for debug
  private msgCount = 0;

  // Track token performance untuk detect "pumping" tokens (mooning)
  private tokenMcapHistory: Map<string, {mcap: number; ts: number}[]> = new Map(); // mint -> [mcap, timestamp][]
  
  // ALL TOKEN strategy: track SEMUA token yang ada activity
  private trackedTokens: Map<string, number> = new Map(); // mint -> timestamp
  private tokenBuyCounter: Map<string, number> = new Map();
  private tokenLaunchTime: Map<string, number> = new Map();
  private recentBuys: Array<{mint: string; trader: string; amount: number; ts: number}> = [];
  private blacklistedWallets: Set<string> = new Set();
  
  // CONNECTED WALLET DETECTION: wallet -> funding source (first SOL provider)
  private walletFundingSource: Map<string, string> = new Map();
  private walletFirstSeen: Map<string, number> = new Map(); // wallet -> timestamp
  private readonly MAX_TRACKED_TOKENS = CONFIG.EYE_MAX_TRACKED_TOKENS;
  private readonly TOKEN_TRACK_TTL_MS = CONFIG.EYE_TOKEN_TTL_MINUTES * 60 * 1000;
  private readonly MCAP_CHECK_INTERVAL_MS = CONFIG.EYE_CHECK_INTERVAL_SECONDS * 1000;
  private readonly PUMP_THRESHOLD_PERCENT = CONFIG.EYE_PUMP_THRESHOLD_PERCENT;
  private readonly MIN_MCAP_FOR_TRACK = CONFIG.EYE_MIN_MCAP_TRACK_SOL;
  private readonly SKIP_FIRST_N_BUYS = CONFIG.EYE_SKIP_FIRST_N_BUYS;
  private readonly SKIP_FIRST_30_SECONDS = CONFIG.SNIPER_WINDOW_SECONDS * 1000;
  private readonly BUNDLE_WINDOW_MS = CONFIG.EYE_BUNDLE_WINDOW_MS;
  private readonly BUNDLE_AMOUNT_THRESHOLD = CONFIG.EYE_BUNDLE_AMOUNT_THRESHOLD_SOL;
  private readonly WALLET_CACHE_TTL_MS = CONFIG.EYE_WALLET_CACHE_TTL_MINUTES * 60 * 1000;
  private mcapCheckTimer: NodeJS.Timeout | null = null;
  private walletCacheTimer: NodeJS.Timeout | null = null;  // FIX #1: Timer untuk cleanup wallet cache

  /**
   * Handle incoming WebSocket message
   * PUMPING ONLY strategy: Track mcap dari semua trades, subscribe pas pumping
   */
  private async handleMessage(data: string): Promise<void> {
    this.msgCount++;
    
    // Log every 100 messages for debug
    if (this.msgCount % 100 === 0) {
      logger.info(`[Eye] WebSocket: ${this.msgCount} msgs, tracking ${this.trackedTokens.size} pumping tokens, history: ${this.tokenMcapHistory.size} tokens`);
    }
    
    try {
      const parsed = JSON.parse(data);
      const txType = parsed.txType as string | undefined;
      const mint = (parsed.mint as string) || '';
      const trader = (parsed.traderPublicKey as string) || (parsed.trader as string) || '';
      const mcap = parseFloat(
        (parsed.marketCapSol as string) || (parsed.vSolInBondingCurve as string) || '0'
      );

      // === STEP 1: Track mcap untuk semua trades (buat pumping detection) ===
      if (mint && mcap > 0) {
        this.trackTokenMcap(mint, mcap);
        // DEBUG: Log first 20 trades to confirm data masuk
        if (this.msgCount <= 20) {
          logger.info(`[Eye] 📊 TRADE #${this.msgCount}: type=${txType}, mint=${mint.slice(0,8)}..., mcap=${mcap.toFixed(1)} SOL`);
        }
      }

      // === STEP 2: Handle 'create' event (token baru) → Subscribe & init counter + launch time ===
      if (txType === 'create' && mint) {
        const now = Date.now();
        
        // === LIMIT CHECK: Max concurrent token subscriptions ===
        if (this.trackedTokens.size >= this.MAX_TRACKED_TOKENS) {
          // Find token to remove: oldest AND passed minimum stay duration
          // This ensures tokens stay long enough for whale detection (30s sniper window + buffer)
          let candidateMint: string | null = null;
          let oldestTime = now;
          this.trackedTokens.forEach((ts, m) => {
            const launchTime = this.tokenLaunchTime.get(m) || ts;
            const ageMs = now - launchTime;
            // Only consider tokens past minimum stay duration (from .env)
            if (ageMs >= CONFIG.EYE_MIN_TOKEN_STAY_MS && ts < oldestTime) {
              oldestTime = ts;
              candidateMint = m;
            }
          });
          // If no token passed min stay, skip adding new token to protect tracking window
          if (!candidateMint) {
            logger.warn(`[Eye] ⚠️ All tokens still young (<${CONFIG.EYE_MIN_TOKEN_STAY_MS/60000}min), skipping new token`);
            return; // Don't add new token, keep existing ones to mature
          }
          if (candidateMint && typeof candidateMint === 'string') {
            this.unsubscribeTokenTrade(candidateMint);
            this.trackedTokens.delete(candidateMint);
            this.tokenBuyCounter.delete(candidateMint);
            this.tokenLaunchTime.delete(candidateMint);
            logger.info(`[Eye] ♻️ Replaced token: ${(candidateMint as string).slice(0, 12)}... (limit: ${this.MAX_TRACKED_TOKENS})`);
          }
        }
        
        this.subscribeTokenTrade(mint);
        this.trackedTokens.set(mint, now);
        this.tokenBuyCounter.set(mint, 0);
        this.tokenLaunchTime.set(mint, now);
        logger.info(`[Eye] 🆕 New token: ${mint.slice(0, 12)}... | Mcap: ${mcap.toFixed(1)} SOL | ${CONFIG.SNIPER_WINDOW_SECONDS}s sniper | Tracked: ${this.trackedTokens.size}/${this.MAX_TRACKED_TOKENS}`);
        return;
      }
      
      // === STEP 3: Handle 'buy' event → Time skip + Bundle detection + Whale detection ===
      if (txType === 'buy' && mint) {
        const solAmount = parseFloat(parsed.solAmount as string || parsed.initialBuy as string || '0');
        const trader = parsed.trader || parsed.user || parsed.account || 'unknown';
        const now = Date.now();
        
        // Only process tracked tokens
        if (!this.trackedTokens.has(mint)) return;
        
        // Check: Wallet blacklisted (previous sniper bundle)?
        if (this.blacklistedWallets.has(trader as string)) {
          logger.debug(`[Eye] ⛔ Blacklisted wallet skipped: ${(trader as string).slice(0, 8)}...`);
          return;
        }
        
        // Update activity timestamp
        this.trackedTokens.set(mint, now);
        
        // Increment buy counter
        const currentCount = (this.tokenBuyCounter.get(mint) || 0) + 1;
        this.tokenBuyCounter.set(mint, currentCount);
        
        // === TIME-BASED SKIP: First X seconds from launch (sniper protection) ===
        const launchTime = this.tokenLaunchTime.get(mint) || 0;
        const secondsSinceLaunch = (now - launchTime) / 1000;
        if (secondsSinceLaunch < CONFIG.SNIPER_WINDOW_SECONDS) {
          if (this.msgCount <= 100 || currentCount <= 10) {
            logger.info(`[Eye] ⏱️  Skipping buy #${currentCount} (${secondsSinceLaunch.toFixed(1)}s, ${solAmount.toFixed(3)} SOL) on ${mint.slice(0,8)}...`);
          }
          // Still add to recent buys for bundle detection
          this.addToRecentBuys(mint, trader as string, solAmount, now);
          return;
        }
        
        // === ENHANCED BUNDLE DETECTION: Time + Connected Wallet Check ===
        const bundleCheck = await this.detectEnhancedBundle(mint, solAmount, now, trader as string);
        
        if (bundleCheck.isBundle) {
          const timeCount = bundleCheck.timeBundleWallets.length;
          const connectedCount = bundleCheck.totalUniqueFunders;
          
          logger.warn(`[Eye] 🎯 SNIPER BUNDLE detected: ${timeCount} buys, ${connectedCount} unique funders on ${mint.slice(0, 12)}...`);
          
          // Log connected groups untuk debug
          bundleCheck.connectedGroups.forEach((wallets, funder) => {
            if (wallets.length > 1) {
              logger.warn(`[Eye] 🔗 CONNECTED: ${wallets.length} wallets funded by ${funder.slice(0, 8)}...`);
            }
          });
          
          // Blacklist all wallets in bundle
          for (const wallet of bundleCheck.timeBundleWallets) {
            this.blacklistedWallets.add(wallet);
            logger.warn(`[Eye] ⛔ Blacklisted: ${wallet.slice(0, 8)}...`);
          }
          return; // Skip this buy
        }
        
        // Add to recent buys for future bundle detection
        this.addToRecentBuys(mint, trader as string, solAmount, now);
        
        // === WHALE BUY DETECTION: After sniper window with >= MIN_INANG_BUY_SOL ===
        if (solAmount >= CONFIG.MIN_INANG_BUY_SOL) {
          logger.info(`[Eye] 🐋 WHALE BUY #${currentCount}: ${solAmount.toFixed(3)} SOL on ${mint.slice(0, 12)}... | ${secondsSinceLaunch.toFixed(0)}s after launch`);
          this.stats.pumpingTrades++;
          const trade = this.parseTrade(parsed);
          if (trade) this.processTrade(trade);
        }
        return;
      }
      
      // === STEP 4: Handle sell events → update token activity ===
      if (txType === 'sell' && mint) {
        if (this.trackedTokens.has(mint)) {
          this.trackedTokens.set(mint, Date.now());
        }
        return;
      }

      // Log other message types (first 50 only) - buat debug struktur data
      if (this.msgCount <= 50) {
        const msgType = parsed.type || txType || parsed.message || 'unknown';
        const keys = Object.keys(parsed).slice(0, 5).join(',');
        logger.info(`[Eye] Other msg #${this.msgCount}: type=${msgType}, keys=[${keys}]`);
      }

    } catch (error) {
      logger.debug(`[Eye] Failed to parse message: ${data.slice(0, 100)}`);
    }
  }

  /**
   * Add buy to recent buys list (for bundle detection)
   * Keep only buys from last 10 seconds
   */
  private addToRecentBuys(mint: string, trader: string, amount: number, ts: number): void {
    // Remove old buys (>10s ago)
    const cutoff = ts - CONFIG.RECENT_BUYS_WINDOW_MS;
    this.recentBuys = this.recentBuys.filter(b => b.ts > cutoff);
    
    // Add new buy
    this.recentBuys.push({ mint, trader, amount, ts });
  }

  /**
   * Detect sniper bundle: multiple buys in 5s window with similar amount
   * Returns array of matching buys if bundle detected
   */
  private detectBundle(mint: string, amount: number, ts: number): Array<{mint: string; trader: string; amount: number; ts: number}> {
    const windowStart = ts - this.BUNDLE_WINDOW_MS;
    const similarBuys = this.recentBuys.filter(b => {
      if (b.mint !== mint) return false;
      if (b.ts < windowStart) return false;
      // Amount similarity: within ±10%
      const ratio = Math.min(amount, b.amount) / Math.max(amount, b.amount);
      return ratio >= (1 - this.BUNDLE_AMOUNT_THRESHOLD);
    });
    
    // Bundle detected if 2+ similar buys in window
    if (similarBuys.length >= 2) {
      // Include current buy (not yet in recentBuys)
      return [...similarBuys, { mint, trader: 'current', amount, ts }];
    }
    return [];
  }

  /**
   * CONNECTED WALLET DETECTION: Check if wallets share same funding source
   * Sniper sering pakai 1 wallet "boss" yang fund multiple sniper wallets
   * Returns: map of funding source -> array of connected wallets
   */
  private async checkConnectedWallets(wallets: string[]): Promise<Map<string, string[]>> {
    const connectedGroups = new Map<string, string[]>();
    
    for (const wallet of wallets) {
      // Skip cache lookup untuk wallet yang udah pernah dicek
      let funder = this.walletFundingSource.get(wallet);
      
      // FIX #1: Track first seen timestamp
      if (!this.walletFirstSeen.has(wallet)) {
        this.walletFirstSeen.set(wallet, Date.now());
      }

      if (!funder) {
        // Fetch funding source via Alchemy (free tier)
        funder = await this.fetchFundingSource(wallet);
        if (funder) {
          this.walletFundingSource.set(wallet, funder);
        }
      }
      
      if (funder) {
        const group = connectedGroups.get(funder) || [];
        group.push(wallet);
        connectedGroups.set(funder, group);
      }
    }
    
    return connectedGroups;
  }

  /**
   * Fetch first funding source (wallet yang kirim SOL pertama kali)
   * Menggunakan Alchemy getSignaturesForAddress (FREE)
   * 
   * Strategy: Cari earliest TX where wallet received SOL (non-system program)
   * atau pertama kali ada balance change positif
   */
  private async fetchFundingSource(wallet: string): Promise<string | undefined> {
    try {
      // For now: simplified version - check if we can use RPC
      // Implementation will be enhanced with actual Alchemy call
      // Return 'unknown' untuk placeholder, will be async later
      
      // TODO: Implement real Alchemy RPC call
      // const signatures = await alchemyConnection.getSignaturesForAddress(
      //   new PublicKey(wallet), { limit: 100 }
      // );
      // Parse earliest TX to find funder...
      
      return undefined; // Placeholder - real implementation needs async RPC
    } catch (error) {
      return undefined;
    }
  }

  /**
   * ENHANCED BUNDLE DETECTION: Check both time+amount AND funding connections
   * Returns bundle info dengan connected wallet analysis
   */
  private async detectEnhancedBundle(
    mint: string, 
    amount: number, 
    ts: number,
    trader: string
  ): Promise<{
    isBundle: boolean;
    timeBundleWallets: string[];
    connectedGroups: Map<string, string[]>;
    totalUniqueFunders: number;
  }> {
    // Step 1: Time-based bundle detection (existing)
    const windowStart = ts - this.BUNDLE_WINDOW_MS;
    const timeBundle = this.recentBuys.filter(b => {
      if (b.mint !== mint) return false;
      if (b.ts < windowStart) return false;
      const ratio = Math.min(amount, b.amount) / Math.max(amount, b.amount);
      return ratio >= (1 - this.BUNDLE_AMOUNT_THRESHOLD);
    });
    
    const timeBundleWallets = [...timeBundle.map(b => b.trader), trader];
    
    // Step 2: Connected wallet detection (new)
    const connectedGroups = await this.checkConnectedWallets(timeBundleWallets);
    
    // Count unique funders (kalau sedikit = likely connected/sniper)
    let totalUniqueFunders = 0;
    connectedGroups.forEach((wallets, funder) => {
      if (wallets.length > 0) totalUniqueFunders++;
    });
    
    // Bundle confirmed kalau:
    // - N+ time-based match ATAU
    // - Multiple wallets from same funder (connected)
    const isBundle = timeBundle.length >= CONFIG.BUNDLE_MIN_WALLETS || 
                     (timeBundleWallets.length > CONFIG.BUNDLE_CONNECTED_WALLETS && totalUniqueFunders <= CONFIG.BUNDLE_MAX_FUNDERS);
    
    return {
      isBundle,
      timeBundleWallets,
      connectedGroups,
      totalUniqueFunders
    };
  }

  /**
   * Subscribe to tokenTrade events for a specific mint
   */
  private subscribeTokenTrade(mint: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const msg = {
      method: 'subscribeTokenTrade',
      keys: [mint],
    };
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Unsubscribe from tokenTrade events
   */
  private unsubscribeTokenTrade(mint: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const msg = {
      method: 'unsubscribeTokenTrade',
      keys: [mint],
    };
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Cleanup expired token subscriptions
   */
  private cleanupExpiredTokens(): void {
    const now = Date.now();
    const expired: string[] = [];
    
    // Use Array.from to avoid downlevelIteration issues
    const entries = Array.from(this.trackedTokens.entries());
    for (let i = 0; i < entries.length; i++) {
      const [mint, timestamp] = entries[i];
      if (now - timestamp > this.TOKEN_TRACK_TTL_MS) {
        expired.push(mint);
      }
    }

    for (let i = 0; i < expired.length; i++) {
      const mint = expired[i];
      this.unsubscribeTokenTrade(mint);
      this.trackedTokens.delete(mint);
      this.tokenBuyCounter.delete(mint);        // FIX #2: Clear counter
      this.tokenLaunchTime.delete(mint);        // FIX #2: Clear launch time
    }

    if (expired.length > 0) {
      logger.info(`[Eye] 🧹 Cleaned up ${expired.length} expired token subs`);
    }
  }

  /**
   * Parse trade data from PumpPortal
   */
  private parseTrade(data: Record<string, unknown>): PumpTrade | null {
    try {
      // newToken events use 'initialBuy' for solAmount, trade events use 'solAmount'
      const solAmount = parseFloat(
        (data.solAmount as string) || (data.initialBuy as string) || '0'
      );
      
      // newToken events use 'vSolInBondingCurve' for market cap calculation
      const mcap = parseFloat(
        (data.marketCapSol as string) || (data.vSolInBondingCurve as string) || '0'
      );

      // Determine if it's a buy (txType: 'buy' or 'create')
      const isBuy = data.txType === 'buy' || data.txType === 'create';

      return {
        signature: (data.signature as string) || (data.txHash as string) || '',
        mint: (data.mint as string) || '',
        trader: (data.traderPublicKey as string) || (data.trader as string) || '',
        tokenAmount: parseFloat(data.tokenAmount as string || '0'),
        solAmount,
        isBuy,
        timestamp: Date.now(),
        mcap,
        price: parseFloat(data.price as string || '0'),
      };
    } catch {
      return null;
    }
  }

  // Stats tracking
  private stats = {
    totalTrades: 0,
    stage1Rejected: 0,
    stage1Passed: 0,
    alreadyInDb: 0,
    newCandidates: 0,
    filterRejected: 0,
    inangAdded: 0,
    pumpingTokens: 0,
    pumpingTrades: 0
  };

  /**
   * Track market cap untuk detect pumping tokens
   */
  private trackTokenMcap(mint: string, mcap: number): void {
    const now = Date.now();
    let history = this.tokenMcapHistory.get(mint);
    if (!history) {
      history = [];
      this.tokenMcapHistory.set(mint, history);
    }

    // Add new data point
    history.push({ mcap, ts: now });

    // Keep only last 10 data points (or last history window)
    const cutoff = now - CONFIG.EYE_HISTORY_WINDOW_MS;
    while (history.length > 0 && history[0].ts < cutoff) {
      history.shift();
    }
    while (history.length > 10) {
      history.shift();
    }
  }

  /**
   * Check apakah token lagi pumping (mooning)
   * Returns growth percentage jika pumping, null jika tidak
   */
  private checkPumping(mint: string): { growth: number; isPumping: boolean } | null {
    const history = this.tokenMcapHistory.get(mint);
    if (!history || history.length < 2) return null;

    const oldest = history[0];
    const latest = history[history.length - 1];
    const timeDiff = (latest.ts - oldest.ts) / 1000; // seconds

    // Need at least minimum time window for valid calculation
    if (timeDiff < CONFIG.MIN_GROWTH_TIME_WINDOW_SEC) return null;

    const growth = ((latest.mcap - oldest.mcap) / oldest.mcap) * 100;
    
    return {
      growth,
      isPumping: growth >= this.PUMP_THRESHOLD_PERCENT
    };
  }

  /**
   * Start timer untuk check pumping tokens dan subscribe ke mereka
   */
  private startPumpingCheck(): void {
    if (this.mcapCheckTimer) return;

    this.mcapCheckTimer = setInterval(() => {
      this.analyzeAndSubscribePumping();
    }, this.MCAP_CHECK_INTERVAL_MS);

    // FIX #1: Start wallet cache cleanup timer
    this.startWalletCacheCleanup();

    logger.info(`[Eye] 🚀 Global Trade Radar: 15s interval, ${this.PUMP_THRESHOLD_PERCENT}% threshold, max ${this.MAX_TRACKED_TOKENS} tokens, min ${this.MIN_MCAP_FOR_TRACK} SOL mcap`);
  }

  /**
   * FIX #1: Cleanup wallet cache yang expired (30 min TTL)
   * Prevent memory bloat dari walletFundingSource & walletFirstSeen
   */
  private startWalletCacheCleanup(): void {
    if (this.walletCacheTimer) return;

    this.walletCacheTimer = setInterval(() => {
      this.cleanupWalletCache();
    }, 5 * 60 * 1000); // Run setiap 5 menit
  }

  /**
   * FIX #1: Remove expired wallet cache entries
   */
  private cleanupWalletCache(): void {
    const now = Date.now();
    let cleaned = 0;

    // Cleanup walletFirstSeen (entry > 30 min)
    this.walletFirstSeen.forEach((timestamp, wallet) => {
      if (now - timestamp > this.WALLET_CACHE_TTL_MS) {
        this.walletFirstSeen.delete(wallet);
        this.walletFundingSource.delete(wallet);
        cleaned++;
      }
    });

    if (cleaned > 0) {
      logger.info(`[Eye] 🧹 Cleaned up ${cleaned} expired wallet cache entries`);
    }
  }

  /**
   * Analyze token growth dan subscribe ke token yang pumping
   */
  private analyzeAndSubscribePumping(): void {
    let pumpingCount = 0;
    const newPumping = new Set<string>();

    // Use Array.from to avoid iteration issues
    const entries = Array.from(this.tokenMcapHistory.entries());
    for (let i = 0; i < entries.length; i++) {
      const [mint, history] = entries[i];
      const check = this.checkPumping(mint);
      if (!check) continue;

      if (check.isPumping) {
        pumpingCount++;
        
        // Jika token baru pumping dan belum di-track, subscribe!
        if (!this.trackedTokens.has(mint)) {
          if (this.trackedTokens.size < this.MAX_TRACKED_TOKENS) {
            const now = Date.now();
            this.subscribeTokenTrade(mint);
            this.trackedTokens.set(mint, now);
            this.tokenBuyCounter.set(mint, 0);        // FIX #3: Init counter
            this.tokenLaunchTime.set(mint, now - CONFIG.TOKEN_PROTECTION_PERIOD_MS);  // Set protection period ago so whale buy triggers immediately
            newPumping.add(mint);
            this.stats.pumpingTokens++;
            logger.info(`[Eye] 🚀 PUMPING DETECTED: ${mint.slice(0, 12)}... | Growth: +${check.growth.toFixed(1)}% | Subscribing...`);
          }
        }
      }
    }

    // FIX #4: Cleanup multiple tokens jika over limit + clear semua data
    while (this.trackedTokens.size > this.MAX_TRACKED_TOKENS) {
      const tokensArray = Array.from(this.trackedTokens.entries());
      // Sort by timestamp (oldest first)
      tokensArray.sort((a, b) => a[1] - b[1]);
      const oldest = tokensArray[0][0];
      this.unsubscribeTokenTrade(oldest);
      this.trackedTokens.delete(oldest);
      this.tokenBuyCounter.delete(oldest);      // FIX #4: Clear counter
      this.tokenLaunchTime.delete(oldest);      // FIX #4: Clear launch time
      logger.info(`[Eye] 🧹 Unsubscribed from old token: ${oldest.slice(0, 12)}...`);
    }

    if (newPumping.size > 0) {
      logger.info(`[Eye] 🚀 Now tracking ${this.trackedTokens.size} pumping tokens (+${newPumping.size} new)`);
    }
  }

  /**
   * Process incoming trade - Stage 1 Filter
   */
  private async processTrade(trade: PumpTrade): Promise<void> {
    this.stats.totalTrades++;
    
    // Log every trade (verbose)
    if (this.stats.totalTrades % 100 === 0) {
      logger.info(`[Eye] Stats: Total=${this.stats.totalTrades} | S1Pass=${this.stats.stage1Passed} | S1Reject=${this.stats.stage1Rejected} | DBSkip=${this.stats.alreadyInDb} | New=${this.stats.newCandidates} | Rejected=${this.stats.filterRejected} | Added=${this.stats.inangAdded}`);
    }
    
    // Stage 1: Filter by buy amount and market cap
    if (!this.passStage1(trade)) {
      this.stats.stage1Rejected++;
      return;
    }
    
    this.stats.stage1Passed++;

    const { trader } = trade;

    // Skip if already processing this wallet
    if (this.processingWallets.has(trader)) {
      return;
    }

    // Skip if already in database
    const existing = await this.inangBase.isInangExists(trader);
    if (existing) {
      this.stats.alreadyInDb++;
      return;
    }

    this.processingWallets.add(trader);

    try {
      logger.info(`[Eye] New candidate detected: ${trader} | Buy: ${trade.solAmount} SOL | Mcap: ${trade.mcap} SOL`);

      this.stats.newCandidates++;
      
      this.emit('trade_detected', {
        type: 'trade_detected',
        timestamp: new Date(),
        trader,
        stage: '1',
        data: trade,
      } as EyeEvent);

      // Run all filter stages
      const result = await this.runFilters(trader);

      if (result.passed) {
        await this.addInang(trader, result.data as Partial<Inang>);
      } else {
        this.stats.filterRejected++;
        // Enhanced logging with actual values
        const dataInfo = result.data ? ` | Data: ${JSON.stringify(result.data)}` : '';
        logger.warn(`[Eye] ${trader.slice(0, 20)}... ${result.reason}${dataInfo}`);
        this.emit('filter_failed', {
          type: 'filter_failed',
          timestamp: new Date(),
          trader,
          stage: result.stage || 'unknown',
          data: { reason: result.reason, ...((result.data || {}) as object) },
        } as EyeEvent);
      }

    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[Eye] Error processing ${trader}: ${errMsg}`);
    } finally {
      this.processingWallets.delete(trader);
    }
  }

  /**
   * Stage 1: Filter by minimum buy SOL and market cap
   */
  private passStage1(trade: PumpTrade): boolean {
    const minBuy = CONFIG.PUMP_MIN_BUY_SOL;
    const minMcap = CONFIG.PUMP_MIN_MCAP_SOL;

    if (trade.solAmount < minBuy) {
      return false;
    }

    if (trade.mcap < minMcap) {
      return false;
    }

    // Only process buys
    if (!trade.isBuy) {
      return false;
    }

    return true;
  }

  /**
   * Run all filter stages (1.5, 2, 3, 4)
   */
  private async runFilters(wallet: string): Promise<FilterResult & { stage?: string }> {
    // Stage 1.5: Filter Identity (Blacklist + Security Scan)
    const identityResult = await this.filterIdentity.filterIdentity(wallet);
    if (!identityResult.passed) {
      return { ...identityResult, stage: '1.5' };
    }
    logger.info(`[Eye] Stage 1.5 PASSED for ${wallet}`);

    // Stage 2: Alchemy Transaction Count
    const alchemyResult = await this.analyzer.checkTransactionCountAlchemy(wallet);
    if (!alchemyResult.passed) {
      return { ...alchemyResult, stage: '2' };
    }
    logger.info(`[Eye] Stage 2 PASSED for ${wallet}`);

    // Stage 3: Comprehensive Analysis (merged L3+L4 - Helius SWAP)
    const stage3Result = await this.analyzer.analyzeTradingActivityAndPnl(wallet);
    if (!stage3Result.passed) {
      return { ...stage3Result, stage: '3' };
    }
    logger.info(`[Eye] Stage 3 PASSED for ${wallet}`);

    // All stages passed - collect all data (with safety checks)
    const safeData = {
      totalTx: (alchemyResult.data as { totalTx?: number })?.totalTx ?? 0,
      tradingActivity: (stage3Result.data as { swapCount?: number })?.swapCount ?? 0,
      winrate: (stage3Result.data as { winrate?: number })?.winrate ?? 0,
      totalPnl: (stage3Result.data as { totalPnl?: number })?.totalPnl ?? 0,
    };
    
    return {
      passed: true,
      data: {
        address: wallet,
        ...safeData,
        status: 'active',
      },
    };
  }

  /**
   * Add qualified inang to database
   */
  private async addInang(wallet: string, data: Partial<Inang>): Promise<void> {
    // Convert to InangData format (snake_case for database)
    const inangData = {
      address: wallet,
      total_tx: data.totalTx || 0,
      winrate: data.winrate || 0,
      total_pnl: data.totalPnl || 0,
      status: 'active',
    };

    const result = this.inangBase.addInang(inangData);

    if (result.success && result.isNew) {
      this.stats.inangAdded++;
      
      logger.info(`[Eye] NEW INANG ADDED: ${wallet} (ID: ${result.id})`);
      logger.info(`[Eye]   - Total TX: ${inangData.total_tx}`);
      logger.info(`[Eye]   - Winrate: ${inangData.winrate.toFixed(2)}%`);
      logger.info(`[Eye]   - Total PnL: ${inangData.total_pnl.toFixed(4)} SOL`);
      logger.info(`[Eye] Stats update: Added=${this.stats.inangAdded} | Rejected=${this.stats.filterRejected}`);

      this.emit('inang_added', {
        type: 'inang_added',
        timestamp: new Date(),
        trader: wallet,
        stage: 'complete',
        data: inangData,
      } as EyeEvent);
    }
  }

  /**
   * Handle WebSocket disconnect - auto reconnect
   */
  private handleDisconnect(): void {
    this.isRunning = false;

    // FIX: Clear timers untuk prevent leak pas reconnect
    if (this.mcapCheckTimer) {
      clearInterval(this.mcapCheckTimer);
      this.mcapCheckTimer = null;
    }
    if (this.walletCacheTimer) {
      clearInterval(this.walletCacheTimer);
      this.walletCacheTimer = null;
    }

    if (this.reconnectAttempts >= CONSTANTS.MAX_WS_RECONNECT_ATTEMPTS) {
      logger.error('[Eye] Max reconnect attempts reached. Giving up.');
      this.emit('error', new Error('Max reconnect attempts reached'));
      return;
    }

    this.reconnectAttempts++;
    const delay = CONSTANTS.WS_RECONNECT_INTERVAL_MS * this.reconnectAttempts;

    logger.info(`[Eye] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${CONSTANTS.MAX_WS_RECONNECT_ATTEMPTS})`);

    setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * Get currently processing wallets count
   */
  getProcessingCount(): number {
    return this.processingWallets.size;
  }

  /**
   * Check if radar is running
   */
  isActive(): boolean {
    return this.isRunning && this.ws?.readyState === WebSocket.OPEN;
  }
}

// Export singleton instance
export const eye = new Eye();
