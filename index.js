import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
  TransactionExpiredBlockheightExceededError,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';import express from 'express';
import path from 'path';
import fs from 'fs';
import https from 'https';
import http from 'node:http';
import { PostHog } from 'posthog-node'
import { logger } from './utils/logger.js';
import { EventEmitter } from 'events';
import chalk from 'chalk';
import figlet from 'figlet';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { Wallet } from '@project-serum/anchor';
import bs58 from 'bs58';
import crypto from 'crypto';
dotenv.config();

const MIN_SOL_BALANCE = process.env.MIN_SOL_BALANCE || 0.1;
const PLATFORM_FEE_BPS = 50; // 0.5% fee
const JUPITER_MAX_RETRIES = 3;
const JUPITER_BASE_DELAY = 500;
const SLIPPAGE_BPS = 300; // 3%
const INPUT_MINT = 'So11111111111111111111111111111111111111112'; // SOL
const OUTPUT_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
const RPC_ENDPOINTS = [
  'https://api.mainnet-beta.solana.com',
  'https://thrilling-red-tree.solana-mainnet.quiknode.pro/392c7c4a3140c4fcef39f1be375947284e2f799c',
  'https://mainnet.helius-rpc.com/?api-key=292afef7-e149-4010-862b-f611beb385fc'
];
const RPC_TIMEOUT = 45000; // 45 seconds
let currentRpcIndex = 0;
const wallet = new Wallet(Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY || '')));
const SEND_OPTIONS = {
  skipPreflight: true,
  maxRetries: 1,
  computeUnits: 1_000_000,    
  priorityFee: 10_000_000,   // Increased priority fee to 0.1 SOL for better chances
};

// Validate required environment variables
const requiredEnvVars = [
    'DOMAIN',
    'NODE_ENV',
    'SOLANA_RPC_ENDPOINT',
    'PRIVATE_KEY'
];


const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
    console.error(chalk.red('Error: Missing required environment variables:'));
    missingEnvVars.forEach(varName => {
        console.error(chalk.red(`  - ${varName}`));
    });
    console.error(chalk.yellow('\nPlease check your .env file'));
    process.exit(1);
}

// Initialize PostHog with debug mode
const client = new PostHog(
  'phc_bSVQPOlxikcyh0ScYCZQNpCg6guWnYvVwAd2e5z8iHz',
  { 
    host: 'https://eu.i.posthog.com',
    flushAt: 1, // Flush immediately for testing
    flushInterval: 0 // Disable auto-flushing
  }
)

// Test event
client.capture({
  distinctId: 'test-user',
  event: 'server_started',
  properties: {
    environment: process.env.NODE_ENV,
    timestamp: new Date().toISOString()
  }
})

// 🔑 SSL

// Load SSL certificates only in production
const getSSLCredentials = () => {
  if (process.env.NODE_ENV !== 'production') {
    console.log('Development mode: Using dummy SSL credentials');
    return {
      // Development certificates - you might want to add local dev certs here
      // or just return empty object
      key: '',
      cert: '',
      ca: ''
    };
  }

  // Check if we're on the production server
  const certPath = '/root/.acme.sh/soltradeview.com_ecc';
  if (!fs.existsSync(certPath)) {
    console.warn(`Production SSL path ${certPath} not found.`);
    console.warn('If running locally, make sure NODE_ENV is not set to "production"');
    return {};
  }

  try {
    return {
      key: fs.readFileSync(`${certPath}/soltradeview.com.key`, 'utf8'),
      cert: fs.readFileSync(`${certPath}/fullchain.cer`, 'utf8'),
      ca: fs.readFileSync(`${certPath}/ca.cer`, 'utf8'),
    };
  } catch (error) {
    console.error('Failed to load SSL certificates:', error.message);
    if (process.env.NODE_ENV === 'production') {
      console.error('Cannot start production server without SSL certificates');
      process.exit(1);
    }
    return {};
  }
};

const credentials = getSSLCredentials();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));





// Update connection creation to use the current RPC endpoint
const connection = new Connection(RPC_ENDPOINTS[currentRpcIndex], 'finalized');

// Add RPC health check function
async function checkRPCHealth(endpoint) {
    try {
        const conn = new Connection(endpoint, 'confirmed');
        const start = Date.now();
        await conn.getSlot();
        const latency = Date.now() - start;
        console.log(`RPC ${endpoint} is healthy (latency: ${latency}ms)`);
        return true;
    } catch (error) {
        console.error(`RPC ${endpoint} is unhealthy:`, error.message);
        return false;
    }
}

