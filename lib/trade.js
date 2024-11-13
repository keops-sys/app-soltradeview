import { Connection, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { rpcWithRetry, fetchWithRetry } from './retry.js';
import fetch from 'node-fetch';
import  { logger } from './logger.js';

// Constants
export const INPUT_MINT = 'So11111111111111111111111111111111111111112'; // SOL
export const OUTPUT_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
export const SLIPPAGE_BPS = 300; // 3%
export const SEND_OPTIONS = {
  skipPreflight: true,
  maxRetries: 3,
  preflightCommitment: 'confirmed'
};

/**
 * Creates a connection pool with optimized settings
 * @param {Array} RPC_ENDPOINTS - Array of RPC endpoint configurations
 * @returns {Array<Connection>} Array of configured connections
 */
export function createConnectionPool(RPC_ENDPOINTS) {
  return RPC_ENDPOINTS.map(endpoint => 
    new Connection(endpoint.http, {
      commitment: 'confirmed',
      httpHeaders: { 'Cache-Control': 'no-cache' },
      confirmTransactionInitialTimeout: 60000,
      wsEndpoint: endpoint.ws
    })
  );
}

/**
 * Main trade execution function
 * @param {Object} params - Trade parameters
 * @returns {Promise<string>} Transaction signature
 */
export async function executeTrade({ tradeId, action, order_size, wallet, connectionPool, currentConnectionIndex }) {
  const startTime = Date.now();
  logger.debug('Starting trade execution', { 
    tradeId,
    action, 
    order_size, 
    walletPublicKey: wallet?.publicKey?.toString() 
  });
  
  if (!action || !order_size) {
    logger.error('Missing required fields', { action, order_size });
    throw new Error('Missing required fields: action and order_size');
  }

  if (!['buy', 'sell'].includes(action)) {
    logger.error('Invalid action provided', { action });
    throw new Error('Invalid action: must be "buy" or "sell"');
  }

  try {
    // Get initial quote for price check
    let initialAmount = action === 'buy' ? 1_000_000 : 1_000_000_000;
    logger.debug('Getting initial price quote', {
      tradeId,
      initialAmount,
      action
    });
    const priceQuote = await getQuote(initialAmount, action);
    logger.debug('Received price quote', { priceQuote });
    
    // Calculate actual trade amount
    const tradeAmount = await calculateTradeAmount({
      tradeId,
      action,
      order_size,
      wallet,
      connectionPool,
      currentConnectionIndex
    });

    // Get final quote for actual trade
    const quoteResponse = await getQuote(tradeAmount, action);
    logger.debug('Received final quote', { quoteResponse });

    // Get and process swap transaction
    const swapTransaction = await getSwapTransaction(quoteResponse, wallet);
    logger.debug('Requesting swap transaction', {
      tradeId,
      quoteResponse,
      walletPublicKey: wallet?.publicKey?.toString()
    });
    logger.debug('Swap transaction received', {
      tradeId,
      size: swapTransaction.length,
      walletPublicKey: wallet?.publicKey?.toString()
    });

    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    // Get latest blockhash and sign transaction
    const latestBlockhash = await connectionPool[currentConnectionIndex].getLatestBlockhash();
    transaction.message.recentBlockhash = latestBlockhash.blockhash;

    try {

      
      // For versioned transactions
      if (transaction.version === 0) {
        // Legacy transaction
        transaction.sign([wallet]);
      } else {
        // Versioned transaction
        transaction.sign([wallet]);
      }
      


    } catch (error) {
      logger.error('Failed to sign transaction ❌', {
        error: error.message,
        walletPublicKey: wallet?.publicKey?.toString(),
        transactionVersion: transaction.version
      });
      throw error;
    }

    // Send and confirm transaction
    const signature = await sendAndConfirmTransaction({
      serializedTransaction: transaction.serialize(),
      blockhashWithExpiryBlockHeight: latestBlockhash,
      connectionPool,
      currentConnectionIndex
    });

    const executionTime = Date.now() - startTime;

    const tradeResult = {
      success: true,
      signature,
      details: {
        action,
        amount: tradeAmount,
        price: quoteResponse.price,
        token: action === 'buy' ? 'SOL' : 'USDC',
        timestamp: new Date().toISOString(),
        executionTime: `${executionTime}ms`
      }
    };


    return tradeResult;

  } catch (error) {
    const executionTime = Date.now() - startTime;
    
    logger.error('Trade execution failed', {
      tradeId,
      error: error.message,
      stack: error.stack,
      params: {
        action,
        order_size,
        walletPublicKey: wallet?.publicKey?.toString()
      },
      timestamp: new Date().toISOString(),
      executionTime: `${executionTime}ms`
    });

    throw error;
  }
}

/**
 * Calculates the trade amount based on parameters
 */
async function calculateTradeAmount({ tradeId, action, order_size, wallet, connectionPool, currentConnectionIndex }) {
  let tradeAmount;
  
  if (order_size === '100%') {
    // logger.info('Processing 100% order size...', { tradeId });

    if (action === 'buy') {
      const usdcBalance = await getTokenBalance(OUTPUT_MINT, wallet, connectionPool, currentConnectionIndex);
    //   logger.info('Available USDC balance:', {
    //     tradeId,
    //     balance: usdcBalance.toString(),
    //     currency: 'USDC'
    //   });
      tradeAmount = usdcBalance;
    } else {
      const solBalance = await connectionPool[currentConnectionIndex].getBalance(wallet.publicKey);
    //   logger.info('Available SOL balance:', {
    //     tradeId,
    //     balance: solBalance.toString(),
    //     currency: 'lamports'
    //   });
      tradeAmount = Math.max(0, solBalance - 0.05 * LAMPORTS_PER_SOL); // Leave some SOL for fees
    }
  } else {
    logger.info('Processing fixed order size', {
      tradeId,
      order_size
    });

    if (!order_size || isNaN(parseFloat(order_size))) {
      throw new Error(`Invalid order size: ${order_size}`);
    }
    
    if (action === 'buy') {
      tradeAmount = Math.floor(parseFloat(order_size) * 1e6); // USDC decimals
    } else {
      tradeAmount = Math.floor(parseFloat(order_size) * LAMPORTS_PER_SOL); // SOL to lamports
    }
    
    logger.info('Trade amount calculated', {
      tradeId,
      tradeAmount: tradeAmount.toString(),
      currency: action === 'buy' ? 'USDC' : 'lamports'
    });
  }

  if (!tradeAmount || tradeAmount <= 0) {
    throw new Error(`Insufficient ${action === 'buy' ? 'USDC' : 'SOL'} balance for trade`);
  }

  return tradeAmount;
}

/**
 * Gets token balance for a specific mint
 */
async function getTokenBalance(mint, wallet, connectionPool, currentConnectionIndex) {
  try {
    const connection = connectionPool[currentConnectionIndex];
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      mint: new PublicKey(mint)
    });
    
    if (tokenAccounts.value.length === 0) {
      return 0;
    }
    
    return tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
  } catch (error) {
    logger.error('Failed to get token balance', {
      error: error.message,
      mint,
      walletPublicKey: wallet.publicKey.toString()
    });
    throw error;
  }
}

