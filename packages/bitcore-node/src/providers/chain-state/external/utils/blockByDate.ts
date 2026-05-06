import { LRUCache } from 'lru-cache';

export type BlockTag = number | 'latest';

export interface BlockHeader {
  number: number;
  timestampSec: number;
}

export interface CachedHeader {
  timestampSec: number;
  fetchedAtMs: number;
  reorgSensitive: boolean;
}

export interface BlockHeaderSource {
  getBlockHeader(tag: BlockTag): Promise<BlockHeader>;
}

export interface BlockByDateProviderState {
  headerCache: LRUCache<number, CachedHeader>;
  inFlight: Map<BlockTag, Promise<BlockHeader>>;
  genesisHeader: BlockHeader | null;
  avg: { valueSec: number | null; tipBlockNumber: number | null; computedAtMs: number | null };
}

export interface FindBlockCandidateOptions {
  state: BlockByDateProviderState;
  recentBlockTtlMs?: number;
  finalityDepth?: number;
  maxEstimateProbes?: number;
  nowMs?: () => number;
}

export interface BlockByDateDiagnostics {
  sourceFetches: number;
  cacheHits: number;
  estimateProbes: number;
  binaryProbes: number;
  cacheBypasses: number;
  usedBinaryFallback: boolean;
}

export interface FindBlockCandidateResult {
  candidateBlock: number;
  diagnostics: BlockByDateDiagnostics;
}

export type BlockByDateErrorCode = 'INVALID_INPUT' | 'MALFORMED_HEADER' | 'NON_MONOTONIC_DATA';

export class BlockByDateError extends Error {
  code: BlockByDateErrorCode;
  constructor(code: BlockByDateErrorCode, message: string) {
    super(message);
    this.name = 'BlockByDateError';
    this.code = code;
  }
}

const DEFAULT_RECENT_BLOCK_TTL_MS = 5_000;
const DEFAULT_FINALITY_DEPTH = 128;
const DEFAULT_MAX_ESTIMATE_PROBES = 5;
const DEFAULT_HEADER_CACHE_MAX = 10_000;
const AVG_REFRESH_TIP_DELTA = 50_000;
const AVG_REFRESH_AGE_MS = 24 * 60 * 60 * 1000;

export function createBlockByDateProviderState(): BlockByDateProviderState {
  return {
    headerCache: new LRUCache<number, CachedHeader>({ max: DEFAULT_HEADER_CACHE_MAX }),
    inFlight: new Map(),
    genesisHeader: null,
    avg: { valueSec: null, tipBlockNumber: null, computedAtMs: null }
  };
}

function validateHeader(h: BlockHeader, tag?: BlockTag): void {
  if (!h || typeof h !== 'object') {
    throw new BlockByDateError('MALFORMED_HEADER', 'header is null or not an object');
  }
  if (!Number.isSafeInteger(h.number) || h.number < 0) {
    throw new BlockByDateError('MALFORMED_HEADER', `invalid block number: ${h.number}`);
  }
  if (!Number.isSafeInteger(h.timestampSec) || h.timestampSec < 0) {
    throw new BlockByDateError('MALFORMED_HEADER', `invalid timestamp: ${h.timestampSec}`);
  }
  if (typeof tag === 'number' && h.number !== tag) {
    throw new BlockByDateError('MALFORMED_HEADER', `tag/number mismatch: requested ${tag}, got ${h.number}`);
  }
}

async function rawFetch(source: BlockHeaderSource, tag: BlockTag): Promise<BlockHeader> {
  const h = await source.getBlockHeader(tag);
  validateHeader(h, tag);
  return h;
}

async function getOrFetchHeader(
  state: BlockByDateProviderState,
  source: BlockHeaderSource,
  tag: BlockTag,
  diagnostics: BlockByDateDiagnostics,
  ctx: { latestNumber: number | null; finalityDepth: number; nowMs: () => number; recentBlockTtlMs: number }
): Promise<BlockHeader> {
  if (typeof tag === 'number') {
    const cached = state.headerCache.get(tag);
    if (cached) {
      const age = ctx.nowMs() - cached.fetchedAtMs;
      const reusable = !cached.reorgSensitive || age <= ctx.recentBlockTtlMs;
      if (reusable) {
        diagnostics.cacheHits++;
        return { number: tag, timestampSec: cached.timestampSec };
      }
    }
  }

  const existing = state.inFlight.get(tag);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    diagnostics.sourceFetches++;
    return await rawFetch(source, tag);
  })();
  state.inFlight.set(tag, promise);

  try {
    const header = await promise;
    if (typeof tag === 'number') {
      cacheNumericHeader(state, header, ctx);
    } else {
      // 'latest' result is keyed by its actual block number
      cacheNumericHeader(state, header, ctx);
    }
    return header;
  } finally {
    state.inFlight.delete(tag);
  }
}

function cacheNumericHeader(
  state: BlockByDateProviderState,
  header: BlockHeader,
  ctx: { latestNumber: number | null; finalityDepth: number; nowMs: () => number }
): void {
  const reorgSensitive =
    ctx.latestNumber == null
      ? true
      : header.number > ctx.latestNumber - ctx.finalityDepth;
  state.headerCache.set(header.number, {
    timestampSec: header.timestampSec,
    fetchedAtMs: ctx.nowMs(),
    reorgSensitive
  });
}

