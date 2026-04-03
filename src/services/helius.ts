import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import axios from 'axios';
import { CONFIG } from '../config/config';
import { createModuleLogger } from '../utils/logger';
import { lamportsToSol } from '../utils/math';

const logger = createModuleLogger('Helius');

export class HeliusClient {
  private connection: Connection;
  private apiKey: string;
  private baseUrl: string;

  constructor() {
    this.apiKey = CONFIG.HELIUS_API_KEY;
    this.baseUrl = `${CONFIG.HELIUS_RPC_URL}/?api-key=${this.apiKey}`;
    this.connection = new Connection(this.baseUrl, 'confirmed');
  }

  /**
   * Check if Helius is configured
   */
  isConfigured(): boolean {
    return !!this.apiKey;
  }

  getConnection(): Connection {
    return this.connection;
  }

  // Get SOL balance
  async getSolBalance(address: string): Promise<number> {
    try {
      const pubkey = new PublicKey(address);
      const balance = await this.connection.getBalance(pubkey);
      return lamportsToSol(balance);
    } catch (error) {
      logger.error(`Error fetching SOL balance: ${error}`);
      return 0;
    }
  }

  // Get token accounts
  async getTokenAccounts(ownerAddress: string, mintAddress?: string): Promise<any[]> {
    try {
      const pubkey = new PublicKey(ownerAddress);
      
      const response = await axios.post(this.baseUrl, {
        jsonrpc: '2.0',
        id: 'helius',
        method: 'getTokenAccounts',
        params: {
          owner: ownerAddress,
          mint: mintAddress,
          options: { showMetadata: true }
        }
      });

      return response.data.result?.tokenAccounts || [];
    } catch (error) {
      logger.error(`Error fetching token accounts: ${error}`);
      return [];
    }
  }

  // Get token balance
  async getTokenBalance(ownerAddress: string, mintAddress: string): Promise<number> {
    try {
      const accounts = await this.getTokenAccounts(ownerAddress, mintAddress);
      if (accounts.length === 0) return 0;
      
      const balance = accounts[0].amount;
      const decimals = accounts[0].decimals || 6;
      return balance / Math.pow(10, decimals);
    } catch (error) {
      logger.error(`Error fetching token balance: ${error}`);
      return 0;
    }
  }

  // Get transaction history
  async getTransactionHistory(address: string, limit: number = 100): Promise<any[]> {
    try {
      const response = await axios.post(this.baseUrl, {
        jsonrpc: '2.0',
        id: 'helius',
        method: 'getSignaturesForAddress',
        params: [address, { limit }]
      });

      const signatures = response.data.result || [];
      const txs = [];

      for (const sig of signatures.slice(0, 20)) { // Parse top 20
        try {
          const txResponse = await axios.post(this.baseUrl, {
            jsonrpc: '2.0',
            id: 'helius',
            method: 'getTransaction',
            params: [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
          });
          
          if (txResponse.data.result) {
            txs.push(txResponse.data.result);
          }
        } catch (e) {
          // Skip failed tx fetch
        }
      }

      return txs;
    } catch (error) {
      logger.error(`Error fetching transaction history: ${error}`);
      return [];
    }
  }

  // Parse Pump.fun transactions from history
  async parsePumpTrades(address: string): Promise<any[]> {
    const txs = await this.getTransactionHistory(address, 50);
    const trades = [];

    for (const tx of txs) {
      try {
        const logs = tx.meta?.logMessages?.join(' ') || '';
        
        // Detect Pump.fun program
        if (logs.includes('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')) {
          const preBalances = tx.meta?.preBalances || [];
          const postBalances = tx.meta?.postBalances || [];
          const balanceChange = (postBalances[0] - preBalances[0]) / LAMPORTS_PER_SOL;
          
          trades.push({
            signature: tx.transaction?.signatures?.[0],
            timestamp: tx.blockTime ? new Date(tx.blockTime * 1000) : new Date(),
            balanceChange,
            type: balanceChange < 0 ? 'BUY' : 'SELL',
            success: tx.meta?.err === null
          });
        }
      } catch (e) {
        // Skip invalid tx
      }
    }

    return trades;
  }

  /**
   * Get Helius connection (used by TradeEngine for sending transactions)
   * Actual sendTransaction using connection.sendRawTransaction in TradeEngine
   */
  getHeliusConnection(): Connection {
    return this.connection;
  }
}

export const heliusClient = new HeliusClient();
