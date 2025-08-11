import logger from '../../../logger';
import { CoinEvent, EventStorage } from '../../../models/events';
import { WalletAddressStorage } from '../../../models/walletAddress';
import { BaseSVMStateProvider } from '../../../providers/chain-state/svm/api/csp';
import { BaseP2PWorker } from '../../../services/p2p';
import { wait } from '../../../utils';

interface SolanaSubscription {
  subscriptionId: number | null;
  address: string;
  commitment: 'confirmed' | 'finalized';
  isActive: boolean;
  lastSeen: Date;
}

class SubscriptionManager {
  private subscriptions = new Map<string, SolanaSubscription>();
  private connection: any;
  private chainNetworkStr: string;
  private isHealthy: boolean = true;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;

  constructor(
    chain: string,
    network: string,
    private onTransactionNotification: (signature: string, address: string) => Promise<void>
  ) {
    this.chainNetworkStr = `${chain}:${network}`;
  }

  async initialize(connection: any) {
    this.connection = connection;
    logger.info(`SubscriptionManager initialized for ${this.chainNetworkStr}`);
  }

  async subscribeToAddress(address: string, commitment: 'confirmed' | 'finalized' = 'confirmed') {
    if (!this.connection) {
      throw new Error('Connection not initialized');
    }

    const subscriptionKey = `${address}:${commitment}`;

    if (this.subscriptions.has(subscriptionKey)) {
      logger.debug(`Already subscribed to ${address} with ${commitment} commitment`);
      return;
    }

    try {
      const subscriptionId = await this.connection.logsSubscribe(
        { mentions: [address] },
        { commitment }
      );

      // Store subscription info
      this.subscriptions.set(subscriptionKey, {
        subscriptionId,
        address,
        commitment,
        isActive: true,
        lastSeen: new Date()
      });

      logger.info(`Subscribed to ${address} logs with ${commitment} commitment (ID: ${subscriptionId})`);

      // Set up notification handler
      this.connection.on('logsNotification', async (notification: any) => {
        if (notification.subscription === subscriptionId) {
          const { signature } = notification.result.value;
          logger.debug(`Log notification received for ${address}: ${signature}`);

          // Update last seen
          const sub = this.subscriptions.get(subscriptionKey);
          if (sub) {
            sub.lastSeen = new Date();
          }

          try {
            await this.onTransactionNotification(signature, address);
          } catch (error) {
            logger.error(`Error processing transaction notification for ${signature}:`, error);
          }
        }
      });

      this.isHealthy = true;
      this.reconnectAttempts = 0;

    } catch (error) {
      logger.error(`Failed to subscribe to ${address}:`, error);
      this.handleSubscriptionError(error);
      throw error;
    }
  }

  async unsubscribeFromAddress(address: string, commitment: 'confirmed' | 'finalized' = 'confirmed') {
    const key = `${address}:${commitment}`;
    const subscription = this.subscriptions.get(key);

    if (!subscription || subscription.subscriptionId === null) {
      return;
    }

    try {
      await this.connection.logsUnsubscribe(subscription.subscriptionId);
      this.subscriptions.delete(key);
      logger.info(`Unsubscribed from ${address} logs (ID: ${subscription.subscriptionId})`);
    } catch (error) {
      logger.error(`Failed to unsubscribe from ${address}:`, error);
    }
  }

  private handleSubscriptionError(error: any) {
    this.isHealthy = false;
    logger.error(`Subscription error for ${this.chainNetworkStr}:`, error);

    // Mark all subscriptions as inactive
    for (const [, sub] of this.subscriptions.entries()) {
      sub.isActive = false;
    }
  }

