import { v4 as uuidv4 } from 'uuid';
import { analytics } from './config.js';
import { logger } from './logger.js';
import os from 'os';
import { executeTrade } from './trade.js';
import { Connection, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';


export function setupRoutes(app, { wallet, connectionPool, currentConnectionIndex }) {
  if (!wallet?.publicKey) {
    throw new Error('Wallet not properly initialized for route setup');
  }

  app.post('/webhook', async (req, res) => {
    const startTime = Date.now();
    const tradeId = uuidv4();
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    
    try {
      // Initial logging and analytics
      logger.info('Trade initiated', {
        tradeId,
        walletPublicKey: wallet?.publicKey?.toString(),
        body: req.body,
        timestamp: new Date().toISOString(),
        clientIp
      });

      analytics.capture({
        distinctId: wallet?.publicKey || 'anonymous',
        event: 'trade_initiated',
        properties: {
          tradeId,
          clientIp,
          userAgent: req.headers['user-agent'],
          timestamp: new Date().toISOString(),
          // Trade details
          action: req.body.action,
          orderSize: req.body.order_size,
          market: req.body.market,
          leverage: req.body.leverage,
          // System state
          connectionIndex: currentConnectionIndex,
          memoryUsage: process.memoryUsage(),
          cpuUsage: process.cpuUsage(),
          // Request metadata
          referrer: req.headers.referer,
          origin: req.headers.origin,
          method: req.method,
          path: req.path
        }
      });

      const tradeResult = await executeTrade({ 
        tradeId,
        action: req.body.action,
        order_size: req.body.order_size,
        market: req.body.ticker,
        timestamp: req.body.timestamp,
        wallet,
        connectionPool,
        currentConnectionIndex
      });
      const executionTime = Date.now() - startTime;

      // Success logging and analytics
      logger.info('Trade executed successfully', {
        tradeId,
        executionTime: `${executionTime}ms`,
        txHash: tradeResult.signature,
        ...tradeResult.details
      });

      analytics.capture({
        distinctId: wallet?.publicKey || 'anonymous',
        event: 'trade_completed',
        properties: {
          tradeId,
          clientIp,
          executionTime,
          signature: tradeResult.signature,
          success: true,
          // Performance metrics
          executionTimeMs: executionTime,
          memoryUsage: process.memoryUsage(),
          cpuUsage: process.cpuUsage(),
          // Trade results
          ...tradeResult.details,
          // Network info
          rpcEndpoint: connectionPool[currentConnectionIndex].http,
          // System metrics
          nodeVersion: process.version,
          platform: process.platform,
          uptime: process.uptime()
        }
      });

      res.json({ 
        success: true,
        tradeId,
        signature: tradeResult.signature,
        details: tradeResult.details
      });

    } catch (error) {
      const executionTime = Date.now() - startTime;

      // Error logging and analytics
      logger.error('Trade execution failed ❌', {
        tradeId,
        error: error.message,
        stack: error.stack,
        request: req.body,
        executionTime: `${executionTime}ms`
      });

      analytics.capture({
        distinctId: wallet?.publicKey || 'anonymous',
        event: 'trade_failed',
        properties: {
          tradeId,
          clientIp,
          errorMessage: error.message,
          errorName: error.name,
          errorStack: error.stack,
          request: req.body,
          executionTimeMs: executionTime
        }
      });

      res.status(400).json({ 
        success: false,
        error: error.message,
        tradeId
      });
    }
  });

  // Server health monitoring
  setInterval(() => {
    analytics.capture({
      distinctId: 'server',
      event: 'server_health_check',
      properties: {
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage(),
        activeConnections: connectionPool.length,
        currentConnectionIndex,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        loadAverage: os.loadavg(),
        freeMemory: os.freemem(),
        totalMemory: os.totalmem(),
        cpuCount: os.cpus().length
      }
    });
  }, 5 * 60 * 1000); // Every 5 minutes
} 