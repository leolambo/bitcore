import { expect } from 'chai';
import sinon from 'sinon';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// --- Pre-register module mocks BEFORE importing MultiProviderEVMStateProvider ---
// @bitpay-labs/* packages are private and not available in this environment.
// We mock them so the deep dependency chain resolves.
// Additionally, src/config.ts must be mocked because it tries to load
// bitcore.config.json from a path that is only valid in compiled builds.

const mockWeb3 = {
  utils: {
    toChecksumAddress: (addr: string) => addr
  }
};

const Module = require('module');
const originalResolve = Module._resolveFilename;
const mockModules: Record<string, any> = {
  '@bitpay-labs/crypto-wallet-core': { Web3: mockWeb3, BitcoreLib: {}, Utils: { BI: { JSONStringifyBigIntReplacer: null } } },
};

const configModulePath = path.resolve(__dirname, '../../../../src/config.ts');
const MOCK_CONFIG_KEY = '__mock__/src/config/multiProvider';

const mockConfig = {
  maxPoolSize: 50,
  port: 3000,
  dbUrl: '',
  dbHost: '127.0.0.1',
  dbName: 'bitcore',
  dbPort: '27017',
  dbUser: '',
  dbPass: '',
  numWorkers: 1,
  chains: {
    ETH: {
      mainnet: {
        trustedPeers: [],
        providers: [{ host: 'localhost', port: 8545, protocol: 'http', dataType: 'combined' }],
        externalProviders: [
          {
            name: 'moralis',
            priority: 1,
            config: { apiKey: 'test-moralis-key' },
            circuitBreakerConfig: {}
          },
          {
            name: 'alchemy',
            priority: 2,
            config: { apiKey: 'test-alchemy-key' },
            circuitBreakerConfig: {}
          }
        ]
      }
    }
  },
  aliasMapping: { chains: {}, networks: {} },
  services: {
    api: { rateLimiter: { disabled: true, whitelist: [] }, wallets: {} },
    event: { onlyWalletEvents: false },
    p2p: {},
    socket: { bwsKeys: [] },
    storage: {}
  },
  externalProviders: { moralis: { apiKey: 'test' } }
};

// Pre-populate require.cache for the config mock
require.cache[MOCK_CONFIG_KEY] = {
  id: MOCK_CONFIG_KEY,
  filename: MOCK_CONFIG_KEY,
  loaded: true,
  exports: { default: mockConfig, __esModule: true },
  parent: null,
  children: [],
  paths: [],
  path: ''
} as any;

// Intercept module resolution for @bitpay-labs/* packages AND src/config.ts
Module._resolveFilename = function(request: string, parent: any, isMain: boolean, options: any) {
  if (mockModules[request]) {
    return request;
  }
  if (request.startsWith('@bitpay-labs/')) {
    if (!mockModules[request]) {
      mockModules[request] = {};
      require.cache[request] = {
        id: request,
        filename: request,
        loaded: true,
        exports: mockModules[request],
        parent: null,
        children: [],
        paths: [],
        path: ''
      } as any;
    }
    return request;
  }
  try {
    const resolved = originalResolve.call(this, request, parent, isMain, options);
    if (resolved === configModulePath) {
      return MOCK_CONFIG_KEY;
    }
    return resolved;
  } catch (err) {
    throw err;
  }
};

// Pre-populate require.cache for the explicitly mocked @bitpay-labs modules
for (const [modName, modExports] of Object.entries(mockModules)) {
  require.cache[modName] = {
    id: modName,
    filename: modName,
    loaded: true,
    exports: modExports,
    parent: null,
    children: [],
    paths: [],
    path: ''
  } as any;
}

// Now import the modules under test
import {
  InvalidRequestError,
  UpstreamError,
  AllProvidersUnavailableError,
  TimeoutError,
  RateLimitError
} from '../../../../src/providers/chain-state/external/adapters/errors';
// CircuitBreaker is used implicitly by the provider - not directly imported in tests
import { IIndexedAPIAdapter } from '../../../../src/providers/chain-state/external/adapters/IIndexedAPIAdapter';
import { AdapterFactory } from '../../../../src/providers/chain-state/external/adapters/factory';
import { ExternalApiStream } from '../../../../src/providers/chain-state/external/streams/apiStream';
import { BaseEVMStateProvider } from '../../../../src/providers/chain-state/evm/api/csp';
import { EVMTransactionStorage } from '../../../../src/providers/chain-state/evm/models/transaction';
import { Config } from '../../../../src/services/config';

// We import the class AFTER mocks are set up
import { MultiProviderEVMStateProvider } from '../../../../src/modules/multiProvider/api/csp';

// --- Mock helpers ---