  async reconnect(newConnection: any) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error(`Max reconnection attempts reached for ${this.chainNetworkStr}`);
      return false;
    }

    this.reconnectAttempts++;
    this.connection = newConnection;

    try {
      // Resubscribe to all previous addresses
      const oldSubscriptions = Array.from(this.subscriptions.values());
      this.subscriptions.clear();

      for (const oldSub of oldSubscriptions) {
        await this.subscribeToAddress(oldSub.address, oldSub.commitment);
      }

      logger.info(`Successfully reconnected and resubscribed for ${this.chainNetworkStr}`);
      return true;
    } catch (error) {
      logger.error(`Failed to reconnect for ${this.chainNetworkStr}:`, error);
      return false;
    }
  }

  getActiveSubscriptions(): SolanaSubscription[] {
    return Array.from(this.subscriptions.values()).filter(sub => sub.isActive);
  }

  isSubscriptionHealthy(): boolean {
    return this.isHealthy;
  }

  async cleanup() {
    logger.info(`Cleaning up subscriptions for ${this.chainNetworkStr}`);

    for (const [subscriptionKey, subscription] of this.subscriptions.entries()) {
      try {
        if (subscription.subscriptionId !== null) {
          await this.connection?.logsUnsubscribe(subscription.subscriptionId);
        }
      } catch (error) {
        logger.error(`Error cleaning up subscription ${subscriptionKey}:`, error);
      }
    }

    this.subscriptions.clear();
  }
}

export class SolanaP2PWorker extends BaseP2PWorker {
  private csp: BaseSVMStateProvider;
  private subscriptionManager: SubscriptionManager;
  private syncInterval?: NodeJS.Timeout;
  private healthCheckInterval?: NodeJS.Timeout;
  private addressRefreshInterval?: NodeJS.Timeout;

  constructor({ chain, network, chainConfig }) {
    super({ chain, network, chainConfig });
    this.chain = chain || 'SOL';
    this.network = network;
    this.csp = new BaseSVMStateProvider(this.chain);

    // Initialize subscription manager
    this.subscriptionManager = new SubscriptionManager(
      this.chain,
      this.network,
      this.onTransactionNotification.bind(this)
    );
  }

  async start() {
    logger.info(`Starting Solana P2P worker for ${this.chain}:${this.network}`);

    try {
      // Initialize RPC connection
      await this.initializeConnection();

      // Start syncing
      this.refreshSyncingNode();

    } catch (error) {
      logger.error('Failed to start Solana P2P worker:', error);
      throw error;
    }
  }

