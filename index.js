import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { rpcWithRetry, fetchWithRetry } from './lib/retry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import dotenv from 'dotenv';
import { Wallet } from '@project-serum/anchor';
import bs58 from 'bs58';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Define multiple RPC endpoints
const RPC_ENDPOINTS = [
  {
    http: 'https://mainnet.helius-rpc.com/?api-key=292afef7-e149-4010-862b-f611beb385fc',
    ws: 'wss://mainnet.helius-rpc.com/?api-key=292afef7-e149-4010-862b-f611beb385fc'
  }
];

// Create connection pool with optimized settings for Helius
const connectionPool = RPC_ENDPOINTS.map(endpoint => 
  new Connection(endpoint.http, {
    commitment: 'confirmed',
    httpHeaders: { 'Cache-Control': 'no-cache' },
    confirmTransactionInitialTimeout: 60000,
    wsEndpoint: endpoint.ws
  })
);

let currentConnectionIndex = 0;

// Function to get next connection
function getNextConnection() {
  currentConnectionIndex = (currentConnectionIndex + 1) % connectionPool.length;
  return connectionPool[currentConnectionIndex];
}

const wallet = new Wallet(Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY || '')));

const INPUT_MINT = 'So11111111111111111111111111111111111111112'; // SOL
const OUTPUT_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
const SLIPPAGE_BPS = 300; // 3%

const SEND_OPTIONS = {
  skipPreflight: true,
  maxRetries: 3,
  preflightCommitment: 'confirmed'
};

async function calculateTradeAmount(inputMint, action, quote) {
  try {
    const minBalanceSol = 0.1;
    const estimatedTxFeeSol = 0.001;

    console.log('Calculate Trade Amount Inputs:', {
      inputMint,
      action,
      quote,
      minBalanceSol,
      estimatedTxFeeSol
    });

    if (action === 'buy' && inputMint === OUTPUT_MINT) { 
      console.log('Calculating buy amount with USDC...');
      const tokenAccounts = await rpcWithRetry(
        async (connection) => 
          connection.getTokenAccountsByOwner(wallet.publicKey, {
            mint: new PublicKey(inputMint),
          })
        , connectionPool, currentConnectionIndex
      );

      console.log('Found token accounts:', tokenAccounts.value.length);

      let totalUsdcBalance = 0;
      for (const account of tokenAccounts.value) {
        const accountInfo = await rpcWithRetry(
          async (connection) => 
            connection.getParsedAccountInfo(account.pubkey)
          , connectionPool, currentConnectionIndex
        );
        const tokenAmount = accountInfo.value?.data?.parsed?.info?.tokenAmount;
        console.log('Token account info:', {
          pubkey: account.pubkey.toString(),
          tokenAmount
        });

        if (tokenAmount) {
          totalUsdcBalance += Number(tokenAmount.amount);
        }
      }

      if (totalUsdcBalance === 0) {
        console.log('❌ No USDC balance available for trade');
        throw new Error('Insufficient USDC balance for trade');
      }

      console.log(`💰 Total Available USDC: ${(totalUsdcBalance / 1e6).toFixed(2)} USDC`);
      const tradeAmountUsdc = Math.min(totalUsdcBalance, quote.inAmount);
      console.log(`🔄 Trading USDC for SOL: ${(tradeAmountUsdc / 1e6).toFixed(2)}`);
      
      if (tradeAmountUsdc <= 0) {
        throw new Error('Trade amount calculation resulted in 0 or negative value');
      }

      return Math.floor(tradeAmountUsdc);
    }

    console.log('Calculating sell amount with SOL...');
    // Sell SOL to get USDC
    const balance = await rpcWithRetry(
      async (connection) => 
        connection.getBalance(wallet.publicKey)
      , connectionPool, currentConnectionIndex
    );
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

    console.log('❌ No matching trade condition found:', {
      action,
      inputMint,
      quoteInputMint: quote.inputMint,
      quoteOutputMint: quote.outputMint
    });
    return 0;
  } catch (error) {
    console.error('💥 Error calculating trade amount:', error);
    throw error;
  }
}

