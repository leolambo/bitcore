// src/providers/chain-state/external/adapters/moralis.ts

import axios, { AxiosError } from 'axios';
import { IIndexedAPIAdapter, AdapterTransactionParams, AdapterStreamParams, AdapterBlockByDateParams } from './IIndexedAPIAdapter';
import { IEVMTransactionTransformed } from '../../evm/types';
import { EVMTransactionStorage } from '../../evm/models/transaction';
import { ExternalApiStream } from '../streams/apiStream';
import { Web3 } from '@bitpay-labs/crypto-wallet-core';
import { NotFoundError, InvalidRequestError, AuthError, RateLimitError, TimeoutError, UpstreamError } from './errors';

const TX_HASH_REGEX = /^0x[0-9a-fA-F]{64}$/;

export class MoralisAdapter implements IIndexedAPIAdapter {
  readonly name = 'Moralis';
  readonly supportedChains = ['ETH', 'MATIC', 'BASE', 'ARB', 'OP'];

  private apiKey: string;
  private baseUrl = 'https://deep-index.moralis.io/api/v2.2';
  private headers: Record<string, string>;
  private requestTimeout: number;

  constructor(config: { apiKey: string; requestTimeout?: number }) {
    if (!config.apiKey) throw new Error('MoralisAdapter: apiKey is required');
    this.apiKey = config.apiKey;
    this.requestTimeout = config.requestTimeout ?? 30000;
    this.headers = {
      'Content-Type': 'application/json',
      'X-API-Key': this.apiKey
    };
  }

  async getTransaction(params: AdapterTransactionParams): Promise<IEVMTransactionTransformed | undefined> {
    const { chain, network, chainId, txId } = params;

    // Validate txId format before making external call
    if (!TX_HASH_REGEX.test(txId)) {
      throw new InvalidRequestError(this.name, `invalid txId format: ${txId}`);
    }

    const query = this._buildQueryString({ chain: this._formatChainId(chainId), include: 'internal_transactions' });

    try {
      const response = await axios.get(
        `${this.baseUrl}/transaction/${txId}${query}`,
        { headers: this.headers, timeout: this.requestTimeout }
      );
      if (!response.data) return undefined;
      return this._transformTransaction({ chain, network, ...response.data });
    } catch (error) {
      if (error instanceof InvalidRequestError) throw error;
      if (axios.isAxiosError(error) && (error as AxiosError).response?.status === 404) {
        return undefined; // Not found - return undefined per interface contract
      }
      this._classifyError(error); // Throws typed error for other failures
    }
  }

  streamAddressTransactions(params: AdapterStreamParams): ExternalApiStream {
    const { chainId, chain, network, address, args } = params;
    const query = this._transformQueryParams({ chainId, args });
    const queryStr = this._buildQueryString({
      ...query,
      order: args.order || 'DESC',
      limit: args.pageSize || 10,
      include: 'internal_transactions'
    });

    // Set up transform on args (ExternalApiStream reads args.transform)
    const streamArgs = {
      ...args,
      transform: (tx: any) => {
        const _tx: any = this._transformTransaction({ chain, network, ...tx });
        const confirmations = args.tipHeight ? args.tipHeight - _tx.blockHeight + 1 : 0;
        return EVMTransactionStorage._apiTransform({ ..._tx, confirmations }, { object: true });
      }
    };

    return new ExternalApiStream(
      `${this.baseUrl}/${address}${queryStr}`,
      this.headers,
      streamArgs
    );
  }

  streamERC20Transfers(params: AdapterStreamParams & { tokenAddress: string }): ExternalApiStream {
    const { chainId, chain, network, address, tokenAddress, args } = params;
    const query = this._transformQueryParams({ chainId, args });
    const queryStr = this._buildQueryString({
      ...query,
      order: args.order || 'DESC',
      limit: args.pageSize || 10,
      contract_addresses: [tokenAddress]
    });

    const streamArgs = {
      ...args,
      transform: (tx: any) => {
        const _tx: any = this._transformTokenTransfer({ chain, network, ...tx });
        const confirmations = args.tipHeight ? args.tipHeight - _tx.blockHeight + 1 : 0;
        return EVMTransactionStorage._apiTransform({ ..._tx, confirmations }, { object: true });
      }
    };

    return new ExternalApiStream(
      `${this.baseUrl}/${address}/erc20/transfers${queryStr}`,
      this.headers,
      streamArgs
    );
  }

  async getBlockNumberByDate(params: AdapterBlockByDateParams): Promise<number> {
    const { chainId, date } = params;
    const queryStr = this._buildQueryString({
      chain: this._formatChainId(chainId),
      date: new Date(date).getTime()
    });

    try {
      const response = await axios.get(
        `${this.baseUrl}/dateToBlock${queryStr}`,
        { headers: this.headers, timeout: this.requestTimeout }
      );
      return response.data.block as number;
    } catch (error) {
      this._classifyError(error);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Use a lightweight endpoint - web3 API info
      await axios.get(`${this.baseUrl}/web3/version`, {
        headers: this.headers,
        timeout: 5000
      });
      return true;
    } catch {
      return false;
    }
  }

