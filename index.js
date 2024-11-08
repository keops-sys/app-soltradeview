import express from 'express';
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
import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
  TransactionExpiredBlockheightExceededError,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import { Wallet } from '@project-serum/anchor';
import bs58 from 'bs58';
dotenv.config();

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

// Create an EventEmitter for RPC events
const rpcEvents = new EventEmitter();

// Create connection with retry and event emission
const createRateLimitedConnection = () => {
    const maxRetries = 3;
    const baseDelay = 1000;

    return new Connection(process.env.SOLANA_RPC_ENDPOINT, {
        commitment: 'confirmed',
        async fetchMiddleware(url, options, fetch) {
            for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                    return await fetch(url, options);
                } catch (error) {
                    if (error) {
                        const delay = baseDelay * Math.pow(2, attempt);
                        
                        // Emit rate limit event
                        rpcEvents.emit('rateLimitHit', {
                            retryIn: delay,
                            attempt: attempt + 1,
                            endpoint: url
                        });

                        logger.warn('Rate limit hit', {
                            retryIn: delay,
                            attempt: attempt + 1,
                            endpoint: url
                        });

                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }
                    throw error;
                }
            }
            throw new Error(`Failed after ${maxRetries} attempts due to rate limits`);
        }
    });
};

const connection = createRateLimitedConnection();
const wallet = new Wallet(Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY || '')));

const INPUT_MINT = 'So11111111111111111111111111111111111111112'; // SOL
const OUTPUT_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
const SLIPPAGE_BPS = 300; // 3%

const SEND_OPTIONS = {
  skipPreflight: true,
  maxRetries: 3,
  computeUnits: 1_000_000,    
  priorityFee: 10_000_000,    // 0.01 SOL priority fee
};

async function calculateTradeAmount(inputMint, action, quote) {
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

    if (!quote || typeof quote.inAmount === 'undefined' || typeof quote.outAmount === 'undefined') {
      console.log('⚠️ Quote object:', quote);
      console.log('⚠️ Quote object is missing or malformed. Aborting trade calculation.');
      return 0;
    }

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

          // Use the min of USDC balance or inAmount from the quote
          const tradeAmountUsdc = Math.min(usdcBalance, quote.inAmount);
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

/**
 * Fetch quote from Jupiter API
 */
async function getQuote(amount, action = 'sell') {
  try {
    // Swap mints based on action
    const [inputMint, outputMint] = action === 'buy' 
      ? [OUTPUT_MINT, INPUT_MINT]   // For buy: USDC -> SOL
      : [INPUT_MINT, OUTPUT_MINT];  // For sell: SOL -> USDC

    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}`;
    console.log('Quote URL:', url);
    const response = await fetch(url);
    return await response.json();
  } catch (error) {
    console.error('Error fetching quote:', error);
    throw error;
  }
}

/**
 * Fetch swap transaction from Jupiter API
 */
async function getSwapTransaction(quoteResponse) {
  try {
    const response = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicSlippage: { maxBps: SLIPPAGE_BPS },
      }),
    });
    const swapData = await response.json();
    if (swapData.error) throw new Error(swapData.error);
    return swapData.swapTransaction;
  } catch (error) {
    console.error('Error fetching swap transaction:', error);
    throw error;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function abortableResender(connection, serializedTransaction, abortSignal) {
  while (true) {
    await wait(2000);
    if (abortSignal.aborted) return;
    try {
      await connection.sendRawTransaction(serializedTransaction, SEND_OPTIONS);
    } catch (e) {
      console.warn(`Failed to resend transaction: ${e}`);
    }
  }
}

async function sendAndConfirmTransaction({ connection, serializedTransaction, blockhashWithExpiryBlockHeight }) {
  const controller = new AbortController();
  const abortSignal = controller.signal;
  const maxRetries = 3;

  try {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Get fresh blockhash for each attempt
        const latestBlockhash = await connection.getLatestBlockhash('confirmed');
        
        const signature = await connection.sendRawTransaction(
          serializedTransaction,
          {
            ...SEND_OPTIONS,
            preflightCommitment: 'confirmed'
          }
        );
        console.log(`Attempt ${attempt + 1}: Transaction sent. Signature:`, signature);

        // Start resender in background
        abortableResender(connection, serializedTransaction, abortSignal);

        // Wait for confirmation with shorter timeout
        const confirmation = await connection.confirmTransaction({
          signature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
        }, 'confirmed');

        if (confirmation.value.err) {
          throw new Error(`Transaction failed: ${confirmation.value.err}`);
        }

        console.log(`Transaction successful: https://solscan.io/tx/${signature}`);
        return signature;
      } catch (error) {
        console.error(`Attempt ${attempt + 1} failed:`, error);
        if (attempt === maxRetries - 1) throw error;
        // Wait before retry
        await wait(2000);
      }
    }
  } finally {
    controller.abort();
  }
}

