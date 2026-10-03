import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AssetIndex, AssetNode } from '../../../api/freebank/asset-index';
import { TxidIndex } from '../../../api/freebank/txid-index';

// The asset index and the txid index on a fake node: scanning, the listassets skip, reorgs, and the cache files.

const hex64 = (label: string): string => createHash('sha256').update(label).digest('hex');
const P2PKH = (n: number): any => ({ hex: '76a914' + String(n).padStart(40, '0') + '88ac', addresses: [`X${n}`] });
const out = (n: number, value: number): any => ({ n, value, scriptPubKey: P2PKH(n + 10) });
const coinbase = (h: number, tag: string): any => ({ txid: hex64(`cb ${tag} ${h}`), version: 3, vin: [{ coinbase: '00' }], vout: [out(0, 1)] });

function block(height: number, prev: string, txs: any[], tag = 'a'): any {
  return { height, hash: hex64(`block ${tag} ${height}`), previousblockhash: prev || undefined, time: 1000 + height, tx: [coinbase(height, tag), ...txs] };
}

const GOLD = hex64('gold genesis');
const genesis = { txid: GOLD, version: 10, vin: [{ txid: hex64('funding'), vout: 0 }], vout: [out(0, 0.00001), out(1, 10)],
  asset_genesis: { asset_id: GOLD, ticker: 'GOLD', headline: 'h', payload: '', decimals: 3, supply: 1000000000 } };
const transfer = { txid: hex64('gold transfer'), version: 2, vin: [{ txid: GOLD, vout: 1 }], vout: [out(0, 4), out(1, 6)] };

/** Blocks 0..n-1 with GOLD's genesis at `gHeight` and a transfer just after it. */
function chain(n: number, gHeight: number, tag = 'a', from: any[] = []): any[] {
  const blocks = [...from];
  for (let h = blocks.length; h < n; h++) {
    const txs = h === gHeight ? [genesis] : h === gHeight + 1 ? [transfer] : [];
    blocks.push(block(h, blocks[h - 1]?.hash, txs, tag));
  }
  return blocks;
}

class FakeNode implements AssetNode {
  public getBlockCalls: number[] = [];
  constructor(public blocks: any[], public listable = true) { }
  async getBlockCount(): Promise<number> {
    return this.blocks.length - 1;
  }
  async getBlockHash(height: number): Promise<string> {
    if (!this.blocks[height]) {
      throw Object.assign(new Error('Block height out of range'), { code: -8 });
    }
    return this.blocks[height].hash;
  }
  async getBlock(hash: string, verbosity: number): Promise<any> {
    const b = this.blocks.find((x) => x.hash === hash);
    if (!b) {
      throw Object.assign(new Error('Block not found'), { code: -5 });
    }
    this.getBlockCalls.push(b.height);
    return verbosity === 1 ? { ...b, tx: b.tx.map((t: any) => t.txid) } : b;
  }
  async listAssets(from: string, count: number): Promise<any[]> {
    if (!this.listable) {
      throw Object.assign(new Error('Method not found'), { code: -32601 });
    }
    const rows = this.blocks.flatMap((b) => b.tx.filter((t: any) => t.version === 10).map((t: any) => ({ asset_id: t.txid, height: b.height })));
    return rows.slice(0, count);
  }
}

async function settle(index: { $waitForTip(tip: { height: number, hash: string }, ms: number): Promise<void> }, node: FakeNode): Promise<void> {
  const tip = node.blocks[node.blocks.length - 1];
  await index.$waitForTip({ height: tip.height, hash: tip.hash }, 5000);
}

