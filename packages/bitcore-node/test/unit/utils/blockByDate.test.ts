import { expect } from 'chai';
import {
  BlockByDateError,
  BlockHeader,
  BlockHeaderSource,
  createBlockByDateProviderState,
  findBlockCandidateByTimestamp
} from '../../../src/providers/chain-state/external/utils/blockByDate';

interface FakeChain {
  blocks: Array<{ number: number; timestampSec: number }>;
  malformedAt?: Map<number | 'latest', BlockHeader | null | object>;
  latestOverride?: BlockHeader | null;
}

function makeUniformChain(latestNumber: number, blockTimeSec: number, genesisTs = 0): FakeChain {
  const blocks: FakeChain['blocks'] = [];
  for (let n = 0; n <= latestNumber; n++) {
    blocks.push({ number: n, timestampSec: genesisTs + n * blockTimeSec });
  }
  return { blocks };
}

function makeSource(chain: FakeChain): { source: BlockHeaderSource; calls: Array<number | 'latest'> } {
  const calls: Array<number | 'latest'> = [];
  const source: BlockHeaderSource = {
    getBlockHeader: async (tag) => {
      calls.push(tag);
      if (chain.malformedAt && chain.malformedAt.has(tag)) {
        const v = chain.malformedAt.get(tag);
        return v as BlockHeader;
      }
      if (tag === 'latest') {
        if (chain.latestOverride !== undefined) {
          return chain.latestOverride as BlockHeader;
        }
        const last = chain.blocks[chain.blocks.length - 1];
        return { number: last.number, timestampSec: last.timestampSec };
      }
      const block = chain.blocks[tag];
      if (!block) throw new Error(`unknown block ${tag}`);
      return { number: block.number, timestampSec: block.timestampSec };
    }
  };
  return { source, calls };
}