// Add startup health check
async function validateRPCEndpoints() {
    console.log('Validating RPC endpoints...');
    const healthyEndpoints = [];
    
    for (const endpoint of RPC_ENDPOINTS) {
        if (await checkRPCHealth(endpoint)) {
            healthyEndpoints.push(endpoint);
        }
    }
    
    if (healthyEndpoints.length === 0) {
        console.error(chalk.red('Error: No healthy RPC endpoints available'));
        process.exit(1);
    }
    
    console.log(`${healthyEndpoints.length} healthy RPC endpoints available`);
    return healthyEndpoints;
}

// Update server startup to include RPC validation
const startServer = async () => {
    try {
        // Validate RPC endpoints
        const healthyEndpoints = await validateRPCEndpoints();
        
        // Update RPC_ENDPOINTS with only healthy ones
        RPC_ENDPOINTS.length = 0;
        RPC_ENDPOINTS.push(...healthyEndpoints);

        // Start the server
        const port = process.env.PORT || 3000;
        app.listen(port, () => {
            console.log(chalk.green(`Server running on port ${port}`));
            console.log('\nAvailable endpoints:');
            console.log(chalk.yellow('- Dashboard:', `http://localhost:${port}/dashboard.html`));
            console.log(chalk.yellow('- API:', `http://localhost:${port}/api/trades`));
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
};



async function calculateTradeAmount(inputMint, action, quote, connection) {
  try {
    const minBalanceSol = 0.1; // Minimum SOL balance to maintain
    const estimatedTxFeeSol = 0.001; // Transaction fee in SOL

    console.log('Calculate Trade Amount Inputs:', {
      inputMint,
      action,
      quote,
      minBalanceSol,
      estimatedTxFeeSol
    });

    if (action === 'buy' && inputMint === OUTPUT_MINT) { 
      console.log('Calculating buy amount with USDC...');
      // Buy SOL using USDC
      const tokenAccounts = await connection.getTokenAccountsByOwner(wallet.publicKey, {
        mint: new PublicKey(inputMint),
      });

      console.log('Found token accounts:', tokenAccounts.value.length);

      if (tokenAccounts.value.length === 0) {
        console.log('❌ No USDC token accounts found.');
        return 0;
      }

      for (const account of tokenAccounts.value) {
        const accountInfo = await connection.getParsedAccountInfo(account.pubkey);
        const tokenAmount = accountInfo.value?.data?.parsed?.info?.tokenAmount;
        console.log('Token account info:', {
          pubkey: account.pubkey.toString(),
          tokenAmount
        });

        if (tokenAmount && tokenAmount.uiAmount > 0) {
          const usdcBalance = tokenAmount.amount;
          console.log(`💰 Available USDC: ${(usdcBalance / 1e6).toFixed(2)} USDC`);

          // Use all available USDC balance for 100% trades
          const tradeAmountUsdc = usdcBalance;
          console.log(`🔄 Trading USDC for SOL: ${(tradeAmountUsdc / 1e6).toFixed(2)}`);
          return Math.floor(tradeAmountUsdc);
        }
      }
      return 0;

    } else if (action === 'sell' && inputMint === INPUT_MINT) { 
      console.log('Calculating sell amount with SOL...');
      // Sell SOL to get USDC
      const balance = await connection.getBalance(wallet.publicKey);
      const currentBalanceSol = balance / LAMPORTS_PER_SOL;
      console.log(`Current SOL balance: ${currentBalanceSol}`);

      const requiredReserve = minBalanceSol + estimatedTxFeeSol;
      let maxSellSol = currentBalanceSol - requiredReserve;

      console.log(`Max sellable SOL (after reserve): ${maxSellSol}`);

      if (maxSellSol <= 0) {
        console.log('⚠️ Not enough SOL to maintain reserve.');
        maxSellSol = currentBalanceSol - estimatedTxFeeSol;
      }

      // Limit trade amount to available SOL or inAmount from quote
      const tradeAmountSol = Math.min(maxSellSol, quote.inAmount / LAMPORTS_PER_SOL);
      console.log(`🔄 Trading SOL for USDC: ${tradeAmountSol.toFixed(6)} SOL`);
      return Math.max(0, Math.floor(tradeAmountSol * LAMPORTS_PER_SOL));
    }

    console.log('❌ No matching trade condition found:', {
      action,
      inputMint,
      quoteInputMint: quote.inputMint,
      quoteOutputMint: quote.outputMint
    });
    return 0;
  } catch (error) {
    console.error('💥 Error calculating trade amount:', error);
    return 0;
  }
}

// Update the getQuote function with better rate limit handling
async function getQuote(amount, action = 'sell', connection) {
  const maxRetries = JUPITER_MAX_RETRIES;
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const [inputMint, outputMint] = action === 'buy' 
        ? [OUTPUT_MINT, INPUT_MINT]   // For buy: USDC -> SOL
        : [INPUT_MINT, OUTPUT_MINT];  // For sell: SOL -> USDC

      const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}\
&outputMint=${outputMint}\
&amount=${amount}\
&slippageBps=${SLIPPAGE_BPS}\
&platformFeeBps=${PLATFORM_FEE_BPS}`;

      const response = await fetch(url);
      
      if (response.status === 429) {
        const delay = JUPITER_BASE_DELAY * Math.pow(2, attempt);
        console.log(`Rate limit hit, waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries - 1) throw error;
      
      const delay = Math.min(JUPITER_BASE_DELAY * Math.pow(2, attempt), 10000);
      console.log(`Quote attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

// Update getSwapTransaction with similar rate limit handling
async function getSwapTransaction(quote, connection) {
  const maxRetries = JUPITER_MAX_RETRIES;
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: wallet.publicKey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto',
          feeAccount: wallet.publicKey.toString(),
          dynamicSlippage: { maxBps: SLIPPAGE_BPS }
        }),
      });

      if (response.status === 429) {
        const delay = JUPITER_BASE_DELAY * Math.pow(2, attempt);
        console.log(`Rate limit hit, waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const swapData = await response.json();
      if (swapData.error) throw new Error(swapData.error);
      return swapData.swapTransaction;
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries - 1) throw error;
      
      const delay = Math.min(JUPITER_BASE_DELAY * Math.pow(2, attempt), 10000);
      console.log(`Swap transaction attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}



// Update executeTrade to use RPC rotation and existing functions
async function executeTrade(tradeRequest) {
    const startTime = Date.now();
    let lastError;
    let lastSignature;

    console.log('Starting trade execution with request:', JSON.stringify(tradeRequest, null, 2));

    for (let rpcAttempt = 0; rpcAttempt < RPC_ENDPOINTS.length; rpcAttempt++) {
        const connection = new Connection(RPC_ENDPOINTS[currentRpcIndex], 'finalized');
        
        console.log(`Using RPC endpoint: ${RPC_ENDPOINTS[currentRpcIndex]}`);

        try {
            // Fresh calculation for each attempt
            let tradeAmount;
            if (tradeRequest.order_size === '100%') {
                console.log('Getting fresh quote for 100% calculation...');
                const initialQuote = await getQuote(LAMPORTS_PER_SOL, tradeRequest.action, connection);
                console.log('Initial quote received:', initialQuote);
                
                tradeAmount = await calculateTradeAmount(
                    tradeRequest.action === 'buy' ? OUTPUT_MINT : INPUT_MINT,
                    tradeRequest.action,
                    initialQuote,
                    connection
                );
            } else {
                tradeAmount = tradeRequest.action === 'buy' 
                    ? Math.floor(parseFloat(tradeRequest.position_size) * 1e6)
                    : Math.floor(parseFloat(tradeRequest.position_size) * LAMPORTS_PER_SOL);
            }

            console.log(`Calculated trade amount: ${tradeAmount}`);

            if (!tradeAmount || tradeAmount === 0) {
                throw new Error('Invalid trade amount calculated');
            }

            // Get fresh quote with actual amount
            console.log('Getting fresh final quote...');
            const quote = await getQuote(tradeAmount, tradeRequest.action, connection);
            console.log('Final quote received:', quote);

            // Get fresh swap transaction
            console.log('Getting fresh swap transaction...');
            const swapTransaction = await getSwapTransaction(quote, connection);
            console.log('Swap transaction received');

            // Get fresh blockhash
            console.log('Getting fresh blockhash...');
            const latestBlockhash = await connection.getLatestBlockhash('finalized');
            console.log('Latest blockhash received:', latestBlockhash.blockhash);

            // Process transaction
            const transaction = VersionedTransaction.deserialize(
                Buffer.from(swapTransaction, 'base64')
            );
            transaction.message.recentBlockhash = latestBlockhash.blockhash;
            transaction.sign([wallet.payer]);

            // Send transaction
            console.log('Sending transaction...');
            const signature = await connection.sendRawTransaction(
                transaction.serialize(),
                SEND_OPTIONS
            );
            lastSignature = signature;
            console.log(`Transaction sent. Signature: ${signature}`);

            // Wait for confirmation with timeout
            console.log('Waiting for confirmation...');
            const confirmationPromise = new Promise(async (resolve, reject) => {
                const startConfirmTime = Date.now();
                
                while (Date.now() - startConfirmTime < RPC_TIMEOUT) {
                    try {
                        const status = await connection.getSignatureStatus(signature);
                        
                        if (status.value?.err) {
                            reject(new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`));
                            break;
                        }
                        
                        if (status.value?.confirmationStatus === 'finalized') {
                            resolve(status);
                            break;
                        }
                        
                        await new Promise(r => setTimeout(r, 1000));
                    } catch (error) {
                        console.warn(`Error checking status: ${error.message}`);
                        await new Promise(r => setTimeout(r, 1000));
                    }
                }
                reject(new Error('Confirmation timeout'));
            });

            await confirmationPromise;
            
            console.log(`✅ Trade executed successfully: ${signature}`);
            return {
                signature,
                success: true,
                timestamp: new Date().toISOString()
            };

        } catch (error) {
            console.error(`Attempt ${rpcAttempt + 1} failed with RPC ${currentRpcIndex}:`, error);
            lastError = error;
            
            if (Date.now() - startTime >= RPC_TIMEOUT) {
                console.log('Switching to next RPC endpoint after timeout');
                currentRpcIndex = (currentRpcIndex + 1) % RPC_ENDPOINTS.length;
                continue;
            }

            // Check last signature before continuing
            if (lastSignature) {
                try {
                    const status = await connection.getSignatureStatus(lastSignature);
                    if (status.value?.confirmationStatus === 'finalized') {
                        return {
                            signature: lastSignature,
                            success: true,
                            timestamp: new Date().toISOString()
                        };
                    }
                } catch (statusError) {
                    console.warn('Error checking signature status:', statusError?.message);
                }
            }

            // Wait before trying next RPC
            await new Promise(resolve => setTimeout(resolve, 1000));
            currentRpcIndex = (currentRpcIndex + 1) % RPC_ENDPOINTS.length;
        }
    }

    throw new Error(`Trade execution failed after trying all RPC endpoints: ${lastError?.message || 'Unknown error'}`);
}

