import { Cursor } from 'mongodb';
/*
import Web3 from '@solana/web3.js';
import { CryptoRpc } from 'crypto-rpc';
import { createSolanaRpcSubscriptions, RpcSubscriptions, SolanaRpcSubscriptionsApi } from '@solana/rpc-subscriptions';
import { address, Address } from '@solana/addresses';
*/
import logger/*, { timestamp }*/ from '../../../logger';
import { /* IWebhook  ,*/ WebhookStorage } from '../../../models/webhook';
import { BaseP2PWorker } from '../../../services/p2p';
import { IEVMNetworkConfig, IExternalSyncConfig } from '../../../types/Config';
import { IAddressSubscription } from '../../../types/ExternalProvider';
import { SOLStateProvider } from '../api/csp';

export class SolanaP2PWorker extends BaseP2PWorker {
  private chainConfig: IExternalSyncConfig<IEVMNetworkConfig>;
  private web3?: any;
  private syncInterval?: NodeJS.Timeout;
  private addressSub?: IAddressSubscription;
  private webhookTail?: Cursor;
  private bestSlot: number;
  private chainNetworkStr: string;
  private csp: SOLStateProvider;

  constructor({ chain, network, chainConfig }) {
    super({ chain, network, chainConfig });
    this.chain = chain;
    this.network = network;
    this.chainConfig = chainConfig;
    this.csp = new SOLStateProvider();
    this.addressSub = undefined;
    this.webhookTail = undefined;
    this.bestSlot = 0; // slot is synonmous with block here
    this.chainNetworkStr = `${this.chain}:${this.network}`;
  }

  async start() {
    this.refreshSyncingNode();


    // below is filler. ignore and delete
    this.subscribeToAccountActivity()
    this.syncAccountActivity()
    const {chainConfig, web3, syncInterval, addressSub, bestSlot, csp } = this;
    return { chainConfig, web3, syncInterval, addressSub, bestSlot, csp };
  }

  async stop() {

  }

  async getRPC() {}
  
  async sync(): Promise<void> {}
  
  private async subscribeToAccountActivity() {}

  private async syncAccountActivity() {
    // if this is a reconnect, remove old listeners
    this.webhookTail?.removeAllListeners();
    this.webhookTail = WebhookStorage.getTail({ chain: this.chain, network: this.network });
    logger.info(`Webhook tail initiated for ${this.chainNetworkStr}`);
  }

  
}