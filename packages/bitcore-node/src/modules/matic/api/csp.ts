/**
 * Polygon (MATIC) Chain State Provider - LOCAL MONGODB IMPLEMENTATION
 *
 * NOTE! THIS IS THE LOCAL IMPLEMENTATION:
 * This class extends BaseEVMStateProvider and uses LOCAL MongoDB for all queries
 * (same architecture as ETH). Polygon is architecturally a Layer 2, but currently
 * operates with Layer 1 infrastructure (local P2P + MongoDB).
 *
 * CURRENT STATE:
 * - Inherits all query methods from BaseEVMStateProvider (local MongoDB queries)
 * - Does NOT override methods to use external APIs
 * - Used by the ./matic module (not ./moralis module)
 *
 * MIGRATION PATH TO EXTERNAL PROVIDER:
 * To migrate Polygon to use Moralis API (like BASE/ARB/OP):
 * 1. Change network config: module: "./moralis" (instead of "./matic")
 * 2. Network will then use MoralisStateProvider instead of this class
 * 3. No code changes needed - just configuration change
 *
 * See: https://bitpayprod.atlassian.net/wiki/spaces/CONS/pages/2742059010/BCN+Node+Providers
 */
import { BaseEVMStateProvider } from '../../../providers/chain-state/evm/api/csp';

export class MATICStateProvider extends BaseEVMStateProvider {
  constructor() {
    super('MATIC'); // NOTE! Uses base class methods (local MongoDB, not external API)
  }
}

export const MATIC = new MATICStateProvider();
