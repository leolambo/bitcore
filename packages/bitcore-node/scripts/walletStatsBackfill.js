#!/usr/bin/env node

import { Utils } from '@bitpay-labs/crypto-wallet-core';
import { Config } from '../build/src/services/config.js';
import { Storage } from '../build/src/services/storage.js';
import { WalletStatsBackfill } from '../build/src/services/walletStatsBackfill.js';

function usage(errMsg) {
  console.log('USAGE: ./walletStatsBackfill.js [options]');
  console.log('[OPTIONS]:');
  console.log('  --chain <value>      chain to backfill (default: every configured chain)');
  console.log('  --network <value>    network to backfill (default: every configured network)');
  console.log('  --from <date>        YYYY-MM-DD, rounds forward to the first schedule day');
  console.log('  --to <date>          YYYY-MM-DD');
  console.log('  --dates <list>       explicit comma separated YYYY-MM-DD dates');
  console.log('  --gaps               fill the schedule days missing from the existing series');
  console.log('  --evm-balances       also read historical EVM balances (needs an archive node)');
  console.log('  --sleep <ms>         pause length between batches (default: config, else 50)');
  console.log('  --every <n>          pause every N wallets (default: config, else 10)');
  console.log('  --dry                print the planned dates and exit without writing');
  console.log('');
  console.log('With no range options, backfills the twelve months before the earliest snapshot.');
  if (errMsg) {
    console.error(errMsg);
    process.exit(1);
  }
  process.exit();
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  usage();
}

const valueOf = flag => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const chain = valueOf('--chain');
const network = valueOf('--network');
const from = valueOf('--from');
const to = valueOf('--to');
const dates = valueOf('--dates') ? valueOf('--dates').split(',').map(d => d.trim()).filter(Boolean) : undefined;
const gaps = args.includes('--gaps');
const evmBalances = args.includes('--evm-balances');
const dry = args.includes('--dry');

if (evmBalances && dry) {
  console.log('Note: --dry plans dates only; no balances will be read.');
}

// First interrupt asks the backfill to wind up the date it is on, second one gives up
// waiting. Matches the other long-running scripts here.
let quit = false;
process.on('SIGINT', () => {
  if (quit) {
    process.exit(1);
  }
  console.log('\nCaught interrupt signal; finishing the current step. Interrupt again to force quit.');
  quit = true;
  WalletStatsBackfill.stop();
});

function targets() {
  const configured = Config.chainNetworks();
  return configured.filter(cn => (!chain || cn.chain === chain) && (!network || cn.network === network));
}

function report(chainNetwork, summary) {
  const { chain: c, network: n } = chainNetwork;
  if (summary.aborted) {
    console.error(
      `${c}:${n} ABORTED — every wallet history failed, so nothing was written. ` +
        'Check externalProviders.moralis.apiKey, then re-run: no dates were consumed.'
    );
    return;
  }
  const parts = [`written ${summary.written}`, `skipped ${summary.skipped}`, `failed dates ${summary.erroredDates}`];
  if (summary.erroredWallets !== undefined) {
    parts.push(`failed wallets ${summary.erroredWallets}`);
  }
  console.log(`${c}:${n} ${parts.join(', ')}`);
}

console.log('Connecting to database...');

Storage.start()
  .then(async () => {
    const chainNetworks = targets();
    if (!chainNetworks.length) {
      usage('No configured chain/network matched those options');
    }
    for (const chainNetwork of chainNetworks) {
      if (quit) {
        break;
      }
      const { chain: c, network: n } = chainNetwork;
      const isUtxo = Utils.isUtxoChain(c);
      const isEvm = Utils.isEvmChain(c);
      if (!isUtxo && !isEvm) {
        console.log(`Skipping ${c}:${n} (not a UTXO or EVM chain)`);
        continue;
      }

      const planned = await WalletStatsBackfill.planDates({ chain: c, network: n, from, to, dates, gaps });
      if (!planned.length) {
        console.log(`${c}:${n} nothing to backfill`);
        continue;
      }
      if (dry) {
        console.log(`${c}:${n} would backfill ${planned.length} dates: ${planned.join(', ')}`);
        continue;
      }

      console.log(`${c}:${n} backfilling ${planned.length} dates (${planned[0]} to ${planned[planned.length - 1]})...`);
      const summary = isUtxo
        ? await WalletStatsBackfill.backfillUtxoChain({ chain: c, network: n, dates: planned })
        : await WalletStatsBackfill.backfillEvmChain({ chain: c, network: n, dates: planned, evmBalances });
      report(chainNetwork, summary);
    }
    if (quit) {
      console.log('Stopped early; dates not reached were left alone. Re-running skips what is already written.');
    }
  })
  .catch(err => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => {
    Storage.stop();
  });