function createMockAdapter(name: string, overrides: Partial<IIndexedAPIAdapter> = {}): IIndexedAPIAdapter {
  return {
    name,
    supportedChains: ['ETH'],
    getTransaction: sinon.stub().resolves(undefined),
    streamAddressTransactions: sinon.stub().returns(new ExternalApiStream('http://test', {}, {})),
    streamERC20Transfers: sinon.stub().returns(new ExternalApiStream('http://test', {}, {})),
    getBlockNumberByDate: sinon.stub().resolves(18000000),
    healthCheck: sinon.stub().resolves(true),
    ...overrides
  };
}

const MOCK_TX = {
  txid: '0xabc123',
  chain: 'ETH',
  network: 'mainnet',
  blockHeight: 18000000,
  blockHash: '0xblockhash',
  blockTime: new Date(),
  blockTimeNormalized: new Date(),
  value: 1000000000000000000,
  gasLimit: 21000,
  gasPrice: 20000000000,
  fee: 420000000000000,
  nonce: 5,
  to: '0xto',
  from: '0xfrom',
  data: Buffer.from(''),
  internal: [],
  calls: [],
  effects: [],
  wallets: [],
  transactionIndex: 42
};

describe('MultiProviderEVMStateProvider', function() {
  let sandbox: sinon.SinonSandbox;
  let provider: MultiProviderEVMStateProvider;
  let mockAdapterPrimary: IIndexedAPIAdapter;
  let mockAdapterSecondary: IIndexedAPIAdapter;

  beforeEach(function() {
    sandbox = sinon.createSandbox();

    // Stub Config.get() to return our mock config
    sandbox.stub(Config, 'get').returns(mockConfig as any);

    // Stub BaseEVMStateProvider static methods to avoid RPC initialization
    sandbox.stub(BaseEVMStateProvider, 'initializeRpcs').returns(undefined as any);

    // Stub getWeb3 and getChainId
    const mockWeb3Instance = {
      eth: {
        getBlockNumber: sinon.stub().resolves(BigInt(18000100)),
        getBlock: sinon.stub().callsFake((blockNum) => {
          if (blockNum === 'latest') {
            return Promise.resolve({ number: 18000100, timestamp: 1700000000 });
          }
          return Promise.resolve({
            number: typeof blockNum === 'number' ? blockNum : 18000000,
            timestamp: 1693526400 // 2023-09-01T00:00:00Z
          });
        })
      }
    };
    sandbox.stub(BaseEVMStateProvider.prototype, 'getWeb3').resolves({
      rpc: {} as any,
      web3: mockWeb3Instance as any,
      dataType: 'historical'
    });
    sandbox.stub(BaseEVMStateProvider.prototype, 'getChainId').resolves(BigInt(1));

    // Stub populateReceipt and populateEffects
    sandbox.stub(BaseEVMStateProvider.prototype, 'populateReceipt').callsFake(async (tx) => tx);
    sandbox.stub(BaseEVMStateProvider.prototype, 'populateEffects').callsFake((tx) => tx);

    // Stub EVMTransactionStorage._apiTransform
    sandbox.stub(EVMTransactionStorage, '_apiTransform').callsFake((tx: any, _opts: any) => tx);

    // Create mock adapters
    mockAdapterPrimary = createMockAdapter('Moralis');
    mockAdapterSecondary = createMockAdapter('Alchemy');

    // Stub AdapterFactory.createAdapter
    sandbox.stub(AdapterFactory, 'createAdapter').callsFake((name: string) => {
      if (name === 'moralis') return mockAdapterPrimary;
      if (name === 'alchemy') return mockAdapterSecondary;
      throw new Error(`Unknown adapter: ${name}`);
    });

    // Create provider instance
    provider = new MultiProviderEVMStateProvider('ETH');
  });

  afterEach(function() {
    sandbox.restore();
  });

  after(function() {
    Module._resolveFilename = originalResolve;
  });

  // ==========================================
  // _getTransaction
  // ==========================================
  describe('_getTransaction', function() {
    it('should return from primary on success', async function() {
      (mockAdapterPrimary.getTransaction as sinon.SinonStub).resolves({ ...MOCK_TX });

      const result = await provider._getTransaction({
        chain: 'ETH', network: 'mainnet', txId: '0xabc123', streamId: ''
      } as any);

      expect(result.found).to.exist;
      expect(result.found!.txid).to.equal('0xabc123');
      expect(result.tipHeight).to.equal(18000100);
      // Secondary should not be called
      expect((mockAdapterSecondary.getTransaction as sinon.SinonStub).called).to.be.false;
    });

    it('should failover to secondary when primary throws UpstreamError', async function() {
      (mockAdapterPrimary.getTransaction as sinon.SinonStub).rejects(
        new UpstreamError('Moralis', 500)
      );
      (mockAdapterSecondary.getTransaction as sinon.SinonStub).resolves({ ...MOCK_TX });

      const result = await provider._getTransaction({
        chain: 'ETH', network: 'mainnet', txId: '0xabc123', streamId: ''
      } as any);

      expect(result.found).to.exist;
      expect(result.found!.txid).to.equal('0xabc123');
      expect((mockAdapterPrimary.getTransaction as sinon.SinonStub).calledOnce).to.be.true;
      expect((mockAdapterSecondary.getTransaction as sinon.SinonStub).calledOnce).to.be.true;
    });

    it('should skip OPEN circuit providers', async function() {
      // Make both adapters return a result
      (mockAdapterPrimary.getTransaction as sinon.SinonStub).resolves({ ...MOCK_TX });
      (mockAdapterSecondary.getTransaction as sinon.SinonStub).resolves({ ...MOCK_TX, txid: '0xfromSecondary' });

      // Access the providers and manually open primary's circuit
      const providers = (provider as any).providersByNetwork.get('mainnet');
      // Force primary circuit to OPEN
      for (let i = 0; i < 5; i++) {
        providers[0].circuitBreaker.recordFailure(new Error('test'));
      }

      const result = await provider._getTransaction({
        chain: 'ETH', network: 'mainnet', txId: '0xabc123', streamId: ''
      } as any);

      // Should have gone to secondary
      expect(result.found).to.exist;
      expect(result.found!.txid).to.equal('0xfromSecondary');
      // Primary should not be called since circuit is OPEN
      expect((mockAdapterPrimary.getTransaction as sinon.SinonStub).called).to.be.false;
      expect((mockAdapterSecondary.getTransaction as sinon.SinonStub).calledOnce).to.be.true;
    });

    it('should throw AllProvidersUnavailableError when all fail', async function() {
      (mockAdapterPrimary.getTransaction as sinon.SinonStub).rejects(
        new UpstreamError('Moralis', 500)
      );
      (mockAdapterSecondary.getTransaction as sinon.SinonStub).rejects(
        new UpstreamError('Alchemy', 503)
      );

      try {
        await provider._getTransaction({
          chain: 'ETH', network: 'mainnet', txId: '0xabc123', streamId: ''
        } as any);
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(AllProvidersUnavailableError);
        expect(err.message).to.include('ETH:mainnet');
      }
    });

    it('should continue to next provider when primary returns undefined (not found)', async function() {
      (mockAdapterPrimary.getTransaction as sinon.SinonStub).resolves(undefined);
      (mockAdapterSecondary.getTransaction as sinon.SinonStub).resolves({ ...MOCK_TX });

      const result = await provider._getTransaction({
        chain: 'ETH', network: 'mainnet', txId: '0xabc123', streamId: ''
      } as any);

      expect(result.found).to.exist;
      expect(result.found!.txid).to.equal('0xabc123');
      expect((mockAdapterPrimary.getTransaction as sinon.SinonStub).calledOnce).to.be.true;
      expect((mockAdapterSecondary.getTransaction as sinon.SinonStub).calledOnce).to.be.true;
    });

    it('should throw InvalidRequestError immediately without failover', async function() {
      (mockAdapterPrimary.getTransaction as sinon.SinonStub).rejects(
        new InvalidRequestError('Moralis', 'invalid txId format')
      );

      try {
        await provider._getTransaction({
          chain: 'ETH', network: 'mainnet', txId: 'bad-tx', streamId: ''
        } as any);
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(InvalidRequestError);
        expect(err.message).to.include('invalid txId format');
        // Secondary should NOT be called
        expect((mockAdapterSecondary.getTransaction as sinon.SinonStub).called).to.be.false;
      }
    });

    it('should call recordFailure on breaker-eligible errors', async function() {
      const providers = (provider as any).providersByNetwork.get('mainnet');
      const recordFailureSpy = sandbox.spy(providers[0].circuitBreaker, 'recordFailure');

      (mockAdapterPrimary.getTransaction as sinon.SinonStub).rejects(
        new UpstreamError('Moralis', 500)
      );
      (mockAdapterSecondary.getTransaction as sinon.SinonStub).resolves({ ...MOCK_TX });

      await provider._getTransaction({
        chain: 'ETH', network: 'mainnet', txId: '0xabc123', streamId: ''
      } as any);

      expect(recordFailureSpy.calledOnce).to.be.true;
    });

    it('should return found: undefined when all providers return undefined', async function() {
      (mockAdapterPrimary.getTransaction as sinon.SinonStub).resolves(undefined);
      (mockAdapterSecondary.getTransaction as sinon.SinonStub).resolves(undefined);

      const result = await provider._getTransaction({
        chain: 'ETH', network: 'mainnet', txId: '0xnotfound', streamId: ''
      } as any);

      expect(result.found).to.be.undefined;
      expect(result.tipHeight).to.equal(18000100);
    });

    it('should throw AllProvidersUnavailableError when no providers can be attempted', async function() {
      // Open both circuits
      const providers = (provider as any).providersByNetwork.get('mainnet');
      for (let i = 0; i < 5; i++) {
        providers[0].circuitBreaker.recordFailure(new Error('test'));
        providers[1].circuitBreaker.recordFailure(new Error('test'));
      }

      try {
        await provider._getTransaction({
          chain: 'ETH', network: 'mainnet', txId: '0xabc123', streamId: ''
        } as any);
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(AllProvidersUnavailableError);
      }
    });
  });

  // ==========================================
  // getTransaction (public override)
  // ==========================================
  describe('getTransaction (public override)', function() {
    it('should let AllProvidersUnavailableError propagate', async function() {
      (mockAdapterPrimary.getTransaction as sinon.SinonStub).rejects(
        new UpstreamError('Moralis', 500)
      );
      (mockAdapterSecondary.getTransaction as sinon.SinonStub).rejects(
        new UpstreamError('Alchemy', 500)
      );

      try {
        await provider.getTransaction({
          chain: 'ETH', network: 'mainnet', txId: '0xabc123', streamId: ''
        } as any);
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(AllProvidersUnavailableError);
      }
    });

    it('should let InvalidRequestError propagate', async function() {
      (mockAdapterPrimary.getTransaction as sinon.SinonStub).rejects(
        new InvalidRequestError('Moralis', 'invalid txId')
      );

      try {
        await provider.getTransaction({
          chain: 'ETH', network: 'mainnet', txId: 'bad', streamId: ''
        } as any);
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(InvalidRequestError);
      }
    });

    it('should return undefined for non-typed errors (preserve base behavior)', async function() {
      (mockAdapterPrimary.getTransaction as sinon.SinonStub).rejects(new TypeError('random error'));
      (mockAdapterSecondary.getTransaction as sinon.SinonStub).rejects(new TypeError('also random'));

      // Both fail with non-breaker errors, but hadBreakerError = true because
      // TypeError is treated as breaker-eligible in withBreakerAttempt.
      // This means AllProvidersUnavailableError is thrown from _getTransaction,
      // and the public getTransaction lets that propagate.
      try {
        await provider.getTransaction({
          chain: 'ETH', network: 'mainnet', txId: '0xabc123', streamId: ''
        } as any);
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(AllProvidersUnavailableError);
      }
    });

    it('should return result with confirmations on success', async function() {
      (mockAdapterPrimary.getTransaction as sinon.SinonStub).resolves({
        ...MOCK_TX,
        blockHeight: 18000000
      });

      const result = await provider.getTransaction({
        chain: 'ETH', network: 'mainnet', txId: '0xabc123', streamId: ''
      } as any);

      expect(result).to.exist;
      // confirmations = tipHeight - blockHeight + 1 = 18000100 - 18000000 + 1 = 101
      expect(result!.confirmations).to.equal(101);
    });

    it('should return undefined when not found across all providers', async function() {
      (mockAdapterPrimary.getTransaction as sinon.SinonStub).resolves(undefined);
      (mockAdapterSecondary.getTransaction as sinon.SinonStub).resolves(undefined);

      const result = await provider.getTransaction({
        chain: 'ETH', network: 'mainnet', txId: '0xnotfound', streamId: ''
      } as any);

      expect(result).to.be.undefined;
    });
  });

  // ==========================================
  // withBreakerAttempt
  // ==========================================
  describe('withBreakerAttempt', function() {
    // Access private method via cast
    function callWithBreakerAttempt(prov: any, fn: () => Promise<any>) {
      return (provider as any).withBreakerAttempt(prov, fn);
    }

    it('should call recordSuccess on success', async function() {
      const providers = (provider as any).providersByNetwork.get('mainnet');
      const recordSuccessSpy = sandbox.spy(providers[0].circuitBreaker, 'recordSuccess');

      const result = await callWithBreakerAttempt(providers[0], async () => 'ok');

      expect(result.result).to.equal('ok');
      expect(result.error).to.be.undefined;
      expect(recordSuccessSpy.calledOnce).to.be.true;
    });

    it('should call recordFailure on breaker-eligible AdapterError', async function() {
      const providers = (provider as any).providersByNetwork.get('mainnet');
      const recordFailureSpy = sandbox.spy(providers[0].circuitBreaker, 'recordFailure');

      const result = await callWithBreakerAttempt(providers[0], async () => {
        throw new UpstreamError('test', 500);
      });

      expect(result.error).to.be.instanceOf(UpstreamError);
      expect(recordFailureSpy.calledOnce).to.be.true;
    });

    it('should call recordFailure on non-AdapterError (e.g., TypeError)', async function() {
      const providers = (provider as any).providersByNetwork.get('mainnet');
      const recordFailureSpy = sandbox.spy(providers[0].circuitBreaker, 'recordFailure');

      const result = await callWithBreakerAttempt(providers[0], async () => {
        throw new TypeError('Cannot read property of null');
      });

      expect(result.error).to.be.instanceOf(TypeError);
      expect(recordFailureSpy.calledOnce).to.be.true;
    });

    it('should releasePermit and re-throw on InvalidRequestError', async function() {
      const providers = (provider as any).providersByNetwork.get('mainnet');
      const releasePermitSpy = sandbox.spy(providers[0].circuitBreaker, 'releasePermit');
      const recordFailureSpy = sandbox.spy(providers[0].circuitBreaker, 'recordFailure');
      const recordSuccessSpy = sandbox.spy(providers[0].circuitBreaker, 'recordSuccess');

      try {
        await callWithBreakerAttempt(providers[0], async () => {
          throw new InvalidRequestError('test', 'bad input');
        });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(InvalidRequestError);
        expect(releasePermitSpy.calledOnce).to.be.true;
        expect(recordFailureSpy.called).to.be.false;
        expect(recordSuccessSpy.called).to.be.false;
      }
    });

    it('should call recordFailure on RateLimitError (breaker-eligible)', async function() {
      const providers = (provider as any).providersByNetwork.get('mainnet');
      const recordFailureSpy = sandbox.spy(providers[0].circuitBreaker, 'recordFailure');

      const result = await callWithBreakerAttempt(providers[0], async () => {
        throw new RateLimitError('test');
      });

      expect(result.error).to.be.instanceOf(RateLimitError);
      expect(recordFailureSpy.calledOnce).to.be.true;
    });
  });

  // ==========================================
  // _buildAddressTransactionsStream
  // ==========================================
  describe('_buildAddressTransactionsStream', function() {
    let mockReq: any;
    let mockRes: any;

    beforeEach(function() {
      mockReq = new EventEmitter();
      mockRes = new EventEmitter();
      mockRes.type = sinon.stub();
      mockRes.write = sinon.stub();
      mockRes.end = sinon.stub();
      mockRes.destroy = sinon.stub();
      mockRes.status = sinon.stub().returns(mockRes);
      mockRes.send = sinon.stub();
    });

    it('should use preflight to test stream before committing', async function() {
      // Create a stream that emits data
      const mockStream = new PassThrough({ objectMode: true });
      (mockStream as any).url = 'http://test';
      (mockStream as any).headers = {};
      (mockStream as any).eventPipe = function(dest: any) { return dest; };

      (mockAdapterPrimary.streamAddressTransactions as sinon.SinonStub).returns(mockStream);

      // Stub ExternalApiStream.onStream to resolve successfully
      const onStreamStub = sandbox.stub(ExternalApiStream, 'onStream').resolves({ success: true });

      // Push data asynchronously
      setTimeout(() => {
        mockStream.write({ txid: '0xtx1' });
        mockStream.end();
      }, 10);

      await provider._buildAddressTransactionsStream({
        req: mockReq,
        res: mockRes,
        args: {},
        chain: 'ETH',
        network: 'mainnet',
        address: '0xaddress'
      } as any);

      expect(onStreamStub.calledOnce).to.be.true;
      // Secondary should not be called since primary succeeded
      expect((mockAdapterSecondary.streamAddressTransactions as sinon.SinonStub).called).to.be.false;
    });

    it('should failover on preflight failure', async function() {
      // Primary emits error
      const failStream = new PassThrough({ objectMode: true });
      (failStream as any).url = 'http://test';
      (failStream as any).headers = {};
      (failStream as any).eventPipe = function(dest: any) { return dest; };

      (mockAdapterPrimary.streamAddressTransactions as sinon.SinonStub).returns(failStream);

      // Secondary succeeds
      const successStream = new PassThrough({ objectMode: true });
      (successStream as any).url = 'http://test';
      (successStream as any).headers = {};
      (successStream as any).eventPipe = function(dest: any) { return dest; };

      (mockAdapterSecondary.streamAddressTransactions as sinon.SinonStub).returns(successStream);

      const onStreamStub = sandbox.stub(ExternalApiStream, 'onStream').resolves({ success: true });

      // Primary fails, secondary succeeds
      setTimeout(() => {
        failStream.emit('error', new UpstreamError('Moralis', 500));
      }, 10);
      setTimeout(() => {
        successStream.write({ txid: '0xtx2' });
        successStream.end();
      }, 30);

      await provider._buildAddressTransactionsStream({
        req: mockReq,
        res: mockRes,
        args: {},
        chain: 'ETH',
        network: 'mainnet',
        address: '0xaddress'
      } as any);

      expect(onStreamStub.calledOnce).to.be.true;
      expect((mockAdapterSecondary.streamAddressTransactions as sinon.SinonStub).calledOnce).to.be.true;
    });

    it('should convert startDate to startBlock before provider loop', async function() {
      // Stub _getBlockNumberByDate to verify it's called for date conversion
      const getBlockStub = sandbox.stub(provider as any, '_getBlockNumberByDate').resolves(17500000);

      const mockStream = new PassThrough({ objectMode: true });
      (mockStream as any).url = 'http://test';
      (mockStream as any).headers = {};
      (mockStream as any).eventPipe = function(dest: any) { return dest; };

      (mockAdapterPrimary.streamAddressTransactions as sinon.SinonStub).returns(mockStream);
      sandbox.stub(ExternalApiStream, 'onStream').resolves({ success: true });

      setTimeout(() => {
        mockStream.write({ txid: '0xtx1' });
        mockStream.end();
      }, 10);

      await provider._buildAddressTransactionsStream({
        req: mockReq,
        res: mockRes,
        args: { startDate: '2023-01-01' },
        chain: 'ETH',
        network: 'mainnet',
        address: '0xaddress'
      } as any);

      expect(getBlockStub.calledOnce).to.be.true;
      const callArgs = getBlockStub.firstCall.args[0];
      expect(callArgs.date).to.be.instanceOf(Date);
    });

    it('should throw AllProvidersUnavailableError when all providers fail', async function() {
      // Both adapters fail during preflight
      const failStream1 = new PassThrough({ objectMode: true });
      (failStream1 as any).url = 'http://test';
      (failStream1 as any).headers = {};
      (failStream1 as any).eventPipe = function(dest: any) { return dest; };

      const failStream2 = new PassThrough({ objectMode: true });
      (failStream2 as any).url = 'http://test';
      (failStream2 as any).headers = {};
      (failStream2 as any).eventPipe = function(dest: any) { return dest; };

      (mockAdapterPrimary.streamAddressTransactions as sinon.SinonStub).returns(failStream1);
      (mockAdapterSecondary.streamAddressTransactions as sinon.SinonStub).returns(failStream2);

      setTimeout(() => {
        failStream1.emit('error', new UpstreamError('Moralis', 500));
      }, 10);
      setTimeout(() => {
        failStream2.emit('error', new UpstreamError('Alchemy', 500));
      }, 30);

      try {
        await provider._buildAddressTransactionsStream({
          req: mockReq,
          res: mockRes,
          args: {},
          chain: 'ETH',
          network: 'mainnet',
          address: '0xaddress'
        } as any);
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(AllProvidersUnavailableError);
      }
    });

    it('should use ERC20 stream when tokenAddress is provided', async function() {
      const mockStream = new PassThrough({ objectMode: true });
      (mockStream as any).url = 'http://test';
      (mockStream as any).headers = {};
      (mockStream as any).eventPipe = function(dest: any) { return dest; };

      (mockAdapterPrimary.streamERC20Transfers as sinon.SinonStub).returns(mockStream);
      sandbox.stub(ExternalApiStream, 'onStream').resolves({ success: true });

      setTimeout(() => {
        mockStream.write({ txid: '0xtx1' });
        mockStream.end();
      }, 10);

      await provider._buildAddressTransactionsStream({
        req: mockReq,
        res: mockRes,
        args: { tokenAddress: '0xtoken' },
        chain: 'ETH',
        network: 'mainnet',
        address: '0xaddress'
      } as any);

      expect((mockAdapterPrimary.streamERC20Transfers as sinon.SinonStub).calledOnce).to.be.true;
      expect((mockAdapterPrimary.streamAddressTransactions as sinon.SinonStub).called).to.be.false;
    });
  });

  // ==========================================
  // _preflightStream
  // ==========================================
  describe('_preflightStream', function() {
    it('should return success with firstItem when data is emitted', async function() {
      const stream = new PassThrough({ objectMode: true }) as any;
      stream.url = 'http://test';
      stream.headers = {};

      setTimeout(() => stream.write({ txid: '0xtx1' }), 10);

      const result = await (provider as any)._preflightStream(stream, 5000);
      expect(result.success).to.be.true;
      expect(result.firstItem).to.deep.equal({ txid: '0xtx1' });
    });

    it('should return success with null firstItem when stream ends immediately', async function() {
      const stream = new PassThrough({ objectMode: true }) as any;
      stream.url = 'http://test';
      stream.headers = {};

      setTimeout(() => stream.end(), 10);

      const result = await (provider as any)._preflightStream(stream, 5000);
      expect(result.success).to.be.true;
      expect(result.firstItem).to.be.null;
    });

    it('should return failure on stream error', async function() {
      const stream = new PassThrough({ objectMode: true }) as any;
      stream.url = 'http://test';
      stream.headers = {};

      setTimeout(() => stream.emit('error', new UpstreamError('test', 500)), 10);

      const result = await (provider as any)._preflightStream(stream, 5000);
      expect(result.success).to.be.false;
      expect(result.error).to.be.instanceOf(UpstreamError);
    });

    it('should return failure on timeout', async function() {
      const stream = new PassThrough({ objectMode: true }) as any;
      stream.url = 'http://test';
      stream.headers = {};

      // Don't emit anything - let it timeout
      const result = await (provider as any)._preflightStream(stream, 50);
      expect(result.success).to.be.false;
      expect(result.error).to.be.instanceOf(TimeoutError);
    });
  });

  // ==========================================
  // getProvidersForNetwork
  // ==========================================
  describe('getProvidersForNetwork', function() {
    it('should throw AllProvidersUnavailableError for empty config', function() {
      // Access private method
      const getProviders = (provider as any).getProvidersForNetwork.bind(provider);

      try {
        getProviders('nonexistent');
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(AllProvidersUnavailableError);
        expect(err.message).to.include('config');
      }
    });

    it('should return providers for configured network', function() {
      const getProviders = (provider as any).getProvidersForNetwork.bind(provider);
      const providers = getProviders('mainnet');
      expect(providers).to.be.an('array').with.lengthOf(2);
    });
  });

  // ==========================================
  // provider ordering
  // ==========================================
  describe('provider ordering', function() {
    it('should sort by priority ascending, then name lexicographically', function() {
      const providers = (provider as any).providersByNetwork.get('mainnet');
      expect(providers).to.have.lengthOf(2);
      // moralis has priority 1, alchemy has priority 2
      expect(providers[0].adapter.name).to.equal('Moralis');
      expect(providers[0].priority).to.equal(1);
      expect(providers[1].adapter.name).to.equal('Alchemy');
      expect(providers[1].priority).to.equal(2);
    });

    it('should sort by name when priorities are equal', function() {
      // Reconfigure with equal priorities
      (Config.get as sinon.SinonStub).returns({
        ...mockConfig,
        chains: {
          ETH: {
            mainnet: {
              trustedPeers: [],
              providers: [{ host: 'localhost', port: 8545, protocol: 'http', dataType: 'combined' }],
              externalProviders: [
                { name: 'alchemy', priority: 1, config: { apiKey: 'k' }, circuitBreakerConfig: {} },
                { name: 'moralis', priority: 1, config: { apiKey: 'k' }, circuitBreakerConfig: {} }
              ]
            }
          }
        }
      });

      const p2 = new MultiProviderEVMStateProvider('ETH');
      const providers = (p2 as any).providersByNetwork.get('mainnet');
      // Alchemy < Moralis lexicographically
      expect(providers[0].adapter.name).to.equal('Alchemy');
      expect(providers[1].adapter.name).to.equal('Moralis');
    });
  });

  // ==========================================
  // getBlockBeforeTime
  // ==========================================
  describe('getBlockBeforeTime', function() {
    it('should use adapter getBlockNumberByDate with floor semantics', async function() {
      (mockAdapterPrimary.getBlockNumberByDate as sinon.SinonStub).resolves(18000000);

      const result = await provider.getBlockBeforeTime({
        query: { chain: 'ETH', network: 'mainnet', time: '2023-09-01T00:00:00Z' }
      });

      expect(result).to.exist;
      expect((mockAdapterPrimary.getBlockNumberByDate as sinon.SinonStub).calledOnce).to.be.true;
    });
  });

  // ==========================================
  // _getBlockNumberByDate
  // ==========================================
  describe('_getBlockNumberByDate', function() {
    it('should return block number from adapter with floor semantics enforcement', async function() {
      (mockAdapterPrimary.getBlockNumberByDate as sinon.SinonStub).resolves(18000000);

      const result = await provider._getBlockNumberByDate({
        date: new Date('2023-09-01T00:00:00Z'),
        chainId: BigInt(1),
        network: 'mainnet'
      });

      expect(typeof result).to.equal('number');
    });

    it('should failover when primary adapter fails', async function() {
      (mockAdapterPrimary.getBlockNumberByDate as sinon.SinonStub).rejects(
        new UpstreamError('Moralis', 500)
      );
      (mockAdapterSecondary.getBlockNumberByDate as sinon.SinonStub).resolves(18000000);

      const result = await provider._getBlockNumberByDate({
        date: new Date('2023-09-01T00:00:00Z'),
        chainId: BigInt(1),
        network: 'mainnet'
      });

      expect(typeof result).to.equal('number');
      expect((mockAdapterSecondary.getBlockNumberByDate as sinon.SinonStub).calledOnce).to.be.true;
    });

    it('should throw AllProvidersUnavailableError when all fail', async function() {
      (mockAdapterPrimary.getBlockNumberByDate as sinon.SinonStub).rejects(
        new UpstreamError('Moralis', 500)
      );
      (mockAdapterSecondary.getBlockNumberByDate as sinon.SinonStub).rejects(
        new UpstreamError('Alchemy', 500)
      );

      try {
        await provider._getBlockNumberByDate({
          date: new Date('2023-09-01T00:00:00Z'),
          chainId: BigInt(1),
          network: 'mainnet'
        });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(AllProvidersUnavailableError);
      }
    });
  });

  // ==========================================
  // _buildWalletTransactionsStream
  // ==========================================
  describe('_buildWalletTransactionsStream', function() {
    it('should throw AllProvidersUnavailableError when no provider available', async function() {
      // Open all circuits
      const providers = (provider as any).providersByNetwork.get('mainnet');
      for (let i = 0; i < 5; i++) {
        providers[0].circuitBreaker.recordFailure(new Error('test'));
        providers[1].circuitBreaker.recordFailure(new Error('test'));
      }

      try {
        await provider._buildWalletTransactionsStream(
          { network: 'mainnet', args: {} } as any,
          { transactionStream: {} as any, populateEffects: {} as any, walletAddresses: ['0xaddr1'] }
        );
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(AllProvidersUnavailableError);
      }
    });

    it('should stream for each wallet address', async function() {
      const mockStream = {
        eventPipe: sinon.stub().returnsArg(0)
      };

      (mockAdapterPrimary.streamAddressTransactions as sinon.SinonStub).returns(mockStream);

      // Stub WalletAddressStorage.updateLastQueryTime
      const { WalletAddressStorage } = require('../../../../src/models/walletAddress');
      sandbox.stub(WalletAddressStorage, 'updateLastQueryTime').resolves();

      const mockTransactionStream = { eventPipe: sinon.stub().returnsArg(0) } as any;

      await provider._buildWalletTransactionsStream(
        { network: 'mainnet', args: {} } as any,
        { transactionStream: mockTransactionStream, populateEffects: {} as any, walletAddresses: ['0xaddr1', '0xaddr2'] }
      );

      expect((mockAdapterPrimary.streamAddressTransactions as sinon.SinonStub).calledTwice).to.be.true;
    });
  });

  // ==========================================
  // getProviderHealth
  // ==========================================
  describe('getProviderHealth', function() {
    it('should return health info for all providers', async function() {
      const health = await provider.getProviderHealth();

      expect(health).to.have.property('mainnet');
      expect(health.mainnet).to.have.property('Moralis');
      expect(health.mainnet).to.have.property('Alchemy');
      expect(health.mainnet.Moralis).to.have.property('priority', 1);
      expect(health.mainnet.Moralis).to.have.property('circuitState', 'CLOSED');
      expect(health.mainnet.Moralis).to.have.property('apiHealthy', true);
    });

    it('should report apiHealthy as false when health check fails', async function() {
      (mockAdapterPrimary.healthCheck as sinon.SinonStub).rejects(new Error('health check failed'));

      const health = await provider.getProviderHealth();

      expect(health.mainnet.Moralis.apiHealthy).to.be.false;
    });
  });

  // ==========================================
  // _enforceFloorSemantics
  // ==========================================
  describe('_enforceFloorSemantics', function() {
    it('should return candidate block when timestamp matches', async function() {
      // The default getBlock mock returns timestamp 1693526400 (2023-09-01T00:00:00Z)
      // which matches the date we'll pass
      const result = await (provider as any)._enforceFloorSemantics(
        'mainnet',
        18000000,
        new Date('2023-09-01T00:00:00Z')
      );

      expect(typeof result).to.equal('number');
    });

    it('should decrement block when candidate is too late', async function() {
      // Override getWeb3 to return a web3 with timestamp > target
      const targetDate = new Date('2023-08-31T00:00:00Z'); // Earlier than our mock blocks
      const targetTimestamp = Math.floor(targetDate.getTime() / 1000);

      const mockWeb3Instance = {
        eth: {
          getBlockNumber: sinon.stub().resolves(BigInt(18000100)),
          getBlock: sinon.stub().callsFake((blockNum) => {
            if (blockNum === 'latest') {
              return Promise.resolve({ number: 18000100, timestamp: 1700000000 });
            }
            // Return timestamp that's after the target for high blocks, before for lower
            const ts = blockNum >= 18000000 ? 1693612800 : targetTimestamp - 100;
            return Promise.resolve({ number: blockNum, timestamp: ts });
          })
        }
      };

      (BaseEVMStateProvider.prototype.getWeb3 as sinon.SinonStub).resolves({
        rpc: {} as any,
        web3: mockWeb3Instance as any,
        dataType: 'historical'
      });

      const result = await (provider as any)._enforceFloorSemantics(
        'mainnet',
        18000000,
        targetDate
      );

      expect(result).to.be.lessThan(18000000);
    });
  });

  // ==========================================
  // initializeProviders
  // ==========================================
  describe('initializeProviders', function() {
    it('should handle missing chain config gracefully', function() {
      (Config.get as sinon.SinonStub).returns({ ...mockConfig, chains: {} });
      // Should not throw
      const p = new MultiProviderEVMStateProvider('UNKNOWN');
      expect((p as any).providersByNetwork.size).to.equal(0);
    });

    it('should handle networks with no externalProviders', function() {
      (Config.get as sinon.SinonStub).returns({
        ...mockConfig,
        chains: {
          ETH: {
            mainnet: {
              trustedPeers: [],
              providers: [{ host: 'localhost', port: 8545, protocol: 'http', dataType: 'combined' }]
              // No externalProviders
            }
          }
        }
      });

      const p = new MultiProviderEVMStateProvider('ETH');
      expect((p as any).providersByNetwork.size).to.equal(0);
    });
  });
});
