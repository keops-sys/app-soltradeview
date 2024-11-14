import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Custom format for trade logs
const tradeFormat = winston.format.printf(({ level, message, timestamp, ...metadata }) => {
  const metaStr = Object.keys(metadata).length ? 
    JSON.stringify(metadata, null, 2) : '';
  return `.log${message} ${metaStr}`.trimLeft();
});

// Create logger
const logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.metadata({ fillExcept: ['message', 'level', 'timestamp'] }),
    tradeFormat
  ),
  transports: [
    // Console logging
    new winston.transports.Console({
      level: 'debug',
      format: winston.format.combine(
        winston.format.colorize(),
        tradeFormat
      )
    }),
    // File logging
    new winston.transports.File({ 
      filename: path.join(process.cwd(), 'logs', 'trades.log'),
      level: 'info'
    }),
    // Error logging
    new winston.transports.File({ 
      filename: path.join(process.cwd(), 'logs', 'error.log'),
      level: 'error'
    })
  ]
}); 
export { logger };