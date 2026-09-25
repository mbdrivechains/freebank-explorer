import * as fs from 'fs';
import * as path from 'path';
import config from '../../config';
import logger from '../../logger';
import bitcoinClient from '../bitcoin/bitcoin-client';
import { parsePegOutputs } from './peg-parser';
import { derivePegState, extractBlockEvents, joinOutputs, PegTipInfo, pegTxView, PegState, StoredBlock } from './peg-state';
import {
  PegBlockView, PegBundle, PegDeposit, PegEcashTxView, PegList, PegListType, PegNodeWithdrawal, PegSummary,
  PegTxView, PegWithdrawal, PegWithdrawalView,
} from './peg.interfaces';

// FreeBank: the index behind /api/v1/freebank/peg*: every deposit from eCash, withdrawal to
// eCash, withdrawal bundle and refund on the chain. Unlike the credit activity index it covers
// the WHOLE chain, because a withdrawal can be paid long after it was made.
//
// Per block: getblockhash, then getblock <hash> 2, whose output scripts hold everything (the
// peg objects are OP_RETURN outputs; peg-parser.ts decodes them). Blocks without peg outputs
// keep only their hash and parent hash, and only while they are among the newest KEEP_RECENT
// blocks: enough to find where a reorg forks. A reorg deeper than that starts the scan over.
//
// Reorgs: every sync walks down from the top until a height whose hash the node still has,
// drops everything above it, then scans upward, each block checked against its parent hash (as
// credit-activity.ts does). Every change rebuilds the derived state (peg-state.ts) from the
// kept events, which is cheap: most blocks have none.
//
// Restarts: kept in <CACHE_DIR>/freebank/peg-index.json (a subdirectory, since the deploy clears the
// cache's top-level *.json), with the chain's genesis hash, so the scan resumes where it stopped
// and a cache from another chain is not used. index.ts kicks the index at startup and on every
// new block; the API also kicks it. The answers say how far the index is behind the node's tip
// (behind_by), so a page can say the totals are not complete yet.

const KEEP_RECENT = 2016;
const RETRY_MS = 30_000;
const SAVE_DELAY_MS = 10_000;
const SAVE_EVERY_BLOCKS = 500; // during a long scan
const NODE_WITHDRAWAL_CACHE_MAX = 500;

// The cache keeps each block's events as peg-parser.ts and coinbase-split.ts decoded them, so bump
// CACHE_VERSION whenever either of them or the stored events (peg-state.ts StoredEvents) change:
// the index then scans the chain again with the new code instead of keeping the old decodes.
// 2: 'D' records with an amount, bundles outside the coinbase, the bundle-hash kept in the coinbase.
const CACHE_VERSION = 2;
const CACHE_SUBDIR = 'freebank';
const CACHE_FILE = 'peg-index.json';

const DEFAULT_EXPLORER_URL = 'https://explorer.beta.ecash.ninja';

