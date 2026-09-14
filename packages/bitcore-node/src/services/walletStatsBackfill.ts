import axios from 'axios';
import { ObjectID } from 'mongodb';
import logger from '../logger';
import { IWalletStats } from '../models/walletStats';
import { IWalletStatsWallet } from '../models/walletStatsWallet';
import { SpentHeightIndicators } from '../types/Coin';
import { isYyyyMmDd } from '../utils/date';
import { MoralisTransfer, WalletStats, WalletStatsService } from './walletStats';

export interface BackfillSummary {
  written: number;
  skipped: number;
  erroredDates: number;
}

export interface EvmBackfillSummary extends BackfillSummary {
  erroredWallets: number;
  /** Set when the run wrote nothing because every wallet history failed. */
  aborted?: true;
}

/** Rows per history page. */
export const HISTORY_PAGE_LIMIT = 100;
/** Hard stop on paging, so one busy address cannot stall a whole backfill. */
export const MAX_HISTORY_PAGES = 50;

/**
 * The wallet's most recent transfer at or before `asOf`, ignoring anything older
 * than `windowStart`. Both bounds are inclusive. Timestamps arrive oldest first,
 * so this walks back from the end.
 */
export function lastActivityAt(timestamps: Date[], asOf: Date, windowStart: Date): Date | undefined {
  for (let i = timestamps.length - 1; i >= 0; i--) {
    const stamp = timestamps[i];
    if (stamp > asOf) {
      continue;
    }
    return stamp >= windowStart ? stamp : undefined;
  }
  return undefined;
}

/**
 * Reconstructs historical wallet-stats snapshots. Kept apart from the collector
 * because the two answer different questions — the collector reports the present
 * on a schedule, this replays the past on demand — and only the backfiller is
 * driven by an operator with a CLI. Shared machinery (snapshot building, dup
 * detection, the block scan, the models) is borrowed from the collector rather
 * than duplicated, so both write identically shaped documents.
 */
export class WalletStatsBackfiller {
  stopping = false;

  constructor(private service: WalletStatsService = WalletStats) {}

  // The CLI stops the backfill without touching a running collector. One-shot: an
  // instance that has been stopped stays stopped, so a resumed run needs a new one.
  stop() {
    this.stopping = true;
  }

  private get config() {
    return this.service.serviceConfig;
  }

  // Weekly schedule days within [from, to], anchored the same way the collector
  // anchors its snapshots, so reconstructed dates land in the same series rather
  // than a parallel one offset by whatever day the range starts on. `from` rounds
  // FORWARD to the first schedule day on or after it. Both bounds must be real
  // dates: an unparseable `to` never compares greater than a date string, so the
  // walk would never terminate.
  backfillDates(from: string, to: string): string[] {
    const dates: string[] = [];
    if (!isYyyyMmDd(from) || !isYyyyMmDd(to) || from > to) {
      return dates;
    }
    const { targetDay } = this.service.getSchedule();
    const cursor = new Date(`${from}T00:00:00Z`);
    cursor.setUTCDate(cursor.getUTCDate() + ((targetDay - cursor.getUTCDay() + 7) % 7));
    for (;;) {
      const date = cursor.toISOString().split('T')[0];
      if (date > to) {
        return dates;
      }
      dates.push(date);
      cursor.setUTCDate(cursor.getUTCDate() + 7);
    }
  }

  // Point lookup on the unique {chain, network, date} index.
  async snapshotExists(params: { chain: string; network: string; date: string }): Promise<boolean> {
    const { chain, network, date } = params;
    const found = await this.service.walletStatsModel.collection.findOne({ chain, network, date });
    return !!found;
  }

  // Backfill's write path. Facts upsert exactly as the collector's do — their
  // unique key makes a re-run idempotent — but the snapshot is insert-if-absent:
  // a snapshot taken live is the authoritative one and reconstruction must never
  // overwrite it. buildSnapshot is shared and stamps every snapshot 'interval', so
  // the source is corrected here, at the one place every backfill write passes.
  async persistBackfill(params: {
    chain: string;
    network: string;
    snapshot: IWalletStats;
    walletFacts: IWalletStatsWallet[];
    partial?: string[];
  }) {
    const { chain, network, snapshot, walletFacts, partial } = params;
    await this.service.persistWalletFacts({ chain, network, walletFacts });
    const toInsert: IWalletStats = {
      ...snapshot,
      meta: { ...snapshot.meta, source: 'backfill', ...(partial?.length ? { partial } : {}) }
    };
    await this.service.walletStatsModel.collection.updateOne(
      { chain, network, date: snapshot.date },
      { $setOnInsert: toInsert },
      { upsert: true }
    );
  }

