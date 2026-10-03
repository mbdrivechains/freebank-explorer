import * as fs from 'fs';
import * as path from 'path';
import config from '../../config';
import logger from '../../logger';
import bitcoinClient from '../bitcoin/bitcoin-client';

// FreeBank: partial txid search (GET /api/v1/freebank/txid-prefix/:prefix). The node cannot look a txid up by its
// start, so the backend keeps the first 8 bytes of every confirmed txid (two 32-bit words) and its block height, in
// typed arrays: 12 bytes a tx (beta's 1.08 million txs: 13 MB). A query scans them (a few ms), then reads the blocks of
// the candidates (getblock <hash> 1) for the full txids, which also settles prefixes longer than 16 hex characters.
// Unconfirmed txs are matched against the backend's own mempool by the route.
//
// Built from getblock <hash> 1 per block, in height order; the entries of each height are contiguous, so a reorg
// truncates the arrays back to the fork. Saved in <CACHE_DIR>/freebank/txid-index.bin (+ .json for the block hashes
// and offsets), so a restart resumes instead of reading every block again.

const RETRY_MS = 30_000;
const SAVE_DELAY_MS = 30_000;
const KEEP_HASHES = 2016; // block hashes kept to find where a reorg forks; a deeper one starts over
const CACHE_VERSION = 1;
const CACHE_SUBDIR = 'freebank';
const CACHE_BASE = 'txid-index';
export const TXID_PREFIX_MIN = 6;
export const TXID_PREFIX_RESULTS = 10;

