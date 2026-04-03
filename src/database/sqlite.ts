import type { Database as DatabaseType } from 'better-sqlite3';
import Database from 'better-sqlite3';
import path from 'path';
import { createModuleLogger } from '../utils/logger';
import { CONFIG } from '../config/config';

const logger = createModuleLogger('SQLite');

let dbInstance: DatabaseType | null = null;

export function initDatabase(): DatabaseType {
  if (dbInstance) return dbInstance;

  const dbPath = path.isAbsolute(CONFIG.DB_PATH) 
    ? CONFIG.DB_PATH 
    : path.join(__dirname, '../../', CONFIG.DB_PATH);

  logger.info(`Opening database at ${dbPath}`);

  dbInstance = new Database(dbPath);
  dbInstance.pragma('journal_mode = WAL');

  createTables();
  logger.info('Database initialized');
  return dbInstance;
}

export function getDb(): DatabaseType | null {
  return dbInstance;
}

function createTables(): void {
  if (!dbInstance) throw new Error('Database not initialized');

  // Inang (Trader) table
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS inang_list (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT UNIQUE NOT NULL,
      discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      total_tx INTEGER DEFAULT 0,
      trading_activity INTEGER DEFAULT 0,
      winrate REAL DEFAULT 0,
      total_pnl REAL DEFAULT 0,
      status TEXT DEFAULT 'active',
      last_analyzed_at DATETIME,
      metadata TEXT
    )
  `);

  // Trades tracking table
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signature TEXT UNIQUE NOT NULL,
      trader_address TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      amount REAL,
      sol_amount REAL,
      is_buy BOOLEAN,
      timestamp DATETIME,
      pnl REAL,
      FOREIGN KEY (trader_address) REFERENCES inang_list(address)
    )
  `);

  // Filter log table for debugging
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS filter_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trader_address TEXT NOT NULL,
      stage TEXT NOT NULL,
      passed BOOLEAN,
      reason TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      data TEXT
    )
  `);

  // Positions table for active trades
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_mint TEXT UNIQUE NOT NULL,
      token_symbol TEXT,
      entry_price REAL NOT NULL,
      amount_tokens REAL NOT NULL,
      amount_sol REAL NOT NULL,
      highest_price REAL DEFAULT 0,
      trailing_stop_price REAL DEFAULT 0,
      partial_sold BOOLEAN DEFAULT 0,
      inang_address TEXT,
      status TEXT DEFAULT 'open',
      opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      closed_at DATETIME,
      closed_price REAL,
      pnl_percent REAL,
      exit_reason TEXT
    )
  `);

  logger.info('Tables created');
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    logger.info('Database closed');
  }
}
