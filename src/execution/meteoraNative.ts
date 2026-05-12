import axios from 'axios';
import BN from 'bn.js';
import { ComputeBudgetProgram, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import DLMM from '@meteora-ag/dlmm';
import { logger } from '../utils/logger';
import { NativeSwapParams, NativeSwapResult } from './nativeTypes';

interface DexScreenerPair {
  dexId?: string;
  pairAddress?: string;
  liquidity?: { usd?: number };
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
}

const DEXSCREENER_TOKEN_ENDPOINT = 'https://api.dexscreener.com/latest/dex/tokens';

async function findBestMeteoraPair(mint: string): Promise<string | null> {
  const response = await axios.get(`${DEXSCREENER_TOKEN_ENDPOINT}/${mint}`, {
    timeout: 10_000,
  });

  const pairs: DexScreenerPair[] = response.data?.pairs ?? [];
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return null;
  }

  const best = pairs
    .filter(pair => pair.dexId?.toLowerCase().includes('meteora') && pair.pairAddress)
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];

  return best?.pairAddress ?? null;
}

async function executeMeteoraTx(params: NativeSwapParams, tx: any): Promise<string> {
  const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: params.priorityFeeMicroLamports,
  });

  tx.instructions = [priorityIx, ...tx.instructions];
  tx.feePayer = params.keypair.publicKey;

  const { blockhash, lastValidBlockHeight } = await params.connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.sign(params.keypair);

  const signature = await params.connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: params.maxRetries,
  });

  const confirmation = await params.connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed'
  );

  if (confirmation.value.err) {
    throw new Error(`Meteora native transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  return signature;
}

export async function executeMeteoraNativeSwap(params: NativeSwapParams): Promise<NativeSwapResult> {
  try {
    const pairAddress = await findBestMeteoraPair(params.mint);
    if (!pairAddress) {
      return { success: false, error: 'meteora_pair_not_found', dex: 'meteora_native' };
    }

    const dlmmPool = await DLMM.create(params.connection, new PublicKey(pairAddress));
    await dlmmPool.refetchStates();

    const inputMint = new PublicKey(params.inputMint);
    const outputMint = new PublicKey(params.outputMint);
    const amountIn = new BN(params.amountInRaw);
    const swapForY = inputMint.equals(dlmmPool.tokenX.publicKey);

    if (!inputMint.equals(dlmmPool.tokenX.publicKey) && !inputMint.equals(dlmmPool.tokenY.publicKey)) {
      return { success: false, error: 'meteora_input_mint_not_in_pair', poolId: pairAddress, dex: 'meteora_native' };
    }

    if (!outputMint.equals(dlmmPool.tokenX.publicKey) && !outputMint.equals(dlmmPool.tokenY.publicKey)) {
      return { success: false, error: 'meteora_output_mint_not_in_pair', poolId: pairAddress, dex: 'meteora_native' };
    }

    const binArrays = await dlmmPool.getBinArrayForSwap(swapForY);
    const quote = dlmmPool.swapQuote(
      amountIn,
      swapForY,
      new BN(params.slippageBps),
      binArrays,
      false
    );

    logger.info(`[MeteoraNative] pair=${pairAddress} input=${amountIn.toString()} minOut=${quote.minOutAmount.toString()}`);

    const tx = await dlmmPool.swap({
      inToken: inputMint,
      outToken: outputMint,
      inAmount: amountIn,
      minOutAmount: quote.minOutAmount,
      lbPair: dlmmPool.pubkey,
      user: params.keypair.publicKey,
      binArraysPubkey: quote.binArraysPubkey,
    });

    const txHash = await executeMeteoraTx(params, tx);
    return { success: true, txHash, poolId: pairAddress, dex: 'meteora_native' };
  } catch (error: any) {
    const errorMsg = error?.message ?? String(error);
    logger.error(`[MeteoraNative] Failed: ${errorMsg}`);
    return { success: false, error: errorMsg, dex: 'meteora_native' };
  }
}
