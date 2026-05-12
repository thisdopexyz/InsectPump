import axios from 'axios';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { Raydium, TxVersion, AMM_V4, CREATE_CPMM_POOL_PROGRAM } from '@raydium-io/raydium-sdk-v2';
import { logger } from '../utils/logger';
import { NativeSwapParams, NativeSwapResult } from './nativeTypes';

interface RaydiumPoolApiItem {
  id: string;
  programId: string;
  type?: string;
  pooltype?: string[];
  tvl?: number;
}

let raydiumInstance: any | null = null;

const RAYDIUM_API_V3 = 'https://api-v3.raydium.io';
const RAYDIUM_API_POOL_ENDPOINT = `${RAYDIUM_API_V3}/pools/info/list-v2`;
const AMM_V4_PROGRAM = AMM_V4.toBase58();
const CPMM_PROGRAM = CREATE_CPMM_POOL_PROGRAM.toBase58();

async function getRaydium(params: NativeSwapParams): Promise<any> {
  if (raydiumInstance) {
    return raydiumInstance;
  }

  raydiumInstance = await Raydium.load({
    connection: params.connection,
    owner: params.keypair,
    disableLoadToken: true,
    disableFeatureCheck: true,
  });

  return raydiumInstance;
}

async function findBestPool(inputMint: string, outputMint: string): Promise<RaydiumPoolApiItem | null> {
  const response = await axios.get(RAYDIUM_API_POOL_ENDPOINT, {
    timeout: 10_000,
    params: {
      size: 20,
      mint1: inputMint,
      mint2: outputMint,
      sortField: 'liquidity',
      sortType: 'desc',
    },
  });

  const pools: RaydiumPoolApiItem[] = response.data?.data?.data ?? [];
  if (!Array.isArray(pools) || pools.length === 0) {
    return null;
  }

  return pools
    .filter(pool => pool.programId === AMM_V4_PROGRAM || pool.programId === CPMM_PROGRAM)
    .sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0))[0] ?? null;
}

async function executeTx(txData: any, params: NativeSwapParams): Promise<string> {
  if (typeof txData?.execute !== 'function') {
    throw new Error('Raydium SDK did not return executable transaction data');
  }

  const executed = await txData.execute({
    skipPreflight: false,
    sendAndConfirm: false,
  });

  const signature = executed?.txId;
  if (!signature) {
    throw new Error('Raydium native transaction sent without txId');
  }

  const { blockhash, lastValidBlockHeight } = await params.connection.getLatestBlockhash('confirmed');
  const confirmation = await params.connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed'
  );

  if (confirmation.value.err) {
    throw new Error(`Raydium native transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  return signature;
}

export async function executeRaydiumNativeSwap(params: NativeSwapParams): Promise<NativeSwapResult> {
  try {
    const pool = await findBestPool(params.inputMint, params.outputMint);
    if (!pool) {
      return { success: false, error: 'raydium_pool_not_found', dex: 'raydium_native' };
    }

    const raydium = await getRaydium(params);
    const amountIn = new BN(params.amountInRaw);
    const inputMint = new PublicKey(params.inputMint);
    const outputMint = new PublicKey(params.outputMint);
    const slippage = params.slippageBps / 10_000;
    const computeBudgetConfig = {
      units: 400_000,
      microLamports: params.priorityFeeMicroLamports,
    };

    logger.info(`[RaydiumNative] pool=${pool.id} program=${pool.programId} input=${amountIn.toString()}`);

    if (pool.programId === CPMM_PROGRAM) {
      const poolData = await raydium.cpmm.getPoolInfoFromRpc(pool.id);
      const poolInfo = poolData.poolInfo;
      const poolKeys = poolData.poolKeys;
      const poolRpcData = poolData.poolRpcData ?? poolData.rpcData ?? poolData;
      const baseIn = params.inputMint === poolInfo.mintA.address;
      const quote = raydium.cpmm.computeSwapAmount({
        pool: { ...poolInfo, ...poolRpcData },
        amountIn,
        outputMint,
        slippage,
        swapBaseIn: true,
      });

      const txData = await raydium.cpmm.swap({
        poolInfo,
        poolKeys,
        payer: params.keypair.publicKey,
        baseIn,
        inputAmount: amountIn,
        swapResult: quote.swapResult,
        slippage,
        txVersion: TxVersion.V0,
        computeBudgetConfig,
        config: {
          associatedOnly: false,
          checkCreateATAOwner: true,
        },
      });

      const txHash = await executeTx(txData, params);
      return { success: true, txHash, poolId: pool.id, dex: 'raydium_native' };
    }

    if (pool.programId === AMM_V4_PROGRAM) {
      const { poolInfo, poolKeys } = await raydium.liquidity.getPoolInfoFromRpc({ poolId: pool.id });
      const quote = raydium.liquidity.computeAmountOut({
        poolInfo,
        amountIn,
        mintIn: inputMint,
        mintOut: outputMint,
        slippage,
      });

      const txData = await raydium.liquidity.swap({
        poolInfo,
        poolKeys,
        amountIn,
        amountOut: quote.minAmountOut ?? quote.amountOut,
        inputMint: params.inputMint,
        fixedSide: 'in',
        txVersion: TxVersion.V0,
        computeBudgetConfig,
        config: {
          associatedOnly: false,
          inputUseSolBalance: true,
          outputUseSolBalance: true,
        },
      });

      const txHash = await executeTx(txData, params);
      return { success: true, txHash, poolId: pool.id, dex: 'raydium_native' };
    }

    return { success: false, error: `raydium_pool_program_unsupported_${pool.programId}`, poolId: pool.id, dex: 'raydium_native' };
  } catch (error: any) {
    const errorMsg = error?.message ?? String(error);
    logger.error(`[RaydiumNative] Failed: ${errorMsg}`);
    return { success: false, error: errorMsg, dex: 'raydium_native' };
  }
}