/**
 * Handle incoming swap requests via webhook
 */
app.post('/webhook', async (req, res) => {
    const startTime = Date.now();
    try {
        console.log('Raw webhook request body:', JSON.stringify(req.body, null, 2));
        
        // Extract trade request with logging
        const tradeRequest = req.body?.metadata?.metadata || req.body;
        console.log('Extracted trade request:', JSON.stringify(tradeRequest, null, 2));
        
        // Log trade request
        logger.info('Trade request received', {
            metadata: {
                tradeId: crypto.randomUUID(),
                ...tradeRequest,
                timestamp: new Date().toISOString()
            }
        });

        // Create fresh connection for balance check
        const connection = new Connection(RPC_ENDPOINTS[currentRpcIndex], 'finalized');
        
        // Check balance
        const balance = await connection.getBalance(wallet.publicKey);
        console.log('Raw balance:', balance);
        console.log('Wallet public key:', wallet.publicKey.toString());
        
        logger.debug('Current balance', {
            balance: balance / LAMPORTS_PER_SOL,
            minRequired: MIN_SOL_BALANCE
        });

        if (balance / LAMPORTS_PER_SOL < MIN_SOL_BALANCE) {
            throw new Error('Insufficient balance');
        }

        // Normalize and validate request
        const normalizedRequest = {
            action: tradeRequest.action,
            order_size: tradeRequest.order_size,
            position_size: tradeRequest.position_size
        };

        console.log('Normalized request:', JSON.stringify(normalizedRequest, null, 2));

        // Validate required fields
        if (!normalizedRequest.action) {
            throw new Error('Missing required field: action');
        }
        if (!normalizedRequest.order_size && !normalizedRequest.position_size) {
            throw new Error('Missing required field: order_size or position_size');
        }

        // Execute trade with try-catch
        let result;
        try {
            result = await executeTrade(normalizedRequest);
            console.log('Trade execution result:', JSON.stringify(result, null, 2));
        } catch (tradeError) {
            console.error('Trade execution error:', {
                message: tradeError?.message || 'Unknown trade error',
                stack: tradeError?.stack,
                error: tradeError
            });
            throw tradeError; // Re-throw to be caught by outer catch
        }
        
        // Calculate execution time
        const executionTime = Date.now() - startTime;
        
        // Log successful trade
        logger.info('Trade executed successfully', {
            metadata: {
                tradeId: crypto.randomUUID(),
                action: tradeRequest.action,
                amount: tradeRequest.position_size,
                token: tradeRequest.ticker,
                executionTime: `${executionTime}ms`,
                txHash: result.signature,
                normalizedRequest,
                result
            }
        });

        // Track in PostHog with error handling
        try {
            client.capture({
                distinctId: 'trade',
                event: 'trade_completed',
                properties: {
                    action: tradeRequest.action,
                    amount: tradeRequest.position_size,
                    token: tradeRequest.ticker,
                    executionTime,
                    txHash: result.signature
                }
            });
        } catch (posthogError) {
            console.error('PostHog tracking error:', posthogError);
        }

        res.json({ status: 'success', data: result });

    } catch (error) {
        const executionTime = Date.now() - startTime;
        
        // Enhanced error logging
        console.error('Webhook error details:', {
            error
        });
        
        // Log error with full context
        logger.error('Trade execution failed', {
            metadata: {
                tradeId: crypto.randomUUID(),
                error: error?.message || 'Unknown error',
                stack: error?.stack,
                executionTime: `${executionTime}ms`,
                request: req.body
            }
        });

        res.status(500).json({ 
            status: 'error', 
            message: error?.message || 'Unknown error'
        });
    }
});

