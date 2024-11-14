import { v4 as uuidv4 } from 'uuid';
import { postHog } from './config.js';
import { logger } from './logger.js';
import os from 'os';
import { executeTrade } from './trade.js';
import { Connection, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import newrelic from 'newrelic';


export function setupRoutes(app, { wallet, connectionPool, currentConnectionIndex }) {
  if (!wallet?.publicKey) {
    throw new Error('Wallet not properly initialized for route setup');
  }

  app.post('/webhook', async (req, res) => {
    const startTime = Date.now();
    const tradeId = uuidv4();
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    
    try {
      // Initial logging and postHog
      logger.info('Trade initiated', {
        tradeId,
        walletPublicKey: wallet?.publicKey?.toString(),
        body: req.body,
        timestamp: new Date().toISOString(),
        clientIp
      });

      postHog.capture({
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

      // Add NewRelic event for trade initiation
      newrelic.recordCustomEvent('TradeInitiated', {
        tradeId,
        clientIp,
        userAgent: req.headers['user-agent'],
        timestamp: Date.now(),
        action: req.body.action,
        orderSize: req.body.order_size,
        market: req.body.market,
        leverage: req.body.leverage,
        connectionIndex: currentConnectionIndex,
        memoryUsage: JSON.stringify(process.memoryUsage()),
        cpuUsage: JSON.stringify(process.cpuUsage()),
        referrer: req.headers.referer,
        origin: req.headers.origin,
        method: req.method,
        path: req.path,
        walletPublicKey: wallet?.publicKey?.toString()
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

      // Success logging and postHog
      logger.info('Trade executed successfully', {
        tradeId,
        executionTime: `${executionTime}ms`,
        txHash: tradeResult.signature,
        ...tradeResult.details
      });

      postHog.capture({
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

      // Add NewRelic event for trade completion
      newrelic.recordCustomEvent('TradeCompleted', {
        tradeId,
        clientIp,
        executionTime,
        signature: tradeResult.signature,
        success: true,
        executionTimeMs: executionTime,
        memoryUsage: JSON.stringify(process.memoryUsage()),
        cpuUsage: JSON.stringify(process.cpuUsage()),
        ...tradeResult.details,
        rpcEndpoint: connectionPool[currentConnectionIndex].http,
        nodeVersion: process.version,
        platform: process.platform,
        uptime: process.uptime(),
        timestamp: Date.now(),
        walletPublicKey: wallet?.publicKey?.toString()
      });

      res.json({ 
        success: true,
        tradeId,
        signature: tradeResult.signature,
        details: tradeResult.details
      });

    } catch (error) {
      const executionTime = Date.now() - startTime;
      
      // Parse Solana-specific error details
      let errorCode = null;
      let instructionIndex = null;
      let customErrorCode = null;
      
      try {
        if (error.message.includes('InstructionError')) {
          const errorObj = JSON.parse(error.message.split('Transaction failed: ')[1]);
          if (errorObj.InstructionError) {
            [instructionIndex, customErrorCode] = errorObj.InstructionError;
            if (typeof customErrorCode === 'object' && customErrorCode.Custom) {
              errorCode = customErrorCode.Custom;
            }
          }
        }
      } catch (parseError) {
        logger.warn('Failed to parse Solana error details', { parseError });
      }

      // Error logging and postHog with enhanced error details
      logger.error('Trade execution failed ❌', {
        tradeId,
        error: error.message,
        stack: error.stack,
        request: req.body,
        executionTime: `${executionTime}ms`,
        solanaError: {
          instructionIndex,
          errorCode,
          customErrorCode
        }
      });

      postHog.capture({
        distinctId: wallet?.publicKey || 'anonymous',
        event: 'trade_failed',
        properties: {
          tradeId,
          clientIp,
          errorMessage: error.message,
          errorName: error.name,
          errorStack: error.stack,
          request: req.body,
          executionTimeMs: executionTime,
          // Add Solana-specific error details
          solanaInstructionIndex: instructionIndex,
          solanaErrorCode: errorCode,
          solanaCustomErrorCode: customErrorCode,
          // Add transaction context
          action: req.body.action,
          orderSize: req.body.order_size,
          market: req.body.market,
          connectionIndex: currentConnectionIndex,
          rpcEndpoint: connectionPool[currentConnectionIndex].http
        }
      });

      // Enhanced NewRelic error event
      newrelic.recordCustomEvent('TradeFailed', {
        tradeId,
        clientIp,
        errorMessage: error.message,
        errorName: error.name,
        errorStack: error.stack,
        request: JSON.stringify(req.body),
        executionTimeMs: executionTime,
        // Add Solana-specific error details
        solanaInstructionIndex: instructionIndex,
        solanaErrorCode: errorCode,
        solanaCustomErrorCode: customErrorCode,
        // Add transaction context
        action: req.body.action,
        orderSize: req.body.order_size,
        market: req.body.market,
        connectionIndex: currentConnectionIndex,
        rpcEndpoint: connectionPool[currentConnectionIndex].http,
        timestamp: Date.now(),
        walletPublicKey: wallet?.publicKey?.toString()
      });

      // Also record as error in NewRelic
      newrelic.noticeError(error, {
        tradeId,
        solanaInstructionIndex: instructionIndex,
        solanaErrorCode: errorCode,
        solanaCustomErrorCode: customErrorCode,
        action: req.body.action,
        orderSize: req.body.order_size,
        market: req.body.market
      });

      res.status(400).json({ 
        success: false,
        error: error.message,
        tradeId,
        solanaError: {
          instructionIndex,
          errorCode,
          customErrorCode
        }
      });
    }
  });

  // Server health monitoring
  setInterval(() => {
    postHog.capture({
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

    // Add NewRelic event for server health
    newrelic.recordCustomEvent('ServerHealthCheck', {
      timestamp: Date.now(),
      uptime: process.uptime(),
      memoryUsage: JSON.stringify(process.memoryUsage()),
      cpuUsage: JSON.stringify(process.cpuUsage()),
      activeConnections: connectionPool.length,
      currentConnectionIndex,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      loadAverage: os.loadavg(),
      freeMemory: os.freemem(),
      totalMemory: os.totalmem(),
      cpuCount: os.cpus().length
    });
  }, 5 * 60 * 1000); // Every 5 minutes
} 