import 'newrelic';
import express from 'express';
import http from 'node:http';
import https from 'https';
import fs from 'fs';
import { logger } from './lib/logger.js';
import { analytics } from './lib/config.js';
import { setupRoutes } from './lib/routes.js';
import { RPC_ENDPOINTS, wallet } from './lib/config.js';
import os from 'os';

/**
 * Start the server based on environment
 * @param {express.Application} app - Express application instance
 */
export function startServer(app) {
  const PORT = process.env.NODE_ENV === 'production' ? 80 : 3000;
  
  // Initialize connection pool
  const connectionPool = RPC_ENDPOINTS;
  const currentConnectionIndex = 0;

  // Setup routes with dependencies
  setupRoutes(app, { 
    connectionPool, 
    currentConnectionIndex,
    wallet
  });

  if (process.env.NODE_ENV === 'production') {
    startProductionServer(app);
  } else {
    startDevelopmentServer(app, PORT);
  }
}

/**
 * Start production server with SSL
 * @param {express.Application} app - Express application instance
 */
function startProductionServer(app) {
  try {
    // Load SSL certificates
    const certPath = '/root/.acme.sh/soltradeview.com_ecc';
    const credentials = {
      key: fs.readFileSync(`${certPath}/soltradeview.com.key`, 'utf8'),
      cert: fs.readFileSync(`${certPath}/fullchain.cer`, 'utf8'),
      ca: fs.readFileSync(`${certPath}/ca.cer`, 'utf8'),
    };

    // Setup HTTP redirect server
    const httpApp = express();
    httpApp.use((req, res) => {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    });

    // Start HTTP server for redirects
    http.createServer(httpApp).listen(80, () => {
      logger.info('HTTP redirect server started', { port: 80 });
    });

    // Start HTTPS server
    https.createServer(credentials, app).listen(443, () => {
      logger.info('HTTPS server started 🚀', {
        port: '🔒 443',
        domain: `🌐 ${process.env.DOMAIN}`,
        mode: '⚡ production'
      });
      
      analytics.capture({
        distinctId: 'server',
        event: 'server_started',
        properties: {
          mode: 'production',
          port: 443,
          domain: process.env.DOMAIN,
          // System info
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          // Resources
          cpuCount: os.cpus().length,
          totalMemory: os.totalmem(),
          freeMemory: os.freemem(),
          loadAverage: os.loadavg(),
          // Process info
          pid: process.pid,
          ppid: process.ppid,
          // Environment
          nodeEnv: process.env.NODE_ENV,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          // Dependencies
          dependencies: process.versions,
          // Initial resource usage
          memoryUsage: process.memoryUsage(),
          cpuUsage: process.cpuUsage()
        }
      });
    });

  } catch (error) {
    analytics.capture({
      distinctId: 'server',
      event: 'server_error',
      properties: {
        error: error.message,
        errorName: error.name,
        stack: error.stack,
        // System state at time of error
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage(),
        uptime: process.uptime(),
        // System info
        nodeVersion: process.version,
        platform: process.platform,
        freeMemory: os.freemem(),
        loadAverage: os.loadavg()
      }
    });
    logger.error('Failed to start HTTPS server ❌', {
      error: error.message,
      stack: error.stack
    });
  }
}

/**
 * Start development server
 * @param {express.Application} app - Express application instance
 * @param {number} port - Port number
 */
function startDevelopmentServer(app, port) {
  app.listen(port, () => {
    // Pretty print the endpoints
    console.log(`\n🚀 Development server\n\n http://localhost:${port}/webhook`);
    console.table({
      dashboard: `http://localhost:${port}/dashboard.html`,
      api: `http://localhost:${port}/api/trades`    });
  });
}