import axios from 'axios';
import { CONFIG } from '../config/config';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('Alchemy');

// Types untuk Alchemy response
interface AlchemyTransaction {
  blockNum: string;
  uniqueId: string;
  hash: string;
  from: string;
  to: string;
  value: number;
  erc721TokenId: string | null;
  erc1155Metadata: string | null;
  tokenId: string | null;
  asset: string;
  category: 'external' | 'internal' | 'token' | 'erc721' | 'erc1155' | 'erc20';
  rawContract: {
    value: string;
    address: string | null;
    decimal: string | null;
  };
}

interface AssetTransfer {
  category: string;
  from: string;
  to: string;
  tokenAddress?: string;
  value: number;
  asset?: string;
  hash: string;
  metadata?: {
    blockTimestamp: string;
  };
}

export class AlchemyClient {
  private apiKey: string;
  private baseUrl: string;

  constructor() {
    this.apiKey = CONFIG.ALCHEMY_API_KEY;
    this.baseUrl = `${CONFIG.ALCHEMY_RPC_URL}/${this.apiKey}`;
  }

  /**
   * Check if Alchemy is configured
   */
  isConfigured(): boolean {
    return !!this.apiKey;
  }

  // Get asset transfers (menggantikan getTransactions yang deprecated)
  async getAssetTransfers(address: string, limit: number = CONFIG.ALCHEMY_TRANSFER_LIMIT): Promise<AssetTransfer[]> {
    try {
      // Alchemy v2 method
      const response = await axios.post(this.baseUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'alchemy_getAssetTransfers',
        params: [
          {
            fromBlock: '0x0',
            toBlock: 'latest',
            fromAddress: address,
            category: ['external', 'token'],
            maxCount: limit.toString(16), // hex
            withMetadata: true,
            excludeZeroValue: true
          }
        ]
      });

      if (response.data.error) {
        logger.error(`Alchemy error: ${JSON.stringify(response.data.error)}`);
        return [];
      }

      const transfers = response.data.result?.transfers || [];
      
      return transfers.map((t: AlchemyTransaction) => ({
        category: t.category,
        from: t.from,
        to: t.to,
        tokenAddress: t.rawContract?.address || undefined,
        value: t.value,
        asset: t.asset,
        hash: t.hash,
        metadata: {
          blockTimestamp: new Date().toISOString()
        }
      }));
    } catch (error) {
      logger.error(`Error fetching Alchemy transfers: ${error}`);
      return [];
    }
  }

  // Cek 100 transaksi terakhir untuk analisa inang
  async analyzeInangHistory(address: string): Promise<{
    totalTx: number;
    pumpTx: number;
    buyCount: number;
    sellCount: number;
    totalVolume: number;
    avgTradeSize: number;
    timestamps: Date[];
  }> {
    try {
      const transfers = await this.getAssetTransfers(address, 100);
      
      let pumpTx = 0;
      let buyCount = 0;
      let sellCount = 0;
      let totalVolume = 0;
      const tradeSizes: number[] = [];
      const timestamps: Date[] = [];

      for (const tx of transfers) {
        // Check if Pump.fun related (via token or known patterns)
        if (tx.tokenAddress || tx.category === 'token') {
          pumpTx++;
          
          // BUY = received tokens, SELL = sent tokens
          if (tx.to.toLowerCase() === address.toLowerCase()) {
            buyCount++;
          } else if (tx.from.toLowerCase() === address.toLowerCase()) {
            sellCount++;
          }
          
          if (tx.value) {
            totalVolume += tx.value;
            tradeSizes.push(tx.value);
          }
          
          if (tx.metadata?.blockTimestamp) {
            timestamps.push(new Date(tx.metadata.blockTimestamp));
          }
        }
      }

      const avgTradeSize = tradeSizes.length > 0 
        ? tradeSizes.reduce((a, b) => a + b, 0) / tradeSizes.length 
        : 0;

      return {
        totalTx: transfers.length,
        pumpTx,
        buyCount,
        sellCount,
        totalVolume,
        avgTradeSize,
        timestamps
      };
    } catch (error) {
      logger.error(`Error analyzing inang history: ${error}`);
      return {
        totalTx: 0,
        pumpTx: 0,
        buyCount: 0,
        sellCount: 0,
        totalVolume: 0,
        avgTradeSize: 0,
        timestamps: []
      };
    }
  }

  // Check if address is active on Pump.fun
  async isPumpTrader(address: string, minTrades: number = CONFIG.PUMP_TRADER_MIN_TRADES): Promise<boolean> {
    const analysis = await this.analyzeInangHistory(address);
    return analysis.pumpTx >= minTrades;
  }
}

export const alchemyClient = new AlchemyClient();
