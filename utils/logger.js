import winston from 'winston';
import path from 'path';
import { format } from 'winston';

// Custom format for trade logs
const tradeFormat = format.printf(({ level, message, timestamp, ...metadata }) => {
  const metaStr = Object.keys(metadata).length ? 
    JSON.stringify(metadata, null, 2) : '';
  return `[${timestamp}] ${level.toUpperCase()}: ${message} ${metaStr}`;
});

// Create logger
const logger = winston.createLogger({
  format: format.combine(
    format.timestamp(),
    format.metadata({ fillExcept: ['message', 'level', 'timestamp'] }),
    tradeFormat
  ),
  transports: [
    // Console logging
    new winston.transports.Console({
      level: 'debug',
      format: format.combine(
        format.colorize(),
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