import * as fs from 'fs';
import * as path from 'path';
import config from '../../config';
import logger from '../../logger';
import bitcoinClient from '../bitcoin/bitcoin-client';
import { AssetCoinKind, AssetLedger, AssetRecord, AssetTxEvent, StoredAssetBlock } from './asset-state';

// FreeBank: the index behind /api/v1/freebank/asset*: every asset (v0.2.18 tx v10) and every coin that carries one,
// from the colouring rule replayed over the whole chain (asset-state.ts). The node offers listassets and, per unspent
// output, gettxout's colour; holders, burns and the colour of spent coins need the replay.
//
// Built like the peg index (peg-index.ts): per block getblockhash + getblock <hash> 2; blocks with asset events are
// kept for good (the ledger is rebuilt from them), others only while among the newest KEEP_RECENT (to find where a
// reorg forks). Reorgs drop the blocks above the fork and rebuild the ledger from the kept events; a reorg deeper than
// the window starts over. Kept in <CACHE_DIR>/freebank/asset-index.json with the chain's genesis hash. index.ts kicks
// it at startup and on each new block; answers carry behind_by.

const KEEP_RECENT = 2016;
const RETRY_MS = 30_000;
const SAVE_DELAY_MS = 10_000;
const SAVE_EVERY_BLOCKS = 500;
// Bump when asset-state.ts's stored events change: the index then reads the chain again.
const CACHE_VERSION = 1;
const CACHE_SUBDIR = 'freebank';
const CACHE_FILE = 'asset-index.json';

export const ASSET_HOLDERS_MAX = 100;
export const ASSET_TXS_MAX = 50;

export interface AssetNode {
  getBlockCount(): Promise<number>;
  getBlockHash(height: number): Promise<string>;
  getBlock(hash: string, verbosity: number): Promise<any>;
}

export interface AssetTipInfo {
  tip_height: number; // the index's top
  behind_by: number; // blocks the node's tip is past it
}

export interface AssetSummaryRow extends AssetRecord {
  circulating: number; // supply - burned
  holders: number; // addresses holding units now
  control_address: string | null; // where the control coin is now (null: unknown script)
}

export interface AssetHolder {
  address: string | null; // null: a script without an address
  units: number;
  coins: number;
}

export interface AssetTxRow {
  txid: string;
  height: number;
  time: number;
  kind: 'genesis' | 'transfer' | 'invalid';
  units_moved: number; // units in the tx's coloured inputs (the supply for a genesis)
  burned: number;
  control_moved: boolean;
}

export interface AssetDetail extends AssetSummaryRow {
  holders_list: AssetHolder[]; // largest first, at most ASSET_HOLDERS_MAX
  holders_truncated: boolean;
  control: { txid: string, vout: number, address: string | null } | null;
  txs: AssetTxRow[]; // newest first, at most ASSET_TXS_MAX
}

/** One coin's colour, for the custody labels on a tx page. */
export interface AssetColour {
  asset_id: string;
  ticker: string;
  decimals: number;
  kind: AssetCoinKind;
  units: number;
  burn?: true;
}

