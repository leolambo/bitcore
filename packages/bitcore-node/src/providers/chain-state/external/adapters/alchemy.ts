// src/providers/chain-state/external/adapters/alchemy.ts
// Stub adapter - will be fully implemented in Task 6

import { IIndexedAPIAdapter, AdapterTransactionParams, AdapterStreamParams, AdapterBlockByDateParams } from './IIndexedAPIAdapter';
import { IEVMTransactionTransformed } from '../../evm/types';
import { ExternalApiStream } from '../streams/apiStream';

export class AlchemyAdapter implements IIndexedAPIAdapter {
  readonly name = 'Alchemy';
  readonly supportedChains: string[];

  constructor(_config: any) {
    this.supportedChains = ['ETH', 'MATIC', 'ARB', 'BASE', 'OP'];
  }

  async getTransaction(_params: AdapterTransactionParams): Promise<IEVMTransactionTransformed | undefined> {
    throw new Error('AlchemyAdapter.getTransaction not implemented');
  }

  streamAddressTransactions(_params: AdapterStreamParams): ExternalApiStream {
    throw new Error('AlchemyAdapter.streamAddressTransactions not implemented');
  }

  streamERC20Transfers(_params: AdapterStreamParams & { tokenAddress: string }): ExternalApiStream {
    throw new Error('AlchemyAdapter.streamERC20Transfers not implemented');
  }

  async getBlockNumberByDate(_params: AdapterBlockByDateParams): Promise<number> {
    throw new Error('AlchemyAdapter.getBlockNumberByDate not implemented');
  }

  async healthCheck(): Promise<boolean> {
    throw new Error('AlchemyAdapter.healthCheck not implemented');
  }
}
