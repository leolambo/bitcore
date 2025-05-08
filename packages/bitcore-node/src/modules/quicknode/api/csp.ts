import request = require('request');
import config from '../../../config';
import logger from '../../../logger';
import { BaseSVMStateProvider } from '../../../providers/chain-state/svm/api/csp';



export class QuickNodeStateProvider extends BaseSVMStateProvider {
  baseUrl = 'https://api.quicknode.com/';
  baseStreamUrl = 'https://api.quicknode.com/streams/rest/v1/'; // will have to create own endpoint for stream
  baseKeyValueUrl = 'https://api.quicknode.com/kv/rest/v1/'
  apiKey = config.externalProviders?.quicknode?.apiKey;
  baseWebhookurl = config.externalProviders?.quicknode?.webhookBaseUrl;
  headers = {
    'Content-Type': 'application/json',
    'accept': 'application/json',
    'x-api-key': this.apiKey,
  };
  example_createStream = JSON.stringify({
    name: 'My Stream',
    network: 'ethereum-mainnet',
    dataset: 'block',
    filter_function: 'ZnVuY3Rpb24gbWFpbihkYXRhKSB7CiAgICB2YXIgbnVtYmVyRGVjaW1hbCA9IHBhcnNlSW50KGRhdGEuc3RyZWFtRGF0YS5udW1iZXIsIDE2KTsKICAgIHZhciBmaWx0ZXJlZERhdGEgPSB7CiAgICAgICAgaGFzaDogZGF0YS5zdHJlYW1EYXRhLmhhc2gsCiAgICAgICAgbnVtYmVyOiBudW1iZXJEZWNpbWFsCiAgICB9OwogICAgcmV0dXJuIGZpbHRlcmVkRGF0YTsKfQ==',
    region: 'usa_east',
    start_range: 100,
    end_range: 200, // omit for coninously
    dataset_batch_size: 1,
    include_stream_metadata: 'body',
    destination: 'webhook',
    fix_block_reorgs: 0,
    keep_distance_from_tip: 0,
    destination_attributes: {
      url: 'https://webhook.site',
      compression: 'none',
      headers: {
        'Content-Type': 'Test',
        Authorization: 'again'
      },
      max_retry: 3,
      retry_interval_sec: 1,
      post_timeout_sec: 10
    },
    status: 'active'
  })

  /**
   * Request wrapper for quicknode Streams (subscriptions)
   * @param method 
   * @param url 
   * @param body 
   * @returns 
   */
  _subsRequest(method: string, url: string, body?: any) {
    this._addAddressToSubscription(body);
    this._getTransactionFilter(body);
    return new Promise((resolve, reject) => {
      request({
        method,
        url,
        headers: this.headers,
        json: true,
        body
      }, (err, data) => {
        if (err) {
          logger.error(`Error with Moralis subscription call ${method}:${url}: ${err.stack || err.message || err}`);
          return reject(err);
        }
        if (typeof data === 'string') {
          logger.warn(`Moralis subscription ${method}:${url} returned a string: ${data}`);
          return reject(new Error(data));
        }
        return resolve(data.body);
      });
    });
  }

  /*
  async createAddressSubscription(params: ChainNetwork & ChainId) {}
  async getAddressSubscriptions(params: ChainNetwork & ChainId) {}
  deleteAddressSubscription(params: { sub: IAddressSubscription }) {}
  async updateAddressSubscription(params: { sub: IAddressSubscription, addressesToAdd?: string[], addressesToRemove?: string[], status?: string }) {}
  webhookToCoinEvents(params: { webhook: any } & ChainNetwork) {}
  private _transformWebhookTransaction(params: { webhook, tx } & ChainNetwork): CoinEvent[] {}
  */

  // Quicknode Stream wrapper
  // TODO
  getStreams() {
    const url = this.baseStreamUrl + '/streams';
    return url;
  }

  getStreamsById(id) {
    const url = this.baseStreamUrl + `/streams/${id}`;
    return url;
  }

  activateStreams({ id }) {
    const url = this.baseStreamUrl + `/streams/${id}/activate`;
    return url;
  }

  pauseStreams({ id }) {
    const url = this.baseStreamUrl + `/streams/${id}/pause`;
    return url;
  }

  // private _getStreamName({ network }) {
  //   return `solana-${network}-blockStream`
  // }

  // function used on quicknode stream filter_function. must be converted JS/ECMAScript compliant filter encoded in base64.
  private _getTransactionFilter({ network }) {
    // If stream is configured with metadata in the body, the data may be nested under "data" key
    
    // use quick node function to get
    const key = this._getAddressSubscriptionListKey({ network });
    const filterFn = (stream) => {
      const data = stream.data ? stream.data : stream;
      const allowedAddresses =  qnGetList(key);
      // add this to the transaction afterto prevent duplicate data
      /*
      const blockTimeISO = data[0]?.blockTime ? new Date(data[0].blockTime * 1000).toISOString() : null;
      const blockhash = data[0]?.blockhash;
      const blockHeight = data[0]?.blockheight;
      */
      const isVoteTx = (tx) => { 
        return tx.transaction.message.instructions.some(ix => 
            ix.program === 'vote' || 
            ix.parsed?.type === 'compactupdatevotestate' ||
            tx.transaction.message.accountKeys.some(key => 
                key.pubkey === 'Vote111111111111111111111111111111111111111'
            )
        );
      }
      data[0].transactions = data[0].transactions.filter(tx => {
        const txAddresses = tx.transaction.message.accountKeys.map(key => key.pubkey);
        return !isVoteTx(tx) && txAddresses.some(address => allowedAddresses.includes(address));
      });



      data[0].allowedAddresses = allowedAddresses;

      return data;
    }
    return filterFn;
  }

  // Key Value request

  private _getAddressSubscriptionListKey({ network }) {
    return `${this.chain.toLowerCase()}-${network}-addressStream`
  }
  // adds address to quicknode key value pairs
  async _addAddressToSubscription({ network, address }) {
    const key = this._getAddressSubscriptionListKey({ network });
    const url = `${this.baseKeyValueUrl}lists/${key}`;
    const body = { addItems: [address] };
    const res = await this._kvRequest('PATCH', url, body);
    return res;
  }

  async _removeAddressToSubscription({ network, address }) {
    const key = this._getAddressSubscriptionListKey({ network });
    const url = `${this.baseKeyValueUrl}lists/${key}`;
    const body = { removeItems: [address] };
    const res = await this._kvRequest('PATCH', url, body);
    return res;
  }

  _kvRequest(method: string, url: string, body?: any) {
    return new Promise((resolve, reject) => {
      request({
        method,
        url,
        headers: this.headers,
        json: true,
        body
      }, (err, data) => {
        if (err) {
          logger.error(`Error with QuickNode Key Value call ${method}:${url}: ${err.stack || err.message || err}`);
          return reject(err);
        }
        if (typeof data === 'string') {
          logger.warn(`Quick Node subscription ${method}:${url} returned a string: ${data}`);
          return reject(new Error(data));
        }
        return resolve(data.body);
      });
    });
  }
  
}

const qnGetList = (key => key)