  // --- Private transformation methods (extracted from MoralisStateProvider) ---

  private _transformTransaction(tx: any): IEVMTransactionTransformed {
    const transformed = {
      chain: tx.chain,
      network: tx.network,
      txid: tx.hash || tx.transaction_hash,
      blockHeight: Number(tx.block_number ?? tx.blockNumber),
      blockHash: tx.block_hash ?? tx.blockHash,
      blockTime: new Date(tx.block_timestamp ?? tx.blockTimestamp),
      blockTimeNormalized: new Date(tx.block_timestamp ?? tx.blockTimestamp),
      value: Number(tx.value ?? 0),
      gasLimit: Number(tx.gas ?? 0),
      gasPrice: Number(tx.gas_price ?? tx.gasPrice ?? 0),
      fee: Number(BigInt(tx.receipt_gas_used ?? tx.receiptGasUsed ?? 0) * BigInt(tx.gas_price ?? tx.gasPrice ?? 0)),
      nonce: tx.nonce,
      to: (tx.to_address ?? tx.toAddress) ? Web3.utils.toChecksumAddress(tx.to_address ?? tx.toAddress) : '',
      from: Web3.utils.toChecksumAddress(tx.from_address ?? tx.fromAddress),
      data: tx.input ? Buffer.from(String(tx.input).replace('0x', ''), 'hex') : Buffer.alloc(0),
      internal: [],
      calls: tx?.internal_transactions?.map((t: any) => this._transformInternalTransaction(t)) || [],
      effects: [],
      category: tx.category,
      wallets: [],
      transactionIndex: tx.transaction_index ?? tx.transactionIndex
    } as IEVMTransactionTransformed;
    EVMTransactionStorage.addEffectsToTxs([transformed]);
    return transformed;
  }

  private _transformInternalTransaction(tx: any) {
    return {
      from: Web3.utils.toChecksumAddress(tx.from),
      to: Web3.utils.toChecksumAddress(tx.to),
      gas: tx.gas,
      gasUsed: tx.gas_used,
      input: tx.input,
      output: tx.output,
      type: tx.type,
      value: tx.value,
      abiType: EVMTransactionStorage.abiDecode(tx.input)
    };
  }

  private _transformTokenTransfer(transfer: any) {
    const _transfer = this._transformTransaction(transfer);
    return {
      ..._transfer,
      transactionHash: transfer.transaction_hash,
      transactionIndex: transfer.transaction_index,
      contractAddress: transfer.contract_address ?? transfer.address,
      name: transfer.token_name
    };
  }

  private _transformQueryParams(params: { chainId: string | bigint; args: any }) {
    const { chainId, args } = params;
    const query: any = { chain: this._formatChainId(chainId) };
    if (args) {
      if (args.startBlock || args.endBlock) {
        if (args.startBlock) query.from_block = Number(args.startBlock);
        if (args.endBlock) query.to_block = Number(args.endBlock);
      } else {
        if (args.startDate) query.from_date = args.startDate;
        if (args.endDate) query.to_date = args.endDate;
      }
      if (args.direction) {
        query.order = Number(args.direction) > 0 ? 'ASC' : 'DESC';
      }
    }
    return query;
  }

  private _buildQueryString(params: Record<string, any>): string {
    const query: string[] = [];
    if (params.chain) params.chain = this._formatChainId(params.chain);
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          if (value[i] != null) query.push(`${key}%5B${i}%5D=${value[i]}`);
        }
      } else if (value != null) {
        query.push(`${key}=${value}`);
      }
    }
    return query.length ? `?${query.join('&')}` : '';
  }

  private _formatChainId(chainId: string | bigint): string {
    // Handle hex strings (e.g., '0x1'), decimal strings (e.g., '1'), and bigint
    try {
      const str = String(chainId);
      if (str.startsWith('0x')) return str; // Already hex
      return '0x' + BigInt(str).toString(16);
    } catch {
      throw new InvalidRequestError(this.name, `invalid chainId: ${chainId}`);
    }
  }

  /** Classify Moralis HTTP errors into typed adapter errors */
  private _classifyError(error: unknown): never {
    if (axios.isAxiosError(error)) {
      const status = (error as AxiosError).response?.status;
      if (status === 404) throw new NotFoundError(this.name, 'resource');
      if (status === 401 || status === 403) throw new AuthError(this.name);
      if (status === 429) throw new RateLimitError(this.name);
      if (error.code === 'ECONNABORTED') throw new TimeoutError(this.name, this.requestTimeout);
      if (status && status >= 500) throw new UpstreamError(this.name, status);
    }
    throw new UpstreamError(this.name, undefined, (error as Error)?.message);
  }
}
