/**
 * Polygon (MATIC) Module - LOCAL P2P + MONGODB IMPLEMENTATION
 *
 * NOTE! POLYGON CURRENTLY OPERATES LIKE ETHEREUM LAYER 1:
 * This module uses local P2P blockchain syncing and MongoDB storage, similar to the
 * Ethereum module. Polygon is architecturally a Layer 2 chain, but is NOT currently
 * using the Moralis module like other L2s (BASE, ARB, OP).
 *
 * CURRENT ARCHITECTURE:
 * - Uses EVMP2pWorker for local blockchain synchronization
 * - Uses MATICStateProvider which extends BaseEVMStateProvider (local MongoDB queries)
 * - Requires ~27 TB storage (20.8 TB data + 6.2 TB Matic DB)
 * - Same infrastructure overhead as Ethereum Layer 1
 *
 * MIGRATION OPPORTUNITY:
 * Polygon IS supported by Moralis and QuickNode. To migrate to external provider:
 * 1. Change config: module: "./moralis" (instead of default "./matic")
 * 2. Polygon would then use MoralisStateProvider like BASE/ARB/OP
 * 3. Eliminate 27 TB storage, save $2,306/month ($27,672/year)
 *
 * See: https://bitpayprod.atlassian.net/wiki/spaces/CONS/pages/2742059010/BCN+Node+Providers
 */
import { BaseModule } from '..';
import { EVMVerificationPeer } from '../../providers/chain-state/evm/p2p/EVMVerificationPeer';
import { EVMP2pWorker } from '../../providers/chain-state/evm/p2p/p2p';
import { IEVMNetworkConfig } from '../../types/Config';
import { MATICStateProvider } from './api/csp';
import { MaticRoutes } from './api/matic-routes';

export default class MATICModule extends BaseModule {
  constructor(services: BaseModule['bitcoreServices'], chain: string, network: string, _config: IEVMNetworkConfig) {
    super(services);
    services.P2P.register(chain, network, EVMP2pWorker); // NOTE! Local P2P sync (like ETH)
    services.CSP.registerService(chain, network, new MATICStateProvider()); // NOTE! Local MongoDB queries (like ETH)
    services.Api.app.use(MaticRoutes);
    services.Verification.register(chain, network, EVMVerificationPeer);
  }
}