  // Per-wallet balances as they stood at a past date. Mirrors the cutoff semantics
  // of CoinModel.getBalanceAtTime: find the last block at or before the date, then
  // count coins minted by that height and not yet spent at it. A spentHeight below
  // the sentinel minimum means unspent or spent-in-mempool, which for a historical
  // view reads the same way — it was not spent by height H.
  //
  // One deliberate difference from getBalanceAtTime: mints must be CONFIRMED
  // (mintHeight >= 0). Sentinel mint heights are today's mempool, and attributing
  // coins pending now to a date months ago would inflate that date's balance.
  async collectUtxoBalancesAt(params: { chain: string; network: string; date: string }): Promise<Map<string, bigint>> {
    const { chain, network, date } = params;
    const balances = new Map<string, bigint>();

    const height = await this.heightAt({ chain, network, date });
    if (height === null) {
      return balances; // chain had no blocks yet; nothing to count
    }

    const rows = await this.service.coinModel.collection
      .aggregate<{ _id: any; balance: number }>(
        [
          {
            $match: {
              chain,
              network,
              'wallets.0': { $exists: true },
              mintHeight: { $gte: 0, $lte: height },
              $or: [{ spentHeight: { $gt: height } }, { spentHeight: { $lt: SpentHeightIndicators.minimum } }]
            }
          },
          { $unwind: '$wallets' },
          { $group: { _id: '$wallets', balance: { $sum: '$value' } } }
        ],
        // Same hint getBalanceAtTime uses; our $match carries the partial index's
        // predicate ('wallets.0' exists) so it stays valid.
        { allowDiskUse: true, hint: { wallets: 1, spentHeight: 1, value: 1, mintHeight: 1 } }
      )
      .toArray();
    for (const row of rows) {
      balances.set(row._id.toString(), BigInt(row.balance));
    }
    return balances;
  }

  // Last-activity dates as they stood at a past date: the newest mint or spend per
  // wallet inside [windowStart, date]. Unlike the live path this needs an upper
  // bound as well as a lower one, and the bound has to be applied per height rather
  // than per coin — a coin minted inside the window but spent long after it is
  // activity AT ITS MINT, and a plain $max of the two heights would report a spend
  // that had not happened yet on the date being reconstructed.
  async collectUtxoActivityAt(params: {
    chain: string;
    network: string;
    date: string;
    windowStart: Date;
  }): Promise<Map<string, Date>> {
    const { chain, network, date, windowStart } = params;
    const activity = new Map<string, Date>();

    const [startBlock] = await this.service.blockModel.collection
      .find({ chain, network, timeNormalized: { $gte: windowStart } })
      .project({ height: 1 })
      .sort({ timeNormalized: 1 })
      .limit(1)
      .toArray();
    if (!startBlock) {
      return activity; // no blocks in the window => nothing counts as recent
    }
    const fromHeight = startBlock.height;

    const toHeight = await this.heightAt({ chain, network, date });
    if (toHeight === null || toHeight < fromHeight) {
      return activity;
    }

    const inWindow = (field: string) => ({
      $cond: [{ $and: [{ $gte: [field, fromHeight] }, { $lte: [field, toHeight] }] }, field, -1]
    });
    const rows = await this.service.coinModel.collection
      .aggregate<{ _id: any; maxHeight: number }>(
        [
          {
            $match: {
              chain,
              network,
              'wallets.0': { $exists: true },
              $or: [
                { mintHeight: { $gte: fromHeight, $lte: toHeight } },
                { spentHeight: { $gte: fromHeight, $lte: toHeight } }
              ]
            }
          },
          { $project: { wallets: 1, activityHeight: { $max: [inWindow('$mintHeight'), inWindow('$spentHeight')] } } },
          { $match: { activityHeight: { $gte: fromHeight } } },
          { $unwind: '$wallets' },
          { $group: { _id: '$wallets', maxHeight: { $max: '$activityHeight' } } }
        ],
        { allowDiskUse: true }
      )
      .toArray();
    if (!rows.length) {
      return activity;
    }

    const heightToDate = await this.service.blockTimesByHeight({ chain, network, fromHeight, toHeight });
    for (const row of rows) {
      const when = heightToDate.get(row.maxHeight);
      if (when) {
        activity.set(row._id.toString(), when);
      }
    }
    return activity;
  }

