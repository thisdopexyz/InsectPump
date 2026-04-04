import * as winston from 'winston';
import * as path from 'path';
import * as fs from 'fs';
import { CONFIG } from '../config/config';

// Define custom colors
const customColors = {
  info: 'green',
  warn: 'yellow',
  error: 'red',
  debug: 'blue',
};

// Add colors to winston
winston.addColors(customColors);

// Custom format: [Timestamp] [Module Name] [Message]
const customFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ level, message, timestamp, module }) => {
    const moduleName = module || 'App';
    return `[${timestamp}] [${moduleName}] [${level.toUpperCase()}] ${message}`;
  })
);

// Console format with colors
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(({ level, message, timestamp, module }) => {
    const moduleName = module || 'App';
    return `[${timestamp}] [${moduleName}] [${level}] ${message}`;
  })
);

// Create logs directory if needed
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Build transports array
const transports: winston.transport[] = [
  // Console transport for real-time monitoring (ALWAYS ON)
  new winston.transports.Console({
    format: consoleFormat,
  }),
];

// File transport for persistence (conditional on LOG_TO_FILE config)
const logToFile = CONFIG.LOG_TO_FILE;
if (logToFile) {
  transports.push(
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      format: customFormat,
      maxsize: CONFIG.LOG_MAX_SIZE_BYTES,
      maxFiles: CONFIG.LOG_MAX_FILES,
    }),
    // Separate error log file
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      format: customFormat,
      maxsize: CONFIG.LOG_MAX_SIZE_BYTES,
      maxFiles: CONFIG.LOG_MAX_FILES,
    })
  );
}

// Create the logger
export const logger = winston.createLogger({
  level: CONFIG.LOG_LEVEL,
  defaultMeta: { module: 'App' },
  transports: transports,
});

// Helper functions for module-specific logging
export function createModuleLogger(moduleName: string) {
  return {
    info: (msg: string) => logger.info(msg, { module: moduleName }),
    warn: (msg: string) => logger.warn(msg, { module: moduleName }),
    error: (msg: string) => logger.error(msg, { module: moduleName }),
    debug: (msg: string) => logger.debug(msg, { module: moduleName }),
  };
}

// Default module loggers
export const eyeLogger = createModuleLogger('Eye');
export const monitorLogger = createModuleLogger('Monitor');
export const tradeLogger = createModuleLogger('Trade');
export const dbLogger = createModuleLogger('DB');
export const priceLogger = createModuleLogger('Price');