export interface TxidIndexNode {
  getBlockCount(): Promise<number>;
  getBlockHash(height: number): Promise<string>;
  getBlock(hash: string, verbosity: number): Promise<any>;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class TxidIndex {
  private hi = new Uint32Array(1 << 16);
  private lo = new Uint32Array(1 << 16);
  private heights = new Uint32Array(1 << 16);
  private count = 0;
  private offsets: number[] = []; // offsets[h] = first entry of height h
  private hashes = new Map<number, string>(); // the newest KEEP_HASHES blocks
  private top = -1;
  private genesis: string | null = null;
  private loaded = false;
  private working = false;
  private again = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving = false;

  constructor(
    private readonly node: TxidIndexNode = bitcoinClient,
    private readonly cacheBase: string | null = path.join(config.MEMPOOL.CACHE_DIR, CACHE_SUBDIR, CACHE_BASE),
  ) { }

  public kick(): void {
    if (this.working) {
      this.again = true;
      return;
    }
    void this.$work();
  }

  public getTop(): number {
    return this.top;
  }

  public size(): number {
    return this.count;
  }

  /**
   * Confirmed txids starting with `prefix` (lower-case hex, TXID_PREFIX_MIN to 63 chars), newest first, at most
   * `limit`. @asyncUnsafe
   */
  public async $match(prefix: string, limit = TXID_PREFIX_RESULTS): Promise<{ txid: string, height: number }[]> {
    const p = prefix.toLowerCase();
    const head = p.slice(0, 16);
    const bits = head.length * 4;
    const hiBits = Math.min(32, bits);
    const loBits = Math.max(0, bits - 32);
    const hiWant = parseInt(head.slice(0, 8).padEnd(8, '0'), 16) >>> 0;
    const loWant = head.length > 8 ? parseInt(head.slice(8).padEnd(8, '0'), 16) >>> 0 : 0;
    const hiMask = hiBits === 32 ? 0xffffffff : (~((1 << (32 - hiBits)) - 1)) >>> 0;
    const loMask = loBits === 0 ? 0 : loBits === 32 ? 0xffffffff : (~((1 << (32 - loBits)) - 1)) >>> 0;
    // candidate heights, newest first (the arrays are in height order)
    const candidateHeights: number[] = [];
    for (let i = this.count - 1; i >= 0 && candidateHeights.length < limit * 4; i--) {
      if (((this.hi[i] & hiMask) >>> 0) === hiWant && ((this.lo[i] & loMask) >>> 0) === loWant) {
        const h = this.heights[i];
        if (candidateHeights[candidateHeights.length - 1] !== h) {
          candidateHeights.push(h);
        }
      }
    }
    const out: { txid: string, height: number }[] = [];
    for (const h of candidateHeights) {
      if (out.length >= limit) {
        break;
      }
      let block: any;
      try {
        block = await this.node.getBlock(await this.node.getBlockHash(h), 1);
      } catch {
        continue; // the block left the chain (or the node is behind a reorg the index has not seen yet)
      }
      for (const txid of [...(block?.tx || [])].reverse()) {
        if (typeof txid === 'string' && txid.startsWith(p) && out.length < limit) {
          out.push({ txid, height: h });
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------------------------ sync

  /** @asyncSafe */
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
      logger.warn(`FreeBank txid index: ${errMsg(e)}. Retrying in ${RETRY_MS / 1000} seconds.`);
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
    this.count = 0;
    this.offsets = [];
    this.hashes.clear();
    this.top = -1;
    this.genesis = null;
  }

  private truncateTo(height: number): void {
    this.count = height + 1 < this.offsets.length ? this.offsets[height + 1] : this.count;
    this.offsets.length = Math.min(this.offsets.length, height + 1);
    for (const h of [...this.hashes.keys()]) {
      if (h > height) {
        this.hashes.delete(h);
      }
    }
    this.top = height;
  }

  /** @asyncUnsafe */
  private async $sync(): Promise<void> {
    const tip = await this.node.getBlockCount();
    if (this.top >= 0 && await this.node.getBlockHash(0) !== this.genesis) {
      logger.info('FreeBank txid index: the node is on another chain, starting over');
      this.reset();
    }
    if (this.top >= 0) {
      let h = Math.min(this.top, tip);
      const low = Math.max(0, this.top - KEEP_HASHES + 1);
      while (h >= low) {
        const kept = this.hashes.get(h);
        if (kept && kept === await this.node.getBlockHash(h)) {
          break;
        }
        h--;
      }
      if (h < low) {
        logger.info('FreeBank txid index: a reorg deeper than the kept hashes, starting over');
        this.reset();
      } else if (h < this.top) {
        logger.info(`FreeBank txid index: reorg, dropping blocks ${h + 1} to ${this.top}`);
        this.truncateTo(h);
        this.scheduleSave();
      }
    }
    let scanned = 0;
    while (this.top < tip) {
      const next = this.top + 1;
      const hash = await this.node.getBlockHash(next);
      const block = await this.node.getBlock(hash, 1);
      if (next > 0 && block?.previousblockhash !== this.hashes.get(this.top)) {
        this.again = true;
        return;
      }
      if (next === 0) {
        this.genesis = hash;
      }
      this.offsets[next] = this.count;
      for (const txid of block?.tx || []) {
        if (typeof txid === 'string' && txid.length === 64) {
          this.push(txid, next);
        }
      }
      this.hashes.set(next, hash);
      this.hashes.delete(next - KEEP_HASHES);
      this.top = next;
      if (++scanned % 100 === 0) {
        this.scheduleSave();
      }
      if (this.again) {
        return;
      }
    }
    if (scanned) {
      this.scheduleSave();
    }
  }

  private push(txid: string, height: number): void {
    if (this.count === this.hi.length) {
      const grow = (a: Uint32Array): Uint32Array => {
        const b = new Uint32Array(a.length * 2);
        b.set(a);
        return b;
      };
      this.hi = grow(this.hi);
      this.lo = grow(this.lo);
      this.heights = grow(this.heights);
    }
    this.hi[this.count] = parseInt(txid.slice(0, 8), 16) >>> 0;
    this.lo[this.count] = parseInt(txid.slice(8, 16), 16) >>> 0;
    this.heights[this.count] = height;
    this.count++;
  }

  // ------------------------------------------------------------------------------ cache files

  private loadCache(): void {
    if (!this.cacheBase) {
      return;
    }
    try {
      const meta = JSON.parse(fs.readFileSync(this.cacheBase + '.json', 'utf8'));
      if (meta?.version !== CACHE_VERSION || typeof meta.top !== 'number' || !Array.isArray(meta.offsets) || !Array.isArray(meta.hashes)) {
        return;
      }
      const bin = fs.readFileSync(this.cacheBase + '.bin');
      const n = meta.count;
      if (bin.length !== n * 12) {
        return;
      }
      const size = Math.max(1 << 16, 1 << Math.ceil(Math.log2(n + 1)));
      this.hi = new Uint32Array(size);
      this.lo = new Uint32Array(size);
      this.heights = new Uint32Array(size);
      for (let i = 0; i < n; i++) {
        this.hi[i] = bin.readUInt32LE(i * 12);
        this.lo[i] = bin.readUInt32LE(i * 12 + 4);
        this.heights[i] = bin.readUInt32LE(i * 12 + 8);
      }
      this.count = n;
      this.offsets = meta.offsets;
      this.hashes = new Map(meta.hashes);
      this.top = meta.top;
      this.genesis = meta.genesis;
      logger.info(`FreeBank txid index: resuming at block ${this.top} (${n} txids) from ${this.cacheBase}.bin`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        logger.warn(`FreeBank txid index: cannot read its cache (${errMsg(e)}), scanning from the start`);
      }
      this.reset();
    }
  }

  private scheduleSave(): void {
    if (!this.cacheBase || this.saveTimer) {
      return;
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.$save();
    }, SAVE_DELAY_MS);
  }

  /** @asyncSafe */
  public async $save(): Promise<void> {
    if (!this.cacheBase || this.top < 0) {
      return;
    }
    if (this.saving) {
      this.scheduleSave();
      return;
    }
    this.saving = true;
    try {
      await fs.promises.mkdir(path.dirname(this.cacheBase), { recursive: true });
      const n = this.count;
      const bin = Buffer.alloc(n * 12);
      for (let i = 0; i < n; i++) {
        bin.writeUInt32LE(this.hi[i], i * 12);
        bin.writeUInt32LE(this.lo[i], i * 12 + 4);
        bin.writeUInt32LE(this.heights[i], i * 12 + 8);
      }
      const meta = {
        version: CACHE_VERSION, top: this.top, genesis: this.genesis, count: n,
        offsets: this.offsets.slice(0, this.top + 1), hashes: [...this.hashes.entries()],
      };
      const tmp = `.${process.pid}.tmp`;
      await fs.promises.writeFile(this.cacheBase + '.bin' + tmp, bin);
      await fs.promises.writeFile(this.cacheBase + '.json' + tmp, JSON.stringify(meta));
      await fs.promises.rename(this.cacheBase + '.bin' + tmp, this.cacheBase + '.bin');
      await fs.promises.rename(this.cacheBase + '.json' + tmp, this.cacheBase + '.json');
    } catch (e) {
      logger.warn(`FreeBank txid index: cannot write its cache: ${errMsg(e)}`);
    } finally {
      this.saving = false;
    }
  }
}

export default new TxidIndex();