  // Height of the last block at or before the start of `date`, or null when the
  // chain had no blocks yet. The cutoff getBalanceAtTime uses for "as of".
  private async heightAt(params: { chain: string; network: string; date: string }): Promise<number | null> {
    const { chain, network, date } = params;
    const [block] = await this.service.blockModel.collection
      .find({ chain, network, timeNormalized: { $lte: new Date(`${date}T00:00:00Z`) } })
      .project({ height: 1 })
      .sort({ timeNormalized: -1 })
      .limit(1)
      .toArray();
    return block ? block.height : null;
  }

  // Every transfer timestamp for one address in [from, to], oldest first. This is
  // the single pass the whole EVM backfill rests on: one bounded walk of history
  // per address, from which every date's activity is then derived locally. Paging
  // is capped and each page is spam-filtered.
  //
  // A missing api key throws rather than returning nothing. An empty result would
  // be indistinguishable from "this wallet was never active", and that would be
  // written into history as fact.
  async fetchAddressActivityDates(params: {
    chain: string;
    network: string;
    address: string;
    from: Date;
    to: Date;
  }): Promise<Date[]> {
    const { chain, network, address, from, to } = params;
    const apiKey = this.service.configService.get()?.externalProviders?.moralis?.apiKey;
    if (!apiKey) {
      throw new Error('Wallet Stats backfill needs externalProviders.moralis.apiKey to read EVM history');
    }
    const csp: any = this.service.cspProvider.get({ chain, network });
    const chainId = await csp.getChainId({ network });
    const { formatMoralisChainId } = await import('../providers/chain-state/external/adapters/moralis-utils');
    const moralisChain = formatMoralisChainId(chainId);

    const dates: Date[] = [];
    let cursor: string | undefined;
    let page = 0;
    do {
      const { data } = await this.service.withRateLimitRetry(
        () =>
          axios.get<{ result?: MoralisTransfer[]; cursor?: string }>(
            `https://deep-index.moralis.io/api/v2.2/${address}/erc20/transfers`,
            {
              params: {
                chain: moralisChain,
                from_date: from.toISOString(),
                to_date: to.toISOString(),
                order: 'ASC',
                limit: HISTORY_PAGE_LIMIT,
                exclude_spam: true,
                ...(cursor ? { cursor } : {})
              },
              headers: { 'X-API-Key': apiKey },
              timeout: 30000
            }
          ),
        () => this.stopping
      );
      for (const row of data?.result || []) {
        if (!row.possible_spam && row.block_timestamp) {
          dates.push(new Date(row.block_timestamp));
        }
      }
      cursor = data?.cursor;
      page++;
      if (cursor && page >= MAX_HISTORY_PAGES) {
        // Truncated history dates a wallet earlier than the truth, so say so.
        logger.warn(
          `Wallet Stats backfill: history for ${address} on ${chain}:${network} hit the ${MAX_HISTORY_PAGES} page cap; activity may be understated`
        );
        break;
      }
    } while (cursor);

    return dates.sort((a, b) => a.getTime() - b.getTime());
  }

