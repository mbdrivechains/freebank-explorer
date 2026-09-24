import axios, { AxiosResponse } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import config from '../../config';
import logger from '../../logger';
import bitcoinClient from '../bitcoin/bitcoin-client';
import freebankApi from './freebank-api';
import { parseBmmBlock } from './bmm-parser';
import { BmmBlock, BmmList, BmmPool, BmmPoolShare, BmmStatus, BmmSummary } from './freebank.interfaces';

// FreeBank: the data behind the BMM view (/api/v1/freebank/bmm*): for each FreeBank block,
// the eCash block that carried it, that block's pool, and the bid paid for it.
//
// FreeBank side: the node's getblock <hash> 1. hashmainblock is the eCash block; merkleroot
// is h*, the value committed on eCash. eCash side: an eCash mempool explorer's API (BMM_API,
// the ninja explorer by default), up to three requests per FreeBank block:
//   GET /v1/block/<eCash hash>   height, timestamp, extras.pool; 404 = not on that chain
//   GET /block/<eCash hash>/raw  the coinbase's M7 for our slot, and the M8 (the bid). The
//                                explorer does not index OP_RETURN outputs, so the raw block
//                                is the only way to find the bid (bmm-parser.ts).
//   GET /tx/<M8 txid>            fee (= the bid, the M8's output is worth 0) and weight
//
// Requests go one at a time, BMM_MIN_INTERVAL_MS apart, with a 30 s timeout and
// MEMPOOL.USER_AGENT. A 429, a 5xx or no answer pauses all requests: 30 s, doubling up to
// 10 min. With BMM_ENABLED off nothing here runs and no request is ever made.
//
// Results are kept per FreeBank block hash, so a FreeBank reorg needs nothing special, in
// <CACHE_DIR>/bmm/bmm-v1.json (a subdirectory: the deploy clears the cache's top-level *.json).
// Final statuses are never looked up again; 'error' is retried, 30 s doubling up to 10 min.
//
// Order of work: blocks the API asked for and new blocks, then failed blocks that are due,
// then the backfill of the newest BMM_BACKFILL_BLOCKS blocks, newest first. The worker keeps a
// view of the active chain over that window (height -> hash, each linked to the one below by
// previousblockhash, walked back after a reorg as credit-activity.ts does); /bmm/summary
// counts the window.

const DEFAULT_API = 'https://explorer.beta.ecash.ninja/api';
const DEFAULT_EXPLORER_URL = 'https://explorer.beta.ecash.ninja';
const DEFAULT_SLOT = 130;
const DEFAULT_BACKFILL_BLOCKS = 2000;
const DEFAULT_MIN_INTERVAL_MS = 1000;

const CACHE_VERSION = 1;
const CACHE_SUBDIR = 'bmm';
const CACHE_FILE = 'bmm-v1.json';
const SAVE_DELAY_MS = 10_000;

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RAW_BLOCK_BYTES = 16 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const BACKOFF_MIN_MS = 30_000;
const BACKOFF_MAX_MS = 600_000;
const NODE_RETRY_MS = 30_000;
// The eCash explorer can be a little behind the eCash node that FreeBank follows, so a 404
// for a block younger than this is retried instead of taken as final.
const NOT_FOUND_GRACE_S = 3600;
const QUEUE_MAX = 2000;
const FB_BLOCK_MEMO_MAX = 5000;

const HASH_RE = /^[0-9a-f]{64}$/;
const ZERO_HASH = '0'.repeat(64);
const FINAL_STATUSES: readonly BmmStatus[] = ['ok', 'no-mainchain-block', 'no-commitment', 'no-bid'];
const UNKNOWN_POOL: BmmPool = { name: 'Unknown', slug: 'unknown' }; // mempool's name for it

interface BmmSettings {
  enabled: boolean;
  api: string;
  explorerUrl: string;
  slot: number;
  backfill: number;
  minIntervalMs: number;
}

/** A FreeBank block as the BMM view needs it (getblock <hash> 1). */
interface FbBlock {
  hash: string;
  height: number;
  merkleroot: string;
  time: number;
  hashmainblock: string;
  prev: string; // '' for genesis
}

interface Retry {
  attempts: number;
  at: number; // ms
  entry: BmmBlock; // status 'error'
}

/** A retry that is expected (the eCash explorer may not have the block yet): logged quietly. */
class NotYet extends Error {}

function intSetting(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
}

