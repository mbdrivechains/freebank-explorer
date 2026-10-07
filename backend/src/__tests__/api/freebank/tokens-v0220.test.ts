import { coinTags } from '../../../api/freebank/custody-tags';
import { creditOpName, decodeCreditPayload, parseFreebankTx } from '../../../api/freebank/freebank-tx-parser';

// Token mint and burn records (freebankd v0.2.20, D-2026-10-08-1), on real txs from ecash/tokens-cycle.sh: house 1
// minted 1,000,000 units, locked 500,000 then 120,000 as token backing, and burned 200,000 (tokenunits 420,000).
const fixtures = require('../test-data/freebank-v0220-txs.json');
const tx = (label: string): any => fixtures.txs.find((t: any) => t.label === label);
const read = (label: string): any => {
  const t = parseFreebankTx(tx(label).hex);
  expect(t.txid).toEqual(tx(label).txid);
  return { op: creditOpName(t.family as any, t.op as number), ...decodeCreditPayload(t.family, t.op, t.payload), tags: coinTags(t) };
};

describe('FreeBank token records (v0.2.20)', () => {
  test('LOCK, the mint record: the units locked, and the change notes back to the holder', () => {
    const a = read('lock-1');
    const b = read('lock-2');
    expect(a).toMatchObject({ op: 'lock', house_id: 1, units: 500000 });
    expect(b).toMatchObject({ op: 'lock', house_id: 1, units: 120000 });
    for (const [r, t] of [[a, tx('lock-1')], [b, tx('lock-2')]]) {
      // the change notes are the leading outputs, tagged as notes of house 1 with their units
      const notes = r.tags.filter((g: any) => g?.kind === 'note');
      expect(notes.length).toEqual(r.outputs);
      expect(notes.reduce((s: number, g: any) => s + g.units, 0)).toEqual(r.change_units);
      // each note coin carries the 1,000-szat note dust; its units are in the payload
      notes.forEach((g: any, i: number) => {
        expect(g.houseId).toEqual(1);
        expect(t.note_outputs[i]).toEqual(1000);
      });
    }
  });

  test('UNLOCK, the burn record: the backing released as note coins', () => {
    const u = read('unlock-1');
    expect(u).toMatchObject({ op: 'unlock', house_id: 1, units: 200000, outputs: 1 });
    expect(u.tags[0]).toMatchObject({ kind: 'note', houseId: 1, units: 200000 });
  });

  test('locks less burns is the node\'s tokenunits', () => {
    expect(read('lock-1').units + read('lock-2').units - read('unlock-1').units).toEqual(fixtures.house.tokenunits);
  });
});