  // Reconstruct an EVM chain's snapshots. Activity comes from ONE bounded history
  // read per address covering the whole range, from which each date's last-activity
  // is derived locally — per-date provider calls would multiply cost by the number
  // of weeks being rebuilt.
  //
  // Balances are the expensive half: a past balance needs archive-node reads per
  // wallet per date. They are off unless asked for, and a snapshot written without
  // them is marked partial rather than being allowed to read as a real zero.
  async backfillEvmChain(params: {
    chain: string;
    network: string;
    dates: string[];
    evmBalances?: boolean;
    getBalanceAt?: (params: { chain: string; network: string; address: string; date: string }) => Promise<string>;
  }): Promise<EvmBackfillSummary> {
    const { chain, network, evmBalances, getBalanceAt } = params;
    const summary = { written: 0, skipped: 0, erroredDates: 0, erroredWallets: 0 };
    const sorted = [...params.dates].sort();
    if (!sorted.length) {
      return summary;
    }
    if (evmBalances && !getBalanceAt) {
      throw new Error('Wallet Stats backfill: --evm-balances needs a balance reader');
    }

    const pending: string[] = [];
    for (const date of sorted) {
      if (await this.snapshotExists({ chain, network, date })) {
        summary.skipped++;
      } else {
        pending.push(date);
      }
    }
    if (!pending.length) {
      return summary; // nothing to rebuild, so nothing is worth asking a provider for
    }

    const allWallets = (await this.service.walletModel.collection.find({ chain, network }).toArray()) as Array<{
      _id: ObjectID;
    }>;
    const dups = await this.service.detectDups({ chain, network, wallets: allWallets });

    const from = new Date(`${pending[0]}T00:00:00Z`);
    from.setUTCFullYear(from.getUTCFullYear() - 1);
    const to = new Date(`${pending[pending.length - 1]}T00:00:00Z`);

    const sleepMs = this.config.sleepMs ?? 50;
    const every = this.config.every ?? 10;
    const stampsByWallet = new Map<string, Date[]>();
    const addressesByWallet = new Map<string, string[]>();
    let erroredWalletCnt = 0;
    let processed = 0;

    for (const wallet of allWallets) {
      if (this.stopping) {
        // A half-read history would understate activity, and that would be written
        // into the record as fact. Abandon the run instead.
        return summary;
      }
      const id = wallet._id.toHexString();
      try {
        const addresses = (
          await this.service.walletAddressModel.collection
            .find({ chain, network, wallet: wallet._id })
            .project({ address: 1 })
            .toArray()
        ).map(a => a.address);
        addressesByWallet.set(id, addresses);
        const stamps: Date[] = [];
        for (const address of addresses) {
          stamps.push(...(await this.fetchAddressActivityDates({ chain, network, address, from, to })));
        }
        stampsByWallet.set(id, stamps.sort((a, b) => a.getTime() - b.getTime()));
      } catch (err: any) {
        erroredWalletCnt++;
        logger.error(
          `Wallet Stats backfill: history failed for wallet ${id} on ${chain}:${network}: ${err.stack || err.message || err}`
        );
      }
      if (++processed % every === 0) {
        await this.service.waitFn(sleepMs);
      }
    }
    summary.erroredWallets = erroredWalletCnt;

    // Every wallet failing is a failure of the run, not of the wallets — a missing
    // or rejected api key looks exactly like this. Writing the dates anyway would
    // record "nobody was ever active", and because backfill only inserts where
    // nothing exists, a corrected re-run would skip those dates and leave the false
    // history in place for good.
    if (allWallets.length && erroredWalletCnt === allWallets.length) {
      logger.error(
        `Wallet Stats backfill aborted for ${chain}:${network}: all ${allWallets.length} wallet histories failed; nothing written`
      );
      return { ...summary, aborted: true };
    }

    for (const date of pending) {
      if (this.stopping) {
        break;
      }
      try {
        const asOf = new Date(`${date}T00:00:00Z`);
        const windowStart = new Date(asOf.getTime());
        windowStart.setUTCFullYear(windowStart.getUTCFullYear() - 1);
        const wallets = allWallets.filter(wallet => wallet._id.getTimestamp() < asOf);

        const activity = new Map<string, Date>();
        const balances = new Map<string, bigint>();
        for (const wallet of wallets) {
          const id = wallet._id.toHexString();
          const stamps = stampsByWallet.get(id);
          if (!stamps) {
            continue; // its history failed to read; it gets no activity date
          }
          const when = lastActivityAt(stamps, asOf, windowStart);
          if (when) {
            activity.set(id, when);
          }
          if (evmBalances) {
            let balance = 0n;
            for (const address of addressesByWallet.get(id) || []) {
              balance += BigInt(await getBalanceAt!({ chain, network, address, date }));
            }
            balances.set(id, balance);
            await this.service.waitFn(sleepMs);
          }
        }

        const { snapshot, walletFacts } = this.service.buildSnapshot({
          chain,
          network,
          date,
          wallets,
          balances,
          activity,
          dups
        });
        // buildSnapshot fills a balance of '0' for every wallet it was not given one
        // for, which here would claim an empty wallet rather than an unread one. Drop
        // the field wherever the balance was not actually read: all of them when
        // balances are off, and the ones whose history failed even when they are on.
        // Snapshots insert once and are never updated, so a zero written here is
        // permanent, and buckets would file a whale as dust.
        let unread = 0;
        for (const fact of walletFacts) {
          if (!evmBalances || !stampsByWallet.has(fact.wallet.toHexString())) {
            delete fact.balance;
            delete fact.nonce;
            unread++;
          }
        }
        snapshot.meta.erroredWalletCnt = erroredWalletCnt;
        snapshot.meta.completedAt = new Date(this.service.nowFn());
        await this.persistBackfill({
          chain,
          network,
          snapshot,
          walletFacts,
          // Any unread balance makes the snapshot's totals incomplete, whether that
          // is every wallet or just the ones that failed.
          ...(unread ? { partial: ['balances'] } : {})
        });
        summary.written++;
      } catch (err: any) {
        summary.erroredDates++;
        logger.error(`Wallet Stats backfill error for ${chain}:${network} ${date}: ${err.stack || err.message || err}`);
      }
      await this.service.waitFn(sleepMs);
    }
    return summary;
  }