function readSettings(): BmmSettings {
  const c = config.FREEBANK;
  return {
    enabled: c?.BMM_ENABLED === true || String(c?.BMM_ENABLED) === 'true',
    api: (c?.BMM_API || DEFAULT_API).replace(/\/+$/, ''),
    explorerUrl: (c?.BMM_EXPLORER_URL || DEFAULT_EXPLORER_URL).replace(/\/+$/, ''),
    slot: intSetting(c?.BMM_SLOT, DEFAULT_SLOT, 0, 255),
    backfill: intSetting(c?.BMM_BACKFILL_BLOCKS, DEFAULT_BACKFILL_BLOCKS, 1, 10_000_000),
    minIntervalMs: intSetting(c?.BMM_MIN_INTERVAL_MS, DEFAULT_MIN_INTERVAL_MS, 0, 3_600_000),
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The node's answer for a hash it does not know (RPC_INVALID_ADDRESS_OR_KEY). */
export function isBlockNotFound(e: any): boolean {
  return e?.code === -5 || /^block not found$/i.test(e?.message ?? '');
}

/** @asyncSafe */
function sleep$(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pendingEntry(fb: FbBlock): BmmBlock {
  return {
    freebank_height: fb.height,
    freebank_hash: fb.hash,
    merkleroot: fb.merkleroot,
    time: fb.time,
    ecash_hash: fb.hashmainblock,
    ecash_height: null,
    ecash_time: null,
    pool: null,
    bid_sats: null,
    bid_txid: null,
    bid_vsize: null,
    bid_rate: null,
    other_sidechains: [],
    status: 'pending',
  };
}

function isFinalEntry(hash: string, entry: any): entry is BmmBlock {
  return typeof entry === 'object' && entry !== null && entry.freebank_hash === hash
    && typeof entry.freebank_height === 'number' && FINAL_STATUSES.includes(entry.status);
}

function expectOk(res: AxiosResponse, what: string): void {
  if (res.status !== 200) {
    throw new Error(`${what}: HTTP ${res.status}`);
  }
}

class BmmIndex {
  private readonly settings = readSettings();
  private started = false;
  private entries = new Map<string, BmmBlock>(); // final statuses, by FreeBank block hash
  private retries = new Map<string, Retry>(); // status 'error', by FreeBank block hash
  private queue: string[] = []; // FreeBank block hashes, next first
  private fbBlocks = new Map<string, FbBlock>();

  // The active chain over the window: heights low..top, -1 = empty.
  private chain = new Map<number, string>();
  private top = -1;
  private low = 0;

  private working = false;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt = 0;

  private lastRequestEnd = 0;
  private pauseMs = 0;
  private pauseUntil = 0;

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving = false;

  /** Load the cache and start the worker. Does nothing when BMM_ENABLED is off. */
  public start(): void {
    if (!this.settings.enabled) {
      logger.info('FreeBank BMM view: off (FREEBANK.BMM_ENABLED), no requests to the eCash explorer');
      return;
    }
    if (this.started) {
      return;
    }
    this.started = true;
    this.loadCache();
    logger.info(`FreeBank BMM view: slot ${this.settings.slot}, eCash API ${this.settings.api}, `
      + `${this.entries.size} block(s) cached, backfill ${this.settings.backfill}`);
    this.kick();
  }

  /**
   * New FreeBank block (index.ts's new-block callback): it goes to the front of the queue.
   * The worker would find it at the tip anyway, and also finds a block that replaced the tip
   * at the same height, which the callback does not report.
   */
  public onNewBlock(hash: string): void {
    if (HASH_RE.test(hash)) {
      this.prioritize([hash]);
    }
    this.kick();
  }

  /** Start (or nudge) the worker. Safe to call any number of times; never throws. */
  public kick(): void {
    if (!this.started) {
      return;
    }
    if (this.working) {
      this.again = true;
      return;
    }
    void this.$work();
  }

  /**
   * GET bmm: `limit` blocks of the active chain below height `before` (or from the tip),
   * newest first. Blocks not looked up yet are 'pending' and go to the front of the queue.
   * @asyncUnsafe
   */
  public async $getList(limit: number, before: number | null): Promise<BmmList> {
    const tip = await freebankApi.$getTip();
    const list: BmmList = {
      enabled: this.settings.enabled,
      explorer_url: this.settings.explorerUrl,
      tip_height: tip.height,
      items: [],
    };
    if (!this.settings.enabled) {
      return list;
    }
    const start = before === null ? tip.height : Math.min(tip.height, before - 1);
    const stop = Math.max(0, start - limit + 1);
    // the worker's view answers without node calls while it is at the node's tip; read it
    // before the first await, since the worker may move it
    const viewAtTip = this.top === tip.height && this.chain.get(tip.height) === tip.hash;
    const hashes: (string | undefined)[] = [];
    for (let h = start; h >= stop; h--) {
      hashes.push(viewAtTip ? this.chain.get(h) : undefined);
    }
    const asked: string[] = [];
    for (let i = 0; i < hashes.length; i++) {
      const hash: string = hashes[i] ?? await bitcoinClient.getBlockHash(start - i);
      const item = await this.$lookup(hash);
      if (item.status === 'pending') {
        asked.push(hash);
      }
      list.items.push(item);
    }
    this.prioritize(asked.reverse());
    return list;
  }

  /**
   * GET bmm/block/:hash: the block's entry ('pending' if not looked up yet, and it goes to the
   * front of the queue), or null if the node does not know the hash.
   * @asyncUnsafe
   */
  public async $getBlock(hash: string): Promise<BmmBlock | null> {
    let item: BmmBlock;
    try {
      item = await this.$lookup(hash);
    } catch (e) {
      if (isBlockNotFound(e)) {
        return null;
      }
      throw e;
    }
    if (item.status === 'pending') {
      this.prioritize([hash]);
    }
    return item;
  }

  /** GET bmm/summary: over the cached blocks of the window on the active chain. */
  public getSummary(): BmmSummary {
    const summary: BmmSummary = {
      enabled: this.settings.enabled,
      explorer_url: this.settings.explorerUrl,
      indexed: 0,
      pending: 0,
      carried: 0,
      total_bid_sats: 0,
      avg_bid_sats: null,
      median_bid_sats: null,
      last: null,
      pools: [],
      latest_ecash_height: null,
    };
    if (!this.started || this.top < 0) {
      return summary;
    }
    const bids: number[] = [];
    const pools = new Map<string, BmmPoolShare>();
    for (let h = this.top; h >= this.floor(); h--) {
      const hash = this.chain.get(h);
      const entry = hash !== undefined ? this.entries.get(hash) : undefined;
      if (!entry) {
        summary.pending++; // not looked up yet, being retried, or below the view so far
        continue;
      }
      summary.indexed++;
      if (entry.ecash_height !== null && (summary.latest_ecash_height === null || entry.ecash_height > summary.latest_ecash_height)) {
        summary.latest_ecash_height = entry.ecash_height;
      }
      if (entry.status !== 'ok' && entry.status !== 'no-bid') {
        continue;
      }
      summary.carried++;
      const pool = entry.pool ?? UNKNOWN_POOL;
      const share = pools.get(pool.slug) ?? { name: pool.name, slug: pool.slug, blocks: 0, share: 0 };
      share.blocks++;
      pools.set(pool.slug, share);
      if (entry.status === 'ok' && entry.bid_sats !== null) {
        bids.push(entry.bid_sats);
        summary.total_bid_sats += entry.bid_sats;
        summary.last = summary.last ?? entry;
      }
    }
    if (bids.length) {
      bids.sort((a, b) => a - b);
      const mid = Math.floor(bids.length / 2);
      summary.avg_bid_sats = Math.round(summary.total_bid_sats / bids.length);
      summary.median_bid_sats = bids.length % 2 ? bids[mid] : Math.round((bids[mid - 1] + bids[mid]) / 2);
    }
    for (const share of pools.values()) {
      share.share = Math.round(share.blocks / summary.carried * 10_000) / 10_000;
    }
    summary.pools = [...pools.values()].sort((a, b) => b.blocks - a.blocks || a.name.localeCompare(b.name));
    return summary;
  }

  /** Lowest height of the window. */
  private floor(): number {
    return Math.max(0, this.top - this.settings.backfill + 1);
  }

  /** The cached entry, or a pending one built from the node's getblock. @asyncUnsafe */
  private async $lookup(hash: string): Promise<BmmBlock> {
    const cached = this.entries.get(hash) ?? this.retries.get(hash)?.entry;
    if (cached) {
      return cached;
    }
    return pendingEntry(await this.$fbBlock(hash));
  }

  /** Put blocks at the front of the queue, the last one first. */
  private prioritize(hashes: string[]): void {
    if (!this.started) {
      return;
    }
    let added = false;
    for (const hash of hashes) {
      if (this.entries.has(hash) || this.retries.has(hash)) {
        continue;
      }
      const i = this.queue.indexOf(hash);
      if (i >= 0) {
        this.queue.splice(i, 1);
      }
      this.queue.unshift(hash);
      added = true;
    }
    if (this.queue.length > QUEUE_MAX) {
      this.queue.length = QUEUE_MAX;
    }
    if (added) {
      this.kick();
    }
  }

  /** Never rejects: a node failure is logged and retried in NODE_RETRY_MS. @asyncSafe */
  private async $work(): Promise<void> {
    this.working = true;
    try {
      do {
        this.again = false;
        await this.$syncChain();
        const hash = await this.$nextBlock();
        if (hash !== null) {
          await this.$resolve(hash);
          this.again = true;
        }
      } while (this.again);
      let next = Infinity;
      for (const retry of this.retries.values()) {
        next = Math.min(next, retry.at);
      }
      if (next !== Infinity) {
        this.wakeAt(next);
      }
    } catch (e) {
      logger.warn(`FreeBank BMM view: ${errMsg(e)}. Retrying in ${NODE_RETRY_MS / 1000} seconds.`);
      this.wakeAt(Date.now() + NODE_RETRY_MS);
    } finally {
      this.working = false;
    }
  }

  private wakeAt(at: number): void {
    if (this.timer) {
      if (this.timerAt <= at) {
        return;
      }
      clearTimeout(this.timer);
    }
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, Math.max(0, at - Date.now()));
  }

  /**
   * Bring the chain view up to the node's tip: walk down to the highest height the node
   * still agrees on, drop what is above it, then map upward, each block linked to the one
   * below. New blocks go to the front of the queue.
   * @asyncUnsafe
   */
  private async $syncChain(): Promise<void> {
    const tip = await freebankApi.$getTip();
    if (this.top === tip.height && this.chain.get(tip.height) === tip.hash) {
      return;
    }
    if (this.top >= 0 && tip.height - this.top > this.settings.backfill) {
      this.resetChain(); // far behind: start again from the tip
    }
    if (this.top >= 0) {
      let h = Math.min(this.top, tip.height);
      while (h >= this.low) {
        const hash: string = await bitcoinClient.getBlockHash(h);
        if (hash === this.chain.get(h)) {
          break;
        }
        h--;
      }
      if (h < this.low) {
        logger.info('FreeBank BMM view: every block of the chain view was reorganized away, starting over');
        this.resetChain();
      } else if (h < this.top) {
        logger.info(`FreeBank BMM view: reorg, dropping heights ${h + 1} to ${this.top} from the chain view`);
        for (let d = h + 1; d <= this.top; d++) {
          this.chain.delete(d);
        }
        this.top = h;
      }
    }

    const fresh: string[] = [];
    if (this.top < 0) {
      this.chain.set(tip.height, tip.hash);
      this.top = tip.height;
      this.low = tip.height;
      fresh.push(tip.hash);
    }
    while (this.top < tip.height) {
      const next = this.top + 1;
      const hash: string = await bitcoinClient.getBlockHash(next);
      if (await this.$prevOf(hash) !== this.chain.get(this.top)) {
        this.again = true; // the chain moved under us; the next pass walks back
        break;
      }
      this.chain.set(next, hash);
      this.top = next;
      fresh.push(hash);
    }
    const floor = this.floor();
    for (let h = this.low; h < floor; h++) {
      this.chain.delete(h);
    }
    this.low = Math.max(this.low, floor);
    this.prioritize(fresh);
  }

  private resetChain(): void {
    this.chain.clear();
    this.top = -1;
    this.low = 0;
  }

  /** The next FreeBank block to look up, or null if nothing is due now. @asyncUnsafe */
  private async $nextBlock(): Promise<string | null> {
    while (this.queue.length) {
      const hash = this.queue.shift() as string;
      if (!this.entries.has(hash) && !this.retries.has(hash)) {
        return hash;
      }
    }
    const now = Date.now();
    for (const [hash, retry] of this.retries) {
      if (retry.at <= now) {
        return hash;
      }
    }
    // backfill: extend the view down the window, one block at a time
    while (this.top >= 0 && this.low > this.floor()) {
      if (this.again) {
        return null; // something was queued; the next pass takes it first
      }
      const prev = await this.$prevOf(this.chain.get(this.low) as string);
      this.low--;
      this.chain.set(this.low, prev);
      if (!this.entries.has(prev) && !this.retries.has(prev)) {
        return prev;
      }
    }
    return null;
  }

  /** @asyncUnsafe */
  private async $fbBlock(hash: string): Promise<FbBlock> {
    const memo = this.fbBlocks.get(hash);
    if (memo) {
      return memo;
    }
    const block = await bitcoinClient.getBlock(hash, 1);
    const fb: FbBlock = {
      hash: block.hash,
      height: block.height,
      merkleroot: block.merkleroot,
      time: block.time,
      hashmainblock: typeof block.hashmainblock === 'string' ? block.hashmainblock : '',
      prev: block.previousblockhash || '',
    };
    if (this.fbBlocks.size >= FB_BLOCK_MEMO_MAX) {
      this.fbBlocks.clear();
    }
    this.fbBlocks.set(hash, fb);
    return fb;
  }

  /** @asyncUnsafe */
  private async $prevOf(hash: string): Promise<string> {
    const prev = this.fbBlocks.get(hash)?.prev ?? (await bitcoinClient.getBlockHeader(hash, true)).previousblockhash;
    if (typeof prev !== 'string' || !HASH_RE.test(prev)) {
      throw new Error(`no previous block for ${hash}`);
    }
    return prev;
  }

  /**
   * Look one FreeBank block up on eCash and record the result: final, or 'error' with a
   * retry time. Rejects only on a node error (the block goes back to the front of the queue).
   * @asyncUnsafe
   */
  private async $resolve(hash: string): Promise<void> {
    let fb: FbBlock;
    try {
      fb = await this.$fbBlock(hash);
    } catch (e) {
      if (isBlockNotFound(e)) {
        this.retries.delete(hash);
        return; // not a block of this node's (any more): nothing to look up
      }
      this.queue.unshift(hash);
      throw e;
    }
    const base = pendingEntry(fb);
    let entry: BmmBlock;
    try {
      entry = await this.$lookUpOnEcash(fb, base);
    } catch (e) {
      const attempts = (this.retries.get(hash)?.attempts ?? 0) + 1;
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(attempts - 1, 10));
      this.retries.set(hash, { attempts, at: Date.now() + delay, entry: { ...base, status: 'error' } });
      const message = `FreeBank BMM view: block ${fb.height} (${hash}): ${errMsg(e)}; retry ${attempts} in ${delay / 1000} s`;
      if (attempts === 1 && !(e instanceof NotYet)) {
        logger.warn(message);
      } else {
        logger.debug(message);
      }
      return;
    }
    this.retries.delete(hash);
    this.entries.set(hash, entry);
    this.scheduleSave();
  }

  /** @asyncUnsafe */
  private async $lookUpOnEcash(fb: FbBlock, base: BmmBlock): Promise<BmmBlock> {
    const ecashHash = fb.hashmainblock;
    if (ecashHash === ZERO_HASH) {
      return { ...base, status: 'no-mainchain-block' }; // genesis: carried by no eCash block
    }
    if (!HASH_RE.test(ecashHash)) {
      throw new Error('the node gave no hashmainblock');
    }

    const blockRes = await this.$request(`/v1/block/${ecashHash}`, 'json');
    if (blockRes.status === 404) {
      if (Date.now() / 1000 - fb.time < NOT_FOUND_GRACE_S) {
        throw new NotYet('eCash block not on the eCash explorer yet');
      }
      return { ...base, status: 'no-mainchain-block' };
    }
    expectOk(blockRes, 'v1/block');
    const info = blockRes.data;
    if (typeof info?.height !== 'number' || typeof info?.timestamp !== 'number') {
      throw new Error('v1/block: no height or timestamp');
    }
    const pool = info.extras?.pool;
    const found: BmmBlock = {
      ...base,
      ecash_height: info.height,
      ecash_time: info.timestamp,
      pool: typeof pool?.name === 'string' && typeof pool?.slug === 'string' ? { name: pool.name, slug: pool.slug } : null,
    };

    const rawRes = await this.$request(`/block/${ecashHash}/raw`, 'raw');
    expectOk(rawRes, 'block raw');
    const records = parseBmmBlock(Buffer.from(rawRes.data));
    if (records.hash !== ecashHash) {
      throw new Error(`block raw: got block ${records.hash}`);
    }
    const slot = this.settings.slot;
    found.other_sidechains = [...new Set(records.coinbaseM7.map((m) => m.slot).filter((s) => s !== slot))];
    if (!records.coinbaseM7.some((m) => m.slot === slot && m.hstar === fb.merkleroot)) {
      return { ...found, status: 'no-commitment' };
    }
    const bids = records.m8.filter((m) => m.slot === slot && m.hstar === fb.merkleroot);
    const bid = bids.find((m) => m.prev === records.prevBlock) ?? bids[0];
    if (!bid) {
      return { ...found, status: 'no-bid' };
    }

    const txRes = await this.$request(`/tx/${bid.txid}`, 'json');
    expectOk(txRes, 'tx');
    const fee = txRes.data?.fee;
    const weight = txRes.data?.weight;
    if (typeof fee !== 'number' || typeof weight !== 'number' || weight <= 0) {
      throw new Error('tx: no fee or weight');
    }
    const vsize = weight / 4;
    return {
      ...found,
      bid_sats: fee,
      bid_txid: bid.txid,
      bid_vsize: vsize,
      bid_rate: Math.round(fee / vsize * 100) / 100,
      status: 'ok',
    };
  }

  /**
   * One GET to BMM_API, after the minimum interval and any pause. Resolves with every HTTP
   * status except 429 and 5xx (which pause all requests and reject).
   * @asyncUnsafe
   */
  private async $request(pathname: string, kind: 'json' | 'raw'): Promise<AxiosResponse> {
    const wait = Math.max(this.lastRequestEnd + this.settings.minIntervalMs, this.pauseUntil) - Date.now();
    if (wait > 0) {
      await sleep$(wait);
    }
    let res: AxiosResponse;
    try {
      res = await axios.get(this.settings.api + pathname, {
        headers: { 'User-Agent': config.MEMPOOL.USER_AGENT },
        timeout: REQUEST_TIMEOUT_MS,
        responseType: kind === 'raw' ? 'arraybuffer' : 'json',
        maxContentLength: kind === 'raw' ? MAX_RAW_BLOCK_BYTES : MAX_JSON_BYTES,
        validateStatus: () => true,
      });
    } catch (e) {
      this.lastRequestEnd = Date.now();
      if (!/maxContentLength/.test(errMsg(e))) {
        this.pause(`${pathname}: ${errMsg(e)}`); // no answer: timeout, refused, reset...
      }
      throw e;
    }
    this.lastRequestEnd = Date.now();
    if (res.status === 429 || res.status >= 500) {
      this.pause(`${pathname}: HTTP ${res.status}`);
      throw new Error(`${pathname}: HTTP ${res.status}`);
    }
    this.pauseMs = 0;
    return res;
  }

  private pause(reason: string): void {
    this.pauseMs = this.pauseMs ? Math.min(BACKOFF_MAX_MS, this.pauseMs * 2) : BACKOFF_MIN_MS;
    this.pauseUntil = Date.now() + this.pauseMs;
    logger.warn(`FreeBank BMM view: eCash explorer ${reason}; pausing requests for ${this.pauseMs / 1000} s`);
  }

  private cacheFile(): string {
    return path.join(config.MEMPOOL.CACHE_DIR, CACHE_SUBDIR, CACHE_FILE);
  }

  private loadCache(): void {
    const file = this.cacheFile();
    let data: any;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        logger.warn(`FreeBank BMM view: cannot read ${file} (${errMsg(e)}), starting empty`);
      }
      return;
    }
    if (data?.version !== CACHE_VERSION || data.slot !== this.settings.slot || data.api !== this.settings.api) {
      logger.info(`FreeBank BMM view: ${file} is for another slot or eCash API, starting empty`);
      return;
    }
    for (const [hash, entry] of Object.entries(data.entries ?? {})) {
      if (isFinalEntry(hash, entry)) {
        this.entries.set(hash, entry);
      }
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) {
      return;
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.$save();
    }, SAVE_DELAY_MS);
  }

  /** Write the final entries (temp file, then rename). Never rejects. @asyncSafe */
  private async $save(): Promise<void> {
    if (this.saving) {
      this.scheduleSave();
      return;
    }
    this.saving = true;
    const file = this.cacheFile();
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const body = JSON.stringify({
        version: CACHE_VERSION,
        slot: this.settings.slot,
        api: this.settings.api,
        entries: Object.fromEntries(this.entries),
      });
      await fs.promises.writeFile(file + '.tmp', body);
      await fs.promises.rename(file + '.tmp', file);
    } catch (e) {
      logger.warn(`FreeBank BMM view: cannot write ${file}: ${errMsg(e)}`);
    } finally {
      this.saving = false;
    }
  }
}

export default new BmmIndex();
