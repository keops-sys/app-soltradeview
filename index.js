import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createConnectionPool } from './lib/trade.js';
import { setupRoutes } from './lib/routes.js';
import { RPC_ENDPOINTS, wallet } from './lib/config.js';
import { logger } from './lib/logger.js';
import { startServer } from './server.js';

// Initialize environment
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config();

// Initialize app
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize connections
let currentConnectionIndex = 0;
const connectionPool = createConnectionPool(RPC_ENDPOINTS);

// Setup routes
setupRoutes(app, { 
  wallet, 
  connectionPool, 
  currentConnectionIndex 
});

// Start server
startServer(app);

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { 
    error: error.message, 
    stack: error.stack 
  });
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled rejection', { 
    error: error.message, 
    stack: error.stack 
  });
  process.exit(1);
}); 