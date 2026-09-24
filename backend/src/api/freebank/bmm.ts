import axios, { AxiosResponse } from 'axios';
import cluster from 'cluster';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import config from '../../config';
import logger from '../../logger';
import bitcoinClient from '../bitcoin/bitcoin-client';
import freebankApi from './freebank-api';
import { parseBmmBlock } from './bmm-parser';
import { FreebankParseError } from './freebank-tx-parser';
import { BmmBlock, BmmList, BmmPool, BmmPoolShare, BmmStatus, BmmSummary } from './freebank.interfaces';

// FreeBank: our own agents for the eCash explorer. With axios's default ones Node tried only the first
// address DNS gave, the explorer's IPv6 one, and timed out on hosts without IPv6 routing (the dev box
// and freebanktest); autoSelectFamily tries IPv6 and IPv4 in turn. keepAlive saves a TLS handshake
// per request.
const AGENT_OPTIONS = { keepAlive: true, maxSockets: 1, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 500 };
const HTTP_AGENT = new http.Agent(AGENT_OPTIONS);
const HTTPS_AGENT = new https.Agent(AGENT_OPTIONS);

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
// Requests go one at a time, BMM_MIN_INTERVAL_MS apart, each cut off after 30 s, with
// MEMPOOL.USER_AGENT. Only a 200 with the expected answer and a 404 are answers. Anything
// else pauses all requests: no answer, a 429, a 5xx, a 403 or any other status, a page that is
// not the API's (a bot filter's HTML). The pause is 30 s, doubling up to 10 min, and starts at
// 30 s again once a lookup goes through. With BMM_ENABLED off nothing here runs and no request
// is ever made.
//
// A 404 from v1/block becomes 'no-mainchain-block' only once the FreeBank block is an hour old
// and the eCash explorer's own tip (asked at most once a minute) is an hour past it: an
// explorer that is restarting, reindexing or behind answers 404 too. Until then the block is
// retried ('not yet'); and if the explorer's tip is over 2 h old, the 404 pauses all requests.
//
// Results are kept per FreeBank block hash, so a FreeBank reorg needs nothing special, in
// <CACHE_DIR>/bmm/bmm-v1.json (a subdirectory: the deploy clears the cache's top-level *.json).
// Final statuses are never looked up again. A failed lookup ('error') is retried from where it
// stopped, so a retry does not download the raw block again: 30 s doubling up to 10 min, and
// only every 6 h once the block has failed MAX_ATTEMPTS times on its own (at once if its raw
// block cannot be read). A block is tried at least until its first hour is over. 'Not yet' and
// the explorer's failures (a pause) do not count as the block's own; after MAX_PAUSES pauses a
// block is also tried every 6 h only.
//
// Order of work: blocks the API asked for and new blocks, then failed blocks that are due,
// then the backfill of the newest BMM_BACKFILL_BLOCKS blocks, newest first. The worker keeps a
// view of the active chain over that window (height -> hash, each linked to the one below by
// previousblockhash, walked back after a reorg as credit-activity.ts does); /bmm/summary
// counts the window.
//
// With MEMPOOL.SPAWN_CLUSTER_PROCS, only the first cluster worker makes requests and writes
// the cache file; the others read that file every 30 s and answer from it.

const DEFAULT_API = 'https://explorer.beta.ecash.ninja/api';
const DEFAULT_EXPLORER_URL = 'https://explorer.beta.ecash.ninja';
const DEFAULT_SLOT = 130;
const DEFAULT_BACKFILL_BLOCKS = 2000;
const DEFAULT_MIN_INTERVAL_MS = 1000;

