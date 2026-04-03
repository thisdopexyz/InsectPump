/**
 * Test script untuk EyeUniversal (Universal Pumping Token Radar)
 * Run: npx ts-node test-eye-universal.ts
 * 
 * Features:
 * - Track BUY trades only (mcap >=60 SOL, buy >=0.3 SOL)
 * - 30-detik tracking window, >10% = pumping
 * - FIFO 100 token queue
 * - Real-time stats setiap 30 detik
 */
import { EyeUniversal } from './src/discovery/eye-universal';
import { logger } from './src/utils/logger';

// Token tracking data structures
interface TokenData {
  mint: string;
  firstSeen: number;
  lastMcap: number;
  buyVolume: number;
  buyCount: number;
  isPumping: boolean;
  pumpingDetectedAt?: number;
  growthPercent?: number;
}

const allTokens = new Map<string, TokenData>();
const pumpingTokens = new Set<string>();
const activeTokens = new Set<string>();

async function testEyeUniversal() {
  logger.info('========================================');
  logger.info('=== EYE UNIVERSAL - PUMPING RADAR ===');
  logger.info('========================================');
  logger.info('Filters: mcap >=60 SOL, buy >=0.3 SOL');
  logger.info('Window: 30s, Threshold: >10%, Queue: 100 FIFO');
  logger.info('');
  
  const eye = new EyeUniversal();
  
  // Track pumping events
  eye.on('pumping', (event) => {
    const mint = event.mint;
    
    const existing = allTokens.get(mint);
    if (existing) {
      existing.isPumping = true;
      existing.pumpingDetectedAt = Date.now();
      existing.growthPercent = event.growth;
      existing.lastMcap = event.currentMcap;
    } else {
      allTokens.set(mint, {
        mint,
        firstSeen: Date.now(),
        lastMcap: event.currentMcap,
        buyVolume: event.buyVolume,
        buyCount: event.buyCount,
        isPumping: true,
        pumpingDetectedAt: Date.now(),
        growthPercent: event.growth
      });
    }
    
    pumpingTokens.add(mint);
    activeTokens.add(mint);
    
    logger.info('');
    logger.info(`[ALERT] 🚀 PUMPING DETECTED!`);
    logger.info(`[ALERT]    Token: ${mint.slice(0, 16)}...`);
    logger.info(`[ALERT]    Growth: +${event.growth.toFixed(1)}%`);
    logger.info(`[ALERT]    Mcap: ${event.initialMcap.toFixed(1)} → ${event.currentMcap.toFixed(1)} SOL`);
    logger.info(`[ALERT]    Buys: ${event.buyCount} | Volume: ${event.buyVolume.toFixed(2)} SOL`);
    logger.info(`[ALERT]    Wallets: ${event.walletCount} | Age: ${event.age}s`);
    logger.info('');
  });
  
  // Track inang (whales)
  let inangCount = 0;
  eye.on('inang_added', (event) => {
    inangCount++;
    logger.info('');
    logger.info(`[ALERT] 🎯 INANG #${inangCount} FOUND!`);
    logger.info(`[ALERT]    Wallet: ${event.trader.slice(0, 16)}...`);
    logger.info(`[ALERT]    Winrate: ${event.data?.winrate}% | PnL: ${event.data?.total_pnl?.toFixed(2)} SOL`);
    logger.info(`[ALERT]    Source: ${event.source} | Token: ${event.token?.slice(0, 12)}...`);
    logger.info('');
  });
  
  // Track new token added to queue
  eye.on('trade', (event) => {
    const mint = event.mint;
    
    if (!allTokens.has(mint)) {
      allTokens.set(mint, {
        mint,
        firstSeen: Date.now(),
        lastMcap: event.mcap,
        buyVolume: event.amount,
        buyCount: 1,
        isPumping: false
      });
      activeTokens.add(mint);
      logger.info(`[TRACKER] 🎯 NEW TOKEN QUEUED: ${mint.slice(0, 12)}... | Mcap: ${event.mcap.toFixed(1)} SOL | Buy: ${event.amount.toFixed(2)} SOL`);
    } else {
      const t = allTokens.get(mint)!;
      t.buyVolume += event.amount;
      t.buyCount++;
      t.lastMcap = event.mcap;
    }
  });
  
  // Hook into stdout for parsing EyeUniversal internal logs
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  let buffer = '';
  
  process.stdout.write = (chunk: any, encoding?: any, callback?: any) => {
    const str = chunk.toString();
    buffer += str;
    
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    for (const line of lines) {
      // Parse "New tracked token" log
      const newMatch = line.match(/🎯 New tracked token: ([\w]+)\.\.\..*Mcaps: ([\d\.]+) SOL/);
      if (newMatch) {
        const mint = newMatch[1];
        const mcap = parseFloat(newMatch[2]);
        originalStdoutWrite.call(process.stdout, `[TEST] 📥 Token queued: ${mint.slice(0, 12)}... @ ${mcap} SOL\n`);
      }
      
      // Parse "PUMPING DETECTED" log
      const pumpMatch = line.match(/🚀 PUMPING DETECTED: ([\w]+)\.\.\..*Growth: \+([\d\.]+)%/);
      if (pumpMatch) {
        const mint = pumpMatch[1];
        const growth = parseFloat(pumpMatch[2]);
        originalStdoutWrite.call(process.stdout, `[TEST] 🚀 PUMPING: ${mint.slice(0, 12)}... +${growth}%\n`);
      }
      
      // Parse "Replaced token" log
      const replaceMatch = line.match(/♻️ Replaced token: ([\w]+)/);
      if (replaceMatch) {
        const mint = replaceMatch[1];
        activeTokens.delete(mint);
        originalStdoutWrite.call(process.stdout, `[TEST] ♻️ Token replaced (oldest): ${mint.slice(0, 12)}...\n`);
      }
    }
    
    return originalStdoutWrite.call(process.stdout, chunk, encoding, callback);
  };
  
  // Init dan start
  await eye.init();
  eye.start();
  
  logger.info('');
  logger.info('✅ EyeUniversal started successfully');
  logger.info('');
  
  // Detailed stats every 30 seconds
  const statusInterval = setInterval(() => {
    const now = Date.now();
    const isActive = eye.isActive();
    const processing = eye.getProcessingCount();
    const tracked = eye.getTrackedTokensCount();
    
    logger.info('');
    logger.info('═══════════════════════════════════════════════════');
    logger.info(`📊 EYE UNIVERSAL STATS @ ${new Date().toLocaleTimeString()}`);
    logger.info('═══════════════════════════════════════════════════');
    logger.info(`Status: ${isActive ? '✅ ACTIVE' : '❌ INACTIVE'} | Processing: ${processing} wallets`);
    logger.info(`Tracked Tokens: ${tracked}/${100} (FIFO queue)`);
    logger.info(`Total Unique Seen: ${allTokens.size}`);
    logger.info(`Currently Pumping: ${pumpingTokens.size}`);
    logger.info(`Inang Found: ${inangCount}`);
    
    // Show pumping tokens detail
    if (pumpingTokens.size > 0) {
      logger.info('');
      logger.info('🚀 PUMPING TOKENS:');
      pumpingTokens.forEach(mint => {
        const t = allTokens.get(mint);
        if (t) {
          const age = Math.floor((now - t.firstSeen) / 1000);
          const pumpAge = t.pumpingDetectedAt ? Math.floor((now - t.pumpingDetectedAt) / 1000) : 0;
          logger.info(`   ${mint.slice(0, 12)}... | +${t.growthPercent?.toFixed(1)}% | Vol: ${t.buyVolume.toFixed(2)} SOL | Buys: ${t.buyCount} | Pumping for: ${pumpAge}s`);
        }
      });
    }
    
    // Show newest active tokens
    if (activeTokens.size > 0) {
      logger.info('');
      logger.info('🎯 NEWEST ACTIVE TOKENS (last 5):');
      const sorted = Array.from(activeTokens)
        .map(m => allTokens.get(m))
        .filter(Boolean)
        .sort((a, b) => b!.firstSeen - a!.firstSeen)
        .slice(0, 5);
      
      sorted.forEach(t => {
        const age = Math.floor((now - t!.firstSeen) / 1000);
        logger.info(`   ${t!.mint.slice(0, 12)}... | ${t!.lastMcap.toFixed(1)} SOL | Vol: ${t!.buyVolume.toFixed(2)} SOL | ${age}s ago`);
      });
    }
    
    logger.info('═══════════════════════════════════════════════════');
  }, 30000);
  
  // Graceful shutdown
  process.on('SIGINT', () => {
    logger.info('\n[TEST] Shutting down...');
    clearInterval(statusInterval);
    
    logger.info('');
    logger.info('========================================');
    logger.info('=== FINAL SUMMARY ===');
    logger.info('========================================');
    logger.info(`Total unique tokens seen: ${allTokens.size}`);
    logger.info(`Pumping tokens detected: ${pumpingTokens.size}`);
    logger.info(`Inang found: ${inangCount}`);
    
    eye.stop();
    process.exit(0);
  });
  
  // Keep alive
  await new Promise(() => {});
}

testEyeUniversal().catch(err => {
  logger.error('Test failed:', err);
  process.exit(1);
});
