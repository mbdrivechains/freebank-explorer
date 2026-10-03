import config from '../../config';
import logger from '../../logger';
import bitcoinClient from '../bitcoin/bitcoin-client';
import {
  CREDIT_FAMILY_BY_VERSION, CreditFamily, creditOpName, decodeCreditPayload, DecodedPayload,
  FreebankParsedTx, isCreditVersion, parseFreebankTx,
} from './freebank-tx-parser';
import { FreebankActivityItem } from './freebank.interfaces';

// In-memory index of the credit transactions (versions 11-17) in recent blocks, behind
// /api/v1/freebank/activity. No database: at startup it backfills the last N blocks
// (FREEBANK.ACTIVITY_BACKFILL_BLOCKS, default 2016; the environment variable
// FREEBANK_ACTIVITY_BACKFILL_BLOCKS overrides it), newest first, and then appends every new
// block (index.ts kicks it from the new-block callback; an /activity request also kicks it).
//
// Per block: getblock <hash> 2 (versions, and the raw hex of each tx - getrawtransaction
// <txid> false only if a node leaves hex out), then the FreeBank parser for the op byte and
// payload, and the fee from the inputs' values (the block's own tx fee field when the node
// gives one, else getrawtransaction of each spent tx - which needs -txindex; without it the
// fee is null). Settlements are found this way too: listsettlements is a wallet RPC.
//
// Reorgs: each indexed block keeps its hash and parent hash. Every sync first walks down
// from the top of the index until a height whose hash the node still has, drops what is
// above it, and only then scans upward; backfill checks each block against its child's
// parent hash. A bad payload never fails a block: its item gets op null and decoded {}.

const DEFAULT_BACKFILL_BLOCKS = 2016;
const BACKFILL_CHUNK = 25; // blocks per backfill step; the top is re-synced between steps
const RETRY_MS = 30_000;
const PREVOUT_CACHE_MAX = 5000;

interface IndexedBlock {
  hash: string;
  prev: string;
  items: FreebankActivityItem[]; // in block order
}

