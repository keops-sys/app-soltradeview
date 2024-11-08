import { createRotatingFileStream } from 'rotating-file-stream';
import path from 'path';

// Create rotating stream for trades.log
const tradeStream = createRotatingFileStream('trades.log', {
  interval: '1d', // Rotate daily
  path: path.join(process.cwd(), 'logs'),
  compress: 'gzip', // Compress old logs
  maxFiles: 14 // Keep 2 weeks of logs
});

export { tradeStream }; 