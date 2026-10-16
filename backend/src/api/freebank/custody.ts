import bitcoinClient from '../bitcoin/bitcoin-client';
import freebankApi, { Tip } from './freebank-api';
import logger from '../../logger';
import { FreebankParsedTx, parseFreebankTx } from './freebank-tx-parser';
import { CoinTag, coinTags, CustodyDirectory, CustodyLabel, custodyLabel, custodyLabelled } from './custody-tags';
import { FreebankBill, FreebankHouse, FreebankOracleSubmitter, FreebankPool } from './freebank.interfaces';

// GET /api/v1/freebank/custody?txids=a,b,...: custody labels on the inputs and outputs of up to
// CUSTODY_MAX_TXIDS transactions (custody-tags.ts says what they mean).
//
// Per transaction: its raw hex (getrawtransaction <txid> false) gives the tags of its own
// outputs; each input's funding transaction (the explorer's node runs with -txindex) gives the
// tag of the coin it spends, which the node set when that coin was created and keeps until it
// is spent. At most CUSTODY_MAX_INPUTS inputs per transaction are looked up.
//
// A transaction's tags follow from its content, which its txid fixes, so parsed transactions
// are kept (LRU, TX_CACHE_MAX) across blocks. The numbers of houses, bills and oracle
// submitters come from the credit RPCs at the current tip (bills and houses are numbered in
// connect order, so a reorg can renumber a recent one): read again at each new tip, and only
// when a custody-shaped script turns up.

export const CUSTODY_MAX_TXIDS = 25;
export const CUSTODY_MAX_INPUTS = 50;
const TX_CACHE_MAX = 5000;
const RPC_CONCURRENCY = 8; // getrawtransaction calls in flight, over all requests
const COINBASE_TXID = '0'.repeat(64);

/** Labels of one transaction, by input and output index (null: not custody-shaped). */
export interface CustodyTxLabels {
  vin: (CustodyLabel | null)[];
  vout: (CustodyLabel | null)[];
  truncated?: boolean; // more than CUSTODY_MAX_INPUTS inputs: the ones past it are null
}

export interface CustodyResponse {
  tip_height: number;
  txs: { [txid: string]: CustodyTxLabels | null }; // null: the node does not know the txid (or it cannot be read)
}

/** What the resolver asks the node (an interface, so tests can stand in for it). */
export interface CustodyNode {
  getTip(): Promise<Tip>;
  getRawTransaction(txid: string): Promise<string | null>; // hex; null for a txid the node does not know
  listHouses(): Promise<FreebankHouse[]>;
  listBills(): Promise<FreebankBill[]>;
  listPools(): Promise<FreebankPool[]>;
  listOracleSubmitters(): Promise<FreebankOracleSubmitter[]>;
}

interface ParsedOutputs {
  inputs: ({ txid: string, vout: number } | null)[]; // null: a coinbase input
  outputs: { script: string, tag: CoinTag | null }[]; // script kept only when custody-shaped (or the mutual fund's)
}

/** The node's answer for a txid it does not know (RPC_INVALID_ADDRESS_OR_KEY). */
function isTxNotFound(e: unknown): boolean {
  const err = e as { code?: number, message?: string } | null | undefined;
  return err?.code === -5 || /No such mempool or blockchain transaction/i.test(err?.message ?? '');
}

const rpcNode: CustodyNode = {
  getTip: () => freebankApi.$getTip(),
  getRawTransaction: async (txid: string): Promise<string | null> => {
    try {
      return await bitcoinClient.getRawTransaction(txid, false);
    } catch (e) {
      if (isTxNotFound(e)) {
        return null;
      }
      throw e;
    }
  },
  listHouses: () => bitcoinClient.listHouses(),
  listBills: () => bitcoinClient.listBills(),
  listPools: () => bitcoinClient.listPools(),
  listOracleSubmitters: () => bitcoinClient.listOracleSubmitters(),
};

/** At most `max` calls at a time, across every request; the rest wait their turn. */
class Limiter {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(private max: number) { }

  /** @asyncUnsafe */
  public async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.max) {
      this.active++;
    } else {
      await new Promise<void>((resolve) => this.waiting.push(resolve)); // the slot is handed over
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        next();
      } else {
        this.active--;
      }
    }
  }
}

/** A directory read from the credit RPCs (see CustodyDirectory). */
export function buildDirectory(houses: FreebankHouse[], bills: FreebankBill[], pools: FreebankPool[],
  submitters: FreebankOracleSubmitter[]): CustodyDirectory {
  const houseByHash = new Map<string, number>();
  const hashByHouse = new Map<number, string>();
  const partners = new Map<string, number>();
  for (const house of houses || []) {
    if (typeof house?.househash === 'string') {
      houseByHash.set(house.househash.toLowerCase(), house.id);
      hashByHouse.set(house.id, house.househash.toLowerCase());
    }
    for (const partner of house?.partners || []) {
      if (typeof partner?.pubkey === 'string') {
        partners.set(`${house.id}:${partner.pubkey.toLowerCase()}`, partner.index);
      }
    }
  }
  const billByHash = new Map<string, number>();
  for (const bill of bills || []) {
    if (typeof bill?.bill_id === 'string') {
      billByHash.set(bill.bill_id.toLowerCase(), bill.id);
    }
  }
  const poolIds = new Set<number>((pools || []).map((pool) => pool?.pool_id));
  const submitterByKey = new Map<string, number>();
  for (const submitter of submitters || []) {
    if (typeof submitter?.pubkey === 'string') {
      submitterByKey.set(submitter.pubkey.toLowerCase(), submitter.id);
    }
  }
  return {
    houseIdByHash: (househash) => houseByHash.get(househash.toLowerCase()),
    houseHashById: (houseId) => hashByHouse.get(houseId),
    partnerIndex: (houseId, pubkey) => partners.get(`${houseId}:${pubkey.toLowerCase()}`),
    billIdByHash: (billHash) => billByHash.get(billHash.toLowerCase()),
    poolListed: (poolId) => poolIds.has(poolId),
    submitterIdByPubkey: (pubkey) => submitterByKey.get(pubkey.toLowerCase()),
  };
}