/**
 * Handle incoming swap requests via webhook
 */
app.post('/webhook', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { action, amount, token, price } = req.body;
    
    // Log trade request
    logger.info('Trade request received', {
      action,
      amount,
      token,
      price,
      timestamp: new Date().toISOString()
    });

    // Check balance
    const balance = await connection.getBalance(wallet.publicKey);
    logger.debug('Current balance', {
      balance: balance / LAMPORTS_PER_SOL,
      minRequired: MIN_SOL_BALANCE
    });

    if (balance / LAMPORTS_PER_SOL < MIN_SOL_BALANCE) {
      logger.error('Insufficient balance', {
        balance: balance / LAMPORTS_PER_SOL,
        minRequired: MIN_SOL_BALANCE
      });
      throw new Error('Insufficient balance');
    }

    // Execute trade
    const result = await executeTrade(action, amount, token, price);
    
    // Calculate execution time
    const executionTime = Date.now() - startTime;
    
    // Log successful trade
    logger.info('Trade executed successfully', {
      action,
      amount,
      token,
      price,
      executionTime: `${executionTime}ms`,
      txHash: result.signature,
      blockTime: result.blockTime,
      fee: result.fee,
      slot: result.slot
    });

    // Track in PostHog
    client.capture({
      distinctId: 'trade',
      event: 'trade_completed',
      properties: {
        action,
        amount,
        token,
        price,
        executionTime,
        txHash: result.signature
      }
    });

    res.json({ status: 'success', data: result });

  } catch (error) {
    const executionTime = Date.now() - startTime;
    
    // Log error with full context
    logger.error('Trade execution failed', {
      error: error.message,
      stack: error.stack,
      executionTime: `${executionTime}ms`,
      request: req.body
    });

    res.status(500).json({ status: 'error', message: error.message });
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

const displayStartupBanner = (port) => {
    console.log('\n');
    console.log(chalk.cyan(figlet.textSync('SolTradeView', { horizontalLayout: 'full' })));
    console.log('\n');
    
    const isDev = process.env.NODE_ENV !== 'production';
    const domain = process.env.DOMAIN || 'soltradeview.com'; // Fallback domain
    
    console.log(chalk.blue('Mode:'), isDev ? chalk.yellow('Development') : chalk.green('Production'));
    console.log(chalk.blue('Server:'), chalk.green(`Running on port ${port}`));
    console.log(chalk.blue('RPC Endpoint:'), chalk.gray(process.env.SOLANA_RPC_ENDPOINT));
    console.log('\n');
    
    console.log(chalk.white.bold('Available Endpoints:'));
    const baseUrl = isDev ? 
        `http://localhost:${port}` : 
        `https://${domain}`;
        
    console.log(chalk.red(`• Webhook:   ${baseUrl}/webhook`));
    console.log(chalk.yellow(`• Dashboard: ${baseUrl}/dashboard.html`));
    console.log(chalk.yellow(`• API:       ${baseUrl}/api/trades`));
    console.log('\n');
    
    if (isDev) {
        console.log(chalk.gray('Press Ctrl+C to stop the server'));
        console.log('\n');
    }
};



// Ensure events are sent before server shutdown
process.on('SIGTERM', async () => {
  await client.shutdown()
  process.exit(0)
})

// Listen for rate limit events
rpcEvents.on('rateLimitHit', ({ retryIn, attempt, endpoint }) => {
    logger.warn('Rate limit hit', {
        retryIn: `${retryIn}ms`,
        attempt,
        endpoint: process.env.SOLANA_RPC_ENDPOINT
    });
});

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
logger.info('Application started', {
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





// Server setup based on environment
if (process.env.NODE_ENV === 'production') {
  // HTTP server for redirects
  const httpApp = express();
  httpApp.use((req, res) => {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  });

  // Start HTTP server
  http.createServer(httpApp).listen(80, () => {
    console.log(chalk.green('HTTP Server running on port 80 and redirecting to HTTPS'));
  });

  // Start HTTPS server
  https.createServer(credentials, app).listen(443, () => {
    console.log(chalk.green('HTTPS Server running on port 443'));
    console.log(chalk.yellow(`Webhook URL: https://${process.env.DOMAIN}/webhook`));
    console.log(chalk.yellow('Dashboard:', `https://${process.env.DOMAIN}/dashboard.html`));

  });
} else {
  // Development server
  app.listen(3000, () => {
    console.log(chalk.green('Development server running on port 3000'));
    console.log(chalk.red('Webhook URL: http://localhost:3000/webhook'));
    console.log('\nAvailable endpoints:');
    console.log(chalk.yellow('- Dashboard:', 'http://localhost:3000/dashboard.html'));
    console.log(chalk.yellow('- API:', 'http://localhost:3000/api/trades'));
  });
}