app.get('/', (req, res) => {
  // Track page view
  client.capture({
    distinctId: req.ip,
    event: 'page_view',
    properties: {
      path: '/',
      userAgent: req.headers['user-agent'],
      timestamp: new Date().toISOString()
    }
  })
  
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Add this function near the top with other utility functions
function displayStartupBanner(port) {
    console.log(chalk.green(figlet.textSync('SolTradeView', {
        font: 'Standard',
        horizontalLayout: 'default',
        verticalLayout: 'default'
    })));
    
    console.log(chalk.cyan('\n=== Server Configuration ==='));
    console.log(chalk.cyan('Environment:'), process.env.NODE_ENV);
    console.log(chalk.cyan('Port:'), port);
    console.log(chalk.cyan('RPC Endpoints:'), RPC_ENDPOINTS.length);
    console.log(chalk.cyan('========================\n'));
}

// Then the server startup code can use it
if (process.env.NODE_ENV === 'production') {
    // HTTP server for redirects
    const httpApp = express();
    httpApp.use((req, res) => {
        return res.redirect(301, `https://${req.headers.host}${req.url}`);
    });

    // Start HTTP server
    http.createServer(httpApp).listen(80, () => {
        displayStartupBanner(80);
        console.log(chalk.green('HTTP Server running on port 80 and redirecting to HTTPS'));
    });

    // Start HTTPS server
    https.createServer(credentials, app).listen(443, () => {
        displayStartupBanner(443);
        console.log(chalk.green('HTTPS Server running on port 443'));
        console.log(chalk.yellow(`Webhook URL: https://${process.env.DOMAIN}/webhook`));
        console.log(chalk.yellow('Dashboard:', `https://${process.env.DOMAIN}/dashboard.html`));
    });
} else {
    // Development server
    const port = process.env.PORT || 3000;
    app.listen(port, () => {
        displayStartupBanner(port);
        console.log(chalk.green(`Development server running on port ${port}`));
        console.log(chalk.yellow(`Webhook URL: http://localhost:${port}/webhook`));
        console.log('\nAvailable endpoints:');
        console.log(chalk.yellow('- Dashboard:', `http://localhost:${port}/dashboard.html`));
        console.log(chalk.yellow('- API:', `http://localhost:${port}/api/trades`));
    });
}

// Ensure events are sent before server shutdown
process.on('SIGTERM', async () => {
  await client.shutdown()
  process.exit(0)
})

// Log application startup
process.on('SIGTERM', () => {
  logger.info('Application shutting down');
  process.exit(0);
});

// Uncaught exception handler
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', {
    error: error.message,
    stack: error.stack
  });
  process.exit(1);
});