/** The node calls the index makes (bitcoinClient by default; tests pass their own). */
export interface PegNode {
  getBlockCount(): Promise<number>;
  getBlockHash(height: number): Promise<string>;
  getBlock(hash: string, verbosity: number): Promise<any>;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** @asyncSafe */
function sleep$(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The eCash explorer the peg pages link to: the BMM view's (FREEBANK.BMM_EXPLORER_URL). */
export function pegExplorerUrl(): string {
  return (config.FREEBANK?.BMM_EXPLORER_URL || DEFAULT_EXPLORER_URL).replace(/\/+$/, '');
}

export class PegIndex {
  private blocks = new Map<number, StoredBlock>();
  private top = -1; // highest indexed height; -1 = nothing yet
  private genesis: string | null = null;
  private state: PegState = derivePegState([]);
  private dirty = false; // the state needs rebuilding
  private loaded = false;
  private fromCache = false; // some kept blocks were read from the cache file

  private working = false;
  private again = false;
  private syncTip = -1; // the node's block count the running sync scans up to (-1: not asked yet)
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving = false;
  private scannedSinceSave = 0;

  private nodeWithdrawals = new Map<string, Promise<PegNodeWithdrawal | null>>();
  private nodeWithdrawalsTip = '';

  constructor(
    private readonly node: PegNode = bitcoinClient,
    private readonly cacheFile: string | null = path.join(config.MEMPOOL.CACHE_DIR, CACHE_SUBDIR, CACHE_FILE),
  ) { }

  /**
   * Start (or nudge) the indexer. Safe to call any number of times; never throws. `tipHeight`:
   * the node's tip height as the caller saw it (an API request). While a sync is about to ask
   * the node's block count, or is scanning up to that same height, the kick is dropped: it
   * would only restart the scan (3 node calls) for nothing. A kick without it (a new block)
   * always makes the sync re-check the tip.
   */
  public kick(tipHeight?: number): void {
    if (this.working) {
      if (tipHeight === undefined || (this.syncTip >= 0 && (tipHeight !== this.syncTip || this.top >= this.syncTip))) {
        this.again = true;
      }
      return;
    }
    void this.$work();
  }

  /** The indexed range: every height from 0 to `top` (-1 before the first block). */
  public getTop(): number {
    return this.top;
  }

  /** Whether the index holds the node's best block (same height AND hash). */
  public holdsTip(tip: { height: number, hash: string }): boolean {
    return this.blocks.get(tip.height)?.hash === tip.hash;
  }

  /** The index's top, and how many blocks the node's tip (`nodeHeight`) is past it. */
  public tipInfo(nodeHeight: number): PegTipInfo {
    return { tip_height: this.top, behind_by: Math.max(0, nodeHeight - this.top) };
  }

  /** Whether the index has read this block (eventless blocks below the kept window are assumed so). */
  private hasRead(height: number, hash: string): boolean {
    const kept = this.blocks.get(height);
    return this.top >= height && (!kept || kept.hash === hash);
  }

  /**
   * Kick the index and wait (up to timeoutMs) until it holds the node's best block, so a block
   * that just arrived, or replaced the tip at the same height, is in the answer.
   * @asyncSafe
   */
  public async $waitForTip(tip: { height: number, hash: string }, timeoutMs: number): Promise<void> {
    if (this.holdsTip(tip)) {
      return;
    }
    this.kick(tip.height);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep$(100);
      if (this.holdsTip(tip)) {
        return;
      }
    }
  }

  // ------------------------------------------------------------------------------ queries

  /** `nodeHeight`: the node's tip height, for behind_by. */
  public getSummary(nodeHeight: number): PegSummary {
    const s = this.current();
    const summary: PegSummary = {
      explorer_url: pegExplorerUrl(),
      ...this.tipInfo(nodeHeight),
      scanned_from_height: 0,
      treasury: s.treasury,
      deposits: s.deposits.length,
      deposits_amount: s.deposits.reduce((sum, d) => sum + d.amount, 0),
      withdrawals: s.withdrawals.size,
      withdrawals_waiting: 0,
      withdrawals_in_bundle: 0,
      withdrawals_paid: 0,
      withdrawals_marked_paid: 0,
      withdrawals_refunded: 0,
      bundles: s.bundles.size,
      current_bundle: null,
    };
    for (const w of s.withdrawals.values()) {
      if (w.status === 'waiting' || w.status === 'requeued') {
        summary.withdrawals_waiting++;
      } else if (w.status === 'in-bundle') {
        summary.withdrawals_in_bundle++;
      } else if (w.status === 'paid') {
        summary.withdrawals_paid++;
      } else if (w.status === 'marked-paid') {
        summary.withdrawals_marked_paid++;
      } else if (w.status === 'refunded') {
        summary.withdrawals_refunded++;
      }
    }
    const newest = [...s.bundles.values()].pop();
    summary.current_bundle = newest && newest.status === 'created' ? newest : null;
    return summary;
  }

  /** Newest first. `nodeHeight`: the node's tip height, for behind_by. */
  public getList(type: PegListType, limit: number, nodeHeight: number): PegList {
    const s = this.current();
    let all: (PegDeposit | PegWithdrawal | PegBundle)[];
    if (type === 'deposit') {
      all = s.deposits;
    } else if (type === 'withdrawal') {
      all = [...s.withdrawals.values()];
    } else {
      all = [...s.bundles.values()];
    }
    return {
      explorer_url: pegExplorerUrl(),
      ...this.tipInfo(nodeHeight),
      type,
      total: all.length,
      items: all.slice(Math.max(0, all.length - limit)).reverse(),
    };
  }

  /**
   * A block's peg events. `onActiveChain`: the node says the block is on its best chain (a block
   * that is not is never indexed). `indexed` is false while the index has not reached it.
   */
  public getBlock(hash: string, height: number, onActiveChain: boolean): PegBlockView {
    const events = this.current().blocks.get(hash);
    // eventless blocks below the newest KEEP_RECENT are not kept: scanned, with nothing to show
    const indexed = onActiveChain && this.hasRead(height, hash);
    return {
      explorer_url: pegExplorerUrl(),
      indexed,
      ...(indexed && events ? events : {
        freebank_height: height,
        freebank_block: hash,
        deposits: [],
        deposits_paid: 0,
        deposits_paid_amount: 0,
        deposits_unpaid: 0,
        refunds: [],
        refunds_amount: 0,
        bundles_created: [],
        bundles_paid: [],
        bundles_failed: [],
        ecash_payments: [],
        withdrawals: [],
      }),
    };
  }

  /** A tx's peg outputs, from the index; null when the index does not hold the tx. */
  public getTx(txid: string, nodeHeight: number): PegTxView | null {
    return pegTxView(this.current(), txid, pegExplorerUrl(), this.tipInfo(nodeHeight));
  }

  /**
   * A tx the index does not hold (unconfirmed, or in a block the index has not reached, or with
   * no peg events): its outputs decoded, joined with what the index knows. Null when it has no
   * peg outputs, except for a confirmed coinbase, which always gets an answer: once the index
   * has read its block, empty deposit_payouts and refund_payouts say it pays neither.
   * `block.active`: the block is on the node's best chain.
   */
  public describeTx(txid: string, vout: { scriptpubkey: string }[], coinbase: boolean, block: { height: number, hash: string, active?: boolean } | null, nodeHeight: number): PegTxView | null {
    const outputs = parsePegOutputs(vout, coinbase);
    if (!outputs.length && !(coinbase && block)) {
      return null;
    }
    return {
      explorer_url: pegExplorerUrl(),
      ...this.tipInfo(nodeHeight),
      txid,
      confirmed: block !== null,
      indexed: block !== null && block.active !== false && this.hasRead(block.height, block.hash),
      freebank_height: block ? block.height : null,
      freebank_block: block ? block.hash : null,
      coinbase,
      outputs: joinOutputs(this.current(), txid, outputs),
      deposit_payouts: [],
      refund_payouts: [],
    };
  }

  public getEcashTx(ecashTxid: string): PegEcashTxView | null {
    const found = this.current().ecashTxs.get(ecashTxid);
    const record = found?.deposit ?? found?.payment;
    if (!found || !record) {
      return null;
    }
    return {
      explorer_url: pegExplorerUrl(),
      ecash_txid: ecashTxid,
      kind: found.deposit ? 'deposit' : 'bundle-payment',
      freebank_height: record.freebank_height,
      freebank_block: record.freebank_block,
      coinbase_txid: record.coinbase_txid,
      record_vout: record.record_vout,
      deposit: found.deposit ?? null,
      payment: found.payment ?? null,
    };
  }

  public getWithdrawal(id: string): { withdrawal: PegWithdrawal | null, bundle: PegBundle | null } {
    const s = this.current();
    const withdrawal = s.withdrawals.get(id) ?? null;
    const bundle = withdrawal?.bundle_hash ? s.bundles.get(withdrawal.bundle_hash) ?? null : null;
    return { withdrawal, bundle };
  }

  /**
   * The node's getwithdrawal: the authoritative status and the eCash address in its eCash form
   * (carrier-form destinations are decoded by the node, not here). Cached until the tip changes;
   * null when the node does not know the id.
   * @asyncUnsafe
   */
  public $getNodeWithdrawal(id: string, tipHash: string): Promise<PegNodeWithdrawal | null> {
    if (tipHash !== this.nodeWithdrawalsTip || this.nodeWithdrawals.size >= NODE_WITHDRAWAL_CACHE_MAX) {
      this.nodeWithdrawals.clear();
      this.nodeWithdrawalsTip = tipHash;
    }
    let pending = this.nodeWithdrawals.get(id);
    if (!pending) {
      pending = (bitcoinClient as any).getWithdrawal(id).then(
        (result: PegNodeWithdrawal) => result ?? null,
        (e: any) => {
          if (/does not exist|invalid id/i.test(e?.message ?? '')) {
            return null;
          }
          this.nodeWithdrawals.delete(id);
          throw e;
        },
      ) as Promise<PegNodeWithdrawal | null>;
      this.nodeWithdrawals.set(id, pending);
    }
    return pending;
  }

  /**
   * The derived state, rebuilt when the kept events changed. Kept events that do not rebuild
   * (read from a cache file this code cannot use) start the scan over; the answers then say
   * how far behind the index is. A failure on events this process scanned itself is a fault in
   * the code: it throws (the API answers 500), rather than serve an old state as if current.
   */
  private current(): PegState {
    if (this.dirty) {
      const withEvents = [...this.blocks.values()].filter((b) => b.ev).sort((a, b) => a.height - b.height);
      try {
        this.state = derivePegState(withEvents);
      } catch (e) {
        if (!this.fromCache) {
          throw e;
        }
        logger.warn(`FreeBank peg index: the cached events do not rebuild (${errMsg(e)}), scanning from the start`);
        this.reset();
        this.state = derivePegState([]);
        this.kick();
        return this.state;
      }
      this.dirty = false;
    }
    return this.state;
  }

  // ------------------------------------------------------------------------------ sync

  /** Never rejects: a failure is logged and retried in RETRY_MS. @asyncSafe */
  private async $work(): Promise<void> {
    this.working = true;
    try {
      if (!this.loaded) {
        this.loaded = true;
        this.loadCache();
      }
      do {
        this.again = false;
        await this.$sync();
      } while (this.again);
    } catch (e) {
      logger.warn(`FreeBank peg index: ${errMsg(e)}. Retrying in ${RETRY_MS / 1000} seconds.`);
      if (!this.retryTimer) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.kick();
        }, RETRY_MS);
      }
    } finally {
      this.working = false;
    }
  }

  private reset(): void {
    this.blocks.clear();
    this.top = -1;
    this.genesis = null;
    this.dirty = true;
    this.fromCache = false;
  }

  /** @asyncUnsafe */
  private async $sync(): Promise<void> {
    this.syncTip = -1;
    const tip = await this.node.getBlockCount();
    this.syncTip = tip;

    if (this.top >= 0) {
      const genesis = await this.node.getBlockHash(0);
      if (genesis !== this.genesis) {
        logger.info('FreeBank peg index: the node is on another chain, starting over');
        this.reset();
      }
    }

    if (this.top >= 0) {
      // Walk down to the highest kept block the node still has on its best chain. Only the
      // newest KEEP_RECENT blocks are all kept, so the walk stops at the bottom of that window.
      const windowLow = Math.max(0, this.top - KEEP_RECENT + 1);
      let h = Math.min(this.top, tip);
      while (h >= windowLow) {
        const kept = this.blocks.get(h);
        if (kept && kept.hash === await this.node.getBlockHash(h)) {
          break;
        }
        h--;
      }
      if (h < windowLow) {
        logger.info('FreeBank peg index: a reorg deeper than the kept blocks, starting over');
        this.reset();
      } else if (h < this.top) {
        logger.info(`FreeBank peg index: reorg, dropping blocks ${h + 1} to ${this.top}`);
        for (let d = h + 1; d <= this.top; d++) {
          this.blocks.delete(d);
        }
        this.top = h;
        this.dirty = true;
        this.scheduleSave();
      }
    }

    while (this.top < tip) {
      const next = this.top + 1;
      const block = await this.$scanBlock(next);
      if (next > 0 && block.prev !== this.blocks.get(this.top)?.hash) {
        this.again = true; // the chain moved under us; the next pass walks back
        return;
      }
      if (next === 0) {
        this.genesis = block.hash;
      }
      this.blocks.set(next, block);
      this.top = next;
      if (block.ev) {
        this.dirty = true;
      }
      this.trim();
      if (++this.scannedSinceSave >= SAVE_EVERY_BLOCKS) {
        this.scheduleSave();
      }
      if (this.again) {
        return; // a new block arrived meanwhile: re-check the top first
      }
    }
    if (this.scannedSinceSave > 0) {
      this.scheduleSave();
    }
  }

  /** Forget eventless blocks below the window. */
  private trim(): void {
    const drop = this.top - KEEP_RECENT;
    const old = this.blocks.get(drop);
    if (drop > 0 && old && !old.ev) {
      this.blocks.delete(drop);
    }
  }

  /** @asyncUnsafe */
  private async $scanBlock(height: number): Promise<StoredBlock> {
    const hash: string = await this.node.getBlockHash(height);
    const block = await this.node.getBlock(hash, 2);
    const stored: StoredBlock = { height, hash, prev: block?.previousblockhash || '', time: block?.time ?? 0 };
    const ev = extractBlockEvents(block);
    if (ev) {
      stored.ev = ev;
    }
    return stored;
  }

  // ------------------------------------------------------------------------------ cache file

  private loadCache(): void {
    if (!this.cacheFile) {
      return;
    }
    let data: any;
    try {
      data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        logger.warn(`FreeBank peg index: cannot read ${this.cacheFile} (${errMsg(e)}), scanning from the start`);
      }
      return;
    }
    if (data?.version !== CACHE_VERSION || typeof data.top !== 'number' || typeof data.genesis !== 'string' || !Array.isArray(data.blocks)) {
      logger.info(`FreeBank peg index: ${this.cacheFile} is of another version, scanning from the start`);
      return;
    }
    const blocks = new Map<number, StoredBlock>();
    for (const b of data.blocks) {
      if (typeof b?.height === 'number' && typeof b.hash === 'string' && b.height <= data.top) {
        blocks.set(b.height, b);
      }
    }
    if (!blocks.has(data.top)) {
      return;
    }
    this.blocks = blocks;
    this.top = data.top;
    this.genesis = data.genesis;
    this.dirty = true;
    this.fromCache = true;
    logger.info(`FreeBank peg index: resuming at block ${this.top} from ${this.cacheFile}`);
  }

  private scheduleSave(): void {
    this.scannedSinceSave = 0;
    if (!this.cacheFile || this.saveTimer) {
      return;
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.$save();
    }, SAVE_DELAY_MS);
  }

  /** Write the kept blocks (a temp file of this process's, then rename). Never rejects. @asyncSafe */
  public async $save(): Promise<void> {
    if (!this.cacheFile || this.top < 0 || this.genesis === null) {
      return;
    }
    if (this.saving) {
      this.scheduleSave();
      return;
    }
    this.saving = true;
    const tmp = `${this.cacheFile}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(this.cacheFile), { recursive: true });
      const body = JSON.stringify({
        version: CACHE_VERSION,
        genesis: this.genesis,
        top: this.top,
        blocks: [...this.blocks.values()].sort((a, b) => a.height - b.height),
      });
      await fs.promises.writeFile(tmp, body);
      await fs.promises.rename(tmp, this.cacheFile);
    } catch (e) {
      logger.warn(`FreeBank peg index: cannot write ${this.cacheFile}: ${errMsg(e)}`);
    } finally {
      this.saving = false;
    }
  }
}

export default new PegIndex();
