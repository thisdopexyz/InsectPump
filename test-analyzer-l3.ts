/**
 * Test Analyzer L3 (Merged L3+L4 with Helius type=SWAP)
 * Run: npx ts-node test-analyzer-l3.ts
 */
import { Analyzer } from './src/discovery/analyzer';
import { logger } from './src/utils/logger';
import { CONFIG } from './src/config/config';

// Test wallet - known good trader (contoh, ganti dengan wallet real)
const TEST_WALLETS = [
  // Contoh wallet untuk test - bisa ganti dengan wallet CT yang known profitable
  '7ZDbEJzE5J6E4yE1B8Z1v5G6mM9xK3nL2wQ8rT4yU6iO2pA9sD5fG7hJ3kL8zX4cV6bN9mK3pQ7wE2rT8yU4iO6pA2sD5f',
];

async function testAnalyzerL3() {
  logger.info('=== TEST ANALYZER L3 (Helius type=SWAP) ===');
  logger.info('Testing merged L3+L4 with real Helius API...\n');
  
  const analyzer = new Analyzer(CONFIG.HELIUS_RPC_URL, CONFIG.ALCHEMY_RPC_URL);
  
  // Test dengan dummy wallet (akan fail tapi kita lihat flow-nya)
  // atau kita bisa test dengan wallet real kalau ada
  
  logger.info('Testing L2 (Alchemy - FREE)...');
  const l2Result = await analyzer.checkTransactionCountAlchemy(TEST_WALLETS[0]);
  logger.info(`L2 Result: ${l2Result.passed ? '✅ PASS' : '❌ FAIL'} - ${l2Result.reason || 'OK'}`);
  logger.info(`  TX Count: ${l2Result.data?.txCount}\n`);
  
  if (l2Result.passed) {
    logger.info('Testing L3 (Helius type=SWAP - 1 credit)...');
    const l3Result = await analyzer.analyzeTradingActivityAndPnl(TEST_WALLETS[0]);
    logger.info(`L3 Result: ${l3Result.passed ? '✅ PASS' : '❌ FAIL'} - ${l3Result.reason || 'OK'}`);
    logger.info(`  Swap Count: ${l3Result.data?.swapCount}`);
    logger.info(`  Completed Trades: ${l3Result.data?.completedTrades}`);
    logger.info(`  Winrate: ${l3Result.data?.winrate}%`);
    logger.info(`  Total PnL: ${l3Result.data?.totalPnl} SOL`);
    logger.info(`  Credits Used: ${l3Result.data?.creditsUsed}\n`);
  }
  
  // Test full flow
  logger.info('Testing FULL ANALYZE WALLET flow...');
  const fullResult = await analyzer.analyzeWallet(TEST_WALLETS[0]);
  logger.info(`Full Result: ${fullResult.passedAll ? '✅ ALL PASS' : '❌ FAILED'}`);
  logger.info(`  Total Credits: ${fullResult.creditsUsed}`);
  logger.info(`  Stage 2: ${fullResult.stage2.passed ? '✅' : '❌'} ${fullResult.stage2.reason || ''}`);
  logger.info(`  Stage 3: ${fullResult.stage3.passed ? '✅' : '❌'} ${fullResult.stage3.reason || ''}`);
  
  logger.info('\n=== TEST COMPLETE ===');
}

testAnalyzerL3().catch(err => {
  logger.error('Test failed:', err);
  process.exit(1);
});
