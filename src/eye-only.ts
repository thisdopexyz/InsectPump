/**
 * Eye Only Mode - Discovery/Scouter tanpa trading
 * Eye: New token hunting (WebSocket mode)
 * Hanya scan dan detect inang quality, simpan ke DB
 */

import 'dotenv/config';
import { CONFIG, validateConfig } from './config/config';
import { initDatabase, closeDatabase } from './database/sqlite';
import { InangBase } from './database/inangBase';
// Eye (new token) - ACTIVE
import { Eye } from './discovery/eye';
// EyeInsider moved to test/ for debugging
// import { EyeInsider } from './discovery/EyeInsider';
import { TelegramService } from './services/telegram';
import { createModuleLogger } from './utils/logger';

const logger = createModuleLogger('EyeOnly');

class EyeOnlyMode {
  private inangBase: InangBase;
  private eye: Eye;  // Active - new token hunting
  // private eyeInsider: EyeInsider;  // Disabled - moved to test/
  private telegram: TelegramService;

  constructor() {
    this.inangBase = new InangBase();
    this.eye = new Eye();  // Active
    // this.eyeInsider = new EyeInsider();  // Disabled
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
      this.eye.start();
      logger.info('[EyeOnly] 👁️ Eye ACTIVE - New token hunting...');
      logger.info('[EyeOnly] Press Ctrl+C to stop');

      // 5. Send startup notif
        await this.telegram.sendAlert(
        `🛰️ *EYE ONLY MODE ACTIVATED*\n\n` +
        `📡 Scanning: New tokens (WebSocket)\n` +
        `🎯 Strategy: Early insider detection\n` +
        `💾 Storage: SQLite (inangpump.db)\n` +
        `⏱️ Started: ${new Date().toISOString()}\n\n` +
        `_Waiting for insiders..._`
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
    // Handle inang dari Eye
    this.eye.on('inang', async (event: any) => {
      const inang = event;
      logger.info(`[EyeOnly] 🎯 INSIDER DETECTED: ${inang.trader?.slice(0, 12)}...`);
      logger.info(`[EyeOnly]    Token: ${inang.symbol} | Winrate: ${inang.winrate}% | PnL: ${inang.pnl} SOL`);

      // Save to DB via InangBase
      try {
        this.inangBase.addInang({
          address: inang.trader,
          total_tx: 0, // Not available in EyeInsider event
          winrate: inang.winrate || 0,
          total_pnl: inang.pnl || 0,
          status: 'active'
        });
        logger.info(`[EyeOnly]    Saved to database ✓`);

        // Telegram notif
        await this.telegram.sendAlert(
          `🎯 *NEW INSIDER DETECTED!*\n\n` +
          `👤 Trader: \`${inang.trader}\`\n` +
          `🪙 Token: ${inang.symbol} ($${(inang.mcap/1000).toFixed(1)}K)\n` +
          `📊 Winrate: *${inang.winrate?.toFixed(1) || 'N/A'}%*\n` +
          `💰 PnL: ${inang.pnl?.toFixed(4) || 'N/A'} SOL\n\n` +
          `_Mid-cap insider found_`
        );

      } catch (err) {
        logger.error(`[EyeOnly] Failed to save inang: ${err}`);
      }
    });
  }

  private async shutdown(): Promise<void> {
    logger.info('[EyeOnly] Shutting down gracefully...');
    
    await this.telegram.sendAlert(
      `🛑 *EYE ONLY STOPPED*\n\n` +
      `⏱️ Stopped: ${new Date().toISOString()}\n` +
      `_Insiders saved to database_`
    );

    this.eye.stop();
    await closeDatabase();
    process.exit(0);
  }
}

// Start
const mode = new EyeOnlyMode();
mode.start();
