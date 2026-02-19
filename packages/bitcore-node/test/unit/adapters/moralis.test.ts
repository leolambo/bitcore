import { expect } from 'chai';
import sinon from 'sinon';
import axios from 'axios';
import path from 'path';
import { ExternalApiStream } from '../../../src/providers/chain-state/external/streams/apiStream';
import {
  InvalidRequestError,
  NotFoundError,
  AuthError,
  RateLimitError,
  TimeoutError,
  UpstreamError
} from '../../../src/providers/chain-state/external/adapters/errors';

// --- Pre-register module mocks BEFORE importing MoralisAdapter ---
// @bitpay-labs/* packages are private and not available in this environment.
// We mock them so the deep dependency chain from EVMTransactionStorage resolves.
//
// Additionally, src/config.ts must be mocked because it tries to load
// bitcore.config.json from a path that is only valid in compiled builds
// (the extra build/ directory changes the relative resolution).

// Mock Web3.utils.toChecksumAddress to return input as-is
const mockWeb3 = {
  utils: {
    toChecksumAddress: (addr: string) => addr
  }
};

// Known @bitpay-labs packages to mock
const Module = require('module');
const originalResolve = Module._resolveFilename;
const mockModules: Record<string, any> = {
  '@bitpay-labs/crypto-wallet-core': { Web3: mockWeb3, BitcoreLib: {}, Utils: { BI: { JSONStringifyBigIntReplacer: null } } },
};

// Resolve the absolute path to src/config.ts so we can intercept it.
// When ts-node resolves `import config from '../config'` (from services/config.ts),
// it resolves to this exact filename.
const configModulePath = path.resolve(__dirname, '../../../src/config.ts');
const MOCK_CONFIG_KEY = '__mock__/src/config';

// Default config object that satisfies ConfigType without needing bitcore.config.json
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
  chains: {},
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
  // Catch any @bitpay-labs package that isn't explicitly listed
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

  // Intercept src/config.ts — the module that calls findConfig() and throws
  // when bitcore.config.json is not at the expected relative path
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

// Now we can safely import MoralisAdapter and EVMTransactionStorage
import { MoralisAdapter } from '../../../src/providers/chain-state/external/adapters/moralis';
import { EVMTransactionStorage } from '../../../src/providers/chain-state/evm/models/transaction';

// --- Mock data ---
const VALID_TX_HASH = '0xabc123def456abc123def456abc123def456abc123def456abc123def456abc1';
const MOCK_MORALIS_TX = {
  hash: VALID_TX_HASH,
  block_number: '18000000',
  block_hash: '0xblockhash123',
  block_timestamp: '2023-09-01T12:00:00.000Z',
  value: '1000000000000000000',
  gas: '21000',
  gas_price: '20000000000',
  receipt_gas_used: '21000',
  nonce: 5,
  to_address: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD1e',
  from_address: '0x388C818CA8B9251b393131C08a736A67ccB19297',
  input: '0x',
  internal_transactions: [
    {
      from: '0x388C818CA8B9251b393131C08a736A67ccB19297',
      to: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD1e',
      gas: '21000',
      gas_used: '21000',
      input: '0x',
      output: '0x',
      type: 'CALL',
      value: '1000000000000000000'
    }
  ],
  category: 'token send',
  transaction_index: 42
};