async function fetchHeaderBypass(
  state: BlockByDateProviderState,
  source: BlockHeaderSource,
  n: number,
  diagnostics: BlockByDateDiagnostics,
  ctx: { latestNumber: number | null; finalityDepth: number; nowMs: () => number }
): Promise<BlockHeader> {
  state.headerCache.delete(n);
  diagnostics.sourceFetches++;
  diagnostics.cacheBypasses++;
  const header = await rawFetch(source, n);
  cacheNumericHeader(state, header, ctx);
  return header;
}

function refreshAvgIfStale(
  state: BlockByDateProviderState,
  latest: BlockHeader,
  genesis: BlockHeader,
  nowMs: () => number
): void {
  const a = state.avg;
  const stale =
    a.valueSec == null ||
    a.tipBlockNumber == null ||
    a.computedAtMs == null ||
    latest.number - a.tipBlockNumber >= AVG_REFRESH_TIP_DELTA ||
    nowMs() - a.computedAtMs > AVG_REFRESH_AGE_MS;

  if (stale && latest.number > 0) {
    const value = (latest.timestampSec - genesis.timestampSec) / latest.number;
    a.valueSec = Number.isFinite(value) && value > 0 ? value : null;
    a.tipBlockNumber = latest.number;
    a.computedAtMs = nowMs();
  }
}

