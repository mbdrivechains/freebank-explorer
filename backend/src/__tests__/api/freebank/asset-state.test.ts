import { AssetLedger, isUnspendableScript } from '../../../api/freebank/asset-state';

// The colouring rule (freebank src/asset.cpp ComputeAssetTags) on hand-made getblock-2 blocks. Values in ECX, as the
// node prints them; units are szats of the coloured outputs.

const P2PKH = (n: number): any => ({ hex: '76a914' + String(n).padStart(40, '0') + '88ac', addresses: [`X${n}`] });
const OP_RETURN = { hex: '6a0474657374' };
const id = (n: number): string => n.toString(16).padStart(64, '0');
const coinbase = (n: number): any => ({ txid: id(1000 + n), version: 3, vin: [{ coinbase: '00' }], vout: [{ n: 0, value: 1, scriptPubKey: P2PKH(1) }] });
const out = (n: number, value: number, spk: any = P2PKH(n + 10)): any => ({ n, value, scriptPubKey: spk });
const block = (h: number, txs: any[]): any => ({ hash: id(5000 + h), time: 1000 + h, tx: [coinbase(h), ...txs] });

const GOLD = id(1);
const genesis = {
  txid: GOLD, version: 10,
  vin: [{ txid: id(900), vout: 0 }],
  vout: [out(0, 0.00001), out(1, 10), out(2, 4.5)], // control, 1e9 units, plain change
  asset_genesis: { asset_id: GOLD, ticker: 'GOLD', headline: '1 unit = 1 mg', payload: '', decimals: 3, supply: 1000000000 },
};

function ledgerWithGold(): AssetLedger {
  const ledger = new AssetLedger();
  ledger.scanBlock(block(1, [genesis]), 1);
  return ledger;
}

describe('FreeBank asset colouring', () => {
  test('a v10 genesis: control at vout[0], the whole supply at vout[1], the rest plain', () => {
    const ledger = new AssetLedger();
    const ev = ledger.scanBlock(block(1, [genesis]), 1);
    expect(ev?.txs).toHaveLength(1);
    expect(ev?.txs[0].genesis?.ticker).toEqual('GOLD');
    expect(ev?.txs[0].out).toEqual([
      { n: 0, kind: 'control', units: 0, address: 'X10' },
      { n: 1, kind: 'units', units: 1000000000, address: 'X11' },
    ]);
    expect(ledger.assets.get(GOLD)).toMatchObject({ supply: 1000000000, decimals: 3, height: 1, burned: 0, tx_count: 1 });
    expect([...ledger.coins.keys()].sort()).toEqual([`${GOLD}:0`, `${GOLD}:1`]);
  });

  test('a transfer: the leading outputs that sum exactly to the units spent are units; the rest is plain', () => {
    const ledger = ledgerWithGold();
    const t = { txid: id(2), version: 2, vin: [{ txid: GOLD, vout: 1 }, { txid: id(901), vout: 0 }], vout: [out(0, 0.0025), out(1, 9.9975), out(2, 3)] };
    const ev = ledger.scanBlock(block(2, [t]), 2);
    expect(ev?.txs[0].in).toEqual([{ txid: GOLD, vout: 1, kind: 'units', units: 1000000000 }]);
    expect(ev?.txs[0].out.map((o) => [o.n, o.kind, o.units])).toEqual([[0, 'units', 250000], [1, 'units', 999750000]]);
    expect(ledger.coins.has(`${GOLD}:1`)).toBe(false);
    expect(ledger.coins.get(`${id(2)}:0`)).toMatchObject({ asset_id: GOLD, units: 250000 });
    expect(ledger.coins.has(`${id(2)}:2`)).toBe(false); // plain change
  });

  test('moving the control coin makes vout[0] the new control coin, units follow it', () => {
    const ledger = ledgerWithGold();
    const t = { txid: id(3), version: 3, vin: [{ txid: GOLD, vout: 0 }, { txid: GOLD, vout: 1 }], vout: [out(0, 0.00001), out(1, 10), out(2, 1)] };
    const ev = ledger.scanBlock(block(2, [t]), 2);
    expect(ev?.txs[0].out.map((o) => o.kind)).toEqual(['control', 'units']);
    expect(ledger.coins.get(`${id(3)}:0`)?.kind).toEqual('control');
  });

  test('units sent to OP_RETURN are burned: circulating supply falls', () => {
    const ledger = ledgerWithGold();
    const t = { txid: id(4), version: 3, vin: [{ txid: GOLD, vout: 1 }], vout: [out(0, 1, OP_RETURN), out(1, 9)] };
    const ev = ledger.scanBlock(block(2, [t]), 2);
    expect(ev?.txs[0].out[0]).toMatchObject({ n: 0, burn: true, units: 100000000 });
    expect(ledger.assets.get(GOLD)?.burned).toEqual(100000000);
    expect(ledger.coins.has(`${id(4)}:0`)).toBe(false);
  });

  test('chained asset txs in one block replay in order', () => {
    const ledger = ledgerWithGold();
    const a = { txid: id(5), version: 3, vin: [{ txid: GOLD, vout: 1 }], vout: [out(0, 4), out(1, 6)] };
    const b = { txid: id(6), version: 3, vin: [{ txid: id(5), vout: 1 }], vout: [out(0, 6)] };
    const ev = ledger.scanBlock(block(2, [a, b]), 2);
    expect(ev?.txs.map((t) => t.txid)).toEqual([id(5), id(6)]);
    expect(ledger.coins.get(`${id(6)}:0`)).toMatchObject({ units: 600000000 });
  });

  test('a plain tx touches nothing; a tx that breaks the rule is kept as invalid with plain outputs', () => {
    const ledger = ledgerWithGold();
    expect(ledger.scanBlock(block(2, [{ txid: id(7), version: 3, vin: [{ txid: id(902), vout: 0 }], vout: [out(0, 1)] }]), 2)).toBeNull();
    const short = { txid: id(8), version: 3, vin: [{ txid: GOLD, vout: 1 }], vout: [out(0, 3)] };
    const ev = ledger.scanBlock(block(3, [short]), 3);
    expect(ev?.txs[0]).toMatchObject({ invalid: 'bad-asset-units-not-conserved', out: [] });
    expect(ledger.coins.has(`${GOLD}:1`)).toBe(false);
  });

  test('a rebuild from stored events gives the same ledger', () => {
    const live = new AssetLedger();
    const blocks = [
      block(1, [genesis]),
      block(2, [{ txid: id(9), version: 2, vin: [{ txid: GOLD, vout: 1 }], vout: [out(0, 2), out(1, 1, OP_RETURN), out(2, 7)] }]),
    ];
    const stored = blocks.map((b, i) => ({ height: i + 1, hash: b.hash, prev: '', time: b.time, ev: live.scanBlock(b, i + 1) || undefined }));
    const rebuilt = new AssetLedger();
    stored.forEach((b) => rebuilt.applyBlock(b));
    expect([...rebuilt.coins.entries()]).toEqual([...live.coins.entries()]);
    expect([...rebuilt.assets.values()]).toEqual([...live.assets.values()]);
  });

  test('isUnspendableScript: OP_RETURN or longer than 10,000 bytes', () => {
    expect(isUnspendableScript('6a')).toBe(true);
    expect(isUnspendableScript('76a9')).toBe(false);
    expect(isUnspendableScript('00'.repeat(10001))).toBe(true);
  });
});