/** GET asset-coins: the coloured inputs and outputs of one tx. */
export interface AssetTxCoins {
  asset_id: string;
  ticker: string;
  decimals: number;
  genesis: boolean;
  invalid?: string;
  in: { txid: string, vout: number, kind: AssetCoinKind, units: number }[];
  out: { n: number, kind: AssetCoinKind, units: number, burn?: true }[];
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** @asyncSafe */
function sleep$(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AssetIndex {
  private blocks = new Map<number, StoredAssetBlock>();
  private top = -1;
  private genesis: string | null = null;
  private ledger = new AssetLedger();
  private dirty = false; // the ledger must be rebuilt from the kept blocks
  private loaded = false;

  private working = false;
  private again = false;
  private syncTip = -1;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving = false;
  private scannedSinceSave = 0;

  constructor(
    private readonly node: AssetNode = bitcoinClient,
    private readonly cacheFile: string | null = path.join(config.MEMPOOL.CACHE_DIR, CACHE_SUBDIR, CACHE_FILE),
  ) { }

  /** Start (or nudge) the indexer; never throws. Same contract as PegIndex.kick. */
  public kick(tipHeight?: number): void {
    if (this.working) {
      if (tipHeight === undefined || (this.syncTip >= 0 && (tipHeight !== this.syncTip || this.top >= this.syncTip))) {
        this.again = true;
      }
      return;
    }
    void this.$work();
  }

  public holdsTip(tip: { height: number, hash: string }): boolean {
    return this.blocks.get(tip.height)?.hash === tip.hash;
  }

  public tipInfo(nodeHeight: number): AssetTipInfo {
    return { tip_height: this.top, behind_by: Math.max(0, nodeHeight - this.top) };
  }

  /** @asyncSafe */
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

  /** Every asset, oldest first. */
  public list(): AssetSummaryRow[] {
    const ledger = this.current();
    const stats = this.holderStats(ledger);
    return [...ledger.assets.values()]
      .sort((a, b) => a.height - b.height || a.asset_id.localeCompare(b.asset_id))
      .map((a) => this.summaryRow(a, stats.get(a.asset_id)));
  }

  /** One asset with its holders and recent transactions; null if the index has not seen it. */
  public get(assetId: string): AssetDetail | null {
    const ledger = this.current();
    const asset = ledger.assets.get(assetId);
    if (!asset) {
      return null;
    }
    const byAddress = new Map<string, AssetHolder>();
    let control: AssetDetail['control'] = null;
    for (const [key, coin] of ledger.coins) {
      if (coin.asset_id !== assetId) {
        continue;
      }
      if (coin.kind === 'control') {
        const [txid, vout] = key.split(':');
        control = { txid, vout: Number(vout), address: coin.address };
        continue;
      }
      const k = coin.address ?? '';
      const holder = byAddress.get(k) ?? { address: coin.address, units: 0, coins: 0 };
      holder.units += coin.units;
      holder.coins++;
      byAddress.set(k, holder);
    }
    const holders = [...byAddress.values()].sort((a, b) => b.units - a.units || String(a.address).localeCompare(String(b.address)));
    const txs = [...ledger.txs.values()]
      .filter((t) => t.ev.asset_id === assetId)
      .sort((a, b) => b.height - a.height)
      .slice(0, ASSET_TXS_MAX)
      .map((t) => txRow(t.ev, t.height, t.time));
    return {
      ...this.summaryRow(asset, { holders: holders.length, control: control?.address ?? null }),
      holders_list: holders.slice(0, ASSET_HOLDERS_MAX),
      holders_truncated: holders.length > ASSET_HOLDERS_MAX,
      control,
      txs,
    };
  }

  /** The colour of output `n` of `txid` (spent or not), or null when it carries no asset. */
  public colourOf(txid: string, n: number): AssetColour | null {
    const ledger = this.current();
    const ref = ledger.txs.get(txid);
    const out = ref?.ev.out.find((o) => o.n === n);
    if (!ref || !out) {
      return null;
    }
    const asset = ledger.assets.get(ref.ev.asset_id);
    const colour: AssetColour = {
      asset_id: ref.ev.asset_id, ticker: asset?.ticker ?? '', decimals: asset?.decimals ?? 0, kind: out.kind, units: out.units,
    };
    if (out.burn) {
      colour.burn = true;
    }
    return colour;
  }

  /**
   * The asset coins a confirmed tx spends and creates (by outpoint and output index), or null when it touches no
   * asset (or the index has not read its block yet). For the labels on tx lists and pages.
   */
  public txCoins(txid: string): AssetTxCoins | null {
    const ledger = this.current();
    const ref = ledger.txs.get(txid);
    if (!ref) {
      return null;
    }
    const asset = ledger.assets.get(ref.ev.asset_id);
    const base = { asset_id: ref.ev.asset_id, ticker: asset?.ticker ?? '', decimals: asset?.decimals ?? 0 };
    return {
      ...base,
      genesis: !!ref.ev.genesis,
      invalid: ref.ev.invalid,
      in: ref.ev.in.map((c) => ({ txid: c.txid, vout: c.vout, kind: c.kind, units: c.units })),
      out: ref.ev.out.map((o) => ({ n: o.n, kind: o.kind, units: o.units, ...(o.burn ? { burn: true as const } : {}) })),
    };
  }

  /** The asset coins an address holds now, per asset (no address index needed: the ledger has every coloured coin). */
  public holdings(address: string): { asset_id: string, ticker: string, decimals: number, units: number, coins: number, control: boolean }[] {
    const ledger = this.current();
    const per = new Map<string, { asset_id: string, ticker: string, decimals: number, units: number, coins: number, control: boolean }>();
    for (const coin of ledger.coins.values()) {
      if (coin.address !== address) {
        continue;
      }
      const asset = ledger.assets.get(coin.asset_id);
      const row = per.get(coin.asset_id)
        ?? { asset_id: coin.asset_id, ticker: asset?.ticker ?? '', decimals: asset?.decimals ?? 0, units: 0, coins: 0, control: false };
      if (coin.kind === 'control') {
        row.control = true;
      } else {
        row.units += coin.units;
        row.coins++;
      }
      per.set(coin.asset_id, row);
    }
    return [...per.values()].sort((a, b) => a.ticker.localeCompare(b.ticker) || a.asset_id.localeCompare(b.asset_id));
  }

  private holderStats(ledger: AssetLedger): Map<string, { holders: number, control: string | null }> {
    const addresses = new Map<string, Set<string>>();
    const control = new Map<string, string | null>();
    for (const coin of ledger.coins.values()) {
      if (coin.kind === 'control') {
        control.set(coin.asset_id, coin.address);
        continue;
      }
      let set = addresses.get(coin.asset_id);
      if (!set) {
        set = new Set();
        addresses.set(coin.asset_id, set);
      }
      set.add(coin.address ?? '');
    }
    const out = new Map<string, { holders: number, control: string | null }>();
    for (const id of ledger.assets.keys()) {
      out.set(id, { holders: addresses.get(id)?.size ?? 0, control: control.get(id) ?? null });
    }
    return out;
  }

  private summaryRow(a: AssetRecord, stats?: { holders: number, control: string | null }): AssetSummaryRow {
    return { ...a, circulating: a.supply - a.burned, holders: stats?.holders ?? 0, control_address: stats?.control ?? null };
  }

  private current(): AssetLedger {
    if (this.dirty) {
      const ledger = new AssetLedger();
      for (const b of [...this.blocks.values()].filter((x) => x.ev).sort((x, y) => x.height - y.height)) {
        ledger.applyBlock(b);
      }
      this.ledger = ledger;
      this.dirty = false;
    }
    return this.ledger;
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
      logger.warn(`FreeBank asset index: ${errMsg(e)}. Retrying in ${RETRY_MS / 1000} seconds.`);
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
    this.ledger = new AssetLedger();
    this.dirty = false;
  }

  /** @asyncUnsafe */
  private async $sync(): Promise<void> {
    this.syncTip = -1;
    const tip = await this.node.getBlockCount();
    this.syncTip = tip;

    if (this.top >= 0) {
      const genesis = await this.node.getBlockHash(0);
      if (genesis !== this.genesis) {
        logger.info('FreeBank asset index: the node is on another chain, starting over');
        this.reset();
      }
    }

    if (this.top >= 0) {
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
        logger.info('FreeBank asset index: a reorg deeper than the kept blocks, starting over');
        this.reset();
      } else if (h < this.top) {
        logger.info(`FreeBank asset index: reorg, dropping blocks ${h + 1} to ${this.top}`);
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
      const hash: string = await this.node.getBlockHash(next);
      const block = await this.node.getBlock(hash, 2);
      if (next > 0 && block?.previousblockhash !== this.blocks.get(this.top)?.hash) {
        this.again = true; // the chain moved under us; the next pass walks back
        return;
      }
      if (next === 0) {
        this.genesis = hash;
      }
      // scanBlock applies the block to the live ledger as it reads it (chained asset txs need that)
      const ledger = this.current();
      const ev = ledger.scanBlock(block, next);
      const stored: StoredAssetBlock = { height: next, hash, prev: block?.previousblockhash || '', time: block?.time ?? 0 };
      if (ev) {
        stored.ev = ev;
      }
      this.blocks.set(next, stored);
      this.top = next;
      this.trim();
      if (++this.scannedSinceSave >= SAVE_EVERY_BLOCKS) {
        this.scheduleSave();
      }
      if (this.again) {
        return;
      }
    }
    if (this.scannedSinceSave > 0) {
      this.scheduleSave();
    }
  }

  private trim(): void {
    const drop = this.top - KEEP_RECENT;
    const old = this.blocks.get(drop);
    if (drop > 0 && old && !old.ev) {
      this.blocks.delete(drop);
    }
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
        logger.warn(`FreeBank asset index: cannot read ${this.cacheFile} (${errMsg(e)}), scanning from the start`);
      }
      return;
    }
    if (data?.version !== CACHE_VERSION || typeof data.top !== 'number' || typeof data.genesis !== 'string' || !Array.isArray(data.blocks)) {
      logger.info(`FreeBank asset index: ${this.cacheFile} is of another version, scanning from the start`);
      return;
    }
    const blocks = new Map<number, StoredAssetBlock>();
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
    logger.info(`FreeBank asset index: resuming at block ${this.top} from ${this.cacheFile}`);
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

  /** Write the kept blocks (a temp file, then rename). Never rejects. @asyncSafe */
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
      logger.warn(`FreeBank asset index: cannot write ${this.cacheFile}: ${errMsg(e)}`);
    } finally {
      this.saving = false;
    }
  }
}

function txRow(ev: AssetTxEvent, height: number, time: number): AssetTxRow {
  const unitsIn = ev.in.reduce((sum, c) => sum + c.units, 0);
  return {
    txid: ev.txid,
    height,
    time,
    kind: ev.invalid ? 'invalid' : ev.genesis ? 'genesis' : 'transfer',
    units_moved: ev.genesis ? ev.genesis.supply : unitsIn,
    burned: ev.out.filter((o) => o.burn).reduce((sum, o) => sum + o.units, 0),
    control_moved: !ev.genesis && ev.in.some((c) => c.kind === 'control'),
  };
}

export default new AssetIndex();