export async function findBlockCandidateByTimestamp(
  source: BlockHeaderSource,
  targetTimestampSec: number,
  opts: FindBlockCandidateOptions
): Promise<FindBlockCandidateResult> {
  if (!Number.isFinite(targetTimestampSec) || !Number.isSafeInteger(targetTimestampSec)) {
    throw new BlockByDateError('INVALID_INPUT', `targetTimestampSec must be a finite safe integer; got ${targetTimestampSec}`);
  }

  const recentBlockTtlMs = opts.recentBlockTtlMs ?? DEFAULT_RECENT_BLOCK_TTL_MS;
  const finalityDepth = opts.finalityDepth ?? DEFAULT_FINALITY_DEPTH;
  const maxEstimateProbes = opts.maxEstimateProbes ?? DEFAULT_MAX_ESTIMATE_PROBES;
  const nowMs = opts.nowMs ?? Date.now;
  const state = opts.state;

  const diagnostics: BlockByDateDiagnostics = {
    sourceFetches: 0,
    cacheHits: 0,
    estimateProbes: 0,
    binaryProbes: 0,
    cacheBypasses: 0,
    usedBinaryFallback: false
  };

  // Initial latest fetch: latestNumber is unknown, so reorgSensitive defaults to true on cache write.
  const initialCtx = { latestNumber: null as number | null, finalityDepth, nowMs, recentBlockTtlMs };
  const latest = await getOrFetchHeader(state, source, 'latest', diagnostics, initialCtx);

  const ctx = { latestNumber: latest.number, finalityDepth, nowMs, recentBlockTtlMs };
  // Re-cache latest with proper reorgSensitive flag now that we know the tip.
  cacheNumericHeader(state, latest, ctx);

  if (latest.number === 0) {
    return { candidateBlock: 0, diagnostics };
  }
  if (targetTimestampSec >= latest.timestampSec) {
    return { candidateBlock: latest.number, diagnostics };
  }

  let genesis = state.genesisHeader;
  if (!genesis) {
    genesis = await getOrFetchHeader(state, source, 0, diagnostics, ctx);
    state.genesisHeader = genesis;
  }
  if (targetTimestampSec < genesis.timestampSec) {
    return { candidateBlock: 0, diagnostics };
  }

  refreshAvgIfStale(state, latest, genesis, nowMs);

  let low: BlockHeader = genesis;
  let high: BlockHeader = latest;
  const probed = new Set<number>([genesis.number, latest.number]);

  // Tighten bracket using one estimate probe (if avg is usable).
  const avg = state.avg.valueSec;
  if (avg && avg > 0 && Number.isFinite(avg)) {
    let guess = latest.number - Math.floor((latest.timestampSec - targetTimestampSec) / avg);
    if (guess <= low.number) guess = low.number + 1;
    if (guess >= high.number) guess = high.number - 1;
    if (guess > low.number && guess < high.number && !probed.has(guess)) {
      const probe = await getOrFetchHeader(state, source, guess, diagnostics, ctx);
      diagnostics.estimateProbes++;
      probed.add(guess);
      const tighten = tightenBracket(low, high, probe, targetTimestampSec);
      if (tighten === 'NON_MONOTONIC') {
        await handleMonotonicityViolation(state, source, probe, low, high, diagnostics, ctx, targetTimestampSec);
        // re-tighten with refreshed probe
        const refreshed = state.headerCache.get(probe.number)!;
        const refreshedHeader: BlockHeader = { number: probe.number, timestampSec: refreshed.timestampSec };
        const t2 = tightenBracket(low, high, refreshedHeader, targetTimestampSec);
        if (t2 === 'NON_MONOTONIC') {
          throw new BlockByDateError('NON_MONOTONIC_DATA', `probe at ${probe.number} violates bracket invariant`);
        }
        if (t2.low) low = t2.low;
        if (t2.high) high = t2.high;
      } else {
        if (tighten.low) low = tighten.low;
        if (tighten.high) high = tighten.high;
      }
    }

    // Interpolation refinement
    for (let i = 0; i < maxEstimateProbes; i++) {
      if (high.number - low.number <= 1) {
        return { candidateBlock: low.number, diagnostics };
      }
      const slope = (high.timestampSec - low.timestampSec) / (high.number - low.number);
      if (!Number.isFinite(slope) || slope <= 0 || low.timestampSec === high.timestampSec) {
        break;
      }
      let next = low.number + Math.round((targetTimestampSec - low.timestampSec) / slope);
      if (next <= low.number) next = low.number + 1;
      if (next >= high.number) next = high.number - 1;
      if (probed.has(next)) {
        break;
      }
      const probe = await getOrFetchHeader(state, source, next, diagnostics, ctx);
      diagnostics.estimateProbes++;
      probed.add(next);
      const tighten = tightenBracket(low, high, probe, targetTimestampSec);
      if (tighten === 'NON_MONOTONIC') {
        await handleMonotonicityViolation(state, source, probe, low, high, diagnostics, ctx, targetTimestampSec);
        const refreshed = state.headerCache.get(probe.number)!;
        const refreshedHeader: BlockHeader = { number: probe.number, timestampSec: refreshed.timestampSec };
        const t2 = tightenBracket(low, high, refreshedHeader, targetTimestampSec);
        if (t2 === 'NON_MONOTONIC') {
          throw new BlockByDateError('NON_MONOTONIC_DATA', `probe at ${probe.number} violates bracket invariant`);
        }
        if (t2.low) low = t2.low;
        if (t2.high) high = t2.high;
      } else {
        if (tighten.low) low = tighten.low;
        if (tighten.high) high = tighten.high;
      }
    }
  }

  // Binary search fallback
  if (high.number - low.number > 1) {
    diagnostics.usedBinaryFallback = true;
    const span = high.number - low.number;
    const maxBinary = Math.ceil(Math.log2(Math.max(2, span))) + 2;
    let iters = 0;
    while (high.number - low.number > 1) {
      if (iters >= maxBinary) {
        throw new BlockByDateError('NON_MONOTONIC_DATA', `binary search exceeded ${maxBinary} iterations on span ${span}`);
      }
      iters++;
      const mid = Math.floor((low.number + high.number) / 2);
      if (probed.has(mid)) {
        // Should not happen in pure binary; defensive break.
        break;
      }
      const probe = await getOrFetchHeader(state, source, mid, diagnostics, ctx);
      diagnostics.binaryProbes++;
      probed.add(mid);
      const tighten = tightenBracket(low, high, probe, targetTimestampSec);
      if (tighten === 'NON_MONOTONIC') {
        await handleMonotonicityViolation(state, source, probe, low, high, diagnostics, ctx, targetTimestampSec);
        const refreshed = state.headerCache.get(probe.number)!;
        const refreshedHeader: BlockHeader = { number: probe.number, timestampSec: refreshed.timestampSec };
        const t2 = tightenBracket(low, high, refreshedHeader, targetTimestampSec);
        if (t2 === 'NON_MONOTONIC') {
          throw new BlockByDateError('NON_MONOTONIC_DATA', `mid probe at ${mid} violates bracket invariant`);
        }
        if (t2.low) low = t2.low;
        if (t2.high) high = t2.high;
      } else {
        if (tighten.low) low = tighten.low;
        if (tighten.high) high = tighten.high;
      }
    }
  }

  return { candidateBlock: low.number, diagnostics };
}

type TightenResult = { low?: BlockHeader; high?: BlockHeader } | 'NON_MONOTONIC';

function tightenBracket(
  low: BlockHeader,
  high: BlockHeader,
  probe: BlockHeader,
  target: number
): TightenResult {
  // Probe must be strictly inside the bracket for monotonicity check.
  if (probe.number > low.number && probe.number < high.number) {
    if (probe.timestampSec <= low.timestampSec || probe.timestampSec >= high.timestampSec) {
      return 'NON_MONOTONIC';
    }
  }
  if (probe.timestampSec <= target) {
    if (probe.number > low.number) return { low: probe };
    return {};
  } else {
    if (probe.number < high.number) return { high: probe };
    return {};
  }
}

async function handleMonotonicityViolation(
  state: BlockByDateProviderState,
  source: BlockHeaderSource,
  probe: BlockHeader,
  _low: BlockHeader,
  _high: BlockHeader,
  diagnostics: BlockByDateDiagnostics,
  ctx: { latestNumber: number | null; finalityDepth: number; nowMs: () => number },
  _target: number
): Promise<void> {
  // Bypass-refetch the suspect block once.
  await fetchHeaderBypass(state, source, probe.number, diagnostics, ctx);
}
