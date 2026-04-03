import axios from 'axios';
import { CONFIG } from '../config/config';
import { logger } from '../utils/logger';

interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled: boolean;
}

export class TelegramService {
  private config: TelegramConfig;
  private baseUrl: string;

  constructor() {
    // Get Token and ChatID from CONFIG (which reads from .env)
    this.config = {
      botToken: CONFIG.TELEGRAM_BOT_TOKEN || '',
      chatId: CONFIG.TELEGRAM_CHAT_ID || '',
      enabled: !!(CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.TELEGRAM_CHAT_ID)
    };

    this.baseUrl = `https://api.telegram.org/bot${this.config.botToken}`;

    if (this.config.enabled) {
      logger.info(`[Telegram] Initialized with chat ID: ${this.config.chatId}`);
    } else {
      logger.warn('[Telegram] Bot not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env');
    }
  }

  /**
   * Send alert message to owner chat
   * @param message - Message text to send
   */
  async sendAlert(message: string): Promise<boolean> {
    if (!this.config.enabled) {
      logger.warn('[Telegram] Cannot send alert - bot not configured');
      return false;
    }

    try {
      const response = await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id: this.config.chatId,
        text: message,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });

      if (response.data.ok) {
        logger.info('[Telegram] Alert sent successfully');
        return true;
      } else {
        logger.error(`[Telegram] Failed to send alert: ${response.data.description}`);
        return false;
      }
    } catch (error: any) {
      logger.error(`[Telegram] Error sending alert: ${error.message}`);
      return false;
    }
  }

  // ==================== MESSAGE TEMPLATES ====================

  /**
   * Template: Inang baru ditemukan
   * @param inangAddress - Wallet address of the inang
   * @param winrate - Winrate percentage
   * @param totalPnl - Total PnL in SOL
   * @param totalTx - Total transactions
   */
  async notifyInangFound(
    inangAddress: string, 
    winrate: number, 
    totalPnl: number, 
    totalTx: number
  ): Promise<boolean> {
    const emoji = winrate >= 60 ? '🎯' : winrate >= 40 ? '⚠️' : '❓';
    const pnlEmoji = totalPnl >= 0 ? '🟢' : '🔴';
    const pnlSign = totalPnl >= 0 ? '+' : '';

    const message = 
      `${emoji} *INANG BARU DITEMUKAN*\n\n` +
      `👤 Address: \`${inangAddress.substring(0, 16)}...\`\n` +
      `📊 Winrate: ${winrate.toFixed(1)}%\n` +
      `${pnlEmoji} Total PnL: ${pnlSign}${totalPnl.toFixed(4)} SOL\n` +
      `🔄 Total Tx: ${totalTx}\n\n` +
      `✅ *Ditambahkan ke watchlist*`
    ;

    return this.sendAlert(message);
  }

  /**
   * Template: Berhasil mengikuti (copy-buy) Inang
   * @param tokenAddress - Token mint address
   * @param tokenSymbol - Token symbol
   * @param amountSol - Amount spent in SOL
   * @param inangAddress - Inang that triggered the buy
   * @param txHash - Transaction hash
   */
  async notifyCopyBuySuccess(
    tokenAddress: string,
    tokenSymbol: string,
    amountSol: number,
    inangAddress: string,
    txHash: string
  ): Promise<boolean> {
    const message = 
      `🟢 *BERHASIL COPY-BUY INANG*\n\n` +
      `🪙 Token: \`${tokenSymbol}\`\n` +
      `📍 Address: \`${tokenAddress.substring(0, 16)}...\`\n` +
      `💰 Amount: ${amountSol.toFixed(4)} SOL\n` +
      `👤 Inang: \`${inangAddress.substring(0, 12)}...\`\n\n` +
      `🔗 Tx: [${txHash.substring(0, 12)}...](https://solscan.io/tx/${txHash})\n\n` +
      `📈 *Posisi terbuka - Monitoring aktif*`
    ;

    return this.sendAlert(message);
  }

  /**
   * Template: Berhasil menjual (exit) karena Trailing Stop
   * @param tokenAddress - Token mint address
   * @param tokenSymbol - Token symbol
   * @param pnlPercent - PnL percentage
   * @param amountSol - Amount received from sell
   * @param txHash - Transaction hash
   * @param reason - Exit reason (trailing stop, cutloss, etc.)
   */
  async notifyExitTrailingStop(
    tokenAddress: string,
    tokenSymbol: string,
    pnlPercent: number,
    amountSol: number,
    txHash: string,
    reason: string = 'Trailing Stop'
  ): Promise<boolean> {
    const emoji = pnlPercent >= 0 ? '📈' : '📉';
    const pnlEmoji = pnlPercent >= 0 ? '🟢' : '🔴';
    const pnlSign = pnlPercent >= 0 ? '+' : '';

    const message = 
      `${emoji} *BERHASIL EXIT - ${reason.toUpperCase()}*\n\n` +
      `🪙 Token: \`${tokenSymbol}\`\n` +
      `📍 Address: \`${tokenAddress.substring(0, 16)}...\`\n` +
      `💰 Received: ${amountSol.toFixed(4)} SOL\n` +
      `${pnlEmoji} PnL: ${pnlSign}${pnlPercent.toFixed(2)}%\n` +
      `🎯 Reason: ${reason}\n\n` +
      `🔗 Tx: [${txHash.substring(0, 12)}...](https://solscan.io/tx/${txHash})\n\n` +
      (pnlPercent >= 0 ? `✅ *Profit locked!*` : `⚠️ *Cutloss executed*`)
    ;

    return this.sendAlert(message);
  }

  /**
   * Template: Buy failed
   * @param tokenAddress - Token attempted to buy
   * @param error - Error message
   */
  async notifyBuyFailed(tokenAddress: string, error: string): Promise<boolean> {
    const message = 
      `🔴 *BUY GAGAL*\n\n` +
      `📍 Token: \`${tokenAddress.substring(0, 16)}...\`\n` +
      `❌ Error: ${error.substring(0, 100)}\n\n` +
      `⚠️ *Perlu diperiksa manual*`
    ;

    return this.sendAlert(message);
  }

  /**
   * Template: Sell failed
   * @param tokenAddress - Token attempted to sell
   * @param error - Error message
   */
  async notifySellFailed(tokenAddress: string, error: string): Promise<boolean> {
    const message = 
      `🔴 *SELL GAGAL*\n\n` +
      `📍 Token: \`${tokenAddress.substring(0, 16)}...\`\n` +
      `❌ Error: ${error.substring(0, 100)}\n\n` +
      `⚠️ *Perlu diperiksa manual segera!*`
    ;

    return this.sendAlert(message);
  }

  /**
   * Template: General notification
   * @param title - Notification title
   * @param content - Message content
   */
  async notify(title: string, content: string): Promise<boolean> {
    const message = 
      `🔔 *${title}*\n\n` +
      `${content}`
    ;

    return this.sendAlert(message);
  }

  /**
   * Check if telegram is configured
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get chat ID
   */
  getChatId(): string {
    return this.config.chatId;
  }
}

// Export singleton instance
export const telegram = new TelegramService();
