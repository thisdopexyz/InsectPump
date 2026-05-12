import { Keypair, Connection } from '@solana/web3.js';

export interface NativeSwapContext {
  connection: Connection;
  keypair: Keypair;
  slippageBps: number;
  priorityFeeMicroLamports: number;
  maxRetries: number;
}

export interface NativeSwapResult {
  success: boolean;
  txHash?: string;
  error?: string;
  poolId?: string;
  dex?: 'raydium_native' | 'meteora_native';
}

export interface NativeSwapParams extends NativeSwapContext {
  mint: string;
  amountInRaw: string;
  inputMint: string;
  outputMint: string;
}
