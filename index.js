import { PostHog } from 'posthog-node'
const client = new PostHog(
  'phc_bSVQPOlxikcyh0ScYCZQNpCg6guWnYvVwAd2e5z8iHz',
  { host: 'https://eu.i.posthog.com' }
)
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import https from 'https';
import http from 'node:http';
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
import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
  TransactionExpiredBlockheightExceededError,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import dotenv from 'dotenv';
import { Wallet } from '@project-serum/anchor';
import bs58 from 'bs58';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Middleware to ensure www prefix
const ensureWWW = (req, res, next) => {
  // Get the host without port number if present
  const host = req.headers.host.split(':')[0];
  
  if (!host.startsWith('www.')) {
    // Redirect non-www to www while maintaining protocol
    const protocol = req.protocol;
    return res.redirect(301, `${protocol}://www.${host}${req.url}`);
  }
  next();
};

// Apply www redirect middleware to main app
app.use(ensureWWW);

// Replace the simple connection with a rate-limited connection handler
const createRateLimitedConnection = () => {
  const maxRetries = 3;
  const baseDelay = 1000; // 1 second

  return new Connection('https://api.mainnet-beta.solana.com', {
    commitment: 'confirmed',
    async fetchMiddleware(url, options, fetch) {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          return await fetch(url, options);
        } catch (error) {
          if (error) {
            const delay = baseDelay * Math.pow(2, attempt);
            console.log(`Rate limit hit, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
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
  try {
    console.log('Received alert, starting swap process.');
    console.log('Request body:', JSON.stringify(req.body, null, 2));

    const { action, order_size, position_size } = req.body;

    // Validate required fields
    if (!action || !order_size) {
      throw new Error('Missing required fields: action and order_size');
    }

    if (!['buy', 'sell'].includes(action)) {
      throw new Error('Invalid action: must be "buy" or "sell"');
    }

    // Get initial quote to determine price and amounts
    let initialAmount = action === 'buy' ? 1_000_000 : 1_000_000_000; // 1 USDC or 1 SOL for price check
    console.log('Getting initial price quote with amount:', initialAmount);
    const priceQuote = await getQuote(initialAmount, action);
    console.log('Price quote response:', priceQuote);
    
    // Calculate actual trade amount based on position size or percentage
    let tradeAmount;
    if (order_size === '100%') {
      console.log('Processing 100% order size...');
      // Use maximum available balance
      if (action === 'buy') {
        console.log('Creating quote for buying SOL with max USDC');
        const quote = {
          outputMint: INPUT_MINT,
          inAmount: Number.MAX_SAFE_INTEGER,
          outAmount: 0
        };
        tradeAmount = await calculateTradeAmount(OUTPUT_MINT, action, quote);
      } else {
        console.log('Creating quote for selling max SOL');
        const quote = {
          inputMint: INPUT_MINT,
          inAmount: Number.MAX_SAFE_INTEGER,
          outAmount: 0
        };
        tradeAmount = await calculateTradeAmount(INPUT_MINT, action, quote);
      }
    } else {
      console.log('Processing fixed position size:', position_size);
      // Use position_size if specified
      if (action === 'buy') {
        tradeAmount = Math.floor(parseFloat(position_size) * 1e6); // Convert USDC to decimals
        console.log('Converted USDC amount:', tradeAmount);
      } else {
        tradeAmount = Math.floor(parseFloat(position_size) * 1e9); // Convert SOL to lamports
        console.log('Converted SOL amount:', tradeAmount);
      }
    }

    console.log('Final calculated trade amount:', tradeAmount);
    if (tradeAmount === 0) {
      throw new Error('Trade amount calculation failed. Check balances and parameters.');
    }

    console.log(`Proceeding with trade: ${tradeAmount} ${action === 'buy' ? 'USDC' : 'lamports'}`);

    // Get final quote for the actual trade amount
    const quoteResponse = await getQuote(tradeAmount, action);
    console.log('Quote response:', quoteResponse);

    const swapTransaction = await getSwapTransaction(quoteResponse);
    console.log('Swap transaction received.');

    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    const latestBlockhash = await connection.getLatestBlockhash();
    transaction.message.recentBlockhash = latestBlockhash.blockhash;
    transaction.sign([wallet.payer]);

    const serializedTransaction = transaction.serialize();

    await sendAndConfirmTransaction({
      connection,
      serializedTransaction,
      blockhashWithExpiryBlockHeight: latestBlockhash,
    });

    res.json({ status: 'success' });
  } catch (error) {
    console.error('Error processing swap:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Server setup based on environment
if (process.env.NODE_ENV === 'production') {
  // HTTP server for redirects
  const httpApp = express();
  httpApp.use((req, res) => {
    const host = req.headers.host.split(':')[0];
    const wwwHost = host.startsWith('www.') ? host : `www.${host}`;
    return res.redirect(301, `https://${wwwHost}${req.url}`);
  });

  // Start HTTP server
  http.createServer(httpApp).listen(80, () => {
    console.log('HTTP Server running on port 80 and redirecting to HTTPS/WWW');
  });

  // Start HTTPS server
  https.createServer(credentials, app).listen(443, () => {
    console.log('HTTPS Server running on port 443');
  });
} else {
  // Development server
  app.listen(3000, () => {
    console.log('Development server running on port 3000');
  });
}