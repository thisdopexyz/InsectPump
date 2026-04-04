import axios from 'axios';
import { CONFIG } from '../config/config';
import { logger } from '../utils/logger';

interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled: boolean;
}

type CommandHandler = (command: string, args: string[]) => void;

export class TelegramService {
  private config: TelegramConfig;
  private baseUrl: string;
  private lastUpdateId: number = 0;
  private commandHandlers: Map<string, CommandHandler> = new Map();
  private pollingInterval: NodeJS.Timeout | null = null;

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
   * Register command handler
   * @param command - Command name without slash (e.g., 'wallet', 'stats')
   * @param handler - Function to call when command received
   */
  onCommand(command: string, handler: CommandHandler): void {
    this.commandHandlers.set(command.toLowerCase(), handler);
    logger.info(`[Telegram] Registered command handler: /${command}`);
  }

  /**
   * Start polling for incoming messages/commands
   * Call this after registering all command handlers
   */
  startCommandPolling(): void {
    if (!this.config.enabled) {
      logger.warn('[Telegram] Cannot start polling - bot not configured');
      return;
    }

    if (this.pollingInterval) {
      logger.warn('[Telegram] Polling already started');
      return;
    }

    logger.info('[Telegram] Starting command polling...');
    
    this.pollingInterval = setInterval(async () => {
      try {
        await this.pollUpdates();
      } catch (error) {
        logger.error(`[Telegram] Polling error: ${error}`);
      }
    }, 5000); // Check every 5 seconds
  }