describe('FreeBank asset index', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-index-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('skips to just below the first genesis (listassets), then reads every block from there', async () => {
    const node = new FakeNode(chain(30, 20));
    const index = new AssetIndex(node, null);
    await settle(index, node);
    expect(Math.min(...node.getBlockCalls)).toEqual(20);
    expect(index.list().map((a) => [a.ticker, a.circulating, a.holders])).toEqual([['GOLD', 1000000000, 2]]);
    expect(index.txCoins(transfer.txid)?.out.map((o) => o.units)).toEqual([400000000, 600000000]);
  });

  test('a chain without assets reads no block at all; a node without listassets neither', async () => {
    for (const listable of [true, false]) {
      const node = new FakeNode(chain(30, 999), listable);
      const index = new AssetIndex(node, null);
      await settle(index, node);
      expect(node.getBlockCalls).toEqual([]);
      expect(index.tipInfo(29)).toEqual({ tip_height: 29, behind_by: 0 });
    }
  });

  test('after a skip, a reorg below it that brings an asset in is found (the index starts over)', async () => {
    const node = new FakeNode(chain(30, 999));
    const index = new AssetIndex(node, null);
    await settle(index, node);
    expect(index.list()).toEqual([]);
    node.blocks = chain(31, 15, 'c', node.blocks.slice(0, 10)); // a longer branch from block 10, GOLD at 15
    index.kick();
    await settle(index, node);
    expect(index.list().map((a) => [a.ticker, a.height])).toEqual([['GOLD', 15]]);
  });

  test('a reorg that drops the transfer rolls the holdings back', async () => {
    const node = new FakeNode(chain(25, 20));
    const index = new AssetIndex(node, null);
    await settle(index, node);
    expect(index.get(GOLD)?.holders_list.length).toEqual(2);
    node.blocks = chain(26, 999, 'b', node.blocks.slice(0, 21)); // same up to the genesis, then other blocks
    index.kick();
    await settle(index, node);
    const gold = index.get(GOLD);
    expect(gold?.holders_list).toEqual([{ address: 'X11', units: 1000000000, coins: 1 }]);
    expect(index.txCoins(transfer.txid)).toBeNull();
  });

  test('saved and reloaded: the same answers without reading the blocks again', async () => {
    const file = path.join(dir, 'asset-index.json');
    const node = new FakeNode(chain(25, 20));
    const first = new AssetIndex(node, file);
    await settle(first, node);
    await first.$save();
    node.getBlockCalls = [];
    const second = new AssetIndex(node, file);
    await settle(second, node);
    expect(node.getBlockCalls).toEqual([]);
    expect(second.list()).toEqual(first.list());
    expect(second.get(GOLD)).toEqual(first.get(GOLD));
  });
});

describe('FreeBank txid index', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txid-index-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  async function synced(node: FakeNode, base: string | null): Promise<TxidIndex> {
    const index = new TxidIndex(node, base);
    index.kick();
    const tip = node.blocks.length - 1;
    for (let i = 0; i < 200 && index.getTop() < tip; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return index;
  }

  test('finds txids by 6 to 64 hex characters, newest first', async () => {
    const node = new FakeNode(chain(25, 20));
    const index = await synced(node, null);
    expect(index.size()).toEqual(25 + 2);
    for (const n of [6, 7, 8, 9, 15, 16, 17, 40, 64]) {
      expect(await index.$match(GOLD.slice(0, n))).toEqual([{ txid: GOLD, height: 20 }]);
    }
    const txids = node.blocks.flatMap((b) => b.tx.map((t: any) => t.txid));
    const none = ['abcdef012345', '0123456789ab', 'fedcba987654'].find((p) => !txids.some((t) => t.startsWith(p))) as string;
    expect(await index.$match(none)).toEqual([]);
    expect((await index.$match(txids[3].slice(0, 6), 1)).length).toEqual(1);
  });

  test('a reorg truncates the replaced blocks; a reload resumes', async () => {
    const base = path.join(dir, 'txid-index');
    const node = new FakeNode(chain(25, 20));
    const index = await synced(node, base);
    node.blocks = chain(24, 999, 'b', node.blocks.slice(0, 21));
    node.blocks.push(block(24, node.blocks[23].hash, [], 'b'));
    index.kick();
    for (let i = 0; i < 200 && (await index.$match(transfer.txid.slice(0, 12))).length; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await index.$match(transfer.txid.slice(0, 12))).toEqual([]);
    expect(await index.$match(GOLD.slice(0, 12))).toEqual([{ txid: GOLD, height: 20 }]);
    await index.$save();
    node.getBlockCalls = [];
    const again = await synced(node, base);
    expect(node.getBlockCalls).toEqual([]);
    expect(again.size()).toEqual(index.size());
  });
});
