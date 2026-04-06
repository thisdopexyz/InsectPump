import Database from 'better-sqlite3';
import path from 'path';
import { createModuleLogger } from '../utils/logger';
import { CONFIG } from '../config/config';

const logger = createModuleLogger('DB');

interface TradeData {
  token_address: string;
  token_symbol: string;
  inang_address: string;
  entry_price: number;
  buy_amount_sol: number;
  token_amount: number;
}

interface Trade extends TradeData {
  id: number;
  status: 'OPEN' | 'CLOSED';
  highest_price: number;
  is_trailing_active: number;
  pnl_percent: number;
  created_at: string;
  closed_at: string | null;
}

export class TradeBase {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath?: string) {
    // HARDCODED: Always use absolute path to avoid cwd issues
    this.dbPath = dbPath || '/home/ubuntu/InsectPump/data/insectpump.db';
    this.db = new Database(this.dbPath);
    this.init();
  }

  private init(): void {
    // Create table if not exists
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_address TEXT UNIQUE NOT NULL,
        token_symbol TEXT NOT NULL,
        inang_address TEXT NOT NULL,
        entry_price REAL NOT NULL,
        buy_amount_sol REAL NOT NULL,
        token_amount REAL NOT NULL,
        status TEXT DEFAULT 'OPEN' CHECK(status IN ('OPEN', 'CLOSED')),
        highest_price REAL DEFAULT 0,
        is_trailing_active INTEGER DEFAULT 0,
        pnl_percent REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        closed_at DATETIME
      )
    `;
    
    this.db.exec(createTableSQL);
    
    // Create indexes
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_trades_token ON trades(token_address)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_trades_inang ON trades(inang_address)');

    // Create copy_sells table to track whale cutloss exits we followed
    const createCopySellSQL = `
      CREATE TABLE IF NOT EXISTS copy_sells (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_address TEXT NOT NULL,
        whale_address TEXT NOT NULL,
        whale_pnl REAL NOT NULL,
        our_pnl REAL NOT NULL,
        exit_price REAL NOT NULL,
        tx_hash TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
    this.db.exec(createCopySellSQL);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_copy_sells_token ON copy_sells(token_address)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_copy_sells_whale ON copy_sells(whale_address)');
    
    logger.info('[TradeBase] Database initialized');
  }

  /**
   * Insert new trade when buying
   */
  public openTrade(data: TradeData): { success: boolean; id?: number; error?: string } {
    try {
      const insertSQL = `
        INSERT INTO trades (
          token_address, token_symbol, inang_address, entry_price, 
          buy_amount_sol, token_amount, status, highest_price, is_trailing_active, pnl_percent
        ) VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, 0, 0)
        ON CONFLICT(token_address) DO UPDATE SET
          token_symbol = excluded.token_symbol,
          inang_address = excluded.inang_address,
          entry_price = excluded.entry_price,
          buy_amount_sol = excluded.buy_amount_sol,
          token_amount = excluded.token_amount,
          highest_price = CASE WHEN excluded.entry_price > trades.highest_price 
                               THEN excluded.entry_price 
                               ELSE trades.highest_price END,
          status = 'OPEN',
          created_at = CURRENT_TIMESTAMP,
          closed_at = NULL
      `;
      
      // PRESERVE case - base58 addresses are case-sensitive! Never lowercase.
      const result = this.db.prepare(insertSQL).run(
        data.token_address,  // base58 - case sensitive
        data.token_symbol,
        data.inang_address,  // base58 - case sensitive
        data.entry_price,
        data.buy_amount_sol,
        data.token_amount,
        data.entry_price // highest_price initially = entry_price
      );
      
      logger.info(`[TradeBase] Opened trade: ${data.token_symbol} (${data.token_address.substring(0, 12)}...) - ${data.buy_amount_sol} SOL`);
      
      return { success: true, id: result.lastInsertRowid as number };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[TradeBase] Error opening trade: ${errMsg}`);
      return { success: false, error: errMsg };
    }
  }

  /**
   * Get all unsold (OPEN) trades
   */
  public getOpenTrades(): Trade[] {
    try {
      const rows = this.db.prepare("SELECT * FROM trades WHERE status = 'OPEN' ORDER BY created_at DESC").all();
      return rows.map((row: any) => this.mapRowToTrade(row));
    } catch (error) {
      logger.error(`[TradeBase] Error getting open trades: ${error}`);
      return [];
    }
  }

  /**
   * Get open trades count (for dashboard)
   */
  public getOpenTradesCount(): number {
    try {
      const result = this.db.prepare("SELECT COUNT(*) as count FROM trades WHERE status = 'OPEN'").get() as { count: number };
      return result.count;
    } catch (error) {
      logger.error(`[TradeBase] Error counting open trades: ${error}`);
      return 0;
    }
  }

  /**
   * Update highest price and auto-activate trailing stop if profit > threshold
   */
  public updateHighestPrice(id: number, price: number): { success: boolean; trailingActivated?: boolean; error?: string } {
    try {
      // Get current trade data
      const trade = this.db.prepare('SELECT entry_price, highest_price, is_trailing_active FROM trades WHERE id = ?').get(id) as 
        { entry_price: number; highest_price: number; is_trailing_active: number } | undefined;
      
      if (!trade) {
        return { success: false, error: 'Trade not found' };
      }

      // Only update if new price is higher
      if (price <= trade.highest_price) {
        return { success: true, trailingActivated: false };
      }

      // Calculate profit percentage
      const profitPercent = ((price - trade.entry_price) / trade.entry_price) * 100;
      const trailingThreshold = CONFIG.TRAILING_ACTIVATION_PERCENT;
      
      // Activate trailing stop if profit > threshold and not already active
      const shouldActivateTrailing = profitPercent > trailingThreshold && trade.is_trailing_active === 0;
      
      const updateSQL = `
        UPDATE trades 
        SET highest_price = ?, 
            is_trailing_active = CASE WHEN ? > ${trailingThreshold} AND is_trailing_active = 0 THEN 1 ELSE is_trailing_active END,
            pnl_percent = ?
        WHERE id = ?
      `;
      
      this.db.prepare(updateSQL).run(price, profitPercent, profitPercent, id);
      
      if (shouldActivateTrailing) {
        logger.info(`[TradeBase] Trailing stop ACTIVATED for trade ${id} (profit: ${profitPercent.toFixed(2)}%)`);
      }
      
      logger.info(`[TradeBase] Updated highest price for trade ${id}: ${price.toFixed(9)} SOL (PnL: ${profitPercent.toFixed(2)}%)`);
      
      return { success: true, trailingActivated: shouldActivateTrailing };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[TradeBase] Error updating highest price: ${errMsg}`);
      return { success: false, error: errMsg };
    }
  }

  /**
   * Update by token address (alternative to ID)
   */
  public updateHighestPriceByToken(tokenAddress: string, price: number): { success: boolean; trailingActivated?: boolean } {
    try {
      // PRESERVE case - base58 addresses are case-sensitive!
      const trade = this.db.prepare('SELECT id, entry_price, highest_price, is_trailing_active FROM trades WHERE token_address=? AND status = ?')
        .get(tokenAddress, 'OPEN') as { id: number; entry_price: number; highest_price: number; is_trailing_active: number } | undefined;
      
      if (!trade) {
        return { success: false };
      }

      return this.updateHighestPrice(trade.id, price);
    } catch (error) {
      logger.error(`[TradeBase] Error updating by token: ${error}`);
      return { success: false };
    }
  }

  /**
   * Close trade and record PnL
   */
  public closeTrade(id: number, pnlPercent: number): { success: boolean; error?: string } {
    try {
      const updateSQL = `
        UPDATE trades 
        SET status = 'CLOSED', 
            pnl_percent = ?, 
            closed_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'OPEN'
      `;
      
      const result = this.db.prepare(updateSQL).run(pnlPercent, id);
      
      if (result.changes === 0) {
        return { success: false, error: 'Trade not found or already closed' };
      }
      
      const pnlEmoji = pnlPercent >= 0 ? '🟢' : '🔴';
      logger.info(`[TradeBase] Closed trade ${id}: ${pnlEmoji} ${pnlPercent.toFixed(2)}% PnL`);
      
      return { success: true };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[TradeBase] Error closing trade: ${errMsg}`);
      return { success: false, error: errMsg };
    }
  }

  /**
   * Close trade by token address
   */
  public closeTradeByToken(tokenAddress: string, pnlPercent: number): { success: boolean; error?: string } {
    try {
      // PRESERVE case - base58 addresses are case-sensitive!
      
      const updateSQL = `
        UPDATE trades 
        SET status = 'CLOSED', 
            pnl_percent = ?, 
            closed_at = CURRENT_TIMESTAMP
        WHERE token_address=? AND status = 'OPEN'
      `;
      
      const result = this.db.prepare(updateSQL).run(pnlPercent, tokenAddress);
      
      if (result.changes === 0) {
        return { success: false, error: 'Trade not found or already closed' };
      }
      
      const pnlEmoji = pnlPercent >= 0 ? '🟢' : '🔴';
      logger.info(`[TradeBase] Closed trade for ${tokenAddress.substring(0, 12)}...: ${pnlEmoji} ${pnlPercent.toFixed(2)}% PnL`);
      
      return { success: true };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[TradeBase] Error closing trade by token: ${errMsg}`);
      return { success: false, error: errMsg };
    }
  }

  /**
   * Close trade manually (user sold via wallet)
   * Mark with special pnl code for manual sells
   */
  public closeTradeManual(tokenAddress: string, exitPrice: number): { success: boolean; error?: string; pnlPercent?: number } {
    try {
      // PRESERVE case - base58 addresses are case-sensitive!
      
      // Get trade info to calculate PnL
      const trade = this.getTradeByToken(tokenAddress);
      if (!trade) {
        return { success: false, error: 'Trade not found' };
      }
      
      // Calculate PnL
      const pnlPercent = ((exitPrice - trade.entry_price) / trade.entry_price) * 100;
      
      const updateSQL = `
        UPDATE trades 
        SET status = 'CLOSED', 
            pnl_percent = ?,
            closed_at = CURRENT_TIMESTAMP
        WHERE token_address=? AND status = 'OPEN'
      `;
      
      const result = this.db.prepare(updateSQL).run(pnlPercent, tokenAddress);
      
      if (result.changes === 0) {
        return { success: false, error: 'Trade not found or already closed' };
      }
      
      // SYNC: Also close in positions table
      this.closePosition(tokenAddress, pnlPercent, exitPrice, 'manual_sell');
      
      logger.info(`[TradeBase] Manual sell recorded for ${tokenAddress.substring(0, 12)}...: ${pnlPercent.toFixed(2)}% PnL`);
      
      return { success: true, pnlPercent };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[TradeBase] Error recording manual sell: ${errMsg}`);
      return { success: false, error: errMsg };
    }
  }

  /**
   * Add manual buy (user bought via wallet, not from bot)
   * Track for monitoring but marked as manual
   */
  public addManualBuy(tokenAddress: string, tokenSymbol: string, entryPrice: number, tokenAmount: number): { success: boolean; error?: string } {
    try {
      // PRESERVE case - base58 addresses are case-sensitive!
      
      // Check if already exists
      const existing = this.getTradeByToken(tokenAddress);
      if (existing) {
        return { success: false, error: 'Token already tracked' };
      }
      
      const insertSQL = `
        INSERT INTO trades (
          token_address, token_symbol, inang_address, entry_price, 
          buy_amount_sol, token_amount, status, highest_price, is_trailing_active
        ) VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, 0)
      `;
      
      // Calculate SOL spent estimate from entry price and amount
      const solSpent = entryPrice * tokenAmount;
      
      this.db.prepare(insertSQL).run(
        tokenAddress,
        tokenSymbol,
        'MANUAL_BUY', // Special marker for manual buys
        entryPrice,
        solSpent,
        tokenAmount,
        entryPrice // initial highest price
      );
      
      // SYNC: Also insert to positions table
      this.openPosition({
        token_mint: tokenAddress,
        token_symbol: tokenSymbol,
        inang_address: 'MANUAL_BUY',
        entry_price: entryPrice,
        amount_sol: solSpent,
        amount_tokens: tokenAmount,
      });
      
      logger.info(`[TradeBase] Manual buy recorded: ${tokenSymbol} @ ${entryPrice} SOL`);
      return { success: true };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[TradeBase] Error recording manual buy: ${errMsg}`);
      return { success: false, error: errMsg };
    }
  }

  /**
   * Get today's PnL (for dashboard)
   */
  public getTodayPnL(): number {
    try {
      const result = this.db.prepare(`
        SELECT SUM(pnl_percent) as total_pnl 
        FROM trades 
        WHERE status = 'CLOSED' 
        AND DATE(closed_at) = DATE('now')
      `).get() as { total_pnl: number } | undefined;
      
      return result?.total_pnl || 0;
    } catch (error) {
      logger.error(`[TradeBase] Error getting today PnL: ${error}`);
      return 0;
    }
  }

  /**
   * Get trade by token address
   */
  public getTradeByToken(tokenAddress: string): Trade | null {
    try {
      // PRESERVE case - base58 addresses are case-sensitive!
      const row = this.db.prepare('SELECT * FROM trades WHERE token_address=?').get(tokenAddress);
      return row ? this.mapRowToTrade(row) : null;
    } catch (error) {
      logger.error(`[TradeBase] Error getting trade: ${error}`);
      return null;
    }
  }

  /**
   * Get all trades (for stats)
   */
  public getAllTrades(): Trade[] {
    try {
      const rows = this.db.prepare('SELECT * FROM trades ORDER BY created_at DESC').all();
      return rows.map((row: any) => this.mapRowToTrade(row));
    } catch (error) {
      logger.error(`[TradeBase] Error getting all trades: ${error}`);
      return [];
    }
  }

  /**
   * Get trade statistics
   */
  public getStats(): { total: number; open: number; closed: number; avgPnl: number } {
    try {
      const total = this.db.prepare('SELECT COUNT(*) as count FROM trades').get() as { count: number };
      const open = this.db.prepare("SELECT COUNT(*) as count FROM trades WHERE status = 'OPEN'").get() as { count: number };
      const closed = this.db.prepare("SELECT COUNT(*) as count FROM trades WHERE status = 'CLOSED'").get() as { count: number };
      const avgPnl = this.db.prepare("SELECT AVG(pnl_percent) as avg FROM trades WHERE status = 'CLOSED'").get() as { avg: number };

      return {
        total: total.count,
        open: open.count,
        closed: closed.count,
        avgPnl: avgPnl.avg || 0
      };
    } catch (error) {
      logger.error(`[TradeBase] Error getting stats: ${error}`);
      return { total: 0, open: 0, closed: 0, avgPnl: 0 };
    }
  }

  /**
   * Get count of open positions (for concurrent position limit)
   */
  public getOpenPositionsCount(): number {
    try {
      const result = this.db.prepare("SELECT COUNT(*) as count FROM trades WHERE status = 'OPEN'").get() as { count: number };
      return result?.count || 0;
    } catch (error) {
      logger.error(`[TradeBase] Error getting open positions count: ${error}`);
      return 0;
    }
  }

  /**
   * Map database row to Trade object
   */
  private mapRowToTrade(row: any): Trade {
    return {
      id: row.id,
      token_address: row.token_address,
      token_symbol: row.token_symbol,
      inang_address: row.inang_address,
      entry_price: row.entry_price,
      buy_amount_sol: row.buy_amount_sol,
      token_amount: row.token_amount,
      status: row.status,
      highest_price: row.highest_price,
      is_trailing_active: row.is_trailing_active,
      pnl_percent: row.pnl_percent,
      created_at: row.created_at,
      closed_at: row.closed_at
    };
  }

  /**
   * Record a copy-sell (when we follow whale's cutloss)
   */
  public recordCopySell(
    tokenAddress: string, 
    data: {
      whale_address: string;
      whale_pnl: number;
      our_pnl: number;
      exit_price: number;
      tx_hash?: string;
      timestamp?: string;
    }
  ): { success: boolean; error?: string } {
    try {
      const insertSQL = `
        INSERT INTO copy_sells (
          token_address, whale_address, whale_pnl, our_pnl, exit_price, tx_hash, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `;
      
      // PRESERVE case - base58 addresses are case-sensitive!
      this.db.prepare(insertSQL).run(
        tokenAddress,  // base58 - case sensitive
        data.whale_address,  // base58 - case sensitive
        data.whale_pnl,
        data.our_pnl,
        data.exit_price,
        data.tx_hash || null,
        data.timestamp || new Date().toISOString()
      );
      
      logger.info(`[TradeBase] Recorded copy-sell for ${tokenAddress.substring(0, 12)}... (whale PnL: ${data.whale_pnl.toFixed(2)}%, our PnL: ${data.our_pnl.toFixed(2)}%)`);
      return { success: true };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[TradeBase] Error recording copy-sell: ${errMsg}`);
      return { success: false, error: errMsg };
    }
  }

  /**
   * Get position summary for dashboard
   */
  public getPositionSummary(): { totalPositions: number; inProfit: number; inLoss: number; avgPnl: number; bestPnl: number; worstPnl: number } {
    try {
      const openTrades = this.getOpenTrades();

      if (openTrades.length === 0) {
        return { totalPositions: 0, inProfit: 0, inLoss: 0, avgPnl: 0, bestPnl: 0, worstPnl: 0 };
      }

      let inProfit = 0;
      let inLoss = 0;
      let totalPnl = 0;
      let bestPnl = -Infinity;
      let worstPnl = Infinity;

      for (const trade of openTrades) {
        // Use highest_price as proxy for current (or could pass prices param)
        const pnl = ((trade.highest_price - trade.entry_price) / trade.entry_price) * 100;

        if (pnl > 0) inProfit++;
        else inLoss++;

        totalPnl += pnl;
        bestPnl = Math.max(bestPnl, pnl);
        worstPnl = Math.min(worstPnl, pnl);
      }

      return {
        totalPositions: openTrades.length,
        inProfit,
        inLoss,
        avgPnl: totalPnl / openTrades.length,
        bestPnl,
        worstPnl
      };
    } catch (error) {
      logger.error(`[TradeBase] Error getting position summary: ${error}`);
      return { totalPositions: 0, inProfit: 0, inLoss: 0, avgPnl: 0, bestPnl: 0, worstPnl: 0 };
    }
  }

  /**
   * Get today's trading statistics
   */
  public getTodayStats(): { totalTrades: number; wins: number; losses: number; pnlPercent: number } {
    try {
      const today = new Date().toISOString().split('T')[0];
      const result = this.db.prepare(`
        SELECT 
          COUNT(*) as total_trades,
          SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN pnl_percent <= 0 THEN 1 ELSE 0 END) as losses,
          AVG(pnl_percent) as avg_pnl
        FROM trades 
        WHERE DATE(created_at) = ? AND status = 'CLOSED'
      `).get(today) as { total_trades: number; wins: number; losses: number; avg_pnl: number } | undefined;

      return {
        totalTrades: result?.total_trades || 0,
        wins: result?.wins || 0,
        losses: result?.losses || 0,
        pnlPercent: result?.avg_pnl || 0
      };
    } catch (error) {
      logger.error(`[TradeBase] Error getting today's stats: ${error}`);
      return { totalTrades: 0, wins: 0, losses: 0, pnlPercent: 0 };
    }
  }

  /**
   * Get realized PnL in SOL (from closed trades)
   * Formula: buy_amount * (pnl_percent / 100)
   */
  public getRealizedPnLSOL(): number {
    try {
      const rows = this.db.prepare(`
        SELECT buy_amount_sol, pnl_percent FROM trades WHERE status = 'CLOSED'
      `).all() as Array<{ buy_amount_sol: number; pnl_percent: number }>;

      let totalPnL = 0;
      for (const row of rows) {
        totalPnL += row.buy_amount_sol * (row.pnl_percent / 100);
      }
      return totalPnL;
    } catch (error) {
      logger.error(`[TradeBase] Error getting realized PnL: ${error}`);
      return 0;
    }
  }

  /**
   * Get comprehensive trading stats for wallet display
   */
  public getTradingStats(): {
    totalSpent: number;
    locked: number;
    realizedPnL: number;
    todayPnL: number;
    totalTrades: number;
    openTrades: number;
    winRate: number;
  } {
    try {
      const stats = this.getStats();
      const totalSpent = this.getTotalSpentSOL();
      const locked = this.getLockedSOL();
      const realizedPnL = this.getRealizedPnLSOL();
      const todayPnLPercent = this.getTodayPnL();

      // Calculate today's PnL in SOL (estimate from buy_amount avg)
      const todayTrades = this.db.prepare(`
        SELECT buy_amount_sol, pnl_percent FROM trades
        WHERE status = 'CLOSED' AND DATE(closed_at) = DATE('now')
      `).all() as Array<{ buy_amount_sol: number; pnl_percent: number }>;

      let todayPnLSol = 0;
      for (const row of todayTrades) {
        todayPnLSol += row.buy_amount_sol * (row.pnl_percent / 100);
      }

      // Win rate calculation
      const wins = this.db.prepare(`
        SELECT COUNT(*) as count FROM trades WHERE status = 'CLOSED' AND pnl_percent > 0
      `).get() as { count: number };
      const winRate = stats.closed > 0 ? (wins.count / stats.closed) * 100 : 0;

      return {
        totalSpent,
        locked,
        realizedPnL,
        todayPnL: todayPnLSol,
        totalTrades: stats.total,
        openTrades: stats.open,
        winRate
      };
    } catch (error) {
      logger.error(`[TradeBase] Error getting trading stats: ${error}`);
      return {
        totalSpent: 0,
        locked: 0,
        realizedPnL: 0,
        todayPnL: 0,
        totalTrades: 0,
        openTrades: 0,
        winRate: 0
      };
    }
  }

  /**
   * Get total SOL spent on all trades (lifetime)
   */
  public getTotalSpentSOL(): number {
    try {
      const result = this.db.prepare(`
        SELECT SUM(buy_amount_sol) as total_spent FROM trades
      `).get() as { total_spent: number } | undefined;
      return result?.total_spent || 0;
    } catch (error) {
      logger.error(`[TradeBase] Error getting total spent SOL: ${error}`);
      return 0;
    }
  }

  /**
   * Get SOL locked in open positions
   */
  public getLockedSOL(): number {
    try {
      const result = this.db.prepare(`
        SELECT SUM(buy_amount_sol) as locked FROM trades WHERE status = 'OPEN'
      `).get() as { locked: number } | undefined;
      return result?.locked || 0;
    } catch (error) {
      logger.error(`[TradeBase] Error getting locked SOL: ${error}`);
      return 0;
    }
  }

  /**
   * Get copy-sell history (for analytics)
   */
  public getCopySellHistory(limit: number = 50): Array<{
    id: number;
    token_address: string;
    whale_address: string;
    whale_pnl: number;
    our_pnl: number;
    exit_price: number;
    tx_hash: string;
    timestamp: string;
  }> {
    try {
      const rows = this.db.prepare(
        'SELECT * FROM copy_sells ORDER BY timestamp DESC LIMIT ?'
      ).all(limit);
      return rows as any[];
    } catch (error) {
      logger.error(`[TradeBase] Error getting copy-sell history: ${error}`);
      return [];
    }
  }

  /**
   * Get open trades for a specific inang
   */
  public getOpenTradesForInang(inangAddress: string): Trade[] {
    try {
      // PRESERVE case - base58 addresses are case-sensitive!
      const rows = this.db.prepare('SELECT * FROM trades WHERE inang_address = *** AND status = ?').all(inangAddress, 'OPEN') as any[];
      return rows.map((row: any) => this.mapRowToTrade(row));
    } catch (error) {
      logger.error(`[TradeBase] Error getting open trades for inang: ${error}`);
      return [];
    }
  }

  /**
   * Get open trades with real-time PnL calculation
   * Returns trades sorted by current PnL (best to worst)
   */
  public getOpenTradesWithPnL(currentPrices: Map<string, number>): Array<Trade & { currentPnl: number; currentPrice: number }> {
    try {
      const openTrades = this.getAllTrades().filter(t => t.status === 'OPEN');
      const result: Array<Trade & { currentPnl: number; currentPrice: number }> = [];

      for (const trade of openTrades) {
        // PRESERVE case - base58 token addresses are case-sensitive!
        const currentPrice = currentPrices.get(trade.token_address) || trade.highest_price;
        const currentPnl = ((currentPrice - trade.entry_price) / trade.entry_price) * 100;

        result.push({
          ...trade,
          currentPnl,
          currentPrice
        });
      }

      // Sort by PnL (best first)
      return result.sort((a, b) => b.currentPnl - a.currentPnl);
    } catch (error) {
      logger.error(`[TradeBase] Error calculating PnL: ${error}`);
      return [];
    }
  }

  /**
   * Sync: Insert position to positions table (called on buy)
   */
  public openPosition(data: {
    token_mint: string;
    token_symbol: string;
    inang_address: string;
    entry_price: number;
    amount_sol: number;
    amount_tokens: number;
  }): void {
    try {
      const sql = `
        INSERT INTO positions (token_mint, token_symbol, entry_price, amount_tokens, amount_sol,
                              highest_price, trailing_stop_price, partial_sold, inang_address, status, opened_at)
        VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, 'OPEN', datetime('now'))
        ON CONFLICT(token_mint) DO UPDATE SET
          status = 'OPEN',
          closed_at = NULL,
          entry_price = excluded.entry_price,
          amount_sol = excluded.amount_sol,
          amount_tokens = excluded.amount_tokens,
          inang_address = excluded.inang_address
      `;
      this.db.prepare(sql).run(
        data.token_mint,
        data.token_symbol,
        data.entry_price,
        data.amount_tokens,
        data.amount_sol,
        data.inang_address
      );
      logger.info(`[TradeBase] Position OPEN: ${data.token_symbol}`);
    } catch (error) {
      logger.error(`[TradeBase] Error opening position: ${error}`);
    }
  }

  /**
   * Sync: Close position in positions table (called on sell)
   */
  public closePosition(tokenMint: string, pnlPercent: number, exitPrice: number = 0, reason: string = ''): void {
    try {
      const sql = `
        UPDATE positions SET
          status = 'CLOSED',
          closed_at = datetime('now'),
          pnl_percent = ?,
          closed_price = ?,
          exit_reason = ?
        WHERE token_mint = ? AND status = 'OPEN'
      `;
      const result = this.db.prepare(sql).run(pnlPercent, exitPrice, reason, tokenMint);
      if (result.changes > 0) {
        logger.info(`[TradeBase] Position CLOSED: ${tokenMint.substring(0, 12)}... (PnL: ${pnlPercent.toFixed(2)}%)`);
      }
    } catch (error) {
      logger.error(`[TradeBase] Error closing position: ${error}`);
    }
  }

  /**
   * Close database connection
   */
  public close(): void {
    this.db.close();
    logger.info('[TradeBase] Database connection closed');
  }
}
