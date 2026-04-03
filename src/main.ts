import 'dotenv/config';
import { CONFIG, validateConfig } from './config/config';
import { initDatabase, closeDatabase } from './database/sqlite';
import { InangBase } from './database/inangBase';
import { TradeBase } from './database/tradeBase';
import { Eye } from './discovery/eye';
import { InangMonitor } from './monitoring/inangMonitor';
import { PriceMonitor } from './monitoring/priceMonitor';
import { TradeEngine } from './execution/tradeEngine';
import { TelegramService } from './services/telegram';
import { createModuleLogger } from './utils/logger';

const logger = createModuleLogger('Main');

/**
* Main Application Class - Wiring all components together
*/
class InsectPumpBot {
private inangBase: InangBase;
private tradeBase: TradeBase;
private eye: Eye;
private inangMonitor: InangMonitor;
private priceMonitor: PriceMonitor;
private tradeEngine: TradeEngine;
private telegram: TelegramService;
private dashboardInterval: NodeJS.Timeout | null = null;

// Rate limiting: Prevent duplicate buys within timeframe (P0 FIX)
private recentBuyCache: Map<string, number> = new Map(); // tokenAddress -> timestamp
private readonly DUPLICATE_BUY_WINDOW_MS = CONFIG.DUPLICATE_BUY_WINDOW_MS;
private rateLimitCleanupInterval: NodeJS.Timeout | null = null;

// Extended duplicate prevention: Block rebuy for 5 min if buy failed or token rugged
private extendedBuyBlock: Map<string, { until: number; reason: string }> = new Map();
private readonly EXTENDED_BLOCK_MS = CONFIG.EXTENDED_BLOCK_MS;
private readonly BUY_FAIL_BLOCK_MS = CONFIG.BUY_FAIL_BLOCK_MS;

constructor() {
// Initialize all components
this.inangBase = new InangBase();
this.tradeBase = new TradeBase();
this.tradeEngine = new TradeEngine();
this.telegram = new TelegramService();

this.inangMonitor = new InangMonitor(
this.inangBase,
CONFIG.PUMP_PORTAL_WSS || 'wss://pumpportal.fun/api/data'
);

this.priceMonitor = new PriceMonitor(
CONFIG.PUMP_PORTAL_WSS || 'wss://pumpportal.fun/api/data',
this.tradeBase
);

this.eye = new Eye(); // Assumes Eye takes necessary config internally
}

async start(): Promise<void> {
logger.info('╔══════════════════════════════════════════════════╗');
logger.info('║      InsectPump Bot - Full Auto Trading          ║');
logger.info('╚══════════════════════════════════════════════════╝');

try {
// 1. Validate configuration
validateConfig();
logger.info('[Main] Configuration validated');

// 2. Initialize database
await initDatabase();
logger.info('[Main] Database initialized');

// 3. Setup event wiring between components
this.setupWiring();
logger.info('[Main] Event wiring completed');

// 4. Initialize and start all components
await this.inangMonitor.start();
logger.info('[Main] InangMonitor started');

this.priceMonitor.start();
logger.info('[Main] PriceMonitor started');

// SYNC: Resume tracking for any open trades from database
// (e.g., after bot restart with positions still open)
await this.syncOpenTradesToPriceMonitor();

await this.eye.init();
await this.eye.start();
logger.info('[Main] Eye radar started - Scanning for quality traders...');

// 5. Start dashboard
this.startDashboard();

// 6. Start rate limit cache cleanup (every 5 minutes)
this.startRateLimitCleanup();
logger.info(`[Main] Rate limit cache cleanup started (window: ${this.DUPLICATE_BUY_WINDOW_MS / 1000}s)`);

// 7. Start inang entries cleanup (every 6 hours - prevent memory leak)
this.startInangEntriesCleanup();

// 8. Setup graceful shutdown
process.on('SIGINT', () => this.gracefulShutdown());
process.on('SIGTERM', () => this.gracefulShutdown());

logger.info('[Main] Bot is fully operational!');

} catch (error) {
const errMsg = error instanceof Error ? error.message : String(error);
logger.error(`[Main] Fatal error during startup: ${errMsg}`);
process.exit(1);
}
}

/**
* Wire up all event listeners between components
*/
private setupWiring(): void {
// WIRING 1: Eye on inang_added -> InangMonitor.addInangToMonitor()
this.eye.on('inang_added', async (event: any) => {
const inang = event.data;
logger.info(`[Event] NEW INANG DISCOVERED: ${inang.address}`);
logger.info(`        Winrate: ${inang.winrate?.toFixed(2)}%, PnL: ${inang.totalPnl?.toFixed(4)} SOL`);

// Send Telegram notification
await this.telegram.notifyInangFound(
inang.address,
inang.winrate || 0,
inang.totalPnl || 0,
inang.totalTx || 0
);

// Add to monitor
this.inangMonitor.addInangToMonitor(inang.address);
});

// WIRING 2: InangMonitor on inang_buying -> TradeEngine.buy -> PriceMonitor.startTracking
this.inangMonitor.on('inang_buying', async (event: any) => {
logger.info(`[Event] INANG BUYING: ${event.inangAddress.substring(0, 12)}...`);
logger.info(`        Token: ${event.tokenSymbol} (${event.tokenAddress.substring(0, 12)}...)`);
logger.info(`        Amount: ${event.solAmount.toFixed(4)} SOL`);

try {
// === SYARAT 1: Min Market Cap 60 SOL ===
        const tokenMcap=event.mcap || event.tokenMarketCapSol || event.solAmount || 0;
if (tokenMcap < CONFIG.OUR_MIN_MCAP_SOL) {
logger.warn(`[Trade] BUY BLOCKED: Market cap too low (${tokenMcap.toFixed(2)} SOL < ${CONFIG.OUR_MIN_MCAP_SOL} SOL)`);
return; // Skip this buy
}

// === SYARAT 2: Min Inang Buy Amount 0.3 SOL ===
if (event.solAmount < CONFIG.MIN_INANG_BUY_SOL) {
logger.warn(`[Trade] BUY BLOCKED: Inang buy too small (${event.solAmount.toFixed(4)} SOL < ${CONFIG.MIN_INANG_BUY_SOL} SOL)`);
return; // Skip this buy
}

logger.info(`[Trade] Filters passed: Mcap=${tokenMcap.toFixed(2)} SOL, InangBuy=${event.solAmount.toFixed(4)} SOL`);

// === SYARAT 3: Max concurrent positions limit ===
const openPositions = this.tradeBase.getOpenPositionsCount();
const maxPositions = CONFIG.MAX_CONCURRENT_POSITIONS;

if (openPositions >= maxPositions) {
logger.warn(`[Trade] BUY BLOCKED: Max positions reached (${openPositions}/${maxPositions})`);
logger.warn(`[Trade] Ignoring buy signal from ${event.inangAddress.substring(0, 12)}...`);
return; // Skip this buy
}

logger.info(`[Trade] Position check: ${openPositions}/${maxPositions} - Proceeding with buy`);

// === SYARAT 4: EXTENDED BLOCK CHECK - Prevent rebuy of blocked tokens ===
        const tokenLower=event.tokenAddress.toLowerCase();
const now = Date.now();
const extendedBlock = this.extendedBuyBlock.get(tokenLower);

if (extendedBlock && now < extendedBlock.until) {
const secondsRemaining = Math.ceil((extendedBlock.until - now) / 1000);
logger.warn(`[Trade] BUY BLOCKED: Extended block active for ${event.tokenSymbol}`);
logger.warn(`[Trade] Reason: ${extendedBlock.reason}, cooldown: ${secondsRemaining}s remaining`);
return; // Skip this buy
}

// === SYARAT 5: RATE LIMITING - Prevent duplicate buys (P0 FIX) ===
const lastBuyTime = this.recentBuyCache.get(tokenLower);

if (lastBuyTime && (now - lastBuyTime) < this.DUPLICATE_BUY_WINDOW_MS) {
const secondsRemaining = Math.ceil((this.DUPLICATE_BUY_WINDOW_MS - (now - lastBuyTime)) / 1000);
logger.warn(`[Trade] BUY BLOCKED: Rate limit active for ${event.tokenSymbol}`);
logger.warn(`[Trade] Already bought within last ${Math.floor(this.DUPLICATE_BUY_WINDOW_MS / 1000)}s, cooldown: ${secondsRemaining}s remaining`);
return; // Skip this buy
}

// Add to cache before executing (prevent race conditions)
this.recentBuyCache.set(tokenLower, now);
logger.info(`[Trade] Rate limit check passed - Added ${event.tokenSymbol} to buy cache`);

// Execute copy-trade buy
const buyResult = await this.tradeEngine.buy(
event.tokenAddress,
event.solAmount // Or use CONFIG.copyTradeAmount
);

if (buyResult.success && buyResult.txHash) {
logger.info(`[Trade] COPY-BUY SUCCESS: ${buyResult.txHash}`);

// Send Telegram notification
await this.telegram.notifyCopyBuySuccess(
event.tokenAddress,
event.tokenSymbol || 'UNKNOWN',
event.solAmount,
event.inangAddress,
buyResult.txHash
);

// Start tracking price for this token
// Calculate entry price from event data
const entryPrice = event.price || (event.solAmount / event.amount);
await this.priceMonitor.startTracking(event.tokenAddress, entryPrice);

} else {
logger.error(`[Trade] COPY-BUY FAILED: ${buyResult.error}`);

// EXTENDED BLOCK: Add to extended block list to prevent retry (anti-honeypot)
const blockUntil = Date.now() + this.BUY_FAIL_BLOCK_MS;
this.extendedBuyBlock.set(tokenLower, {
until: blockUntil,
reason: `Buy failed: ${buyResult.error?.substring(0, 50) || 'Unknown error'}`
});
logger.warn(`[Trade] Extended block added: ${event.tokenSymbol} blocked for ${this.BUY_FAIL_BLOCK_MS / 60000} minutes`);

// Send Telegram alert for failed buy
await this.telegram.notifyBuyFailed(
event.tokenAddress,
buyResult.error || 'Unknown error'
);
}

} catch (error) {
const errMsg = error instanceof Error ? error.message : String(error);
logger.error(`[Trade] Error during copy-buy: ${errMsg}`);
}
});

// WIRING 2b: InangMonitor on inang_selling -> COPY-SELL logic
// Rules:
// - Whale CL (PnL < 0) + Trailing OFF -> COPY-SELL (ikut cutloss)
// - Whale TP (PnL > 0) + Trailing OFF -> COPY-SELL (ikut take profit, trailing belom aktif)
// - Whale SELL + Trailing ON -> SKIP (biarin trailing jalan, ga ganggu)
this.inangMonitor.on('inang_selling', async (event: any) => {
const whalePnl = event.estimatedPnlPercent ?? 0;
const exitType = whalePnl < 0 ? '🔴 CL' : whalePnl > 0 ? '🟢 TP' : '⚪ FLAT';

logger.info(`[Event] INANG SELLING: ${event.inangAddress.substring(0, 12)}... ${exitType}`);
logger.info(`        Token: ${event.tokenSymbol} (${event.tokenAddress.substring(0, 12)}...)`);
logger.info(`        Amount: ${event.solAmount.toFixed(4)} SOL | Whale PnL: ${whalePnl.toFixed(1)}%`);

try {
// Check if we have position for this token
const trade = this.tradeBase.getTradeByToken(event.tokenAddress);
if (!trade) {
logger.info(`[Trade] COPY-SELL: No position for ${event.tokenSymbol}, ignoring`);
return;
}

// DECISION LOGIC:
// 1. Trailing ACTIVE -> Always skip (let our trailing stop handle it)
// 2. Trailing INACTIVE -> Copy-sell regardless of whale PnL
//    (ikut CL kalo dia cutloss, ikut TP kalo dia profit early)
if (trade.is_trailing_active === 1) {
logger.info(`[Trade] COPY-SELL SKIPPED: Trailing stop active, ignoring whale ${exitType}`);
return;
}

// Trailing not active -> Follow whale exit
logger.info(`[Trade] COPY-SELL: Trailing OFF, following whale ${exitType}...`);

const sellResult = await this.tradeEngine.copySell(
event.tokenAddress,
event.inangAddress,
whalePnl
);

if (sellResult.skipped) {
logger.info(`[Trade] COPY-SELL SKIPPED: ${sellResult.reason}`);
} else if (sellResult.success) {
logger.info(`[Trade] COPY-SELL SUCCESS: ${sellResult.txHash}`);

// Send Telegram notification for copy-sell
const ourTrade = this.tradeBase.getTradeByToken(event.tokenAddress);
const ourPnl = ourTrade ? ((event.price - ourTrade.entry_price) / ourTrade.entry_price) * 100 : 0;

await this.telegram.notifyExitTrailingStop(
event.tokenAddress,
event.tokenSymbol || 'UNKNOWN',
ourPnl,
event.solAmount,
sellResult.txHash!,
`Copy-Sell (Follow Whale ${exitType})`
);
} else {
logger.error(`[Trade] COPY-SELL FAILED: ${sellResult.error}`);
await this.telegram.notifySellFailed(event.tokenAddress, sellResult.error || 'Unknown error');
}

} catch (error) {
const errMsg = error instanceof Error ? error.message : String(error);
logger.error(`[Trade] Error during copy-sell: ${errMsg}`);
}
});

// WIRING 3: PriceMonitor on trailing_stop_hit -> TradeEngine.sell(100)
this.priceMonitor.on('trailing_stop_hit', async (event: any) => {
logger.info(`[Event] TRAILING STOP HIT: ${event.tokenAddress.substring(0, 12)}...`);
logger.info(`        Highest: ${event.highestPrice.toFixed(9)} SOL`);
logger.info(`        Exit: ${event.exitPrice.toFixed(9)} SOL`);
logger.info(`        Profit: ${event.profitPercent.toFixed(2)}%`);

try {
// Sell 100% (dump all)
const sellResult = await this.tradeEngine.sell(event.tokenAddress, 100);

if (sellResult.success) {
logger.info(`[Trade] TRAILING SELL SUCCESS: ${sellResult.txHash}`);

// Send Telegram notification
await this.telegram.notifyExitTrailingStop(
event.tokenAddress,
'UNKNOWN', // Symbol not available in event, bisa di-lookup
event.profitPercent,
event.exitPrice,
sellResult.txHash!,
'Trailing Stop'
);
} else {
logger.error(`[Trade] TRAILING SELL FAILED: ${sellResult.error}`);

// Send Telegram alert for failed sell
await this.telegram.notifySellFailed(event.tokenAddress, sellResult.error || 'Unknown error');
}

} catch (error) {
const errMsg = error instanceof Error ? error.message : String(error);
logger.error(`[Trade] Error during trailing sell: ${errMsg}`);
}
});

// BONUS: PriceMonitor on emergency_exit -> Sell immediately
this.priceMonitor.on('emergency_exit', async (event: any) => {
logger.warn(`[Event] EMERGENCY EXIT: ${event.tokenAddress.substring(0, 12)}...`);
logger.warn(`        Loss: ${event.lossPercent.toFixed(2)}%`);

try {
// Sell 100% immediately (stop loss hit)
const sellResult = await this.tradeEngine.sell(event.tokenAddress, 100);

if (sellResult.success) {
logger.info(`[Trade] EMERGENCY SELL SUCCESS: ${sellResult.txHash}`);

// Send Telegram notification for emergency exit (cutloss)
await this.telegram.notifyExitTrailingStop(
event.tokenAddress,
'UNKNOWN',
event.lossPercent * -1, // Convert to negative for cutloss
0, // Amount not available in event
sellResult.txHash!,
'Emergency Exit (Cutloss)'
);
} else {
logger.error(`[Trade] EMERGENCY SELL FAILED: ${sellResult.error}`);
}

} catch (error) {
const errMsg = error instanceof Error ? error.message : String(error);
logger.error(`[Trade] Error during emergency sell: ${errMsg}`);
}
});
}

/**
* Start dashboard display
*/
private startDashboard(): void {
logger.info('[Dashboard] Starting dashboard...');

// Update dashboard every DASHBOARD_INTERVAL_MS
this.dashboardInterval = setInterval(async () => {
await this.showDashboard();
}, CONFIG.DASHBOARD_INTERVAL_MS);

// Show initial dashboard
this.showDashboard();
}

/**
* Display dashboard stats with SOL balance and holdings
*/
private async showDashboard(): Promise<void> {
try {
const activeInangs = this.inangBase.getInangStats().active;
const openTrades = this.tradeBase.getOpenTradesCount();
const todayPnL = this.tradeBase.getTodayPnL();
const trackedTokens = this.priceMonitor.getTrackedCount();
const walletAddress = this.tradeEngine.getPublicKey().substring(0, 12);

// Get SOL balance
let solBalance = 0;
try {
solBalance = await this.tradeEngine.getBalance();
} catch (e) {
// Ignore balance errors, show 0
}

// Get holdings (open trades)
const holdings = this.tradeBase.getOpenTrades();

console.log('');
console.log('╔══════════════════════════════════════════════════╗');
console.log('║           INSECTPUMP BOT DASHBOARD               ║');
console.log('╠══════════════════════════════════════════════════╣');
console.log(`║  Wallet:     ${walletAddress.padEnd(38)}... ║`);
console.log(`║  SOL Balance: ${solBalance.toFixed(4).padStart(10)} SOL${' '.repeat(21)}║`);
console.log(`║  Inangs:     ${String(activeInangs).padStart(3)} active${' '.repeat(29)}║`);
console.log(`║  Trades:     ${String(openTrades).padStart(3)} open positions${' '.repeat(21)}║`);
console.log(`║  Tracking:   ${String(trackedTokens).padStart(3)} tokens${' '.repeat(27)}║`);
console.log(`║  Today PnL:   ${(todayPnL >= 0 ? '+' : '') + todayPnL.toFixed(4)}%${' '.repeat(28)}║`);

// Show holdings if any
if (holdings.length > 0) {
console.log('╠══════════════════════════════════════════════════╣');
console.log('║              CURRENT HOLDINGS                    ║');
console.log('╠══════════════════════════════════════════════════╣');

holdings.slice(0, 5).forEach((trade, idx) => {
const symbol = trade.token_symbol.padEnd(8).substring(0, 8);
const entry = trade.entry_price.toFixed(6).padStart(10);
const trailing = trade.is_trailing_active ? '🟢' : '⏸️';
console.log(`║  ${String(idx + 1).padStart(2)}. ${symbol} @ ${entry} SOL ${trailing}${' '.repeat(8)}║`);
});

if (holdings.length > 5) {
console.log(`║      ... and ${holdings.length - 5} more${' '.repeat(29)}║`);
}
}

console.log('╚══════════════════════════════════════════════════╝');
console.log('');

} catch (error) {
// Dashboard errors shouldn't crash the bot
}
}

/**
* Sync open trades from TradeBase to PriceMonitor
* Called on startup to resume tracking for positions that were open before restart
*/
private async syncOpenTradesToPriceMonitor(): Promise<void> {
try {
const openTrades = this.tradeBase.getOpenTrades();

if (openTrades.length === 0) {
logger.info('[Main] No open trades to sync - starting fresh');
return;
}

logger.info(`[Main] Syncing ${openTrades.length} open trades to PriceMonitor...`);

for (const trade of openTrades) {
try {
// Get current price for this token to update highest price
await this.priceMonitor.startTracking(trade.token_address, trade.entry_price);

// Also sync highest_price from database
if (trade.highest_price > trade.entry_price) {
this.tradeBase.updateHighestPriceByToken(trade.token_address, trade.highest_price);
logger.info(`[Main]   ↳ ${trade.token_symbol}: entry=${trade.entry_price.toFixed(9)}, highest=${trade.highest_price.toFixed(9)}, trailing=${trade.is_trailing_active ? 'ON' : 'OFF'}`);
} else {
logger.info(`[Main]   ↳ ${trade.token_symbol}: entry=${trade.entry_price.toFixed(9)} (no price update yet)`);
}
} catch (err) {
logger.error(`[Main] Failed to sync trade ${trade.token_symbol}: ${err}`);
}
}

logger.info(`[Main] Sync complete - PriceMonitor now tracking ${openTrades.length} tokens`);
} catch (error) {
logger.error(`[Main] Error syncing open trades: ${error}`);
}
}

/**
* Start rate limit cache cleanup interval
* Removes entries older than DUPLICATE_BUY_WINDOW_MS to prevent memory leaks
*/
private startRateLimitCleanup(): void {
this.rateLimitCleanupInterval = setInterval(() => {
const now = Date.now();
let cleaned = 0;
let extendedCleaned = 0;

// Use forEach for ES5 compatibility
this.recentBuyCache.forEach((timestamp, token) => {
if ((now - timestamp) > this.DUPLICATE_BUY_WINDOW_MS) {
this.recentBuyCache.delete(token);
cleaned++;
}
});

// Clean extended buy block entries
this.extendedBuyBlock.forEach((block, token) => {
if (now > block.until) {
this.extendedBuyBlock.delete(token);
extendedCleaned++;
}
});

if (cleaned > 0 || extendedCleaned > 0) {
logger.info(`[RateLimit] Cache cleanup: ${cleaned} rate-limit entries, ${extendedCleaned} extended blocks removed`);
}
}, CONFIG.CACHE_CLEANUP_INTERVAL_MS);
}

/**
* Start inang entries cleanup interval
* Prevents memory leak from tracking inang entry prices
*/
private startInangEntriesCleanup(): void {
setInterval(() => {
this.inangMonitor.cleanupOldEntries();
const stats = this.inangMonitor.getEntryStats();
logger.info(`[InangEntries] Cleanup done. Active entries: ${stats.total}`);
}, 6 * 60 * 60 * 1000); // Run every 6 hours
}

/**
* Graceful shutdown
*/
async gracefulShutdown(): Promise<void> {
logger.info('\n[Main] Graceful shutdown initiated...');

try {
// Stop dashboard
if (this.dashboardInterval) {
clearInterval(this.dashboardInterval);
}

// Stop rate limit cleanup
if (this.rateLimitCleanupInterval) {
clearInterval(this.rateLimitCleanupInterval);
logger.info('[RateLimit] Cleanup interval stopped');
}

// Stop all components
this.eye.stop();
this.inangMonitor.stop();
this.priceMonitor.stop();
this.inangBase.close();
await closeDatabase();

logger.info('[Main] Shutdown complete. Goodbye!');
process.exit(0);

} catch (error) {
const errMsg = error instanceof Error ? error.message : String(error);
logger.error(`[Main] Error during shutdown: ${errMsg}`);
process.exit(1);
}
}
}

/**
* Entry point
*/
async function main(): Promise<void> {
const bot = new InsectPumpBot();
await bot.start();
}

// Run main
main().catch((error) => {
console.error('Unhandled error:', error);
process.exit(1);
});