const CACHE_VERSION = 1;
const CACHE_SUBDIR = 'bmm';
const CACHE_FILE = 'bmm-v1.json';
const SAVE_DELAY_MS = 10_000;
const CACHE_RELOAD_MS = 30_000; // cluster workers that make no requests

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RAW_BLOCK_BYTES = 16 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const BACKOFF_MIN_MS = 30_000;
const BACKOFF_MAX_MS = 600_000;
const MAX_ATTEMPTS = 6; // failures of the block's own, then RETRY_LATER_MS
const MAX_PAUSES = 24; // failures that paused all requests, then RETRY_LATER_MS
const RETRY_LATER_MS = 6 * 3600_000;
const NODE_RETRY_MS = 30_000;
// The eCash explorer can be a little behind the eCash node that FreeBank follows, so a 404
// is final only for a block older than this, and once the explorer's tip is this much newer.
const NOT_FOUND_GRACE_S = 3600;
const EXPLORER_TIP_TTL_MS = 60_000;
// An explorer whose newest block is older than this is behind (reindexing, stuck): a 404 from
// it pauses all requests. At 10 min a block, a 2 h gap is rare (about 1 in 160,000 blocks).
const EXPLORER_STALE_S = 2 * 3600;
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

/** How far a failed lookup got, so its retry starts there. */
interface Progress {
  found?: BmmBlock; // from v1/block (and other_sidechains from the raw block)
  bidTxid?: string; // from the raw block: only /tx is left
}

interface Retry {
  failures: number; // all of them (the backoff)
  attempts: number; // the block's own: not 'not yet', not a pause
  pauses: number; // the ones that paused all requests (the explorer's)
  late: boolean; // retried every RETRY_LATER_MS now
  at: number; // ms
  entry: BmmBlock; // status 'error'
  progress: Progress;
}

/** The eCash explorer may not have the block yet: retried, logged quietly, not the block's fault. */
class NotYet extends Error {}

/** The eCash explorer failed as a whole and all requests are paused: not the block's fault. */
class Paused extends Error {}

/** The eCash block cannot be read (malformed, not the block asked for, too big). */
class Unreadable extends Error {}

/** A whole number from min to max (clamped); the default when unset or not a number. */
function intSetting(name: string, value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  if (!Number.isFinite(n)) {
    if (value !== undefined && value !== null && value !== '') {
      logger.warn(`FreeBank BMM view: FREEBANK.${name} is not a number (${String(value)}), using ${fallback}`);
    }
    return fallback;
  }
  const clamped = Math.min(max, Math.max(min, Math.floor(n)));
  if (clamped !== n) {
    logger.warn(`FreeBank BMM view: FREEBANK.${name} is ${n}, using ${clamped} (a whole number from ${min} to ${max})`);
  }
  return clamped;
}

