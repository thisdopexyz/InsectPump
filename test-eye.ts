/**
 * Test script untuk Eye (Pumping Token Detection)
 * Run: npx ts-node test-eye.ts
 * 
 * Features:
 * - Track NEW tokens (create event)
 * - Track PUMPING tokens (>10% growth detection)
 * - Track ALL tokens in history with mcap data
 * - Real-time stats every 30 seconds
 */
import { Eye } from './src/discovery/eye';
import { logger } from './src/utils/logger';
import { CONFIG } from './src/config/config';

// Token tracking data structures
interface TokenData {
  mint: string;
  firstSeen: number;
  lastMcap: number;
  mcapHistory: {mcap: number; ts: number}[];
  isPumping: boolean;
  pumpingDetectedAt?: number;
  growthPercent?: number;
  source: 'create' | 'pumping' | 'both';
}

const allTokens = new Map<string, TokenData>();
const pumpingTokens = new Set<string>();
const newTokens = new Set<string>();

async function testEye() {
  logger.info('========================================');
  logger.info('=== TEST EYE - FULL PUMPING TRACKER ===');
  logger.info('========================================');
  logger.info('Tracking: NEW tokens + PUMPING tokens');
  logger.info('');
  
  const eye = new Eye();
  
  // Track inang (whales)
  let inangCount = 0;
  eye.on('inang_added', (event) => {
    inangCount++;
    logger.info('');
    logger.info(`🎯 INANG #${inangCount} FOUND: ${event.trader.slice(0, 16)}...`);
    logger.info(`   Winrate: ${event.data?.winrate}% | PnL: ${event.data?.total_pnl} SOL`);
    logger.info(`   Swaps: ${event.data?.swapCount} | Trades: ${event.data?.completedTrades}`);
    logger.info('');
  });
  
  // Hook into Eye's logging by intercepting stdout
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  let buffer = '';
  
  process.stdout.write = (chunk: any, encoding?: any, callback?: any) => {
    const str = chunk.toString();
    buffer += str;
    
    // Process complete lines
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';  // Keep incomplete line in buffer
    
    for (const line of lines) {
      // Parse NEW token (handle truncated mint with ...)
      const newMatch = line.match(/🆕 New token: ([\w]+)\.\.\..*Mcap: ([\d\.]+) SOL.*sniper/);
      if (newMatch) {
        const mintShort = newMatch[1];
        const mcap = parseFloat(newMatch[2]);
        const mint = mintShort;
        allTokens.set(mint, {
          mint,
          firstSeen: Date.now(),
          lastMcap: mcap,
          mcapHistory: [{mcap, ts: Date.now()}],
          isPumping: false,
          source: 'create'
        });
        newTokens.add(mint);
        // Write tracker log directly to avoid recursion
        originalStdoutWrite.call(process.stdout, `[TRACKER] 🆕 NEW TOKEN: ${mint.slice(0, 12)}... @ ${mcap.toFixed(1)} SOL\n`);
      }
      
      // Parse PUMPING DETECTED (handle truncated mint)
      const pumpingMatch = line.match(/🚀 PUMPING DETECTED: ([\w]+)\.\.\..*Growth: \+([\d\.]+)%/);
      if (pumpingMatch) {
        const mint = pumpingMatch[1];
        const growth = parseFloat(pumpingMatch[2]);
        
        const existing = allTokens.get(mint);
        if (existing) {
          existing.isPumping = true;
          existing.pumpingDetectedAt = Date.now();
          existing.growthPercent = growth;
          if (existing.source === 'create') {
            existing.source = 'both';
          }
        } else {
          allTokens.set(mint, {
            mint,
            firstSeen: Date.now(),
            lastMcap: 0,
            mcapHistory: [],
            isPumping: true,
            pumpingDetectedAt: Date.now(),
            growthPercent: growth,
            source: 'pumping'
          });
        }
        pumpingTokens.add(mint);
        originalStdoutWrite.call(process.stdout, `[TRACKER] 🚀 PUMPING: ${mint.slice(0, 12)}... +${growth.toFixed(1)}% growth\n`);
      }
      
      // Parse REPLACED token (handle truncated mint)
      const replacedMatch = line.match(/♻️ Replaced token: ([\w]+)\.\.\./);
      if (replacedMatch) {
        const mint = replacedMatch[1];
        newTokens.delete(mint);
      }
    }
    
    // Call original
    return originalStdoutWrite.call(process.stdout, chunk, encoding, callback);
  };
  
  // Init dan start
  await eye.init();
  await eye.start();
  
  logger.info('');
  logger.info('✅ Eye started successfully');
  logger.info(`📊 Config: ${CONFIG.EYE_PUMP_THRESHOLD_PERCENT}% threshold, 15s check interval`);
  logger.info(`📊 Max tracked: ${CONFIG.EYE_MAX_TRACKED_TOKENS} tokens`);
  logger.info('');
  
  // Detailed stats every 30 seconds
  const statusInterval = setInterval(() => {
    const now = Date.now();
    const isActive = eye.isActive();
    const processing = eye.getProcessingCount();
    
    logger.info('');
    logger.info('═══════════════════════════════════════════════════');
    logger.info(`📊 STATS @ ${new Date().toLocaleTimeString()}`);
    logger.info('═══════════════════════════════════════════════════');
    logger.info(`Eye Status: ${isActive ? '✅ ACTIVE' : '❌ INACTIVE'} | Processing: ${processing} wallets`);
    logger.info(`Total Tokens Seen: ${allTokens.size}`);
    logger.info(`Currently New (30s): ${newTokens.size}`);
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
          logger.info(`   ${mint.slice(0, 12)}... | +${t.growthPercent?.toFixed(1)}% | Age: ${age}s | Pumping for: ${pumpAge}s | Source: ${t.source}`);
        }
      });
    }
    
    // Show newest tokens
    if (newTokens.size > 0) {
      logger.info('');
      logger.info('🆕 NEWEST TOKENS (last 5):');
      const sorted = Array.from(newTokens)
        .map(m => allTokens.get(m))
        .filter(Boolean)
        .sort((a, b) => b!.firstSeen - a!.firstSeen)
        .slice(0, 5);
      
      sorted.forEach(t => {
        const age = Math.floor((now - t!.firstSeen) / 1000);
        logger.info(`   ${t!.mint.slice(0, 12)}... | ${t!.lastMcap.toFixed(1)} SOL | ${age}s ago`);
      });
    }
    
    logger.info('═══════════════════════════════════════════════════');
  }, 30000);
  
  // Graceful shutdown
  process.on('SIGINT', () => {
    logger.info('\n[TEST] Shutting down...');
    clearInterval(statusInterval);
    
    // Final summary
    logger.info('');
    logger.info('========================================');
    logger.info('=== FINAL SUMMARY ===');
    logger.info('========================================');
    logger.info(`Total unique tokens seen: ${allTokens.size}`);
    logger.info(`Pumping tokens detected: ${pumpingTokens.size}`);
    const createCount = Array.from(allTokens.values()).filter(t => t.source === 'create' || t.source === 'both').length;
    logger.info(`New tokens (create): ${createCount}`);
    logger.info(`Inang found: ${inangCount}`);
    
    eye.stop();
    process.exit(0);
  });
  
  // Keep alive
  await new Promise(() => {});
}

testEye().catch(err => {
  logger.error('Test failed:', err);
  process.exit(1);
});
