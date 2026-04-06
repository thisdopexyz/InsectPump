import type { Database as DatabaseType } from 'better-sqlite3';
import Database from 'better-sqlite3';
import path from 'path';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('DB');

interface InangData {
  address: string;
  winrate: number;
  total_pnl: number;
  total_tx: number;
  status?: string;
  last_trade_at?: string;
}

interface InangStats {
  total: number;
  active: number;
  blacklisted: number;
}

export class InangBase {
  private db: DatabaseType;
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
      CREATE TABLE IF NOT EXISTS inangs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT UNIQUE NOT NULL,
        winrate REAL DEFAULT 0,
        total_pnl REAL DEFAULT 0,
        total_tx INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_trade_at DATETIME
      )
    `;
    
    this.db.exec(createTableSQL);
    
    // Create index for faster lookups
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_address ON inangs(address)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_status ON inangs(status)');
    
    logger.info('[InangBase] Database initialized');
  }

  /**
   * Add new inang or update existing (upsert)
   * Logs when new inang is added
   */
  /**
   * Validate Solana base58 address
   * Rules: 32-44 chars, no 0/O/I/l
   */
  private isValidSolanaAddress(address: string): boolean {
    if (!address || address.length < 32 || address.length > 44) return false;
    
    // Base58 charset: 1-9, A-H, J-N, P-Z, a-k, m-z
    // Forbidden: 0, O, I, l
    const validBase58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
    return validBase58.test(address);
  }

  public addInang(data: InangData): { success: boolean; isNew: boolean; id?: number } {
    try {
      const { address, winrate, total_pnl, total_tx, status = 'active', last_trade_at } = data;
      
      // Validate address BEFORE any processing
      if (!this.isValidSolanaAddress(address)) {
        logger.error(`[InangBase] INVALID address rejected: ${address} (contains 0/O/I/l or wrong length)`);
        return { success: false, isNew: false };
      }
      
      // PRESERVE original case - base58 is case-sensitive!
      const addressNormalized = address;

      // Check if exists
      const existing = this.db.prepare('SELECT id FROM inangs WHERE address = ?').get(addressNormalized);

      if (existing) {
        // Update existing
        const updateSQL = `
          UPDATE inangs 
          SET winrate = ?, total_pnl = ?, total_tx = ?, 
              status = ?, last_trade_at = COALESCE(?, last_trade_at)
          WHERE address = ?
        `;
        this.db.prepare(updateSQL).run(winrate, total_pnl, total_tx, status, last_trade_at, addressNormalized);
        
        logger.info(`[InangBase] Updated inang: ${address} (Winrate: ${winrate.toFixed(2)}%, PnL: ${total_pnl.toFixed(4)} SOL)`);
        
        return { success: true, isNew: false, id: (existing as any).id };
      } else {
        // Insert new
        const insertSQL = `
          INSERT INTO inangs (address, winrate, total_pnl, total_tx, status, last_trade_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `;
        const result = this.db.prepare(insertSQL).run(addressNormalized, winrate, total_pnl, total_tx, status, last_trade_at);
        
        logger.info(`[InangBase] New inang discovered: ${address} (Winrate: ${winrate.toFixed(2)}%, PnL: ${total_pnl.toFixed(4)} SOL)`);
        
        return { success: true, isNew: true, id: result.lastInsertRowid as number };
      }
    } catch (error) {
      logger.error(`[InangBase] Error adding inang ${data.address}: ${error}`);
      return { success: false, isNew: false };
    }
  }

  /**
   * Quick check if wallet exists in database
   * NOTE: Address must be valid base58 (checked by addInang)
   */
  public isInangExists(address: string): boolean {
    try {
      // PRESERVE case - base58 is case-sensitive!
      const result = this.db.prepare('SELECT 1 FROM inangs WHERE address = ?').get(address);
      return !!result;
    } catch (error) {
      logger.error(`[InangBase] Error checking existence for ${address}: ${error}`);
      return false;
    }
  }

  /**
   * Get inang by address
   * NOTE: Address must be valid base58 (checked by addInang)
   */
  public getInang(address: string): any | null {
    try {
      // PRESERVE case - base58 is case-sensitive!
      return this.db.prepare('SELECT * FROM inangs WHERE address = ?').get(address) || null;
    } catch (error) {
      logger.error(`[InangBase] Error getting inang ${address}: ${error}`);
      return null;
    }
  }

  /**
   * Get all active inangs (addresses only)
   */
  public getActiveInangs(): string[] {
    try {
      const rows = this.db.prepare("SELECT address FROM inangs WHERE status = 'active'").all();
      return rows.map((row: any) => row.address);
    } catch (error) {
      logger.error(`[InangBase] Error getting active inangs: ${error}`);
      return [];
    }
  }

  /**
   * Get all active inangs with full data
   */
  public getActiveInangsFull(): any[] {
    try {
      return this.db.prepare("SELECT * FROM inangs WHERE status = 'active' ORDER BY total_pnl DESC").all();
    } catch (error) {
      logger.error(`[InangBase] Error getting active inangs full: ${error}`);
      return [];
    }
  }

  /**
   * Update status of an inang (e.g., 'blacklisted', 'paused', 'active')
   * NOTE: Address must be valid base58
   */
  public updateStatus(address: string, status: string): boolean {
    try {
      // PRESERVE case - base58 is case-sensitive!
      const result = this.db.prepare('UPDATE inangs SET status = ? WHERE address = ?').run(status, address);
      
      if (result.changes > 0) {
        logger.info(`[InangBase] Updated status for ${address}: ${status}`);
        return true;
      }
      
      logger.warn(`[InangBase] No inang found to update status: ${address}`);
      return false;
    } catch (error) {
      logger.error(`[InangBase] Error updating status for ${address}: ${error}`);
      return false;
    }
  }

  /**
   * Get summary statistics of inangs
   */
  public getInangStats(): InangStats {
    try {
      const total = this.db.prepare('SELECT COUNT(*) as count FROM inangs').get() as { count: number };
      const active = this.db.prepare("SELECT COUNT(*) as count FROM inangs WHERE status = 'active'").get() as { count: number };
      const blacklisted = this.db.prepare("SELECT COUNT(*) as count FROM inangs WHERE status = 'blacklisted'").get() as { count: number };

      return {
        total: total.count,
        active: active.count,
        blacklisted: blacklisted.count
      };
    } catch (error) {
      logger.error(`[InangBase] Error getting stats: ${error}`);
      return { total: 0, active: 0, blacklisted: 0 };
    }
  }

  /**
   * Update last trade timestamp
   * NOTE: Address must be valid base58
   */
  public updateLastTrade(address: string): boolean {
    try {
      // PRESERVE case - base58 is case-sensitive!
      const result = this.db.prepare('UPDATE inangs SET last_trade_at = CURRENT_TIMESTAMP WHERE address = ?').run(address);
      return result.changes > 0;
    } catch (error) {
      logger.error(`[InangBase] Error updating last trade for ${address}: ${error}`);
      return false;
    }
  }

  /**
   * Delete inang (rarely used, prefer status update)
   * NOTE: Address must be valid base58
   */
  public deleteInang(address: string): boolean {
    try {
      // PRESERVE case - base58 is case-sensitive!
      const result = this.db.prepare('DELETE FROM inangs WHERE address = ?').run(address);
      
      if (result.changes > 0) {
        logger.info(`[InangBase] Deleted inang: ${address}`);
        return true;
      }
      
      return false;
    } catch (error) {
      logger.error(`[InangBase] Error deleting inang ${address}: ${error}`);
      return false;
    }
  }

  /**
   * Close database connection
   */
  public close(): void {
    this.db.close();
    logger.info('[InangBase] Database connection closed');
  }
}