  // Reconstruct a UTXO chain's snapshots for the given dates, oldest first. Dates
  // that already have a snapshot are left alone, and a date that fails is logged
  // and counted rather than abandoning the rest of the range.
  async backfillUtxoChain(params: {
    chain: string;
    network: string;
    dates: string[];
  }): Promise<BackfillSummary> {
    const { chain, network } = params;
    const dates = [...params.dates].sort();
    const summary = { written: 0, skipped: 0, erroredDates: 0 };
    if (!dates.length) {
      return summary;
    }

    const allWallets = (await this.service.walletModel.collection.find({ chain, network }).toArray()) as Array<{
      _id: ObjectID;
    }>;
    // Duplicate verdicts describe the wallets themselves, not any point in time, so
    // one pass covers every date in the range.
    const dups = await this.service.detectDups({ chain, network, wallets: allWallets });
    const sleepMs = this.config.sleepMs ?? 50;

    for (const date of dates) {
      if (this.stopping) {
        break;
      }
      try {
        if (await this.snapshotExists({ chain, network, date })) {
          summary.skipped++;
          continue;
        }
        const asOf = new Date(`${date}T00:00:00Z`);
        // buildSnapshot counts every wallet it is handed. Live that is right, because
        // every wallet exists as of now; reconstructing a past date it is not, so the
        // population is cut back to the wallets that existed then. Without this every
        // historical snapshot would report today's wallet count.
        const wallets = allWallets.filter(wallet => wallet._id.getTimestamp() < asOf);
        const windowStart = new Date(asOf.getTime());
        windowStart.setUTCFullYear(windowStart.getUTCFullYear() - 1);

        const balances = await this.collectUtxoBalancesAt({ chain, network, date });
        const activity = await this.collectUtxoActivityAt({ chain, network, date, windowStart });
        const { snapshot, walletFacts } = this.service.buildSnapshot({
          chain,
          network,
          date,
          wallets,
          balances,
          activity,
          dups
        });
        snapshot.meta.completedAt = new Date(this.service.nowFn());
        await this.persistBackfill({ chain, network, snapshot, walletFacts });
        summary.written++;
      } catch (err: any) {
        summary.erroredDates++;
        logger.error(`Wallet Stats backfill error for ${chain}:${network} ${date}: ${err.stack || err.message || err}`);
      }
      await this.service.waitFn(sleepMs);
    }
    return summary;
  }
}

export const WalletStatsBackfill = new WalletStatsBackfiller();
