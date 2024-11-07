import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import https from 'https';
import http from 'node:http';
// Load SSL certificates
const privateKey = fs.readFileSync('/root/.acme.sh/soltradeview.com_ecc/soltradeview.com.key', 'utf8');
const certificate = fs.readFileSync('/root/.acme.sh/soltradeview.com_ecc/fullchain.cer', 'utf8');
const ca = fs.readFileSync('/root/.acme.sh/soltradeview.com_ecc/ca.cer', 'utf8');
const credentials = {
  key: privateKey,
  cert: certificate,
  ca: ca,
};


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

const connection = new Connection('https://solana-mainnet.core.chainstack.com/514be15fa4a3676212b0f8f2f11ab308');
const wallet = new Wallet(Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY || '')));

const INPUT_MINT = 'So11111111111111111111111111111111111111112'; // SOL
const OUTPUT_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
const SLIPPAGE_BPS = 300; // 3%

const SEND_OPTIONS = {
  skipPreflight: true,
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

  try {
    const signature = await connection.sendRawTransaction(serializedTransaction, SEND_OPTIONS);
    console.log('Transaction sent. Signature:', signature);

    abortableResender(connection, serializedTransaction, abortSignal);

    await connection.confirmTransaction(
      {
        signature,
        ...blockhashWithExpiryBlockHeight,
      },
      'confirmed'
    );

    console.log(`Transaction successful: https://solscan.io/tx/${signature}`);
    return signature;
  } catch (error) {
    console.error('Transaction failed:', error);
    throw error;
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

const httpsServer = https.createServer(credentials, app);

httpsServer.listen(443, () => {
  console.log('HTTPS Server running on port 443');
});


const httpApp = express();
httpApp.use((req, res) => {
  res.redirect(`https://${req.headers.host}${req.url}`);
});

http.createServer(httpApp).listen(80, () => {
  console.log('HTTP Server running on port 80 and redirecting to HTTPS');
});