// Log startup
logger.verbose('Application started', {
  env: process.env.NODE_ENV,
  rpcEndpoint: process.env.SOLANA_RPC_ENDPOINT
});

// API endpoint for dashboard
app.get('/api/trades', async (req, res) => {
    try {
        // Read and parse the trades log file
        const trades = await new Promise((resolve, reject) => {
            const results = [];
            createReadStream(path.join(process.cwd(), 'logs', 'trades.log'))
                .pipe(split2())
                .on('data', (line) => {
                    try {
                        const log = JSON.parse(line);
                        if (log.message.includes('Trade executed successfully')) {
                            results.push({
                                timestamp: log.timestamp,
                                action: log.metadata.action,
                                amount: log.metadata.amount,
                                token: log.metadata.token,
                                price: log.metadata.price,
                                executionTime: log.metadata.executionTime,
                                txHash: log.metadata.txHash,
                                status: 'success'
                            });
                        }
                    } catch (e) {
                        // Skip invalid lines
                    }
                })
                .on('end', () => resolve(results))
                .on('error', reject);
        });

        res.json(trades);
    } catch (error) {
        logger.error('Error fetching trade data', { error });
        res.status(500).json({ error: 'Failed to fetch trade data' });
    }
});

app.get('/api/logs', async (req, res) => {
    try {
        const errorLogPath = path.join(__dirname, 'logs', 'error.log');
        const tradeLogPath = path.join(__dirname, 'logs', 'trades.log');
        
        const [errorLogs, tradeLogs] = await Promise.all([
            fs.promises.readFile(errorLogPath, 'utf8'),
            fs.promises.readFile(tradeLogPath, 'utf8')
        ]);

        const parseLogs = (content) => {
            const logs = [];
            let currentLog = '';
            let inJson = false;
            
            // Split by lines but preserve the original formatting
            const lines = content.split('\n');
            
            for (const line of lines) {
                if (line.match(/^\[\d{4}-\d{2}-\d{2}T/)) {
                    // New log entry starts
                    if (currentLog) {
                        try {
                            const parsed = parseLogEntry(currentLog);
                            if (parsed) logs.push(parsed);
                        } catch (e) {
                            console.debug('Failed to parse log entry:', e);
                        }
                    }
                    currentLog = line;
                } else {
                    // Continue current log entry
                    currentLog += '\n' + line;
                }
            }
            
            // Don't forget the last entry
            if (currentLog) {
                try {
                    const parsed = parseLogEntry(currentLog);
                    if (parsed) logs.push(parsed);
                } catch (e) {
                    console.debug('Failed to parse last log entry:', e);
                }
            }
            
            return logs;
        };

        const parseLogEntry = (entry) => {
            const match = entry.match(/^\[(.*?)\] (\w+): (.*[\s\S]*)/);
            if (!match) return null;

            const [_, timestamp, level, rest] = match;
            
            try {
                // Find the JSON part
                const jsonStart = rest.indexOf('{');
                const message = rest.substring(0, jsonStart).trim();
                const jsonStr = rest.substring(jsonStart);
                const data = JSON.parse(jsonStr);

                return {
                    timestamp,
                    type: level,
                    message,
                    metadata: data.metadata || {},
                    raw: entry // Keep the raw log for debugging
                };
            } catch (e) {
                console.debug('Error parsing JSON in log entry:', e);
                return {
                    timestamp,
                    type: level,
                    message: rest.trim(),
                    metadata: {},
                    raw: entry
                };
            }
        };

        const parsedErrorLogs = parseLogs(errorLogs);
        const parsedTradeLogs = parseLogs(tradeLogs);

        res.json({
            errorLogs: parsedErrorLogs.filter(log => log.type === 'ERROR'),
            tradeLogs: parsedTradeLogs.filter(log => log.type === 'INFO')
        });
    } catch (error) {
        console.error('Error loading logs:', error);
        res.status(500).json({ 
            error: 'Failed to load logs',
            details: error.message 
        });
    }
});

// Update the logs page route to use proper path resolution
app.get('/logs', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'logs.html'));
});

app.get('/health', async (req, res) => {
    try {
        const connection = new Connection(RPC_ENDPOINTS[currentRpcIndex], 'finalized');
        await connection.getSlot();
        res.json({ status: 'healthy' });
    } catch (error) {
        res.status(500).json({ status: 'unhealthy', error: error.message });
    }
});