function readSettings(): BmmSettings {
  const c = config.FREEBANK;
  return {
    enabled: c?.BMM_ENABLED === true || String(c?.BMM_ENABLED) === 'true',
    api: (c?.BMM_API || DEFAULT_API).replace(/\/+$/, ''),
    explorerUrl: (c?.BMM_EXPLORER_URL || DEFAULT_EXPLORER_URL).replace(/\/+$/, ''),
    slot: intSetting('BMM_SLOT', c?.BMM_SLOT, DEFAULT_SLOT, 0, 255),
    backfill: intSetting('BMM_BACKFILL_BLOCKS', c?.BMM_BACKFILL_BLOCKS, DEFAULT_BACKFILL_BLOCKS, 1, 10_000_000), // 0 or 1: the tip only
    minIntervalMs: intSetting('BMM_MIN_INTERVAL_MS', c?.BMM_MIN_INTERVAL_MS, DEFAULT_MIN_INTERVAL_MS, 0, 3_600_000),
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

function backoffMs(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(failures - 1, 10));
}

function hasHeightAndTime(body: any): boolean {
  return typeof body.height === 'number' && typeof body.timestamp === 'number';
}

function hasFeeAndWeight(body: any): boolean {
  return typeof body.fee === 'number' && typeof body.weight === 'number' && body.weight > 0;
}

class BmmIndex {
  private readonly settings = readSettings();
  private started = false;
  private lookups = true; // false in a cluster worker that only reads the cache file
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
  private explorerTip: { height: number, time: number, at: number } | null = null;

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving = false;
  private cacheMtimeMs = 0;

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
    // with SPAWN_CLUSTER_PROCS every worker gets here; the first (its workerId survives a
    // restart) makes the requests, the others answer from its cache file
    this.lookups = !cluster.isWorker || process.env.workerId === '0';
    this.loadCache();
    logger.info(`FreeBank BMM view: slot ${this.settings.slot}, eCash API ${this.settings.api}, `
      + `${this.entries.size} block(s) cached, backfill ${this.settings.backfill}`
      + (this.lookups ? '' : ', cluster worker: reading the cache file only'));
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
    if (!this.started || !this.lookups) {
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
      if (!this.lookups) {
        this.loadCache();
      }
      do {
        this.again = false;
        await this.$syncChain();
        const hash = await this.$nextBlock();
        if (hash !== null) {
          if (this.lookups) {
            await this.$resolve(hash);
          }
          this.again = true;
        }
      } while (this.again);
      let next = this.lookups ? Infinity : Date.now() + CACHE_RELOAD_MS;
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
    const due = (): string | null => {
      for (const [hash, retry] of this.retries) {
        if (retry.at <= now) {
          return hash;
        }
      }
      return null;
    };
    // Retries first, except while requests are paused after a failure: a retry is due exactly when
    // the pause ends, so retries alone would take every turn and the backfill would never move.
    // The first success resets pauseMs, and retries come first again.
    if (!this.pauseMs) {
      const retry = due();
      if (retry !== null) {
        return retry;
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
    return this.pauseMs ? due() : null;
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
    const retry = this.retries.get(hash);
    const progress: Progress = retry?.progress ?? {};
    let entry: BmmBlock;
    try {
      entry = await this.$lookUpOnEcash(fb, base, progress);
    } catch (e) {
      this.retryLater(fb, base, retry, progress, e);
      return;
    }
    this.retries.delete(hash);
    this.entries.set(hash, entry);
    this.pauseMs = 0; // the explorer answered: a next pause starts at 30 s again
    this.scheduleSave();
  }

  /** Record a failed lookup ('error') and when to try it again. */
  private retryLater(fb: FbBlock, base: BmmBlock, retry: Retry | undefined, progress: Progress, e: unknown): void {
    const paused = e instanceof Paused;
    const own = !paused && !(e instanceof NotYet);
    const failures = (retry?.failures ?? 0) + 1;
    const attempts = (retry?.attempts ?? 0) + (own ? 1 : 0);
    const pauses = (retry?.pauses ?? 0) + (paused ? 1 : 0);
    const now = Date.now();
    const graceLeftMs = (fb.time + NOT_FOUND_GRACE_S) * 1000 - now;
    let delay = backoffMs(failures);
    if (e instanceof Unreadable || e instanceof FreebankParseError) {
      delay = RETRY_LATER_MS; // the same bytes would fail the same way
    } else if (paused) {
      // not before the pause ends; backing off too, so that blocks the explorer keeps failing on
      // do not take every turn after a pause
      delay = pauses > MAX_PAUSES ? RETRY_LATER_MS : Math.max(this.pauseUntil - now, delay);
    } else if (graceLeftMs > 0) {
      delay = Math.min(delay, graceLeftMs + 1000); // young: tried again at least once its hour is over
    } else if (attempts > MAX_ATTEMPTS) {
      delay = RETRY_LATER_MS;
    }
    const late = delay >= RETRY_LATER_MS;
    this.retries.set(fb.hash, { failures, attempts, pauses, late, at: now + delay, entry: { ...base, status: 'error' }, progress });
    const message = `FreeBank BMM view: block ${fb.height} (${fb.hash}): ${errMsg(e)}; retry in ${Math.round(delay / 1000)} s`;
    if ((late && !retry?.late) || (own && attempts === 1)) {
      logger.warn(message);
    } else {
      logger.debug(message);
    }
  }

  /** @asyncUnsafe */
  private async $lookUpOnEcash(fb: FbBlock, base: BmmBlock, progress: Progress): Promise<BmmBlock> {
    const ecashHash = fb.hashmainblock;
    if (ecashHash === ZERO_HASH) {
      return { ...base, status: 'no-mainchain-block' }; // genesis: carried by no eCash block
    }
    if (!HASH_RE.test(ecashHash)) {
      throw new Error('the node gave no hashmainblock');
    }

    if (!progress.found) {
      const info = await this.$request(`/v1/block/${ecashHash}`, 'json', hasHeightAndTime);
      if (info === null) {
        await this.$checkNotFound(fb);
        return { ...base, status: 'no-mainchain-block' };
      }
      const pool = info.extras?.pool;
      progress.found = {
        ...base,
        ecash_height: info.height,
        ecash_time: info.timestamp,
        pool: typeof pool?.name === 'string' && typeof pool?.slug === 'string' ? { name: pool.name, slug: pool.slug } : null,
      };
    }
    const found = progress.found;

    if (progress.bidTxid === undefined) {
      const raw = await this.$request(`/block/${ecashHash}/raw`, 'raw');
      if (raw === null) {
        throw new Error('block raw: HTTP 404');
      }
      const records = parseBmmBlock(Buffer.from(raw)); // FreebankParseError: unreadable
      if (records.hash !== ecashHash) {
        throw new Unreadable(`block raw: got block ${records.hash}`);
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
      progress.bidTxid = bid.txid;
    }

    const tx = await this.$request(`/tx/${progress.bidTxid}`, 'json', hasFeeAndWeight);
    if (tx === null) {
      throw new Error('tx: HTTP 404');
    }
    const vsize = tx.weight / 4;
    return {
      ...found,
      bid_sats: tx.fee,
      bid_txid: progress.bidTxid,
      bid_vsize: vsize,
      bid_rate: Math.round(tx.fee / vsize * 100) / 100,
      status: 'ok',
    };
  }

  /**
   * After a 404 from v1/block: returns if the 404 is final, i.e. the block is past its grace
   * hour and the eCash explorer's tip is an hour past it. Otherwise throws NotYet, or pauses all
   * requests (Paused) if the explorer's tip is over EXPLORER_STALE_S old.
   * @asyncUnsafe
   */
  private async $checkNotFound(fb: FbBlock): Promise<void> {
    const now = Date.now() / 1000;
    const graceEnd = fb.time + NOT_FOUND_GRACE_S;
    if (now < graceEnd) {
      throw new NotYet('eCash block not on the eCash explorer yet');
    }
    const tip = await this.$explorerTip();
    const newest = `its newest block (${tip.height}) is from ${new Date(tip.time * 1000).toISOString()}`;
    if (tip.time < now - EXPLORER_STALE_S) {
      throw this.pause(`is behind: 404 for the eCash block of FreeBank block ${fb.height}, and ${newest}`);
    }
    if (tip.time < graceEnd) {
      throw new NotYet(`eCash block not found, but the eCash explorer's ${newest}, not an hour past this block yet`);
    }
  }

  /** The eCash explorer's newest block, asked at most once a minute. @asyncUnsafe */
  private async $explorerTip(): Promise<{ height: number, time: number }> {
    if (this.explorerTip && Date.now() - this.explorerTip.at < EXPLORER_TIP_TTL_MS) {
      return this.explorerTip;
    }
    const hash = await this.$request('/blocks/tip/hash', 'text', (body) => HASH_RE.test(body.trim()));
    if (hash === null) {
      throw new Error('blocks/tip/hash: HTTP 404');
    }
    const info = await this.$request(`/v1/block/${hash.trim()}`, 'json', hasHeightAndTime);
    if (info === null) {
      throw new Error('v1/block of the explorer\'s tip: HTTP 404');
    }
    this.explorerTip = { height: info.height, time: info.timestamp, at: Date.now() };
    return this.explorerTip;
  }

  /**
   * One GET to BMM_API, after the minimum interval and any pause, cut off after
   * REQUEST_TIMEOUT_MS. Resolves with the body of a 200 answer, or null for a 404. Anything else
   * pauses all requests and rejects with Paused: no answer, any other status, or a 200 that is
   * not the API's answer (HTML, or JSON that `valid` rejects). A body over the size cap rejects
   * with Unreadable, without a pause.
   * @asyncUnsafe
   */
  private async $request(pathname: string, kind: 'json' | 'text' | 'raw', valid: (body: any) => boolean = (): boolean => true): Promise<any> {
    const wait = Math.max(this.lastRequestEnd + this.settings.minIntervalMs, this.pauseUntil) - Date.now();
    if (wait > 0) {
      await sleep$(wait);
    }
    let res: AxiosResponse;
    try {
      res = await axios.get(this.settings.api + pathname, {
        headers: { 'User-Agent': config.MEMPOOL.USER_AGENT },
        httpAgent: HTTP_AGENT,
        httpsAgent: HTTPS_AGENT,
        timeout: REQUEST_TIMEOUT_MS, // only a socket that goes quiet
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), // the whole request
        responseType: kind === 'raw' ? 'arraybuffer' : kind,
        maxContentLength: kind === 'raw' ? MAX_RAW_BLOCK_BYTES : MAX_JSON_BYTES,
        validateStatus: () => true,
      });
    } catch (e) {
      this.lastRequestEnd = Date.now();
      if (/maxContentLength/.test(errMsg(e))) {
        throw new Unreadable(`${pathname}: ${errMsg(e)}`);
      }
      const code = (e as any)?.code;
      const why = code === 'ERR_CANCELED' ? `no full answer in ${REQUEST_TIMEOUT_MS / 1000} s` : (errMsg(e) || code || 'no answer');
      throw this.pause(`${pathname}: ${why}`); // no answer: timeout, refused, reset...
    }
    this.lastRequestEnd = Date.now();
    if (res.status === 404) {
      return null;
    }
    if (res.status !== 200) {
      throw this.pause(`${pathname}: HTTP ${res.status}`);
    }
    const body = res.data;
    const html = /text\/html/i.test(String(res.headers?.['content-type'] ?? ''));
    const expected = kind === 'json' ? typeof body === 'object' && body !== null && valid(body)
      : kind === 'text' ? typeof body === 'string' && valid(body)
        : !html && (Buffer.isBuffer(body) || body instanceof ArrayBuffer);
    if (!expected) {
      throw this.pause(`${pathname}: not the API's answer (${html ? 'an HTML page' : 'unexpected content'})`);
    }
    return body;
  }

  /** Pause all requests (30 s, doubling up to 10 min); returns the error to throw. */
  private pause(reason: string): Paused {
    this.pauseMs = this.pauseMs ? Math.min(BACKOFF_MAX_MS, this.pauseMs * 2) : BACKOFF_MIN_MS;
    this.pauseUntil = Date.now() + this.pauseMs;
    logger.warn(`FreeBank BMM view: eCash explorer ${reason}; pausing requests for ${this.pauseMs / 1000} s`);
    return new Paused(`eCash explorer ${reason}`);
  }

  private cacheFile(): string {
    return path.join(config.MEMPOOL.CACHE_DIR, CACHE_SUBDIR, CACHE_FILE);
  }

  /** Read the final entries from the cache file; again only when the file has changed. */
  private loadCache(): void {
    const file = this.cacheFile();
    let data: any;
    try {
      const mtimeMs = fs.statSync(file).mtimeMs;
      if (mtimeMs === this.cacheMtimeMs) {
        return;
      }
      this.cacheMtimeMs = mtimeMs;
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        logger.warn(`FreeBank BMM view: cannot read ${file} (${errMsg(e)})`);
      }
      return;
    }
    if (data?.version !== CACHE_VERSION || data.slot !== this.settings.slot || data.api !== this.settings.api) {
      logger.info(`FreeBank BMM view: ${file} is for another slot or eCash API, not using it`);
      return;
    }
    const entries = new Map<string, BmmBlock>();
    for (const [hash, entry] of Object.entries(data.entries ?? {})) {
      if (isFinalEntry(hash, entry)) {
        entries.set(hash, entry);
      }
    }
    this.entries = entries;
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

  /** Write the final entries (a temp file of this process's, then rename). Never rejects. @asyncSafe */
  private async $save(): Promise<void> {
    if (this.saving) {
      this.scheduleSave();
      return;
    }
    this.saving = true;
    const file = this.cacheFile();
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const body = JSON.stringify({
        version: CACHE_VERSION,
        slot: this.settings.slot,
        api: this.settings.api,
        entries: Object.fromEntries(this.entries),
      });
      await fs.promises.writeFile(tmp, body);
      await fs.promises.rename(tmp, file);
    } catch (e) {
      logger.warn(`FreeBank BMM view: cannot write ${file}: ${errMsg(e)}`);
    } finally {
      this.saving = false;
    }
  }
}

export default new BmmIndex();
