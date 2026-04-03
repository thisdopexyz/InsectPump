/**
 * InsectPump Configuration
 * 
 * SEMUA PARAMETER STRATEGI TRADING ADA DI SINI!
 * Edit file ini untuk ganti threshold, min buy, dll.
 * 
 * Setelah edit: npm run build && npm run start
 * 
 * .env cuma buat secrets (API keys, private key, RPC URLs)
 */

export const CONFIG = {
  // ============================================================================
  // SECRETS (di-override dari .env)
  // ============================================================================
  PRIVATE_KEY: process.env.PRIVATE_KEY || '',
  HELIUS_RPC_URL: process.env.HELIUS_RPC_URL || '',
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  ALCHEMY_RPC_URL: process.env.ALCHEMY_RPC_URL || '',
  ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY || '',
  PUMP_PORTAL_WSS: process.env.PUMP_PORTAL_WSS || 'wss://pumpportal.fun/api/data',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  
  // ============================================================================
  // STRATEGI: BUY KITA (Bot Trading)
  // ============================================================================
  // Ukuran buy kita per trade
  OUR_BUY_SIZE_SOL: 0.1,           // Buy 0.1 SOL per position
  
  // Mcap entry kita
  OUR_MIN_MCAP_SOL: 60,              // Entry min 60 SOL mcap
  OUR_MAX_MCAP_SOL: 300,             // Entry max 300 SOL mcap
  
  // ============================================================================
  // STRATEGI: INANG/WHALE DETECTION
  // ============================================================================
  // Min buy whale yang kita anggap "inang"
  MIN_INANG_BUY_SOL: 0.3,            // Whale buy min 0.3 SOL
  MAX_INANG_BUY_SOL: 2.0,            // Whale buy max 2.0 SOL
  
  // Sniper protection: Skip buys di awal launch
  SNIPER_WINDOW_SECONDS: 30,         // Skip 30 detik pertama
  
  // ============================================================================
  // STRATEGI: PUMPING DETECTION (After Sniper Window)
  // ============================================================================
  // Whale buy threshold (setelah 30s, min buy ini = trigger)
  PUMP_MIN_BUY_SOL: 0.1,             // Min 0.1 SOL = whale
  PUMP_MAX_BUY_SOL: 2.0,             // Max 2.0 SOL
  
  // Market cap filter
  PUMP_MIN_MCAP_SOL: 25,             // Min 25 SOL mcap
  
  // Check interval
  PUMP_CHECK_INTERVAL_MS: 15000,      // Check tiap 15 detik
  PUMP_GROWTH_THRESHOLD: 0.10,       // 10% growth = pumping
  
  // ============================================================================
  // STRATEGI: HELIUS ANALYSIS (L3/L4)
  // ============================================================================
  // TX limit buat winrate calc (higher = lebih akurat, lebih mahal)
  HELIUS_L3_LIMIT: 50,               // 50 TX = ~2-3 credits
  
  // Filter trading activity (MODE 2: MODERATE - balanced quality)
  MIN_TRADING_ACTIVITY: 2,           // Min 2 swaps - some activity required
  MIN_WINRATE_PERCENT: 30,             // Min 30% winrate - minimum profitable
  MIN_COMPLETED_TRADES: 1,             // Min 1 round-trip - must have closed trade
  MIN_BUY_SIZE_SOL: 0.01,              // Skip dust buys < 0.01 SOL
  SKIP_SELL_ONLY_WALLETS: true,        // Skip wallet sell-only
  
  // ============================================================================
  // STRATEGI: ALCHEMY FILTER (L2)
  // ============================================================================
  MIN_TOTAL_TX: 100,                   // Filter burn/dev wallets
  
  // ============================================================================
  // EXECUTION: PRIORITY FEE
  // ============================================================================
  BASE_PRIORITY_FEE: 10000,            // 0.001 SOL base fee
  MAX_PRIORITY_FEE: 5000000,           // 0.5 SOL max fee (anti stuck)
  
  // ============================================================================
  // EXECUTION: POSITION MANAGEMENT (Trailing Stop)
  // ============================================================================
  MAX_CONCURRENT_POSITIONS: 2,         // Max 2 posisi open
  TRAILING_ACTIVATION_PERCENT: 30,     // 30% profit = trailing stop aktif
  TRAILING_STOP_DROP: 20,              // 20% drop dari highest = sell
  EMERGENCY_STOP_LOSS: 50,             // -50% dari entry = emergency sell
  
  // ============================================================================
  // EYE: PUMPING DETECTION SETTINGS
  // ============================================================================
  EYE_MAX_TRACKED_TOKENS: 200,         // Max 200 token concurrent
  EYE_TOKEN_TTL_MINUTES: 60,           // Token expire setelah 60 menit
  EYE_MIN_TOKEN_STAY_MS: 3 * 60 * 1000, // Token stay 3 min sebelum boleh di-kick (biar whale detection sempat jalan)
  EYE_PUMP_THRESHOLD_PERCENT: 10,        // 10% growth = pumping
  EYE_CHECK_INTERVAL_SECONDS: 15,      // Check tiap 15 detik
  EYE_MIN_MCAP_TRACK_SOL: 1,             // Min 1 SOL mcap untuk tracking
  EYE_SKIP_FIRST_N_BUYS: 5,              // Skip 5 buy pertama (sniper bundle)
  EYE_BUNDLE_WINDOW_MS: 5000,            // 5 detik window bundle detection
  EYE_BUNDLE_AMOUNT_THRESHOLD_SOL: 0.1,  // 0.1 SOL threshold bundle amount
  EYE_WALLET_CACHE_TTL_MINUTES: 30,      // 30 menit wallet cache TTL
  
  // ============================================================================
  // EXECUTION: PRIORITY FEE Tiers
  // ============================================================================
  FEE_TIER_LOW: 0.0001,                // 0.0001 SOL - Low congestion
  FEE_TIER_NORMAL: 0.0005,             // 0.0005 SOL - Normal
  FEE_TIER_HIGH: 0.001,                // 0.001 SOL - High congestion
  FEE_TIER_URGENT: 0.005,              // 0.005 SOL - Urgent
  FEE_CACHE_TTL_SECONDS: 30,           // 30 detik fee cache
  PRICE_CACHE_TTL_SECONDS: 30,         // 30 detik price cache
  
  // ============================================================================
  // RPC & API TIMEOUTS
  // ============================================================================
  RPC_TIMEOUT_MS: 30000,               // 30 detik RPC timeout
  API_TIMEOUT_MS: 5000,                // 5 detik API timeout
  WS_RECONNECT_DELAY_MS: 5000,         // 5 detik WS reconnect
  MAX_WS_RECONNECT_ATTEMPTS: 10,       // Max 10 reconnect attempts
  HELIUS_API_TIMEOUT_MS: 15000,        // 15 detik Helius API timeout
  
  // ============================================================================
  // RATE LIMITING & COOLDOWNS
  // ============================================================================
  DUPLICATE_BUY_WINDOW_MS: 60000,        // 60 detik cooldown buy ulang
  EXTENDED_BLOCK_MS: 300000,           // 5 menit extended block
  BUY_FAIL_BLOCK_MS: 600000,           // 10 menit block kalo buy fail
  DASHBOARD_INTERVAL_MS: 30000,        // 30 detik update dashboard
  CACHE_CLEANUP_INTERVAL_MS: 300000,   // 5 menit cleanup cache
  
  // ============================================================================
  // TOKEN PROTECTION
  // ============================================================================
  TOKEN_PROTECTION_PERIOD_MS: 60000,   // 60 detik protection new token
  RECENT_BUYS_WINDOW_MS: 10000,        // 10 detik window recent buys
  
  // ============================================================================
  // TRADING PARAMETERS
  // ============================================================================
  DEFAULT_SLIPPAGE_BPS: 200,           // 2% default slippage (200 bps)
  ATA_COST_ESTIMATE_SOL: 0.002,        // 0.002 SOL untuk buat ATA
  GRADUATION_THRESHOLD_SOL: 30,        // 30 SOL = graduated
  COMPUTE_UNIT_LIMIT: 200000,          // 200k compute units
  
  // ============================================================================
  // FILTER THRESHOLDS
  // ============================================================================
  FAIL_RATE_THRESHOLD: 0.5,            // 50% max fail rate (bot detection)
  PARTIAL_SELL_RATIO: 0.5,             // 50% ratio = partial sell
  
  // ============================================================================
  // LOGGING
  // ============================================================================
  LOG_MAX_SIZE_BYTES: 52428800,        // 50MB max log size
  LOG_MAX_FILES: 5,                    // 5 log files rotation
  
  // ============================================================================
  // WALLET: BUFFER & SAFETY
  // ============================================================================
  WALLET_BUFFER_SOL: 0.01,             // 0.01 SOL buffer untuk gas
  WALLET_MIN_BALANCE_SOL: 0.01,        // Min 0.01 SOL untuk trading
  
  // ============================================================================
  // DATABASE & LOGGING
  // ============================================================================
  DB_PATH: process.env.DB_PATH || './data/insectpump.db',
  BLACKLIST_PATH: process.env.BLACKLIST_PATH || './data/blacklist.json',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  LOG_TO_FILE: process.env.LOG_TO_FILE === 'true',
};

// Validasi config
export function validateConfig(): void {
  const requiredSecrets = [
    'PRIVATE_KEY',
    'HELIUS_RPC_URL', 
    'HELIUS_API_KEY',
    'ALCHEMY_RPC_URL',
    'ALCHEMY_API_KEY'
  ];
  
  const missing = requiredSecrets.filter(key => !CONFIG[key as keyof typeof CONFIG]);
  if (missing.length > 0) {
    throw new Error(`Missing required secrets in .env: ${missing.join(', ')}`);
  }
}
