import { BaseModule } from '..';
import { SOLStateProvider } from './api/csp';
import { SOLRoutes } from './api/sol-routes';
import { SolanaP2PWorker } from './p2p/p2p';

export default class SOLModule extends BaseModule {
  constructor(services: BaseModule['bitcoreServices'], chain: string, network: string) {
    super(services);
    services.CSP.registerService(chain, network, new SOLStateProvider());
    services.Api.app.use(SOLRoutes);
    services.P2P.register(chain, network, SolanaP2PWorker);
  }
}