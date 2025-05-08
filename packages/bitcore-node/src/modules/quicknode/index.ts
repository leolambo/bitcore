import { BaseModule } from '..';
import { SVMRouter } from '../../providers/chain-state/svm/api/routes';
// import { EVMVerificationPeer } from '../../providers/chain-state/evm/p2p/EVMVerificationPeer';
import { IEVMNetworkConfig } from '../../types/Config';
import { QuickNodeStateProvider } from './api/csp';
// import { MoralisP2PWorker } from './p2p/p2p';

export default class QuickNodeModule extends BaseModule {
  constructor(services: BaseModule['bitcoreServices'], chain: string, network: string, _config: IEVMNetworkConfig) {
    super(services);
    // services.P2P.register(chain, network, MoralisP2PWorker);
    const csp = new QuickNodeStateProvider(chain);
    services.CSP.registerService(chain, network, csp);
    services.Api.app.use(new SVMRouter(csp, chain, { quicknode: true }).getRouter());
    // services.Verification.register(chain, network, EVMVerificationPeer);
  }
}