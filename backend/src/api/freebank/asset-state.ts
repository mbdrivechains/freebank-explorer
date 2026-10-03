// FreeBank assets (v0.2.18, D-2026-10-03-1): the colouring rule, replayed over the chain's blocks, so the explorer
// knows which coins carry an asset's units or its control without asking the node per output. Pure: no node, no
// files (asset-index.ts reads the blocks and keeps the events; tests feed blocks directly).
//
// The rule (freebank src/asset.cpp ComputeAssetTags, the node's single source of truth):
//   - a v10 transaction is an asset GENESIS: the asset id is its txid, vout[0] is the CONTROL coin, vout[1] carries
//     the whole SUPPLY (units = its value in szats); further outputs are plain ECX. It has no coloured inputs.
//   - a later transaction that spends coloured coins (only versions 1-9 may) moves ONE asset: at most one control
//     coin; if it spends the control coin, vout[0] is the new control coin; the unit outputs are the LEADING outputs
//     (after vout[0] when control moved) whose values sum exactly to the units spent, each > 0; the rest is plain.
//   - a unit output to an unspendable script (OP_RETURN) BURNS those units; the control coin cannot be burned.
//   - a block may chain asset transactions, so they are replayed in block order.
// The coinbase is never coloured. A block the node accepted always fits the rule; if one ever did not here, the
// transaction is kept as `invalid` with its outputs left plain, and the coloured inputs are still spent.

export type AssetCoinKind = 'units' | 'control';

export interface AssetGenesisInfo {
  ticker: string;
  headline: string;
  payload: string; // '' when all zero (as the node prints it)
  decimals: number; // display only: 0-8
  supply: number; // units created (szats of vout[1])
}

export interface AssetCoinIn {
  txid: string;
  vout: number;
  kind: AssetCoinKind;
  units: number; // 0 for the control coin
}

export interface AssetCoinOut {
  n: number;
  kind: AssetCoinKind;
  units: number; // 0 for the control coin
  address: string | null;
  burn?: true; // units sent to an unspendable script
}

/** One transaction that creates or moves an asset. Only coloured inputs and outputs are listed. */
export interface AssetTxEvent {
  txid: string;
  asset_id: string;
  genesis?: AssetGenesisInfo;
  in: AssetCoinIn[];
  out: AssetCoinOut[];
  invalid?: string; // the rule's reason, if the node's block broke it (never expected)
}

export interface AssetBlockEvents {
  txs: AssetTxEvent[];
}

export interface StoredAssetBlock {
  height: number;
  hash: string;
  prev: string;
  time: number;
  ev?: AssetBlockEvents;
}

export interface AssetCoin {
  asset_id: string;
  kind: AssetCoinKind;
  units: number;
  address: string | null;
  height: number;
}

export interface AssetRecord extends AssetGenesisInfo {
  asset_id: string;
  height: number;
  block_hash: string;
  time: number;
  burned: number; // units burned since the genesis
  tx_count: number; // transactions that created or moved it, the genesis included
  last_height: number;
}

export interface AssetTxRef {
  height: number;
  block_hash: string;
  time: number;
  ev: AssetTxEvent;
}

const SATS = 100_000_000;
const MAX_SCRIPT_SIZE = 10_000; // script.h: a longer script is unspendable

/** script.h CScript::IsUnspendable: OP_RETURN first, or longer than MAX_SCRIPT_SIZE. */
export function isUnspendableScript(hex: string): boolean {
  return (hex || '').startsWith('6a') || (hex || '').length / 2 > MAX_SCRIPT_SIZE;
}

function sats(value: unknown): number {
  return typeof value === 'number' ? Math.round(value * SATS) : 0;
}

function outAddress(out: any): string | null {
  const spk = out?.scriptPubKey;
  return spk?.address ?? spk?.addresses?.[0] ?? null;
}

const coinKey = (txid: string, n: number): string => `${txid}:${n}`;

/**
 * The asset ledger: every asset and every unspent coloured coin, built by applying block events in chain order.
 * `scanBlock` reads a getblock-2 block against the ledger, applies it, and returns its events (to be stored).
 */
export class AssetLedger {
  readonly assets = new Map<string, AssetRecord>();
  readonly coins = new Map<string, AssetCoin>(); // unspent coloured coins, by "txid:n"
  readonly txs = new Map<string, AssetTxRef>(); // every asset tx, by txid

  /** Read one block (getblock <hash> 2) at `height`, apply it, and return its asset events (null when none). */
  scanBlock(block: any, height: number): AssetBlockEvents | null {
    const events: AssetTxEvent[] = [];
    for (const tx of block?.tx || []) {
      const ev = this.colourTx(tx);
      if (ev) {
        this.applyTx(ev, height, block.hash, block.time ?? 0);
        events.push(ev);
      }
    }
    return events.length ? { txs: events } : null;
  }

