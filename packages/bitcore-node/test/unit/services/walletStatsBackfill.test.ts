import { expect } from 'chai';
import { ObjectID } from 'mongodb';
import * as sinon from 'sinon';
import { WalletStatsStorage } from '../../../src/models/walletStats';
import { WalletStatsWalletStorage } from '../../../src/models/walletStatsWallet';
import { WalletStatsService } from '../../../src/services/walletStats';
import { lastActivityAt, MAX_HISTORY_PAGES, WalletStatsBackfiller } from '../../../src/services/walletStatsBackfill';
import axios from 'axios';
import logger from '../../../src/logger';

/** Chainable cursor: find().project().sort().limit().toArray() all resolve to rows. */
const cursorOf = (rows: any[]) => {
  const c: any = { project: () => c, sort: () => c, limit: () => c, toArray: async () => rows };
  return c;
};

describe('WalletStats Backfiller', function() {
  const sandbox = sinon.createSandbox();
  afterEach(() => sandbox.restore());

  /** A backfiller over a stubbed collector; `svc` exposes the collector for stubbing. */
  const backfiller = (deps: any = {}) => {
    const svc = new WalletStatsService({
      configService: { for: () => ({}), isDisabled: () => false },
      ...deps
    } as any);
    const instance = new WalletStatsBackfiller(svc) as WalletStatsBackfiller & { svc: WalletStatsService };
    instance.svc = svc;
    return instance;
  };

  describe('backfillDates', () => {
    // Mondays in Aug 2026: 3, 10, 17, 24, 31.
    const svc = (serviceConfig: any = {}) =>
      backfiller({ configService: { for: () => serviceConfig, isDisabled: () => false } } as any);

    it('lists the weekly schedule days across the range', () => {
      expect(svc().backfillDates('2026-08-03', '2026-08-24')).to.deep.equal([
        '2026-08-03',
        '2026-08-10',
        '2026-08-17',
        '2026-08-24'
      ]);
    });

    it('rounds a mid-week start forward to the first schedule day', () => {
      expect(svc().backfillDates('2026-08-05', '2026-08-17')).to.deep.equal(['2026-08-10', '2026-08-17']);
    });

    it('stops before a to-date that is not itself a schedule day', () => {
      expect(svc().backfillDates('2026-08-03', '2026-08-13')).to.deep.equal(['2026-08-03', '2026-08-10']);
    });

    it('returns nothing when the range contains no schedule day', () => {
      expect(svc().backfillDates('2026-08-04', '2026-08-09')).to.deep.equal([]);
    });

    it('refuses an unparseable date instead of walking forever', () => {
      // '2026-08-03' > 'garbage' is false, so the walk's terminator never fires and
      // the loop runs until memory gives out. Both bounds get validated.
      expect(svc().backfillDates('2026-08-03', 'garbage')).to.deep.equal([]);
      expect(svc().backfillDates('2026-08-03', 'today')).to.deep.equal([]);
      expect(svc().backfillDates('garbage', '2026-08-24')).to.deep.equal([]);
      expect(svc().backfillDates('', '')).to.deep.equal([]);
    });

    it('refuses a well formed date that never happened', () => {
      expect(svc().backfillDates('2026-08-03', '2026-02-30')).to.deep.equal([]);
      expect(svc().backfillDates('2026-13-45', '2026-08-24')).to.deep.equal([]);
    });

    it('returns nothing when the range is inverted', () => {
      expect(svc().backfillDates('2026-08-24', '2026-08-03')).to.deep.equal([]);
    });

    it('follows a configured schedule day rather than assuming Monday', () => {
      expect(svc({ snapshotDayUTC: 3 }).backfillDates('2026-08-03', '2026-08-19')).to.deep.equal([
        '2026-08-05',
        '2026-08-12',
        '2026-08-19'
      ]);
    });

    it('lands on the same weekday the interval service would pick, so the series interleave', () => {
      const service = svc();
      const dates = service.backfillDates('2026-07-01', '2026-08-24');
      const live = service.svc.snapshotDateIfDue(new Date('2026-08-26T12:00:00Z'), null);
      const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
      expect(dates.length).to.be.greaterThan(0);
      expect(dates.every(d => weekday(d) === weekday(live!))).to.equal(true);
    });

    it('spans a year boundary without drifting off the schedule day', () => {
      expect(svc().backfillDates('2025-12-22', '2026-01-12')).to.deep.equal([
        '2025-12-22',
        '2025-12-29',
        '2026-01-05',
        '2026-01-12'
      ]);
    });
  });

  describe('snapshotExists', () => {
    const svcWith = (findOne: any) =>
      backfiller({
        walletStatsModel: { collection: { findOne } },
        configService: { for: () => ({}), isDisabled: () => false }
      } as any);

    it('is true when the snapshot is already there', async () => {
      const findOne = sandbox.stub().resolves({ _id: new ObjectID() });
      const exists = await svcWith(findOne).snapshotExists({ chain: 'BTC', network: 'mainnet', date: '2026-08-03' });
      expect(exists).to.equal(true);
      expect(findOne.calledOnceWith({ chain: 'BTC', network: 'mainnet', date: '2026-08-03' })).to.equal(true);
    });

    it('is false when it is absent', async () => {
      expect(await svcWith(sandbox.stub().resolves(null)).snapshotExists({ chain: 'BTC', network: 'mainnet', date: '2026-08-03' })).to.equal(
        false
      );
    });
  });

  describe('persistBackfill', () => {
    const makeBackfillDeps = () => {
      const updateOne = sandbox.stub().resolves();
      const bulkWrite = sandbox.stub().resolves();
      const service = backfiller({
        walletStatsModel: { collection: { updateOne } },
        walletStatsWalletModel: { collection: { bulkWrite } },
        configService: { for: () => ({}), isDisabled: () => false }
      } as any);
      return { service, updateOne, bulkWrite };
    };

    const snapshotFor = (date: string) => WalletStatsStorage.newSnapshot({ chain: 'BTC', network: 'mainnet', date });

    it('inserts the snapshot only when it is absent', async () => {
      const { service, updateOne } = makeBackfillDeps();
      await service.persistBackfill({
        chain: 'BTC',
        network: 'mainnet',
        snapshot: snapshotFor('2026-08-03'),
        walletFacts: []
      });
      const [filter, update, options] = updateOne.firstCall.args;
      expect(filter).to.deep.equal({ chain: 'BTC', network: 'mainnet', date: '2026-08-03' });
      expect(options).to.deep.equal({ upsert: true });
      // The whole point: an existing snapshot, interval or backfill, must survive untouched.
      expect(Object.keys(update)).to.deep.equal(['$setOnInsert']);
      expect(update.$set).to.equal(undefined);
    });

    it('stamps the snapshot as backfilled', async () => {
      const { service, updateOne } = makeBackfillDeps();
      const snapshot = snapshotFor('2026-08-03');
      expect(snapshot.meta.source).to.equal('interval');
      await service.persistBackfill({ chain: 'BTC', network: 'mainnet', snapshot, walletFacts: [] });
      expect(updateOne.firstCall.args[1].$setOnInsert.meta.source).to.equal('backfill');
    });

    it('records which counters a partial snapshot is missing', async () => {
      const { service, updateOne } = makeBackfillDeps();
      await service.persistBackfill({
        chain: 'BTC',
        network: 'mainnet',
        snapshot: snapshotFor('2026-08-03'),
        walletFacts: [],
        partial: ['balances']
      });
      expect(updateOne.firstCall.args[1].$setOnInsert.meta.partial).to.deep.equal(['balances']);
    });

    it('leaves meta.partial off a complete snapshot', async () => {
      const { service, updateOne } = makeBackfillDeps();
      await service.persistBackfill({
        chain: 'BTC',
        network: 'mainnet',
        snapshot: snapshotFor('2026-08-03'),
        walletFacts: []
      });
      expect(updateOne.firstCall.args[1].$setOnInsert.meta.partial).to.equal(undefined);
    });

    it('upserts the per-wallet facts, which are keyed to be idempotent', async () => {
      const { service, bulkWrite } = makeBackfillDeps();
      const wallet = new ObjectID();
      await service.persistBackfill({
        chain: 'BTC',
        network: 'mainnet',
        snapshot: snapshotFor('2026-08-03'),
        walletFacts: [
          {
            wallet,
            chain: 'BTC',
            network: 'mainnet',
            snapshotDate: '2026-08-03',
            createdDate: new Date('2026-01-01T00:00:00Z'),
            balance: '10',
            isDup: false
          }
        ]
      });
      const [ops] = bulkWrite.firstCall.args;
      expect(ops[0].updateOne.filter).to.deep.equal({
        chain: 'BTC',
        network: 'mainnet',
        snapshotDate: '2026-08-03',
        wallet
      });
      expect(ops[0].updateOne.upsert).to.equal(true);
    });

    it('skips the fact write when there are no facts', async () => {
      const { service, bulkWrite } = makeBackfillDeps();
      await service.persistBackfill({
        chain: 'BTC',
        network: 'mainnet',
        snapshot: snapshotFor('2026-08-03'),
        walletFacts: []
      });
      expect(bulkWrite.called).to.equal(false);
    });
  });

  describe('collectUtxoBalancesAt', () => {
    const makeSvc = (over: any = {}) => {
      const aggregate = sandbox.stub().returns(cursorOf(over.coinRows ?? []));
      const find = sandbox.stub().returns(cursorOf(over.blockRows ?? [{ height: 800000 }]));
      const service = backfiller({
        coinModel: { collection: { aggregate } },
        blockModel: { collection: { find } },
        configService: { for: () => ({}), isDisabled: () => false }
      } as any);
      return { service, aggregate, find };
    };

    it('cuts off at the last block on or before the date, as getBalanceAtTime does', async () => {
      const { service, find } = makeSvc();
      await service.collectUtxoBalancesAt({ chain: 'BTC', network: 'mainnet', date: '2026-08-03' });
      expect(find.firstCall.args[0]).to.deep.equal({
        chain: 'BTC',
        network: 'mainnet',
        timeNormalized: { $lte: new Date('2026-08-03T00:00:00Z') }
      });
    });

    it('counts coins minted by that height and not yet spent at it', async () => {
      const { service, aggregate } = makeSvc({ blockRows: [{ height: 800000 }] });
      await service.collectUtxoBalancesAt({ chain: 'BTC', network: 'mainnet', date: '2026-08-03' });
      const [pipeline, options] = aggregate.firstCall.args;
      expect(pipeline[0].$match).to.deep.equal({
        chain: 'BTC',
        network: 'mainnet',
        'wallets.0': { $exists: true },
        mintHeight: { $gte: 0, $lte: 800000 },
        $or: [{ spentHeight: { $gt: 800000 } }, { spentHeight: { $lt: 0 } }]
      });
      expect(options.hint).to.deep.equal({ wallets: 1, spentHeight: 1, value: 1, mintHeight: 1 });
      expect(options.allowDiskUse).to.equal(true);
    });

    it('unwinds shared coins and sums per wallet', async () => {
      const { service, aggregate } = makeSvc();
      await service.collectUtxoBalancesAt({ chain: 'BTC', network: 'mainnet', date: '2026-08-03' });
      const [pipeline] = aggregate.firstCall.args;
      expect(pipeline[1]).to.deep.equal({ $unwind: '$wallets' });
      expect(pipeline[2]).to.deep.equal({ $group: { _id: '$wallets', balance: { $sum: '$value' } } });
    });

    it('returns balances keyed by wallet id', async () => {
      const wallet = new ObjectID();
      const { service } = makeSvc({ coinRows: [{ _id: wallet, balance: 4200 }] });
      const balances = await service.collectUtxoBalancesAt({ chain: 'BTC', network: 'mainnet', date: '2026-08-03' });
      expect(balances.get(wallet.toString())).to.equal(BigInt(4200));
    });

    it('returns nothing when the chain had no blocks yet at that date', async () => {
      const { service, aggregate } = makeSvc({ blockRows: [] });
      const balances = await service.collectUtxoBalancesAt({ chain: 'BTC', network: 'mainnet', date: '2015-01-01' });
      expect(balances.size).to.equal(0);
      expect(aggregate.called).to.equal(false);
    });
  });

  describe('collectUtxoActivityAt', () => {
    // find() answers three different questions in order: window-start height,
    // as-of height, then the block range scan.
    const makeSvc = (over: any = {}) => {
      const aggregate = sandbox.stub().returns(cursorOf(over.coinRows ?? []));
      const find = sandbox.stub();
      find.onCall(0).returns(cursorOf(over.startBlock ?? [{ height: 700000 }]));
      find.onCall(1).returns(cursorOf(over.asOfBlock ?? [{ height: 800000 }]));
      find.onCall(2).returns(cursorOf(over.blocks ?? []));
      const service = backfiller({
        coinModel: { collection: { aggregate } },
        blockModel: { collection: { find } },
        configService: { for: () => ({}), isDisabled: () => false }
      } as any);
      return { service, aggregate, find };
    };

    const call = (service: any) =>
      service.collectUtxoActivityAt({
        chain: 'BTC',
        network: 'mainnet',
        date: '2026-08-03',
        windowStart: new Date('2025-08-03T00:00:00Z')
      });

    it('bounds the window by the first block in it and the last block by the date', async () => {
      const { service, find } = makeSvc();
      await call(service);
      expect(find.getCall(0).args[0]).to.deep.equal({
        chain: 'BTC',
        network: 'mainnet',
        timeNormalized: { $gte: new Date('2025-08-03T00:00:00Z') }
      });
      expect(find.getCall(1).args[0]).to.deep.equal({
        chain: 'BTC',
        network: 'mainnet',
        timeNormalized: { $lte: new Date('2026-08-03T00:00:00Z') }
      });
    });

    it('ignores activity that happened after the date being reconstructed', async () => {
      const { service, aggregate } = makeSvc();
      await call(service);
      const [pipeline] = aggregate.firstCall.args;
      const projected = pipeline.find((stage: any) => stage.$project);
      // A coin minted inside the window but spent long after it must contribute its
      // MINT height, not its spend; a plain $max of the two would read the future.
      expect(projected.$project.activityHeight).to.deep.equal({
        $max: [
          { $cond: [{ $and: [{ $gte: ['$mintHeight', 700000] }, { $lte: ['$mintHeight', 800000] }] }, '$mintHeight', -1] },
          { $cond: [{ $and: [{ $gte: ['$spentHeight', 700000] }, { $lte: ['$spentHeight', 800000] }] }, '$spentHeight', -1] }
        ]
      });
    });

    it('keeps only wallets with activity inside the window, and takes their latest', async () => {
      const { service, aggregate } = makeSvc();
      await call(service);
      const [pipeline] = aggregate.firstCall.args;
      expect(pipeline.some((stage: any) => stage.$match?.activityHeight?.$gte === 700000)).to.equal(true);
      const grouped = pipeline.find((stage: any) => stage.$group);
      expect(grouped.$group).to.deep.equal({ _id: '$wallets', maxHeight: { $max: '$activityHeight' } });
    });

    it('dates each wallet by the block its latest activity landed in', async () => {
      const wallet = new ObjectID();
      const when = new Date('2026-07-20T04:00:00Z');
      const { service } = makeSvc({
        coinRows: [{ _id: wallet, maxHeight: 750000 }],
        blocks: [{ height: 750000, timeNormalized: when }]
      });
      const activity = await call(service);
      expect(activity.get(wallet.toString())).to.deep.equal(when);
    });

    it('scans only the blocks inside the window when resolving heights', async () => {
      const { service, find } = makeSvc({ coinRows: [{ _id: new ObjectID(), maxHeight: 750000 }] });
      await call(service);
      expect(find.getCall(2).args[0]).to.deep.equal({
        chain: 'BTC',
        network: 'mainnet',
        height: { $gte: 700000, $lte: 800000 }
      });
    });

    it('skips the block scan when no wallet was active', async () => {
      const { service, find } = makeSvc({ coinRows: [] });
      const activity = await call(service);
      expect(activity.size).to.equal(0);
      expect(find.callCount).to.equal(2);
    });

    it('returns nothing when the window has no blocks at all', async () => {
      const { service, aggregate } = makeSvc({ startBlock: [] });
      const activity = await call(service);
      expect(activity.size).to.equal(0);
      expect(aggregate.called).to.equal(false);
    });

    it('returns nothing when the chain had no blocks by that date', async () => {
      const { service, aggregate } = makeSvc({ asOfBlock: [] });
      const activity = await call(service);
      expect(activity.size).to.equal(0);
      expect(aggregate.called).to.equal(false);
    });
  });

  describe('lastActivityAt', () => {
    const stamps = ['2026-01-15', '2026-05-20', '2026-07-30'].map(d => new Date(`${d}T00:00:00Z`));
    const asOf = (d: string) => new Date(`${d}T00:00:00Z`);
    const windowFor = (d: string) => {
      const start = asOf(d);
      start.setUTCFullYear(start.getUTCFullYear() - 1);
      return start;
    };

    it('takes the newest transfer at or before the date', () => {
      expect(lastActivityAt(stamps, asOf('2026-08-03'), windowFor('2026-08-03'))).to.deep.equal(stamps[2]);
    });

    it('does not let later activity leak into an earlier date', () => {
      expect(lastActivityAt(stamps, asOf('2026-06-01'), windowFor('2026-06-01'))).to.deep.equal(stamps[1]);
    });

    it('ignores activity older than the twelve month window', () => {
      const old = [new Date('2024-01-01T00:00:00Z')];
      expect(lastActivityAt(old, asOf('2026-08-03'), windowFor('2026-08-03'))).to.equal(undefined);
    });

    it('counts a transfer landing exactly on either boundary', () => {
      const onAsOf = [asOf('2026-08-03')];
      expect(lastActivityAt(onAsOf, asOf('2026-08-03'), windowFor('2026-08-03'))).to.deep.equal(onAsOf[0]);
      const onStart = [windowFor('2026-08-03')];
      expect(lastActivityAt(onStart, asOf('2026-08-03'), windowFor('2026-08-03'))).to.deep.equal(onStart[0]);
    });

    it('is undefined for a wallet with no transfers at all', () => {
      expect(lastActivityAt([], asOf('2026-08-03'), windowFor('2026-08-03'))).to.equal(undefined);
    });
  });

  describe('fetchAddressActivityDates', () => {
    const makeSvc = ({ apiKey }: { apiKey?: string } = { apiKey: 'key' }) =>
      backfiller({
        configService: {
          get: () => ({ externalProviders: apiKey ? { moralis: { apiKey } } : {} }),
          for: () => ({}),
          isDisabled: () => false
        },
        cspProvider: { get: () => ({ getChainId: async () => 1 }) }
      } as any);

    const call = (instance: any) =>
      instance.fetchAddressActivityDates({
        chain: 'ETH',
        network: 'mainnet',
        address: '0xabc',
        from: new Date('2025-08-03T00:00:00Z'),
        to: new Date('2026-08-03T00:00:00Z')
      });

    it('asks for one bounded, spam-excluded page of history', async () => {
      const get = sandbox.stub(axios, 'get').resolves({ data: { result: [] } });
      await call(makeSvc());
      const { params } = get.firstCall.args[1] as any;
      expect(params.from_date).to.equal('2025-08-03T00:00:00.000Z');
      expect(params.to_date).to.equal('2026-08-03T00:00:00.000Z');
      expect(params.exclude_spam).to.equal(true);
      expect(params.limit).to.be.greaterThan(0);
      expect((get.firstCall.args[1] as any).timeout).to.equal(30000);
    });

    it('follows the cursor until the history runs out', async () => {
      const get = sandbox.stub(axios, 'get');
      get.onCall(0).resolves({ data: { result: [{ block_timestamp: '2026-01-15T00:00:00Z' }], cursor: 'next' } });
      get.onCall(1).resolves({ data: { result: [{ block_timestamp: '2026-05-20T00:00:00Z' }] } });
      const dates = await call(makeSvc());
      expect(get.callCount).to.equal(2);
      expect((get.secondCall.args[1] as any).params.cursor).to.equal('next');
      expect(dates).to.deep.equal([new Date('2026-01-15T00:00:00Z'), new Date('2026-05-20T00:00:00Z')]);
    });

    it('stops at the page cap rather than paging forever', async () => {
      const get = sandbox
        .stub(axios, 'get')
        .resolves({ data: { result: [{ block_timestamp: '2026-01-15T00:00:00Z' }], cursor: 'always' } });
      const warn = sandbox.stub(logger, 'warn');
      await call(makeSvc());
      expect(get.callCount).to.equal(MAX_HISTORY_PAGES);
      expect(warn.called).to.equal(true); // truncation is a fidelity loss, so it is not silent
    });

    it('drops spam rows the provider still returned', async () => {
      sandbox.stub(axios, 'get').resolves({
        data: {
          result: [
            { block_timestamp: '2026-05-20T00:00:00Z', possible_spam: true },
            { block_timestamp: '2026-01-15T00:00:00Z', possible_spam: false }
          ]
        }
      });
      expect(await call(makeSvc())).to.deep.equal([new Date('2026-01-15T00:00:00Z')]);
    });

    it('returns the timestamps oldest first', async () => {
      sandbox.stub(axios, 'get').resolves({
        data: {
          result: [{ block_timestamp: '2026-05-20T00:00:00Z' }, { block_timestamp: '2026-01-15T00:00:00Z' }]
        }
      });
      expect(await call(makeSvc())).to.deep.equal([
        new Date('2026-01-15T00:00:00Z'),
        new Date('2026-05-20T00:00:00Z')
      ]);
    });

    it('refuses to run without an api key instead of reporting no activity', async () => {
      const get = sandbox.stub(axios, 'get');
      let error: any;
      await call(makeSvc({})).catch((e: any) => (error = e));
      expect(error).to.be.an('error');
      expect(get.called).to.equal(false);
    });

    it('passes its own stop signal into the retry rather than the collector one', async () => {
      const instance = makeSvc();
      const retry = sandbox.spy(instance.svc, 'withRateLimitRetry');
      sandbox.stub(axios, 'get').resolves({ data: { result: [] } });
      await call(instance);
      const isStopped = retry.firstCall.args[1] as () => boolean;
      expect(isStopped).to.be.a('function');
      expect(isStopped()).to.equal(false);
      instance.stop();
      expect(isStopped()).to.equal(true);
    });

    it('retries a rate-limited page', async () => {
      const instance = makeSvc();
      const retry = sandbox.spy(instance.svc, 'withRateLimitRetry');
      sandbox.stub(axios, 'get').resolves({ data: { result: [] } });
      await call(instance);
      expect(retry.called).to.equal(true);
    });
  });

  describe('backfillEvmChain', () => {
    const NOW = new Date('2026-08-31T00:00:00Z');
    const walletCreatedAt = (iso: string) => ({ _id: ObjectID.createFromTime(new Date(iso).getTime() / 1000) });

    const makeSvc = (over: any = {}) => {
      const wallets = over.wallets ?? [walletCreatedAt('2025-01-01T00:00:00Z')];
      const waitFn = sandbox.stub().resolves();
      const instance = backfiller({
        walletModel: { collection: { find: () => cursorOf(wallets) } },
        walletAddressModel: { collection: { find: () => cursorOf(over.addresses ?? [{ address: '0xabc' }]) } },
        walletStatsModel: { collection: {}, newSnapshot: (p: any) => WalletStatsStorage.newSnapshot(p) },
        walletStatsWalletModel: {
          collection: {},
          activityWindow: (d: any, asOf: any) => WalletStatsWalletStorage.activityWindow(d, asOf)
        },
        configService: { for: () => over.serviceConfig ?? {}, isDisabled: () => false },
        nowFn: () => NOW.getTime(),
        waitFn
      } as any);
      const exists = sandbox.stub(instance, 'snapshotExists').resolves(false);
      const fetch = sandbox
        .stub(instance, 'fetchAddressActivityDates')
        .resolves(over.stamps ?? [new Date('2026-07-30T00:00:00Z')]);
      const persist = sandbox.stub(instance, 'persistBackfill').resolves();
      sandbox.stub(instance.svc, 'detectDups').resolves(new Set());
      return { instance, exists, fetch, persist, waitFn };
    };

    const run = (instance: any, dates: string[], opts: any = {}) =>
      instance.backfillEvmChain({ chain: 'ETH', network: 'mainnet', dates, ...opts });

    it('reads each address history once for the whole range', async () => {
      const { instance, fetch } = makeSvc();
      await run(instance, ['2026-08-03', '2026-08-10', '2026-08-17']);
      expect(fetch.callCount).to.equal(1);
      const { from, to } = fetch.firstCall.args[0];
      // twelve months before the oldest date, through the newest
      expect(from).to.deep.equal(new Date('2025-08-03T00:00:00Z'));
      expect(to).to.deep.equal(new Date('2026-08-17T00:00:00Z'));
    });

    it('derives every date from that one pass', async () => {
      const { instance, persist } = makeSvc({ stamps: [new Date('2026-07-30T00:00:00Z')] });
      await run(instance, ['2026-07-27', '2026-08-03']);
      const dates = persist.getCalls().map(c => c.args[0].snapshot.date);
      expect(dates).to.deep.equal(['2026-07-27', '2026-08-03']);
      // The transfer is after the 27th, so only the later snapshot counts it active.
      const [earlier, later] = persist.getCalls().map(c => c.args[0].walletFacts[0].lastActivityDate);
      expect(earlier).to.equal(undefined);
      expect(later).to.deep.equal(new Date('2026-07-30T00:00:00Z'));
    });

    it('skips a date that already has a snapshot', async () => {
      const { instance, exists, persist } = makeSvc();
      exists.withArgs(sinon.match({ date: '2026-08-03' })).resolves(true);
      const summary = await run(instance, ['2026-08-03', '2026-08-10']);
      expect(persist.getCalls().map(c => c.args[0].snapshot.date)).to.deep.equal(['2026-08-10']);
      expect(summary.skipped).to.equal(1);
    });

    it('touches no provider at all when every date is already there', async () => {
      const { instance, exists, fetch } = makeSvc();
      exists.resolves(true);
      const summary = await run(instance, ['2026-08-03', '2026-08-10']);
      expect(fetch.called).to.equal(false);
      expect(summary).to.deep.equal({ written: 0, skipped: 2, erroredDates: 0, erroredWallets: 0 });
    });

    it('marks the snapshot partial and leaves balances off the facts', async () => {
      const { instance, persist } = makeSvc();
      await run(instance, ['2026-08-03']);
      const { snapshot, walletFacts, partial } = persist.firstCall.args[0];
      expect(partial).to.deep.equal(['balances']);
      expect(snapshot.totalBalance).to.equal('0');
      // Absent, not '0' — a consumer must be able to tell unknown from empty.
      expect('balance' in walletFacts[0]).to.equal(false);
      expect('nonce' in walletFacts[0]).to.equal(false);
    });

    it('reads balances per date when asked, and then is not partial', async () => {
      const { instance, persist } = makeSvc();
      const getBalanceAt = sandbox.stub().resolves('4200');
      await run(instance, ['2026-08-03', '2026-08-10'], { evmBalances: true, getBalanceAt });
      expect(getBalanceAt.callCount).to.equal(2); // one wallet, two dates
      expect(getBalanceAt.firstCall.args[0].date).to.equal('2026-08-03');
      const { snapshot, walletFacts, partial } = persist.firstCall.args[0];
      expect(partial).to.equal(undefined);
      expect(snapshot.totalBalance).to.equal('4200');
      expect(walletFacts[0].balance).to.equal('4200');
    });

    it('counts only the wallets that existed on each date', async () => {
      const { instance, persist } = makeSvc({
        wallets: [walletCreatedAt('2025-01-01T00:00:00Z'), walletCreatedAt('2026-08-20T00:00:00Z')]
      });
      await run(instance, ['2026-08-03']);
      expect(persist.firstCall.args[0].snapshot.walletCntTotal).to.equal('1');
    });

    it('writes nothing when every wallet history failed', async () => {
      // A missing or rejected api key fails every wallet identically. Writing the
      // dates anyway records "nobody was ever active", and insert-if-absent means a
      // corrected re-run skips those dates and the lie is permanent.
      const { instance, fetch, persist } = makeSvc({
        wallets: [walletCreatedAt('2025-01-01T00:00:00Z'), walletCreatedAt('2025-02-01T00:00:00Z')]
      });
      fetch.rejects(new Error('no api key'));
      const summary = await run(instance, ['2026-08-03', '2026-08-10']);
      expect(persist.called).to.equal(false);
      expect(summary.aborted).to.equal(true);
      expect(summary.written).to.equal(0);
      expect(summary.erroredWallets).to.equal(2);
    });

    it('does not abort when there were no wallets to read', async () => {
      const { instance, persist } = makeSvc({ wallets: [] });
      const summary = await run(instance, ['2026-08-03']);
      expect(summary.aborted).to.equal(undefined);
      expect(persist.calledOnce).to.equal(true); // an empty chain is a real, zeroed snapshot
    });

    it('carries on when one wallet history fails', async () => {
      const { instance, fetch, persist } = makeSvc({
        wallets: [walletCreatedAt('2025-01-01T00:00:00Z'), walletCreatedAt('2025-02-01T00:00:00Z')]
      });
      fetch.onFirstCall().rejects(new Error('provider down'));
      const summary = await run(instance, ['2026-08-03']);
      expect(persist.calledOnce).to.equal(true);
      // Failed wallets and failed dates are different problems, counted separately.
      expect(summary.erroredWallets).to.equal(1);
      expect(summary.erroredDates).to.equal(0);
      expect(persist.firstCall.args[0].snapshot.meta.erroredWalletCnt).to.equal(1);
    });

    it('stops cleanly when a shutdown is requested', async () => {
      const { instance, persist } = makeSvc();
      (instance.fetchAddressActivityDates as sinon.SinonStub).callsFake(async () => {
        instance.stopping = true;
        return [];
      });
      await run(instance, ['2026-08-03', '2026-08-10']);
      expect(persist.called).to.equal(false); // a partial history must not become a snapshot
    });

    it('throttles between wallets', async () => {
      const { instance, waitFn } = makeSvc({ serviceConfig: { sleepMs: 250, every: 1 } });
      await run(instance, ['2026-08-03']);
      expect(waitFn.called).to.equal(true);
    });

    it('does nothing when given no dates', async () => {
      const { instance, fetch, persist } = makeSvc();
      const summary = await run(instance, []);
      expect(fetch.called).to.equal(false);
      expect(persist.called).to.equal(false);
      expect(summary).to.deep.equal({ written: 0, skipped: 0, erroredDates: 0, erroredWallets: 0 });
    });
  });

  describe('backfillUtxoChain', () => {
    const NOW = new Date('2026-08-31T00:00:00Z');
    // ObjectIDs carry their creation time, which is how buildSnapshot dates a wallet.
    const walletCreatedAt = (iso: string) => ({ _id: ObjectID.createFromTime(new Date(iso).getTime() / 1000) });

    const makeSvc = (over: any = {}) => {
      const wallets = over.wallets ?? [walletCreatedAt('2025-01-01T00:00:00Z')];
      const cursor = cursorOf(wallets);
      const waitFn = sandbox.stub().resolves();
      const service = backfiller({
        walletModel: { collection: { find: () => cursor } },
        walletStatsModel: { collection: {}, newSnapshot: (p: any) => WalletStatsStorage.newSnapshot(p) },
        walletStatsWalletModel: {
          collection: {},
          activityWindow: (d: any, asOf: any) => WalletStatsWalletStorage.activityWindow(d, asOf)
        },
        configService: { for: () => over.serviceConfig ?? {}, isDisabled: () => false },
        nowFn: () => NOW.getTime(),
        waitFn
      } as any);
      const exists = sandbox.stub(service, 'snapshotExists').resolves(false);
      const balances = sandbox.stub(service, 'collectUtxoBalancesAt').resolves(new Map());
      const activity = sandbox.stub(service, 'collectUtxoActivityAt').resolves(new Map());
      const dups = sandbox.stub(service.svc, 'detectDups').resolves(new Set());
      const persist = sandbox.stub(service, 'persistBackfill').resolves();
      return { service, exists, balances, activity, dups, persist, waitFn };
    };

    const run = (service: any, dates: string[]) =>
      service.backfillUtxoChain({ chain: 'BTC', network: 'mainnet', dates });

    it('works through the dates oldest first', async () => {
      const { service, persist } = makeSvc();
      await run(service, ['2026-08-17', '2026-08-03', '2026-08-10']);
      expect(persist.getCalls().map(c => c.args[0].snapshot.date)).to.deep.equal([
        '2026-08-03',
        '2026-08-10',
        '2026-08-17'
      ]);
    });

    it('leaves a date that already has a snapshot completely alone', async () => {
      const { service, exists, balances, persist } = makeSvc();
      exists.withArgs(sinon.match({ date: '2026-08-03' })).resolves(true);
      const summary = await run(service, ['2026-08-03', '2026-08-10']);
      expect(balances.getCalls().map(c => c.args[0].date)).to.deep.equal(['2026-08-10']);
      expect(persist.callCount).to.equal(1);
      expect(summary).to.deep.equal({ written: 1, skipped: 1, erroredDates: 0 });
    });

    it('counts only the wallets that existed on the date being reconstructed', async () => {
      const { service, persist } = makeSvc({
        wallets: [walletCreatedAt('2025-01-01T00:00:00Z'), walletCreatedAt('2026-08-20T00:00:00Z')]
      });
      await run(service, ['2026-08-03']);
      // The second wallet was created after this date; counting it would make every
      // historical snapshot report today's wallet count.
      const { snapshot, walletFacts } = persist.firstCall.args[0];
      expect(snapshot.walletCntTotal).to.equal('1');
      expect(walletFacts).to.have.lengthOf(1);
    });

    it('looks back twelve months for activity on each date', async () => {
      const { service, activity } = makeSvc();
      await run(service, ['2026-08-03']);
      expect(activity.firstCall.args[0].windowStart).to.deep.equal(new Date('2025-08-03T00:00:00Z'));
    });

    it('writes through the insert-if-absent path', async () => {
      const { service, persist } = makeSvc();
      await run(service, ['2026-08-03']);
      expect(persist.calledOnce).to.equal(true);
      expect(persist.firstCall.args[0].chain).to.equal('BTC');
    });

    it('stamps when the snapshot was reconstructed', async () => {
      const { service, persist } = makeSvc();
      await run(service, ['2026-08-03']);
      expect(persist.firstCall.args[0].snapshot.meta.completedAt).to.deep.equal(NOW);
    });

    it('detects duplicates once for the whole run, since the verdict does not move', async () => {
      const { service, dups } = makeSvc();
      await run(service, ['2026-08-03', '2026-08-10', '2026-08-17']);
      expect(dups.callCount).to.equal(1);
    });

    it('carries on to the next date when one date fails', async () => {
      const { service, balances, persist } = makeSvc();
      balances.withArgs(sinon.match({ date: '2026-08-03' })).rejects(new Error('aggregation blew up'));
      const summary = await run(service, ['2026-08-03', '2026-08-10']);
      expect(persist.getCalls().map(c => c.args[0].snapshot.date)).to.deep.equal(['2026-08-10']);
      expect(summary).to.deep.equal({ written: 1, skipped: 0, erroredDates: 1 });
    });

    it('stops cleanly when a shutdown is requested mid-run', async () => {
      const { service, persist } = makeSvc();
      (service as any).collectUtxoBalancesAt.callsFake(async () => {
        service.stopping = true;
        return new Map();
      });
      await run(service, ['2026-08-03', '2026-08-10']);
      expect(persist.callCount).to.equal(1); // the in-flight date finishes, the next never starts
    });

    it('throttles between dates', async () => {
      const { service, waitFn } = makeSvc({ serviceConfig: { sleepMs: 250 } });
      await run(service, ['2026-08-03', '2026-08-10']);
      expect(waitFn.called).to.equal(true);
      expect(waitFn.firstCall.args[0]).to.equal(250);
    });

    it('does nothing at all when given no dates', async () => {
      const { service, persist, dups } = makeSvc();
      const summary = await run(service, []);
      expect(persist.called).to.equal(false);
      expect(dups.called).to.equal(false);
      expect(summary).to.deep.equal({ written: 0, skipped: 0, erroredDates: 0 });
    });
  });

});
