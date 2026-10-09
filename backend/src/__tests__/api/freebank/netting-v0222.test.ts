import { creditOpName, decodeCreditPayload, parseFreebankTx } from '../../../api/freebank/freebank-tx-parser';
import { activityNamesHouse } from '../../../api/freebank/credit-activity';

// Multilateral netting (freebankd v0.2.22, D-2026-10-09-1), on the real rounds of freebankd's own gate
// settle_net_roundtrip.sh (ecash/net-cycle.sh): every house's notes retired, net and payment equal listsettlements.
const fx = require('../test-data/freebank-v0222-txs.json');

describe('FreeBank netting rounds (v0.2.22)', () => {
  test.each<[string, any]>(fx.txs.map((t: any): [string, any] => [t.txid.slice(0, 12), t]))('round %s matches listsettlements', (_l: string, t: any) => {
    const tx = parseFreebankTx(t.hex);
    expect(tx.txid).toEqual(t.txid);
    expect(creditOpName(tx.family as any, tx.op as number)).toEqual('net');
    const d = decodeCreditPayload(tx.family, tx.op, tx.payload);
    const node = fx.listsettlements_net.find((s: any) => s.txid === t.txid);
    expect(node).toBeDefined();
    const split = (key: string): number[] => String(d[key]).split(',').map(Number);
    expect(split('house_ids')).toEqual(node.houses.map((h: any) => h.house));
    expect(split('units_retired')).toEqual(node.houses.map((h: any) => h.units_retired));
    expect(split('nets')).toEqual(node.houses.map((h: any) => h.net));
    expect(split('received_sats')).toEqual(node.houses.map((h: any) => h.received_sats));
    expect(d.paid_sats).toEqual(node.houses.reduce((s: number, h: any) => s + h.received_sats, 0));
    // the round shows on every one of its houses' pages, and on no other
    const item: any = { decoded: d };
    for (const h of node.houses) {
      expect(activityNamesHouse(item, h.house)).toBe(true);
    }
    expect(activityNamesHouse(item, 99)).toBe(false);
  });
});
