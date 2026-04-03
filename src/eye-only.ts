/**
 * Eye Only Mode - Discovery/Scouter tanpa trading
 * Hanya scan dan detect inang quality, simpan ke DB
 */

import 'dotenv/config'; // Load .env first
import { CONFIG, validateConfig } from './config/config';
import { initDatabase, closeDatabase } from './database/sqlite';
import { InangBase } from './database/inangBase';
import { Eye } from './discovery/eye';
import { TelegramService } from './services/telegram';
import { createModuleLogger } from './utils/logger';

const logger = createModuleLogger('EyeOnly');

class EyeOnlyMode {
  private inangBase: InangBase;
  private eye: Eye;
  private telegram: TelegramService;

  constructor() {
    this.inangBase = new InangBase();
    this.eye = new Eye();
    this.telegram = new TelegramService();
  }

  async start(): Promise<void> {
    logger.info('╔══════════════════════════════════════════════════╗');
    logger.info('║      InsectPump - EYE ONLY (Discovery Mode)      ║');
    logger.info('╠══════════════════════════════════════════════════╣');
    logger.info('║  Mode: Scouter/Discovery (No Trading)            ║');
    logger.info('║  Filters: L1(MCap) → L1.5(Identity) → L2(TX)     ║');
    logger.info('║           → L3(Activity) → L4(Winrate+Quality)   ║');
    logger.info('╚══════════════════════════════════════════════════╝');

    try {
      // 1. Validate config
      validateConfig();
      logger.info('[EyeOnly] Configuration validated');

      // 2. Init DB
      await initDatabase();
      logger.info('[EyeOnly] Database initialized');

      // 3. Setup Eye event handler
      this.setupEyeHandlers();

      // 4. Start Eye
      await this.eye.init();
      await this.eye.start();
      logger.info('[EyeOnly] 🎯 Eye radar ACTIVE - Scanning Pump.fun...');
      logger.info('[EyeOnly] Press Ctrl+C to stop');

      // 5. Send startup notif
        await this.telegram.sendAlert(
        `🛰️ *EYE ONLY MODE ACTIVATED*\n\n` +
        `📡 Scanning: Pump.fun global trades\n` +
        `🎯 Filters: 4-Layer (L1→L4)\n` +
        `💾 Storage: SQLite (inangpump.db)\n` +
        `⏱️ Started: ${new Date().toISOString()}\n\n` +
        `_Waiting for quality inang..._`
      );

      // 6. Graceful shutdown
      process.on('SIGINT', () => this.shutdown());
      process.on('SIGTERM', () => this.shutdown());

    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[EyeOnly] Fatal error: ${errMsg}`);
      process.exit(1);
    }
  }

  private setupEyeHandlers(): void {
    // Handle inang yang lolos semua filter
    this.eye.on('inang_added', async (event: any) => {
      const inang = event.data;
      logger.info(`[EyeOnly] ✅ NEW INANG DETECTED: ${inang.address?.slice(0, 12)}...`);
      logger.info(`[EyeOnly]    Winrate: ${inang.winrate}% | Trades: ${inang.totalTrades} | PnL: ${inang.totalPnl} SOL`);

      // Save to DB via InangBase
      try {
        this.inangBase.addInang({
          address: inang.address,
          total_tx: inang.totalTx || 0,
          winrate: inang.winrate || 0,
          total_pnl: inang.totalPnl || 0,
          status: 'active'
        });
        logger.info(`[EyeOnly]    Saved to database ✓`);

        // Telegram notif
        await this.telegram.sendAlert(
          `🎯 *NEW INANG DETECTED!*\n\n` +
          `👤 Address: \`${inang.address}\`\n` +
          `📊 Winrate: *${inang.winrate?.toFixed(1) || 'N/A'}%*\n` +
          `🔄 Trades: ${inang.totalTrades || 'N/A'}\n` +
          `💰 Total PnL: ${inang.totalPnl?.toFixed(4) || 'N/A'} SOL\n` +
          `📈 Avg PnL: ${inang.avgPnl?.toFixed(4) || 'N/A'} SOL\n\n` +
          `_Passed all 4 filters (L1→L4)_`
        );

      } catch (err) {
        logger.error(`[EyeOnly] Failed to save inang: ${err}`);
      }
    });

    // Handle inang yang rejected (untuk logging)
    this.eye.on('filter_failed', (data: any) => {
      logger.debug(`[EyeOnly] ❌ Filter failed at ${data.stage}: ${data.reason}`);
    });
  }

  private async shutdown(): Promise<void> {
    logger.info('[EyeOnly] Shutting down gracefully...');
    
    await this.telegram.sendAlert(
      `🛑 *EYE MODE STOPPED*\n\n` +
      `⏱️ Stopped: ${new Date().toISOString()}\n` +
      `_Inangs saved to database_`
    );

    await this.eye.stop();
    await closeDatabase();
    process.exit(0);
  }
}

// Start
const mode = new EyeOnlyMode();
mode.start();