function backfillBlocks(): number {
  const fromEnv = parseInt(process.env.FREEBANK_ACTIVITY_BACKFILL_BLOCKS ?? '', 10);
  const n = Number.isFinite(fromEnv) ? fromEnv : config.FREEBANK?.ACTIVITY_BACKFILL_BLOCKS;
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_BACKFILL_BLOCKS;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** @asyncSafe */
function sleep$(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const HOUSE_FIELDS = ['house_id', 'house_a_id', 'house_b_id', 'pool_id'] as const; // pool_id == house_id in v1

/** Whether a decoded credit payload names this house (its own ops, its notes, its pool, a settlement it is in). */
export function activityNamesHouse(item: FreebankActivityItem, houseId: number): boolean {
  return HOUSE_FIELDS.some((f) => item.decoded?.[f] === houseId);
}

/** Whether a decoded credit payload names this bill (every bill op but the issue, which the node numbers). */
export function activityNamesBill(item: FreebankActivityItem, billId: number): boolean {
  return item.family === 'bill' && item.decoded?.bill_id === billId;
}

class CreditActivityIndex {
  private blocks = new Map<number, IndexedBlock>();
  private high = -1; // top of the indexed range, inclusive; -1 = not started
  private low = 0; // bottom of the indexed range, inclusive
  private floor = 0; // the backfill stops here
  private working = false;
  private again = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private prevoutValues = new Map<string, number[]>();

  /** Start (or nudge) the indexer. Safe to call any number of times; never throws. */
  public kick(): void {
    if (this.working) {
      this.again = true;
      return;
    }
    void this.$work();
  }

  /** The indexed range [scannedFrom, top]; empty (scannedFrom > top) before the first block. */
  public getRange(): { top: number, scannedFrom: number } {
    return this.high < 0 ? { top: -1, scannedFrom: 0 } : { top: this.high, scannedFrom: this.low };
  }

  /** Indexed credit txs, newest first, optionally of one family and only those `match` keeps. */
  public getItems(family: CreditFamily | null, limit: number, match?: (item: FreebankActivityItem) => boolean): FreebankActivityItem[] {
    const out: FreebankActivityItem[] = [];
    if (this.high < 0) {
      return out;
    }
    for (let h = this.high; h >= this.low && out.length < limit; h--) {
      const block = this.blocks.get(h);
      if (!block) {
        continue;
      }
      for (let i = block.items.length - 1; i >= 0 && out.length < limit; i--) {
        if ((family === null || block.items[i].family === family) && (!match || match(block.items[i]))) {
          out.push(block.items[i]);
        }
      }
    }
    return out;
  }

  /** Whether the index holds the node's best block `tip` (same height AND same hash). */
  private holdsTip(tip: { height: number, hash: string }): boolean {
    return this.blocks.get(tip.height)?.hash === tip.hash;
  }

  /**
   * Kick the indexer and wait (up to timeoutMs) until it holds the node's best block `tip`.
   * The hash is compared, not just the height: a block replaced at the same height (a BMM
   * reorg the backend's new-block callback does not report) is then picked up by the next
   * request instead of serving the orphaned block's credit txs until the next block.
   * @asyncSafe
   */
  public async $waitForTip(tip: { height: number, hash: string }, timeoutMs: number): Promise<void> {
    if (this.holdsTip(tip)) {
      return;
    }
    this.kick();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep$(100);
      if (this.holdsTip(tip)) {
        return;
      }
    }
  }

  /** Never rejects: a failure is logged and retried in RETRY_MS. @asyncSafe */
  private async $work(): Promise<void> {
    this.working = true;
    try {
      do {
        this.again = false;
        await this.$syncTop();
        if (!this.again && this.high >= 0 && this.low > this.floor) {
          await this.$backfillChunk();
          if (this.high < 0) {
            continue; // the backfill started over (and set `again`)
          }
          if (this.low > this.floor) {
            this.again = true; // more to backfill; re-sync the top first
          } else {
            logger.debug(`FreeBank credit activity: indexed blocks ${this.low} to ${this.high}`);
          }
        }
      } while (this.again);
    } catch (e) {
      logger.warn(`FreeBank credit activity index: ${errMsg(e)}. Retrying in ${RETRY_MS / 1000} seconds.`);
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
    this.high = -1;
    this.low = 0;
    this.floor = 0;
  }

  /** @asyncUnsafe */
  private async $syncTop(): Promise<void> {
    const tip: number = await bitcoinClient.getBlockCount();

    if (this.high < 0) {
      // first run: index the tip block, backfill downward from there
      const block = await this.$scanBlock(tip);
      this.blocks.set(tip, block);
      this.high = tip;
      this.low = tip;
      this.floor = Math.max(0, tip - backfillBlocks() + 1);
      logger.debug(`FreeBank credit activity: indexing blocks ${this.floor} to ${tip}`);
      return;
    }

    // Walk down to the highest indexed block the node still has on its best chain.
    let h = Math.min(this.high, tip);
    while (h >= this.low) {
      const hash: string = await bitcoinClient.getBlockHash(h);
      if (hash === this.blocks.get(h)?.hash) {
        break;
      }
      h--;
    }
    if (h < this.low) {
      logger.info('FreeBank credit activity: every indexed block was reorganized away, starting over');
      this.reset();
      this.again = true;
      return;
    }
    if (h < this.high) {
      logger.info(`FreeBank credit activity: reorg, dropping indexed blocks ${h + 1} to ${this.high}`);
      for (let d = h + 1; d <= this.high; d++) {
        this.blocks.delete(d);
      }
      this.high = h;
    }

    while (this.high < tip) {
      const next = this.high + 1;
      const block = await this.$scanBlock(next);
      if (block.prev !== this.blocks.get(this.high)?.hash) {
        this.again = true; // the chain moved under us; the next pass walks back
        return;
      }
      this.blocks.set(next, block);
      this.high = next;
    }
  }

  /** @asyncUnsafe */
  private async $backfillChunk(): Promise<void> {
    const stop = Math.max(this.floor, this.low - BACKFILL_CHUNK);
    for (let h = this.low - 1; h >= stop; h--) {
      const block = await this.$scanBlock(h);
      if (block.hash !== this.blocks.get(h + 1)?.prev) {
        // The chain changed under the backfill (a reorg is under way at the node). Start over
        // rather than stitch: cheap at this size, and it cannot loop on a stale link.
        logger.info(`FreeBank credit activity: block ${h} no longer links to the index, starting over`);
        this.reset();
        this.again = true;
        return;
      }
      this.blocks.set(h, block);
      this.low = h;
    }
  }

  /** @asyncUnsafe */
  private async $scanBlock(height: number): Promise<IndexedBlock> {
    const hash: string = await bitcoinClient.getBlockHash(height);
    const block = await bitcoinClient.getBlock(hash, 2);
    const items: FreebankActivityItem[] = [];
    for (const tx of block.tx || []) {
      if (isCreditVersion(tx.version)) {
        items.push(await this.$buildItem(tx, height, block.time));
      }
    }
    return { hash, prev: block.previousblockhash || '', items };
  }

  /** Never rejects: a tx it cannot read gets op null and decoded {}. @asyncSafe */
  private async $buildItem(tx: any, height: number, time: number): Promise<FreebankActivityItem> {
    const family = CREDIT_FAMILY_BY_VERSION[tx.version];
    let op: number | null = null;
    let decoded: DecodedPayload = {};
    let fee: number | null = null;
    try {
      const hex: string = tx.hex || await bitcoinClient.getRawTransaction(tx.txid, false);
      const parsed = parseFreebankTx(hex);
      if (parsed.txid !== tx.txid) {
        logger.warn(`FreeBank credit activity: parsed txid ${parsed.txid} differs from the node's ${tx.txid}`);
      }
      op = parsed.op;
      decoded = decodeCreditPayload(parsed.family, parsed.op, parsed.payload);
      fee = await this.$fee(tx, parsed);
    } catch (e) {
      logger.debug(`FreeBank credit activity: cannot read credit tx ${tx.txid}: ${errMsg(e)}`);
    }
    return {
      txid: tx.txid,
      height,
      time,
      version: tx.version,
      family,
      op,
      op_name: op !== null ? creditOpName(family, op) : null,
      fee,
      decoded,
    };
  }

  /**
   * Fee in sats: inputs minus outputs, as the node's mempool counts it. null if unknown.
   * @asyncSafe
   */
  private async $fee(tx: any, parsed: FreebankParsedTx): Promise<number | null> {
    if (typeof tx.fee === 'number') {
      return Math.round(tx.fee * 100_000_000); // newer nodes (and the spike's RPC shim) give it
    }
    try {
      let totalIn = 0;
      for (const input of parsed.vin) {
        const values = await this.$outputValues(input.txid);
        const value = values[input.vout];
        if (value === undefined) {
          return null;
        }
        totalIn += value;
      }
      const totalOut = parsed.vout.reduce((sum, output) => sum + output.value, 0);
      return totalIn - totalOut;
    } catch {
      return null;
    }
  }

  /** @asyncUnsafe */
  private async $outputValues(txid: string): Promise<number[]> {
    const cached = this.prevoutValues.get(txid);
    if (cached) {
      return cached;
    }
    const hex: string = await bitcoinClient.getRawTransaction(txid, false);
    const values = parseFreebankTx(hex).vout.map((output) => output.value);
    if (this.prevoutValues.size >= PREVOUT_CACHE_MAX) {
      this.prevoutValues.clear();
    }
    this.prevoutValues.set(txid, values);
    return values;
  }
}

export default new CreditActivityIndex();
