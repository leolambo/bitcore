import { expect } from 'chai';
import sinon from 'sinon';
import { MultiProviderEVMStateProvider } from '../../../src/modules/multiProvider/api/csp';
import { BaseEVMStateProvider } from '../../../src/providers/chain-state/evm/api/csp';
import { Config } from '../../../src/services/config';

interface FakeBlock { number: number; timestamp: number }

function makeWeb3(blocks: Array<{ number: number; timestampSec: number }>) {
  return {
    eth: {
      getBlock: sinon.stub().callsFake(async (tag: any) => {
        if (tag === 'latest') {
          const last = blocks[blocks.length - 1];
          return { number: last.number, timestamp: last.timestampSec };
        }
        const n = Number(tag);
        const b = blocks.find(x => x.number === n);
        return b ? { number: b.number, timestamp: b.timestampSec } : null;
      })
    }
  };
}

function buildProvider(blocks: Array<{ number: number; timestampSec: number }>) {
  const provider = new MultiProviderEVMStateProvider('ETH');
  const web3 = makeWeb3(blocks);
  (provider as any).getWeb3 = async () => ({ web3 });
  return { provider, web3 };
}

describe('MultiProviderEVMStateProvider: _verifyBlockBeforeDate', function() {
  let sandbox: sinon.SinonSandbox;
  let cfgStub: sinon.SinonStub;
  before(function() {
    // Stub Config.get and short-circuit RPC init for the entire suite.
    cfgStub = sinon.stub(Config, 'get').returns({ chains: { ETH: {} } } as any);
    (BaseEVMStateProvider as any).rpcInitialized = { ETH: true };
  });
  after(function() { cfgStub.restore(); });
  beforeEach(function() { sandbox = sinon.createSandbox(); });
  afterEach(function() { sandbox.restore(); });

  function uniformChain(latestNumber: number, blockTimeSec: number, genesisTs = 0) {
    const blocks: Array<{ number: number; timestampSec: number }> = [];
    for (let n = 0; n <= latestNumber; n++) {
      blocks.push({ number: n, timestampSec: genesisTs + n * blockTimeSec });
    }
    return blocks;
  }

  it('returns candidate when timestamp is exactly correct (1 read + 1 peek)', async function() {
    const blocks = uniformChain(100, 12);
    const { provider, web3 } = buildProvider(blocks);
    const targetTs = blocks[50].timestampSec;
    const result = await (provider as any)._verifyBlockBeforeDate('mainnet', 50, new Date(targetTs * 1000));
    expect(result).to.equal(50);
    // 1 fetch for candidate + 1 peek (next block)
    expect(web3.eth.getBlock.callCount).to.equal(2);
  });

  it('walks backward up to 16 blocks when candidate is too high', async function() {
    const blocks = uniformChain(100, 12);
    const { provider } = buildProvider(blocks);
    const targetTs = blocks[40].timestampSec;
    // Candidate 50 is 10 blocks too high — walks back to 40.
    const result = await (provider as any)._verifyBlockBeforeDate('mainnet', 50, new Date(targetTs * 1000));
    expect(result).to.equal(40);
  });

  it('falls back to local binary search when candidate is more than 16 too high', async function() {
    const blocks = uniformChain(100, 12);
    const { provider } = buildProvider(blocks);
    const targetTs = blocks[10].timestampSec;
    // Candidate 100 is 90 blocks too high — backward walk exhausts, falls back.
    const result = await (provider as any)._verifyBlockBeforeDate('mainnet', 100, new Date(targetTs * 1000));
    expect(result).to.equal(10);
  });

  it('walks forward up to 16 blocks when candidate is too low', async function() {
    const blocks = uniformChain(100, 12);
    const { provider } = buildProvider(blocks);
    const targetTs = blocks[60].timestampSec;
    // Candidate 50 is 10 blocks too low — walks forward to 60.
    const result = await (provider as any)._verifyBlockBeforeDate('mainnet', 50, new Date(targetTs * 1000));
    expect(result).to.equal(60);
  });

  it('REGRESSION: falls back to local binary search when candidate is more than 16 too low', async function() {
    const blocks = uniformChain(100, 12);
    const { provider } = buildProvider(blocks);
    const targetTs = blocks[80].timestampSec;
    // Candidate 0 is 80 blocks too low — forward walk would exhaust, peek would still satisfy → binary fallback.
    const result = await (provider as any)._verifyBlockBeforeDate('mainnet', 0, new Date(targetTs * 1000));
    expect(result).to.equal(80);
  });

  it('returns undefined when candidate 0 has timestamp > target (before-genesis)', async function() {
    const blocks = uniformChain(100, 12, 1000);
    const { provider } = buildProvider(blocks);
    // target=500 < genesisTs=1000 → candidate 0 still has ts=1000 > 500 → undefined
    const result = await (provider as any)._verifyBlockBeforeDate('mainnet', 0, new Date(500 * 1000));
    expect(result).to.equal(undefined);
  });

  it('local binary search returns undefined when target is before genesis', async function() {
    const blocks = uniformChain(100, 12, 1000);
    const { provider } = buildProvider(blocks);
    const result = await (provider as any)._binarySearchFloorByTimestamp(
      { eth: makeWeb3(blocks).eth },
      500
    );
    expect(result).to.equal(undefined);
  });

  it('local binary search returns latest when target is in the future', async function() {
    const blocks = uniformChain(100, 12);
    const { provider } = buildProvider(blocks);
    const web3 = makeWeb3(blocks);
    const result = await (provider as any)._binarySearchFloorByTimestamp(web3, 999_999);
    expect(result).to.equal(100);
  });

  it('local binary search finds floor on long monotonic chain', async function() {
    const blocks = uniformChain(1000, 12);
    const { provider } = buildProvider(blocks);
    const web3 = makeWeb3(blocks);
    const target = blocks[500].timestampSec + 5;
    const result = await (provider as any)._binarySearchFloorByTimestamp(web3, target);
    expect(result).to.equal(500);
  });

  it('rejects NaN candidate and falls back to binary search', async function() {
    const blocks = uniformChain(100, 12);
    const { provider } = buildProvider(blocks);
    const targetTs = blocks[50].timestampSec;
    const result = await (provider as any)._verifyBlockBeforeDate('mainnet', NaN, new Date(targetTs * 1000));
    expect(result).to.equal(50);
  });

  it('rejects negative candidate and falls back to binary search', async function() {
    const blocks = uniformChain(100, 12);
    const { provider } = buildProvider(blocks);
    const targetTs = blocks[30].timestampSec;
    const result = await (provider as any)._verifyBlockBeforeDate('mainnet', -1, new Date(targetTs * 1000));
    expect(result).to.equal(30);
  });

  it('clamps candidate beyond local tip to tip and continues verification', async function() {
    const blocks = uniformChain(100, 12);
    const { provider } = buildProvider(blocks);
    const targetTs = blocks[100].timestampSec; // tip itself
    const result = await (provider as any)._verifyBlockBeforeDate('mainnet', 99999, new Date(targetTs * 1000));
    expect(result).to.equal(100);
  });

  it('throws when local-node returns malformed header', async function() {
    const blocks = uniformChain(100, 12);
    const { provider } = buildProvider(blocks);
    const web3 = makeWeb3(blocks);
    web3.eth.getBlock = sinon.stub().resolves({ number: 'not-a-number', timestamp: 600 } as any);
    (provider as any).getWeb3 = async () => ({ web3 });
    try {
      await (provider as any)._verifyBlockBeforeDate('mainnet', 50, new Date(600_000));
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e.message).to.match(/malformed/i);
    }
  });

  it('candidate 0 with block 0 ts <= target and next ts > target returns 0 (no falsy bug)', async function() {
    const blocks = uniformChain(100, 12, 0);
    const { provider } = buildProvider(blocks);
    // target equals genesis ts exactly
    const result = await (provider as any)._verifyBlockBeforeDate('mainnet', 0, new Date(0));
    expect(result).to.equal(0);
  });

  it('correctness fuzz: verifier matches canonical floor across 200 random monotonic chains and candidates', async function() {
    let s = 98765;
    const rand = () => {
      s = (s * 1664525 + 1013904223) % 0x100000000;
      return s / 0xFFFFFFFF;
    };

    for (let iter = 0; iter < 200; iter++) {
      const latestNumber = 50 + Math.floor(rand() * 1500);
      const blocks: Array<{ number: number; timestampSec: number }> = [];
      let ts = Math.floor(rand() * 100);
      for (let n = 0; n <= latestNumber; n++) {
        blocks.push({ number: n, timestampSec: ts });
        ts += 1 + Math.floor(rand() * 30);
      }
      const { provider } = buildProvider(blocks);

      const targetIdx = Math.floor(rand() * latestNumber);
      const targetTs = blocks[targetIdx].timestampSec;

      // Canonical answer
      let canonical: number | undefined = undefined;
      if (targetTs >= blocks[latestNumber].timestampSec) canonical = latestNumber;
      else if (targetTs < blocks[0].timestampSec) canonical = undefined;
      else {
        for (let n = 0; n <= latestNumber; n++) {
          if (blocks[n].timestampSec <= targetTs) canonical = n;
          else break;
        }
      }

      // Random candidate (sometimes wildly off)
      const candidate = Math.floor(rand() * (latestNumber + 5));
      const result = await (provider as any)._verifyBlockBeforeDate('mainnet', candidate, new Date(targetTs * 1000));

      if (result !== canonical) {
        throw new Error(`fuzz mismatch iter=${iter} latest=${latestNumber} target=${targetTs} cand=${candidate} canonical=${canonical} got=${result}`);
      }
    }
  });
});

// Suppress unused interface warning
type _UnusedFakeBlock = FakeBlock;
const _ignored: _UnusedFakeBlock = { number: 0, timestamp: 0 };
void _ignored;