/**
 * Gets quote from Jupiter API
 */
async function getQuote(amount, action = 'sell') {
  try {
    const [inputMint, outputMint] = action === 'buy' 
      ? [OUTPUT_MINT, INPUT_MINT]
      : [INPUT_MINT, OUTPUT_MINT];

    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}&restrictIntermediateTokens=true`;
    logger.debug('Fetching quote', { url });
    
    const response = await fetchWithRetry(url);
    const quote = await response.json();
    
    logger.debug('Quote received', { quote });
    return quote;
  } catch (error) {
    logger.error('Failed to fetch quote', { 
      error: error.message, 
      amount, 
      action 
    });
    throw error;
  }
}

/**
 * Gets swap transaction from Jupiter API
 */
async function getSwapTransaction(quoteResponse, wallet) {
  try {
    logger.debug('Requesting swap transaction', { 
      quoteResponse,
      walletPublicKey: wallet.publicKey.toString()
    });

    const response = await fetchWithRetry('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            maxLamports: 10000000,
            priorityLevel: "veryHigh"
          }
        }
      }),
    });
    
    const swapData = await response.json();
    if (swapData.error) {
      logger.error('Swap transaction request failed', { error: swapData.error });
      throw new Error(swapData.error);
    }
    
    logger.debug('Swap transaction received', { 
      transactionSize: swapData.swapTransaction.length 
    });
    return swapData.swapTransaction;
  } catch (error) {
    logger.error('Failed to get swap transaction', { 
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

/**
 * Sends and confirms a transaction
 */
async function sendAndConfirmTransaction({ serializedTransaction, blockhashWithExpiryBlockHeight, connectionPool, currentConnectionIndex }) {
  try {
    const signature = await rpcWithRetry(
      async (connection) => connection.sendRawTransaction(serializedTransaction, SEND_OPTIONS),
      connectionPool,
      currentConnectionIndex
    );
    console.log('⏳ Transaction sent. Signature:', signature);

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
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    console.log('✅ Transaction confirmed:', signature);
    return signature;
  } catch (error) {
    console.error('😡 Transaction failed:', error);
    throw error;
  }
} 