  /**
   * Stop polling for commands
   */
  stopCommandPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logger.info('[Telegram] Command polling stopped');
    }
  }

  /**
   * Poll for new updates from Telegram
   */
  private async pollUpdates(): Promise<void> {
    try {
      const response = await axios.get(`${this.baseUrl}/getUpdates`, {
        params: {
          offset: this.lastUpdateId + 1,
          limit: CONFIG.TELEGRAM_POLL_LIMIT,
          timeout: 0
        }
      });

      if (!response.data.ok) {
        return;
      }

      const updates = response.data.result;
      
      for (const update of updates) {
        this.lastUpdateId = update.update_id;
        
        // Only process messages from configured chat
        if (!update.message || !update.message.text) continue;
        
        const chatId = update.message.chat?.id?.toString();
        if (chatId !== this.config.chatId) {
          logger.warn(`[Telegram] Ignoring message from unauthorized chat: ${chatId}`);
          continue;
        }

        const text = update.message.text.trim();
        
        // Parse command
        if (text.startsWith('/')) {
          const parts = text.substring(1).split(' ');
          const command = parts[0].toLowerCase();
          const args = parts.slice(1);
          
          logger.info(`[Telegram] Received command: /${command} from chat ${chatId}`);
          
          const handler = this.commandHandlers.get(command);
          if (handler) {
            handler(command, args);
          } else {
            // Unknown command - send help
            this.sendHelp();
          }
        }
      }
    } catch (error: any) {
      if (!error.message?.includes('timeout')) {
        logger.error(`[Telegram] Get updates error: ${error.message}`);
      }
    }
  }

  /**
   * Send help message with available commands
   */
  private async sendHelp(): Promise<void> {
    const commands = Array.from(this.commandHandlers.keys()).map(cmd => `/${cmd}`).join(', ');
    const message = 
      `ℹ️ *Available Commands*\n\n` +
      `${commands || 'No commands registered'}\n\n` +
      `Use any command above to get info.`
    ;
    await this.sendAlert(message);
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
   * Template: Manual sell detected (user sold via wallet)
   */
  async notifyManualSell(
    tokenAddress: string,
    tokenSymbol: string,
    pnlPercent: number
  ): Promise<boolean> {
    const emoji = pnlPercent >= 0 ? '🟢' : '🔴';
    const pnlSign = pnlPercent >= 0 ? '+' : '';

    const message = 
      `🔴 *MANUAL SELL TERDETEKSI*\n\n` +
      `🪙 Token: \`${tokenSymbol}\`\n` +
      `📍 Address: \`${tokenAddress.substring(0, 16)}...\`\n` +
      `${emoji} PnL: ${pnlSign}${pnlPercent.toFixed(2)}%\n\n` +
      `⚠️ Token dijual manual via wallet\n` +
      `✅ Database sudah di-update`
    ;

    return this.sendAlert(message);
  }

  /**
   * Template: Manual buy detected (user bought via wallet)
   */
  async notifyManualBuy(
    tokenAddress: string,
    tokenSymbol: string,
    balance: number
  ): Promise<boolean> {
    const message = 
      `🟢 *MANUAL BUY TERDETEKSI*\n\n` +
      `🪙 Token: \`${tokenSymbol}\`\n` +
      `📍 Address: \`${tokenAddress.substring(0, 16)}...\`\n` +
      `💰 Balance: ${balance.toFixed(6)}\n\n` +
      `👤 Token dibeli manual via wallet\n` +
      `✅ Ditambahkan ke monitoring`
    ;

    return this.sendAlert(message);
  }

  /**
   * Template: Wallet sync report on startup
   */
  async notifyWalletSync(
    resumed: number,
    soldManual: number,
    boughtManual: number
  ): Promise<boolean> {
    let message = 
      `🔄 *WALLET SYNC COMPLETE*\n\n` +
      `📊 Hasil validasi startup:\n`
    ;

    if (resumed > 0) {
      message += `✅ ${resumed} posisi resume tracking\n`;
    }
    if (soldManual > 0) {
      message += `🔴 ${soldManual} token terjual manual\n`;
    }
    if (boughtManual > 0) {
      message += `🟢 ${boughtManual} token baru (manual buy)\n`;
    }
    if (resumed === 0 && soldManual === 0 && boughtManual === 0) {
      message += `ℹ️ Tidak ada perubahan\n`;
    }

    message += `\n💡 Monitoring aktif untuk semua token.`;

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

  /**
   * Template: Wallet stats report (on-demand)
   * @param walletInfo - Wallet info from WalletManager
   * @param openTrades - List of open trades/holdings
   */
  async notifyWalletReport(
    walletInfo: {
      address: string;
      solBalance: number;
      tokenCount: number;
      trading?: {
        totalSpentSOL: number;
        lockedSOL: number;
        availableSOL: number;
        realizedPnLSOL: number;
        todayPnLSOL: number;
        totalTrades: number;
        openTrades: number;
        winRate: number;
      };
    },
    openTrades: Array<{
      token_symbol: string;
      entry_price: number;
      highest_price: number;
      is_trailing_active: number;
    }>
  ): Promise<boolean> {
    const t = walletInfo.trading;
    const pnlEmoji = (t?.realizedPnLSOL || 0) >= 0 ? '🟢' : '🔴';
    const todayEmoji = (t?.todayPnLSOL || 0) >= 0 ? '📈' : '📉';
    
    let message = 
      `💼 *WALLET REPORT*\n\n` +
      `👤 Address: \`${walletInfo.address.substring(0, 16)}...\`\n` +
      `💰 SOL Balance: ${walletInfo.solBalance.toFixed(4)} SOL\n` +
      `🪙 Token Holdings: ${walletInfo.tokenCount}\n\n`
    ;

    if (t && t.totalTrades > 0) {
      message +=
        `📊 *Trading Stats*\n` +
        `Total Spent: ${t.totalSpentSOL.toFixed(4)} SOL\n` +
        `Locked: ${t.lockedSOL.toFixed(4)} SOL | Available: ${t.availableSOL.toFixed(4)} SOL\n` +
        `${pnlEmoji} Realized PnL: ${t.realizedPnLSOL >= 0 ? '+' : ''}${t.realizedPnLSOL.toFixed(4)} SOL\n` +
        `${todayEmoji} Today PnL: ${t.todayPnLSOL >= 0 ? '+' : ''}${t.todayPnLSOL.toFixed(4)} SOL\n` +
        `Trades: ${t.totalTrades} total | ${t.openTrades} open\n` +
        `Win Rate: ${t.winRate.toFixed(1)}%\n\n`
      ;
    }

    // Show current holdings
    if (openTrades.length > 0) {
      message += `📋 *Current Holdings (${openTrades.length})*\n`;
      
      openTrades.slice(0, 10).forEach((trade, idx) => {
        const trailing = trade.is_trailing_active ? '🟢' : '⏸️';
        const symbol = trade.token_symbol || 'UNKNOWN';
        message += `${idx + 1}. \`${symbol}\` @ ${trade.entry_price.toFixed(6)} ${trailing}\n`;
      });
      
      if (openTrades.length > 10) {
        message += `... and ${openTrades.length - 10} more\n`;
      }
    } else {
      message += `📋 *No open positions*\n`;
    }

    return this.sendAlert(message);
  }
}

// Export singleton instance
export const telegram = new TelegramService();