  /** Apply a stored block's events (a rebuild after a reorg or a restart). */
  applyBlock(b: StoredAssetBlock): void {
    for (const ev of b.ev?.txs || []) {
      this.applyTx(ev, b.height, b.hash, b.time);
    }
  }

  /** The rule for one transaction (getblock-2 JSON) against the ledger as it stands; null if it touches no asset. */
  colourTx(tx: any): AssetTxEvent | null {
    const vin: any[] = tx?.vin || [];
    if (!vin.length || vin[0]?.coinbase !== undefined) {
      return null;
    }
    const vout: any[] = tx.vout || [];
    const ins: AssetCoinIn[] = [];
    let id: string | null = null;
    let mixed = false;
    let unitsIn = 0;
    let control = 0;
    for (const input of vin) {
      const coin = this.coins.get(coinKey(input.txid, input.vout));
      if (!coin) {
        continue;
      }
      ins.push({ txid: input.txid, vout: input.vout, kind: coin.kind, units: coin.units });
      if (id === null) {
        id = coin.asset_id;
      } else if (coin.asset_id !== id) {
        mixed = true;
      }
      if (coin.kind === 'units') {
        unitsIn += coin.units;
      } else {
        control++;
      }
    }

    if (tx.version === 10) {
      const g = tx.asset_genesis || {};
      const supply = sats(vout[1]?.value);
      const ev: AssetTxEvent = {
        txid: tx.txid,
        asset_id: tx.txid,
        genesis: {
          ticker: String(g.ticker ?? ''),
          headline: String(g.headline ?? ''),
          payload: String(g.payload ?? ''),
          decimals: typeof g.decimals === 'number' ? g.decimals : 0,
          supply: typeof g.supply === 'number' ? g.supply : supply,
        },
        in: ins,
        out: [],
      };
      if (ins.length) {
        ev.invalid = 'bad-asset-genesis-coloured-input';
      } else if (vout.length < 2) {
        ev.invalid = 'bad-asset-genesis-vout-count';
      } else {
        ev.out.push({ n: 0, kind: 'control', units: 0, address: outAddress(vout[0]) });
        ev.out.push({ n: 1, kind: 'units', units: supply, address: outAddress(vout[1]) });
      }
      return ev;
    }

    if (id === null) {
      return null;
    }
    const ev: AssetTxEvent = { txid: tx.txid, asset_id: id, in: ins, out: [] };
    const invalid = (reason: string): AssetTxEvent => {
      ev.invalid = reason;
      ev.out = [];
      return ev;
    };
    if (mixed) {
      return invalid('bad-asset-inputs-mixed');
    }
    if (control > 1) {
      return invalid('bad-asset-control-multiple');
    }
    if (!(tx.version >= 1 && tx.version < 10)) {
      return invalid('bad-asset-input-op');
    }
    let n = 0;
    if (control === 1) {
      if (!vout.length || isUnspendableScript(vout[0]?.scriptPubKey?.hex)) {
        return invalid('bad-asset-control-dest');
      }
      ev.out.push({ n: 0, kind: 'control', units: 0, address: outAddress(vout[0]) });
      n = 1;
    }
    let unitsOut = 0;
    while (unitsOut < unitsIn) {
      if (n >= vout.length) {
        return invalid('bad-asset-units-not-conserved');
      }
      const value = sats(vout[n]?.value);
      if (value <= 0) {
        return invalid('bad-asset-units-zero-output');
      }
      unitsOut += value;
      const out: AssetCoinOut = { n, kind: 'units', units: value, address: outAddress(vout[n]) };
      if (isUnspendableScript(vout[n]?.scriptPubKey?.hex)) {
        out.burn = true;
      }
      ev.out.push(out);
      n++;
    }
    if (unitsOut !== unitsIn) {
      return invalid('bad-asset-units-not-conserved');
    }
    return ev;
  }

  private applyTx(ev: AssetTxEvent, height: number, blockHash: string, time: number): void {
    for (const input of ev.in) {
      this.coins.delete(coinKey(input.txid, input.vout));
    }
    if (ev.genesis && !ev.invalid && !this.assets.has(ev.asset_id)) {
      this.assets.set(ev.asset_id, {
        asset_id: ev.asset_id, ...ev.genesis, height, block_hash: blockHash, time, burned: 0, tx_count: 0, last_height: height,
      });
    }
    const asset = this.assets.get(ev.asset_id);
    for (const out of ev.out) {
      if (out.burn) {
        if (asset) {
          asset.burned += out.units;
        }
        continue;
      }
      this.coins.set(coinKey(ev.txid, out.n), { asset_id: ev.asset_id, kind: out.kind, units: out.units, address: out.address, height });
    }
    if (asset) {
      asset.tx_count++;
      asset.last_height = height;
    }
    this.txs.set(ev.txid, { height, block_hash: blockHash, time, ev });
  }
}
