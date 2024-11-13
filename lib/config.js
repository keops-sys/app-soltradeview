import { Wallet } from '@project-serum/anchor';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { PostHog } from 'posthog-node';
import dotenv from 'dotenv';
import { logger } from './logger.js';

// Ensure environment variables are loaded
dotenv.config();

export const RPC_ENDPOINTS = [
  {
    http: 'https://mainnet.helius-rpc.com/?api-key=292afef7-e149-4010-862b-f611beb385fc',
    ws: 'wss://mainnet.helius-rpc.com/?api-key=292afef7-e149-4010-862b-f611beb385fc'
  },
  {
    http: 'https://solana-mainnet.core.chainstack.com/514be15fa4a3676212b0f8f2f11ab308',
    ws: 'wss://solana-mainnet.core.chainstack.com/514be15fa4a3676212b0f8f2f11ab308'
  }
];

// Initialize wallet from private key
let wallet;
try {
  if (!process.env.PRIVATE_KEY) {
    throw new Error('PRIVATE_KEY environment variable is not set');
  }
  
  const privateKeyBytes = bs58.decode(process.env.PRIVATE_KEY);
  wallet = Keypair.fromSecretKey(new Uint8Array(privateKeyBytes));
  
//   logger.info('Wallet initialized ✅', {
//     publicKey: wallet.publicKey.toString(),
//     type: 'Keypair'
//   });
} catch (error) {
  logger.error('Failed to initialize wallet ❌', {
    error: error.message,
    stack: error.stack
  });
  throw error; // Fail fast if wallet initialization fails
}

export { wallet };

// Validate wallet on export
if (!wallet?.publicKey) {
  logger.warn('⚠️  Warning: Wallet not properly initialized', {
    hasWallet: !!wallet,
    env: process.env.NODE_ENV
  });
}

export const analytics = new PostHog(
  'phc_bSVQPOlxikcyh0ScYCZQNpCg6guWnYvVwAd2e5z8iHz',
  { 
    host: 'https://eu.i.posthog.com',
    flushAt: 1,
    flushInterval: 0
  }
); 