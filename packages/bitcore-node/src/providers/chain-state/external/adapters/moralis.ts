// src/providers/chain-state/external/adapters/moralis.ts
// Stub adapter - will be fully implemented in Task 5

import { IIndexedAPIAdapter, AdapterTransactionParams, AdapterStreamParams, AdapterBlockByDateParams } from './IIndexedAPIAdapter';
import { IEVMTransactionTransformed } from '../../evm/types';
import { ExternalApiStream } from '../streams/apiStream';

export class MoralisAdapter implements IIndexedAPIAdapter {
  readonly name = 'Moralis';
  readonly supportedChains: string[];

  constructor(_config: any) {
    this.supportedChains = ['ETH', 'MATIC', 'ARB', 'BASE', 'OP'];
  }

  async getTransaction(_params: AdapterTransactionParams): Promise<IEVMTransactionTransformed | undefined> {
    throw new Error('MoralisAdapter.getTransaction not implemented');
  }

  streamAddressTransactions(_params: AdapterStreamParams): ExternalApiStream {
    throw new Error('MoralisAdapter.streamAddressTransactions not implemented');
  }

  streamERC20Transfers(_params: AdapterStreamParams & { tokenAddress: string }): ExternalApiStream {
    throw new Error('MoralisAdapter.streamERC20Transfers not implemented');
  }

  async getBlockNumberByDate(_params: AdapterBlockByDateParams): Promise<number> {
    throw new Error('MoralisAdapter.getBlockNumberByDate not implemented');
  }

  async healthCheck(): Promise<boolean> {
    throw new Error('MoralisAdapter.healthCheck not implemented');
  }
}
