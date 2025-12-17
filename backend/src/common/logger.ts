import * as winston from 'winston';
import * as path from 'path';
import * as fs from 'fs';

// Determine log directory based on platform
const getLogDirectory = (): string => {
  const isDev = process.env.NODE_ENV === 'development';

  if (isDev) {
    // In development, log to project root
    return path.join(process.cwd(), 'logs');
  } else {
    // In production, log to platform-appropriate user data directory
    const platform = process.platform;
    const homeDir = process.env.HOME || process.env.USERPROFILE || '.';

    if (platform === 'darwin') {
      // macOS: ~/Library/Logs/ClipChimp
      return path.join(homeDir, 'Library', 'Logs', 'ClipChimp');
    } else if (platform === 'win32') {
      // Windows: %APPDATA%/clipchimp/logs
      const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
      return path.join(appData, 'clipchimp', 'logs');
    } else {
      // Linux: ~/.config/clipchimp/logs
      return path.join(homeDir, '.config', 'clipchimp', 'logs');
    }
  }
};

// Ensure log directory exists
const logDir = getLogDirectory();
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Custom format for better readability
const customFormat = winston.format.printf(({ level, message, timestamp, ...metadata }) => {
  let msg = `${timestamp} [${level.toUpperCase()}] ${message}`;

  // Add metadata if present
  if (Object.keys(metadata).length > 0) {
    msg += ` ${JSON.stringify(metadata)}`;
  }

  return msg;
});

// Create the logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    customFormat
  ),
  transports: [
    // Console transport for development
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        customFormat
      )
    }),
    // File transport for all logs
    new winston.transports.File({
      filename: path.join(logDir, 'backend.log'),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      tailable: true
    }),
    // File transport for errors only
    new winston.transports.File({
      filename: path.join(logDir, 'backend-error.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      tailable: true
    })
  ],
  exitOnError: false
});

// Export logger with electron-log compatible interface
export const log = {
  info: (...args: any[]) => logger.info(args.join(' ')),
  error: (...args: any[]) => logger.error(args.join(' ')),
  warn: (...args: any[]) => logger.warn(args.join(' ')),
  debug: (...args: any[]) => logger.debug(args.join(' ')),
  verbose: (...args: any[]) => logger.verbose(args.join(' ')),
  silly: (...args: any[]) => logger.silly(args.join(' ')),
  log: (...args: any[]) => logger.info(args.join(' '))
};

// Also export as default for different import styles
export default log;

// Export the winston logger instance for advanced usage
export { logger };
