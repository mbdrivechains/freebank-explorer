import { createHash } from 'crypto';
import { coinTags } from '../../../api/freebank/custody-tags';
import { creditOpName, decodeCreditPayload, parseFreebankTx } from '../../../api/freebank/freebank-tx-parser';

// Repay in kind (freebankd v0.2.27, bill op 9, REPAY_IN_KIND_DESIGN.md), on the real txs of freebankd's own gate
// repay_in_kind_roundtrip.sh (ecash/repay-cycle.sh): house 1 discounts bill 1 (face 1) and bill 2 (face 0.5); the
// drawee repays bill 1 with 0.95 in the house's own notes and 0.05 in ECX to the custody key, and bill 2 all in notes.
// Checked against the node's op names, listbills and gethouse.
const fx = require('../test-data/freebank-v0229-repay-txs.json');
const read = fx.txs.map((t: any) => {
  const tx = parseFreebankTx(t.hex);
  expect(tx.txid).toEqual(t.txid);
  return { ...t, op: creditOpName(tx.family as any, tx.op as number), d: decodeCreditPayload(tx.family, tx.op, tx.payload), tags: coinTags(tx) };
});
const bill = (id: number): any => fx.bills.find((b: any) => b.id === id);
const sha256 = (b: Buffer): Buffer => createHash('sha256').update(b).digest();
const custodyKeyScript = '76a914' + createHash('ripemd160').update(sha256(Buffer.from(fx.house.redemptiondestpk, 'hex'))).digest('hex') + '88ac';

describe('FreeBank repay in kind (v0.2.27)', () => {
  test('every bill tx reads whole, named as the node names it', () => {
    for (const t of read) {
      expect(t.op).toEqual(t.node.credit.op_name);
    }
    expect(read.filter((t: any) => t.op === 'hretire_notes')).toHaveLength(2);
  });

  test('op 9, part in notes: 0.95 burned, 0.05 to the custody key', () => {
    const [part] = read.filter((t: any) => t.op === 'hretire_notes' && t.d.bill_id === 1);
    expect(part.d).toEqual({ bill_id: 1, house_id: 1, face_sats: 100000000, maturity_height: bill(1).maturity_height, units_burned: 95000000 });
    expect(part.node.vout[0]).toEqual({ value: 0.05, script: custodyKeyScript });
    expect(part.tags.every((tag: any) => tag === null)).toBe(true); // the notes are burned: no note outputs
  });

  test('op 9, all in notes: no output to the custody key', () => {
    const [whole] = read.filter((t: any) => t.op === 'hretire_notes' && t.d.bill_id === 2);
    expect(whole.d).toEqual({ bill_id: 2, house_id: 1, face_sats: 50000000, maturity_height: bill(2).maturity_height, units_burned: 50000000 });
    expect(whole.node.vout.some((o: any) => o.script === custodyKeyScript)).toBe(false);
    expect(whole.tags.every((tag: any) => tag === null)).toBe(true);
  });

  test('both bills retired and out of the book', () => {
    expect([bill(1), bill(2)].map((b: any) => [b.status, b.owner_house_id])).toEqual([['r', 0], ['r', 0]]);
    expect(fx.house.loanbookface).toEqual(0);
  });
});