/**
 * Fetch quote from Jupiter API
 */
async function getQuote(amount, action = 'sell') {
  try {
    const [inputMint, outputMint] = action === 'buy' 
      ? [OUTPUT_MINT, INPUT_MINT]
      : [INPUT_MINT, OUTPUT_MINT];

    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}&restrictIntermediateTokens=true`;
    console.log('Quote URL:', url);
    const response = await fetchWithRetry(url);
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
    const response = await fetchWithRetry('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: {
          minBps: 50,
          maxBps: SLIPPAGE_BPS
        },
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            maxLamports: 10000000,
            priorityLevel: "veryHigh"
          }
        }
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

// Update the sendTransaction function to handle responses better
// async function sendTransaction(serializedTransaction) {
//   try {
//     const response = await fetch('https://worker.jup.ag/send-transaction', {
//       method: 'POST',
//       headers: {
//         'Accept': 'application/json',
//         'Content-Type': 'application/json'
//       },
//       body: JSON.stringify({
//         transaction: serializedTransaction
//       })
//     });

//     // Check if response is ok before parsing JSON
//     if (!response.ok) {
//       const errorText = await response.text();
//       throw new Error(`Jupiter API error: ${errorText}`);
//     }

//     const data = await response.json();
//     return data;
//   } catch (error) {
//     console.error('Error sending transaction through Jupiter:', error);
//     return { success: false, error: error.message };
//   }
// }

// Update sendAndConfirmTransaction to handle errors better
async function sendAndConfirmTransaction({ serializedTransaction, blockhashWithExpiryBlockHeight }) {
  try {
    // Fallback to direct RPC
    const signature = await rpcWithRetry(
      async (connection) => connection.sendRawTransaction(serializedTransaction, SEND_OPTIONS),
      connectionPool,
      currentConnectionIndex
    );
    console.log('Transaction sent through RPC. Signature:', signature);

    // Wait for confirmation
    const confirmation = await rpcWithRetry(
      async (connection) => connection.confirmTransaction({
        signature,
        blockhash: blockhashWithExpiryBlockHeight.blockhash,
        lastValidBlockHeight: blockhashWithExpiryBlockHeight.lastValidBlockHeight
      }),
      connectionPool,
      currentConnectionIndex
    );

    if (confirmation?.value?.err) {
      throw new Error(`Transaction failed: ${confirmation.value.err}`);
    }

    console.log('Transaction confirmed:', signature);
    return signature;
  } catch (error) {
    console.error('Transaction failed:', error);
    throw error;
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
      const errorMessage = action === 'buy' 
        ? 'Insufficient USDC balance for trade' 
        : 'Insufficient SOL balance for trade';
      throw new Error(errorMessage);
    }

    console.log(`Proceeding with trade: ${tradeAmount} ${action === 'buy' ? 'USDC' : 'lamports'}`);

    // Get final quote for the actual trade amount
    const quoteResponse = await getQuote(tradeAmount, action);
    console.log('Quote response:', quoteResponse);

    const swapTransaction = await getSwapTransaction(quoteResponse);
    console.log('Swap transaction received.');

    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    const latestBlockhash = await connectionPool[currentConnectionIndex].getLatestBlockhash();
    transaction.message.recentBlockhash = latestBlockhash.blockhash;
    transaction.sign([wallet.payer]);

    const serializedTransaction = transaction.serialize();

    await sendAndConfirmTransaction({
      serializedTransaction,
      blockhashWithExpiryBlockHeight: latestBlockhash,
    });

    res.json({ status: 'success' });
  } catch (error) {
    console.error('Error processing swap:', error);
    res.status(400).json({ 
      status: 'error', 
      message: error.message,
      details: {
        action: req.body.action,
        order_size: req.body.order_size,
        position_size: req.body.position_size
      }
    });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});