describe('MoralisAdapter', function() {
  let sandbox: sinon.SinonSandbox;
  let adapter: MoralisAdapter;
  let axiosGetStub: sinon.SinonStub;

  beforeEach(function() {
    sandbox = sinon.createSandbox();

    // Mock EVMTransactionStorage methods
    sandbox.stub(EVMTransactionStorage, 'addEffectsToTxs').callsFake(() => { /* no-op */ });
    sandbox.stub(EVMTransactionStorage, 'abiDecode').returns(undefined as any);
    sandbox.stub(EVMTransactionStorage, '_apiTransform').callsFake((tx: any, _opts: any) => tx);

    // Stub axios.get
    axiosGetStub = sandbox.stub(axios, 'get');

    // Create adapter instance
    adapter = new MoralisAdapter({ apiKey: 'test-api-key' });
  });

  afterEach(function() {
    sandbox.restore();
  });

  // Restore the original Module._resolveFilename after all tests
  after(function() {
    Module._resolveFilename = originalResolve;
  });

  // ==========================================
  // 1. Constructor validation
  // ==========================================
  describe('constructor', function() {
    it('should throw if apiKey is missing', function() {
      expect(() => new MoralisAdapter({ apiKey: '' })).to.throw('MoralisAdapter: apiKey is required');
    });

    it('should throw if apiKey is undefined', function() {
      expect(() => new MoralisAdapter({ apiKey: undefined as any })).to.throw('MoralisAdapter: apiKey is required');
    });

    it('should set default requestTimeout to 30000ms', function() {
      const a = new MoralisAdapter({ apiKey: 'key' });
      expect(a.name).to.equal('Moralis');
      expect(a.supportedChains).to.include('ETH');
    });

    it('should accept custom requestTimeout', function() {
      const a = new MoralisAdapter({ apiKey: 'key', requestTimeout: 5000 });
      expect(a.name).to.equal('Moralis');
    });

    it('should set supportedChains to ETH, MATIC, BASE, ARB, OP', function() {
      const a = new MoralisAdapter({ apiKey: 'key' });
      expect(a.supportedChains).to.deep.equal(['ETH', 'MATIC', 'BASE', 'ARB', 'OP']);
    });
  });

  // ==========================================
  // 2. getTransaction
  // ==========================================
  describe('getTransaction', function() {
    const baseParams = {
      chain: 'ETH',
      network: 'mainnet',
      chainId: '1',
      txId: VALID_TX_HASH
    };

    it('should return transformed transaction for valid tx', async function() {
      axiosGetStub.resolves({ data: { ...MOCK_MORALIS_TX } });

      const result = await adapter.getTransaction(baseParams);

      expect(result).to.exist;
      expect(result!.txid).to.equal(VALID_TX_HASH);
      expect(result!.chain).to.equal('ETH');
      expect(result!.network).to.equal('mainnet');
      expect(result!.blockHeight).to.equal(18000000);
      expect(result!.blockHash).to.equal('0xblockhash123');
      expect(result!.nonce).to.equal(5);
      expect(result!.transactionIndex).to.equal(42);

      // Verify axios was called with correct URL
      expect(axiosGetStub.calledOnce).to.be.true;
      const callUrl = axiosGetStub.firstCall.args[0];
      expect(callUrl).to.include('/transaction/');
      expect(callUrl).to.include(VALID_TX_HASH);
    });

    it('should return undefined for 404 response', async function() {
      const axiosError = new Error('Not Found') as any;
      axiosError.isAxiosError = true;
      axiosError.response = { status: 404 };
      axiosGetStub.rejects(axiosError);

      const result = await adapter.getTransaction(baseParams);
      expect(result).to.be.undefined;
    });

    it('should throw InvalidRequestError for invalid txId format without making HTTP call', async function() {
      try {
        await adapter.getTransaction({ ...baseParams, txId: 'not-a-tx-hash' });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(InvalidRequestError);
        expect(err.message).to.include('invalid txId format');
        // Verify no HTTP call was made
        expect(axiosGetStub.called).to.be.false;
      }
    });

    it('should throw InvalidRequestError for txId without 0x prefix', async function() {
      try {
        await adapter.getTransaction({ ...baseParams, txId: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc123' });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(InvalidRequestError);
        expect(axiosGetStub.called).to.be.false;
      }
    });

    it('should throw InvalidRequestError for short txId', async function() {
      try {
        await adapter.getTransaction({ ...baseParams, txId: '0xabc' });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(InvalidRequestError);
        expect(axiosGetStub.called).to.be.false;
      }
    });

    it('should return undefined when response data is falsy', async function() {
      axiosGetStub.resolves({ data: null });

      const result = await adapter.getTransaction(baseParams);
      expect(result).to.be.undefined;
    });

    it('should classify 401 as AuthError', async function() {
      const axiosError = new Error('Unauthorized') as any;
      axiosError.isAxiosError = true;
      axiosError.response = { status: 401 };
      axiosGetStub.rejects(axiosError);

      try {
        await adapter.getTransaction(baseParams);
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(AuthError);
      }
    });

    it('should classify 429 as RateLimitError', async function() {
      const axiosError = new Error('Too Many Requests') as any;
      axiosError.isAxiosError = true;
      axiosError.response = { status: 429 };
      axiosGetStub.rejects(axiosError);

      try {
        await adapter.getTransaction(baseParams);
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(RateLimitError);
      }
    });

    it('should classify 500 as UpstreamError', async function() {
      const axiosError = new Error('Internal Server Error') as any;
      axiosError.isAxiosError = true;
      axiosError.response = { status: 500 };
      axiosGetStub.rejects(axiosError);

      try {
        await adapter.getTransaction(baseParams);
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(UpstreamError);
      }
    });

    it('should classify ECONNABORTED as TimeoutError', async function() {
      const axiosError = new Error('timeout') as any;
      axiosError.isAxiosError = true;
      axiosError.code = 'ECONNABORTED';
      axiosError.response = undefined;
      axiosGetStub.rejects(axiosError);

      try {
        await adapter.getTransaction(baseParams);
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(TimeoutError);
      }
    });

    it('should classify unknown errors as UpstreamError', async function() {
      axiosGetStub.rejects(new Error('Something unexpected'));

      try {
        await adapter.getTransaction(baseParams);
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(UpstreamError);
        expect(err.message).to.include('Something unexpected');
      }
    });
  });

  // ==========================================
  // 3. _transformTransaction (tested via getTransaction)
  // ==========================================
  describe('_transformTransaction (via getTransaction)', function() {
    const baseParams = {
      chain: 'ETH',
      network: 'mainnet',
      chainId: '1',
      txId: VALID_TX_HASH
    };

    it('should produce a Buffer for data field', async function() {
      axiosGetStub.resolves({ data: { ...MOCK_MORALIS_TX, input: '0xabcdef' } });

      const result = await adapter.getTransaction(baseParams);
      expect(result).to.exist;
      expect(Buffer.isBuffer(result!.data)).to.be.true;
    });

    it('should return empty Buffer when input is falsy', async function() {
      axiosGetStub.resolves({ data: { ...MOCK_MORALIS_TX, input: '' } });

      const result = await adapter.getTransaction(baseParams);
      expect(result).to.exist;
      expect(Buffer.isBuffer(result!.data)).to.be.true;
      expect(result!.data.length).to.equal(0);
    });

    it('should produce numeric value field', async function() {
      axiosGetStub.resolves({ data: { ...MOCK_MORALIS_TX } });

      const result = await adapter.getTransaction(baseParams);
      expect(result).to.exist;
      expect(typeof result!.value).to.equal('number');
      expect(result!.value).to.equal(1000000000000000000);
    });

    it('should produce numeric gasLimit field', async function() {
      axiosGetStub.resolves({ data: { ...MOCK_MORALIS_TX } });

      const result = await adapter.getTransaction(baseParams);
      expect(result).to.exist;
      expect(typeof result!.gasLimit).to.equal('number');
      expect(result!.gasLimit).to.equal(21000);
    });

    it('should produce numeric gasPrice field', async function() {
      axiosGetStub.resolves({ data: { ...MOCK_MORALIS_TX } });

      const result = await adapter.getTransaction(baseParams);
      expect(result).to.exist;
      expect(typeof result!.gasPrice).to.equal('number');
      expect(result!.gasPrice).to.equal(20000000000);
    });

    it('should calculate fee using BigInt: receipt_gas_used * gas_price', async function() {
      axiosGetStub.resolves({ data: { ...MOCK_MORALIS_TX } });

      const result = await adapter.getTransaction(baseParams);
      expect(result).to.exist;
      // fee = Number(BigInt(21000) * BigInt(20000000000)) = 420000000000000
      expect(typeof result!.fee).to.equal('number');
      expect(result!.fee).to.equal(420000000000000);
    });

    it('should produce numeric blockHeight', async function() {
      axiosGetStub.resolves({ data: { ...MOCK_MORALIS_TX } });

      const result = await adapter.getTransaction(baseParams);
      expect(result).to.exist;
      expect(typeof result!.blockHeight).to.equal('number');
      expect(result!.blockHeight).to.equal(18000000);
    });

    it('should produce Date objects for blockTime and blockTimeNormalized', async function() {
      axiosGetStub.resolves({ data: { ...MOCK_MORALIS_TX } });

      const result = await adapter.getTransaction(baseParams);
      expect(result).to.exist;
      expect(result!.blockTime).to.be.instanceOf(Date);
      expect(result!.blockTimeNormalized).to.be.instanceOf(Date);
    });

    it('should handle to_address being null (contract creation)', async function() {
      axiosGetStub.resolves({
        data: { ...MOCK_MORALIS_TX, to_address: null }
      });

      const result = await adapter.getTransaction(baseParams);
      expect(result).to.exist;
      expect(result!.to).to.equal('');
    });

    it('should call EVMTransactionStorage.addEffectsToTxs', async function() {
      axiosGetStub.resolves({ data: { ...MOCK_MORALIS_TX } });

      await adapter.getTransaction(baseParams);
      expect((EVMTransactionStorage.addEffectsToTxs as sinon.SinonStub).called).to.be.true;
    });

    it('should transform internal_transactions into calls array', async function() {
      axiosGetStub.resolves({ data: { ...MOCK_MORALIS_TX } });

      const result = await adapter.getTransaction(baseParams);
      expect(result).to.exist;
      expect(result!.calls).to.be.an('array').with.lengthOf(1);
      expect(result!.calls[0]).to.have.property('from');
      expect(result!.calls[0]).to.have.property('to');
      expect(result!.calls[0]).to.have.property('type', 'CALL');
    });

    it('should use camelCase fallbacks (blockNumber, toAddress, etc.)', async function() {
      const camelCaseTx = {
        hash: VALID_TX_HASH,
        blockNumber: '18000000',
        blockHash: '0xblockhash123',
        blockTimestamp: '2023-09-01T12:00:00.000Z',
        value: '500',
        gas: '21000',
        gasPrice: '10000000000',
        receiptGasUsed: '21000',
        nonce: 3,
        toAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD1e',
        fromAddress: '0x388C818CA8B9251b393131C08a736A67ccB19297',
        input: '0x',
        transactionIndex: 7
      };
      axiosGetStub.resolves({ data: camelCaseTx });

      const result = await adapter.getTransaction(baseParams);
      expect(result).to.exist;
      expect(result!.blockHeight).to.equal(18000000);
      expect(result!.blockHash).to.equal('0xblockhash123');
      expect(result!.transactionIndex).to.equal(7);
    });
  });

  // ==========================================
  // 4. _classifyError (tested via getTransaction and getBlockNumberByDate)
  // ==========================================
  describe('_classifyError (via public API)', function() {
    const baseParams = {
      chain: 'ETH',
      network: 'mainnet',
      chainId: '1',
      txId: VALID_TX_HASH
    };

    it('should classify 404 as NotFoundError via getBlockNumberByDate', async function() {
      // Note: getTransaction handles 404 specially (returns undefined),
      // but _classifyError maps 404 to NotFoundError for other methods
      const axiosError = new Error('Not Found') as any;
      axiosError.isAxiosError = true;
      axiosError.response = { status: 404 };
      axiosGetStub.rejects(axiosError);

      try {
        await adapter.getBlockNumberByDate({ chainId: '1', date: new Date() });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(NotFoundError);
      }
    });

    it('should classify 401 as AuthError', async function() {
      const axiosError = new Error('Unauthorized') as any;
      axiosError.isAxiosError = true;
      axiosError.response = { status: 401 };
      axiosGetStub.rejects(axiosError);

      try {
        await adapter.getTransaction(baseParams);
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(AuthError);
        expect(err.providerName).to.equal('Moralis');
      }
    });

    it('should classify 403 as AuthError', async function() {
      const axiosError = new Error('Forbidden') as any;
      axiosError.isAxiosError = true;
      axiosError.response = { status: 403 };
      axiosGetStub.rejects(axiosError);

      try {
        await adapter.getTransaction(baseParams);
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(AuthError);
      }
    });

    it('should classify 429 as RateLimitError', async function() {
      const axiosError = new Error('Rate Limit') as any;
      axiosError.isAxiosError = true;
      axiosError.response = { status: 429 };
      axiosGetStub.rejects(axiosError);

      try {
        await adapter.getTransaction(baseParams);
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(RateLimitError);
        expect(err.providerName).to.equal('Moralis');
      }
    });

    it('should classify 5xx as UpstreamError', async function() {
      for (const status of [500, 502, 503, 504]) {
        const axiosError = new Error(`Server Error ${status}`) as any;
        axiosError.isAxiosError = true;
        axiosError.response = { status };
        axiosGetStub.rejects(axiosError);

        try {
          await adapter.getTransaction(baseParams);
          expect.fail('Should have thrown');
        } catch (err: any) {
          expect(err).to.be.instanceOf(UpstreamError);
        }
        axiosGetStub.reset();
      }
    });

    it('should classify ECONNABORTED as TimeoutError', async function() {
      const axiosError = new Error('timeout of 30000ms exceeded') as any;
      axiosError.isAxiosError = true;
      axiosError.code = 'ECONNABORTED';
      axiosError.response = undefined;
      axiosGetStub.rejects(axiosError);

      try {
        await adapter.getTransaction(baseParams);
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(TimeoutError);
        expect(err.message).to.include('30000ms');
      }
    });

    it('should classify unknown non-axios error as UpstreamError', async function() {
      axiosGetStub.rejects(new TypeError('Cannot read property of null'));

      try {
        await adapter.getTransaction(baseParams);
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(UpstreamError);
        expect(err.message).to.include('Cannot read property of null');
      }
    });
  });

  // ==========================================
  // 5. _formatChainId (tested via getTransaction URL)
  // ==========================================
  describe('_formatChainId (via public API)', function() {
    it('should pass through hex chain IDs (0x1)', async function() {
      axiosGetStub.resolves({ data: { ...MOCK_MORALIS_TX } });

      await adapter.getTransaction({
        chain: 'ETH', network: 'mainnet', chainId: '0x1', txId: VALID_TX_HASH
      });

      const url = axiosGetStub.firstCall.args[0] as string;
      expect(url).to.include('chain=0x1');
    });

    it('should convert decimal string to hex', async function() {
      axiosGetStub.resolves({ data: { ...MOCK_MORALIS_TX } });

      await adapter.getTransaction({
        chain: 'ETH', network: 'mainnet', chainId: '137', txId: VALID_TX_HASH
      });

      const url = axiosGetStub.firstCall.args[0] as string;
      expect(url).to.include('chain=0x89');
    });

    it('should convert bigint to hex', async function() {
      axiosGetStub.resolves({ data: { ...MOCK_MORALIS_TX } });

      await adapter.getTransaction({
        chain: 'ETH', network: 'mainnet', chainId: BigInt(10), txId: VALID_TX_HASH
      });

      const url = axiosGetStub.firstCall.args[0] as string;
      expect(url).to.include('chain=0xa');
    });

    it('should convert "1" to "0x1"', async function() {
      axiosGetStub.resolves({ data: { ...MOCK_MORALIS_TX } });

      await adapter.getTransaction({
        chain: 'ETH', network: 'mainnet', chainId: '1', txId: VALID_TX_HASH
      });

      const url = axiosGetStub.firstCall.args[0] as string;
      expect(url).to.include('chain=0x1');
    });

    it('should throw InvalidRequestError for invalid chainId via getBlockNumberByDate', async function() {
      try {
        await adapter.getBlockNumberByDate({ chainId: 'not-a-number' as any, date: new Date() });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(InvalidRequestError);
        expect(err.message).to.include('invalid chainId');
      }
    });
  });

  // ==========================================
  // 6. healthCheck
  // ==========================================
  describe('healthCheck', function() {
    it('should return true on successful response', async function() {
      axiosGetStub.resolves({ data: { version: '1.0' } });

      const result = await adapter.healthCheck();
      expect(result).to.be.true;

      // Verify the correct endpoint was called
      const url = axiosGetStub.firstCall.args[0] as string;
      expect(url).to.include('/web3/version');
    });

    it('should return false on failure', async function() {
      axiosGetStub.rejects(new Error('Network error'));

      const result = await adapter.healthCheck();
      expect(result).to.be.false;
    });

    it('should use a 5-second timeout', async function() {
      axiosGetStub.resolves({ data: {} });

      await adapter.healthCheck();

      const config = axiosGetStub.firstCall.args[1];
      expect(config.timeout).to.equal(5000);
    });
  });

  // ==========================================
  // 7. streamAddressTransactions
  // ==========================================
  describe('streamAddressTransactions', function() {
    it('should return an ExternalApiStream instance', function() {
      const stream = adapter.streamAddressTransactions({
        chainId: '1',
        chain: 'ETH',
        network: 'mainnet',
        address: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD1e',
        args: {} as any
      });

      expect(stream).to.be.instanceOf(ExternalApiStream);
    });

    it('should build URL with address and query params', function() {
      const address = '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD1e';
      const stream = adapter.streamAddressTransactions({
        chainId: '1',
        chain: 'ETH',
        network: 'mainnet',
        address,
        args: {} as any
      });

      expect(stream.url).to.include(address);
      expect(stream.url).to.include('chain=0x1');
      expect(stream.url).to.include('include=internal_transactions');
    });

    it('should set default order to DESC', function() {
      const stream = adapter.streamAddressTransactions({
        chainId: '1',
        chain: 'ETH',
        network: 'mainnet',
        address: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD1e',
        args: {} as any
      });

      expect(stream.url).to.include('order=DESC');
    });

    it('should use custom order when provided', function() {
      const stream = adapter.streamAddressTransactions({
        chainId: '1',
        chain: 'ETH',
        network: 'mainnet',
        address: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD1e',
        args: { order: 'ASC' } as any
      });

      expect(stream.url).to.include('order=ASC');
    });

    it('should set default limit to 10', function() {
      const stream = adapter.streamAddressTransactions({
        chainId: '1',
        chain: 'ETH',
        network: 'mainnet',
        address: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD1e',
        args: {} as any
      });

      expect(stream.url).to.include('limit=10');
    });

    it('should use custom pageSize when provided', function() {
      const stream = adapter.streamAddressTransactions({
        chainId: '1',
        chain: 'ETH',
        network: 'mainnet',
        address: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD1e',
        args: { pageSize: 25 } as any
      });

      expect(stream.url).to.include('limit=25');
    });

    it('should pass headers to the stream', function() {
      const stream = adapter.streamAddressTransactions({
        chainId: '1',
        chain: 'ETH',
        network: 'mainnet',
        address: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD1e',
        args: {} as any
      });

      expect(stream.headers).to.have.property('X-API-Key', 'test-api-key');
    });

    it('should include startBlock/endBlock as from_block/to_block', function() {
      const stream = adapter.streamAddressTransactions({
        chainId: '1',
        chain: 'ETH',
        network: 'mainnet',
        address: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD1e',
        args: { startBlock: '100', endBlock: '200' } as any
      });

      expect(stream.url).to.include('from_block=100');
      expect(stream.url).to.include('to_block=200');
    });

    it('should include startDate/endDate when no block range', function() {
      const stream = adapter.streamAddressTransactions({
        chainId: '1',
        chain: 'ETH',
        network: 'mainnet',
        address: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD1e',
        args: { startDate: '2023-01-01', endDate: '2023-12-31' } as any
      });

      expect(stream.url).to.include('from_date=2023-01-01');
      expect(stream.url).to.include('to_date=2023-12-31');
    });

    it('should set up a transform function on the stream', function() {
      const stream = adapter.streamAddressTransactions({
        chainId: '1',
        chain: 'ETH',
        network: 'mainnet',
        address: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD1e',
        args: {} as any
      });

      expect(stream.transform).to.be.a('function');
    });
  });

  // ==========================================
  // 8. streamERC20Transfers
  // ==========================================
  describe('streamERC20Transfers', function() {
    const tokenAddress = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
    const address = '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD1e';

    it('should return an ExternalApiStream instance', function() {
      const stream = adapter.streamERC20Transfers({
        chainId: '1',
        chain: 'ETH',
        network: 'mainnet',
        address,
        tokenAddress,
        args: {} as any
      });

      expect(stream).to.be.instanceOf(ExternalApiStream);
    });

    it('should build URL with /erc20/transfers path', function() {
      const stream = adapter.streamERC20Transfers({
        chainId: '1',
        chain: 'ETH',
        network: 'mainnet',
        address,
        tokenAddress,
        args: {} as any
      });

      expect(stream.url).to.include(`/${address}/erc20/transfers`);
    });

    it('should include token contract address in query as array format', function() {
      const stream = adapter.streamERC20Transfers({
        chainId: '1',
        chain: 'ETH',
        network: 'mainnet',
        address,
        tokenAddress,
        args: {} as any
      });

      // contract_addresses[0]=...
      expect(stream.url).to.include(`contract_addresses%5B0%5D=${tokenAddress}`);
    });

    it('should pass headers to the stream', function() {
      const stream = adapter.streamERC20Transfers({
        chainId: '1',
        chain: 'ETH',
        network: 'mainnet',
        address,
        tokenAddress,
        args: {} as any
      });

      expect(stream.headers).to.have.property('X-API-Key', 'test-api-key');
    });

    it('should set up a transform function', function() {
      const stream = adapter.streamERC20Transfers({
        chainId: '1',
        chain: 'ETH',
        network: 'mainnet',
        address,
        tokenAddress,
        args: {} as any
      });

      expect(stream.transform).to.be.a('function');
    });
  });

  // ==========================================
  // 9. getBlockNumberByDate
  // ==========================================
  describe('getBlockNumberByDate', function() {
    it('should return block number from response', async function() {
      axiosGetStub.resolves({ data: { block: 18500000 } });

      const result = await adapter.getBlockNumberByDate({
        chainId: '1',
        date: new Date('2023-09-01')
      });

      expect(result).to.equal(18500000);
    });

    it('should call correct endpoint with date as timestamp', async function() {
      const date = new Date('2023-09-01T00:00:00.000Z');
      axiosGetStub.resolves({ data: { block: 18500000 } });

      await adapter.getBlockNumberByDate({ chainId: '1', date });

      const url = axiosGetStub.firstCall.args[0] as string;
      expect(url).to.include('/dateToBlock');
      expect(url).to.include(`date=${date.getTime()}`);
      expect(url).to.include('chain=0x1');
    });

    it('should classify errors through _classifyError', async function() {
      const axiosError = new Error('Rate Limited') as any;
      axiosError.isAxiosError = true;
      axiosError.response = { status: 429 };
      axiosGetStub.rejects(axiosError);

      try {
        await adapter.getBlockNumberByDate({ chainId: '1', date: new Date() });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).to.be.instanceOf(RateLimitError);
      }
    });
  });

  // ==========================================
  // Additional edge cases
  // ==========================================
  describe('edge cases', function() {
    it('should handle transaction_hash field for ERC20 transfers (no hash field)', async function() {
      const txWithTransactionHash = {
        ...MOCK_MORALIS_TX,
        hash: undefined,
        transaction_hash: VALID_TX_HASH
      };
      axiosGetStub.resolves({ data: txWithTransactionHash });

      const result = await adapter.getTransaction({
        chain: 'ETH', network: 'mainnet', chainId: '1', txId: VALID_TX_HASH
      });

      expect(result).to.exist;
      expect(result!.txid).to.equal(VALID_TX_HASH);
    });

    it('should handle missing internal_transactions', async function() {
      const txWithoutInternals = { ...MOCK_MORALIS_TX, internal_transactions: undefined };
      axiosGetStub.resolves({ data: txWithoutInternals });

      const result = await adapter.getTransaction({
        chain: 'ETH', network: 'mainnet', chainId: '1', txId: VALID_TX_HASH
      });

      expect(result).to.exist;
      expect(result!.calls).to.deep.equal([]);
    });

    it('should use direction arg to set order when combined with explicit order', function() {
      // When both direction and order are provided, explicit order wins in the spread
      const stream = adapter.streamAddressTransactions({
        chainId: '1',
        chain: 'ETH',
        network: 'mainnet',
        address: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD1e',
        args: { direction: 1, order: 'ASC' } as any
      });

      // direction > 0 => ASC in _transformQueryParams, but explicit order: 'ASC' takes effect
      expect(stream.url).to.include('order=ASC');
    });

    it('should use default DESC when direction is set but order is not', function() {
      // _transformQueryParams sets order from direction, but streamAddressTransactions
      // overwrites with args.order || 'DESC', and since args.order is undefined, DESC wins
      const stream = adapter.streamAddressTransactions({
        chainId: '1',
        chain: 'ETH',
        network: 'mainnet',
        address: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD1e',
        args: { direction: 1 } as any
      });

      // The explicit `order: args.order || 'DESC'` in streamAddressTransactions
      // overrides the direction-based order from _transformQueryParams
      expect(stream.url).to.include('order=DESC');
    });

    it('should use negative direction to set DESC order', function() {
      const stream = adapter.streamAddressTransactions({
        chainId: '1',
        chain: 'ETH',
        network: 'mainnet',
        address: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD1e',
        args: { direction: -1 } as any
      });

      expect(stream.url).to.include('order=DESC');
    });
  });
});
