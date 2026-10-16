import { custodyLabelled, MUTUAL_FUND_SCRIPT } from '../../../api/freebank/custody-tags';
import { CustodyNode, FreebankCustody } from '../../../api/freebank/custody';
import { creditOpName, decodeCreditPayload, parseFreebankTx } from '../../../api/freebank/freebank-tx-parser';
import { houseBadge } from '../../../api/freebank/house-badge';

// A failed house, end to end (freebankd v0.2.28/v0.2.29, FAILED_HOUSE_DESIGN.md), on the real txs of freebankd's own
// gate failed_house_roundtrip.sh (ecash/failed-cycle.sh): house 1 discounts bills 2 and 3, suspends (DEFER), the
// drawee repays bill 2 into its escrow (bill op 10), it turns insolvent at the 12-month cap (regtest 400 blocks), a
// stranger moves defaulted bill 3's bond into its escrow (op 11), a note claim, and after the claim window the
// stranger CLOSEs it: the partner gets its residual, the rest goes to the mutual fund. Checked against the node's op
// names, listbills and gethouse.
const fx = require('../test-data/freebank-v0229-failed-txs.json');
const read = fx.txs.map((t: any) => {
  const tx = parseFreebankTx(t.hex);
  expect(tx.txid).toEqual(t.txid);
  return { ...t, op: creditOpName(tx.family as any, tx.op as number), d: decodeCreditPayload(tx.family, tx.op, tx.payload) };
});
const one = (name: string): any => {
  const found = read.filter((t: any) => t.op === name);
  expect(found).toHaveLength(1);
  return found[0];
};
const bill = (id: number): any => fx.bills.find((b: any) => b.id === id);
const sats = (ecx: number): number => Math.round(ecx * 1e8);

const node: CustodyNode = {
  getTip: async () => ({ height: fx.tip, hash: 'ff'.repeat(32) }) as any,
  getRawTransaction: async (txid: string) => fx.txs.find((t: any) => t.txid === txid)?.hex ?? null,
  listHouses: async () => fx.houses,
  listBills: async () => fx.bills,
  listPools: async () => [],
  listOracleSubmitters: async () => [],
};

describe('FreeBank failed house (v0.2.28-v0.2.29)', () => {
  test('every credit tx reads whole, named as the node names it', () => {
    for (const t of read) {
      expect(t.op).toEqual(t.node.credit.op_name);
    }
    expect(read.map((t: any) => t.op)).toEqual(
      ['register', 'issue', 'issue', 'discount', 'issue', 'discount', 'defer', 'hretire_escrow', 'hclaim_escrow', 'claim', 'close']);
  });

  test('bill op 10: bill 2 repaid into the suspended house\'s escrow, no notes', () => {
    const t = one('hretire_escrow');
    expect(t.d).toEqual({ bill_id: 2, house_id: 1, face_sats: sats(bill(2).amount), maturity_height: bill(2).maturity_height, units_burned: 0 });
    expect(sats(t.node.vout[0].value)).toEqual(t.d.face_sats);
    expect(bill(2)).toMatchObject({ status: 'r', owner_house_id: 0 });
  });

  test('bill op 11: defaulted bill 3\'s bond moved into the escrow by a stranger', () => {
    const t = one('hclaim_escrow');
    expect(t.d).toEqual({ bill_id: 3, house_id: 1, face_sats: sats(bill(3).amount), maturity_height: bill(3).maturity_height });
    expect(sats(t.node.vout[0].value)).toEqual(sats(bill(3).escrow));
    expect(bill(3)).toMatchObject({ status: 'd', owner_house_id: 0 });
  });

  test('house op 15: CLOSE pays the partner, then the mutual fund', () => {
    const t = one('close');
    expect(t.d).toEqual({ house_id: 1 });
    expect(t.node.vout[1].script).toEqual(MUTUAL_FUND_SCRIPT);
    expect(custodyLabelled(t.node.vout[1].script)).toBe(true);
    expect(t.node.vout[0].script).toMatch(/^76a914[0-9a-f]{40}88ac$/); // the partner's residual, on its own key
  });

  test('custody labels: the escrow repayments, and every coin the CLOSE spends', async () => {
    const op10 = one('hretire_escrow');
    const op11 = one('hclaim_escrow');
    const close = one('close');
    const res = await new FreebankCustody(node).$getCustody([op10.txid, op11.txid, close.txid]);
    const text = (l: any): string | null => l?.text ?? null;

    expect(res.txs[op10.txid]?.vout[0]).toMatchObject({ kind: 'house_bill_escrow', house_id: 1, bill_id: 2, link: '/house/1', text: 'House 1 · escrow (bill 2 repaid)' });
    expect(res.txs[op11.txid]?.vout[0]).toMatchObject({ kind: 'house_bill_escrow', house_id: 1, bill_id: 3, text: 'House 1 · escrow (bill 3\'s bond, defaulted)' });
    expect(text(res.txs[op11.txid]?.vin[0])).toEqual('Bill 3 · escrow bond'); // op 11 spends the bill's own bond
    expect(res.txs[close.txid]?.vin.map(text)).toEqual([
      'House 1 · escrow (claim change)',
      'House 1 · till locked at deferral',
      'House 1 · escrow (bill 2 repaid)',
      'House 1 · escrow (bill 3\'s bond, defaulted)',
      null, // the stranger's own coin for the fee
    ]);
    expect(res.txs[close.txid]?.vout.map((l) => l?.kind ?? null)).toEqual([null, 'mutual_fund', null]);
    expect(res.txs[close.txid]?.vout[1]?.text).toEqual('FreeBank mutual fund (locked)');
  });

  test('the house: closed, insolvent at the 12-month cap', () => {
    expect(fx.house).toMatchObject({ effective_status: 'insolvent', closed: true, collection_done: true });
    expect(fx.house.insolvent_since).toEqual(fx.house.defer_cap_insolvent_height);
    const badge = houseBadge(fx.house, fx.tip);
    expect(badge.badge).toEqual('insolvent');
    expect(badge.reason).toEqual('Closed: the house failed at block 481 and has been wound up. Its partners took their residual; no more claims are paid.');
  });
});