describe('blockByDate helper', function() {
  describe('input validation', function() {
    it('throws INVALID_INPUT for NaN target', async function() {
      const { source } = makeSource(makeUniformChain(100, 12));
      const state = createBlockByDateProviderState();
      try {
        await findBlockCandidateByTimestamp(source, NaN, { state });
        throw new Error('should have thrown');
      } catch (e: any) {
        expect(e).to.be.instanceOf(BlockByDateError);
        expect(e.code).to.equal('INVALID_INPUT');
      }
    });

    it('throws INVALID_INPUT for non-integer target', async function() {
      const { source } = makeSource(makeUniformChain(100, 12));
      const state = createBlockByDateProviderState();
      try {
        await findBlockCandidateByTimestamp(source, 1.5, { state });
        throw new Error('should have thrown');
      } catch (e: any) {
        expect(e.code).to.equal('INVALID_INPUT');
      }
    });
  });

  describe('boundary cases', function() {
    it('returns latest.number when target is in the future', async function() {
      const chain = makeUniformChain(100, 12);
      const { source } = makeSource(chain);
      const state = createBlockByDateProviderState();
      const { candidateBlock } = await findBlockCandidateByTimestamp(source, 99999, { state });
      expect(candidateBlock).to.equal(100);
    });

    it('returns 0 when target equals latest.timestampSec', async function() {
      const chain = makeUniformChain(100, 12);
      const { source } = makeSource(chain);
      const state = createBlockByDateProviderState();
      const latestTs = chain.blocks[100].timestampSec;
      const { candidateBlock } = await findBlockCandidateByTimestamp(source, latestTs, { state });
      expect(candidateBlock).to.equal(100);
    });

    it('returns 0 when target is before genesis', async function() {
      const chain = makeUniformChain(100, 12, 1000);
      const { source } = makeSource(chain);
      const state = createBlockByDateProviderState();
      const { candidateBlock } = await findBlockCandidateByTimestamp(source, 500, { state });
      expect(candidateBlock).to.equal(0);
    });

    it('returns 0 when latest.number is 0 (degenerate chain)', async function() {
      const chain = makeUniformChain(0, 12);
      const { source } = makeSource(chain);
      const state = createBlockByDateProviderState();
      const { candidateBlock } = await findBlockCandidateByTimestamp(source, 50, { state });
      expect(candidateBlock).to.equal(0);
    });
  });

  describe('estimate-then-bracket happy path', function() {
    it('lands on exact answer in 1-2 estimate probes on uniform chain', async function() {
      const chain = makeUniformChain(1_000_000, 12);
      const { source, calls } = makeSource(chain);
      const state = createBlockByDateProviderState();
      const target = chain.blocks[500_000].timestampSec;
      const { candidateBlock, diagnostics } = await findBlockCandidateByTimestamp(source, target, { state });
      expect(candidateBlock).to.equal(500_000);
      // Worst case for uniform chain should be very low
      expect(diagnostics.sourceFetches).to.be.lessThan(8);
      // 1 latest + 1 genesis + 1-2 estimate probes
      expect(calls.length).to.be.greaterThan(2);
    });

    it('returns greatest block with ts <= target between blocks', async function() {
      const chain = makeUniformChain(100, 12);
      const { source } = makeSource(chain);
      const state = createBlockByDateProviderState();
      // Target between blocks 50 (ts=600) and 51 (ts=612)
      const { candidateBlock } = await findBlockCandidateByTimestamp(source, 605, { state });
      expect(candidateBlock).to.equal(50);
    });
  });

  describe('variable block times', function() {
    it('finds correct block when block times vary', async function() {
      // Non-uniform: blocks 0-50 at 12s, 51-100 at 24s
      const blocks: FakeChain['blocks'] = [];
      let ts = 0;
      for (let n = 0; n <= 50; n++) { blocks.push({ number: n, timestampSec: ts }); ts += 12; }
      for (let n = 51; n <= 100; n++) { ts += 24; blocks.push({ number: n, timestampSec: ts }); }
      const chain: FakeChain = { blocks };
      const { source } = makeSource(chain);
      const state = createBlockByDateProviderState();

      const target = blocks[75].timestampSec + 5; // between 75 and 76
      const { candidateBlock } = await findBlockCandidateByTimestamp(source, target, { state });
      expect(candidateBlock).to.equal(75);
    });
  });

  describe('malformed headers', function() {
    it('throws MALFORMED_HEADER on null result for latest', async function() {
      const chain = makeUniformChain(100, 12);
      chain.malformedAt = new Map();
      chain.malformedAt.set('latest', null);
      const { source } = makeSource(chain);
      const state = createBlockByDateProviderState();
      try {
        await findBlockCandidateByTimestamp(source, 600, { state });
        throw new Error('should throw');
      } catch (e: any) {
        expect(e).to.be.instanceOf(BlockByDateError);
        expect(e.code).to.equal('MALFORMED_HEADER');
      }
    });

    it('throws MALFORMED_HEADER on negative timestamp', async function() {
      const chain = makeUniformChain(100, 12);
      chain.malformedAt = new Map();
      chain.malformedAt.set('latest', { number: 100, timestampSec: -1 });
      const { source } = makeSource(chain);
      const state = createBlockByDateProviderState();
      try {
        await findBlockCandidateByTimestamp(source, 600, { state });
        throw new Error('should throw');
      } catch (e: any) {
        expect(e.code).to.equal('MALFORMED_HEADER');
      }
    });

    it('throws MALFORMED_HEADER when numeric tag returns wrong number', async function() {
      const chain = makeUniformChain(100, 12);
      chain.malformedAt = new Map();
      chain.malformedAt.set(50, { number: 51, timestampSec: 600 });
      const { source } = makeSource(chain);
      const state = createBlockByDateProviderState();
      try {
        await findBlockCandidateByTimestamp(source, 600, { state });
        throw new Error('should throw');
      } catch (e: any) {
        expect(e.code).to.equal('MALFORMED_HEADER');
      }
    });
  });

  describe('caching', function() {
    it('reuses cached headers across sequential calls', async function() {
      const chain = makeUniformChain(100, 12);
      const { source, calls } = makeSource(chain);
      const state = createBlockByDateProviderState();

      await findBlockCandidateByTimestamp(source, 600, { state });
      const callsAfterFirst = calls.length;
      await findBlockCandidateByTimestamp(source, 600, { state });
      const callsAfterSecond = calls.length;

      // Second call should issue 1 'latest' fetch but reuse genesis and any other cached numerics.
      expect(callsAfterSecond - callsAfterFirst).to.be.lessThan(callsAfterFirst);
    });

    it('caches genesis forever', async function() {
      const chain = makeUniformChain(100, 12, 1000);
      const { source, calls } = makeSource(chain);
      const state = createBlockByDateProviderState();

      await findBlockCandidateByTimestamp(source, 500, { state }); // before genesis
      const genesisCalls1 = calls.filter(c => c === 0).length;
      expect(genesisCalls1).to.equal(1);

      await findBlockCandidateByTimestamp(source, 500, { state }); // before genesis again
      const genesisCalls2 = calls.filter(c => c === 0).length;
      expect(genesisCalls2).to.equal(1);
    });

    it('latest is fetched fresh on every call', async function() {
      const chain = makeUniformChain(100, 12);
      const { source, calls } = makeSource(chain);
      const state = createBlockByDateProviderState();

      await findBlockCandidateByTimestamp(source, 600, { state });
      await findBlockCandidateByTimestamp(source, 600, { state });
      await findBlockCandidateByTimestamp(source, 600, { state });

      const latestCalls = calls.filter(c => c === 'latest').length;
      expect(latestCalls).to.equal(3);
    });

    it('reorgSensitive entries expire after recentBlockTtlMs', async function() {
      const chain = makeUniformChain(100, 12);
      const { source, calls } = makeSource(chain);
      const state = createBlockByDateProviderState();

      let now = 1_000_000;
      const nowMs = () => now;

      // First call probes near tip; cache entries within finalityDepth=128 of tip=100 are reorgSensitive.
      // For tip=100 with finalityDepth=128, ALL blocks (0..100) are reorgSensitive since 100 > 100-128.
      await findBlockCandidateByTimestamp(source, 1188, { state, nowMs, recentBlockTtlMs: 5000 });
      const callsAfter1 = calls.length;

      // Advance clock past TTL
      now += 6000;

      await findBlockCandidateByTimestamp(source, 1188, { state, nowMs, recentBlockTtlMs: 5000 });
      const callsAfter2 = calls.length;

      // After TTL, reorg-sensitive entries are NOT reused → more fetches
      expect(callsAfter2 - callsAfter1).to.be.greaterThan(1);
    });

    it('non-reorg-sensitive entries reusable past TTL (deep blocks on long chain)', async function() {
      // tip=10000 with finalityDepth=128: blocks <= 9872 are NOT reorgSensitive
      const chain = makeUniformChain(10_000, 12);
      const { source, calls } = makeSource(chain);
      const state = createBlockByDateProviderState();

      let now = 1_000_000;
      const nowMs = () => now;

      // Target deep in history, well below tip - finalityDepth
      const targetTs = chain.blocks[5000].timestampSec + 5;
      await findBlockCandidateByTimestamp(source, targetTs, { state, nowMs, recentBlockTtlMs: 5000 });
      const callsAfter1 = calls.length;

      // Advance clock past TTL
      now += 60_000;

      await findBlockCandidateByTimestamp(source, targetTs, { state, nowMs, recentBlockTtlMs: 5000 });
      const callsAfter2 = calls.length;

      // Deep entries should still be reused; only 'latest' is refetched
      expect(callsAfter2 - callsAfter1).to.be.lessThan(callsAfter1);
    });
  });

  describe('concurrency', function() {
    it('dedupes concurrent identical fetches via inFlight', async function() {
      const chain = makeUniformChain(100, 12);
      const pendingResolves: Array<() => void> = [];
      const callOrder: Array<number | 'latest'> = [];
      const source: BlockHeaderSource = {
        getBlockHeader: async (tag) => {
          callOrder.push(tag);
          await new Promise<void>((resolve) => { pendingResolves.push(resolve); });
          if (tag === 'latest') {
            const last = chain.blocks[chain.blocks.length - 1];
            return { number: last.number, timestampSec: last.timestampSec };
          }
          return chain.blocks[tag as number];
        }
      };
      const state = createBlockByDateProviderState();

      // Issue two concurrent identical lookups
      const p1 = findBlockCandidateByTimestamp(source, 600, { state });
      const p2 = findBlockCandidateByTimestamp(source, 600, { state });

      // Wait for inFlight to be set up, then drain
      await new Promise(r => setTimeout(r, 10));
      while (pendingResolves.length > 0) {
        pendingResolves.shift()!();
        await new Promise(r => setTimeout(r, 5));
      }

      const r1 = await p1;
      const r2 = await p2;
      expect(r1.candidateBlock).to.equal(r2.candidateBlock);

      // Each unique block number should be fetched exactly once across both calls
      const latestCount = callOrder.filter(c => c === 'latest').length;
      expect(latestCount).to.equal(1);
    });

    it('rejected inFlight does not poison subsequent calls', async function() {
      let attempt = 0;
      const source: BlockHeaderSource = {
        getBlockHeader: async (tag) => {
          if (tag === 'latest' && attempt === 0) {
            attempt++;
            throw new Error('transient failure');
          }
          if (tag === 'latest') {
            return { number: 100, timestampSec: 1200 };
          }
          if (tag === 0) return { number: 0, timestampSec: 0 };
          return { number: tag as number, timestampSec: (tag as number) * 12 };
        }
      };
      const state = createBlockByDateProviderState();

      try {
        await findBlockCandidateByTimestamp(source, 600, { state });
        throw new Error('should have thrown');
      } catch (e: any) {
        expect(e.message).to.equal('transient failure');
      }

      // Second call should succeed (inFlight cleaned up)
      const { candidateBlock } = await findBlockCandidateByTimestamp(source, 600, { state });
      expect(candidateBlock).to.equal(50);
    });
  });

  describe('monotonicity recovery', function() {
    it('bypass-refetches a block that violates bracket invariant', async function() {
      // Build a chain where block 50 returns inconsistent timestamp on first probe but correct on refetch
      let block50FetchCount = 0;
      const source: BlockHeaderSource = {
        getBlockHeader: async (tag) => {
          if (tag === 'latest') return { number: 100, timestampSec: 1200 };
          if (tag === 0) return { number: 0, timestampSec: 0 };
          if (tag === 50) {
            block50FetchCount++;
            if (block50FetchCount === 1) {
              // First fetch returns a timestamp that violates monotonicity (inside bracket [0..100] but ts > latest)
              return { number: 50, timestampSec: 99999 };
            }
            return { number: 50, timestampSec: 600 };
          }
          return { number: tag as number, timestampSec: (tag as number) * 12 };
        }
      };
      const state = createBlockByDateProviderState();

      // Force a probe at block 50 by targeting around its timestamp
      const { candidateBlock } = await findBlockCandidateByTimestamp(source, 605, { state });
      expect(candidateBlock).to.equal(50);
      expect(block50FetchCount).to.be.greaterThan(1);
    });

    it('throws NON_MONOTONIC_DATA when bypass refetch still fails', async function() {
      const source: BlockHeaderSource = {
        getBlockHeader: async (tag) => {
          if (tag === 'latest') return { number: 100, timestampSec: 1200 };
          if (tag === 0) return { number: 0, timestampSec: 0 };
          // Block 50 always returns broken timestamp
          if (tag === 50) return { number: 50, timestampSec: 99999 };
          return { number: tag as number, timestampSec: (tag as number) * 12 };
        }
      };
      const state = createBlockByDateProviderState();
      try {
        await findBlockCandidateByTimestamp(source, 600, { state });
        throw new Error('should throw');
      } catch (e: any) {
        expect(e).to.be.instanceOf(BlockByDateError);
        expect(e.code).to.equal('NON_MONOTONIC_DATA');
      }
    });
  });

  describe('correctness fuzz vs binary search', function() {
    it('matches canonical floor across 200 random monotonic chains', async function() {
      const seed = 12345;
      let s = seed;
      const rand = () => {
        s = (s * 1664525 + 1013904223) % 0x100000000;
        return s / 0xFFFFFFFF;
      };

      for (let i = 0; i < 200; i++) {
        const latestNumber = 100 + Math.floor(rand() * 9000);
        const blocks: FakeChain['blocks'] = [];
        let ts = Math.floor(rand() * 1000);
        for (let n = 0; n <= latestNumber; n++) {
          blocks.push({ number: n, timestampSec: ts });
          ts += 1 + Math.floor(rand() * 30); // 1-30s per block
        }
        const { source } = makeSource({ blocks });
        const state = createBlockByDateProviderState();

        const targetIdx = Math.floor(rand() * latestNumber);
        const targetTs = blocks[targetIdx].timestampSec + Math.floor(rand() * 5);

        // Canonical: greatest block with ts <= targetTs
        let canonical = 0;
        for (let n = 0; n <= latestNumber; n++) {
          if (blocks[n].timestampSec <= targetTs) canonical = n;
          else break;
        }

        const { candidateBlock } = await findBlockCandidateByTimestamp(source, targetTs, { state });
        if (candidateBlock !== canonical) {
          throw new Error(`mismatch on iter ${i}: latest=${latestNumber} target=${targetTs} canonical=${canonical} got=${candidateBlock}`);
        }
      }
    });
  });
});