export class FreebankCustody {
  private txCache = new Map<string, ParsedOutputs>(); // LRU: oldest first
  private inflight = new Map<string, Promise<ParsedOutputs | null>>();
  private directoryMemo: { tipHash: string, promise: Promise<CustodyDirectory> } | null = null;
  private limiter = new Limiter(RPC_CONCURRENCY);

  constructor(private node: CustodyNode = rpcNode) { }

  /**
   * Labels for each txid (lower-case hex, already checked). Rejects on a node error.
   * @asyncUnsafe
   */
  public async $getCustody(txids: string[]): Promise<CustodyResponse> {
    const tip = await this.node.getTip();
    const unique = Array.from(new Set(txids));
    const txs = await Promise.all(unique.map((txid) => this.$parsed(txid)));

    // the coin each input spends: output n of its funding tx
    const spends: { txid: string, vout: number }[] = [];
    for (const tx of txs) {
      for (const input of (tx?.inputs || []).slice(0, CUSTODY_MAX_INPUTS)) {
        if (input) {
          spends.push(input);
        }
      }
    }
    const fundingIds = Array.from(new Set(spends.map((s) => s.txid)));
    const funding = new Map<string, ParsedOutputs | null>();
    const fetched = await Promise.all(fundingIds.map((txid) => this.$parsed(txid)));
    fundingIds.forEach((txid, i) => funding.set(txid, fetched[i]));
    const spentCoin = (input: { txid: string, vout: number } | null): { script: string, tag: CoinTag | null } | null =>
      (input && funding.get(input.txid)?.outputs[input.vout]) || null;

    const anyCustody = txs.some((tx) => tx && (
      tx.outputs.some((o) => o.script)
      || tx.inputs.slice(0, CUSTODY_MAX_INPUTS).some((input) => spentCoin(input)?.script)));
    const directory = anyCustody ? await this.$directory(tip) : null;
    const label = (coin: { script: string, tag: CoinTag | null } | null): CustodyLabel | null =>
      coin?.script && directory ? custodyLabel(coin.script, coin.tag, directory) : null;

    const response: CustodyResponse = { tip_height: tip.height, txs: {} };
    unique.forEach((txid, i) => {
      const tx = txs[i];
      if (!tx) {
        response.txs[txid] = null;
        return;
      }
      const entry: CustodyTxLabels = {
        vin: tx.inputs.map((input, j) => j < CUSTODY_MAX_INPUTS ? label(spentCoin(input)) : null),
        vout: tx.outputs.map((output) => label(output)),
      };
      if (tx.inputs.length > CUSTODY_MAX_INPUTS) {
        entry.truncated = true;
      }
      response.txs[txid] = entry;
    });
    return response;
  }

  /** A transaction's inputs and its outputs' tags, from the cache or the node; null if unknown. */
  private $parsed(txid: string): Promise<ParsedOutputs | null> {
    const hit = this.txCache.get(txid);
    if (hit) {
      this.txCache.delete(txid);
      this.txCache.set(txid, hit);
      return Promise.resolve(hit);
    }
    let pending = this.inflight.get(txid);
    if (!pending) {
      pending = this.$fetchParsed(txid).finally(() => this.inflight.delete(txid));
      this.inflight.set(txid, pending);
    }
    return pending;
  }

  /** @asyncUnsafe */
  private async $fetchParsed(txid: string): Promise<ParsedOutputs | null> {
    const hex = await this.limiter.run(() => this.node.getRawTransaction(txid));
    if (!hex) {
      return null; // not kept: an unknown txid may reach the mempool later
    }
    let tx: FreebankParsedTx;
    try {
      tx = parseFreebankTx(hex);
    } catch (e) {
      logger.debug(`FreeBank custody: cannot read tx ${txid}: ${e instanceof Error ? e.message : e}`);
      return null;
    }
    const tags = coinTags(tx);
    const parsed: ParsedOutputs = {
      inputs: tx.vin.map((input) => (input.txid === COINBASE_TXID && input.vout === 0xffffffff) ? null : { txid: input.txid, vout: input.vout }),
      outputs: tx.vout.map((output, n) => ({ script: custodyLabelled(output.scriptpubkey) ? output.scriptpubkey : '', tag: tags[n] })),
    };
    this.txCache.set(txid, parsed);
    if (this.txCache.size > TX_CACHE_MAX) {
      this.txCache.delete(this.txCache.keys().next().value as string);
    }
    return parsed;
  }

  /** The directory at this tip, read once per tip (a failed read is not kept). */
  private $directory(tip: Tip): Promise<CustodyDirectory> {
    if (this.directoryMemo?.tipHash === tip.hash) {
      return this.directoryMemo.promise;
    }
    const promise = Promise.all([
      this.node.listHouses(),
      this.node.listBills(),
      this.node.listPools(),
      this.node.listOracleSubmitters(),
    ]).then(([houses, bills, pools, submitters]) => buildDirectory(houses, bills, pools, submitters));
    const memo = { tipHash: tip.hash, promise };
    this.directoryMemo = memo;
    promise.catch(() => {
      if (this.directoryMemo === memo) {
        this.directoryMemo = null;
      }
    });
    return promise;
  }
}

export default new FreebankCustody();