  async stop() {
    logger.info(`Stopping Solana P2P worker for ${this.chain}:${this.network}`);

    this.stopping = true;

    // Clear intervals
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = undefined;
    }

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }

    if (this.addressRefreshInterval) {
      clearInterval(this.addressRefreshInterval);
      this.addressRefreshInterval = undefined;
    }

    // Cleanup subscriptions
    await this.subscriptionManager.cleanup();

    // Unregister as syncing node
    await this.unregisterSyncingNode();
  }

  async sync() {
    if (this.stopping || !this.isSyncingNode) {
      return;
    }

    logger.info(`Starting sync for ${this.chain}:${this.network}`);

    try {
      // Start address monitoring
      await this.startAddressMonitoring();

      // Start periodic health checks
      this.startHealthCheck();

      logger.info(`Sync completed for ${this.chain}:${this.network}`);

    } catch (error) {
      logger.error(`Sync failed for ${this.chain}:${this.network}:`, error);
      // Retry sync after delay
      await wait(5000);
      this.sync();
    }
  }

  private async initializeConnection() {
    try {
      const { connection } = await this.csp.getRpc(this.network);

      // Initialize subscription manager with connection
      await this.subscriptionManager.initialize(connection);

      logger.info(`RPC connection established for ${this.chain}:${this.network}`);
    } catch (error) {
      logger.error('Failed to initialize RPC connection:', error);
      throw error;
    }
  }

  private async startAddressMonitoring() {
    // Subscribe to active wallet addresses
    await this.subscribeToActiveAddresses();

    // Set up periodic address refresh
    this.addressRefreshInterval = setInterval(async () => {
      if (!this.stopping && this.isSyncingNode) {
        await this.refreshAddressSubscriptions();
      }
    }, 60000); // Check every minute
  }

  private async subscribeToActiveAddresses() {
    try {
      // Get recently active Solana wallet addresses
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const activeAddresses = await WalletAddressStorage.collection.find({
        chain: this.chain,
        network: this.network,
        lastQueryTime: { $gte: oneHourAgo }
      }).toArray();

      logger.info(`Found ${activeAddresses.length} active addresses to monitor`);

      for (const walletAddress of activeAddresses) {
        try {
          await this.subscriptionManager.subscribeToAddress(walletAddress.address, 'confirmed');
        } catch (error) {
          logger.error(`Failed to subscribe to address ${walletAddress.address}:`, error);
        }
      }

    } catch (error) {
      logger.error('Failed to subscribe to active addresses:', error);
    }
  }

  private async refreshAddressSubscriptions() {
    try {
      // Get current active addresses
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const currentActiveAddresses = await WalletAddressStorage.collection.find({
        chain: this.chain,
        network: this.network,
        lastQueryTime: { $gte: oneHourAgo }
      }).toArray();

      const currentActiveAddressSet = new Set(currentActiveAddresses.map(addr => addr.address));
      const currentSubscriptions = this.subscriptionManager.getActiveSubscriptions();
      const currentlySubscribedSet = new Set(currentSubscriptions.map(sub => sub.address));

      // Subscribe to new addresses
      for (const address of currentActiveAddressSet) {
        if (!currentlySubscribedSet.has(address)) {
          try {
            await this.subscriptionManager.subscribeToAddress(address, 'confirmed');
            logger.info(`Subscribed to new active address: ${address}`);
          } catch (error) {
            logger.error(`Failed to subscribe to new address ${address}:`, error);
          }
        }
      }

      // Unsubscribe from inactive addresses
      for (const subscription of currentSubscriptions) {
        if (!currentActiveAddressSet.has(subscription.address)) {
          try {
            await this.subscriptionManager.unsubscribeFromAddress(subscription.address, subscription.commitment);
            logger.info(`Unsubscribed from inactive address: ${subscription.address}`);
          } catch (error) {
            logger.error(`Failed to unsubscribe from address ${subscription.address}:`, error);
          }
        }
      }

    } catch (error) {
      logger.error('Failed to refresh address subscriptions:', error);
    }
  }

  private startHealthCheck() {
    this.healthCheckInterval = setInterval(async () => {
      if (this.stopping || !this.isSyncingNode) {
        return;
      }

      if (!this.subscriptionManager.isSubscriptionHealthy()) {
        logger.warn(`Subscription unhealthy for ${this.chain}:${this.network}, attempting reconnect`);
        await this.handleConnectionReconnect();
      }
    }, 30000); // Check every 30 seconds
  }

  private async handleConnectionReconnect() {
    try {
      // Get fresh connection
      const { connection } = await this.csp.getRpc(this.network);

      // Attempt reconnection
      const success = await this.subscriptionManager.reconnect(connection);

      if (success) {
        logger.info(`Successfully reconnected for ${this.chain}:${this.network}`);
      } else {
        logger.error(`Failed to reconnect for ${this.chain}:${this.network}`);
      }
    } catch (error) {
      logger.error('Connection reconnect failed:', error);
    }
  }

  private async onTransactionNotification(signature: string, address: string) {
    try {
      logger.debug(`Processing transaction notification: ${signature} for address: ${address}`);

      // Get transaction details using existing CSP
      const transaction = await this.csp.getTransaction({
        txId: signature,
        network: this.network,
        chain: this.chain
      });

      if (!transaction) {
        logger.warn(`Transaction not found: ${signature}`);
        return;
      }

      // Transform transaction for event emission
      const coinEvent: CoinEvent = {
        coin: {
          chain: this.chain,
          network: this.network,
          mintTxid: signature,
          mintIndex: 0,
          mintHeight: transaction.height || 0,
          coinbase: false,
          value: transaction.satoshis || 0,
          address,
          script: Buffer.from(''),
          wallets: [],
          spentTxid: '',
          spentHeight: 0
        },
        address
      };

      // Emit address coin event for real-time processing
      await EventStorage.signalAddressCoin(coinEvent);

      logger.info(`Emitted coin event for transaction ${signature} on address ${address}`);

    } catch (error) {
      logger.error(`Failed to process transaction notification ${signature}:`, error);
    }
  }
}